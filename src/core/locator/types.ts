/**
 * 要素特定エンジンの入出力の型。
 * 入力は target（ツアー形式の zod スキーマが作る `Target` と同じ形）と、判定を差し替える `LocatorEnv`。
 * 出力の `LocateSummary` は文字列（名前・表示文字列・URL）を含まず、ページ側からバックグラウンドへの報告と保守記録にそのまま使える。
 */

/** 探索の手がかりの段階（1 が最上位）。 */
export type Tier = 1 | 2 | 3 | 4 | 5;

/** `within`（探す範囲）の指定。役割＋名前、ラベル、CSS のいずれか。 */
export type LocatorWithin =
  | { role: string; name: string[] }
  | { label: string[] }
  | { css: string };

/** ツアーの target。`src/core/tour` の `Target` と同じ形。 */
export interface LocatorTarget {
  tourId?: string;
  testId?: string;
  role?: string;
  name?: string[];
  label?: string[];
  text?: string[];
  textTag?: string[];
  match?: 'exact' | 'contains';
  css?: string[];
  within?: LocatorWithin;
  require?: { role?: string; inputType?: string; region?: string; name?: string[] };
  highlight?: { closest: string };
  fallbackText?: string;
}

export type LocateReason = 'degraded' | 'conflict' | 'missing' | 'nameMismatch';

/** 段階ごとの候補数。集めた数・必須の照合後・表示の確認後。 */
export interface TierCount {
  tier: Tier;
  collected: number;
  required: number;
  visible: number;
}

export interface LocateSummary {
  found: boolean;
  tier: Tier | null;
  topTier: Tier | null;
  reasons: LocateReason[];
  counts: TierCount[];
}

export interface LocateResult extends LocateSummary {
  target: Element | null;
  highlightEl: Element | null;
}

/** 判定の差し替え口。テストでは jsdom 向けの実装を渡す。 */
export interface LocatorEnv {
  isVisible(el: Element): boolean;
  computeRole(el: Element): string | null;
  /** エンジンの中だけで使い、呼び出し元には返さない。 */
  computeName(el: Element): string;
  viewport(): { width: number; height: number };
  /** 自前の表示のホスト要素か（属性 `data-guided-tour-host` を持つ）。 */
  isOwnHost(el: Element): boolean;
}

export interface LocateOptions {
  /** 完了の目安の判定で、表示されていない候補も対象にする。 */
  allowHidden?: boolean;
}
