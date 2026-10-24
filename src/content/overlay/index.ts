/**
 * ハイライト・吹き出し・表示を戻すボタン。閉じた Shadow DOM の中に描く。
 * ハイライトは枠と4枚の減衰板で、どれもポインター操作を通す（pointer-events: none）。
 * 吹き出しの文字は textContent（tip だけは強調とコードを許す小さな描画）で入れ、HTML としては解釈しない。
 * 利用者の実際の操作（isTrusted）だけがメッセージを送る。
 */
import { renderInline } from '../../core/markdown/inline.ts';
import { newOpId as defaultNewOpId, type OpId, type SessionId } from '../../shared/ids/index.ts';
import type { PageToBg } from '../../shared/messages/index.ts';
import { clamp, clampRect, px, rectOf, type Rect, type Size } from '../geometry.ts';
import { attachClosed, createOwnHost, type AttachShadow, type OwnHost } from '../host.ts';
import { defaultTrust, type TrustCheck } from '../trust.ts';
import { OVERLAY_CSS } from './styles.ts';

/** 吹き出しの幅（px）。スタイルと同じ値。 */
export const BUBBLE_WIDTH = 280;
/** 吹き出しと対象の間（px）。 */
const GAP = 8;
/** 枠を対象より外へ広げる量（px）。 */
const FRAME_PADDING = 4;

export type BubblePlacement = 'below' | 'above' | 'left' | 'fallback';

export interface OverlayStep {
  title: string;
  tip?: string | undefined;
}

export interface OverlayState {
  /** ページ上の表示を消しているか。 */
  hidden: boolean;
  /** ミニガイドを使う設定か。使わないときだけ、表示を戻すボタンを出す。 */
  miniGuideEnabled: boolean;
}

export interface OverlayDeps {
  doc: Document;
  send: (message: PageToBg) => void;
  getSessionId: () => SessionId | null;
  newOpId?: () => OpId;
  isTrusted?: TrustCheck;
  attachShadow?: AttachShadow;
  viewport?: () => Size;
  measureBubble?: (el: HTMLElement) => Size;
}

export interface Overlay {
  /**
   * `hint` は目安の状態の文言（無ければ null）。`miniGuideRect` はミニガイドの領域（無ければ null）。
   * 同じ内容で何度呼んでもよい（要素は作り直さず、位置と文言だけを更新する）。
   */
  paint(
    highlightEl: Element,
    step: OverlayStep,
    overlay: OverlayState,
    hint: string | null,
    miniGuideRect: Rect | null,
  ): void;
  /**
   * 表示を戻すボタンだけを出す（枠・減衰板・吹き出しは出さない）。対象を特定できていないときのために使う。
   * 同じ内容で何度呼んでもよい。
   */
  showRestore(): void;
  clear(): void;
}

interface Shown {
  title: string;
  tip: string | undefined;
  hint: string | null;
}

interface Parts {
  ui: OwnHost;
  plates: HTMLElement[];
  frame: HTMLElement;
  bubble: HTMLElement;
  title: HTMLElement;
  tip: HTMLElement;
  hint: HTMLElement;
  restore: HTMLButtonElement;
}

/** 吹き出しを置く位置。下、上、左の順に収まる所を選び、どこにも収まらなければ下に寄せる。 */
export function placeBubble(
  target: Rect,
  area: Rect,
  size: Size,
): { left: number; top: number; placement: BubblePlacement } {
  const maxLeft = Math.max(area.left, area.right - size.width);
  const maxTop = Math.max(area.top, area.bottom - size.height);
  const x = clamp(target.left, area.left, maxLeft);

  const belowTop = target.bottom + GAP;
  if (belowTop + size.height <= area.bottom) return { left: x, top: belowTop, placement: 'below' };

  const aboveTop = target.top - GAP - size.height;
  if (aboveTop >= area.top) return { left: x, top: aboveTop, placement: 'above' };

  const leftLeft = target.left - GAP - size.width;
  if (leftLeft >= area.left) {
    return { left: leftLeft, top: clamp(target.top, area.top, maxTop), placement: 'left' };
  }
  return { left: x, top: clamp(belowTop, area.top, maxTop), placement: 'fallback' };
}

function setBox(el: HTMLElement, rect: Rect): void {
  el.style.left = px(rect.left);
  el.style.top = px(rect.top);
  el.style.width = px(rect.right - rect.left);
  el.style.height = px(rect.bottom - rect.top);
}

/** 対象の周囲を覆う4枚（上・下・左・右）。対象の矩形の上は覆わない。 */
function platesAround(target: Rect, area: Rect): Rect[] {
  return [
    { left: area.left, top: area.top, right: area.right, bottom: target.top },
    { left: area.left, top: target.bottom, right: area.right, bottom: area.bottom },
    { left: area.left, top: target.top, right: target.left, bottom: target.bottom },
    { left: target.right, top: target.top, right: area.right, bottom: target.bottom },
  ];
}

export function createOverlay(deps: OverlayDeps): Overlay {
  const { doc } = deps;
  const attach = deps.attachShadow ?? attachClosed;
  const trusted = deps.isTrusted ?? defaultTrust;
  const newOpId = deps.newOpId ?? defaultNewOpId;
  const viewport = deps.viewport ?? ((): Size => ({ width: doc.documentElement.clientWidth, height: doc.documentElement.clientHeight }));
  const measureBubble =
    deps.measureBubble ??
    ((el: HTMLElement): Size => {
      const r = el.getBoundingClientRect();
      return { width: r.width > 0 ? r.width : BUBBLE_WIDTH, height: r.height };
    });

  let parts: Parts | null = null;
  let shown: Shown = { title: '', tip: undefined, hint: null };

  function sendOverlay(hidden: boolean): void {
    const sessionId = deps.getSessionId();
    if (sessionId === null) return;
    deps.send({ type: 'SET_OVERLAY', hidden, sessionId, opId: newOpId() });
  }

  function button(className: string, label: string, hidden: boolean, ariaLabel?: string): HTMLButtonElement {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = label;
    if (ariaLabel !== undefined) b.setAttribute('aria-label', ariaLabel);
    b.addEventListener('click', (event) => {
      if (!trusted(event)) return;
      sendOverlay(hidden);
    });
    return b;
  }

  function div(className: string): HTMLElement {
    const el = doc.createElement('div');
    el.className = className;
    return el;
  }

  function ensureParts(): Parts {
    if (parts) return parts;
    const ui = createOwnHost(doc, attach, OVERLAY_CSS, 'back');
    const bubble = div('bubble');
    const title = div('title');
    const tip = div('tip');
    const hint = div('hint');
    tip.hidden = true;
    hint.hidden = true;
    bubble.append(title, tip, hint, button('close', '×', true, '吹き出しを閉じる'));
    parts = {
      ui,
      plates: [div('dim'), div('dim'), div('dim'), div('dim')],
      frame: div('frame'),
      bubble,
      title,
      tip,
      hint,
      restore: button('restore', '表示を戻す', false),
    };
    shown = { title: '', tip: undefined, hint: null };
    return parts;
  }

  function attached(p: Parts, ...els: HTMLElement[]): void {
    for (const el of els) if (el.parentNode !== p.ui.root) p.ui.root.appendChild(el);
  }

  function detach(...els: HTMLElement[]): void {
    for (const el of els) el.remove();
  }

  function updateText(p: Parts, step: OverlayStep, hint: string | null): void {
    if (shown.title !== step.title) p.title.textContent = step.title;
    if (shown.tip !== step.tip) {
      if (step.tip === undefined || step.tip === '') p.tip.replaceChildren();
      else renderInline(step.tip, p.tip);
      p.tip.hidden = step.tip === undefined || step.tip === '';
    }
    if (shown.hint !== hint) {
      p.hint.textContent = hint ?? '';
      p.hint.hidden = hint === null;
    }
    shown = { title: step.title, tip: step.tip, hint };
  }

  return {
    paint(highlightEl, step, overlay, hint, miniGuideRect) {
      const p = ensureParts();
      if (overlay.hidden) {
        detach(...p.plates, p.frame, p.bubble);
        if (overlay.miniGuideEnabled) detach(p.restore);
        else attached(p, p.restore);
        return;
      }
      detach(p.restore);

      const vp = viewport();
      const area: Rect = {
        left: 0,
        top: 0,
        right: Math.min(vp.width, miniGuideRect?.left ?? vp.width),
        bottom: vp.height,
      };
      const raw = rectOf(highlightEl);
      const padded: Rect = {
        left: raw.left - FRAME_PADDING,
        top: raw.top - FRAME_PADDING,
        right: raw.right + FRAME_PADDING,
        bottom: raw.bottom + FRAME_PADDING,
      };
      const target = clampRect(padded, area);

      platesAround(target, area).forEach((rect, i) => {
        const plate = p.plates[i];
        if (plate) setBox(plate, rect);
      });
      setBox(p.frame, target);

      updateText(p, step, hint);
      p.bubble.style.left = '0px';
      p.bubble.style.top = '0px';
      attached(p, ...p.plates, p.frame, p.bubble);
      const placed = placeBubble(target, area, measureBubble(p.bubble));
      p.bubble.style.left = px(placed.left);
      p.bubble.style.top = px(placed.top);
      p.bubble.dataset.placement = placed.placement;
    },
    showRestore() {
      const p = ensureParts();
      detach(...p.plates, p.frame, p.bubble);
      attached(p, p.restore);
    },
    clear() {
      parts?.ui.remove();
      parts = null;
    },
  };
}
