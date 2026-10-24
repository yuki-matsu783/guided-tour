/**
 * 状態管理：保存処理の各段階で打ち切ったときの復帰（T-SES-35〜49）、削除待ち（T-SES-50〜54）、保存の失敗（T-SES-55〜59）。
 * 打ち切りは、指定した storage の書き込み・外への作用の前後で処理を止め（以後その実体は何も返さない）、
 * 同じ storage の上で新しい実体を作って `recover()` を走らせる。
 */
import { describe, expect, it } from 'vitest';
import type { BgToPage } from '../../shared/messages/index.ts';
import {
  Crash,
  cur,
  createEnv,
  freshOp,
  gotoMsg,
  startBound,
  waitCrash,
  type Env,
} from './testkit.ts';

async function running(): Promise<Env> {
  const env = createEnv();
  await startBound(env);
  return env;
}

interface Outcome {
  env: Env;
  /** 打ち切りまでに送られた指示。 */
  before: BgToPage[];
  /** 復帰の後に送られた指示。 */
  after: BgToPage[];
}

/** `act` の途中の `label` の `when` で打ち切り、復帰させる。 */
async function crashAt(
  label: string,
  when: 'before' | 'after',
  act: (env: Env) => Promise<unknown>,
  prep?: (env: Env) => Promise<void> | void,
  nth = 1,
): Promise<Outcome> {
  const env = await running();
  if (prep !== undefined) await prep(env);
  const crash = new Crash();
  env.withCrash(crash);
  crash.arm(label, when, nth);
  void act(env);
  await waitCrash(crash);
  const before = env.tabs.sent.map((r) => r.message);
  env.tabs.clear();
  const next = env.restart();
  await next.recover();
  return { env, before, after: env.tabs.sent.map((r) => r.message) };
}

const renders = (msgs: BgToPage[]) => msgs.flatMap((m) => (m.type === 'RENDER' ? [m] : []));
const syncs = (msgs: BgToPage[]) => msgs.flatMap((m) => (m.type === 'SYNC' ? [m] : []));

describe('保存処理の各段階での打ち切りと復帰', () => {
  const goto = (env: Env): Promise<unknown> => env.session.handlePanel(gotoMsg(env, 1));

  it('T-SES-35: GOTO で storage.session への書き込みの前に打ち切って復帰したとき、状態は移動前のままで、表示が二重にならない', async () => {
    const { env, before, after } = await crashAt('session.set', 'before', goto);
    expect(before).toEqual([]);
    expect(env.state()).toMatchObject({ stepIndex: 0, stepId: 's1', gen: 1 });
    expect(renders(after).map((r) => r.step.id)).toEqual(['s1']);
  });

  it('T-SES-36: GOTO で storage.session への書き込み直後（進捗の前）に打ち切って復帰したとき、状態は移動後で、進捗が書き直される', async () => {
    const { env } = await crashAt('session.set', 'after', goto);
    expect(env.state()).toMatchObject({ stepIndex: 1, stepId: 's2', gen: 2 });
    expect(env.progress().t1).toMatchObject({ gen: 2, stepId: 's2', stepIndex: 1 });
  });

  it('T-SES-37: GOTO で進捗の書き込み後（RENDER の前）に打ち切って復帰したとき、rev が進み、SYNC で現在のステップが描画される', async () => {
    const { env, before, after } = await crashAt('local.set', 'after', goto);
    expect(before).toEqual([]);
    const st = env.state();
    expect(st).toMatchObject({ stepIndex: 1, gen: 2 });
    expect(syncs(after)).toHaveLength(1);
    expect(syncs(after)[0]).toMatchObject({ sessionId: st?.sessionId, gen: 2 });
    expect(renders(after).map((r) => r.step.id)).toEqual(['s2']);
  });

  it('T-SES-38: GOTO で RENDER の送信後（応答前）に打ち切って復帰したとき、ステップが二重に移動しない', async () => {
    const { env, before, after } = await crashAt('tabs.send', 'after', goto);
    expect(renders(before).map((r) => r.step.id)).toEqual(['s2']);
    expect(env.state()).toMatchObject({ stepIndex: 1, gen: 2 });
    expect(renders(after).map((r) => r.step.id)).toEqual(['s2']);
  });

  const complete = (env: Env): Promise<unknown> => env.session.handlePanel(gotoMsg(env, 4));
  const stop = (env: Env): Promise<unknown> =>
    env.session.handlePanel({ type: 'STOP', sessionId: cur(env).sessionId, opId: freshOp() });

  it('T-SES-39: 完了で ended の確定後（進捗の削除前）に打ち切って復帰したとき、同じ sessionId の進捗が削除され、復活しない', async () => {
    const { env } = await crashAt('local.set', 'before', complete);
    expect(env.state()?.status).toBe('ended');
    expect(env.progress().t1).toBeUndefined();
    await env.restart().recover();
    expect(env.progress().t1).toBeUndefined();
    const view = await env.session.view();
    expect(view.catalog[0]?.progress).toBeNull();
  });

  it('T-SES-40: 終了で ended の確定前に打ち切って復帰したとき、実行中として復帰する', async () => {
    const { env, after } = await crashAt('session.set', 'before', stop);
    expect(env.state()?.status).toBe('running');
    expect(env.progress().t1).toBeDefined();
    expect(renders(after)).toHaveLength(1);
  });

  it('T-SES-41: 終了で進捗の削除の途中（前後）に打ち切って復帰したとき、進捗が復活しない', async () => {
    for (const when of ['before', 'after'] as const) {
      const { env } = await crashAt('local.set', when, stop);
      expect(env.state()?.status).toBe('ended');
      expect(env.progress().t1).toBeUndefined();
    }
  });

  it('T-SES-42: 復帰時、状態が実行中で進捗の gen が状態より小さいとき、状態に合わせて進捗が書き直される', async () => {
    const env = await running();
    await env.session.handlePanel(gotoMsg(env, 1));
    const { sessionId } = cur(env);
    env.localArea.data.set('progress', { t1: { sessionId, gen: 1, stepId: 's1', stepIndex: 0, savedAt: 1 } });
    await env.restart().recover();
    expect(env.progress().t1).toMatchObject({ sessionId, gen: 2, stepId: 's2', stepIndex: 1 });
  });

  it('T-SES-43: 復帰時、状態が ended で同じ sessionId の進捗が残っているとき、それが削除される', async () => {
    const env = await running();
    const { sessionId } = cur(env);
    await stop(env);
    env.localArea.data.set('progress', { t1: { sessionId, gen: 1, stepId: 's1', stepIndex: 0, savedAt: 1 } });
    await env.restart().recover();
    expect(env.progress().t1).toBeUndefined();
  });

  it('T-SES-44: 復帰時、状態が ended で別の sessionId の進捗があるとき、削除されない', async () => {
    const env = await running();
    await stop(env);
    const other = { sessionId: 'another-run', gen: 1, stepId: 's1', stepIndex: 0, savedAt: 1 };
    env.localArea.data.set('progress', { t1: other });
    await env.restart().recover();
    expect(env.progress().t1).toEqual(other);
  });

  it('T-SES-45: 復帰時、実行中なら rev が進められ、役割のタブに SYNC{sessionId, gen, rev} が送られ、現在のステップが描画し直される', async () => {
    const env = await running();
    const revBefore = env.state()?.rev ?? 0;
    await env.restart().recover();
    const st = env.state();
    const sync = syncs(env.tabs.sent.map((r) => r.message));
    expect(sync).toHaveLength(1);
    expect(sync[0]).toMatchObject({ sessionId: st?.sessionId, gen: st?.gen });
    expect(sync[0]?.rev).toBeGreaterThan(revBefore);
    expect(env.tabs.sent.find((r) => r.message.type === 'SYNC')?.to).toBe(10);
    const rendered = renders(env.tabs.sent.map((r) => r.message));
    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.step.id).toBe('s1');
    expect(rendered[0]?.rev).toBeGreaterThan(sync[0]?.rev ?? 0);
    expect(st?.rev).toBe(rendered[0]?.rev);
  });

  it('T-SES-46: 復帰時、状態がなければ（storage.session が空）、実行中として扱わない', async () => {
    const env = createEnv();
    await env.session.recover();
    expect(env.tabs.sent).toEqual([]);
    expect((await env.session.view()).status).toBe('idle');
    expect(env.state()).toBeNull();
  });

  it('T-SES-47: 復帰後の rev は、復帰前に送った rev より大きい（単調に増える）', async () => {
    const env = await running();
    await env.session.handlePanel(gotoMsg(env, 1));
    const revs = (): number[] =>
      env.tabs.sent.map((r) => r.message).flatMap((m) => ('rev' in m ? [m.rev] : []));
    let max = Math.max(...revs());
    for (let i = 0; i < 3; i++) {
      const sentBefore = env.tabs.sent.length;
      await env.restart().recover();
      const added = env.tabs.sent
        .slice(sentBefore)
        .map((r) => r.message)
        .flatMap((m) => ('rev' in m ? [m.rev] : []));
      expect(added.length).toBeGreaterThan(0);
      expect(Math.min(...added)).toBeGreaterThan(max);
      max = Math.max(...added);
    }
  });

  it('T-SES-48: 利用者に見せたステップから、どの段階で打ち切っても復帰によって巻き戻らない', async () => {
    const labels = ['session.set', 'local.set', 'tabs.send', 'panel'];
    for (const label of labels) {
      for (const when of ['before', 'after'] as const) {
        const { env, before } = await crashAt(label, when, goto);
        const seen = renders(before).some((r) => r.step.id === 's2');
        const index = env.state()?.stepIndex;
        expect([0, 1]).toContain(index);
        if (seen) expect(index).toBe(1);
        // 復帰後に描画されるのは、状態のステップだけ
        expect(renders(env.tabs.sent.map((r) => r.message)).map((r) => r.step.id)).toEqual([
          index === 1 ? 's2' : 's1',
        ]);
      }
    }
  });

  it('T-SES-49: 一時中断の状態で復帰したとき、描画指示は送られず、表示は出ない', async () => {
    const env = await running();
    await env.session.handlePanel({ type: 'PAUSE', sessionId: cur(env).sessionId, opId: freshOp() });
    env.tabs.clear();
    await env.restart().recover();
    const types = env.tabs.types();
    expect(types).not.toContain('RENDER');
    expect(types).not.toContain('SYNC');
    expect(env.state()?.status).toBe('paused');
  });
});

describe('削除待ち', () => {
  const failProgress = (env: Env, fail: boolean): void => {
    env.localArea.failSet = fail ? (keys) => keys === 'progress' : false;
  };
  const stop = (env: Env): Promise<unknown> =>
    env.session.handlePanel({ type: 'STOP', sessionId: cur(env).sessionId, opId: freshOp() });

  it('T-SES-50: 完了・終了で進捗の削除に失敗したとき、pendingDeletes に { tourId, sessionId } が加えられ、完了・終了は成立する', async () => {
    const env = await running();
    const { sessionId } = cur(env);
    failProgress(env, true);
    const res = await stop(env);
    expect(res).toEqual({ status: 'done' });
    expect(env.state()?.status).toBe('ended');
    expect(env.localArea.data.get('pendingDeletes')).toEqual([{ tourId: 't1', sessionId }]);
    const complete = await running();
    failProgress(complete, true);
    await complete.session.handlePanel(gotoMsg(complete, 4));
    expect(complete.state()?.status).toBe('ended');
    expect(complete.localArea.data.get('pendingDeletes')).toHaveLength(1);
  });

  it('T-SES-51: 起動時の復帰で、pendingDeletes の削除がやり直され、成功したものは一覧から外れる', async () => {
    const env = await running();
    failProgress(env, true);
    await stop(env);
    failProgress(env, false);
    await env.restart().recover();
    expect(env.progress().t1).toBeUndefined();
    expect(env.localArea.data.get('pendingDeletes')).toEqual([]);
  });

  it('T-SES-52: pendingDeletes のやり直しが再び失敗したとき、一覧に残り、次回に再び試される', async () => {
    const env = await running();
    const { sessionId } = cur(env);
    failProgress(env, true);
    await stop(env);
    await env.restart().recover();
    expect(env.localArea.data.get('pendingDeletes')).toEqual([{ tourId: 't1', sessionId }]);
    expect(env.progress().t1).toBeDefined();
    failProgress(env, false);
    await env.restart().recover();
    expect(env.localArea.data.get('pendingDeletes')).toEqual([]);
    expect(env.progress().t1).toBeUndefined();
  });

  it('T-SES-53: pendingDeletes の削除が成功した後、その ID の「続きから」が出ない', async () => {
    const env = await running();
    failProgress(env, true);
    await stop(env);
    // 削除待ちの間も、完了・終了した実行回の進捗は一覧に出さない
    expect((await env.session.view()).catalog[0]?.progress).toBeNull();
    failProgress(env, false);
    await env.restart().recover();
    expect((await env.session.view()).catalog[0]?.progress).toBeNull();
  });

  it('T-SES-54: pendingDeletes の sessionId と違う sessionId の進捗（新しい実行回）は、削除されない', async () => {
    const env = await running();
    failProgress(env, true);
    await stop(env);
    failProgress(env, false);
    await env.session.handlePanel({ type: 'START', tourId: 't1', resume: false, opId: freshOp() });
    const newer = cur(env).sessionId;
    await env.restart().recover();
    expect(env.progress().t1).toMatchObject({ sessionId: newer });
    expect(env.localArea.data.get('pendingDeletes')).toEqual([]);
  });
});

describe('保存の失敗', () => {
  it('T-SES-55: storage.session への書き込みが失敗したとき、メモリ上の状態で操作が続き、saveError が立つ', async () => {
    const env = await running();
    env.sessionArea.failSet = true;
    const res = await env.session.handlePanel(gotoMsg(env, 1));
    expect(res).toEqual({ status: 'done' });
    const view = await env.session.view();
    expect(view).toMatchObject({ stepIndex: 1, saveError: true });
    expect(renders(env.tabs.sent.map((r) => r.message)).map((r) => r.step.id)).toEqual(['s2']);
    // 書けていなくても、メモリ上の状態（gen 2）で次の操作を受け付ける
    if (view.sessionId === null || view.gen === null) throw new Error('状態がない');
    const next = await env.session.handlePanel({
      type: 'GOTO',
      to: 0,
      sessionId: view.sessionId,
      gen: view.gen,
      opId: freshOp(),
    });
    expect(next).toEqual({ status: 'done' });
  });

  it('T-SES-56: storage.local への進捗の書き込みが失敗したとき、操作が続き、saveError が立つ', async () => {
    const env = await running();
    env.localArea.failSet = true;
    const res = await env.session.handlePanel(gotoMsg(env, 1));
    expect(res).toEqual({ status: 'done' });
    expect(await env.session.view()).toMatchObject({ stepIndex: 1, saveError: true });
    expect(env.state()?.stepIndex).toBe(1);
  });

  it('T-SES-57: saveError が立っているとき、次の確定で再び保存が試みられる', async () => {
    const env = await running();
    env.sessionArea.failSet = true;
    env.localArea.failSet = true;
    await env.session.handlePanel(gotoMsg(env, 1));
    expect(env.state()?.stepIndex).toBe(0);
    env.sessionArea.failSet = false;
    env.localArea.failSet = false;
    await env.session.handlePanel({ type: 'SET_OVERLAY', hidden: true, sessionId: cur(env).sessionId, opId: freshOp() });
    expect(env.state()).toMatchObject({ stepIndex: 1, overlayHidden: true });
    // 進捗の書き込みも、進捗を書かない操作の確定でやり直される
    expect(env.progress().t1).toMatchObject({ stepId: 's2', gen: 2 });
  });

  it('T-SES-58: saveError が立った後、次の保存がすべて成功したとき、saveError が下りる', async () => {
    const env = await running();
    env.localArea.failSet = true;
    await env.session.handlePanel(gotoMsg(env, 1));
    expect((await env.session.view()).saveError).toBe(true);
    env.localArea.failSet = false;
    await env.session.handlePanel(gotoMsg(env, 0));
    expect((await env.session.view()).saveError).toBe(false);
    expect(env.panels.at(-1)?.saveError).toBe(false);
  });

  it('T-SES-59: saveError が立った後、保存が再び失敗したとき、saveError が立ったままになる', async () => {
    const env = await running();
    env.localArea.failSet = true;
    await env.session.handlePanel(gotoMsg(env, 1));
    await env.session.handlePanel(gotoMsg(env, 0));
    expect((await env.session.view()).saveError).toBe(true);
    env.localArea.failSet = false;
    env.sessionArea.failSet = true;
    await env.session.handlePanel(gotoMsg(env, 1));
    expect((await env.session.view()).saveError).toBe(true);
  });
});
