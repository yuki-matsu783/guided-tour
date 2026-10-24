/**
 * ログの保管のテスト（T-LOG-33〜62）。IndexedDB は fake-indexeddb、時刻とタイマーは偽物を差し込む。
 */
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { INDEX, LogRecordSchema, STORE, openDb, readAll, requestToPromise, withTx } from '../../shared/db/index.ts';
import type { EventFields, LogEntry } from '../../shared/logger/index.ts';
import { MAX_AGE_MS, createLogStore, type LogStore, type Timers } from './logstore.ts';

const NOW = Date.UTC(2026, 5, 1);
const DAY = 24 * 60 * 60 * 1000;

function fakeTimers() {
  let current = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; callback: () => void }>();
  const timers: Timers = {
    set(callback, ms) {
      const id = nextId++;
      pending.set(id, { at: current + ms, callback });
      return id;
    },
    clear(handle) {
      if (typeof handle === 'number') pending.delete(handle);
    },
  };
  return {
    timers,
    advance(ms: number) {
      current += ms;
      const due = [...pending.entries()].filter(([, t]) => t.at <= current);
      for (const [id, t] of due) {
        pending.delete(id);
        t.callback();
      }
    },
  };
}

function entry(ts: number, n = 0): LogEntry {
  return {
    ts,
    level: 'info',
    ctx: 'background',
    event: 'session.goto',
    fields: { from: n, to: n + 1, accepted: true },
  };
}

interface Env {
  db: IDBDatabase;
  factory: IDBFactory;
  clock: ReturnType<typeof fakeTimers>;
  failures: EventFields['error'][];
  dbCalls: { count: number };
  store: LogStore;
  /** true の間、getDb は閉じた接続を返す（書き込みが失敗する）。 */
  failing: { value: boolean };
  closed: IDBDatabase;
}

async function setup(): Promise<Env> {
  const factory = new IDBFactory();
  const db = await openDb(factory);
  const closed = await openDb(factory);
  closed.close();
  const clock = fakeTimers();
  const failures: EventFields['error'][] = [];
  const failing = { value: false };
  const dbCalls = { count: 0 };
  const store = createLogStore({
    getDb: () => {
      dbCalls.count += 1;
      return Promise.resolve(failing.value ? closed : db);
    },
    now: () => NOW,
    timers: clock.timers,
    onFailure: (f) => failures.push(f),
  });
  return { db, factory, clock, failures, dbCalls, store, failing, closed };
}

function allRows(db: IDBDatabase) {
  return withTx(db, STORE.logs, 'readonly', (tx) =>
    readAll(tx.objectStore(STORE.logs).index(INDEX.logsByTs), LogRecordSchema),
  );
}

async function seed(db: IDBDatabase, rows: LogEntry[]): Promise<void> {
  await withTx(db, STORE.logs, 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE.logs);
    await Promise.all(rows.map((r) => requestToPromise(store.add(r))));
  });
}

const recent = (n: number, base = NOW - DAY) =>
  Array.from({ length: n }, (_, i) => entry(base + i, i));

let env: Env;
beforeEach(async () => {
  env = await setup();
});

describe('受信と再検査', () => {
  it('T-LOG-33: 受け取った LOG の各項目を再検査し、通らないものを捨てて logger.invalid を記録する', async () => {
    const good = entry(NOW, 1);
    env.store.ingest({
      type: 'LOG',
      entries: [
        good,
        { ...entry(NOW, 2), event: 'tabs.status', fields: { role: 'main', status: 'ok', url: 'https://example.com/' } },
        { ts: 'x' },
        { ...entry(NOW, 3), event: 'page text', fields: {} },
      ],
    }, 'content');
    await env.store.flush();
    const rows = await allRows(env.db);
    expect(rows.map((r) => [r.event, r.fields])).toEqual([
      ['session.goto', good.fields],
      ['logger.invalid', { event: 'tabs.status' }],
      ['logger.invalid', { event: 'unknown' }],
      ['logger.invalid', { event: 'unknown' }],
    ]);
    expect(JSON.stringify(rows)).not.toContain('example.com');
  });

  it('T-LOG-34: 形が合わない LOG メッセージ（entries が配列でない）は捨てられる', async () => {
    env.store.ingest({ type: 'LOG', entries: 'not an array' }, 'content');
    env.store.ingest({ type: 'LOG' }, 'content');
    env.store.ingest({ type: 'OTHER', entries: [entry(NOW)] }, 'content');
    env.store.ingest(null, 'content');
    await env.store.flush();
    expect(await allRows(env.db)).toHaveLength(0);
  });
});

describe('まとめ書き', () => {
  it('T-LOG-35: 1件のとき、2秒がたつまで書かれず、2秒で書かれる', async () => {
    env.store.append(entry(NOW));
    await env.store.whenIdle();
    env.clock.advance(1999);
    await env.store.whenIdle();
    expect(await allRows(env.db)).toHaveLength(0);
    env.clock.advance(1);
    await env.store.whenIdle();
    expect(await allRows(env.db)).toHaveLength(1);
  });

  it('T-LOG-36: 49件のとき、2秒がたつまで書かれない', async () => {
    for (const e of recent(49)) env.store.append(e);
    env.clock.advance(1999);
    await env.store.whenIdle();
    expect(await allRows(env.db)).toHaveLength(0);
  });

  it('T-LOG-37: ちょうど50件に達したら、2秒を待たずにまとめて書かれる', async () => {
    for (const e of recent(50)) env.store.append(e);
    await env.store.whenIdle();
    expect(await allRows(env.db)).toHaveLength(50);
  });

  it('T-LOG-38: 2秒で書いた後、新しいログがあればそこからまた2秒で次のまとめ書きが行われる', async () => {
    env.store.append(entry(NOW, 1));
    env.clock.advance(2000);
    await env.store.whenIdle();
    env.store.append(entry(NOW, 2));
    env.clock.advance(1999);
    await env.store.whenIdle();
    expect(await allRows(env.db)).toHaveLength(1);
    env.clock.advance(1);
    await env.store.whenIdle();
    expect(await allRows(env.db)).toHaveLength(2);
  });

  it('T-LOG-39: 51件を続けて受けたとき、50件で1回書き、残り1件は次の2秒で書かれる', async () => {
    for (const e of recent(51)) env.store.append(e);
    await env.store.whenIdle();
    expect(await allRows(env.db)).toHaveLength(50);
    env.clock.advance(2000);
    await env.store.whenIdle();
    expect(await allRows(env.db)).toHaveLength(51);
  });

  it('T-LOG-40: 書き込みの順序が受け取った順序のまま保たれる', async () => {
    const rows = recent(120).map((e, i) => entry(NOW, i));
    for (const e of rows) env.store.append(e);
    env.clock.advance(2000);
    await env.store.whenIdle();
    const stored = await withTx(env.db, STORE.logs, 'readonly', (tx) =>
      readAll(tx.objectStore(STORE.logs), LogRecordSchema),
    );
    expect(stored.map((r) => r.fields.from)).toEqual(rows.map((_, i) => i));
  });
});

describe('削除（30日・2,000件）', () => {
  it('T-LOG-41: 起動時に、30日より古いログが削除される', async () => {
    await seed(env.db, [entry(NOW - 40 * DAY, 1), entry(NOW - DAY, 2)]);
    await env.store.start();
    expect((await allRows(env.db)).map((r) => r.fields.from)).toEqual([2]);
  });

  it('T-LOG-42: ちょうど30日前のログは残り、1ミリ秒古いログは削除される', async () => {
    await seed(env.db, [entry(NOW - MAX_AGE_MS - 1, 1), entry(NOW - MAX_AGE_MS, 2)]);
    await env.store.start();
    expect((await allRows(env.db)).map((r) => r.fields.from)).toEqual([2]);
  });

  it('T-LOG-43: 100件書くごとに、30日より古いログが削除される', async () => {
    await env.store.start();
    await seed(env.db, [entry(NOW - 40 * DAY, 0)]);
    for (const e of recent(100)) env.store.append(e);
    env.clock.advance(2000);
    await env.store.whenIdle();
    const rows = await allRows(env.db);
    expect(rows).toHaveLength(100);
    expect(rows.every((r) => r.ts >= NOW - MAX_AGE_MS)).toBe(true);
  });

  it('T-LOG-44: 99件を書いた時点では削除が走らず、100件目を書いたときに走る', async () => {
    await env.store.start();
    await seed(env.db, [entry(NOW - 40 * DAY, 0)]);
    for (const e of recent(99)) env.store.append(e);
    env.clock.advance(2000);
    await env.store.whenIdle();
    expect(await allRows(env.db)).toHaveLength(100);
    env.store.append(entry(NOW, 100));
    env.clock.advance(2000);
    await env.store.whenIdle();
    expect(await allRows(env.db)).toHaveLength(100);
  });

  it('T-LOG-45: 2,000件ちょうどのとき、削除されない', async () => {
    await seed(env.db, recent(2000));
    await env.store.start();
    expect(await allRows(env.db)).toHaveLength(2000);
  });

  it('T-LOG-46: 2,001件になったとき、新しい順に2,000件が残り、最も古い1件が削除される', async () => {
    await seed(env.db, recent(2001));
    await env.store.start();
    const rows = await allRows(env.db);
    expect(rows).toHaveLength(2000);
    expect(rows[0]?.fields.from).toBe(1);
  });

  it('T-LOG-47: 30日以内のログが2,500件あるとき、新しい順に2,000件が残る', async () => {
    await seed(env.db, recent(2500));
    await env.store.start();
    const rows = await allRows(env.db);
    expect(rows).toHaveLength(2000);
    expect(rows[0]?.fields.from).toBe(500);
    expect(rows[1999]?.fields.from).toBe(2499);
  });

  it('T-LOG-48: 2,000件以下でも、30日より古いログは削除される', async () => {
    await seed(env.db, [...Array.from({ length: 5 }, (_, i) => entry(NOW - 50 * DAY + i, i)), ...recent(100)]);
    await env.store.start();
    expect(await allRows(env.db)).toHaveLength(100);
  });

  it('T-LOG-49: 30日の削除が先で、そのあと新しい順に2,000件を残す', async () => {
    await seed(env.db, [...Array.from({ length: 50 }, (_, i) => entry(NOW - 50 * DAY + i, 9000 + i)), ...recent(2050)]);
    await env.store.start();
    const rows = await allRows(env.db);
    expect(rows).toHaveLength(2000);
    expect(rows.every((r) => r.ts >= NOW - MAX_AGE_MS)).toBe(true);
    expect(rows[0]?.fields.from).toBe(50);
  });
});

describe('保存失敗時の再試行', () => {
  /** 最初の getDb だけ失敗させ、以降は成功させる。 */
  function failFirstCall(e: Env) {
    let first = true;
    return createLogStore({
      getDb: () => {
        const bad = first;
        first = false;
        e.dbCalls.count += 1;
        return Promise.resolve(bad ? e.closed : e.db);
      },
      now: () => NOW,
      timers: e.clock.timers,
      onFailure: (f) => e.failures.push(f),
    });
  }

  it('T-LOG-50: まとめ書きが失敗したとき、古いものを消してから1回だけ再試行する', async () => {
    await seed(env.db, [entry(NOW - 40 * DAY, 0)]);
    const store = failFirstCall(env);
    store.append(entry(NOW, 1));
    await store.flush();
    const rows = await allRows(env.db);
    expect(rows.map((r) => r.fields.from)).toEqual([1]);
    expect(env.dbCalls.count).toBe(3);
  });

  it('T-LOG-51: 再試行が成功したとき、まとめたログは保存され、何も報告されない', async () => {
    const store = failFirstCall(env);
    for (const e of recent(3)) store.append(e);
    await store.flush();
    expect(await allRows(env.db)).toHaveLength(3);
    expect(env.failures).toEqual([]);
  });

  it('T-LOG-52: 再試行も失敗したとき、そのまとめは捨てられ、それ以上は再試行されない', async () => {
    env.failing.value = true;
    env.store.append(entry(NOW, 1));
    await env.store.flush();
    const calls = env.dbCalls.count;
    env.failing.value = false;
    env.clock.advance(10_000);
    await env.store.whenIdle();
    expect(env.dbCalls.count).toBe(calls);
    expect(await allRows(env.db)).toHaveLength(0);
    expect(env.failures).toHaveLength(1);
  });

  it('T-LOG-53: 保存の失敗によって例外が外へ伝わらない', async () => {
    env.failing.value = true;
    expect(() => {
      env.store.append(entry(NOW));
    }).not.toThrow();
    await expect(env.store.flush()).resolves.toBeUndefined();
    await expect(env.store.start()).resolves.toBeUndefined();
  });

  it('T-LOG-54: 再試行で捨てたあとも、次のまとめ書きは通常どおり行われる', async () => {
    env.failing.value = true;
    env.store.append(entry(NOW, 1));
    await env.store.flush();
    env.failing.value = false;
    env.store.append(entry(NOW, 2));
    env.clock.advance(2000);
    await env.store.whenIdle();
    expect((await allRows(env.db)).map((r) => r.fields.from)).toEqual([2]);
  });

  it('T-LOG-55: 保存の失敗の報告には、例外名と理由コードだけがあり、メッセージが含まれない', async () => {
    env.failing.value = true;
    env.store.append(entry(NOW));
    await env.store.flush();
    expect(env.failures).toHaveLength(1);
    const f = env.failures[0];
    expect(Object.keys(f ?? {}).sort()).toEqual(['name', 'reason']);
    expect(f?.reason).toBe('storage');
  });
});

describe('JSON Lines の書き出しと消去', () => {
  it('T-LOG-56: 書き出すと、1行が1つの JSON で、行が改行で区切られた文字列になる', async () => {
    env.store.append(entry(NOW, 1));
    env.store.append(entry(NOW + 1, 2));
    const text = await env.store.exportJsonl();
    const lines = text.split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(2);
    expect(text.endsWith('\n')).toBe(true);
    for (const l of lines) {
      const parsed: unknown = JSON.parse(l);
      expect(parsed).toBeTypeOf('object');
    }
  });

  it('T-LOG-57: 書き出した各行から ts・level・ctx・event・fields が復元できる', async () => {
    env.store.append(entry(NOW, 7));
    const line = (await env.store.exportJsonl()).trim();
    expect(JSON.parse(line)).toEqual(entry(NOW, 7));
  });

  it('T-LOG-58: ログが0件のとき、書き出しは空のファイルになり、例外は出ない', async () => {
    await expect(env.store.exportJsonl()).resolves.toBe('');
  });

  it('T-LOG-59: 書き出した内容に、入力値・ページの文字列・URL・例外のメッセージが含まれない', async () => {
    env.store.ingest({
      type: 'LOG',
      entries: [
        entry(NOW, 1),
        { ...entry(NOW, 2), fields: { from: 1, to: 2, accepted: true, url: 'https://example.com/p' } },
        { ...entry(NOW, 3), event: 'error', fields: { name: 'Error', reason: 'x', message: 'ページの文字列' } },
      ],
    }, 'content');
    const text = await env.store.exportJsonl();
    expect(text).not.toContain('example.com');
    expect(text).not.toContain('ページの文字列');
  });

  it('T-LOG-60: 書き出しの前に、まとめ待ちのログが書き込まれ、含まれる', async () => {
    env.store.append(entry(NOW, 1));
    const text = await env.store.exportJsonl();
    expect(text.split('\n').filter((l) => l !== '')).toHaveLength(1);
  });

  it('T-LOG-61: 消去を実行すると、保存したログがすべて消える', async () => {
    await seed(env.db, recent(10));
    env.store.append(entry(NOW, 99));
    await env.store.clear();
    env.clock.advance(5000);
    await env.store.whenIdle();
    expect(await allRows(env.db)).toHaveLength(0);
    await expect(env.store.exportJsonl()).resolves.toBe('');
  });

  it('T-LOG-62: 書き出しの順序は、時刻（ts）の昇順（古い順）に揃っている', async () => {
    for (const ts of [NOW + 30, NOW + 10, NOW + 20]) env.store.append(entry(ts));
    const lines = (await env.store.exportJsonl()).trim().split('\n');
    const times = lines.map((l) => {
      const parsed: unknown = JSON.parse(l);
      return LogRecordSchema.parse(parsed).ts;
    });
    expect(times).toEqual([NOW + 10, NOW + 20, NOW + 30]);
  });
});

/** スキーマを通さず、保存された生の行を入れる（壊れた行の再現用）。 */
async function seedRaw(db: IDBDatabase, rows: Record<string, unknown>[]): Promise<void> {
  await withTx(db, STORE.logs, 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE.logs);
    await Promise.all(rows.map((r) => requestToPromise(store.add(r))));
  });
}

const rawRows = (db: IDBDatabase) =>
  withTx(db, STORE.logs, 'readonly', (tx) => requestToPromise(tx.objectStore(STORE.logs).getAll()));

describe('第1段のレビュー指摘の修正（ログの保管）', () => {
  it('R-LOG-1: 受け取った LOG の ts は受け取った時刻、ctx は送り手の実行場所に置き換わる', async () => {
    env.store.ingest(
      {
        type: 'LOG',
        entries: [
          { ...entry(NOW + 99_999, 1), ctx: 'sidepanel' },
          { ...entry(NOW - 99_999, 2), event: 'tabs.status', fields: { role: 'main', status: 'bad' } },
        ],
      },
      'content',
    );
    await env.store.flush();
    const rows = await allRows(env.db);
    expect(rows.map((r) => [r.ts, r.ctx, r.event])).toEqual([
      [NOW, 'content', 'session.goto'],
      [NOW, 'content', 'logger.invalid'],
    ]);
  });

  it('R-LOG-2: 削除は、スキーマに合わない行を飛ばさず消して止まらない', async () => {
    await seedRaw(env.db, [
      { ts: NOW - DAY, level: 'bad', ctx: 'content', event: 1, fields: 'x' },
      { ts: NOW - 40 * DAY, junk: true },
      { ts: NOW - DAY + 1, junk: true },
    ]);
    await seed(env.db, [entry(NOW - DAY + 2, 7)]);
    await expect(env.store.start()).resolves.toBeUndefined();
    expect(env.failures).toEqual([]);
    expect((await rawRows(env.db)).length).toBe(1);
    expect((await allRows(env.db)).map((r) => r.fields.from)).toEqual([7]);
  });

  it('R-LOG-2: 書き出しは、スキーマに合わない行があっても全体を失敗させず、その行を飛ばす', async () => {
    await seedRaw(env.db, [{ ts: NOW - DAY, junk: true }]);
    await seed(env.db, [entry(NOW - DAY + 1, 1), entry(NOW - DAY + 2, 2)]);
    const lines = (await env.store.exportJsonl()).trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('R-LOG-3: onFailure が例外を投げても、書き込みの列は止まらず次の書き込みが行われる', async () => {
    const store = createLogStore({
      getDb: () => Promise.resolve(env.failing.value ? env.closed : env.db),
      now: () => NOW,
      timers: env.clock.timers,
      onFailure: () => {
        throw new Error('onFailure が投げた');
      },
    });
    env.failing.value = true;
    store.append(entry(NOW, 1));
    await expect(store.flush()).resolves.toBeUndefined();
    await expect(store.start()).resolves.toBeUndefined();
    env.failing.value = false;
    store.append(entry(NOW, 2));
    await expect(store.flush()).resolves.toBeUndefined();
    expect((await allRows(env.db)).map((r) => r.fields.from)).toEqual([2]);
  });

  it('R-LOG-5: 書き出しは、新しい順に 2,000 件だけを古い順に返す', async () => {
    await seed(env.db, recent(2500));
    const lines = (await env.store.exportJsonl()).trim().split('\n');
    expect(lines).toHaveLength(2000);
    const froms = lines.map((l) => {
      const parsed: unknown = JSON.parse(l);
      return LogRecordSchema.parse(parsed).fields.from;
    });
    expect(froms[0]).toBe(500);
    expect(froms.at(-1)).toBe(2499);
  });

  it('R-LOG-6: 100件ごとの数え方で、超えた分は次の周期へ繰り越す', async () => {
    const group = async (n: number, base: number): Promise<void> => {
      for (const e of recent(n, NOW - DAY + base)) env.store.append(e);
      await env.store.flush();
    };
    await seed(env.db, [entry(NOW - 40 * DAY, 100)]);
    await group(40, 0);
    await group(40, 100);
    expect(await allRows(env.db)).toHaveLength(81);
    await group(40, 200); // 120件目で削除が走り、20件を繰り越す
    expect(await allRows(env.db)).toHaveLength(120);
    await seed(env.db, [entry(NOW - 40 * DAY, 101)]);
    await group(40, 300);
    await group(39, 400); // 繰り越し 20 + 79 = 99
    expect((await allRows(env.db)).some((r) => r.ts < NOW - MAX_AGE_MS)).toBe(true);
    await group(1, 500); // 100件に届いて削除が走る
    expect((await allRows(env.db)).some((r) => r.ts < NOW - MAX_AGE_MS)).toBe(false);
  });

  it('R-DIAG-3: 再試行の前に、上限内でも最も古い1割（最低1件）を消す', async () => {
    await seed(env.db, recent(20));
    let first = true;
    const store = createLogStore({
      getDb: () => {
        const bad = first;
        first = false;
        return Promise.resolve(bad ? env.closed : env.db);
      },
      now: () => NOW,
      timers: env.clock.timers,
    });
    store.append(entry(NOW, 99));
    await store.flush();
    const froms = (await allRows(env.db)).map((r) => r.fields.from);
    expect(froms).toHaveLength(19);
    expect(froms.slice(0, 2)).toEqual([2, 3]);
    expect(froms.at(-1)).toBe(99);
  });

  it('R-DIAG-3: 件数が10件未満でも、再試行の前に最低1件の最も古いものを消す', async () => {
    await seed(env.db, recent(3));
    let first = true;
    const store = createLogStore({
      getDb: () => {
        const bad = first;
        first = false;
        return Promise.resolve(bad ? env.closed : env.db);
      },
      now: () => NOW,
      timers: env.clock.timers,
    });
    store.append(entry(NOW, 99));
    await store.flush();
    expect((await allRows(env.db)).map((r) => r.fields.from)).toEqual([1, 2, 99]);
  });
});
