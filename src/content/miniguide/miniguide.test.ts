// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OWN_HOST_ATTRIBUTE } from '../../core/locator/index.ts';
import type { PageToBg, UiSettings } from '../../shared/messages/index.ts';
import { gen, nextOpId, sid } from '../test-support.ts';
import { BAR_WIDTH, createMiniGuide, HOVER_CLOSE_MS, type MiniGuideModel } from './index.ts';

const MODEL: MiniGuideModel = {
  sessionId: sid(),
  gen: gen(4),
  index: 1,
  total: 3,
  title: '見出し',
  tip: '補足の `コード`',
  hintKind: 'unmet',
  hintText: 'まだ完了の目安を満たしていません',
  fallbackText: null,
  isLast: false,
  overlayHidden: false,
  hasTarget: true,
  shortcut: 'Alt+Shift+G',
};
const UI: UiSettings = { enabled: true, mode: 'expanded', width: 320 };
const MIN: UiSettings = { ...UI, mode: 'minimized' };
const HOVER: UiSettings = { ...UI, mode: 'hover' };

interface Setup {
  roots: ShadowRoot[];
  sent: PageToBg[];
  mg: ReturnType<typeof createMiniGuide>;
}

function setup(trusted = true): Setup {
  const roots: ShadowRoot[] = [];
  const sent: PageToBg[] = [];
  const mg = createMiniGuide({
    doc: document,
    send: (m) => sent.push(m),
    newOpId: nextOpId,
    isTrusted: () => trusted,
    viewport: () => ({ width: 1000, height: 800 }),
    attachShadow: (host) => {
      const root = host.attachShadow({ mode: 'closed' });
      roots.push(root);
      return root;
    },
  });
  return { roots, sent, mg };
}

function root(s: Setup): ShadowRoot {
  const r = s.roots[0];
  if (!r) throw new Error('Shadow DOM がまだ無い');
  return r;
}
function q(s: Setup, sel: string): HTMLElement {
  const el = root(s).querySelector<HTMLElement>(sel);
  if (!el) throw new Error(`要素が無い: ${sel}`);
  return el;
}
function maybe(s: Setup, sel: string): HTMLElement | null {
  return root(s).querySelector<HTMLElement>(sel);
}
function buttonByText(s: Setup, text: string): HTMLButtonElement {
  const b = Array.from(root(s).querySelectorAll('button')).find((x) => x.textContent === text);
  if (!b) throw new Error(`ボタンが無い: ${text}`);
  return b;
}
function click(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}
function ptr(el: HTMLElement, type: string, clientX = 0): void {
  el.dispatchEvent(new MouseEvent(type, { bubbles: type !== 'pointerenter' && type !== 'pointerleave', clientX }));
}
function key(el: HTMLElement, k: string): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
}
function width(s: Setup): number {
  return Number.parseFloat(q(s, '.panel').style.width);
}
function setUis(s: Setup): Extract<PageToBg, { type: 'SET_UI' }>[] {
  return s.sent.flatMap((m) => (m.type === 'SET_UI' ? [m] : []));
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  document.documentElement.querySelectorAll(`[${OWN_HOST_ATTRIBUTE}]`).forEach((e) => { e.remove(); });
});

describe('表示の条件', () => {
  it('T-MG-01: ui.enabled が偽のとき、描かれない', () => {
    const s = setup();
    s.mg.renderMiniGuide(MODEL, { ...UI, enabled: false });
    expect(document.querySelector(`[${OWN_HOST_ATTRIBUTE}]`)).toBeNull();
  });

  it('T-MG-02: ui.enabled が偽に変わったとき、描かれたミニガイドが取り除かれる', () => {
    const s = setup();
    s.mg.renderMiniGuide(MODEL, UI);
    expect(document.querySelector(`[${OWN_HOST_ATTRIBUTE}]`)).not.toBeNull();
    s.mg.renderMiniGuide(MODEL, { ...UI, enabled: false });
    expect(document.querySelector(`[${OWN_HOST_ATTRIBUTE}]`)).toBeNull();
    expect(s.mg.getRect()).toBeNull();
  });

  it('T-MG-03: 描画指示が届いていないとき（model が null）、描かれない', () => {
    const s = setup();
    s.mg.renderMiniGuide(null, UI);
    expect(document.querySelector(`[${OWN_HOST_ATTRIBUTE}]`)).toBeNull();
  });

  it('T-MG-04: ホストは閉じた Shadow DOM で、ページから shadowRoot を取得できない', () => {
    const mg = createMiniGuide({ doc: document, send: () => undefined });
    mg.renderMiniGuide(MODEL, UI);
    const host = document.querySelector(`[${OWN_HOST_ATTRIBUTE}]`);
    expect(host).not.toBeNull();
    expect(host?.shadowRoot).toBeNull();
    expect(host?.getAttribute('style')).toContain('all: initial');
    mg.remove();
  });

  it('T-MG-44: 同じ内容で再度呼んでも、二重に作られない', () => {
    const s = setup();
    s.mg.renderMiniGuide(MODEL, UI);
    s.mg.renderMiniGuide(MODEL, UI);
    expect(document.querySelectorAll(`[${OWN_HOST_ATTRIBUTE}]`)).toHaveLength(1);
    expect(root(s).querySelectorAll('.title')).toHaveLength(1);
  });
});

describe('展開の表示', () => {
  it('T-MG-05: 展開のとき、右端に固定され、width の幅で表示される', () => {
    const s = setup();
    s.mg.renderMiniGuide(MODEL, { ...UI, width: 400 });
    expect(width(s)).toBe(400);
    expect(s.mg.getRect()).toEqual({ left: 600, top: 0, right: 1000, bottom: 800 });
    expect(root(s).querySelector('style')?.textContent).toMatch(/\.panel\s*\{[^}]*position:\s*fixed[^}]*right:\s*0/);
  });

  it('T-MG-06: 展開のとき、n/N・見出し・tip・目安の状態が表示される', () => {
    const s = setup();
    s.mg.renderMiniGuide(MODEL, UI);
    expect(q(s, '.step').textContent).toBe('2/3');
    expect(q(s, '.title').textContent).toBe('見出し');
    expect(q(s, '.tip code').textContent).toBe('コード');
    expect(q(s, '.hint').textContent).toBe('まだ完了の目安を満たしていません');
  });

  it('T-MG-07: 文章だけの案内のとき、案内文が表示される', () => {
    const s = setup();
    s.mg.renderMiniGuide({ ...MODEL, fallbackText: '画面右上のボタンを押してください' }, UI);
    expect(q(s, '.fallback').textContent).toBe('画面右上のボタンを押してください');
    s.mg.renderMiniGuide({ ...MODEL, fallbackText: null }, UI);
    expect(q(s, '.fallback').hidden).toBe(true);
  });

  it('T-MG-08: 最終ステップのとき、「次へ」の代わりに「完了」が表示される', () => {
    const s = setup();
    s.mg.renderMiniGuide({ ...MODEL, isLast: true }, UI);
    expect(buttonByText(s, '完了')).toBeTruthy();
    expect(() => buttonByText(s, '次へ')).toThrow();
  });

  it('T-MG-09: 最初のステップのとき、「戻る」が無効になる', () => {
    const s = setup();
    s.mg.renderMiniGuide({ ...MODEL, index: 0 }, UI);
    expect(buttonByText(s, '戻る').disabled).toBe(true);
    s.mg.renderMiniGuide({ ...MODEL, index: 1 }, UI);
    expect(buttonByText(s, '戻る').disabled).toBe(false);
  });

  it('T-MG-10: ページ上の表示が消えているときだけ、「表示を戻す」が表示される', () => {
    const s = setup();
    s.mg.renderMiniGuide({ ...MODEL, overlayHidden: true }, UI);
    expect(buttonByText(s, '表示を戻す').hidden).toBe(false);
    s.mg.renderMiniGuide({ ...MODEL, overlayHidden: false }, UI);
    expect(buttonByText(s, '表示を戻す').hidden).toBe(true);
  });

  it('T-MG-40: ショートカットキーの案内が、受け取った実際の割り当てで表示される', () => {
    const s = setup();
    s.mg.renderMiniGuide({ ...MODEL, shortcut: 'Ctrl+Shift+Y' }, UI);
    expect(q(s, '.shortcut').textContent).toContain('Ctrl+Shift+Y');
  });

  it('T-MG-41: ショートカットが未割り当てのとき、割り当てがない旨の案内になる', () => {
    const s = setup();
    s.mg.renderMiniGuide({ ...MODEL, shortcut: null }, UI);
    expect(q(s, '.shortcut').textContent).toContain('割り当てられていません');
  });

  it('T-MG-43: 見出し・tip の HTML 文字列は、文字列のまま描かれる', () => {
    const s = setup();
    s.mg.renderMiniGuide({ ...MODEL, title: '<b>見出し</b>', tip: '<img src=x onerror=alert(1)>' }, UI);
    expect(q(s, '.title').textContent).toBe('<b>見出し</b>');
    expect(q(s, '.tip').textContent).toBe('<img src=x onerror=alert(1)>');
    expect(root(s).querySelector('.body b, .body img')).toBeNull();
  });

  it('T-MG-42: すべてのボタンが <button> で、フォーカス表示の指定がある', () => {
    const s = setup();
    s.mg.renderMiniGuide({ ...MODEL, overlayHidden: true }, UI);
    const labels = ['戻る', '次へ', '対象を表示', '表示を戻す', '展開', 'ホバー', '最小化'];
    for (const l of labels) expect(buttonByText(s, l).getAttribute('tabindex')).toBeNull();
    expect(root(s).querySelector('style')?.textContent).toMatch(/button:focus-visible\s*\{[^}]*outline/);
    expect(root(s).querySelector('style')?.textContent).toMatch(/\.bar:focus-visible\s*\{[^}]*outline/);
    s.mg.renderMiniGuide(MODEL, { ...UI, mode: 'minimized' });
    expect(q(s, '.bar').tagName).toBe('BUTTON');
  });
});

describe('最小化とホバー', () => {

  it('T-MG-11: 最小化のとき、幅28 px のバーが表示され、ステップ番号と目安の状態が出る', () => {
    const s = setup();
    s.mg.renderMiniGuide({ ...MODEL, hintKind: 'met', hintText: '次へ進めます' }, MIN);
    expect(width(s)).toBe(BAR_WIDTH);
    expect(BAR_WIDTH).toBe(28);
    expect(q(s, '.bar .n').textContent).toBe('2/3');
    expect(q(s, '.bar .mark').textContent).toBe('✓');
    expect(q(s, '.bar').getAttribute('aria-label')).toContain('次へ進めます');
    expect(maybe(s, '.body')).toBeNull();
    expect(s.mg.getRect()?.left).toBe(1000 - 28);
  });

  it('T-MG-12: 最小化のバーをクリックしたとき、展開に変わり SET_UI{mode} が送られる', () => {
    const s = setup();
    s.mg.renderMiniGuide(MODEL, MIN);
    click(q(s, '.bar'));
    expect(maybe(s, '.body')).not.toBeNull();
    expect(setUis(s)).toEqual([{ type: 'SET_UI', mode: 'expanded', width: 320 }]);
    // 画面更新（古い設定のままの再描画）で手元の変更が戻らない
    s.mg.renderMiniGuide(MODEL, MIN);
    expect(maybe(s, '.body')).not.toBeNull();
  });

  it('T-MG-13: 最小化のバーで Enter を押したとき、展開に変わる', () => {
    const s = setup();
    s.mg.renderMiniGuide(MODEL, MIN);
    key(q(s, '.bar'), 'Enter');
    expect(maybe(s, '.body')).not.toBeNull();
  });

  it('T-MG-14: ホバーのとき、普段はバーだけが表示される', () => {
    const s = setup();
    s.mg.renderMiniGuide(MODEL, HOVER);
    expect(maybe(s, '.bar')).not.toBeNull();
    expect(maybe(s, '.body')).toBeNull();
    expect(width(s)).toBe(28);
  });

  it('T-MG-15: ホバーのとき、pointerenter で展開する（SET_UI は送らない）', () => {
    const s = setup();
    s.mg.renderMiniGuide(MODEL, HOVER);
    ptr(q(s, '.panel'), 'pointerenter');
    expect(maybe(s, '.body')).not.toBeNull();
    expect(width(s)).toBe(320);
    expect(setUis(s)).toHaveLength(0);
  });

  it('T-MG-16: ホバーのとき、focusin で展開する', () => {
    const s = setup();
    s.mg.renderMiniGuide(MODEL, HOVER);
    q(s, '.panel').dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(maybe(s, '.body')).not.toBeNull();
  });

  it('T-MG-17・T-MG-20: pointerleave から300ミリ秒たつとバーに戻る（299ミリ秒ではまだ戻らない）', () => {
    const s = setup();
    s.mg.renderMiniGuide(MODEL, HOVER);
    ptr(q(s, '.panel'), 'pointerenter');
    ptr(q(s, '.panel'), 'pointerleave');
    vi.advanceTimersByTime(HOVER_CLOSE_MS - 1);
    expect(maybe(s, '.body')).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(maybe(s, '.body')).toBeNull();
    expect(HOVER_CLOSE_MS).toBe(300);
  });

  it('T-MG-18: focusout から300ミリ秒たつとバーに戻る', () => {
    const s = setup();
    s.mg.renderMiniGuide(MODEL, HOVER);
    ptr(q(s, '.panel'), 'pointerenter');
    q(s, '.panel').dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    vi.advanceTimersByTime(299);
    expect(maybe(s, '.body')).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(maybe(s, '.body')).toBeNull();
  });

  it('T-MG-19: pointerleave から300ミリ秒以内に pointerenter が起きたとき、展開のまま', () => {
    const s = setup();
    s.mg.renderMiniGuide(MODEL, HOVER);
    ptr(q(s, '.panel'), 'pointerenter');
    ptr(q(s, '.panel'), 'pointerleave');
    vi.advanceTimersByTime(200);
    ptr(q(s, '.panel'), 'pointerenter');
    vi.advanceTimersByTime(1000);
    expect(maybe(s, '.body')).not.toBeNull();
  });

  it('ホバー状態のバーのクリックは、一時的に展開する（SET_UI は送らない）', () => {
    const s = setup();
    s.mg.renderMiniGuide(MODEL, HOVER);
    click(q(s, '.bar'));
    expect(maybe(s, '.body')).not.toBeNull();
    expect(setUis(s)).toHaveLength(0);
  });

  it('T-MG-34: 展開・ホバー・最小化の切り替えで SET_UI{mode, width} が送られる', () => {
    const s = setup();
    s.mg.renderMiniGuide(MODEL, UI);
    click(buttonByText(s, '最小化'));
    expect(maybe(s, '.bar')).not.toBeNull();
    click(q(s, '.bar'));
    click(buttonByText(s, 'ホバー'));
    click(q(s, '.bar'));
    click(buttonByText(s, '展開'));
    expect(setUis(s)).toEqual([
      { type: 'SET_UI', mode: 'minimized', width: 320 },
      { type: 'SET_UI', mode: 'expanded', width: 320 },
      { type: 'SET_UI', mode: 'hover', width: 320 },
      { type: 'SET_UI', mode: 'expanded', width: 320 },
    ]);
  });

  it('T-MG-39: 表示状態の切り替えは、ページ上の表示（ハイライト・吹き出し）に影響しない', () => {
    // ミニガイドはホスト要素を1つだけ持ち、ハイライトの表示には触れない（メッセージも SET_UI だけ）
    const s = setup();
    s.mg.renderMiniGuide(MODEL, UI);
    click(buttonByText(s, '最小化'));
    expect(s.sent.every((m) => m.type === 'SET_UI')).toBe(true);
    expect(document.querySelectorAll(`[${OWN_HOST_ATTRIBUTE}]`)).toHaveLength(1);
  });
});

describe('幅の変更', () => {
  it('T-MG-21: 左の境界のつまみをドラッグすると幅が変わる（左へ動かすと広がり、右へ動かすと狭まる）', () => {
    const s = setup();
    s.mg.renderMiniGuide(MODEL, UI);
    const handle = q(s, '.handle');
    ptr(handle, 'pointerdown', 700);
    ptr(handle, 'pointermove', 650);
    expect(width(s)).toBe(370);
    ptr(handle, 'pointermove', 740);
    expect(width(s)).toBe(280);
  });

  it('T-MG-22: ドラッグ中は SET_UI が送られず、離したときに1回だけ送られる', () => {
    const s = setup();
    s.mg.renderMiniGuide(MODEL, UI);
    const handle = q(s, '.handle');
    ptr(handle, 'pointerdown', 700);
    ptr(handle, 'pointermove', 680);
    ptr(handle, 'pointermove', 650);
    expect(setUis(s)).toHaveLength(0);
    ptr(handle, 'pointerup', 650);
    expect(setUis(s)).toEqual([{ type: 'SET_UI', mode: 'expanded', width: 370 }]);
    ptr(handle, 'pointerup', 650);
    expect(setUis(s)).toHaveLength(1);
  });

  it('T-MG-22（追加）: clientX が小数でも、幅は整数に丸められる', () => {
    const s = setup();
    s.mg.renderMiniGuide(MODEL, UI);
    const handle = q(s, '.handle');
    ptr(handle, 'pointerdown', 700.5);
    ptr(handle, 'pointermove', 670.25);
    expect(Number.isInteger(width(s))).toBe(true);
    ptr(handle, 'pointerup', 670.25);
    const sent = setUis(s);
    expect(sent).toHaveLength(1);
    expect(Number.isInteger(sent[0]?.width)).toBe(true);
    expect(Number.isInteger(s.mg.getRect()?.left)).toBe(true);
  });

  it('T-MG-23: 240 px より小さくしようとしたとき、240 px に制限される', () => {
    const s = setup();
    s.mg.renderMiniGuide(MODEL, UI);
    const handle = q(s, '.handle');
    ptr(handle, 'pointerdown', 700);
    ptr(handle, 'pointermove', 900);
    expect(width(s)).toBe(240);
  });

  it('T-MG-24: 560 px より大きくしようとしたとき、560 px に制限される', () => {
    const s = setup();
    s.mg.renderMiniGuide(MODEL, UI);
    const handle = q(s, '.handle');
    ptr(handle, 'pointerdown', 700);
    ptr(handle, 'pointermove', 100);
    expect(width(s)).toBe(560);
  });

  it('T-MG-25・T-MG-27: つまみで左キーは16 px 広げ、右キーは16 px 狭め、そのつど SET_UI が送られる', () => {
    const s = setup();
    s.mg.renderMiniGuide(MODEL, UI);
    const handle = q(s, '.handle');
    key(handle, 'ArrowLeft');
    expect(width(s)).toBe(336);
    key(handle, 'ArrowRight');
    key(handle, 'ArrowRight');
    expect(width(s)).toBe(304);
    expect(setUis(s).map((m) => m.width)).toEqual([336, 320, 304]);
    expect(handle.getAttribute('tabindex')).toBe('0');
  });

  it('T-MG-26: キーボードの変更でも、240〜560 px の範囲を超えない', () => {
    const s = setup();
    s.mg.renderMiniGuide(MODEL, { ...UI, width: 552 });
    const handle = q(s, '.handle');
    key(handle, 'ArrowLeft');
    key(handle, 'ArrowLeft');
    expect(width(s)).toBe(560);
    s.mg.renderMiniGuide(MODEL, { ...UI, width: 248 });
    key(handle, 'ArrowRight');
    key(handle, 'ArrowRight');
    expect(width(s)).toBe(240);
  });

  it('T-MG-28: 範囲外の width を受け取ったとき、範囲内に収めて表示する', () => {
    const s = setup();
    s.mg.renderMiniGuide(MODEL, { ...UI, width: 100 });
    expect(width(s)).toBe(240);
    s.mg.renderMiniGuide(MODEL, { ...UI, width: 900 });
    expect(width(s)).toBe(560);
  });
});

describe('ボタンの操作', () => {
  it('T-MG-29: 「戻る」で GOTO{to: 現在-1, sessionId, gen, opId} が送られる', () => {
    const s = setup();
    s.mg.renderMiniGuide(MODEL, UI);
    click(buttonByText(s, '戻る'));
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toMatchObject({ type: 'GOTO', to: 0, sessionId: sid(), gen: gen(4) });
    expect(s.sent[0]).toHaveProperty('opId');
  });

  it('T-MG-30: 「次へ」で GOTO{to: 現在+1, sessionId, gen, opId} が送られる', () => {
    const s = setup();
    s.mg.renderMiniGuide(MODEL, UI);
    click(buttonByText(s, '次へ'));
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toMatchObject({ type: 'GOTO', to: 2, sessionId: sid(), gen: gen(4) });
    expect(s.sent[0]).toHaveProperty('opId');
  });

  it('T-MG-31: 最終ステップで「完了」を押したとき、GOTO（最終の次）が送られる', () => {
    const s = setup();
    s.mg.renderMiniGuide({ ...MODEL, index: 2, isLast: true }, UI);
    click(buttonByText(s, '完了'));
    expect(s.sent[0]).toMatchObject({ type: 'GOTO', to: 3 });
  });

  it('T-MG-32: 「対象を表示」で SCROLL_TO_TARGET が送られる', () => {
    const s = setup();
    s.mg.renderMiniGuide(MODEL, UI);
    click(buttonByText(s, '対象を表示'));
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toMatchObject({ type: 'SCROLL_TO_TARGET', sessionId: sid(), gen: gen(4) });
    expect(s.sent[0]).toHaveProperty('opId');
    // 対象を持たないステップでは出さない
    s.mg.renderMiniGuide({ ...MODEL, hasTarget: false }, UI);
    expect(buttonByText(s, '対象を表示').hidden).toBe(true);
  });

  it('T-MG-33: 「表示を戻す」で SET_OVERLAY{hidden: false} が送られる', () => {
    const s = setup();
    s.mg.renderMiniGuide({ ...MODEL, overlayHidden: true }, UI);
    click(buttonByText(s, '表示を戻す'));
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toMatchObject({ type: 'SET_OVERLAY', hidden: false, sessionId: sid() });
    expect(s.sent[0]).toHaveProperty('opId');
  });

  it('T-MG-35: 「次へ」の連打で送る opId が、押すたびに別の値になる', () => {
    const s = setup();
    s.mg.renderMiniGuide(MODEL, UI);
    const next = buttonByText(s, '次へ');
    click(next);
    click(next);
    click(next);
    const ids = s.sent.flatMap((m) => (m.type === 'GOTO' ? [m.opId] : []));
    expect(new Set(ids).size).toBe(3);
  });

  it('T-MG-35: 既定の opId（crypto.randomUUID）でも別の値になる', () => {
    const sent: PageToBg[] = [];
    const mg = createMiniGuide({ doc: document, send: (m) => sent.push(m), isTrusted: () => true, attachShadow: (h) => h.attachShadow({ mode: 'open' }) });
    mg.renderMiniGuide(MODEL, UI);
    const next = Array.from(document.querySelector(`[${OWN_HOST_ATTRIBUTE}]`)?.shadowRoot?.querySelectorAll('button') ?? []).find((b) => b.textContent === '次へ');
    next?.dispatchEvent(new MouseEvent('click'));
    next?.dispatchEvent(new MouseEvent('click'));
    const ids = sent.flatMap((m) => (m.type === 'GOTO' ? [m.opId] : []));
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    mg.remove();
  });
});

describe('信頼できない操作', () => {
  it('T-MG-36: isTrusted が偽のクリックでは、どのボタンもメッセージを送らない', () => {
    const s = setup(false);
    s.mg.renderMiniGuide({ ...MODEL, overlayHidden: true }, UI);
    for (const l of ['戻る', '次へ', '対象を表示', '表示を戻す', '最小化', 'ホバー']) click(buttonByText(s, l));
    expect(s.sent).toHaveLength(0);
  });

  it('T-MG-37: isTrusted が偽のキー操作・ポインター操作では、バーも幅のつまみも反応しない', () => {
    const s = setup(false);
    s.mg.renderMiniGuide(MODEL, UI);
    const handle = q(s, '.handle');
    key(handle, 'ArrowLeft');
    ptr(handle, 'pointerdown', 700);
    ptr(handle, 'pointermove', 600);
    ptr(handle, 'pointerup', 600);
    expect(width(s)).toBe(320);
    s.mg.renderMiniGuide(MODEL, { ...UI, mode: 'minimized' });
    click(q(s, '.bar'));
    key(q(s, '.bar'), 'Enter');
    expect(maybe(s, '.body')).toBeNull();
    expect(s.sent).toHaveLength(0);
  });

  it('T-MG-38: isTrusted が偽の pointerenter では、ホバーで展開しない', () => {
    const s = setup(false);
    s.mg.renderMiniGuide(MODEL, { ...UI, mode: 'hover' });
    ptr(q(s, '.panel'), 'pointerenter');
    q(s, '.panel').dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(maybe(s, '.body')).toBeNull();
  });
});

describe('キーボードの操作とフォーカス', () => {
  function pageButton(): HTMLButtonElement {
    const b = document.createElement('button');
    document.body.appendChild(b);
    return b;
  }
  const focused = (s: Setup): Element | null => root(s).activeElement;

  it('R-C2: ホバーのバーにフォーカスして展開しても、フォーカスは展開後のミニガイドの中に残り、300 ミリ秒後にも閉じない', () => {
    const s = setup();
    s.mg.renderMiniGuide(MODEL, HOVER);
    q(s, '.bar').focus();
    expect(maybe(s, '.body')).not.toBeNull();
    expect(focused(s)).not.toBeNull();
    expect(q(s, '.panel').contains(focused(s))).toBe(true);
    vi.advanceTimersByTime(HOVER_CLOSE_MS * 5);
    expect(maybe(s, '.body')).not.toBeNull();
    expect(q(s, '.panel').contains(focused(s))).toBe(true);
  });

  it('R-C2: 展開で外れたバーの focusout（relatedTarget なし）が来ても、続く focusin で閉じない', () => {
    const s = setup();
    s.mg.renderMiniGuide(MODEL, HOVER);
    const bar = q(s, '.bar');
    bar.focus();
    bar.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    vi.advanceTimersByTime(HOVER_CLOSE_MS * 5);
    expect(maybe(s, '.body')).not.toBeNull();
  });

  it('R-C2: フォーカスがミニガイドの中の別の部品へ移っても閉じず、外へ出たときだけ300ミリ秒後に閉じる', () => {
    const s = setup();
    s.mg.renderMiniGuide(MODEL, HOVER);
    q(s, '.bar').focus();
    const next = buttonByText(s, '次へ');
    const panel = q(s, '.panel');
    next.focus();
    panel.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: next }));
    vi.advanceTimersByTime(HOVER_CLOSE_MS * 5);
    expect(maybe(s, '.body')).not.toBeNull();
    panel.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: pageButton() }));
    vi.advanceTimersByTime(HOVER_CLOSE_MS - 1);
    expect(maybe(s, '.body')).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(maybe(s, '.body')).toBeNull();
  });

  it('R-C2: Tab の間が300ミリ秒より空いても、展開後の「次へ」まで届く（部品がすべて残っている）', () => {
    const s = setup();
    s.mg.renderMiniGuide(MODEL, HOVER);
    q(s, '.bar').focus();
    vi.advanceTimersByTime(HOVER_CLOSE_MS * 3);
    const order = Array.from(root(s).querySelectorAll<HTMLElement>('button, [tabindex="0"]'));
    expect(order).toContain(buttonByText(s, '次へ'));
    expect(maybe(s, '.body')).not.toBeNull();
  });

  it('R-C2: 最小化のバーで Enter を押して展開したとき、フォーカスは展開後のミニガイドの中へ移る', () => {
    const s = setup();
    s.mg.renderMiniGuide(MODEL, MIN);
    q(s, '.bar').focus();
    key(q(s, '.bar'), 'Enter');
    expect(maybe(s, '.body')).not.toBeNull();
    expect(q(s, '.panel').contains(focused(s))).toBe(true);
  });

  it('R-C2: ホバーのバーで Enter を押して一時的に展開したときも、フォーカスは中へ移る', () => {
    const s = setup();
    s.mg.renderMiniGuide(MODEL, HOVER);
    const bar = q(s, '.bar');
    bar.focus();
    key(bar, 'Enter');
    expect(q(s, '.panel').contains(focused(s))).toBe(true);
    vi.advanceTimersByTime(HOVER_CLOSE_MS * 5);
    expect(maybe(s, '.body')).not.toBeNull();
  });
});

describe('描き直しと領域の通知', () => {
  it('R-C6: 同じ内容で再度呼んでも、DOM を作り直さない', () => {
    const s = setup();
    s.mg.renderMiniGuide(MODEL, UI);
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((r) => records.push(...r));
    observer.observe(root(s), { subtree: true, childList: true, characterData: true, attributes: true });
    s.mg.renderMiniGuide({ ...MODEL }, { ...UI });
    records.push(...observer.takeRecords());
    observer.disconnect();
    expect(records).toHaveLength(0);
  });

  it('R-C6: 内容が変わったときは描き直す', () => {
    const s = setup();
    s.mg.renderMiniGuide(MODEL, UI);
    s.mg.renderMiniGuide({ ...MODEL, title: '別の見出し' }, UI);
    expect(q(s, '.title').textContent).toBe('別の見出し');
    s.mg.renderMiniGuide({ ...MODEL, title: '別の見出し' }, { ...UI, width: 400 });
    expect(width(s)).toBe(400);
  });

  it('R-C3: 領域が変わると、通知される（ホバーの展開・閉じる・モードの切り替え・ドラッグ・取り除き）', () => {
    const s = setup();
    const onChange = vi.fn();
    s.mg.onRectChange(onChange);
    s.mg.renderMiniGuide(MODEL, HOVER);
    onChange.mockClear();

    ptr(q(s, '.panel'), 'pointerenter');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(s.mg.getRect()?.left).toBe(1000 - 320);

    ptr(q(s, '.panel'), 'pointerleave');
    vi.advanceTimersByTime(HOVER_CLOSE_MS);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(s.mg.getRect()?.left).toBe(1000 - 28);

    onChange.mockClear();
    s.mg.renderMiniGuide(MODEL, UI);
    expect(onChange).toHaveBeenCalledTimes(1);
    onChange.mockClear();
    click(buttonByText(s, '最小化'));
    expect(onChange).toHaveBeenCalledTimes(1);

    click(q(s, '.bar'));
    onChange.mockClear();
    const handle = q(s, '.handle');
    ptr(handle, 'pointerdown', 700);
    ptr(handle, 'pointermove', 680);
    expect(onChange).toHaveBeenCalledTimes(1);

    onChange.mockClear();
    s.mg.remove();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('R-C3: 領域が変わらない描き直しでは通知しない', () => {
    const s = setup();
    const onChange = vi.fn();
    s.mg.onRectChange(onChange);
    s.mg.renderMiniGuide(MODEL, UI);
    onChange.mockClear();
    s.mg.renderMiniGuide({ ...MODEL, title: 'x' }, UI);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('R-C3: 通知の購読を解除できる', () => {
    const s = setup();
    const onChange = vi.fn();
    const stop = s.mg.onRectChange(onChange);
    stop();
    s.mg.renderMiniGuide(MODEL, UI);
    expect(onChange).not.toHaveBeenCalled();
  });
});
