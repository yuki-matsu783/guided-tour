/**
 * ページ側の単体テストで共有する部品（試験専用。本番の入口からは読まない）。
 * jsdom 向けの env、矩形の差し替え、検証済みの識別子、描画指示の雛形を提供する。
 */
import { computeAccessibleName } from 'dom-accessibility-api';
import { defaultEnv, type LocatorEnv, type LocateResult } from '../core/locator/index.ts';
import { GenSchema, OpIdSchema, PageSeqSchema, RevSchema, SessionIdSchema } from '../shared/ids/index.ts';
import type { Hint, PageStep, Render, UiSettings } from '../shared/messages/index.ts';
import type { Rect } from './geometry.ts';

/** jsdom 向けの env。要素自身か祖先に data-hidden があれば非表示。viewport は 1000x800。 */
export function makeEnv(over: Partial<LocatorEnv> = {}): LocatorEnv {
  return {
    ...defaultEnv(window),
    computeName: (el) => computeAccessibleName(el, { computedStyleSupportsPseudoElements: false }),
    isVisible: (el) => el.closest('[data-hidden]') === null,
    viewport: () => ({ width: 1000, height: 800 }),
    ...over,
  };
}

export function setRect(el: Element, r: Rect): void {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ ...r, width: r.right - r.left, height: r.bottom - r.top, x: r.left, y: r.top }),
  });
}

export const sid = (n = 1) => SessionIdSchema.parse(`session-${String(n)}`);
export const gen = (n = 1) => GenSchema.parse(n);
export const pageSeq = (n = 1) => PageSeqSchema.parse(n);
export const rev = (n = 1) => RevSchema.parse(n);
let opCounter = 0;
export const nextOpId = () => OpIdSchema.parse(`op-${String((opCounter += 1))}`);

export const UI: UiSettings = { enabled: true, mode: 'expanded', width: 320 };
export const HINT: Hint = { met: false, unsupported: false, stopped: false };

export const STEP: PageStep = { id: 's1', title: '見出し', target: { css: ['#target'] } };

export function makeRender(over: Partial<Render> = {}): Render {
  return {
    type: 'RENDER',
    sessionId: sid(),
    gen: gen(),
    pageSeq: pageSeq(),
    rev: rev(),
    step: STEP,
    index: 1,
    total: 3,
    overlay: { hidden: false },
    ui: UI,
    selected: true,
    attended: true,
    donePage: false,
    hint: HINT,
    shortcut: null,
    fallbackText: null,
    isLast: false,
    ...over,
  };
}

/** `locate` の結果の雛形。 */
export function found(el: Element, over: Partial<LocateResult> = {}): LocateResult {
  return {
    found: true,
    tier: 5,
    topTier: 5,
    reasons: [],
    counts: [],
    target: el,
    highlightEl: el,
    ...over,
  };
}

export const NOT_FOUND: LocateResult = {
  found: false,
  tier: null,
  topTier: 5,
  reasons: ['missing'],
  counts: [],
  target: null,
  highlightEl: null,
};
