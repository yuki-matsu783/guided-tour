/**
 * バックグラウンドの部品（状態管理・タブ管理・ツアー管理）の間の約束。
 * 状態管理はこの型だけに依存し、タブ管理・ツアー管理の実体は起動時に差し込む（テストでは偽物を差し込む）。
 */
import type { Step, Tour } from '../core/tour/index.ts';
import type { BgToPage, TabStatusKind, TourSource } from '../shared/messages/index.ts';

/** 実行中に固定するツアーの内容。`hash` は内容のハッシュ。 */
export interface CatalogTour {
  readonly tour: Tour;
  readonly hash: string;
  readonly source: TourSource;
}

/** 一覧に出す1件。 */
export interface CatalogEntry extends CatalogTour {
  /** 同じ ID の同梱版が取り込み版に隠れているか。 */
  readonly shadowsBundled: boolean;
}

/** ツアー管理。同梱と取り込みをまとめ、取り込みを優先する。 */
export interface CatalogPort {
  list(): Promise<CatalogEntry[]>;
  get(tourId: string): Promise<CatalogTour | null>;
  /** 固定した `hash` の内容。もう無ければ null。 */
  getPinned(tourId: string, hash: string): Promise<CatalogTour | null>;
  /** 取り込み版を削除する（ファイル・保守記録・合計容量も戻す）。同梱版は削除できない。 */
  remove(tourId: string): Promise<boolean>;
  /** キャッシュを捨てて組み立て直す。 */
  reload(): Promise<void>;
}

/** 役割に対応付けたタブ。 */
export interface RoleBinding {
  readonly tabId: number;
  /** `HELLO` の `sender.documentId`。組み込み前は null。 */
  readonly documentId: string | null;
}

export interface TabCandidate {
  readonly tabId: number;
  readonly title: string;
  readonly windowId: number;
  /** 別の役割に対応付け済みなら、その役割。 */
  readonly boundRole: string | null;
}

/** あるステップについての、役割のタブの状態。 */
export interface TabEvaluation {
  readonly role: string;
  readonly status: TabStatusKind;
  readonly selected: boolean;
  readonly attended: boolean;
  readonly candidates: readonly TabCandidate[];
  /** 注目中のタブが URL 条件に合い、「このタブを使う」を出せるときのタブ ID。 */
  readonly focusedCandidate: number | null;
}

/** タブの変化。状態管理は受けたら評価し直す。 */
export type TabEvent =
  | { readonly kind: 'activated' | 'focusChanged' }
  | { readonly kind: 'removed'; readonly tabId: number }
  | { readonly kind: 'committed'; readonly tabId: number }
  | { readonly kind: 'historyStateUpdated'; readonly tabId: number }
  | { readonly kind: 'completed'; readonly tabId: number };

/** タブ管理。依頼されたときだけ、開く・対応付ける・前面に出す。役割を自動では対応付けない。 */
export interface TabsPort {
  evaluate(tour: Tour, step: Step, roles: Readonly<Record<string, RoleBinding>>): Promise<TabEvaluation>;
  /** タブの URL が `tour.origins` に含まれるか（他のツアーの権限は理由にしない）。 */
  isWithinOrigins(tour: Tour, tabId: number): Promise<boolean>;
  /** ページ側を組み込む。組み込む前に `isWithinOrigins` を確かめる。失敗したら false。 */
  inject(tour: Tour, tabId: number): Promise<boolean>;
  /** 今のタブ（今のウィンドウの注目中のタブ）の ID。取れなければ null。 */
  currentTabId(): Promise<number | null>;
  /**
   * 実行中のツアーを知らせる。実行中でなければ null。
   * null の間は、ページ側の組み込みの再試行をしない。
   */
  setActiveTour(tour: Tour | null): void;
  /** 今のタブ／新しいタブで `url` を開き、そのタブ ID を返す。 */
  open(mode: 'current' | 'new', url: string): Promise<number | null>;
  /** タブとそのウィンドウを前面に出す。 */
  focus(tabId: number): Promise<void>;
  /** ページ側へ送る。送る前に `isWithinOrigins` を確かめる。 */
  send(tour: Tour, tabId: number, message: BgToPage): Promise<void>;
  /** 役割のタブ以外も含め、組み込み済みのすべてのタブに送る（CLEAR 用。origins は確かめない）。 */
  broadcast(message: BgToPage): Promise<void>;
  onEvent(listener: (event: TabEvent) => void): () => void;
  /** ショートカットキーの実際の割り当て。無ければ null。 */
  shortcut(): Promise<string | null>;
}
