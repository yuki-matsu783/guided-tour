/**
 * バックグラウンドのログの保管。受け取ったログをまとめて IndexedDB `logs` に書き、古いものを消し、
 * JSON Lines で書き出し、消去する。
 *
 * - まとめ書き: 最初の1件から2秒たつか、50件に達したらすぐ書く。書き込みは1本の列にして順序を保つ
 * - 削除: 起動時（`start`）と100件書くごとに、30日より古いものを消してから、新しい順に2,000件を残す
 * - 失敗: 古いものを消して1回だけ再試行し、だめならそのまとめを捨てる。例外は呼び出し元へ伝えず、
 *   `onFailure` に例外名と理由コードだけを渡す（メッセージは渡さない）
 * - `onFailure` から logstore 自身へ書くと失敗が連鎖するので、配線側はコンソールだけに出すこと
 */
import {
  INDEX,
  LogRecordSchema,
  STORE,
  forEachCursor,
  readAll,
  requestToPromise,
  withTx,
} from '../../shared/db/index.ts';
import {
  errorFields,
  parseLogMessage,
  type EventFields,
  type LogEntry,
} from '../../shared/logger/index.ts';

export const BATCH_MS = 2000;
export const BATCH_SIZE = 50;
export const PRUNE_EVERY = 100;
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_ENTRIES = 2000;

export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** 実環境のタイマー。ハンドルは数の ID にして、型を絞らずに扱えるようにする。 */
function createRealTimers(): Timers {
  const pending = new Map<number, ReturnType<typeof setTimeout>>();
  let nextId = 1;
  return {
    set(callback, ms) {
      const id = nextId++;
      pending.set(
        id,
        setTimeout(() => {
          pending.delete(id);
          callback();
        }, ms),
      );
      return id;
    },
    clear(handle) {
      if (typeof handle !== 'number') return;
      const timer = pending.get(handle);
      if (timer !== undefined) clearTimeout(timer);
      pending.delete(handle);
    },
  };
}

export interface LogStoreOptions {
  getDb: () => Promise<IDBDatabase>;
  now?: () => number;
  timers?: Timers;
  onFailure?: (fields: EventFields['error']) => void;
}

export interface LogStore {
  /** 検査済みの1行をまとめに加える（バックグラウンド自身のロガーの sink）。 */
  append(entry: LogEntry): void;
  /** 受信した `LOG` メッセージを再検査して加える。通らない行は `logger.invalid` にする。形が違えば捨てる。 */
  ingest(message: unknown): void;
  /** 起動時の削除。 */
  start(): Promise<void>;
  /** まとめ待ちのログを書き込み、終わるまで待つ。 */
  flush(): Promise<void>;
  /** 進行中の書き込みが終わるまで待つ。まとめ待ちは書かない。 */
  whenIdle(): Promise<void>;
  /** 古い順の JSON Lines（各行の末尾に改行。0件なら空文字列）。まとめ待ちのログを先に書き込む。 */
  exportJsonl(): Promise<string>;
  clear(): Promise<void>;
}

export function createLogStore(options: LogStoreOptions): LogStore {
  const now = options.now ?? Date.now;
  const timers = options.timers ?? createRealTimers();

  let buffer: LogEntry[] = [];
  let timer: unknown = null;
  let sincePrune = 0;
  // 書き込みを1本の列にして、受け取った順を保つ
  let chain: Promise<void> = Promise.resolve();

  /** 30日より古いものを消してから、新しい順に 2,000 件を残す。 */
  async function prune(): Promise<void> {
    const db = await options.getDb();
    const cutoff = now() - MAX_AGE_MS;
    await withTx(db, STORE.logs, 'readwrite', async (tx) => {
      const store = tx.objectStore(STORE.logs);
      const byTs = store.index(INDEX.logsByTs);
      await forEachCursor(byTs.openCursor(), (cursor) => {
        const row = LogRecordSchema.parse(cursor.value);
        if (row.ts >= cutoff) return false;
        cursor.delete();
        return true;
      });
      const total = await requestToPromise(store.count());
      let excess = total - MAX_ENTRIES;
      if (excess <= 0) return;
      await forEachCursor(byTs.openCursor(), (cursor) => {
        cursor.delete();
        excess -= 1;
        return excess > 0;
      });
    });
  }

  async function write(entries: LogEntry[]): Promise<void> {
    const db = await options.getDb();
    await withTx(db, STORE.logs, 'readwrite', (tx) => {
      const store = tx.objectStore(STORE.logs);
      return Promise.all(entries.map((entry) => requestToPromise(store.add(entry)))).then(
        () => undefined,
      );
    });
  }

  async function writeWithRetry(entries: LogEntry[]): Promise<void> {
    try {
      await write(entries);
    } catch {
      try {
        await prune();
        await write(entries);
      } catch (error) {
        options.onFailure?.(errorFields(error, 'storage'));
        return;
      }
    }
    sincePrune += entries.length;
    if (sincePrune >= PRUNE_EVERY) {
      sincePrune = 0;
      try {
        await prune();
      } catch (error) {
        options.onFailure?.(errorFields(error, 'storage'));
      }
    }
  }

  /** まとめ待ちを取り出して、書き込みの列の末尾に足す。 */
  function flush(): Promise<void> {
    if (timer !== null) {
      timers.clear(timer);
      timer = null;
    }
    const entries = buffer;
    buffer = [];
    if (entries.length > 0) {
      chain = chain.then(() => writeWithRetry(entries));
    }
    return chain;
  }

  function append(entry: LogEntry): void {
    buffer.push(entry);
    if (buffer.length >= BATCH_SIZE) {
      void flush();
      return;
    }
    timer ??= timers.set(() => {
      timer = null;
      void flush();
    }, BATCH_MS);
  }

  return {
    append,
    ingest(message) {
      const parsed = parseLogMessage(message);
      if (!parsed) return;
      for (const result of parsed) {
        if (result.ok) {
          append(result.value);
        } else {
          append({
            ts: now(),
            level: 'warn',
            ctx: 'background',
            event: 'logger.invalid',
            fields: { event: result.event },
          });
        }
      }
    },
    async start() {
      try {
        await prune();
      } catch (error) {
        options.onFailure?.(errorFields(error, 'storage'));
      }
    },
    flush,
    whenIdle: () => chain,
    async exportJsonl() {
      await flush();
      const db = await options.getDb();
      const rows = await withTx(db, STORE.logs, 'readonly', (tx) =>
        readAll(tx.objectStore(STORE.logs).index(INDEX.logsByTs), LogRecordSchema),
      );
      return rows
        .map((row) =>
          JSON.stringify({
            ts: row.ts,
            level: row.level,
            ctx: row.ctx,
            event: row.event,
            fields: row.fields,
          }) + '\n',
        )
        .join('');
    },
    async clear() {
      buffer = [];
      if (timer !== null) {
        timers.clear(timer);
        timer = null;
      }
      await chain;
      const db = await options.getDb();
      await withTx(db, STORE.logs, 'readwrite', async (tx) => {
        await requestToPromise(tx.objectStore(STORE.logs).clear());
      });
    },
  };
}
