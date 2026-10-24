// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OWN_HOST_ATTRIBUTE, type LocateResult, type LocatorTarget } from '../../core/locator/index.ts';
import type { BgToPage, PageStep, PageToBg, Render, UiSettings } from '../../shared/messages/index.ts';
import { PageStepSchema } from '../../shared/messages/index.ts';
import type { Rect } from '../geometry.ts';
import type { MiniGuideModel } from '../miniguide/index.ts';
import { found, gen, makeEnv, makeRender, NOT_FOUND, pageSeq, rev, sid, UI } from '../test-support.ts';
import { createRuntime, SEARCH_WINDOW_MS } from './index.ts';
import { createDomObserver } from './observer.ts';

const harnesses: { rt: { dispose(): void } }[] = [];

type Outcome = LocateResult | Promise<LocateResult>;

const IN_VIEW: Rect = { left: 10, top: 10, right: 110, bottom: 50 };
const OFF_SCREEN: Rect = { left: 10, top: 1500, right: 110, bottom: 1540 };
const DONE_TARGET: LocatorTarget = { css: ['#done'] };
const STEP_WITH_DONE: PageStep = {
  id: 's1',
  title: '見出し',
  target: { css: ['#target'] },
  done: { type: 'element', target: DONE_TARGET, hint: '押してください' },
};

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error('準備に失敗');
  return el;
}

interface Deferred {
  resolve(r: LocateResult): void;
}

function make() {
  document.body.innerHTML = '<div id="target"></div><div id="other"></div><div id="done"></div>';
  const target = byId('target');
  const other = byId('other');
  const sent: PageToBg[] = [];
  const overlay = { paint: vi.fn(), showRestore: vi.fn(), clear: vi.fn() };
  const rectListeners = new Set<() => void>();
  const miniGuide = {
    renderMiniGuide: vi.fn<(model: MiniGuideModel | null, ui: UiSettings) => void>(),
    getRect: vi.fn<() => Rect | null>(() => null),
    onRectChange: vi.fn((listener: () => void) => {
      rectListeners.add(listener);
      return () => {
        rectListeners.delete(listener);
      };
    }),
    remove: vi.fn(),
  };
  const frames = new Map<number, () => void>();
  let frameSeq = 0;
  const rects = new Map<Element, Rect>();
  const scroll = vi.fn();
  const observers = { created: 0, disconnected: 0 };
  const calls: { at: number; done: boolean }[] = [];
  const deferred: Deferred[] = [];

  const ctx: { main: () => Outcome; done: () => Outcome; deferNext: boolean } = {
    main: () => NOT_FOUND,
    done: () => NOT_FOUND,
    deferNext: false,
  };

  const baseObserver = createDomObserver();
  const rt = createRuntime({
    doc: document,
    env: makeEnv(),
    now: () => Date.now(),
    requestFrame: (fn) => {
      frameSeq += 1;
      frames.set(frameSeq, fn);
      return frameSeq;
    },
    cancelFrame: (id) => {
      frames.delete(id);
    },
    createObserver: (cb) => {
      observers.created += 1;
      const o = baseObserver(cb);
      return {
        observe: (root) => {
          o.observe(root);
        },
        disconnect: () => {
          observers.disconnected += 1;
          o.disconnect();
        },
      };
    },
    send: (m) => sent.push(m),
    overlay,
    miniGuide,
    measure: (el) => rects.get(el) ?? IN_VIEW,
    scrollIntoView: scroll,
    locate: (t) => {
      const css = Array.isArray(t.css) ? t.css : t.css?.values;
      const isDone = css?.[0] === '#done';
      calls.push({ at: Date.now(), done: isDone });
      if (ctx.deferNext && !isDone) {
        ctx.deferNext = false;
        return new Promise<LocateResult>((resolve) => {
          deferred.push({ resolve });
        });
      }
      return isDone ? ctx.done() : ctx.main();
    },
  });

  let nextRev = 1;
  const api = {
    rt,
    sent,
    overlay,
    miniGuide,
    /** ミニガイドの領域が変わったことを実行器へ知らせる。 */
    fireRectChange(): void {
      for (const l of Array.from(rectListeners)) l();
    },
    scroll,
    rects,
    target,
    other,
    observers,
    ctx,
    deferred,
    frames,
    mainCalls: () => calls.filter((c) => !c.done),
    doneCalls: () => calls.filter((c) => c.done),
    /** rev を自動で進めて RENDER を送る。 */
    render(over: Partial<Render> = {}): Render {
      const m = makeRender({ rev: rev(nextRev), ...over });
      nextRev = Math.max(nextRev, m.rev) + 1;
      rt.handle(m);
      return m;
    },
    send(m: BgToPage): void {
      rt.handle(m);
    },
    nextRev: () => rev(nextRev++),
    flushFrame(): void {
      const list = Array.from(frames.entries());
      frames.clear();
      for (const [, fn] of list) fn();
    },
    mutate(): void {
      document.body.appendChild(document.createElement('span'));
    },
    locateResults: () => sent.filter((m) => m.type === 'LOCATE_RESULT'),
    hintStates: () => sent.filter((m) => m.type === 'HINT_STATE'),
    lastModel: (): MiniGuideModel | undefined => {
      const c = miniGuide.renderMiniGuide.mock.calls.at(-1);
      return c?.[0] ?? undefined;
    },
  };
  harnesses.push(api);
  return api;
}

type H = ReturnType<typeof make>;

async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  for (const h of harnesses.splice(0)) h.rt.dispose();
  vi.useRealTimers();
  document.body.innerHTML = '';
  document.documentElement.querySelectorAll(`[${OWN_HOST_ATTRIBUTE}]`).forEach((e) => { e.remove(); });
});

/** 見つかった状態（ハイライト中）にする。 */
function follow(h: H, over: Partial<Render> = {}): Render {
  h.ctx.main = () => found(h.target);
  return h.render(over);
}

describe('RENDER の受け付け', () => {
  it('T-RUN-01: 受け取った最大の rev より小さい rev の RENDER は捨てられ、表示も探索も変わらない', () => {
    const h = make();
    h.render({ rev: rev(5), step: { ...STEP_WITH_DONE, title: '新' } });
    const calls = h.mainCalls().length;
    const renders = h.miniGuide.renderMiniGuide.mock.calls.length;
    h.render({ rev: rev(3), step: { ...STEP_WITH_DONE, title: '古い' }, gen: gen(2) });
    expect(h.mainCalls()).toHaveLength(calls);
    expect(h.miniGuide.renderMiniGuide.mock.calls).toHaveLength(renders);
    expect(h.lastModel()?.title).toBe('新');
  });

  it('T-RUN-02: 最大の rev と同じ rev の RENDER は捨てられずに処理される', () => {
    const h = make();
    h.render({ rev: rev(5) });
    h.render({ rev: rev(5), ui: { ...UI, width: 400 } });
    expect(h.miniGuide.renderMiniGuide.mock.calls.at(-1)?.[1]).toMatchObject({ width: 400 });
  });

  it('T-RUN-03: 新しい rev の RENDER の後に、より古い rev の CLEAR が届いても捨てられ、表示が残る', () => {
    const h = make();
    follow(h, { rev: rev(5) });
    const clears = h.overlay.clear.mock.calls.length;
    h.send({ type: 'CLEAR', rev: rev(4) });
    expect(h.miniGuide.remove).not.toHaveBeenCalled();
    expect(h.overlay.clear.mock.calls).toHaveLength(clears);
    expect(h.rt.getSessionId()).toBe(sid());
  });

  it('T-RUN-04: CLEAR の後に、より古い rev の RENDER が届いても捨てられ、何も表示されない', () => {
    const h = make();
    h.render({ rev: rev(5) });
    h.send({ type: 'CLEAR', rev: rev(6) });
    const renders = h.miniGuide.renderMiniGuide.mock.calls.length;
    const calls = h.mainCalls().length;
    h.render({ rev: rev(5) });
    expect(h.miniGuide.renderMiniGuide.mock.calls).toHaveLength(renders);
    expect(h.mainCalls()).toHaveLength(calls);
    expect(h.rt.getSessionId()).toBeNull();
    expect(h.overlay.paint).not.toHaveBeenCalled();
  });

  it('T-RUN-05: 古い rev の RECHECK・SCROLL_TO_TARGET は捨てられ、探索もスクロールも起きない', () => {
    const h = make();
    follow(h, { rev: rev(5) });
    const calls = h.mainCalls().length;
    h.send({ type: 'RECHECK', rev: rev(4) });
    h.send({ type: 'SCROLL_TO_TARGET', rev: rev(3) });
    expect(h.mainCalls()).toHaveLength(calls);
    expect(h.scroll).not.toHaveBeenCalled();
  });

  it('T-RUN-06: 同じ (sessionId, gen, pageSeq) の RENDER は、表示の状態だけが更新され、探索はやり直されない', () => {
    const h = make();
    follow(h);
    const calls = h.mainCalls().length;
    h.render({ overlay: { hidden: true }, ui: { ...UI, mode: 'minimized' }, attended: false });
    expect(h.mainCalls()).toHaveLength(calls);
    expect(h.miniGuide.renderMiniGuide.mock.calls.at(-1)?.[1]).toMatchObject({ mode: 'minimized' });
    expect(h.lastModel()?.overlayHidden).toBe(true);
  });

  it('T-RUN-07: 同じ世代で overlay が hidden: true に変わると、ハイライトと吹き出しは消え、ミニガイドは残る', () => {
    const h = make();
    follow(h);
    h.render({ overlay: { hidden: true } });
    expect(h.overlay.paint.mock.calls.at(-1)?.[2]).toMatchObject({ hidden: true });
    expect(h.miniGuide.remove).not.toHaveBeenCalled();
    expect(h.lastModel()?.overlayHidden).toBe(true);
  });

  it('T-RUN-08: 同じ世代で ui の mode や width が変わると、ミニガイドの表示だけが変わり、探索は止まらない', async () => {
    const h = make();
    follow(h);
    h.render({ ui: { ...UI, mode: 'hover', width: 500 } });
    expect(h.miniGuide.renderMiniGuide.mock.calls.at(-1)?.[1]).toMatchObject({ mode: 'hover', width: 500 });
    const before = h.mainCalls().length;
    await tick(1000);
    expect(h.mainCalls().length).toBeGreaterThan(before);
  });

  it('T-RUN-09・T-RUN-53: gen が違う RENDER で、前のタイマーと Observer が止まり、新しいステップで始め直される（二重に動かない）', async () => {
    const h = make();
    follow(h);
    const timersBefore = vi.getTimerCount();
    h.render({ gen: gen(2) });
    expect(h.observers.created).toBe(2);
    expect(h.observers.disconnected).toBe(1);
    expect(vi.getTimerCount()).toBe(timersBefore);
    const before = h.mainCalls().length;
    await tick(1000);
    expect(h.mainCalls().length - before).toBe(1);
  });

  it('T-RUN-10: pageSeq だけが違う RENDER で始め直され、前のページの探索結果は採用されない', () => {
    const h = make();
    h.ctx.deferNext = true;
    h.render({ pageSeq: pageSeq(1) });
    h.render({ pageSeq: pageSeq(2) });
    expect(h.mainCalls()).toHaveLength(2);
    h.deferred[0]?.resolve(found(h.target));
    return Promise.resolve().then(() => {
      expect(h.overlay.paint).not.toHaveBeenCalled();
    });
  });

  it('T-RUN-11: sessionId だけが違う RENDER で始め直され、前の実行回の表示が残らない', () => {
    const h = make();
    follow(h);
    h.overlay.clear.mockClear();
    h.ctx.main = () => NOT_FOUND;
    h.render({ sessionId: sid(2) });
    expect(h.overlay.clear).toHaveBeenCalled();
    expect(h.rt.getSessionId()).toBe(sid(2));
    expect(h.mainCalls()).toHaveLength(2);
    expect(h.lastModel()?.sessionId).toBe(sid(2));
  });

  it('T-RUN-12: SYNC の sessionId・gen が現在の表示と違うとき、表示が消される', () => {
    const h = make();
    follow(h);
    h.send({ type: 'SYNC', sessionId: sid(), gen: gen(9), rev: h.nextRev() });
    expect(h.miniGuide.remove).toHaveBeenCalled();
    expect(h.rt.getSessionId()).toBeNull();
  });

  it('T-RUN-13: SYNC の sessionId・gen が現在の表示と同じとき、表示は消されない', () => {
    const h = make();
    follow(h);
    h.overlay.clear.mockClear();
    h.send({ type: 'SYNC', sessionId: sid(), gen: gen(), rev: h.nextRev() });
    expect(h.miniGuide.remove).not.toHaveBeenCalled();
    expect(h.overlay.clear).not.toHaveBeenCalled();
    expect(h.rt.getSessionId()).toBe(sid());
  });
});

describe('selected による停止と再開', () => {
  it('T-RUN-14: selected が偽の RENDER を受けたとき、探索・監視・追従のタイマーが動かない', async () => {
    const h = make();
    h.render({ selected: false, step: STEP_WITH_DONE });
    expect(h.mainCalls()).toHaveLength(0);
    expect(h.observers.created).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.frames.size).toBe(0);
    await tick(20_000);
    expect(h.mainCalls()).toHaveLength(0);
    expect(h.doneCalls()).toHaveLength(0);
    expect(h.lastModel()?.hintKind).toBe('stopped');
  });

  it('T-RUN-15: selected が偽でも visibilityState が visible のとき、停止したままになる', async () => {
    const h = make();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    h.render({ selected: false });
    await tick(10_000);
    expect(h.mainCalls()).toHaveLength(0);
    Reflect.deleteProperty(document, 'visibilityState');
  });

  it('T-RUN-16: selected が真でも visibilityState が hidden のとき、探索が動く', () => {
    const h = make();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    h.render({ selected: true });
    expect(h.mainCalls()).toHaveLength(1);
    Reflect.deleteProperty(document, 'visibilityState');
  });

  it('T-RUN-17: selected が偽から真に変わったとき、すぐに1回 locate が実行される', () => {
    const h = make();
    h.render({ selected: false });
    expect(h.mainCalls()).toHaveLength(0);
    h.render({ selected: true });
    expect(h.mainCalls()).toHaveLength(1);
  });

  it('T-RUN-18: selected が偽の間にページが変化しても、locate が実行されない', async () => {
    const h = make();
    h.render({ selected: false });
    h.mutate();
    await tick(5000);
    expect(h.mainCalls()).toHaveLength(0);
  });

  it('T-RUN-19・T-WATCH-21: selected が偽の間、完了の目安の監視（イベント・1秒ごとの確認）が動かない', async () => {
    const h = make();
    h.render({ selected: false, step: STEP_WITH_DONE });
    document.dispatchEvent(new Event('input', { bubbles: true }));
    h.mutate();
    await tick(5000);
    expect(h.doneCalls()).toHaveLength(0);
    expect(h.hintStates()).toHaveLength(0);
  });

  it('T-RUN-19: selected が真に戻ると、監視も再開する', async () => {
    const h = make();
    h.render({ selected: false, step: STEP_WITH_DONE });
    h.render({ selected: true, step: STEP_WITH_DONE });
    expect(h.doneCalls()).toHaveLength(1);
    await tick(1000);
    expect(h.doneCalls().length).toBeGreaterThan(1);
  });

  it('T-RUN-20: 探索中に selected が偽になったとき、探索中の結果が届いても採用されない', async () => {
    const h = make();
    h.ctx.deferNext = true;
    h.render({ selected: true });
    h.render({ selected: false });
    h.deferred[0]?.resolve(found(h.target));
    await tick(0);
    expect(h.overlay.paint).not.toHaveBeenCalled();
    expect(h.locateResults()).toHaveLength(0);
  });

  it('selected が偽になったとき、ハイライトを消す（ミニガイドは残る）', () => {
    const h = make();
    follow(h);
    h.overlay.clear.mockClear();
    h.render({ selected: false });
    expect(h.overlay.clear).toHaveBeenCalled();
    expect(h.miniGuide.remove).not.toHaveBeenCalled();
  });
});

describe('ライフサイクル', () => {
  it('T-RUN-21: 新しいステップの RENDER で、すぐに1回 locate が実行される', () => {
    const h = make();
    h.render();
    expect(h.mainCalls()).toHaveLength(1);
  });

  it('T-RUN-22: RECHECK で、すぐに1回 locate が実行され、初回の探索（8秒）がやり直される', async () => {
    const h = make();
    h.render();
    await tick(5000);
    const calls = h.mainCalls().length;
    h.send({ type: 'RECHECK', rev: h.nextRev() });
    expect(h.mainCalls()).toHaveLength(calls + 1);
    await tick(SEARCH_WINDOW_MS - 100);
    expect(h.lastModel()?.fallbackText).toBeNull();
    await tick(100);
    expect(h.lastModel()?.fallbackText).not.toBeNull();
  });

  it('T-RUN-23: 初回の探索中にページが連続して変化しても、locate は最短250ミリ秒の間隔でしか実行されない', async () => {
    const h = make();
    h.render();
    for (let i = 0; i < 40; i += 1) {
      h.mutate();
      await tick(50);
    }
    const times = h.mainCalls().map((c) => c.at);
    expect(times.length).toBeGreaterThan(3);
    for (let i = 1; i < times.length; i += 1) {
      expect((times[i] ?? 0) - (times[i - 1] ?? 0)).toBeGreaterThanOrEqual(250);
    }
  });

  it('T-RUN-24: 初回の探索中にページの変化がないとき、最初の1回の後に locate が繰り返されない', async () => {
    const h = make();
    h.render();
    await tick(7000);
    expect(h.mainCalls()).toHaveLength(1);
  });

  it('T-RUN-25: 8秒たっても見つからないとき、missing が1回報告され、文章だけの案内に切り替わる', async () => {
    const h = make();
    h.render({ fallbackText: '右上のボタンを押す' });
    await tick(SEARCH_WINDOW_MS - 1);
    expect(h.locateResults()).toHaveLength(0);
    expect(h.lastModel()?.fallbackText).toBeNull();
    await tick(1);
    expect(h.locateResults()).toHaveLength(1);
    expect(h.locateResults()[0]).toMatchObject({ result: { found: false, reasons: ['missing'] } });
    expect(h.lastModel()?.fallbackText).toBe('右上のボタンを押す');
    await tick(20_000);
    expect(h.locateResults()).toHaveLength(1);
  });

  it('T-RUN-25: 代替文が無いときは既定の案内になる', async () => {
    const h = make();
    h.render({ fallbackText: null });
    await tick(SEARCH_WINDOW_MS);
    expect(h.lastModel()?.fallbackText).toBe('対象が見つかりません。説明に沿って操作してください');
  });

  it('T-RUN-26: 7.9秒の時点で見つかったとき、missing は報告されず、ハイライトされる', async () => {
    const h = make();
    h.render();
    await tick(7600);
    h.ctx.main = () => found(h.target);
    h.mutate();
    await tick(300);
    expect(h.overlay.paint).toHaveBeenCalled();
    await tick(2000);
    expect(h.locateResults().every((m) => m.result.found)).toBe(true);
    expect(h.lastModel()?.fallbackText).toBeNull();
  });

  it('T-RUN-27: 8秒以降、変化があるとき、2秒ごとに locate が実行される', async () => {
    const h = make();
    h.render();
    await tick(SEARCH_WINDOW_MS + 100);
    const base = h.mainCalls().length;
    h.mutate();
    await tick(0);
    expect(h.mainCalls()).toHaveLength(base + 1);
    h.mutate();
    await tick(1900);
    expect(h.mainCalls()).toHaveLength(base + 1);
    await tick(100);
    expect(h.mainCalls()).toHaveLength(base + 2);
  });

  it('T-RUN-28: 8秒以降、変化がないとき、locate が実行されない', async () => {
    const h = make();
    h.render();
    await tick(SEARCH_WINDOW_MS + 100);
    const base = h.mainCalls().length;
    await tick(30_000);
    expect(h.mainCalls()).toHaveLength(base);
  });

  it('T-RUN-29: 8秒より後に要素が現れて特定できたとき、文章だけの案内からハイライトに変わり、スクロールしない', async () => {
    const h = make();
    h.rects.set(h.target, OFF_SCREEN);
    h.render();
    await tick(SEARCH_WINDOW_MS + 100);
    expect(h.lastModel()?.fallbackText).not.toBeNull();
    h.ctx.main = () => found(h.target);
    h.mutate();
    await tick(2000);
    expect(h.overlay.paint).toHaveBeenCalled();
    expect(h.lastModel()?.fallbackText).toBeNull();
    expect(h.scroll).not.toHaveBeenCalled();
  });

  it('T-RUN-30: 特定後、requestAnimationFrame で位置が測られ、位置・大きさの変化に枠と吹き出しが追従する', () => {
    const h = make();
    follow(h);
    expect(h.frames.size).toBe(1);
    const paints = h.overlay.paint.mock.calls.length;
    h.flushFrame();
    expect(h.overlay.paint.mock.calls).toHaveLength(paints);
    h.rects.set(h.target, { left: 200, top: 200, right: 300, bottom: 260 });
    h.flushFrame();
    expect(h.overlay.paint.mock.calls).toHaveLength(paints + 1);
    expect(h.frames.size).toBe(1);
  });

  it('T-RUN-31: 追従中、ページが変化したとき、最短250ミリ秒で locate がやり直される', async () => {
    const h = make();
    follow(h);
    await tick(300);
    const base = h.mainCalls().length;
    h.mutate();
    await tick(0);
    expect(h.mainCalls()).toHaveLength(base + 1);
    h.mutate();
    await tick(249);
    expect(h.mainCalls()).toHaveLength(base + 1);
    await tick(1);
    expect(h.mainCalls()).toHaveLength(base + 2);
  });

  it('T-RUN-32: 追従中、ページの変化がなくても1秒ごとに locate がやり直される', async () => {
    const h = make();
    follow(h);
    const base = h.mainCalls().length;
    await tick(999);
    expect(h.mainCalls()).toHaveLength(base);
    await tick(1);
    expect(h.mainCalls()).toHaveLength(base + 1);
    await tick(3000);
    expect(h.mainCalls()).toHaveLength(base + 4);
  });

  it('T-RUN-33: 再検証で候補が増えて一意でなくなったとき、枠と吹き出しがすぐ消え、探し直される', async () => {
    const h = make();
    follow(h);
    h.overlay.clear.mockClear();
    const paints = h.overlay.paint.mock.calls.length;
    h.ctx.main = () => found(h.target, { reasons: ['conflict'] });
    await tick(1000);
    expect(h.overlay.clear).toHaveBeenCalled();
    expect(h.overlay.paint.mock.calls).toHaveLength(paints);
    // 探し直しは変化があったときに行う
    h.ctx.main = () => found(h.target);
    h.mutate();
    await tick(300);
    expect(h.overlay.paint.mock.calls.length).toBeGreaterThan(paints);
  });

  it('T-RUN-34: 再検証で要素が入れ替わったとき、枠がすぐ消え、新しい要素が特定されて枠が移る', async () => {
    const h = make();
    follow(h);
    h.overlay.clear.mockClear();
    h.ctx.main = () => found(h.other);
    await tick(1000);
    expect(h.overlay.clear).toHaveBeenCalled();
    expect(h.overlay.paint.mock.calls.at(-1)?.[0]).toBe(h.other);
  });

  it.each([
    'T-RUN-35: 再検証で、役割・所属する領域が変わって必須の照合を満たさなくなったとき、枠がすぐ消える',
    'T-RUN-36: 再検証で、必須の照合に指定した名前が変わって満たさなくなったとき、枠がすぐ消える',
    'T-RUN-37: 再検証で、対象または読み替えた要素が表示されなくなったとき、枠がすぐ消える',
    'T-RUN-38: 再検証で、読み替えた要素が不適格になったとき、枠がすぐ消える',
  ])('%s', async () => {
    const h = make();
    follow(h);
    h.overlay.clear.mockClear();
    h.ctx.main = () => NOT_FOUND;
    await tick(1000);
    expect(h.overlay.clear).toHaveBeenCalled();
  });

  it('T-RUN-39: 介入の条件から外れ、バックグラウンドが CLEAR を送ったとき、枠がすぐ消える', () => {
    const h = make();
    follow(h);
    h.send({ type: 'CLEAR', rev: h.nextRev() });
    expect(h.overlay.clear).toHaveBeenCalled();
    expect(h.miniGuide.remove).toHaveBeenCalled();
  });

  it('T-RUN-40: 枠が消えた後、喪失後の探し直しが8秒間続き、見つからなければ missing に移る', async () => {
    const h = make();
    follow(h);
    h.ctx.main = () => NOT_FOUND;
    await tick(1000);
    expect(h.lastModel()?.fallbackText).toBeNull();
    // 探し直しは変化があるときに続く
    for (let i = 0; i < 7; i += 1) {
      h.mutate();
      await tick(1000);
    }
    expect(h.lastModel()?.fallbackText).toBeNull();
    expect(h.mainCalls().length).toBeGreaterThan(4);
    await tick(1100);
    expect(h.lastModel()?.fallbackText).not.toBeNull();
  });

  it('R-C5: 再検証で見失っても、8秒以内に見つかり直したときは missing（見つからない報告）を送らない', async () => {
    const h = make();
    follow(h);
    h.ctx.main = () => NOT_FOUND;
    await tick(1000);
    expect(h.overlay.clear).toHaveBeenCalled();
    expect(h.locateResults().filter((m) => !m.result.found)).toHaveLength(0);
    h.ctx.main = () => found(h.target);
    h.mutate();
    await tick(2000);
    expect(h.locateResults().filter((m) => !m.result.found)).toHaveLength(0);
    expect(h.overlay.paint.mock.calls.at(-1)?.[0]).toBe(h.target);
  });

  it('R-C5: missing 以外の理由で外れたときは、すぐ報告する', async () => {
    const h = make();
    follow(h);
    h.ctx.main = () => ({ ...NOT_FOUND, reasons: ['conflict'] });
    await tick(1000);
    expect(h.locateResults().at(-1)).toMatchObject({ result: { found: false, reasons: ['conflict'] } });
  });

  it('R-C5: 見失ったあと8秒見つからなければ、その時点で missing を1回報告する', async () => {
    const h = make();
    follow(h);
    h.ctx.main = () => NOT_FOUND;
    await tick(1000);
    for (let i = 0; i < 6; i += 1) {
      h.mutate();
      await tick(1000);
    }
    expect(h.locateResults().filter((m) => !m.result.found)).toHaveLength(0);
    await tick(2500);
    const missing = h.locateResults().filter((m) => !m.result.found);
    expect(missing).toHaveLength(1);
    expect(missing[0]?.result.reasons).toContain('missing');
  });

  it('T-RUN-41: 補助の照合（名前）だけが一致しなくなったとき、枠と吹き出しは残り、nameMismatch が報告される', async () => {
    const h = make();
    follow(h);
    h.overlay.clear.mockClear();
    h.ctx.main = () => found(h.target, { reasons: ['nameMismatch'] });
    await tick(1000);
    expect(h.overlay.clear).not.toHaveBeenCalled();
    expect(h.locateResults().at(-1)).toMatchObject({ result: { found: true, reasons: ['nameMismatch'] } });
  });

  describe('スクロール', () => {
    it('T-RUN-42: 8秒以内に初めて特定し、attended が真で、画面外のとき、1回だけスクロールする', async () => {
      const h = make();
      h.rects.set(h.target, OFF_SCREEN);
      follow(h, { attended: true });
      expect(h.scroll).toHaveBeenCalledTimes(1);
      expect(h.scroll).toHaveBeenCalledWith(h.target);
      await tick(5000);
      expect(h.scroll).toHaveBeenCalledTimes(1);
    });

    it('T-RUN-43: 特定が一度消えて再び特定されたとき、2回目はスクロールしない', async () => {
      const h = make();
      h.rects.set(h.target, OFF_SCREEN);
      follow(h);
      h.ctx.main = () => NOT_FOUND;
      await tick(1000);
      h.ctx.main = () => found(h.target);
      h.mutate();
      await tick(300);
      expect(h.overlay.paint.mock.calls.length).toBeGreaterThan(1);
      expect(h.scroll).toHaveBeenCalledTimes(1);
    });

    it('T-RUN-44: 8秒を過ぎてから初めて特定したとき、attended が真で画面外でもスクロールしない', async () => {
      const h = make();
      h.rects.set(h.target, OFF_SCREEN);
      h.render({ attended: true });
      await tick(SEARCH_WINDOW_MS + 500);
      h.ctx.main = () => found(h.target);
      h.mutate();
      await tick(2000);
      expect(h.overlay.paint).toHaveBeenCalled();
      expect(h.scroll).not.toHaveBeenCalled();
    });

    it('T-RUN-45: attended が偽のとき、8秒以内に特定して画面外でもスクロールしない', () => {
      const h = make();
      h.rects.set(h.target, OFF_SCREEN);
      follow(h, { attended: false });
      expect(h.scroll).not.toHaveBeenCalled();
    });

    it('T-RUN-46: 8秒以内に特定した要素がすでに画面内にあるとき、スクロールしない', () => {
      const h = make();
      follow(h, { attended: true });
      expect(h.scroll).not.toHaveBeenCalled();
    });

    it('T-RUN-47: SCROLL_TO_TARGET で、attended や8秒の条件に関係なく対象の位置までスクロールする', async () => {
      const h = make();
      h.rects.set(h.target, OFF_SCREEN);
      h.render({ attended: false });
      await tick(SEARCH_WINDOW_MS + 500);
      h.ctx.main = () => found(h.target);
      h.mutate();
      await tick(2000);
      h.send({ type: 'SCROLL_TO_TARGET', rev: h.nextRev() });
      expect(h.scroll).toHaveBeenCalledTimes(1);
      expect(h.scroll).toHaveBeenCalledWith(h.target);
    });

    it('T-RUN-48: SCROLL_TO_TARGET で、対象が未特定なら何も起きない', () => {
      const h = make();
      h.render();
      h.send({ type: 'SCROLL_TO_TARGET', rev: h.nextRev() });
      expect(h.scroll).not.toHaveBeenCalled();
    });
  });

  it('T-RUN-49: donePage が真の RENDER で、locate が実行されず、ハイライトも出ず、ミニガイドだけが表示される', async () => {
    const h = make();
    h.render({ donePage: true, hint: { met: true, unsupported: false, stopped: false } });
    expect(h.mainCalls()).toHaveLength(0);
    expect(h.overlay.paint).not.toHaveBeenCalled();
    expect(h.miniGuide.renderMiniGuide).toHaveBeenCalled();
    expect(h.lastModel()).toMatchObject({ hintKind: 'met', hasTarget: false, fallbackText: null });
    h.mutate();
    await tick(20_000);
    expect(h.mainCalls()).toHaveLength(0);
  });

  it('T-RUN-50: ハイライト中に donePage が真の RENDER を受けたとき、枠と吹き出しが消え、探索も止まる', async () => {
    const h = make();
    follow(h);
    h.overlay.clear.mockClear();
    h.render({ donePage: true });
    expect(h.overlay.clear).toHaveBeenCalled();
    const calls = h.mainCalls().length;
    h.mutate();
    await tick(10_000);
    expect(h.mainCalls()).toHaveLength(calls);
    expect(h.frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('T-RUN-51: CLEAR で、表示・タイマー・Observer・保留中の処理がすべて破棄される', async () => {
    const h = make();
    follow(h, { step: STEP_WITH_DONE });
    h.send({ type: 'CLEAR', rev: h.nextRev() });
    expect(h.overlay.clear).toHaveBeenCalled();
    expect(h.miniGuide.remove).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.frames.size).toBe(0);
    expect(h.observers.disconnected).toBe(h.observers.created);
    const calls = h.mainCalls().length;
    h.mutate();
    document.dispatchEvent(new Event('input', { bubbles: true }));
    await tick(10_000);
    expect(h.mainCalls()).toHaveLength(calls);
  });

  it('T-RUN-52: CLEAR の後に、保留中だった探索の結果が届いても、採用されず何も表示されない', async () => {
    const h = make();
    h.ctx.deferNext = true;
    h.render();
    h.send({ type: 'CLEAR', rev: h.nextRev() });
    h.deferred[0]?.resolve(found(h.target));
    await tick(0);
    expect(h.overlay.paint).not.toHaveBeenCalled();
    expect(h.locateResults()).toHaveLength(0);
  });
});

describe('非同期処理のトークン', () => {
  it('T-RUN-54: 探索中に gen が変わったとき、遅れて届いた古い探索結果が捨てられる', async () => {
    const h = make();
    h.ctx.deferNext = true;
    h.render({ gen: gen(1) });
    h.render({ gen: gen(2) });
    h.deferred[0]?.resolve(found(h.target));
    await tick(0);
    expect(h.overlay.paint).not.toHaveBeenCalled();
    expect(h.locateResults()).toHaveLength(0);
  });

  it('T-RUN-55: ステップ3で探索中に4へ移り、すぐ3へ戻ったとき、最初の探索結果が捨てられる', async () => {
    const h = make();
    h.ctx.deferNext = true;
    h.render({ gen: gen(3), index: 2 });
    h.ctx.deferNext = true;
    h.render({ gen: gen(4), index: 3 });
    h.ctx.deferNext = true;
    h.render({ gen: gen(5), index: 2 });
    h.deferred[0]?.resolve(found(h.other));
    await tick(0);
    expect(h.overlay.paint).not.toHaveBeenCalled();
    h.deferred[1]?.resolve(found(h.target));
    await tick(0);
    expect(h.overlay.paint).not.toHaveBeenCalled();
    h.deferred[2]?.resolve(found(h.target));
    await tick(0);
    expect(h.overlay.paint).toHaveBeenCalledTimes(1);
    expect(h.overlay.paint.mock.calls[0]?.[0]).toBe(h.target);
  });

  it('T-RUN-56: 探索中に pageSeq が変わったとき、前のページの探索結果が捨てられる', async () => {
    const h = make();
    h.ctx.deferNext = true;
    h.render({ pageSeq: pageSeq(1) });
    h.render({ pageSeq: pageSeq(2) });
    h.deferred[0]?.resolve(found(h.target));
    await tick(0);
    expect(h.overlay.paint).not.toHaveBeenCalled();
  });

  it('T-RUN-57: 探索中に rev が変わったとき、古い rev の探索結果が捨てられ、探し直される', async () => {
    const h = make();
    h.ctx.deferNext = true;
    h.render({ rev: rev(1) });
    h.render({ rev: rev(2), ui: { ...UI, width: 300 } });
    h.deferred[0]?.resolve(found(h.target));
    await tick(0);
    expect(h.overlay.paint).not.toHaveBeenCalled();
    h.ctx.main = () => found(h.target);
    await tick(300);
    expect(h.mainCalls()).toHaveLength(2);
    expect(h.overlay.paint).toHaveBeenCalled();
  });

  it('T-RUN-58: 判定中に (sessionId, gen, pageSeq, rev) が変わったとき、遅れて届いた目安の判定結果が捨てられる', async () => {
    const h = make();
    const resolvers: ((r: LocateResult) => void)[] = [];
    h.ctx.done = () =>
      new Promise<LocateResult>((resolve) => {
        resolvers.push(resolve);
      });
    h.render({ step: STEP_WITH_DONE, gen: gen(1) });
    h.render({ step: STEP_WITH_DONE, gen: gen(2) });
    resolvers[0]?.(found(h.target));
    await tick(0);
    expect(h.hintStates()).toHaveLength(0);
  });

  it('T-RUN-59: トークンが現在と一致する結果は、採用されて表示と報告に反映される', async () => {
    const h = make();
    h.ctx.deferNext = true;
    h.render();
    h.deferred[0]?.resolve(found(h.target));
    await tick(0);
    expect(h.overlay.paint).toHaveBeenCalled();
    expect(h.locateResults()).toHaveLength(1);
  });
});

describe('自分の表示の変化の無視と報告', () => {
  it('T-RUN-60: 自分の表示のホスト要素で DOM が変わったとき、変化として記録されず、locate が起動しない', async () => {
    const h = make();
    h.render();
    const host = document.createElement('div');
    host.setAttribute(OWN_HOST_ATTRIBUTE, '');
    document.documentElement.appendChild(host);
    host.appendChild(document.createElement('span'));
    host.setAttribute('style', 'color: red');
    host.textContent = 'x';
    await tick(5000);
    expect(h.mainCalls()).toHaveLength(1);
  });

  it('T-RUN-61: ページの childList・characterData の変化があったとき、変化として記録される', async () => {
    const h = make();
    h.render();
    h.mutate();
    await tick(250);
    expect(h.mainCalls()).toHaveLength(2);
    const text = document.createTextNode('a');
    h.target.appendChild(text);
    await tick(250);
    text.data = 'b';
    await tick(250);
    expect(h.mainCalls()).toHaveLength(4);
  });

  it('T-RUN-62: 監視対象の属性（id・class・aria-checked など）が変わったとき、変化として記録される', async () => {
    const h = make();
    h.render();
    for (const [name, value] of [['id', 'x'], ['class', 'c'], ['aria-checked', 'true'], ['hidden', ''], ['style', 'top:0']] as const) {
      const before = h.mainCalls().length;
      h.other.setAttribute(name, value);
      await tick(250);
      expect(h.mainCalls().length, name).toBe(before + 1);
    }
  });

  it('T-RUN-63: 監視対象外の属性（title・data-foo）が変わったとき、変化として記録されない', async () => {
    const h = make();
    h.render();
    h.other.setAttribute('title', 'x');
    h.other.setAttribute('data-foo', 'y');
    await tick(5000);
    expect(h.mainCalls()).toHaveLength(1);
  });

  it('T-RUN-64: 変化があったとき、その場では locate が実行されず、記録だけが行われて次の間引きの機会に実行される', async () => {
    const h = make();
    h.render();
    await tick(10);
    h.mutate();
    await tick(0);
    expect(h.mainCalls()).toHaveLength(1);
    await tick(239);
    expect(h.mainCalls()).toHaveLength(1);
    await tick(1);
    expect(h.mainCalls()).toHaveLength(2);
  });

  it('T-RUN-65: 同じ特定結果が続くとき、LOCATE_RESULT は最初の1回だけ送られる', async () => {
    const h = make();
    follow(h);
    await tick(5000);
    expect(h.mainCalls().length).toBeGreaterThan(3);
    expect(h.locateResults()).toHaveLength(1);
  });

  it('T-RUN-66: 特定結果が変わったとき（found から missing など）、LOCATE_RESULT が送られる', async () => {
    const h = make();
    follow(h);
    h.ctx.main = () => NOT_FOUND;
    // missing への変化は、喪失後の探し直しの8秒が過ぎたときに報告される
    await tick(1000 + SEARCH_WINDOW_MS);
    const results = h.locateResults();
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ result: { found: true } });
    expect(results[1]).toMatchObject({ result: { found: false } });
  });

  it('T-RUN-67: 目安の状態が変わらないとき、HINT_STATE は繰り返し送られない', async () => {
    const h = make();
    h.render({ step: STEP_WITH_DONE });
    await tick(5000);
    expect(h.doneCalls().length).toBeGreaterThan(3);
    expect(h.hintStates()).toHaveLength(0);
    h.ctx.done = () => found(byId('done'));
    await tick(1000);
    await tick(3000);
    expect(h.hintStates()).toHaveLength(1);
  });

  it('T-RUN-68: 目安の状態が変わったとき、HINT_STATE が送られる', async () => {
    const h = make();
    h.render({ step: STEP_WITH_DONE });
    h.ctx.done = () => found(byId('done'));
    await tick(1000);
    expect(h.hintStates().at(-1)).toMatchObject({ met: true, unsupported: false });
    expect(h.lastModel()?.hintKind).toBe('met');
    h.ctx.done = () => NOT_FOUND;
    document.dispatchEvent(new Event('input', { bubbles: true }));
    expect(h.hintStates().at(-1)).toMatchObject({ met: false });
    expect(h.hintStates()).toHaveLength(2);
    expect(h.lastModel()?.hintKind).toBe('unmet');
  });

  it('T-RUN-69: LOCATE_RESULT・HINT_STATE には、現在の sessionId・gen・pageSeq が付く', async () => {
    const h = make();
    h.ctx.main = () => found(h.target);
    h.ctx.done = () => found(byId('done'));
    h.render({ step: STEP_WITH_DONE, sessionId: sid(7), gen: gen(8), pageSeq: pageSeq(9) });
    await tick(0);
    const ident = { sessionId: sid(7), gen: gen(8), pageSeq: pageSeq(9) };
    expect(h.locateResults()[0]).toMatchObject(ident);
    expect(h.hintStates()[0]).toMatchObject(ident);
  });
});

describe('完了の目安と自動進行', () => {
  it('T-WATCH-23: 完了の目安が満たされても、ステップは自動で進まない（GOTO は送られない）', async () => {
    const h = make();
    h.ctx.main = () => found(h.target);
    h.ctx.done = () => found(byId('done'));
    h.render({ step: STEP_WITH_DONE });
    await tick(10_000);
    expect(h.hintStates()).toHaveLength(1);
    expect(h.sent.some((m) => m.type === 'GOTO')).toBe(false);
  });

  it('T-WATCH-24: 完了ページ（done.type: page）の目安は、ページ側のステップに含まれず判定されない', () => {
    const r = PageStepSchema.safeParse({
      id: 's',
      title: 't',
      done: { type: 'page', target: { css: ['#a'] } },
    });
    expect(r.success).toBe(false);
  });

  it('目安が未達成の間、ミニガイドには done.hint の案内が出る', () => {
    const h = make();
    h.render({ step: STEP_WITH_DONE });
    expect(h.lastModel()).toMatchObject({ hintKind: 'unmet', hintText: '押してください' });
  });
});

describe('ミニガイドの領域の変化', () => {
  it('R-C3: 領域が変わったら、バックグラウンドの RENDER を待たずに、吹き出しと減衰板を新しい領域で描き直す', () => {
    const h = make();
    follow(h);
    h.miniGuide.getRect.mockReturnValue({ left: 972, top: 0, right: 1000, bottom: 800 });
    h.overlay.paint.mockClear();
    h.miniGuide.getRect.mockReturnValue({ left: 680, top: 0, right: 1000, bottom: 800 });
    h.fireRectChange();
    expect(h.overlay.paint).toHaveBeenCalledTimes(1);
    expect(h.overlay.paint.mock.calls.at(-1)?.[0]).toBe(h.target);
    expect(h.overlay.paint.mock.calls.at(-1)?.[4]).toEqual({ left: 680, top: 0, right: 1000, bottom: 800 });
  });

  it('R-C3: 対象を持っていない間（探索中）に領域が変わっても、何も描かない', () => {
    const h = make();
    h.render();
    h.overlay.paint.mockClear();
    h.fireRectChange();
    expect(h.overlay.paint).not.toHaveBeenCalled();
  });

  it('R-C3: ミニガイドを使わない設定のときは、領域を渡さずに描き直す', () => {
    const h = make();
    follow(h, { ui: { ...UI, enabled: false } });
    h.miniGuide.getRect.mockReturnValue({ left: 680, top: 0, right: 1000, bottom: 800 });
    h.fireRectChange();
    expect(h.overlay.paint.mock.calls.at(-1)?.[4]).toBeNull();
  });

  it('R-C3: ミニガイドの描き直し中に通知が来ても、吹き出しは重ねて描かれない（描き直しは1回）', () => {
    const h = make();
    follow(h);
    h.miniGuide.renderMiniGuide.mockImplementation(() => {
      h.fireRectChange();
    });
    h.overlay.paint.mockClear();
    h.render({ step: { ...STEP_WITH_DONE, title: '別の見出し' } });
    expect(h.overlay.paint).toHaveBeenCalledTimes(1);
  });

  it('R-C3: 破棄したあとの通知では何も描かない', () => {
    const h = make();
    follow(h);
    h.rt.dispose();
    h.overlay.paint.mockClear();
    h.fireRectChange();
    expect(h.overlay.paint).not.toHaveBeenCalled();
  });
});

describe('表示を戻すボタン（ミニガイドを表示しない設定）', () => {
  const OFF = { ...UI, enabled: false };
  const HIDDEN = { hidden: true };

  it('R-C4: 対象を特定できているとき、ハイライトの描画の中でボタンが出る（今まで通り）', () => {
    const h = make();
    follow(h, { ui: OFF, overlay: HIDDEN });
    expect(h.overlay.paint.mock.calls.at(-1)?.[2]).toEqual({ hidden: true, miniGuideEnabled: false });
  });

  it('R-C4: 探索中（まだ特定できていない）でも、ボタンだけが出る', () => {
    const h = make();
    h.render({ ui: OFF, overlay: HIDDEN });
    expect(h.overlay.showRestore).toHaveBeenCalled();
    expect(h.overlay.paint).not.toHaveBeenCalled();
  });

  it('R-C4: 8秒後の文章だけの案内（対象が見つからない）でも、ボタンが出る', async () => {
    const h = make();
    h.render({ ui: OFF, overlay: HIDDEN });
    h.overlay.showRestore.mockClear();
    await tick(SEARCH_WINDOW_MS + 500);
    expect(h.lastModel()?.fallbackText).not.toBeNull();
    expect(h.overlay.showRestore).toHaveBeenCalled();
  });

  it('R-C4: 対象を持たない page ステップでも、ボタンが出る', () => {
    const h = make();
    h.render({ ui: OFF, overlay: HIDDEN, step: { id: 'p', title: '手順' } });
    expect(h.overlay.showRestore).toHaveBeenCalled();
  });

  it('R-C4: 表示が消えていないとき、またはミニガイドを使うときは、ボタンを出さない', () => {
    const h = make();
    h.render({ ui: OFF, overlay: { hidden: false } });
    h.render({ ui: UI, overlay: HIDDEN });
    expect(h.overlay.showRestore).not.toHaveBeenCalled();
  });

  it('T-OVL-22（追加）: 完了ページ（donePage）でも、ボタンだけが出る。表示が消えていなければ出ない', () => {
    const h = make();
    h.render({ ui: OFF, overlay: HIDDEN, donePage: true });
    expect(h.overlay.showRestore).toHaveBeenCalled();
    expect(h.overlay.paint).not.toHaveBeenCalled();
    h.overlay.showRestore.mockClear();
    h.render({ ui: OFF, overlay: { hidden: false }, donePage: true });
    expect(h.overlay.showRestore).not.toHaveBeenCalled();
  });
});
