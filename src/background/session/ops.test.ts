/**
 * 状態管理：ツアーの改訂（T-SES-60〜73）、開始・移動・一時中断・再開・終了（T-SES-74〜100）、ページ上の表示・設定（T-SES-101〜110）。
 */
import { describe, expect, it } from 'vitest';
import { PageSeqSchema } from '../../shared/ids/index.ts';
import type { Tour } from '../../core/tour/index.ts';
import {
  ROLE_TAB,
  cur,
  createEnv,
  freshOp,
  gen as mkGen,
  gotoMsg,
  makeTour,
  sender,
  startBound,
  startTour,
  type Env,
} from './testkit.ts';

async function running(tour?: Tour): Promise<Env> {
  const env = createEnv(tour);
  await startBound(env);
  return env;
}

const stopMsg = (env: Env) => ({ type: 'STOP' as const, sessionId: cur(env).sessionId, opId: freshOp() });

function withSteps(ids: string[]): Tour {
  const base = makeTour();
  return { ...base, steps: base.steps.filter((s) => ids.includes(s.id)) };
}

describe('ツアーの改訂', () => {
  async function overwritten(env: Env, dropOld = false): Promise<void> {
    env.catalog.keepOldVersions = !dropOld;
    env.catalog.set(makeTour(), 'h2');
    await env.session.onCatalogChanged('t1', 'h2');
  }

  it('T-SES-60: CATALOG_CHANGED で、同じ ID で hash が違うとき、pauseReason: overwritten で一時中断が確定する', async () => {
    const env = await running();
    await overwritten(env);
    expect(env.state()).toMatchObject({ status: 'paused', pauseReason: 'overwritten' });
    expect(env.logs).toContainEqual({ level: 'info', event: 'session.pause', fields: { reason: 'overwritten' } });
    const viaPanel = await running();
    viaPanel.catalog.set(makeTour(), 'h2');
    await viaPanel.session.handlePanel({ type: 'CATALOG_CHANGED', tourId: 't1', hash: 'h2' });
    expect(viaPanel.state()?.pauseReason).toBe('overwritten');
  });

  it('T-SES-61: 上書きによる一時中断で、全タブに CLEAR が送られる', async () => {
    const env = await running();
    await overwritten(env);
    expect(env.tabs.sent.filter((r) => r.to === 'all' && r.message.type === 'CLEAR')).toHaveLength(1);
  });

  it('T-SES-62: CATALOG_CHANGED で、ID が同じで hash も同じとき、何も起きない', async () => {
    const env = await running();
    const before = JSON.stringify(env.state());
    await env.session.onCatalogChanged('t1', 'h1');
    expect(JSON.stringify(env.state())).toBe(before);
    expect(env.tabs.sent).toEqual([]);
  });

  it('T-SES-63: CATALOG_CHANGED で、実行中でないツアーの ID のとき、何も起きない', async () => {
    const env = await running();
    const before = JSON.stringify(env.state());
    await env.session.onCatalogChanged('other-tour', 'h9');
    expect(JSON.stringify(env.state())).toBe(before);
    expect(env.tabs.sent).toEqual([]);
    const idle = createEnv();
    await idle.session.onCatalogChanged('t1', 'h2');
    expect(idle.state()).toBeNull();
  });

  it('T-SES-64: CATALOG_CHANGED で、実行中のツアーが削除されていたとき、終了（ended）が確定され、進捗が削除される', async () => {
    const env = await running();
    const { sessionId } = cur(env);
    env.catalog.remove('t1');
    await env.session.onCatalogChanged('t1', 'h1');
    expect(env.state()).toMatchObject({ status: 'ended', sessionId });
    expect(env.progress().t1).toBeUndefined();
    expect((await env.session.view()).notice).toBe('tourRemoved');
  });

  it('T-SES-65: 実行中のツアーの削除で、全タブに CLEAR が送られ、表示とミニガイドが消える', async () => {
    const env = await running();
    env.catalog.remove('t1');
    await env.session.onCatalogChanged('t1', 'h1');
    expect(env.tabs.sent.some((r) => r.to === 'all' && r.message.type === 'CLEAR')).toBe(true);
    expect(env.tabs.types()).not.toContain('RENDER');
  });

  it('T-SES-66: 上書きによる一時中断の間、実行中のツアーは固定した hash のままで、勝手に新版へ切り替わらない', async () => {
    const env = await running();
    await overwritten(env, true);
    expect(env.state()?.hash).toBe('h1');
    const view = await env.session.view();
    expect(view.tour?.hash).toBe('h1');
    expect(view.status).toBe('paused');
    expect(env.tabs.types()).not.toContain('RENDER');
  });

  it('T-SES-67: RESUME_NEW{continue} で、同じ stepId のステップから、新しい sessionId・新しい hash で再開される', async () => {
    const env = await running();
    await env.session.handlePanel(gotoMsg(env, 1));
    const old = cur(env).sessionId;
    await overwritten(env);
    const res = await env.session.handlePanel({
      type: 'RESUME_NEW',
      mode: 'continue',
      sessionId: old,
      opId: freshOp(),
    });
    expect(res).toEqual({ status: 'done' });
    const st = env.state();
    expect(st).toMatchObject({ status: 'running', stepId: 's2', stepIndex: 1, hash: 'h2' });
    expect(st?.sessionId).not.toBe(old);
    expect(env.progress().t1).toMatchObject({ sessionId: st?.sessionId, stepId: 's2' });
  });

  it('T-SES-68: RESUME_NEW{continue} で、同じ stepId が新版にないとき、最初のステップから再開される', async () => {
    const env = await running();
    await env.session.handlePanel(gotoMsg(env, 1));
    env.catalog.set(withSteps(['s1', 's3', 's4']), 'h2');
    await env.session.onCatalogChanged('t1', 'h2');
    await env.session.handlePanel({
      type: 'RESUME_NEW',
      mode: 'continue',
      sessionId: cur(env).sessionId,
      opId: freshOp(),
    });
    expect(env.state()).toMatchObject({ stepId: 's1', stepIndex: 0, hash: 'h2' });
    expect((await env.session.view()).notice).toBe('restartedFromFirst');
  });

  it('T-SES-69: RESUME_NEW{restart} で、最初のステップから新しい sessionId で再開される', async () => {
    const env = await running();
    await env.session.handlePanel(gotoMsg(env, 1));
    const old = cur(env).sessionId;
    await overwritten(env);
    await env.session.handlePanel({ type: 'RESUME_NEW', mode: 'restart', sessionId: old, opId: freshOp() });
    expect(env.state()).toMatchObject({ status: 'running', stepId: 's1', stepIndex: 0 });
    expect(env.state()?.sessionId).not.toBe(old);
  });

  it('T-SES-70: RESUME_NEW で、gen が新しい実行回で1から始まる', async () => {
    const env = await running();
    await env.session.handlePanel(gotoMsg(env, 1));
    await env.session.handlePanel(gotoMsg(env, 0));
    expect(env.state()?.gen).toBe(3);
    await overwritten(env);
    await env.session.handlePanel({
      type: 'RESUME_NEW',
      mode: 'continue',
      sessionId: cur(env).sessionId,
      opId: freshOp(),
    });
    expect(env.state()?.gen).toBe(1);
  });

  it('T-SES-71: RESUME_NEW が、上書きによる一時中断でないとき（実行中・利用者の操作・許可の取り消し）、受け付けられない', async () => {
    const env = await running();
    const msg = () => ({
      type: 'RESUME_NEW' as const,
      mode: 'restart' as const,
      sessionId: cur(env).sessionId,
      opId: freshOp(),
    });
    expect(await env.session.handlePanel(msg())).toEqual({ status: 'rejected', reason: 'notOverwritten' });
    await env.session.handlePanel({ type: 'PAUSE', sessionId: cur(env).sessionId, opId: freshOp() });
    expect(await env.session.handlePanel(msg())).toEqual({ status: 'rejected', reason: 'notOverwritten' });
    const permission = await running();
    await permission.session.onPermissionLost();
    const res = await permission.session.handlePanel({
      type: 'RESUME_NEW',
      mode: 'restart',
      sessionId: cur(permission).sessionId,
      opId: freshOp(),
    });
    expect(res).toEqual({ status: 'rejected', reason: 'notOverwritten' });
    expect(permission.state()?.status).toBe('paused');
  });

  it('T-SES-72: 上書きによる一時中断の選択肢「終了」で、STOP が処理されて進捗が破棄される', async () => {
    const env = await running();
    await overwritten(env);
    const res = await env.session.handlePanel(stopMsg(env));
    expect(res).toEqual({ status: 'done' });
    expect(env.state()?.status).toBe('ended');
    expect(env.progress().t1).toBeUndefined();
  });

  it('T-SES-73: RESUME_NEW で、新しい sessionId が前の実行回と異なる', async () => {
    const env = await running();
    const old = cur(env).sessionId;
    await overwritten(env);
    await env.session.handlePanel({ type: 'RESUME_NEW', mode: 'continue', sessionId: old, opId: freshOp() });
    expect(env.state()?.sessionId).not.toBe(old);
    // 前の実行回の識別子の操作は捨てられる
    const stale = await env.session.handlePanel({ type: 'STOP', sessionId: old, opId: freshOp() });
    expect(stale.status).toBe('discarded');
  });
});

function seedProgress(env: Env, stepId: string, stepIndex: number): void {
  env.localArea.data.set('progress', {
    t1: { sessionId: 'old-run', gen: 4, stepId, stepIndex, savedAt: 5 },
  });
}

describe('開始・移動・一時中断・再開・終了', () => {
  it('T-SES-74: start で、ツアーの hash が固定され、新しい sessionId・gen = 1 で状態が作られる', async () => {
    const env = createEnv();
    const res = await env.session.handlePanel({ type: 'START', tourId: 't1', resume: false, opId: freshOp() });
    expect(res).toEqual({ status: 'done' });
    expect(env.state()).toMatchObject({
      status: 'running',
      sessionId: 'sess-1',
      gen: 1,
      hash: 'h1',
      tourId: 't1',
      stepIndex: 0,
      stepId: 's1',
    });
    expect(env.logs).toContainEqual({ level: 'info', event: 'session.start', fields: { resume: false } });
    const busy = await env.session.handlePanel({ type: 'START', tourId: 't1', resume: false, opId: freshOp() });
    expect(busy).toEqual({ status: 'rejected', reason: 'busy' });
  });

  it('T-SES-75: start で、必要な拡張機能のバージョンを満たすとき、開始される', async () => {
    const env = createEnv(makeTour({ minExtensionVersion: '1.0.0' }));
    env.version.value = '1.2.0';
    env.restart();
    expect(await env.session.handlePanel({ type: 'START', tourId: 't1', resume: false, opId: freshOp() })).toEqual({
      status: 'done',
    });
    expect(env.state()?.status).toBe('running');
  });

  it('T-SES-76: start で、必要なバージョンが現在より高いとき、開始されず、状態も作られず、現在と必要なバージョンが返る', async () => {
    const env = createEnv(makeTour({ minExtensionVersion: '2.1.0' }));
    const res = await env.session.handlePanel({ type: 'START', tourId: 't1', resume: false, opId: freshOp() });
    expect(res).toEqual({ status: 'rejected', reason: 'versionTooLow', current: '1.0.0', required: '2.1.0' });
    expect(env.state()).toBeNull();
    expect(env.progress().t1).toBeUndefined();
  });

  it('T-SES-77: start で、必要なバージョンが現在と同じとき、開始される（境界）', async () => {
    const env = createEnv(makeTour({ minExtensionVersion: '1.0.0' }));
    const res = await env.session.handlePanel({ type: 'START', tourId: 't1', resume: false, opId: freshOp() });
    expect(res).toEqual({ status: 'done' });
  });

  it('T-SES-78: start で、ツアーが最低バージョンを宣言していないとき、バージョンの理由では拒否されない', async () => {
    const env = createEnv();
    const res = await env.session.handlePanel({ type: 'START', tourId: 't1', resume: false, opId: freshOp() });
    expect(res.status).toBe('done');
  });

  it('T-SES-79: start で、origins の権限がないとき、開始されず、状態も作られず、必要なサイトが返る', async () => {
    const env = createEnv();
    env.perms.has = false;
    const res = await env.session.handlePanel({ type: 'START', tourId: 't1', resume: false, opId: freshOp() });
    expect(res).toEqual({ status: 'rejected', reason: 'permissionMissing', origins: ['https://example.com'] });
    expect(env.state()).toBeNull();
  });

  it('T-SES-80: start(resume: false) で、進捗があっても最初のステップから始まる', async () => {
    const env = createEnv();
    seedProgress(env, 's2', 1);
    await startTour(env, false);
    expect(env.state()).toMatchObject({ stepId: 's1', stepIndex: 0 });
  });

  it('T-SES-81: start(resume: true) で、進捗の stepId のステップから始まる', async () => {
    const env = createEnv();
    seedProgress(env, 's2', 1);
    await startTour(env, true);
    expect(env.state()).toMatchObject({ stepId: 's2', stepIndex: 1, gen: 1 });
    expect((await env.session.view()).notice).toBeNull();
  });

  it('T-SES-82: start(resume: true) で、進捗の stepId がツアーに無いとき、ステップ1から始まり、その旨の通知が出る', async () => {
    const env = createEnv();
    seedProgress(env, 'removed-step', 7);
    await startTour(env, true);
    expect(env.state()).toMatchObject({ stepId: 's1', stepIndex: 0 });
    expect((await env.session.view()).notice).toBe('restartedFromFirst');
  });

  it('T-SES-83: start(resume: true) で、進捗がないとき、最初から始まる', async () => {
    const env = createEnv();
    await startTour(env, true);
    expect(env.state()).toMatchObject({ stepId: 's1', stepIndex: 0 });
  });

  it('T-SES-84: start の確定後、進捗が storage.local に書かれる', async () => {
    const env = createEnv();
    await startTour(env);
    expect(env.progress().t1).toMatchObject({ sessionId: 'sess-1', gen: 1, stepId: 's1', stepIndex: 0 });
  });

  it('T-SES-85: goto(to) を受け付けたとき、gen が1増え、stepIndex と stepId が更新される', async () => {
    const env = await running();
    await env.session.handlePanel(gotoMsg(env, 1));
    expect(env.state()).toMatchObject({ gen: 2, stepIndex: 1, stepId: 's2' });
    expect(env.logs).toContainEqual({ level: 'info', event: 'session.goto', fields: { from: 0, to: 1, accepted: true } });
  });

  it('T-SES-86: goto で、to が最終ステップの次のとき、完了となり、ended が確定されて進捗が削除される', async () => {
    const env = await running();
    const { sessionId } = cur(env);
    await env.session.handlePanel(gotoMsg(env, 4));
    expect(env.state()).toMatchObject({ status: 'ended', sessionId });
    expect(env.progress().t1).toBeUndefined();
    expect(env.logs.some((l) => l.event === 'session.complete')).toBe(true);
  });

  it('T-SES-87: 完了のとき、全タブに CLEAR が送られる', async () => {
    const env = await running();
    await env.session.handlePanel(gotoMsg(env, 4));
    expect(env.tabs.sent.some((r) => r.to === 'all' && r.message.type === 'CLEAR')).toBe(true);
  });

  it('T-SES-88: ステップ一覧から任意のステップへ goto したとき、そのステップに移り、自動では先へ進まない', async () => {
    const env = await running();
    await env.session.handlePanel(gotoMsg(env, 3));
    expect(env.state()).toMatchObject({ stepId: 's4', stepIndex: 3 });
    await env.session.handlePage({ type: 'HELLO' }, sender());
    expect(env.state()?.stepIndex).toBe(3);
  });

  it('T-SES-89: 完了の目安を満たしていなくても、goto が受け付けられる', async () => {
    const env = await running();
    expect(env.state()?.hint.met).toBe(false);
    expect(await env.session.handlePanel(gotoMsg(env, 1))).toEqual({ status: 'done' });
  });

  it('T-SES-90: 最初のステップから「戻る」の goto(-1) が来たとき、移動しない', async () => {
    const env = await running();
    const res = await env.session.handlePanel(gotoMsg(env, -1));
    expect(res).toEqual({ status: 'discarded', reason: 'outOfRange' });
    expect(env.state()).toMatchObject({ gen: 1, stepIndex: 0 });
    const beyond = await env.session.handlePanel(gotoMsg(env, 5));
    expect(beyond.status).toBe('discarded');
  });

  it('T-SES-91: pause で、pauseReason: user の一時中断が確定し、全タブに CLEAR が送られる', async () => {
    const env = await running();
    await env.session.handlePanel({ type: 'PAUSE', sessionId: cur(env).sessionId, opId: freshOp() });
    expect(env.state()).toMatchObject({ status: 'paused', pauseReason: 'user' });
    expect(env.tabs.sent.some((r) => r.to === 'all' && r.message.type === 'CLEAR')).toBe(true);
    expect(env.logs).toContainEqual({ level: 'info', event: 'session.pause', fields: { reason: 'user' } });
  });

  it('T-SES-92: pause の間、タブからの報告と、gen に依存する操作が処理されない', async () => {
    const env = await running();
    const { sessionId, gen } = cur(env);
    const pageSeq = PageSeqSchema.parse(env.state()?.pageSeq ?? 0);
    await env.session.handlePanel({ type: 'PAUSE', sessionId, opId: freshOp() });
    const report = await env.session.handlePage(
      { type: 'HINT_STATE', sessionId, gen, pageSeq, met: true, unsupported: false },
      sender(),
    );
    expect(report.status).toBe('discarded');
    expect(env.state()?.hint.met).toBe(false);
    for (const msg of [
      { type: 'GOTO' as const, to: 1, sessionId, gen, opId: freshOp() },
      { type: 'RECHECK' as const, sessionId, gen, opId: freshOp() },
      { type: 'BIND_TAB' as const, tabId: 14, force: false, sessionId, gen, opId: freshOp() },
      { type: 'SCROLL_TO_TARGET' as const, sessionId, gen, opId: freshOp() },
    ]) {
      expect(await env.session.handlePanel(msg)).toEqual({ status: 'rejected', reason: 'notRunning' });
    }
    expect(env.state()).toMatchObject({ stepIndex: 0, gen: 1 });
  });

  it('T-SES-93: resume で、gen が1増え、描画指示が送られる', async () => {
    const env = await running();
    await env.session.handlePanel({ type: 'PAUSE', sessionId: cur(env).sessionId, opId: freshOp() });
    env.tabs.clear();
    const res = await env.session.handlePanel({ type: 'RESUME', sessionId: cur(env).sessionId, opId: freshOp() });
    expect(res).toEqual({ status: 'done' });
    expect(env.state()).toMatchObject({ status: 'running', gen: 2 });
    const rendered = env.tabs.messages('RENDER');
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toMatchObject({ gen: 2, index: 0 });
  });

  it('T-SES-94: resume が、許可の取り消しによる一時中断の状態で、権限が戻っていないとき、再開されない', async () => {
    const env = await running();
    await env.session.onPermissionLost();
    env.perms.has = false;
    const msg = () => ({ type: 'RESUME' as const, sessionId: cur(env).sessionId, opId: freshOp() });
    expect(await env.session.handlePanel(msg())).toEqual({ status: 'rejected', reason: 'permissionNotRestored' });
    expect(env.state()?.status).toBe('paused');
    env.perms.has = true;
    expect(await env.session.handlePanel(msg())).toEqual({ status: 'done' });
    expect(env.state()?.status).toBe('running');
  });

  it('T-SES-95: stop で、ended が確定し、進捗が削除され、全タブに CLEAR が送られる', async () => {
    const env = await running();
    const { sessionId } = cur(env);
    await env.session.handlePanel(stopMsg(env));
    expect(env.state()).toMatchObject({ status: 'ended', sessionId });
    expect(env.progress().t1).toBeUndefined();
    expect(env.tabs.sent.some((r) => r.to === 'all' && r.message.type === 'CLEAR')).toBe(true);
  });

  it('T-SES-96: 一時中断中でも stop が受け付けられる', async () => {
    const env = await running();
    await env.session.handlePanel({ type: 'PAUSE', sessionId: cur(env).sessionId, opId: freshOp() });
    expect(await env.session.handlePanel(stopMsg(env))).toEqual({ status: 'done' });
    expect(env.state()?.status).toBe('ended');
  });

  it('T-SES-97: restart で、新しい sessionId・ステップ1で状態が作られ、同じ hash が保たれる', async () => {
    const env = await running();
    await env.session.handlePanel(gotoMsg(env, 1));
    const old = cur(env).sessionId;
    const res = await env.session.handlePanel({ type: 'RESTART', sessionId: old, opId: freshOp() });
    expect(res).toEqual({ status: 'done' });
    const st = env.state();
    expect(st).toMatchObject({ status: 'running', stepIndex: 0, stepId: 's1', gen: 1, hash: 'h1' });
    expect(st?.sessionId).not.toBe(old);
    expect(env.progress().t1).toMatchObject({ sessionId: st?.sessionId, stepId: 's1' });
  });

  it('T-SES-98: restart の後、前の sessionId からの操作・報告が捨てられる', async () => {
    const env = await running();
    const old = cur(env);
    const pageSeq = PageSeqSchema.parse(env.state()?.pageSeq ?? 0);
    await env.session.handlePanel({ type: 'RESTART', sessionId: old.sessionId, opId: freshOp() });
    const op = await env.session.handlePanel({ type: 'GOTO', to: 1, sessionId: old.sessionId, gen: old.gen, opId: freshOp() });
    expect(op).toEqual({ status: 'discarded', reason: 'staleSession' });
    const report = await env.session.handlePage(
      { type: 'HINT_STATE', sessionId: old.sessionId, gen: old.gen, pageSeq, met: true, unsupported: false },
      sender(),
    );
    expect(report).toEqual({ status: 'discarded', reason: 'staleSession' });
    expect(env.state()).toMatchObject({ stepIndex: 0 });
  });

  it('T-SES-99: permissions.onRemoved による一時中断の依頼で、pauseReason: permission が確定し、表示が消える', async () => {
    const env = await running();
    env.tabs.clear();
    await env.session.onPermissionLost();
    expect(env.state()).toMatchObject({ status: 'paused', pauseReason: 'permission' });
    expect(env.tabs.sent.some((r) => r.to === 'all' && r.message.type === 'CLEAR')).toBe(true);
    expect((await env.session.view()).pauseReason).toBe('permission');
    // 実行中でなければ何も起きない
    const before = JSON.stringify(env.state());
    await env.session.onPermissionLost();
    expect(JSON.stringify(env.state())).toBe(before);
  });

  it('T-SES-100: 自動でステップが進むことがない（目安を満たしても goto が起きない）', async () => {
    const env = await running();
    const { sessionId, gen } = cur(env);
    const pageSeq = PageSeqSchema.parse(env.state()?.pageSeq ?? 0);
    await env.session.handlePage(
      { type: 'HINT_STATE', sessionId, gen, pageSeq, met: true, unsupported: false },
      sender(),
    );
    env.tabs.evaluateImpl = () => ({ status: 'donePage' });
    await env.session.onTabEvent({ kind: 'historyStateUpdated', tabId: ROLE_TAB });
    expect(env.state()).toMatchObject({ stepIndex: 0, gen: 1 });
    expect(env.logs.some((l) => l.event === 'session.goto')).toBe(false);
  });
});

describe('ページ上の表示・設定', () => {
  it('T-SES-101: setOverlay(hidden: true) で、overlayHidden が確定し、描画指示が送られる', async () => {
    const env = await running();
    await env.session.handlePanel({ type: 'SET_OVERLAY', hidden: true, sessionId: cur(env).sessionId, opId: freshOp() });
    expect(env.state()?.overlayHidden).toBe(true);
    const rendered = env.tabs.messages('RENDER');
    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.overlay).toEqual({ hidden: true });
  });

  it('T-SES-102: overlayHidden は、ステップの移動・ページの移動でも false に戻らない', async () => {
    const env = await running();
    await env.session.handlePanel({ type: 'SET_OVERLAY', hidden: true, sessionId: cur(env).sessionId, opId: freshOp() });
    await env.session.handlePanel(gotoMsg(env, 1));
    expect(env.state()?.overlayHidden).toBe(true);
    await env.session.onTabEvent({ kind: 'committed', tabId: ROLE_TAB });
    await env.session.handlePage({ type: 'HELLO' }, sender(ROLE_TAB, 'doc-after'));
    expect(env.state()?.overlayHidden).toBe(true);
    expect(env.tabs.messages('RENDER').at(-1)?.overlay).toEqual({ hidden: true });
  });

  it('T-SES-103: overlayHidden が真でも、目安の判定と案内は止まらない', async () => {
    const env = await running();
    const { sessionId, gen } = cur(env);
    await env.session.handlePanel({ type: 'SET_OVERLAY', hidden: true, sessionId, opId: freshOp() });
    const pageSeq = PageSeqSchema.parse(env.state()?.pageSeq ?? 0);
    const res = await env.session.handlePage(
      { type: 'HINT_STATE', sessionId, gen, pageSeq, met: true, unsupported: false },
      sender(),
    );
    expect(res).toEqual({ status: 'done' });
    expect((await env.session.view()).hint.met).toBe(true);
    env.tabs.evaluateImpl = () => ({ status: 'donePage' });
    await env.session.onTabEvent({ kind: 'historyStateUpdated', tabId: ROLE_TAB });
    expect(env.tabs.messages('RENDER').at(-1)).toMatchObject({ donePage: true, overlay: { hidden: true } });
  });

  it('T-SES-104: setUi(mode, width) で、設定が storage.local の settings.miniGuide に保存される', async () => {
    const env = await running();
    await env.session.handlePanel({ type: 'SET_UI', mode: 'minimized', width: 400 });
    expect(env.localArea.data.get('settings')).toMatchObject({
      miniGuide: { enabled: true, mode: 'minimized', width: 400 },
    });
    expect((await env.session.view()).ui).toEqual({ enabled: true, mode: 'minimized', width: 400 });
    const idle = createEnv();
    await idle.session.handlePanel({ type: 'SET_UI', width: 300 });
    expect(idle.localArea.data.get('settings')).toMatchObject({ miniGuide: { width: 300 } });
  });

  it('T-SES-105: setUi の変更が、描画指示で反映される', async () => {
    const env = await running();
    await env.session.handlePanel({ type: 'SET_UI', mode: 'hover', width: 500 });
    const rendered = env.tabs.messages('RENDER');
    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.ui).toEqual({ enabled: true, mode: 'hover', width: 500 });
  });

  it('T-SES-106: setUi で範囲外の width が来たとき、240〜560 px に収められて保存される', async () => {
    const env = await running();
    await env.session.handlePanel({ type: 'SET_UI', width: 1000 });
    expect((await env.session.view()).ui.width).toBe(560);
    await env.session.handlePanel({ type: 'SET_UI', width: 10 });
    expect((await env.session.view()).ui.width).toBe(240);
    expect(env.localArea.data.get('settings')).toMatchObject({ miniGuide: { width: 240 } });
  });

  it('T-SES-107: setUi で enabled だけを変えたとき、mode と width が保たれる', async () => {
    const env = await running();
    await env.session.handlePanel({ type: 'SET_UI', mode: 'minimized', width: 420 });
    await env.session.handlePanel({ type: 'SET_UI', enabled: false });
    expect((await env.session.view()).ui).toEqual({ enabled: false, mode: 'minimized', width: 420 });
  });

  it('T-SES-108: recheck() で、gen が一致するとき、RECHECK{rev} が役割のタブに送られる', async () => {
    const env = await running();
    await env.session.handlePanel({ type: 'RECHECK', sessionId: cur(env).sessionId, gen: cur(env).gen, opId: freshOp() });
    const hit = env.tabs.sent.filter((r) => r.message.type === 'RECHECK');
    expect(hit).toHaveLength(1);
    expect(hit[0]?.to).toBe(ROLE_TAB);
    expect(hit[0]?.message).toMatchObject({ rev: env.state()?.rev });
    const stale = await env.session.handlePanel({
      type: 'RECHECK',
      sessionId: cur(env).sessionId,
      gen: mkGen(cur(env).gen - 1),
      opId: freshOp(),
    });
    expect(stale.status).toBe('discarded');
  });

  it('T-SES-109: scrollToTarget() で、gen が一致するとき、SCROLL_TO_TARGET{rev} が役割のタブに送られる', async () => {
    const env = await running();
    await env.session.handlePanel({
      type: 'SCROLL_TO_TARGET',
      sessionId: cur(env).sessionId,
      gen: cur(env).gen,
      opId: freshOp(),
    });
    const hit = env.tabs.sent.filter((r) => r.message.type === 'SCROLL_TO_TARGET');
    expect(hit).toHaveLength(1);
    expect(hit[0]?.to).toBe(ROLE_TAB);
    expect(hit[0]?.message).toMatchObject({ rev: env.state()?.rev });
  });

  it('T-SES-110: ページ側からの HINT_STATE の結果が、状態の hint に反映され、サイドパネルへ通知される', async () => {
    const env = await running();
    const { sessionId, gen } = cur(env);
    const pageSeq = PageSeqSchema.parse(env.state()?.pageSeq ?? 0);
    env.panels.length = 0;
    await env.session.handlePage(
      { type: 'HINT_STATE', sessionId, gen, pageSeq, met: true, unsupported: true },
      sender(),
    );
    expect(env.state()?.hint).toEqual({ gen, met: true, unsupported: true });
    expect(env.panels.at(-1)?.hint).toMatchObject({ met: true, unsupported: true });
  });
});

