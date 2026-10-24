/**
 * ページの変化の検知（MutationObserver）。
 * childList・subtree・characterData と、目安や特定に関わる属性だけを見る。
 * 自分の表示のホスト要素とその中の変化は変化として数えない。
 */
import type { LocatorEnv } from '../../core/locator/index.ts';

/** 変化として見る属性。 */
export const OBSERVED_ATTRIBUTES: readonly string[] = [
  'id',
  'class',
  'style',
  'hidden',
  'role',
  'type',
  'disabled',
  'data-testid',
  'data-tour-id',
  'aria-label',
  'aria-labelledby',
  'aria-hidden',
  'aria-checked',
  'aria-expanded',
  'aria-selected',
  'aria-pressed',
];

export interface ObserverLike {
  observe(root: Node): void;
  disconnect(): void;
}

/** 変化の記録を受け取る関数を渡して、観測器を作る。 */
export type CreateObserver = (onRecords: (records: readonly MutationRecord[]) => void) => ObserverLike;

export function createDomObserver(
  ctor: typeof MutationObserver = MutationObserver,
): CreateObserver {
  return (onRecords) => {
    const observer = new ctor((records) => {
      onRecords(records);
    });
    return {
      observe(root) {
        observer.observe(root, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: [...OBSERVED_ATTRIBUTES],
        });
      },
      disconnect() {
        observer.disconnect();
      },
    };
  };
}

function insideOwnHost(node: Node, env: LocatorEnv): boolean {
  for (let n: Node | null = node; n; n = n.parentNode) {
    if (n instanceof Element && env.isOwnHost(n)) return true;
  }
  return false;
}

/** 自分の表示以外の変化を含むか。 */
export function hasForeignChange(records: readonly MutationRecord[], env: LocatorEnv): boolean {
  return records.some((record) => {
    if (insideOwnHost(record.target, env)) return false;
    if (record.type !== 'childList') return true;
    const changed = [...record.addedNodes, ...record.removedNodes];
    return changed.length === 0 || changed.some((n) => !insideOwnHost(n, env));
  });
}
