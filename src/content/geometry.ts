/**
 * 表示の配置に使う矩形の部品。ビューポート座標（左上が原点）の left・top・right・bottom で表す。
 */

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Size {
  width: number;
  height: number;
}

export function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 矩形を `area` の内側に収める。大きさは 0 未満にならない。 */
export function clampRect(rect: Rect, area: Rect): Rect {
  const left = clamp(rect.left, area.left, area.right);
  const top = clamp(rect.top, area.top, area.bottom);
  return {
    left,
    top,
    right: Math.max(left, clamp(rect.right, area.left, area.right)),
    bottom: Math.max(top, clamp(rect.bottom, area.top, area.bottom)),
  };
}

export function rectKey(rect: Rect): string {
  return [rect.left, rect.top, rect.right, rect.bottom].map(String).join(',');
}

/** CSS の長さ（px）の文字列。 */
export function px(value: number): string {
  return `${String(value)}px`;
}
