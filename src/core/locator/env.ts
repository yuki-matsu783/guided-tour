/**
 * 実ブラウザ向けの `LocatorEnv`。
 * 読み上げ名と役割は dom-accessibility-api、表示の判定は `getClientRects()` と `checkVisibility` で行う。
 * 名前の文字列は env の外へ出さない（呼ぶ側は照合の結果だけを受け取る）。
 */
import { computeAccessibleName, getRole } from 'dom-accessibility-api';
import type { LocatorEnv } from './types';

/** 自前の表示のホスト要素を見分ける属性。 */
export const OWN_HOST_ATTRIBUTE = 'data-guided-tour-host';

/** `checkVisibility` に渡す指定。Chrome 114 の名前と新しい名前の両方を渡す。 */
const CHECK_VISIBILITY_OPTIONS = {
  checkOpacity: true,
  checkVisibilityCSS: true,
  opacityProperty: true,
  visibilityProperty: true,
};

/** `checkVisibility` が無い環境向け。要素自身と祖先の display・visibility・opacity を見る。 */
function isRenderedByStyle(el: Element, win: Window): boolean {
  const own = win.getComputedStyle(el);
  if (own.visibility === 'hidden' || own.visibility === 'collapse') return false;
  for (let node: Element | null = el; node; node = node.parentElement) {
    const style = win.getComputedStyle(node);
    if (style.display === 'none') return false;
    if (Number.parseFloat(style.opacity) === 0) return false;
  }
  return true;
}

export function defaultEnv(win: Window): LocatorEnv {
  return {
    isVisible(el) {
      // 祖先の矩形は求めない（display: contents の祖先を許す）
      const hasSize = Array.from(el.getClientRects()).some((r) => r.width > 0 && r.height > 0);
      if (!hasSize) return false;
      if (typeof el.checkVisibility === 'function') {
        return el.checkVisibility(CHECK_VISIBILITY_OPTIONS);
      }
      return isRenderedByStyle(el, win);
    },
    computeRole: (el) => getRole(el),
    computeName: (el) => computeAccessibleName(el, {
        getComputedStyle: win.getComputedStyle.bind(win),
        computedStyleSupportsPseudoElements: true,
      }),
    viewport() {
      const root = win.document.documentElement;
      return {
        width: root.clientWidth > 0 ? root.clientWidth : win.innerWidth,
        height: root.clientHeight > 0 ? root.clientHeight : win.innerHeight,
      };
    },
    isOwnHost: (el) => el.hasAttribute(OWN_HOST_ATTRIBUTE),
  };
}
