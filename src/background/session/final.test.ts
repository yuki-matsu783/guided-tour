/**
 * 状態管理：Service Worker の再起動・版の照合・削除（最終レビューの指摘 B-1・B-3・B-4・B-5）。
 * 再起動は、同じ storage の上で新しい実体を作り、`recover()` を呼ぶ前か後の状態で試す。
 */
import { describe, expect, it } from 'vitest';
import { watchRemoved } from '../../shared/permissions/index.ts';
import { sid, createEnv, freshOp, makeTour, startBound, flush, type Env } from './testkit.ts';

async function running(): Promise<Env> {
  const env = createEnv();
  await startBound(env);
  return env;
}

describe('眠っている間の許可の取り消し（B-1）', () => {
  it('R-FINAL-01: 起こされた直後（状態の読み込み前）でも、runningTour は状態を読み込んで実行中のツアーを返す', async () => {
    const env = await running();
    const next = env.restart();
    expect(await next.runningTour()).toMatchObject({ origins: ['https://example.com'] });
  });

  it('R-FINAL-01: 起こされた直後に許可が取り消されると、一時中断（permission）になる', async () => {
    const env = await running();
    const next = env.restart();
    env.perms.has = false;
    let fire: () => void = () => undefined;
    watchRemoved(
      {
        contains: () => Promise.resolve(env.perms.has),
        onRemoved: {
          addListener: (l) => {
            fire = () => {
              l({});
            };
          },
          removeListener: () => undefined,
        },
      },
      () => next.runningTour(),
      () => void next.onPermissionLost(),
    );
    fire();
    await flush();
    expect(env.state()).toMatchObject({ status: 'paused', pauseReason: 'permission' });
  });

  it('R-FINAL-01: 実行中でなければ runningTour は null', async () => {
    const env = createEnv();
    expect(await env.session.runningTour()).toBeNull();
  });
});

describe('起動時の復帰での版の照合（B-3）', () => {
  it('R-FINAL-03: 実行中のツアーの固定した版が現在の版と違うとき、復帰で上書きによる一時中断になる', async () => {
    const env = await running();
    env.catalog.set(makeTour(), 'h2');
    await env.restart().recover();
    expect(env.state()).toMatchObject({ status: 'paused', pauseReason: 'overwritten' });
  });

  it('R-FINAL-03: 利用者が一時中断中でも、版が違えば理由が overwritten になる', async () => {
    const env = await running();
    await env.session.handlePanel({
      type: 'PAUSE',
      sessionId: env.state()?.sessionId ?? sid('x'),
      opId: freshOp(),
    });
    expect(env.state()?.pauseReason).toBe('user');
    env.catalog.set(makeTour(), 'h2');
    await env.restart().recover();
    expect(env.state()).toMatchObject({ status: 'paused', pauseReason: 'overwritten' });
  });

  it('R-FINAL-03: 版が同じでも固定した版の内容が取れないときは、上書きによる一時中断になる', async () => {
    const env = await running();
    env.catalog.versions.clear();
    await env.restart().recover();
    expect(env.state()).toMatchObject({ status: 'paused', pauseReason: 'overwritten' });
  });

  it('R-FINAL-03: 現在の版も無ければ、削除として終了する', async () => {
    const env = await running();
    env.catalog.remove('t1');
    await env.restart().recover();
    expect(env.state()).toMatchObject({ status: 'ended', notice: 'tourRemoved' });
    expect(env.progress().t1).toBeUndefined();
  });

  it('R-FINAL-03: 版が同じなら、これまでどおり実行中のまま復帰する', async () => {
    const env = await running();
    await env.restart().recover();
    expect(env.state()?.status).toBe('running');
  });
});

describe('取り込みの通知の判定（B-4）', () => {
  it('R-FINAL-04: 通知の hash が古い版でも、現在の版が固定した版と違えば上書きとして扱う', async () => {
    const env = await running();
    env.catalog.set(makeTour(), 'h2');
    await env.session.onCatalogChanged('t1', 'h1');
    expect(env.state()).toMatchObject({ status: 'paused', pauseReason: 'overwritten' });
  });

  it('R-FINAL-04: 通知の hash が違っても、現在の版が固定した版と同じなら何も起きない', async () => {
    const env = await running();
    await env.session.onCatalogChanged('t1', 'h-other');
    expect(env.state()?.status).toBe('running');
  });
});

describe('削除時の進捗（B-5）', () => {
  const progress = {
    sessionId: sid('old-session'),
    gen: 3,
    stepId: 's2',
    stepIndex: 1,
    savedAt: 1,
  };

  it('R-FINAL-05: 実行していないツアーを削除すると、その進捗も消える', async () => {
    const env = createEnv();
    env.localArea.data.set('progress', { t1: progress, t2: { ...progress, sessionId: sid('s2') } });
    await env.session.onCatalogRemoved('t1');
    expect(env.progress().t1).toBeUndefined();
    expect(env.progress().t2).toBeDefined();
  });

  it('R-FINAL-05: 別のツアーの実行中に削除しても、実行は続き、削除したツアーの進捗だけが消える', async () => {
    const env = await running();
    env.localArea.data.set('progress', { ...env.progress(), other: progress });
    await env.session.onCatalogRemoved('other');
    expect(env.progress().other).toBeUndefined();
    expect(env.progress().t1).toBeDefined();
    expect(env.state()?.status).toBe('running');
  });

  it('R-FINAL-05: 進捗を消せなかったときは、削除待ちに入れる', async () => {
    const env = createEnv();
    env.localArea.data.set('progress', { t1: progress });
    env.localArea.failSet = (keys) => keys.includes('progress');
    await env.session.onCatalogRemoved('t1');
    expect(env.localArea.data.get('pendingDeletes')).toEqual([{ tourId: 't1', sessionId: 'old-session' }]);
  });

  it('R-FINAL-05: 進捗が無ければ何も書かない', async () => {
    const env = createEnv();
    await env.session.onCatalogRemoved('t1');
    expect(env.localArea.ops).toEqual([]);
  });
});

describe('固定した版が取れない一時中断の表示（B-2）', () => {
  it('R-FINAL-02: 再起動後に上書きされ旧版が取れなくても、view.tour に新版の名前と origins が入る', async () => {
    const env = await running();
    const changed = { ...makeTour(), name: '新しい名前', origins: ['https://example.com', 'https://new.example'] };
    env.catalog.set(changed, 'h2');
    const next = env.restart();
    await next.recover();
    const view = await next.view();
    expect(view).toMatchObject({ status: 'paused', pauseReason: 'overwritten' });
    expect(view.tour).toMatchObject({
      id: 't1',
      name: '新しい名前',
      origins: ['https://example.com', 'https://new.example'],
    });
  });

  it('R-FINAL-02: 固定した版が取れるときは、これまでどおり固定した版の内容を出す', async () => {
    const env = await running();
    env.catalog.keepOldVersions = true;
    env.catalog.set({ ...makeTour(), name: '新しい名前' }, 'h2');
    await env.session.onCatalogChanged('t1');
    const view = await env.session.view();
    expect(view.tour).toMatchObject({ name: 'テスト用ツアー', hash: 'h1' });
  });

  it('R-FINAL-02: 現在の版も無いときは null のまま', async () => {
    const env = await running();
    env.catalog.versions.clear();
    env.catalog.remove('t1');
    await env.restart().recover();
    expect((await env.session.view()).tour).toBeNull();
  });
});
