// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OWN_HOST_ATTRIBUTE } from '../core/locator/index.ts';
import { createMiniGuide } from './miniguide/index.ts';
import { createOverlay } from './overlay/index.ts';
import { createRuntime } from './runtime/index.ts';
import { createDomObserver } from './runtime/observer.ts';
import { found, makeEnv, makeRender, rev, setRect } from './test-support.ts';

/** 実物のミニガイド・オーバーレイ・実行器をつないだ試験。 */

function build() {
  document.body.innerHTML = '<button id="target">x</button>';
  const target = document.getElementById('target');
  if (!target) throw new Error('準備に失敗');
  setRect(target, { left: 700, top: 100, right: 760, bottom: 140 });
  const roots: ShadowRoot[] = [];
  const hosts: HTMLElement[] = [];
  const attachShadow = (h: HTMLElement): ShadowRoot => {
    const r = h.attachShadow({ mode: 'closed' });
    roots.push(r);
    hosts.push(h);
    return r;
  };
  const viewport = () => ({ width: 1000, height: 800 });
  let sessionId: ReturnType<typeof createRuntime>['getSessionId'] | null = null;
  const overlay = createOverlay({
    doc: document,
    send: () => undefined,
    getSessionId: () => sessionId?.() ?? null,
    attachShadow,
    viewport,
    measureBubble: () => ({ width: 280, height: 100 }),
  });
  const miniGuide = createMiniGuide({
    doc: document,
    send: () => Promise.resolve({ status: 'done' }),
    attachShadow,
    viewport,
    isTrusted: () => true,
  });
  const rt = createRuntime({
    doc: document,
    env: makeEnv(),
    locate: () => found(target),
    now: () => Date.now(),
    requestFrame: () => 1,
    cancelFrame: () => undefined,
    createObserver: createDomObserver(),
    send: () => undefined,
    overlay,
    miniGuide,
  });
  sessionId = () => rt.getSessionId();
  const roots2 = () => {
    const [mgRoot, ovRoot] = roots;
    if (!mgRoot || !ovRoot) throw new Error('Shadow DOM がまだ無い');
    return { mgRoot, ovRoot };
  };
  return { rt, roots2, hosts };
}

function plateRights(root: ShadowRoot): number[] {
  return Array.from(root.querySelectorAll<HTMLElement>('.dim')).map(
    (el) => Number.parseFloat(el.style.left) + Number.parseFloat(el.style.width),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  document.documentElement.querySelectorAll(`[${OWN_HOST_ATTRIBUTE}]`).forEach((e) => {
    e.remove();
  });
});

describe('ミニガイドとオーバーレイの連動', () => {
  it('R-C3: ホバーで展開した直後にも、減衰板と吹き出しはミニガイドの領域を覆わない（T-OVL-04）', () => {
    const { rt, roots2 } = build();
    rt.handle(makeRender({ ui: { enabled: true, mode: 'hover', width: 400 } }));
    const { mgRoot, ovRoot } = roots2();
    const panel = mgRoot.querySelector('.panel');
    const bubble = ovRoot.querySelector<HTMLElement>('.bubble');
    if (!panel || !bubble) throw new Error('準備に失敗');
    // バーの間は右端の 28 px を除いた領域に描く
    expect(Math.max(...plateRights(ovRoot))).toBeLessThanOrEqual(1000 - 28);

    panel.dispatchEvent(new MouseEvent('pointerenter'));
    expect(Math.max(...plateRights(ovRoot))).toBeLessThanOrEqual(1000 - 400);
    expect(Number.parseFloat(bubble.style.left) + 280).toBeLessThanOrEqual(1000 - 400);

    panel.dispatchEvent(new MouseEvent('pointerleave'));
    vi.advanceTimersByTime(300);
    expect(Math.max(...plateRights(ovRoot))).toBeLessThanOrEqual(1000 - 28);
    expect(Math.max(...plateRights(ovRoot))).toBeGreaterThan(1000 - 400);
  });

  it('R-C3: ミニガイドのホストは、オーバーレイのホストより後ろ（前面）に並ぶ。オーバーレイが作り直されても変わらない', () => {
    const { rt, hosts } = build();
    rt.handle(makeRender());
    const [miniHost, overlayHost] = hosts;
    if (!miniHost || !overlayHost) throw new Error('準備に失敗');
    const order = (): Element[] => Array.from(document.documentElement.querySelectorAll(`:scope > [${OWN_HOST_ATTRIBUTE}]`));
    expect(order().at(-1)).toBe(miniHost);
    // 表示が消えて作り直されても、ミニガイドが前面のまま
    rt.handle(makeRender({ rev: rev(2), selected: false }));
    rt.handle(makeRender({ rev: rev(3) }));
    expect(order().at(-1)).toBe(miniHost);
  });
});
