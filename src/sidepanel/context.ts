/**
 * 画面の部品が共有する値（依存・表示中の写し・操作・画像の URL 管理）。
 * 部品は `usePanel` で受け取る。写しがまだ無い間は、画面の部品を描かない。
 */
import { createContext, useContext } from 'react';
import type { PanelView } from '../shared/messages/index.ts';
import type { Assets } from './assets/index.ts';
import type { PanelDeps } from './deps.ts';
import type { Ops } from './ops.ts';

export interface PanelContextValue {
  deps: PanelDeps;
  view: PanelView;
  ops: Ops;
  assets: Assets;
  /** 写しを取り直す。 */
  refresh: () => void;
}

export const PanelContext = createContext<PanelContextValue | null>(null);

export function usePanel(): PanelContextValue {
  const value = useContext(PanelContext);
  if (value === null) throw new Error('PanelContext の外では使えません');
  return value;
}
