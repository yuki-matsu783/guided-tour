/**
 * 状態管理：レビュー指摘の追加ケース。ツアー ID・役割の名前が `Object.prototype` の名前のとき、
 * 一時中断中の上書き、別の役割のタブの保護、タブ管理への実行中のツアーの通知、OPEN_IN の確定の順、
 * `saveError` の保存、同梱版が残る削除を確かめる。
 */
import { describe, expect, it } from 'vitest';
import type { Tour } from '../../core/tour/index.ts';
import {
  Crash,
  ORIGIN,
  ROLE_TAB,
  createEnv,
  cur,
  flush,
  freshOp,
  gotoMsg,
  makeTour,
  startBound,
  startTour,
  waitCrash,
  type Env,
} from './testkit.ts';

const PROTO_NAMES = ['toString', 'constructor', '__proto__', 'hasOwnProperty'];

describe('B-1: Object.prototype の名前のツアー ID・役割', () => {
  it.each(PROTO_NAMES)('T-SES-29: ツアー ID が %s でも、進捗が保存され、一覧と「続きから」に反映される（追加）', async (id) => {
    const env = createEnv(makeTour({ id }));
    const before = await env.session.view();
    expect(before.catalog.map((c) => c.progress)).toEqual([null]);
    await startTour(env, false, id);
    expect(env.state()?.saveError).toBe(false);
    await env.session.handlePanel(gotoMsg(env, 1));
    const stored = env.localArea.data.get('progress');
    expect(typeof stored === 'object' && stored !== null && Object.hasOwn(stored, id)).toBe(true);
    expect(env.state()?.saveError).toBe(false);
    await env.session.handlePanel({ type: 'STOP', sessionId: cur(env).sessionId, opId: freshOp() });
    await startTour(env, false, id);
    await env.session.handlePanel(gotoMsg(env, 1));
    await env.session.handlePanel({ type: 'PAUSE', sessionId: cur(env).sessionId, opId: freshOp() });
    const view = await env.session.view();
    expect(view.catalog[0]?.progress).toMatchObject({ stepIndex: 1, stepId: 's2' });
  });

  it.each(PROTO_NAMES)('T-SES-81: ツアー ID が %s で進捗が無いとき、resume: true でも最初から始まり通知は出ない（追加）', async (id) => {
    const env = createEnv(makeTour({ id }));
    await startTour(env, true, id);
    expect(env.state()).toMatchObject({ status: 'running', stepIndex: 0, notice: null });
  });

  it.each(PROTO_NAMES)('T-SES-32: ツアー ID が %s でも、完了のとき進捗が削除される（追加）', async (id) => {
    const env = createEnv(makeTour({ id }));
    await startTour(env, false, id);
    await env.session.handlePanel(gotoMsg(env, 4));
    const stored = env.localArea.data.get('progress');
    expect(typeof stored === 'object' && stored !== null && Object.hasOwn(stored, id)).toBe(false);
    expect(env.state()?.status).toBe('ended');
  });

  function roleTour(role: string): Tour {
    const base = makeTour();
    return {
      ...base,
      tabs: { ...base.tabs, [role]: { open: `${ORIGIN}/start` } },
      steps: base.steps.map((s) => (s.id === 's1' ? { ...s, tab: role } : s)),
    };
  }

  it.each(['toString', 'constructor', 'hasOwnProperty'])(
    'T-TAB-04: 役割の名前が %s でも、対応付けが無ければ missing で、対応付けた後は自分のキーとして残る（追加）',
    async (role) => {
      const env = createEnv(roleTour(role));
      await startTour(env);
      const view = await env.session.view();
      expect(view.tabStatus?.status).toBe('missing');
      const { sessionId, gen } = cur(env);
      await env.session.handlePanel({ type: 'BIND_TAB', tabId: ROLE_TAB, force: false, sessionId, gen, opId: freshOp() });
      const tabs = env.state()?.tabs ?? {};
      expect(Object.keys(tabs)).toEqual([role]);
      expect(tabs[role]?.tabId).toBe(ROLE_TAB);
    },
  );
});

describe('B-2: 一時中断中の上書き', () => {
  async function pausedBy(how: 'user' | 'permission'): Promise<Env> {
    const env = createEnv();
    await startBound(env);
    if (how === 'user') {
      await env.session.handlePanel({ type: 'PAUSE', sessionId: cur(env).sessionId, opId: freshOp() });
    } else {
      await env.session.onPermissionLost();
    }
    return env;
  }

  it.each(['user', 'permission'] as const)(
    'T-SES-60: %s による一時中断中に上書きされたら、一時中断のまま理由が overwritten になる（追加）',
    async (how) => {
      const env = await pausedBy(how);
      expect(env.state()?.pauseReason).toBe(how);
      env.catalog.set(makeTour(), 'h2');
      await env.session.onCatalogChanged('t1', 'h2');
      expect(env.state()).toMatchObject({ status: 'paused', pauseReason: 'overwritten' });
      expect(env.panels.at(-1)).toMatchObject({ status: 'paused', pauseReason: 'overwritten' });
    },
  );

  it('T-SES-66: 一時中断中に上書きされても、固定した hash のままで、RESUME は受け付けられない（追加）', async () => {
    const env = await pausedBy('user');
    env.catalog.set(makeTour(), 'h2');
    await env.session.onCatalogChanged('t1', 'h2');
    expect(env.state()?.hash).toBe('h1');
    const r = await env.session.handlePanel({ type: 'RESUME', sessionId: cur(env).sessionId, opId: freshOp() });
    expect(r).toEqual({ status: 'rejected', reason: 'notResumable' });
  });

  it('T-SES-71: 一時中断中の上書きの後、RESUME_NEW が受け付けられ、新しい hash で再開される（追加）', async () => {
    const env = await pausedBy('permission');
    env.catalog.set(makeTour(), 'h2');
    await env.session.onCatalogChanged('t1', 'h2');
    const r = await env.session.handlePanel({
      type: 'RESUME_NEW',
      mode: 'continue',
      sessionId: cur(env).sessionId,
      opId: freshOp(),
    });
    expect(r).toEqual({ status: 'done' });
    expect(env.state()).toMatchObject({ status: 'running', hash: 'h2' });
  });

  it('T-SES-62: 一時中断中で hash が同じとき、理由は変わらない（追加）', async () => {
    const env = await pausedBy('user');
    await env.session.onCatalogChanged('t1', 'h1');
    expect(env.state()?.pauseReason).toBe('user');
  });
});

describe('B-3: OPEN_IN current は別の役割のタブを奪わない', () => {
  async function atOtherRole(): Promise<Env> {
    const base = makeTour();
    const env = createEnv({ ...base, tabs: { ...base.tabs, other: { open: `${ORIGIN}/o` } } });
    await startBound(env);
    await env.session.handlePanel(gotoMsg(env, 3));
    env.tabs.clear();
    return env;
  }
  const openIn = (env: Env, mode: 'current' | 'new') => {
    const { sessionId, gen } = cur(env);
    return env.session.handlePanel({ type: 'OPEN_IN', mode, sessionId, gen, opId: freshOp() });
  };

  it('R-B3: 今のタブが別の役割に対応付け済みなら、開かずに tabBoundToOtherRole で拒否し、状態を変えない', async () => {
    const env = await atOtherRole();
    env.tabs.currentTab = ROLE_TAB;
    const before = env.state();
    const r = await openIn(env, 'current');
    expect(r).toEqual({ status: 'rejected', reason: 'tabBoundToOtherRole' });
    expect(env.tabs.opened).toEqual([]);
    expect(env.state()?.tabs).toEqual(before?.tabs);
    expect(env.state()?.recentOpIds).toEqual(before?.recentOpIds);
  });

  it('R-B3: 今のタブが未対応付けなら、開いて対応付ける', async () => {
    const env = await atOtherRole();
    env.tabs.currentTab = 55;
    env.tabs.openResult = 55;
    expect(await openIn(env, 'current')).toEqual({ status: 'done' });
    expect(env.state()?.tabs.other?.tabId).toBe(55);
  });

  it('R-B3: mode: new は今のタブを確かめず、新しいタブを開く', async () => {
    const env = await atOtherRole();
    env.tabs.currentTab = ROLE_TAB;
    env.tabs.openResult = 77;
    expect(await openIn(env, 'new')).toEqual({ status: 'done' });
    expect(env.tabs.opened).toHaveLength(1);
    expect(env.state()?.tabs.other?.tabId).toBe(77);
  });
});

describe('B-5: タブ管理への実行中のツアーの通知', () => {
  it('R-B5: 開始・一時中断・再開・終了・完了のたびに、実行中のツアー（または null）が知らされる', async () => {
    const env = createEnv();
    await startTour(env);
    expect(env.tabs.activeTours.at(-1)).toBe('t1');
    await env.session.handlePanel({ type: 'PAUSE', sessionId: cur(env).sessionId, opId: freshOp() });
    expect(env.tabs.activeTours.at(-1)).toBeNull();
    await env.session.handlePanel({ type: 'RESUME', sessionId: cur(env).sessionId, opId: freshOp() });
    expect(env.tabs.activeTours.at(-1)).toBe('t1');
    await env.session.handlePanel({ type: 'STOP', sessionId: cur(env).sessionId, opId: freshOp() });
    expect(env.tabs.activeTours.at(-1)).toBeNull();
    await startTour(env);
    expect(env.tabs.activeTours.at(-1)).toBe('t1');
    await env.session.handlePanel(gotoMsg(env, 4));
    expect(env.tabs.activeTours.at(-1)).toBeNull();
  });

  it('R-B5: ツアーの削除による終了・復帰でも知らされる', async () => {
    const env = createEnv();
    await startTour(env);
    env.catalog.remove('t1');
    await env.session.onCatalogRemoved('t1');
    expect(env.tabs.activeTours.at(-1)).toBeNull();
    const env2 = createEnv();
    await startTour(env2);
    env2.tabs.clear();
    await env2.restart().recover();
    expect(env2.tabs.activeTours.at(-1)).toBe('t1');
  });
});

describe('B-7: OPEN_IN の確定は2回で、開く前に opId を確定する', () => {
  async function atOtherRole(): Promise<Env> {
    const base = makeTour();
    const env = createEnv({ ...base, tabs: { ...base.tabs, other: { open: `${ORIGIN}/o` } } });
    await startBound(env);
    await env.session.handlePanel(gotoMsg(env, 3));
    env.tabs.clear();
    return env;
  }

  it('T-SES-38: タブを開く前に、opId が storage.session に確定している（追加）', async () => {
    const env = await atOtherRole();
    const { sessionId, gen } = cur(env);
    const op = freshOp();
    const crash = new Crash();
    crash.arm('tabs.open', 'before');
    const s = env.withCrash(crash);
    void s.handlePanel({ type: 'OPEN_IN', mode: 'new', sessionId, gen, opId: op });
    await waitCrash(crash);
    expect(env.state()?.recentOpIds).toContain(op);
    expect(env.tabs.opened).toEqual([]);
  });

  it('T-SES-38: 開いた直後に打ち切って、同じ opId を再送しても、二重に開かない（追加）', async () => {
    const env = await atOtherRole();
    const { sessionId, gen } = cur(env);
    const op = freshOp();
    const crash = new Crash();
    crash.arm('tabs.open', 'after');
    const s = env.withCrash(crash);
    void s.handlePanel({ type: 'OPEN_IN', mode: 'new', sessionId, gen, opId: op });
    await waitCrash(crash);
    const s2 = env.restart();
    await s2.recover();
    await s2.handlePanel({ type: 'OPEN_IN', mode: 'new', sessionId, gen, opId: op });
    await flush();
    expect(env.tabs.opened).toHaveLength(1);
  });

  it('T-SES-21: 正常に終わったとき、opId は1回だけ recentOpIds に入り、対応付けも確定する（追加）', async () => {
    const env = await atOtherRole();
    const { sessionId, gen } = cur(env);
    const op = freshOp();
    await env.session.handlePanel({ type: 'OPEN_IN', mode: 'new', sessionId, gen, opId: op });
    expect(env.state()?.recentOpIds.filter((o) => o === op)).toHaveLength(1);
    expect(env.state()?.tabs.other?.tabId).toBe(99);
  });

  it('R-B7: 開けなかったときは openFailed を返し、同じ opId の再送にも同じ結果を返して再び開かない', async () => {
    const env = await atOtherRole();
    env.tabs.openResult = null;
    const { sessionId, gen } = cur(env);
    const op = freshOp();
    const msg = { type: 'OPEN_IN' as const, mode: 'new' as const, sessionId, gen, opId: op };
    expect(await env.session.handlePanel(msg)).toEqual({ status: 'rejected', reason: 'openFailed' });
    expect(await env.session.handlePanel(msg)).toEqual({ status: 'rejected', reason: 'openFailed' });
    expect(env.tabs.opened).toHaveLength(1);
  });
});

describe('B-10: saveError の保存', () => {
  it('T-SES-56: 進捗の保存に失敗した確定で、storage.session の状態にも saveError が立つ（追加）', async () => {
    const env = await startBound2();
    env.localArea.failSet = (keys) => keys === 'progress';
    await env.session.handlePanel(gotoMsg(env, 1));
    expect(env.state()?.saveError).toBe(true);
  });

  it('T-SES-58: 次の保存が成功した確定で、storage.session の状態の saveError も下りる（追加）', async () => {
    const env = await startBound2();
    env.localArea.failSet = (keys) => keys === 'progress';
    await env.session.handlePanel(gotoMsg(env, 1));
    env.localArea.failSet = false;
    await env.session.handlePanel(gotoMsg(env, 2));
    expect(env.state()?.saveError).toBe(false);
  });

  async function startBound2(): Promise<Env> {
    const env = createEnv();
    await startBound(env);
    return env;
  }
});

describe('同梱版が残る削除', () => {
  it('T-SES-65a: 実行中の取り込み版が削除され、同梱版が残っているとき、終了が確定され、進捗が削除される', async () => {
    const env = createEnv();
    await startBound(env);
    await env.session.handlePanel(gotoMsg(env, 1));
    // 取り込み版が消え、同じ ID の同梱版（別の hash）が残る
    env.catalog.set(makeTour(), 'bundled-h');
    await env.session.onCatalogRemoved('t1');
    expect(env.state()).toMatchObject({ status: 'ended', notice: 'tourRemoved' });
    expect(env.progress().t1).toBeUndefined();
    expect(env.tabs.sent.some((r) => r.to === 'all' && r.message.type === 'CLEAR')).toBe(true);
  });

  it('T-SES-65a: 一時中断中に削除されたときも、終了が確定され、進捗が削除される', async () => {
    const env = createEnv();
    await startBound(env);
    await env.session.handlePanel({ type: 'PAUSE', sessionId: cur(env).sessionId, opId: freshOp() });
    env.catalog.set(makeTour(), 'bundled-h');
    await env.session.onCatalogRemoved('t1');
    expect(env.state()?.status).toBe('ended');
    expect(env.progress().t1).toBeUndefined();
  });

  it('T-SES-65a: 別のツアーの削除や、実行中でないときの削除では何も起きない', async () => {
    const env = createEnv();
    await env.session.onCatalogRemoved('t1');
    await startBound(env);
    await env.session.onCatalogRemoved('other');
    expect(env.state()?.status).toBe('running');
  });
});
