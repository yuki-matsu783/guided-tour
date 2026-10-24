/**
 * 保守記録のテスト（T-DIAG-01〜46）。IndexedDB は fake-indexeddb、時刻は進む偽物を差し込む。
 */
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DiagnosticRecordSchema,
  STORE,
  openDb,
  readAll,
  requestToPromise,
  withTx,
  type DiagnosticRecord,
} from '../../shared/db/index.ts';
import type { EventFields } from '../../shared/logger/index.ts';
import { createDiagnostics, type Diagnostics } from './diagnostics.ts';
import type { LocateReason, LocateSummary, Tier } from './types.ts';

interface Env {
  db: IDBDatabase;
  closed: IDBDatabase;
  diag: Diagnostics;
  clock: { t: number; fixed: boolean };
  failing: { value: boolean };
  /** 0 より大きい間、getDb の呼び出しを1回ごとに閉じた接続で失敗させる（1回目だけ失敗させる試験用）。 */
  failFirst: { remaining: number };
  failures: EventFields['error'][];
}

async function setup(): Promise<Env> {
  const factory = new IDBFactory();
  const db = await openDb(factory);
  const closed = await openDb(factory);
  closed.close();
  const clock = { t: 1000, fixed: false };
  const failing = { value: false };
  const failFirst = { remaining: 0 };
  const failures: EventFields['error'][] = [];
  const diag = createDiagnostics({
    getDb: () => {
      const bad = failing.value || failFirst.remaining > 0;
      if (failFirst.remaining > 0) failFirst.remaining -= 1;
      return Promise.resolve(bad ? closed : db);
    },
    now: () => {
      if (!clock.fixed) clock.t += 1;
      return clock.t;
    },
    onFailure: (f) => failures.push(f),
  });
  return { db, closed, diag, clock, failing, failFirst, failures };
}

function summary(
  reasons: LocateReason[],
  tier: Tier | null = 2,
  topTier: Tier | null = 1,
): LocateSummary {
  return {
    found: !reasons.includes('missing'),
    tier,
    topTier,
    reasons,
    counts: [{ tier: 1, collected: 1, required: 1, visible: 1 }],
  };
}

const rawRecords = (db: IDBDatabase) =>
  withTx(db, STORE.diagnostics, 'readonly', (tx) =>
    readAll(tx.objectStore(STORE.diagnostics), DiagnosticRecordSchema),
  );

/** スキーマで読み直す前の、保存された生の値。 */
const storedValues = (db: IDBDatabase): Promise<unknown[]> =>
  withTx(db, STORE.diagnostics, 'readonly', (tx) =>
    requestToPromise(tx.objectStore(STORE.diagnostics).getAll()),
  );

async function seed(db: IDBDatabase, rows: DiagnosticRecord[]): Promise<void> {
  await withTx(db, STORE.diagnostics, 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE.diagnostics);
    await Promise.all(rows.map((r) => requestToPromise(store.put(r))));
  });
}

function seedRow(n: number, lastAt: number, total = 1): DiagnosticRecord {
  return {
    tourId: 't',
    stepId: `s${String(n).padStart(4, '0')}`,
    reason: 'missing',
    tier: null,
    topTier: 1,
    counts: [],
    total,
    lastAt,
    lastKey: 'x:1',
  };
}

let env: Env;
beforeEach(async () => {
  env = await setup();
});

const rec = (
  stepId: string,
  summaryValue: unknown,
  sessionId = 's1',
  gen = 1,
  tourId = 't',
) => env.diag.record(tourId, stepId, sessionId, gen, summaryValue);

describe('reasons からの記録', () => {
  it('T-DIAG-01: reasons が空の結果は何も記録されない', async () => {
    await rec('a', summary([]));
    expect(await env.diag.list()).toEqual([]);
  });

  const single: [string, LocateReason][] = [
    ['T-DIAG-02', 'degraded'],
    ['T-DIAG-03', 'conflict'],
    ['T-DIAG-04', 'missing'],
    ['T-DIAG-05', 'nameMismatch'],
  ];
  for (const [id, reason] of single) {
    it(`${id}: reasons に ${reason} があると、理由 ${reason} の記録が1件できる`, async () => {
      await rec('a', summary([reason]));
      const list = await env.diag.list();
      expect(list).toHaveLength(1);
      expect(list[0]?.reason).toBe(reason);
      expect(list[0]?.total).toBe(1);
    });
  }

  it('T-DIAG-06: conflict と degraded の両方があると、2件が別々に記録される', async () => {
    await rec('a', summary(['conflict', 'degraded']));
    expect((await env.diag.list()).map((r) => r.reason).sort()).toEqual(['conflict', 'degraded']);
  });

  it('T-DIAG-07: 記録の項目が tourId・stepId・reason・tier・topTier・counts・total・lastAt だけ', async () => {
    await rec('a', summary(['degraded']));
    const [entry] = await env.diag.list();
    expect(Object.keys(entry ?? {}).sort()).toEqual(
      ['counts', 'lastAt', 'reason', 'stepId', 'tier', 'topTier', 'total', 'tourId'],
    );
    const [raw] = await rawRecords(env.db);
    expect(Object.keys(raw ?? {}).sort()).toEqual(
      ['counts', 'lastAt', 'lastKey', 'reason', 'stepId', 'tier', 'topTier', 'total', 'tourId'],
    );
  });

  it('T-DIAG-08: 記録にページの文字列（読み上げ名・表示文字列）と URL が含まれない', async () => {
    await rec('a', summary(['degraded', 'conflict']));
    const text = JSON.stringify(await storedValues(env.db));
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toContain('name');
  });

  it('T-DIAG-09: 結果に余計な項目（名前の文字列や URL）が混じっていても保存されない', async () => {
    const dirty = {
      ...summary(['nameMismatch']),
      name: '購入を確定',
      url: 'https://example.com/pay',
      counts: [{ tier: 1, collected: 1, required: 1, visible: 1, text: '注文' }],
    };
    await rec('a', dirty);
    const stored = await storedValues(env.db);
    const text = JSON.stringify(stored);
    expect(text).not.toContain('購入');
    expect(text).not.toContain('example.com');
    expect(text).not.toContain('注文');
    // 保存された生の値に余計な項目がない（トップレベルも counts の中も）
    const row = z.looseObject({ counts: z.array(z.looseObject({})) }).parse(stored[0]);
    expect(Object.keys(row).sort()).toEqual(
      ['counts', 'lastAt', 'lastKey', 'reason', 'stepId', 'tier', 'topTier', 'total', 'tourId'],
    );
    expect(Object.keys(row.counts[0] ?? {}).sort()).toEqual(
      ['collected', 'required', 'tier', 'visible'],
    );
  });

  it('T-DIAG-10: ログレベルに関係なく保守記録は保存される（ロガーに依存しない）', async () => {
    await rec('a', summary(['missing']));
    expect(await env.diag.list()).toHaveLength(1);
  });

  it('T-DIAG-11: 矛盾の counts に、捨てられた時点の段階ごとの候補数が保存される', async () => {
    const s: LocateSummary = {
      found: false,
      tier: null,
      topTier: 1,
      reasons: ['conflict'],
      counts: [
        { tier: 1, collected: 1, required: 0, visible: 0 },
        { tier: 2, collected: 3, required: 3, visible: 2 },
      ],
    };
    await rec('a', s);
    const [entry] = await env.diag.list();
    expect(entry?.counts).toEqual(s.counts);
    expect(entry?.tier).toBeNull();
    expect(entry?.topTier).toBe(1);
  });

  it('不正な要約は何も記録せず、例外も出ない', async () => {
    await expect(rec('a', { reasons: ['bogus'] })).resolves.toBeUndefined();
    await expect(rec('a', null)).resolves.toBeUndefined();
    expect(await env.diag.list()).toEqual([]);
  });
});

describe('数え方', () => {
  it('T-DIAG-12: 新しい (tourId, stepId, reason) を初めて record すると total が 1 になる', async () => {
    await rec('a', summary(['missing']));
    expect((await env.diag.list())[0]?.total).toBe(1);
  });

  it('T-DIAG-13: 同じ (sessionId, gen, reason) を2回 record しても total は 1 のまま', async () => {
    await rec('a', summary(['missing']), 's1', 3);
    await rec('a', summary(['missing']), 's1', 3);
    expect((await env.diag.list())[0]?.total).toBe(1);
  });

  it('T-DIAG-14: 同じ stepId を gen 1 と gen 3 で表示したとき（間に別ステップの gen 2 がある）、total が 2 になる', async () => {
    await rec('a', summary(['missing']), 's1', 1);
    await rec('b', summary(['missing']), 's1', 2);
    await rec('a', summary(['missing']), 's1', 3);
    const list = await env.diag.list();
    expect(list.find((r) => r.stepId === 'a')?.total).toBe(2);
    expect(list.find((r) => r.stepId === 'b')?.total).toBe(1);
  });

  it('T-DIAG-15: gen が同じで sessionId が違うと total が 2 になる', async () => {
    await rec('a', summary(['missing']), 's1', 3);
    await rec('a', summary(['missing']), 's2', 3);
    expect((await env.diag.list())[0]?.total).toBe(2);
  });

  it('T-DIAG-16: 同じ (sessionId, gen) で reason が違うと、それぞれの理由で別に数える', async () => {
    await rec('a', summary(['missing']), 's1', 3);
    await rec('a', summary(['degraded']), 's1', 3);
    const list = await env.diag.list();
    expect(list.map((r) => [r.reason, r.total]).sort()).toEqual([
      ['degraded', 1],
      ['missing', 1],
    ]);
  });

  it('T-DIAG-17: 同じ (sessionId, gen, reason) の繰り返しでは lastAt を更新しない', async () => {
    await rec('a', summary(['missing']), 's1', 3);
    const first = (await env.diag.list())[0]?.lastAt;
    await rec('a', summary(['missing']), 's1', 3);
    expect((await env.diag.list())[0]?.lastAt).toBe(first);
  });

  it('T-DIAG-18: 理由 A、B、A の順で同じ表示中に届いたとき、A は1回、B は1回として数える', async () => {
    await rec('a', summary(['degraded']), 's1', 3);
    await rec('a', summary(['conflict']), 's1', 3);
    await rec('a', summary(['degraded']), 's1', 3);
    const list = await env.diag.list();
    expect(list.map((r) => [r.reason, r.total]).sort()).toEqual([
      ['conflict', 1],
      ['degraded', 1],
    ]);
  });

  it('T-DIAG-19: 再検証で同じ nameMismatch が繰り返し届いても、同じ gen の間は1回だけ数える', async () => {
    for (let i = 0; i < 5; i += 1) await rec('a', summary(['nameMismatch']), 's1', 2);
    expect((await env.diag.list())[0]?.total).toBe(1);
  });

  it('T-DIAG-20: 数えるときに lastAt が最後に数えた時刻に更新される', async () => {
    await rec('a', summary(['missing']), 's1', 1);
    const first = (await env.diag.list())[0]?.lastAt ?? 0;
    await rec('a', summary(['missing']), 's1', 2);
    const second = (await env.diag.list())[0]?.lastAt ?? 0;
    expect(second).toBeGreaterThan(first);
    expect(second).toBe(env.clock.t);
  });

  it('T-DIAG-21: 別のステップ・別のツアーの記録は、互いの total に影響しない', async () => {
    await rec('a', summary(['missing']), 's1', 1);
    await rec('a', summary(['missing']), 's2', 1);
    await rec('b', summary(['missing']), 's1', 1);
    await rec('a', summary(['missing']), 's1', 1, 'other');
    const total = async (tourId: string, stepId: string) =>
      (await env.diag.list(tourId)).find((r) => r.stepId === stepId)?.total;
    expect(await total('t', 'a')).toBe(2);
    expect(await total('t', 'b')).toBe(1);
    expect(await total('other', 'a')).toBe(1);
  });
});

describe('絞り込めただけのものは記録しない', () => {
  it('T-DIAG-22: 候補が3件から1件に絞られて成功した結果（reasons 空）は記録されない', async () => {
    await rec('a', { ...summary([], 1, 1), counts: [{ tier: 1, collected: 3, required: 1, visible: 1 }] });
    expect(await env.diag.list()).toEqual([]);
  });

  it('T-DIAG-23: 絞り込みで counts に差があっても、成功した結果は記録されない', async () => {
    await rec('a', {
      ...summary([], 2, 2),
      counts: [
        { tier: 2, collected: 5, required: 2, visible: 1 },
      ],
    });
    expect(await env.diag.list()).toEqual([]);
  });

  it('T-DIAG-24: すべて捨てられて次の段階で成功した結果（conflict なし、degraded あり）は劣化だけが記録される', async () => {
    await rec('a', {
      ...summary(['degraded'], 2, 1),
      counts: [
        { tier: 1, collected: 2, required: 0, visible: 0 },
        { tier: 2, collected: 1, required: 1, visible: 1 },
      ],
    });
    expect((await env.diag.list()).map((r) => r.reason)).toEqual(['degraded']);
  });
});

describe('上限（1,000件）', () => {
  const thousand = () => Array.from({ length: 1000 }, (_, i) => seedRow(i, 100 + i));

  it('T-DIAG-25: 1,000件ちょうどのとき、削除されない', async () => {
    await seed(env.db, thousand());
    await rec('s0000', summary(['missing']), 'x', 1);
    expect(await env.diag.list()).toHaveLength(1000);
  });

  it('T-DIAG-26: 1,001件になったとき、lastAt が最も古い1件が削除され、1,000件になる', async () => {
    await seed(env.db, thousand());
    await rec('new', summary(['missing']));
    const list = await env.diag.list();
    expect(list).toHaveLength(1000);
    expect(list.some((r) => r.stepId === 's0000')).toBe(false);
    expect(list.some((r) => r.stepId === 'new')).toBe(true);
  });

  it('T-DIAG-27: 上限を超えて複数件を加えたとき、lastAt の古いものから順に削除され 1,000件が残る', async () => {
    await seed(env.db, thousand());
    for (const n of ['n1', 'n2', 'n3']) await rec(n, summary(['missing']));
    const steps = new Set((await env.diag.list()).map((r) => r.stepId));
    expect(steps.size).toBe(1000);
    for (const gone of ['s0000', 's0001', 's0002']) expect(steps.has(gone)).toBe(false);
    expect(steps.has('s0003')).toBe(true);
  });

  it('T-DIAG-28: 既存の記録の total を増やして lastAt が新しくなると、その記録は削除の対象から外れる', async () => {
    await seed(env.db, thousand());
    await rec('s0000', summary(['missing']), 'new-session', 1);
    await rec('new', summary(['missing']));
    const steps = new Set((await env.diag.list()).map((r) => r.stepId));
    expect(steps.has('s0000')).toBe(true);
    expect(steps.has('s0001')).toBe(false);
  });

  it('T-DIAG-29: lastAt が同じ記録が複数あるとき、鍵の順で先のものから削除される', async () => {
    await seed(env.db, Array.from({ length: 1000 }, (_, i) => seedRow(i, 500)));
    env.clock.fixed = true;
    env.clock.t = 500;
    await rec('zzzz', summary(['missing']));
    const steps = new Set((await env.diag.list()).map((r) => r.stepId));
    expect(steps.size).toBe(1000);
    expect(steps.has('s0000')).toBe(false);
    expect(steps.has('s0001')).toBe(true);
    expect(steps.has('zzzz')).toBe(true);
  });

  it('T-DIAG-30: 上限による削除の後も、残った記録の total は変わらない', async () => {
    await seed(env.db, Array.from({ length: 1000 }, (_, i) => seedRow(i, 100 + i, 7)));
    await rec('new', summary(['missing']));
    const list = await env.diag.list();
    expect(list.filter((r) => r.stepId !== 'new').every((r) => r.total === 7)).toBe(true);
  });
});

describe('ツアー削除時の削除と消去', () => {
  beforeEach(async () => {
    await rec('a', summary(['missing']), 's1', 1, 'tour1');
    await rec('b', summary(['degraded']), 's1', 1, 'tour1');
    await rec('a', summary(['missing']), 's1', 1, 'tour2');
  });

  it('T-DIAG-31: ツアーを削除したとき、そのツアーの保守記録がすべて消える', async () => {
    await env.diag.removeTour('tour1');
    expect(await env.diag.list('tour1')).toEqual([]);
  });

  it('T-DIAG-32: ツアーを削除したとき、他のツアーの保守記録は残る', async () => {
    await env.diag.removeTour('tour1');
    expect(await env.diag.list('tour2')).toHaveLength(1);
  });

  it('T-DIAG-33: clear() で、すべてのツアーの保守記録が消える', async () => {
    await env.diag.clear();
    expect(await env.diag.list()).toEqual([]);
  });

  it('T-DIAG-34: 削除・消去の後に同じ (sessionId, gen, reason) を record すると、total が 1 から数え直される', async () => {
    await env.diag.clear();
    await rec('a', summary(['missing']), 's1', 1, 'tour1');
    expect((await env.diag.list('tour1'))[0]?.total).toBe(1);
    await env.diag.removeTour('tour1');
    await rec('a', summary(['missing']), 's1', 1, 'tour1');
    expect((await env.diag.list('tour1'))[0]?.total).toBe(1);
  });
});

describe('一覧と「要確認」', () => {
  it('T-DIAG-35: list(tourId) が、そのツアーの記録だけを、ステップ順に返す', async () => {
    await rec('b', summary(['missing']), 's1', 1, 'tour1');
    await rec('a', summary(['degraded']), 's1', 1, 'tour1');
    await rec('a', summary(['missing']), 's1', 1, 'tour2');
    const list = await env.diag.list('tour1');
    expect(list.map((r) => [r.tourId, r.stepId])).toEqual([
      ['tour1', 'a'],
      ['tour1', 'b'],
    ]);
  });

  const review: [string, LocateReason][] = [
    ['T-DIAG-36', 'degraded'],
    ['T-DIAG-37', 'conflict'],
    ['T-DIAG-38', 'missing'],
    ['T-DIAG-39', 'nameMismatch'],
  ];
  for (const [id, reason] of review) {
    it(`${id}: ${reason} の記録が1件以上あるツアーに「要確認」が付く`, async () => {
      await rec('a', summary([reason]));
      expect(await env.diag.needsReview('t')).toBe(true);
    });
  }

  it('T-DIAG-40: 記録が1件もないツアーには「要確認」が付かない', async () => {
    expect(await env.diag.needsReview('t')).toBe(false);
  });

  it('T-DIAG-41: 他のツアーの記録があっても、記録のないツアーには付かない', async () => {
    await rec('a', summary(['missing']), 's1', 1, 'other');
    expect(await env.diag.needsReview('t')).toBe(false);
    expect(await env.diag.needsReview('other')).toBe(true);
  });

  it('T-DIAG-42: clear() で記録を消したあと、「要確認」が外れる', async () => {
    await rec('a', summary(['missing']));
    await env.diag.clear();
    expect(await env.diag.needsReview('t')).toBe(false);
  });
});

describe('書き出しと文字列を持たないこと', () => {
  it('T-DIAG-43: export() が、保存されたすべての記録を返す', async () => {
    await rec('a', summary(['missing']), 's1', 1, 'tour1');
    await rec('b', summary(['degraded']), 's1', 1, 'tour2');
    expect(await env.diag.export()).toHaveLength(2);
  });

  it('T-DIAG-44: export() の内容に、ページの文字列・URL・入力値・例外のメッセージが含まれない', async () => {
    await rec('a', { ...summary(['nameMismatch']), name: '購入', url: 'https://example.com/', message: 'm' });
    const text = JSON.stringify(await env.diag.export());
    expect(text).not.toContain('購入');
    expect(text).not.toContain('example.com');
    expect(text).not.toContain('"message"');
  });

  it('T-DIAG-45: export() の各記録の項目は一覧に限られ、lastKey を含めない', async () => {
    await rec('a', summary(['missing']));
    const [entry] = await env.diag.export();
    expect(Object.keys(entry ?? {}).sort()).toEqual(
      ['counts', 'lastAt', 'reason', 'stepId', 'tier', 'topTier', 'total', 'tourId'],
    );
  });

  it('T-DIAG-46a: 1回目だけ失敗したとき、古いものを消してから再試行し、2回目で保存される', async () => {
    // 古い順に 10 件。再試行の前に、最も古い1割（1件）が消える
    await seed(env.db, Array.from({ length: 10 }, (_, i) => seedRow(i, 100 + i)));
    env.failFirst.remaining = 1;
    await expect(rec('new', summary(['missing']))).resolves.toBeUndefined();
    expect(env.failures).toEqual([]);
    const steps = (await env.diag.list()).map((r) => r.stepId);
    expect(steps).not.toContain('s0000');
    expect(steps).toContain('s0001');
    expect(steps).toContain('new');
    expect(steps).toHaveLength(10);
  });

  it('T-DIAG-46b: 件数が10件未満でも、再試行の前に最低1件の最も古いものを消す', async () => {
    await seed(env.db, [seedRow(0, 100), seedRow(1, 200)]);
    env.failFirst.remaining = 1;
    await rec('new', summary(['missing']));
    expect((await env.diag.list()).map((r) => r.stepId)).toEqual(['new', 's0001']);
  });

  it('T-DIAG-46c: onFailure が例外を投げても、record は例外を伝えず次の record も動く', async () => {
    const throwing = createDiagnostics({
      getDb: () => Promise.resolve(env.failing.value ? env.closed : env.db),
      now: () => 1,
      onFailure: () => {
        throw new Error('onFailure が投げた');
      },
    });
    env.failing.value = true;
    await expect(throwing.record('t', 'a', 's1', 1, summary(['missing']))).resolves.toBeUndefined();
    env.failing.value = false;
    await throwing.record('t', 'b', 's1', 2, summary(['missing']));
    expect((await throwing.list()).map((r) => r.stepId)).toEqual(['b']);
  });

  it('T-DIAG-46: 保存に失敗しても例外は外へ伝わらず、古いものを消して1回だけ再試行し、だめなら捨てる', async () => {
    env.failing.value = true;
    await expect(rec('a', summary(['missing']))).resolves.toBeUndefined();
    expect(env.failures).toHaveLength(1);
    expect(Object.keys(env.failures[0] ?? {}).sort()).toEqual(['name', 'reason']);
    env.failing.value = false;
    expect(await env.diag.list()).toEqual([]);
    await rec('b', summary(['missing']));
    expect((await env.diag.list()).map((r) => r.stepId)).toEqual(['b']);
  });
});
