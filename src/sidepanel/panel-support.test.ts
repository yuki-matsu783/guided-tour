// @vitest-environment jsdom
/**
 * 画面の下支え（画像の URL 管理・間引き・応答の文言・操作の送り方）のテスト（R-PANEL-60〜66）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GenSchema, SessionIdSchema } from '../shared/ids/index.ts';
import type { OpResponse } from '../shared/messages/index.ts';
import { REJECT_REASONS } from '../shared/messages/index.ts';
import { createAssets } from './assets/index.ts';
import type { AssetDeps } from './assets/index.ts';
import { createOps } from './ops.ts';
import { describeResponse } from './response-text.ts';
import { createCoalescer } from './throttle.ts';
import { makeDeps, makeView } from './test-support.tsx';

afterEach(() => {
  vi.useRealTimers();
});

function assetDeps(source: 'bundled' | 'imported' | null): {
  deps: AssetDeps;
  created: Blob[];
  revoked: string[];
} {
  const created: Blob[] = [];
  const revoked: string[] = [];
  const deps: AssetDeps = {
    getUrl: (path) => `chrome-extension://id/${path}`,
    readStoredFile: (_t, _h, path) => Promise.resolve(path === 'none.png' ? null : new Blob([path])),
    createObjectUrl: (blob) => {
      created.push(blob);
      return `blob:${String(created.length)}`;
    },
    revokeObjectUrl: (url) => {
      revoked.push(url);
    },
    sourceOf: () => source,
  };
  return { deps, created, revoked };
}

describe('画像の URL 管理', () => {
  it('R-PANEL-60: 同梱は getURL、data URL はそのまま、取り込みは Blob から blob URL にする', async () => {
    const png = 'data:image/png;base64,AAAA';
    const bundled = createAssets(assetDeps('bundled').deps);
    expect(await bundled.resolve('t', 'h', 'img/a.png')).toBe('chrome-extension://id/tours/t/img/a.png');
    expect(await bundled.resolve('t', 'h', png)).toBe(png);

    const { deps, created } = assetDeps('imported');
    const imported = createAssets(deps);
    expect(await imported.resolve('t', 'h', 'img/a.png')).toBe('blob:1');
    expect(created).toHaveLength(1);
    expect(await imported.resolve('t', 'h', 'none.png')).toBeNull();
  });

  it('R-PANEL-61: (hash, path) ごとに blob URL を使い回し、処理中の重複も1回にまとめる', async () => {
    const { deps, created } = assetDeps('imported');
    const assets = createAssets(deps);
    const [a, b] = await Promise.all([assets.resolve('t', 'h', 'a.png'), assets.resolve('t', 'h', 'a.png')]);
    expect(a).toBe(b);
    expect(await assets.resolve('t', 'h', 'a.png')).toBe(a);
    expect(created).toHaveLength(1);
    expect(await assets.resolve('t', 'h', 'b.png')).not.toBe(a);
    expect(created).toHaveLength(2);
  });

  it('R-PANEL-62: ツアーや hash が変わったとき、前の blob URL を解放し、閉じるときはすべて解放する', async () => {
    const { deps, revoked } = assetDeps('imported');
    const assets = createAssets(deps);
    const a = await assets.resolve('t', 'h1', 'a.png');
    const b = await assets.resolve('t', 'h2', 'a.png');
    const c = await assets.resolve('u', 'h1', 'a.png');
    assets.keep({ tourId: 't', hash: 'h2' });
    await Promise.resolve();
    expect(revoked.sort()).toEqual([a, c].sort());
    assets.revokeAll();
    await Promise.resolve();
    expect(revoked).toContain(b);
    expect(revoked).toHaveLength(3);
    // 解放後に解決し直すと、新しい URL を作る
    expect(await assets.resolve('t', 'h2', 'a.png')).not.toBe(b);
  });

  it('R-PANEL-63: 出所が分からない間は、取り込みとして扱わず解決しない（覚えない）', async () => {
    const source: { value: 'imported' | null } = { value: null };
    const { deps } = assetDeps('imported');
    const assets = createAssets({ ...deps, sourceOf: () => source.value });
    expect(await assets.resolve('t', 'h', 'a.png')).toBeNull();
    source.value = 'imported';
    expect(await assets.resolve('t', 'h', 'a.png')).toBe('blob:1');
  });
});

describe('間引き', () => {
  it('R-PANEL-64: 最初の値から 120 ミリ秒後に、最新の値を1回だけ渡す', () => {
    vi.useFakeTimers();
    const applied: number[] = [];
    const c = createCoalescer<number>(120, (v) => applied.push(v));
    c.push(1);
    vi.advanceTimersByTime(60);
    c.push(2);
    vi.advanceTimersByTime(59);
    expect(applied).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(applied).toEqual([2]);
    c.push(3);
    c.cancel();
    vi.advanceTimersByTime(500);
    expect(applied).toEqual([2]);
  });
});

describe('応答の文言', () => {
  it('R-PANEL-65: 拒否の理由ごとに文言を出し、バージョン不足と許可不足は値を含める', () => {
    for (const reason of REJECT_REASONS) {
      const text = describeResponse({ status: 'rejected', reason });
      expect(text?.length).toBeGreaterThan(0);
    }
    expect(describeResponse({ status: 'rejected', reason: 'versionTooLow', current: '1.0.0', required: '1.2.0' })).toMatch(
      /1\.0\.0.*1\.2\.0/,
    );
    expect(
      describeResponse({ status: 'rejected', reason: 'permissionMissing', origins: ['https://a.example', 'https://b.example'] }),
    ).toMatch(/a\.example.*b\.example/);
    expect(describeResponse({ status: 'done' })).toBeNull();
    expect(describeResponse({ status: 'confirmBind', boundRole: 'x' })).toBeNull();
    expect(describeResponse({ status: 'discarded', reason: 'staleGen' })).toContain('古い表示');
    expect(describeResponse({ status: 'unhandled' })?.length).toBeGreaterThan(0);
  });
});

describe('操作の送り方', () => {
  const session = SessionIdSchema.parse('s-1');
  const gen = GenSchema.parse(2);

  function setup(view: ReturnType<typeof makeView>, response: unknown = { status: 'done' satisfies OpResponse['status'] }) {
    const deps = makeDeps(view);
    deps.respond = () => response;
    const notices: (string | null)[] = [];
    const ops = createOps({
      deps,
      getView: () => view,
      notify: (t) => notices.push(t),
      refresh: () => undefined,
      askBind: () => undefined,
      finished: () => undefined,
    });
    return { deps, ops, notices };
  }

  it('R-PANEL-66: 実行中でない（sessionId が無い）とき、状態管理への操作は何も送らない', async () => {
    const { deps, ops } = setup(makeView());
    ops.pause();
    ops.resume();
    ops.stop();
    ops.restart();
    ops.goto(1);
    ops.recheck();
    ops.setOverlay(true);
    ops.bindTab(1, false);
    await Promise.resolve();
    expect(deps.sent).toEqual([]);
  });

  it('R-PANEL-67: 操作ごとに新しい opId を付け、sessionId と gen は表示中の値を付ける', async () => {
    const view = makeView({ status: 'running', sessionId: session, gen });
    const { deps, ops } = setup(view);
    ops.recheck();
    ops.recheck();
    await Promise.resolve();
    const [a, b] = deps.sent;
    expect(a).toMatchObject({ type: 'RECHECK', sessionId: 's-1', gen: 2 });
    expect(a && 'opId' in a ? a.opId : 'a').not.toBe(b && 'opId' in b ? b.opId : 'a');
  });

  it('R-PANEL-68: 通信の失敗や形の違う応答は、文言にして出し、例外を外へ出さない', async () => {
    const view = makeView({ status: 'running', sessionId: session, gen });
    const failing = setup(view);
    failing.deps.send = () => Promise.reject(new Error('page text must not leak'));
    failing.ops.recheck();
    await vi.waitFor(() => {
      expect(failing.notices.at(-1)).toContain('通信できませんでした');
    });
    // ログに例外のメッセージを入れない
    expect(JSON.stringify(vi.mocked(failing.deps.logger.error).mock.calls)).not.toContain('page text');

    const garbled = setup(view, { status: 'nonsense' });
    garbled.ops.recheck();
    await vi.waitFor(() => {
      expect(garbled.notices.at(-1)).toContain('応答を読めません');
    });
  });
});
