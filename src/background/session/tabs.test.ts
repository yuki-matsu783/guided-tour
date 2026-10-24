/**
 * タブ管理の判定のうち、状態管理の側でしか確かめられないもの（T-TAB のページ世代・HELLO・対応付け・描画指示の送信と抑止）。
 * タブ管理（evaluate など）は偽物。ここで確かめるのは、状態管理がタブの変化と操作にどう応じるか。
 */
import { describe, expect, it } from 'vitest';
import {
  ROLE_TAB,
  cur,
  createEnv,
  freshOp,
  gotoMsg,
  makeTour,
  sender,
  startBound,
  startTour,
  type Env,
} from './testkit.ts';

async function running(): Promise<Env> {
  const env = createEnv();
  await startBound(env);
  return env;
}

const bind = (env: Env, tabId: number, force = false) =>
  env.session.handlePanel({
    type: 'BIND_TAB',
    tabId,
    force,
    sessionId: cur(env).sessionId,
    gen: cur(env).gen,
    opId: freshOp(),
  });

describe('描画指示の送信と抑止', () => {
  it('T-TAB-10: mismatch のとき、表示を消す指示（CLEAR）が送られる', async () => {
    const env = await running();
    env.tabs.evaluateImpl = () => ({ status: 'mismatch' });
    await env.session.onTabEvent({ kind: 'historyStateUpdated', tabId: ROLE_TAB });
    expect(env.tabs.sent.some((r) => r.to === 'all' && r.message.type === 'CLEAR')).toBe(true);
    expect(env.tabs.types()).not.toContain('RENDER');
    expect((await env.session.view()).tabStatus?.status).toBe('mismatch');
  });

  it('T-TAB-22: activated を受けたとき、判定し直され、結果が変わっていれば描画指示が送られる', async () => {
    const env = await running();
    env.tabs.evaluateImpl = () => ({ selected: false, attended: false });
    await env.session.onTabEvent({ kind: 'activated' });
    const rendered = env.tabs.messages('RENDER');
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toMatchObject({ selected: false, attended: false });
    expect(rendered[0]?.hint.stopped).toBe(true);
  });

  it('T-TAB-23: focusChanged を受けたとき、判定し直され、結果が変わっていれば描画指示が送られる', async () => {
    const env = await running();
    env.tabs.evaluateImpl = () => ({ attended: false });
    await env.session.onTabEvent({ kind: 'focusChanged' });
    const rendered = env.tabs.messages('RENDER');
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toMatchObject({ selected: true, attended: false });
  });

  it('T-TAB-24: 判定の結果が変わらないとき、描画指示は送られない', async () => {
    const env = await running();
    await env.session.onTabEvent({ kind: 'activated' });
    await env.session.onTabEvent({ kind: 'focusChanged' });
    await env.session.onTabEvent({ kind: 'completed', tabId: ROLE_TAB });
    expect(env.tabs.sent).toEqual([]);
  });
});

describe('ページ世代', () => {
  const pageSeq = (env: Env): number | undefined => env.state()?.pageSeq;

  it('T-TAB-35: 役割のタブで onCommitted を受けたとき、pageSeq が1増える', async () => {
    const env = await running();
    const before = pageSeq(env) ?? 0;
    await env.session.onTabEvent({ kind: 'committed', tabId: ROLE_TAB });
    expect(pageSeq(env)).toBe(before + 1);
    expect(env.state()?.tabs.main?.documentId).toBeNull();
  });

  it('T-TAB-36: 役割のタブで onHistoryStateUpdated を受けたとき、pageSeq が増え、描画し直される', async () => {
    const env = await running();
    const before = pageSeq(env) ?? 0;
    await env.session.onTabEvent({ kind: 'historyStateUpdated', tabId: ROLE_TAB });
    expect(pageSeq(env)).toBe(before + 1);
    const rendered = env.tabs.messages('RENDER');
    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.pageSeq).toBe(before + 1);
  });

  it('T-TAB-38: 役割でないタブのナビゲーションイベントでは、pageSeq が変わらない', async () => {
    const env = await running();
    const before = JSON.stringify(env.state());
    for (const kind of ['committed', 'historyStateUpdated', 'completed'] as const) {
      await env.session.onTabEvent({ kind, tabId: 77 });
    }
    expect(JSON.stringify(env.state())).toBe(before);
    expect(env.tabs.sent).toEqual([]);
    expect(env.tabs.injected).toEqual([]);
  });

  it('T-TAB-39: onCommitted を受けたとき、ページ側が組み込み直される', async () => {
    const env = await running();
    await env.session.onTabEvent({ kind: 'committed', tabId: ROLE_TAB });
    expect(env.tabs.injected).toEqual([ROLE_TAB]);
    // 文書 ID が無い間は描画を送らず、HELLO を受けてから描画する
    expect(env.tabs.types()).not.toContain('RENDER');
    await env.session.handlePage({ type: 'HELLO' }, sender(ROLE_TAB, 'doc-2'));
    expect(env.tabs.messages('RENDER')).toHaveLength(1);
  });

  it('T-TAB-42: HELLO を受けたとき、その sender.documentId が役割のタブの文書として記録される', async () => {
    const env = createEnv();
    await startTour(env);
    await bind(env, ROLE_TAB);
    expect(env.state()?.tabs.main).toEqual({ tabId: ROLE_TAB, documentId: null });
    const res = await env.session.handlePage({ type: 'HELLO' }, sender(ROLE_TAB, 'doc-42'));
    expect(res).toEqual({ status: 'done' });
    expect(env.state()?.tabs.main).toEqual({ tabId: ROLE_TAB, documentId: 'doc-42' });
  });

  it('T-TAB-43: 同じタブで別の文書（遷移後）から HELLO が届いたとき、documentId が新しい値に更新される', async () => {
    const env = await running();
    await env.session.onTabEvent({ kind: 'committed', tabId: ROLE_TAB });
    await env.session.handlePage({ type: 'HELLO' }, sender(ROLE_TAB, 'doc-new'));
    expect(env.state()?.tabs.main?.documentId).toBe('doc-new');
    // 遷移の通知が届かなくても、別の文書の HELLO で更新し、ページ世代を進める
    const seq = env.state()?.pageSeq ?? 0;
    await env.session.handlePage({ type: 'HELLO' }, sender(ROLE_TAB, 'doc-newer'));
    expect(env.state()?.tabs.main?.documentId).toBe('doc-newer');
    expect(env.state()?.pageSeq).toBe(seq + 1);
  });

  it('T-TAB-44: HELLO が役割のタブ以外から届いたとき、記録されない', async () => {
    const env = await running();
    const before = JSON.stringify(env.state());
    const res = await env.session.handlePage({ type: 'HELLO' }, sender(77, 'doc-x'));
    expect(res).toEqual({ status: 'discarded', reason: 'senderMismatch' });
    expect(JSON.stringify(env.state())).toBe(before);
    const iframe = await env.session.handlePage({ type: 'HELLO' }, sender(ROLE_TAB, 'doc-f', 4));
    expect(iframe.status).toBe('discarded');
  });
});

describe('役割とタブの対応付け', () => {
  it('T-TAB-48: bindTab(tabId, false) で、未対応付けのタブが役割に対応付けられる', async () => {
    const env = createEnv();
    await startTour(env);
    expect(await bind(env, 21)).toEqual({ status: 'done' });
    expect(env.state()?.tabs).toEqual({ main: { tabId: 21, documentId: null } });
  });

  it('T-TAB-49: 対応付けは、利用者が選んだとき（BIND_TAB を受けたとき）だけ行われる', async () => {
    const env = createEnv();
    await startTour(env);
    await env.session.onTabEvent({ kind: 'activated' });
    await env.session.onTabEvent({ kind: 'committed', tabId: 21 });
    await env.session.handlePage({ type: 'HELLO' }, sender(21, 'doc-21'));
    await env.session.handlePanel(gotoMsg(env, 1));
    expect(env.state()?.tabs).toEqual({});
    expect(env.tabs.opened).toEqual([]);
    expect(env.tabs.injected).toEqual([]);
  });

  async function boundToOther(): Promise<Env> {
    // タブ 10 を役割 other（ステップ s4）に対応付けてから、main のステップへ戻る
    const env = createEnv();
    await startTour(env);
    await env.session.handlePanel(gotoMsg(env, 3));
    await bind(env, ROLE_TAB);
    await env.session.handlePanel(gotoMsg(env, 0));
    expect(env.state()?.tabs.other?.tabId).toBe(ROLE_TAB);
    return env;
  }

  it('T-TAB-50: 別の役割に対応付け済みのタブを force なしで bindTab したとき、対応付けは変わらず、確認が必要と返る', async () => {
    const env = await boundToOther();
    const before = JSON.stringify(env.state()?.tabs);
    const res = await bind(env, ROLE_TAB, false);
    expect(res).toEqual({ status: 'confirmBind', boundRole: 'other' });
    expect(JSON.stringify(env.state()?.tabs)).toBe(before);
  });

  it('T-TAB-51: 別の役割に対応付け済みのタブを force ありで bindTab したとき、付け替えられる', async () => {
    const env = await boundToOther();
    expect(await bind(env, ROLE_TAB, true)).toEqual({ status: 'done' });
    expect(env.state()?.tabs.main?.tabId).toBe(ROLE_TAB);
  });

  it('T-TAB-52: 付け替えたとき、元の役割の対応付けが外れ、1つのタブが1つの役割だけに対応付く', async () => {
    const env = await boundToOther();
    await bind(env, ROLE_TAB, true);
    const roles = Object.entries(env.state()?.tabs ?? {}).filter(([, b]) => b.tabId === ROLE_TAB);
    expect(roles.map(([r]) => r)).toEqual(['main']);
    expect(env.state()?.tabs.other).toBeUndefined();
  });

  it('T-TAB-53: 同じ役割に同じタブをもう一度 bindTab したとき、確認なしで変わらない', async () => {
    const env = await running();
    const before = JSON.stringify(env.state()?.tabs);
    const seq = env.state()?.pageSeq;
    expect(await bind(env, ROLE_TAB, false)).toEqual({ status: 'done' });
    expect(JSON.stringify(env.state()?.tabs)).toBe(before);
    expect(env.state()?.pageSeq).toBe(seq);
  });

  it('T-TAB-54: bindTab の後、origins を確認してからページ側が組み込まれ、HELLO の後に RENDER が送られる', async () => {
    const env = createEnv();
    await startTour(env);
    env.tabs.within = false;
    expect(await bind(env, ROLE_TAB)).toEqual({ status: 'rejected', reason: 'outsideOrigins' });
    expect(env.tabs.injected).toEqual([]);
    expect(env.state()?.tabs).toEqual({});
    env.tabs.within = true;
    env.tabs.clear();
    await bind(env, ROLE_TAB);
    expect(env.tabs.injected).toEqual([ROLE_TAB]);
    expect(env.tabs.messages('RENDER')).toEqual([]);
    await env.session.handlePage({ type: 'HELLO' }, sender(ROLE_TAB, 'doc-54'));
    const sent = env.tabs.sent.filter((r) => r.message.type === 'RENDER');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(ROLE_TAB);
    expect(sent[0]?.message).toMatchObject({ selected: true, attended: true });
  });
});

describe('タブを開く・前面に出す', () => {
  const openIn = (env: Env, mode: 'current' | 'new') =>
    env.session.handlePanel({
      type: 'OPEN_IN',
      mode,
      sessionId: cur(env).sessionId,
      gen: cur(env).gen,
      opId: freshOp(),
    });

  it('T-TAB-55: openInTab("current") で、今のタブでステップの URL が開かれ、役割に対応付けられる', async () => {
    const env = createEnv();
    await startTour(env);
    env.tabs.openResult = 31;
    expect(await openIn(env, 'current')).toEqual({ status: 'done' });
    expect(env.tabs.opened).toEqual([{ mode: 'current', url: 'https://example.com/start' }]);
    expect(env.state()?.tabs.main).toEqual({ tabId: 31, documentId: null });
    expect(env.tabs.injected).toEqual([31]);
  });

  it('T-TAB-56: openInTab("new") で、新しいタブが作られ、役割に対応付けられる', async () => {
    const env = createEnv();
    await startTour(env);
    env.tabs.openResult = 32;
    await openIn(env, 'new');
    expect(env.tabs.opened).toEqual([{ mode: 'new', url: 'https://example.com/start' }]);
    expect(env.state()?.tabs.main?.tabId).toBe(32);
    env.tabs.openResult = null;
    expect(await openIn(env, 'new')).toEqual({ status: 'rejected', reason: 'openFailed' });
  });

  it('T-TAB-57: 開く URL が origins に含まれないとき、openInTab は開かない', async () => {
    const base = makeTour();
    const first = base.steps[0];
    if (first === undefined) throw new Error('ステップがない');
    const env = createEnv({ ...base, steps: [{ ...first, open: 'https://evil.example/' }, ...base.steps.slice(1)] });
    await startTour(env);
    expect(await openIn(env, 'new')).toEqual({ status: 'rejected', reason: 'outsideOrigins' });
    expect(env.tabs.opened).toEqual([]);
    expect(env.state()?.tabs).toEqual({});
  });

  it('T-TAB-58: openInTab は、OPEN_IN を受けたときだけ行われ、ステップに入っただけでは開かない', async () => {
    const env = createEnv();
    await startTour(env);
    await env.session.handlePanel(gotoMsg(env, 1));
    await env.session.handlePanel(gotoMsg(env, 0));
    await env.session.recover();
    expect(env.tabs.opened).toEqual([]);
  });

  it('T-TAB-60: 役割にタブがないとき、focusRole() は何も起きない', async () => {
    const env = createEnv();
    await startTour(env);
    env.tabs.clear();
    const res = await env.session.handlePanel({
      type: 'FOCUS_ROLE',
      sessionId: cur(env).sessionId,
      gen: cur(env).gen,
      opId: freshOp(),
    });
    expect(res).toEqual({ status: 'rejected', reason: 'notBound' });
    expect(env.tabs.focused).toEqual([]);
    const bound = await running();
    await bound.session.handlePanel({
      type: 'FOCUS_ROLE',
      sessionId: cur(bound).sessionId,
      gen: cur(bound).gen,
      opId: freshOp(),
    });
    expect(bound.tabs.focused).toEqual([ROLE_TAB]);
  });
});

describe('タブが閉じられたとき', () => {
  it('T-TAB-61: 役割のタブが閉じられたとき（tabs.onRemoved）、対応付けが外れ、ツアーは続く', async () => {
    const env = await running();
    await env.session.onTabEvent({ kind: 'removed', tabId: ROLE_TAB });
    expect(env.state()?.tabs).toEqual({});
    expect(env.state()).toMatchObject({ status: 'running', stepIndex: 0 });
    expect(env.tabs.sent.some((r) => r.to === 'all' && r.message.type === 'CLEAR')).toBe(true);
  });

  it('T-TAB-63: 役割でないタブが閉じられたとき、状態は変わらない', async () => {
    const env = await running();
    const before = JSON.stringify(env.state());
    await env.session.onTabEvent({ kind: 'removed', tabId: 77 });
    expect(JSON.stringify(env.state())).toBe(before);
    expect(env.tabs.sent).toEqual([]);
  });

  it('役割のタブが無い間は、役割に対応付けていないタブの変化・閉鎖でパネルへ通知する。無いときは通知しない', async () => {
    const env = await running();
    await env.session.onTabEvent({ kind: 'removed', tabId: ROLE_TAB });
    env.tabs.evaluateImpl = () => ({ status: 'missing', selected: false, attended: false });
    await env.session.onTabEvent({ kind: 'activated' });
    const before = env.panels.length;
    await env.session.onTabEvent({ kind: 'changed', tabId: 77 });
    await env.session.onTabEvent({ kind: 'removed', tabId: 78 });
    expect(env.panels.length).toBe(before + 2);
    expect(env.tabs.sent.filter((r) => r.message.type === 'RENDER')).toEqual([]);
  });

  it('役割のタブがあるときは、役割に対応付けていないタブの変化で通知しない', async () => {
    const env = await running();
    const before = env.panels.length;
    await env.session.onTabEvent({ kind: 'changed', tabId: 77 });
    expect(env.panels.length).toBe(before);
  });

  it('T-TAB-64: 閉じた後、別のタブを対応付けたとき、同じステップから続けられる', async () => {
    const env = await running();
    await env.session.onTabEvent({ kind: 'removed', tabId: ROLE_TAB });
    expect(await bind(env, 55)).toEqual({ status: 'done' });
    await env.session.handlePage({ type: 'HELLO' }, sender(55, 'doc-55'));
    expect(env.state()).toMatchObject({ stepIndex: 0, stepId: 's1' });
    expect(env.state()?.tabs.main).toEqual({ tabId: 55, documentId: 'doc-55' });
    expect(env.tabs.messages('RENDER').at(-1)?.step.id).toBe('s1');
  });

  it('T-TAB-65: 役割のタブが閉じられたとき、新しいタブが自動で作られない', async () => {
    const env = await running();
    await env.session.onTabEvent({ kind: 'removed', tabId: ROLE_TAB });
    expect(env.tabs.opened).toEqual([]);
  });
});
