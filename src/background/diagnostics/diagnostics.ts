/**
 * 保守記録。要素特定の `reasons`（劣化・矛盾・未検出・名前不一致）を、ログレベルと無関係に
 * IndexedDB `diagnostics` へ数えて保存する。持つのは理由・段階・件数・累計・最終日時だけ。
 *
 * - 数え方: 同じ `(sessionId, gen, reason)` は1回だけ数える（重複では何も更新しない）。`reasons` が空なら記録しない
 * - 上限: 1,000件。超えたら `lastAt` の古いものから消す（同じ `lastAt` は鍵の順）
 * - 失敗: 古いもの（上限内でも最も古い1割、最低1件）を消して1回だけ再試行し、だめなら捨てる。
 *   例外は呼び出し元へ伝えず、`onFailure` に例外名と理由コードだけを渡す（`onFailure` の例外は握りつぶす）
 */
import {
  DiagnosticRecordSchema,
  INDEX,
  STORE,
  forEachCursor,
  readAll,
  requestToPromise,
  withTx,
  type DiagnosticRecord,
} from '../../shared/db/index.ts';
import { errorFields, type EventFields } from '../../shared/logger/index.ts';
import { LocateSummarySchema, type LocateReason, type LocateSummary } from './types.ts';

export const MAX_RECORDS = 1000;

/** 一覧・書き出しで返す記録。重複判定用の `lastKey` は含めない。 */
export type DiagnosticEntry = Omit<DiagnosticRecord, 'lastKey'>;

export interface DiagnosticsOptions {
  getDb: () => Promise<IDBDatabase>;
  now?: () => number;
  onFailure?: (fields: EventFields['error']) => void;
}

export interface Diagnostics {
  /** 結果の `reasons` を数える。失敗しても例外は投げない。 */
  record(
    tourId: string,
    stepId: string,
    sessionId: string,
    gen: number,
    summary: unknown,
  ): Promise<void>;
  /** 記録を鍵の順（ツアー・ステップ・理由）で返す。tourId があればそのツアーだけ。 */
  list(tourId?: string): Promise<DiagnosticEntry[]>;
  export(): Promise<DiagnosticEntry[]>;
  clear(): Promise<void>;
  removeTour(tourId: string): Promise<void>;
  /** 記録が1件以上あれば true（4つの理由はどれも要確認）。 */
  needsReview(tourId: string): Promise<boolean>;
}

function publicEntry(record: DiagnosticRecord): DiagnosticEntry {
  return {
    tourId: record.tourId,
    stepId: record.stepId,
    reason: record.reason,
    tier: record.tier,
    topTier: record.topTier,
    counts: record.counts,
    total: record.total,
    lastAt: record.lastAt,
  };
}

export function createDiagnostics(options: DiagnosticsOptions): Diagnostics {
  const now = options.now ?? Date.now;

  /** 1,000件を超えた分を、`lastAt` の古いものから消す。 */
  async function trim(tx: IDBTransaction): Promise<void> {
    const store = tx.objectStore(STORE.diagnostics);
    let excess = (await requestToPromise(store.count())) - MAX_RECORDS;
    if (excess <= 0) return;
    await forEachCursor(store.index(INDEX.diagnosticsByLastAt).openCursor(), (cursor) => {
      cursor.delete();
      excess -= 1;
      return excess > 0;
    });
  }

  async function count(
    tourId: string,
    stepId: string,
    sessionId: string,
    gen: number,
    reasons: LocateReason[],
    summary: LocateSummary,
  ): Promise<void> {
    const db = await options.getDb();
    const lastKey = `${sessionId}:${String(gen)}`;
    await withTx(db, STORE.diagnostics, 'readwrite', async (tx) => {
      const store = tx.objectStore(STORE.diagnostics);
      for (const reason of reasons) {
        const found: unknown = await requestToPromise(store.get([tourId, stepId, reason]));
        const existing = found === undefined ? undefined : DiagnosticRecordSchema.parse(found);
        if (existing?.lastKey === lastKey) continue;
        const next: DiagnosticRecord = {
          tourId,
          stepId,
          reason,
          tier: summary.tier,
          topTier: summary.topTier,
          counts: summary.counts,
          total: (existing?.total ?? 0) + 1,
          lastAt: now(),
          lastKey,
        };
        await requestToPromise(store.put(next));
      }
      await trim(tx);
    });
  }

  /** 容量不足のときの空き作り。上限を超えた分に加え、最も古い1割（最低1件）を `lastAt` の順に消す。 */
  async function makeRoom(): Promise<void> {
    const db = await options.getDb();
    await withTx(db, STORE.diagnostics, 'readwrite', async (tx) => {
      await trim(tx);
      const store = tx.objectStore(STORE.diagnostics);
      const total = await requestToPromise(store.count());
      let remaining = Math.max(1, Math.floor(total / 10));
      if (total === 0) return;
      await forEachCursor(store.index(INDEX.diagnosticsByLastAt).openCursor(), (cursor) => {
        cursor.delete();
        remaining -= 1;
        return remaining > 0;
      });
    });
  }

  function notifyFailure(error: unknown): void {
    try {
      options.onFailure?.(errorFields(error, 'storage'));
    } catch {
      // 通知先の失敗で呼び出し元を止めない
    }
  }

  async function list(tourId?: string): Promise<DiagnosticEntry[]> {
    const db = await options.getDb();
    const rows = await withTx(db, STORE.diagnostics, 'readonly', (tx) => {
      const store = tx.objectStore(STORE.diagnostics);
      return tourId === undefined
        ? readAll(store, DiagnosticRecordSchema)
        : readAll(store.index(INDEX.diagnosticsByTour), DiagnosticRecordSchema, tourId);
    });
    return rows.map(publicEntry);
  }

  return {
    async record(tourId, stepId, sessionId, gen, rawSummary) {
      const parsed = LocateSummarySchema.safeParse(rawSummary);
      if (!parsed.success) return;
      const summary = parsed.data;
      const reasons = [...new Set(summary.reasons)];
      if (reasons.length === 0) return;
      try {
        await count(tourId, stepId, sessionId, gen, reasons, summary);
      } catch {
        try {
          await makeRoom();
          await count(tourId, stepId, sessionId, gen, reasons, summary);
        } catch (error) {
          notifyFailure(error);
        }
      }
    },
    list,
    export: () => list(),
    async clear() {
      const db = await options.getDb();
      await withTx(db, STORE.diagnostics, 'readwrite', async (tx) => {
        await requestToPromise(tx.objectStore(STORE.diagnostics).clear());
      });
    },
    async removeTour(tourId) {
      const db = await options.getDb();
      await withTx(db, STORE.diagnostics, 'readwrite', async (tx) => {
        const index = tx.objectStore(STORE.diagnostics).index(INDEX.diagnosticsByTour);
        await forEachCursor(index.openCursor(tourId), (cursor) => {
          cursor.delete();
          return true;
        });
      });
    },
    async needsReview(tourId) {
      const db = await options.getDb();
      const total = await withTx(db, STORE.diagnostics, 'readonly', (tx) =>
        requestToPromise(tx.objectStore(STORE.diagnostics).index(INDEX.diagnosticsByTour).count(tourId)),
      );
      return total > 0;
    },
  };
}
