/**
 * ミニガイド。ページの右端に固定する小さな案内領域で、閉じた Shadow DOM の中に描く。
 * 表示状態は展開・最小化（幅28 px のバー）・ホバー（普段はバー、乗せている間だけ展開）。
 * 操作（ボタン・バー・幅のつまみ・ホバー）は、利用者の実際の操作（isTrusted）だけを受け付ける。
 * 見出し・tip は textContent（tip は強調とコードだけを許す小さな描画）で入れ、HTML としては解釈しない。
 */
import { renderInline } from '../../core/markdown/inline.ts';
import {
  newOpId as defaultNewOpId,
  type Gen,
  type OpId,
  type SessionId,
} from '../../shared/ids/index.ts';
import {
  UI_WIDTH_MAX,
  UI_WIDTH_MIN,
  type PageToBg,
  type UiMode,
  type UiSettings,
} from '../../shared/messages/index.ts';
import { clamp, px, type Rect, type Size } from '../geometry.ts';
import { attachClosed, createOwnHost, type AttachShadow, type OwnHost } from '../host.ts';
import type { HintKind } from '../hint-text.ts';
import { defaultTimers, type TimerHandle } from '../timers.ts';
import { defaultTrust, type TrustCheck } from '../trust.ts';
import { MINIGUIDE_CSS } from './styles.ts';

/** 最小化したバーの幅（px）。 */
export const BAR_WIDTH = 28;
/** キーボードで幅を変える量（px）。 */
export const KEY_STEP = 16;
/** ホバーで展開した後、バーに戻るまでの待ち（ミリ秒）。 */
export const HOVER_CLOSE_MS = 300;

export interface MiniGuideModel {
  sessionId: SessionId;
  gen: Gen;
  /** 0 始まりのステップ番号。 */
  index: number;
  total: number;
  title: string;
  tip?: string | undefined;
  hintKind: HintKind;
  hintText: string | null;
  /** 文章だけの案内の文。無ければ null。 */
  fallbackText: string | null;
  isLast: boolean;
  /** ページ上の表示（ハイライト・吹き出し）が消えているか。 */
  overlayHidden: boolean;
  /** 「対象を表示」を出すか（対象を持つステップか）。 */
  hasTarget: boolean;
  /** サイドパネルを開くショートカットキーの表示。未割り当てなら null。 */
  shortcut: string | null;
}

export interface MiniGuideDeps {
  doc: Document;
  send: (message: PageToBg) => void;
  newOpId?: () => OpId;
  isTrusted?: TrustCheck;
  attachShadow?: AttachShadow;
  viewport?: () => Size;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (id: TimerHandle) => void;
}

export interface MiniGuide {
  /** `model` が null（描画指示がまだ無い）か `ui.enabled` が偽なら、取り除く。 */
  renderMiniGuide(model: MiniGuideModel | null, ui: UiSettings): void;
  /** 今のミニガイドが占める領域。描かれていなければ null。 */
  getRect(): Rect | null;
  remove(): void;
}

export function clampWidth(width: number): number {
  return clamp(width, UI_WIDTH_MIN, UI_WIDTH_MAX);
}

interface View {
  ui: OwnHost;
  panel: HTMLElement;
  handle: HTMLElement;
  body: HTMLElement;
  bar: HTMLButtonElement;
  barNumber: HTMLElement;
  barMark: HTMLElement;
  step: HTMLElement;
  title: HTMLElement;
  tip: HTMLElement;
  hint: HTMLElement;
  fallback: HTMLElement;
  shortcut: HTMLElement;
  modeButtons: Record<UiMode, HTMLButtonElement>;
  back: HTMLButtonElement;
  next: HTMLButtonElement;
  reveal: HTMLButtonElement;
  restore: HTMLButtonElement;
}

const MODE_LABELS: Record<UiMode, string> = {
  expanded: '展開',
  hover: 'ホバー',
  minimized: '最小化',
};
const MODES: readonly UiMode[] = ['expanded', 'hover', 'minimized'];

export function createMiniGuide(deps: MiniGuideDeps): MiniGuide {
  const { doc } = deps;
  const attach = deps.attachShadow ?? attachClosed;
  const trusted = deps.isTrusted ?? defaultTrust;
  const newOpId = deps.newOpId ?? defaultNewOpId;
  const viewport =
    deps.viewport ??
    ((): Size => ({
      width: doc.documentElement.clientWidth,
      height: doc.documentElement.clientHeight,
    }));
  const setTimer = deps.setTimer ?? defaultTimers.setTimer;
  const clearTimer = deps.clearTimer ?? defaultTimers.clearTimer;

  let view: View | null = null;
  let model: MiniGuideModel | null = null;
  /** 最後に受け取った設定。変わったときだけ、手元の表示状態を置き換える。 */
  let lastUi: UiSettings | null = null;
  let mode: UiMode = 'expanded';
  let width = UI_WIDTH_MIN;
  let hoverOpen = false;
  let closeTimer: TimerHandle | null = null;
  let drag: { startX: number; startWidth: number } | null = null;

  function sendUi(): void {
    deps.send({ type: 'SET_UI', mode, width });
  }

  function sendOp(kind: 'GOTO' | 'SCROLL_TO_TARGET' | 'SET_OVERLAY', to?: number): void {
    if (model === null) return;
    const { sessionId, gen } = model;
    const opId = newOpId();
    if (kind === 'GOTO') deps.send({ type: 'GOTO', to: to ?? 0, sessionId, gen, opId });
    else if (kind === 'SCROLL_TO_TARGET') deps.send({ type: 'SCROLL_TO_TARGET', sessionId, gen, opId });
    else deps.send({ type: 'SET_OVERLAY', hidden: false, sessionId, opId });
  }

  function isExpanded(): boolean {
    return mode === 'expanded' || (mode === 'hover' && hoverOpen);
  }

  function currentWidth(): number {
    return isExpanded() ? width : BAR_WIDTH;
  }

  function cancelClose(): void {
    if (closeTimer !== null) clearTimer(closeTimer);
    closeTimer = null;
  }

  function setMode(next: UiMode): void {
    mode = next;
    hoverOpen = false;
    cancelClose();
    sendUi();
    update();
  }

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
    const e = doc.createElement(tag);
    e.className = className;
    return e;
  }

  function button(label: string, onPress: () => void, className = ''): HTMLButtonElement {
    const b = el('button', className);
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', (event) => {
      if (!trusted(event)) return;
      onPress();
    });
    return b;
  }

  function build(): View {
    const ui = createOwnHost(doc, attach, MINIGUIDE_CSS);
    const panel = el('div', 'panel');
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'ガイドツアー');

    const handle = el('div', 'handle');
    handle.tabIndex = 0;
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', 'ミニガイドの幅');
    handle.setAttribute('aria-valuemin', String(UI_WIDTH_MIN));
    handle.setAttribute('aria-valuemax', String(UI_WIDTH_MAX));

    const body = el('div', 'body');
    const head = el('div', 'head');
    const step = el('span', 'step');
    const modes = el('div', 'modes');
    const modeButtons: Record<UiMode, HTMLButtonElement> = {
      expanded: button(MODE_LABELS.expanded, () => { setMode('expanded'); }),
      hover: button(MODE_LABELS.hover, () => { setMode('hover'); }),
      minimized: button(MODE_LABELS.minimized, () => { setMode('minimized'); }),
    };
    for (const m of MODES) modes.appendChild(modeButtons[m]);
    head.append(step, modes);

    const title = el('div', 'title');
    const tip = el('div', 'tip');
    const hint = el('div', 'hint');
    const fallback = el('div', 'fallback');
    const back = button('戻る', () => { if (model) sendOp('GOTO', model.index - 1); });
    const next = button('次へ', () => { if (model) sendOp('GOTO', model.index + 1); });
    const reveal = button('対象を表示', () => { sendOp('SCROLL_TO_TARGET'); });
    const restore = button('表示を戻す', () => { sendOp('SET_OVERLAY'); });
    const actions = el('div', 'actions');
    actions.append(back, next, reveal, restore);
    const shortcut = el('div', 'shortcut');
    body.append(head, title, tip, hint, fallback, actions, shortcut);

    const bar = el('button', 'bar');
    bar.type = 'button';
    const barNumber = el('span', 'n');
    const barMark = el('span', 'mark');
    bar.append(barNumber, barMark);
    bar.addEventListener('click', (event) => {
      if (!trusted(event)) return;
      onBar();
    });
    bar.addEventListener('keydown', (event) => {
      if (!trusted(event) || event.key !== 'Enter') return;
      // 既定のクリックと二重にならないよう、Enter はここで処理する
      event.preventDefault();
      onBar();
    });

    ui.root.appendChild(panel);
    attachHandle(handle);
    attachHover(panel);
    return {
      ui, panel, handle, body, bar, barNumber, barMark, step, title, tip, hint, fallback,
      shortcut, modeButtons, back, next, reveal, restore,
    };
  }

  function onBar(): void {
    if (mode === 'minimized') {
      setMode('expanded');
    } else if (mode === 'hover') {
      // 一時的な展開。設定は変えない
      hoverOpen = true;
      cancelClose();
      update();
    }
  }

  function attachHover(panel: HTMLElement): void {
    const open = (event: Event): void => {
      if (!trusted(event) || mode !== 'hover') return;
      cancelClose();
      if (!hoverOpen) {
        hoverOpen = true;
        update();
      }
    };
    const leave = (event: Event): void => {
      if (!trusted(event) || mode !== 'hover' || !hoverOpen) return;
      cancelClose();
      closeTimer = setTimer(() => {
        closeTimer = null;
        hoverOpen = false;
        update();
      }, HOVER_CLOSE_MS);
    };
    panel.addEventListener('pointerenter', open);
    panel.addEventListener('focusin', open);
    panel.addEventListener('pointerleave', leave);
    panel.addEventListener('focusout', (event) => {
      // 中の別の要素へ移っただけなら閉じない
      if (event instanceof FocusEvent && event.relatedTarget instanceof Node && panel.contains(event.relatedTarget)) return;
      leave(event);
    });
  }

  function attachHandle(handle: HTMLElement): void {
    handle.addEventListener('pointerdown', (event) => {
      if (!trusted(event) || !(event instanceof MouseEvent)) return;
      drag = { startX: event.clientX, startWidth: width };
      try {
        if ('pointerId' in event && typeof event.pointerId === 'number') {
          handle.setPointerCapture(event.pointerId);
        }
      } catch {
        // 捕捉できなくても、ハンドルの上の動きは追える
      }
      event.preventDefault();
    });
    handle.addEventListener('pointermove', (event) => {
      if (!trusted(event) || !(event instanceof MouseEvent) || drag === null) return;
      // 左へ動かすと広がる
      width = clampWidth(drag.startWidth + (drag.startX - event.clientX));
      update();
    });
    const finish = (event: Event): void => {
      if (!trusted(event) || drag === null) return;
      drag = null;
      sendUi();
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    handle.addEventListener('keydown', (event) => {
      if (!trusted(event)) return;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      width = clampWidth(width + (event.key === 'ArrowLeft' ? KEY_STEP : -KEY_STEP));
      sendUi();
      update();
    });
  }

  function setText(target: HTMLElement, text: string | null): void {
    target.textContent = text ?? '';
    target.hidden = text === null || text === '';
  }

  function update(): void {
    if (view === null || model === null) return;
    const v = view;
    const m = model;
    const expanded = isExpanded();
    const w = currentWidth();
    v.panel.style.width = px(w);
    v.panel.dataset.state = expanded ? 'expanded' : 'bar';
    v.panel.dataset.mode = mode;
    v.panel.dataset.width = String(w);

    const children = expanded ? [v.handle, v.body] : [v.bar];
    const keep = new Set<Node>(children);
    for (const child of Array.from(v.panel.children)) if (!keep.has(child)) child.remove();
    for (const child of children) if (child.parentNode !== v.panel) v.panel.appendChild(child);

    const stepLabel = `${String(m.index + 1)}/${String(m.total)}`;
    v.step.textContent = stepLabel;
    v.barNumber.textContent = stepLabel;
    v.barMark.textContent = m.hintKind === 'met' ? '✓' : m.hintKind === 'unsupported' ? '?' : m.hintKind === 'stopped' ? '…' : '';
    v.barMark.dataset.kind = m.hintKind;
    v.bar.setAttribute('aria-label', `ガイドを開く ${stepLabel}${m.hintText === null ? '' : ` ${m.hintText}`}`);

    v.title.textContent = m.title;
    if (m.tip === undefined || m.tip === '') {
      v.tip.replaceChildren();
      v.tip.hidden = true;
    } else {
      renderInline(m.tip, v.tip);
      v.tip.hidden = false;
    }
    setText(v.hint, m.hintText);
    v.hint.dataset.kind = m.hintKind;
    setText(v.fallback, m.fallbackText);
    setText(
      v.shortcut,
      m.shortcut === null
        ? 'サイドパネルを開くショートカットキーは割り当てられていません（Chrome の拡張機能のショートカット設定で割り当てられます）'
        : `サイドパネルを開くショートカットキー: ${m.shortcut}`,
    );

    for (const key of MODES) v.modeButtons[key].setAttribute('aria-pressed', String(mode === key));
    v.handle.setAttribute('aria-valuenow', String(width));
    v.back.disabled = m.index <= 0;
    v.next.textContent = m.isLast ? '完了' : '次へ';
    v.reveal.hidden = !m.hasTarget;
    v.restore.hidden = !m.overlayHidden;
  }

  function remove(): void {
    cancelClose();
    view?.ui.remove();
    view = null;
    model = null;
    lastUi = null;
    hoverOpen = false;
    drag = null;
  }

  return {
    renderMiniGuide(next, ui) {
      if (next === null || !ui.enabled) {
        remove();
        return;
      }
      if (lastUi?.mode !== ui.mode || lastUi.width !== ui.width) {
        mode = ui.mode;
        width = clampWidth(ui.width);
        hoverOpen = false;
        cancelClose();
      }
      lastUi = ui;
      model = next;
      view ??= build();
      update();
    },
    getRect() {
      if (view === null) return null;
      const vp = viewport();
      return { left: vp.width - currentWidth(), top: 0, right: vp.width, bottom: vp.height };
    },
    remove,
  };
}
