// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { OWN_HOST_ATTRIBUTE } from '../../core/locator/index.ts';
import type { PageToBg } from '../../shared/messages/index.ts';
import { TEXT_FALLBACK_DEFAULT, TEXT_MET, TEXT_STOPPED, TEXT_UNMET_DEFAULT, TEXT_UNSUPPORTED, hintKind, hintText } from '../hint-text.ts';
import { nextOpId, setRect, sid } from '../test-support.ts';
import { BUBBLE_WIDTH, createOverlay, placeBubble, type OverlayState } from './index.ts';

interface Setup {
  roots: ShadowRoot[];
  sent: PageToBg[];
  overlay: ReturnType<typeof createOverlay>;
  target: HTMLElement;
}

const SHOWN: OverlayState = { hidden: false, miniGuideEnabled: true };
const MINI_EXPANDED = { left: 680, top: 0, right: 1000, bottom: 800 };

function setup(
  over: { isTrusted?: () => boolean; bubble?: { width: number; height: number }; viewport?: { width: number; height: number } } = {},
): Setup {
  document.body.innerHTML = '<button id="target">対象</button>';
  const target = document.getElementById('target');
  if (!target) throw new Error('準備に失敗');
  setRect(target, { left: 100, top: 100, right: 200, bottom: 140 });
  const roots: ShadowRoot[] = [];
  const sent: PageToBg[] = [];
  const overlay = createOverlay({
    doc: document,
    send: (m) => sent.push(m),
    getSessionId: () => sid(),
    newOpId: nextOpId,
    viewport: () => over.viewport ?? { width: 1000, height: 800 },
    measureBubble: () => over.bubble ?? { width: BUBBLE_WIDTH, height: 100 },
    ...(over.isTrusted ? { isTrusted: over.isTrusted } : {}),
    attachShadow: (host) => {
      const root = host.attachShadow({ mode: 'closed' });
      roots.push(root);
      return root;
    },
  });
  return { roots, sent, overlay, target };
}

function root(s: Setup): ShadowRoot {
  const r = s.roots[0];
  if (!r) throw new Error('Shadow DOM がまだ無い');
  return r;
}

function q(s: Setup, sel: string): HTMLElement | null {
  return root(s).querySelector<HTMLElement>(sel);
}

function plates(s: Setup): { left: number; top: number; right: number; bottom: number }[] {
  return Array.from(root(s).querySelectorAll<HTMLElement>('.dim')).map((el) => {
    const left = Number.parseFloat(el.style.left);
    const top = Number.parseFloat(el.style.top);
    return { left, top, right: left + Number.parseFloat(el.style.width), bottom: top + Number.parseFloat(el.style.height) };
  });
}

function overlaps(a: { left: number; top: number; right: number; bottom: number }, b: typeof a): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom && a.right > a.left && a.bottom > a.top;
}

function paint(s: Setup, over: { state?: OverlayState; mini?: typeof MINI_EXPANDED | null; hint?: string | null; title?: string; tip?: string } = {}): void {
  s.overlay.paint(
    s.target,
    { title: over.title ?? '見出し', tip: over.tip },
    over.state ?? SHOWN,
    over.hint ?? null,
    over.mini === undefined ? null : over.mini,
  );
}

function click(el: HTMLElement | null): void {
  if (!el) throw new Error('要素が無い');
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

afterEach(() => {
  document.documentElement.querySelectorAll(`[${OWN_HOST_ATTRIBUTE}]`).forEach((e) => { e.remove(); });
  document.body.innerHTML = '';
});

describe('表示の作り', () => {
  it('T-OVL-01: Shadow DOM は閉じたモードで作られ、ページから shadowRoot を取得できない', () => {
    // 既定の attachShadow を使う
    document.body.innerHTML = '<button id="target"></button>';
    const target = document.getElementById('target');
    if (!target) throw new Error('準備に失敗');
    const overlay = createOverlay({ doc: document, send: () => undefined, getSessionId: () => sid() });
    overlay.paint(target, { title: 't' }, SHOWN, null, null);
    const host = document.querySelector(`[${OWN_HOST_ATTRIBUTE}]`);
    expect(host).not.toBeNull();
    expect(host?.shadowRoot).toBeNull();
    overlay.clear();
  });

  it('ホスト要素に属性が付き、スタイルは Shadow DOM の中の style にあり、all: initial を使う', () => {
    const s = setup();
    paint(s);
    const host = document.querySelector(`[${OWN_HOST_ATTRIBUTE}]`);
    expect(host?.getAttribute('style')).toContain('all: initial');
    expect(host?.getAttribute('style')).toContain('2147483647');
    expect(root(s).querySelector('style')?.textContent).toContain('all: initial');
  });

  it('T-OVL-02: 減衰板と枠は pointer-events: none', () => {
    const s = setup();
    paint(s);
    const css = root(s).querySelector('style')?.textContent ?? '';
    for (const cls of ['dim', 'frame']) {
      const rule = new RegExp(`\\.${cls}\\s*\\{[^}]*pointer-events:\\s*none`).exec(css);
      expect(rule, cls).not.toBeNull();
    }
    expect(root(s).querySelectorAll('.dim, .frame').length).toBe(5);
  });

  it('T-OVL-03: 減衰板は4枚で、対象の周囲を覆い、対象の矩形の上は覆わない', () => {
    const s = setup();
    paint(s);
    const p = plates(s);
    expect(p).toHaveLength(4);
    const targetRect = { left: 100, top: 100, right: 200, bottom: 140 };
    for (const plate of p) expect(overlaps(plate, targetRect)).toBe(false);
    // 4枚で全体（1000x800）から対象の枠を除いた面積と一致する
    const area = p.reduce((sum, r) => sum + (r.right - r.left) * (r.bottom - r.top), 0);
    expect(area).toBe(1000 * 800 - 108 * 48);
  });

  it('T-OVL-04: ミニガイドが展開しているとき、減衰板はミニガイドの矩形と重ならない', () => {
    const s = setup();
    paint(s, { mini: MINI_EXPANDED });
    for (const plate of plates(s)) expect(overlaps(plate, MINI_EXPANDED)).toBe(false);
  });

  it('T-OVL-05: ミニガイドが最小化（バー28 px）のとき、減衰板はバーの矩形と重ならない', () => {
    const s = setup();
    const bar = { left: 972, top: 0, right: 1000, bottom: 800 };
    paint(s, { mini: bar });
    const p = plates(s);
    for (const plate of p) expect(overlaps(plate, bar)).toBe(false);
    expect(Math.max(...p.map((r) => r.right))).toBe(972);
  });

  it('T-OVL-06: ミニガイドがないとき、減衰板は制限なく周囲を覆う', () => {
    const s = setup();
    paint(s, { mini: null });
    expect(Math.max(...plates(s).map((r) => r.right))).toBe(1000);
  });
});

describe('吹き出しの配置', () => {
  const area = { left: 0, top: 0, right: 1000, bottom: 800 };
  const size = { width: 280, height: 100 };

  it('T-OVL-07: 下に十分な空きがあるとき、対象の下に置かれる', () => {
    const r = placeBubble({ left: 100, top: 100, right: 200, bottom: 140 }, area, size);
    expect(r.placement).toBe('below');
    expect(r.top).toBe(148);
  });

  it('T-OVL-08: 下に収まらず上に収まるとき、対象の上に置かれる', () => {
    const r = placeBubble({ left: 100, top: 700, right: 200, bottom: 780 }, area, size);
    expect(r.placement).toBe('above');
    expect(r.top).toBe(700 - 8 - 100);
  });

  it('T-OVL-09: 下にも上にも収まらず左に収まるとき、対象の左に置かれる', () => {
    const tall = { left: 600, top: 20, right: 700, bottom: 790 };
    const r = placeBubble(tall, area, size);
    expect(r.placement).toBe('left');
    expect(r.left).toBe(600 - 8 - 280);
  });

  it('どこにも収まらないときは、下に置き、表示領域の中へ寄せる', () => {
    const r = placeBubble({ left: 0, top: 0, right: 1000, bottom: 800 }, area, size);
    expect(r.placement).toBe('fallback');
    expect(r.top + size.height).toBeLessThanOrEqual(area.bottom);
    expect(r.left + size.width).toBeLessThanOrEqual(area.right);
  });

  it('T-OVL-10・T-OVL-11: 対象が右端でも、吹き出しは表示領域（ミニガイドを除いた範囲）の中に置かれる', () => {
    const s = setup();
    setRect(s.target, { left: 640, top: 100, right: 700, bottom: 140 });
    paint(s, { mini: MINI_EXPANDED });
    const bubble = q(s, '.bubble');
    const left = Number.parseFloat(bubble?.style.left ?? 'NaN');
    expect(left + BUBBLE_WIDTH).toBeLessThanOrEqual(MINI_EXPANDED.left);
    const frame = q(s, '.frame');
    expect(Number.parseFloat(frame?.style.left ?? 'NaN') + Number.parseFloat(frame?.style.width ?? 'NaN')).toBeLessThanOrEqual(MINI_EXPANDED.left);
  });
});

describe('吹き出しの中身', () => {
  it('T-OVL-12: title・tip の HTML 文字列は要素にならず、文字列として描かれる', () => {
    const s = setup();
    paint(s, { title: '<b>見出し</b>', tip: '<img src=x onerror=alert(1)> を `押す`' });
    const bubble = q(s, '.bubble');
    expect(bubble?.querySelector('b, img')).toBeNull();
    expect(q(s, '.title')?.textContent).toBe('<b>見出し</b>');
    expect(q(s, '.tip')?.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('T-OVL-13: tip は強調とインラインコードだけが装飾される', () => {
    const s = setup();
    paint(s, { tip: '**太字** と *斜体* と `code` と [link](http://x) と # 見出し' });
    const tip = q(s, '.tip');
    expect(tip?.querySelectorAll('strong, em, code')).toHaveLength(3);
    expect(tip?.querySelector('a, h1')).toBeNull();
    expect(tip?.textContent).toContain('[link](http://x)');
  });

  it('T-OVL-14: 目安の状態（満たした・まだ・確認できない・確認を停止中）が吹き出しに表示される', () => {
    const s = setup();
    const cases: [ReturnType<typeof hintKind>, string][] = [
      ['met', TEXT_MET],
      ['unmet', TEXT_UNMET_DEFAULT],
      ['unsupported', TEXT_UNSUPPORTED],
      ['stopped', TEXT_STOPPED],
    ];
    expect(TEXT_MET).toBe('次へ進めます');
    expect(TEXT_UNSUPPORTED).toBe('この項目は確認できません');
    expect(TEXT_STOPPED).toBe('確認を停止中');
    expect(TEXT_FALLBACK_DEFAULT).toBe('対象が見つかりません。説明に沿って操作してください');
    for (const [kind, text] of cases) {
      paint(s, { hint: hintText(kind, undefined) });
      expect(q(s, '.hint')?.textContent).toBe(text);
    }
    // ツアーが書いた未達成の案内を使う
    expect(hintText('unmet', 'ボタンを押してください')).toBe('ボタンを押してください');
    // 優先順位：停止 > 確認できない > 満たした
    expect(hintKind(true, { met: true, unsupported: true, stopped: true })).toBe('stopped');
    expect(hintKind(true, { met: true, unsupported: true, stopped: false })).toBe('unsupported');
    expect(hintKind(true, { met: true, unsupported: false, stopped: false })).toBe('met');
    expect(hintKind(false, { met: true, unsupported: false, stopped: false })).toBe('none');
    paint(s, { hint: null });
    expect(q(s, '.hint')?.hidden).toBe(true);
  });
});

describe('操作', () => {
  it('T-OVL-15: × を（信頼できる操作で）押したとき、SET_OVERLAY{hidden: true, sessionId, opId} が送られる', () => {
    const s = setup({ isTrusted: () => true });
    paint(s);
    click(q(s, '.close'));
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toMatchObject({ type: 'SET_OVERLAY', hidden: true, sessionId: sid() });
    expect(s.sent[0]).toHaveProperty('opId');
  });

  it('T-OVL-16: × を押した後（hidden: true で描き直すと）、ハイライトと吹き出しは消える', () => {
    const s = setup({ isTrusted: () => true });
    paint(s);
    click(q(s, '.close'));
    paint(s, { state: { hidden: true, miniGuideEnabled: true } });
    expect(root(s).querySelectorAll('.dim, .frame, .bubble')).toHaveLength(0);
  });

  it('T-OVL-17: ページのスクリプトが発生させたクリック（isTrusted が偽）では、× は何も送らない', () => {
    const s = setup();
    paint(s);
    click(q(s, '.close'));
    expect(s.sent).toHaveLength(0);
  });

  it('T-OVL-18: ミニガイドが無効で表示が消えているとき、表示を戻すボタンが出る', () => {
    const s = setup();
    paint(s, { state: { hidden: true, miniGuideEnabled: false } });
    expect(q(s, '.restore')?.textContent).toBe('表示を戻す');
  });

  it('T-OVL-19: ミニガイドが有効なとき、表示を戻すボタンは出ない', () => {
    const s = setup();
    paint(s, { state: { hidden: true, miniGuideEnabled: true } });
    expect(q(s, '.restore')).toBeNull();
    paint(s, { state: { hidden: false, miniGuideEnabled: false } });
    expect(q(s, '.restore')).toBeNull();
  });

  it('T-OVL-20: 表示を戻すボタンを（信頼できる操作で）押したとき、SET_OVERLAY{hidden: false} が送られる', () => {
    const s = setup({ isTrusted: () => true });
    paint(s, { state: { hidden: true, miniGuideEnabled: false } });
    click(q(s, '.restore'));
    expect(s.sent[0]).toMatchObject({ type: 'SET_OVERLAY', hidden: false, sessionId: sid() });
  });

  it('T-OVL-21: isTrusted が偽のクリックでは、表示を戻すボタンは何も送らない', () => {
    const s = setup();
    paint(s, { state: { hidden: true, miniGuideEnabled: false } });
    click(q(s, '.restore'));
    expect(s.sent).toHaveLength(0);
  });

  it('T-OVL-22: ハイライトがないとき（paint を呼ばない・clear 済み）、ページ上に何も出ない', () => {
    const s = setup();
    expect(document.querySelector(`[${OWN_HOST_ATTRIBUTE}]`)).toBeNull();
    paint(s, { state: { hidden: true, miniGuideEnabled: false } });
    s.overlay.clear();
    expect(document.querySelector(`[${OWN_HOST_ATTRIBUTE}]`)).toBeNull();
  });

  it('T-OVL-23: clear() で枠・減衰板・吹き出し・ボタンがすべて取り除かれ、何度呼んでも壊れない', () => {
    const s = setup();
    paint(s);
    s.overlay.clear();
    expect(document.querySelector(`[${OWN_HOST_ATTRIBUTE}]`)).toBeNull();
    paint(s, { state: { hidden: true, miniGuideEnabled: false } });
    s.overlay.clear();
    s.overlay.clear();
    expect(document.querySelector(`[${OWN_HOST_ATTRIBUTE}]`)).toBeNull();
  });

  it('T-OVL-24: すべてのボタンが <button> で、キーボードの Tab 移動から外れていない', () => {
    const s = setup();
    paint(s, { state: SHOWN });
    const close = q(s, '.close');
    expect(close?.tagName).toBe('BUTTON');
    expect(close?.getAttribute('tabindex')).toBeNull();
    paint(s, { state: { hidden: true, miniGuideEnabled: false } });
    const restore = q(s, '.restore');
    expect(restore?.tagName).toBe('BUTTON');
    expect(restore?.getAttribute('tabindex')).toBeNull();
    expect(root(s).querySelectorAll('[role="button"]')).toHaveLength(0);
  });

  it('T-OVL-25: キーボードのフォーカスが見える（:focus-visible の指定がある）', () => {
    const s = setup();
    paint(s);
    expect(root(s).querySelector('style')?.textContent).toMatch(/button:focus-visible\s*\{[^}]*outline/);
  });

  it('同じ内容で何度 paint しても、要素は二重にならず、位置の変化に追従する', () => {
    const s = setup();
    paint(s);
    paint(s);
    expect(root(s).querySelectorAll('.bubble, .frame')).toHaveLength(2);
    setRect(s.target, { left: 300, top: 300, right: 400, bottom: 340 });
    paint(s);
    expect(Number.parseFloat(q(s, '.frame')?.style.left ?? 'NaN')).toBe(300 - 4);
  });
});
