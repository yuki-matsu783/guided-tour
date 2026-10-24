/**
 * 状態管理の外とやり取りする型。注入する部品（storage・ポート・ログなど）と、操作の応答の形。
 * 応答の `status` は、処理した（done）・識別子の不一致や重複で捨てた（discarded）・
 * 識別子は合うが今の状態では受け付けない（rejected）・確認が要る（confirmBind）・扱わない（unhandled）のいずれか。
 */
import type { CatalogPort, TabsPort } from '../ports.ts';
import type { Diagnostics } from '../diagnostics/index.ts';
import type { DISCARD_REASONS, Logger } from '../../shared/logger/index.ts';
import type { PanelView } from '../../shared/messages/index.ts';
import type { PermissionsApi } from '../../shared/permissions/index.ts';

/** `chrome.storage.session` / `chrome.storage.local` と同じ get/set/remove の形。 */
export interface StorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface SessionDeps {
  readonly storageSession: StorageArea;
  readonly storageLocal: StorageArea;
  readonly catalog: CatalogPort;
  readonly tabs: TabsPort;
  readonly permissions: Pick<PermissionsApi, 'contains'>;
  readonly diagnostics: Pick<Diagnostics, 'record' | 'needsReview'>;
  readonly logger: Logger;
  /** サイドパネルへ状態の写しを通知する。失敗（パネルが閉じているなど）は呼び出し側で握りつぶしてよい。 */
  readonly notifyPanel: (view: PanelView) => void | Promise<void>;
  /** 現在の拡張機能のバージョン（`1.2.3` の形）。 */
  readonly extensionVersion: string;
  readonly now: () => number;
  /** 新しい `sessionId` の元になる文字列（識別子の形に合わなければ `crypto.randomUUID` で作り直す）。 */
  readonly randomId: () => string;
}

/** Chrome が付ける送信元のうち、確認に使う項目。 */
export interface PageSender {
  readonly tabId: number | undefined;
  readonly frameId: number | undefined;
  readonly documentId: string | undefined;
}

export type DiscardReason = (typeof DISCARD_REASONS)[number];

/** 識別子は合うが、今の状態では受け付けない理由。 */
export type RejectReason =
  | 'busy'
  | 'notRunning'
  | 'notPaused'
  | 'notResumable'
  | 'notRestartable'
  | 'notOverwritten'
  | 'tourNotFound'
  | 'permissionNotRestored'
  | 'outsideOrigins'
  | 'noPageStep'
  | 'notBound'
  | 'noOpenUrl'
  | 'tabBoundToOtherRole'
  | 'openFailed'
  | 'internal';

export type SessionResponse =
  | { readonly status: 'done' }
  | { readonly status: 'discarded'; readonly reason: DiscardReason }
  | { readonly status: 'rejected'; readonly reason: RejectReason }
  /** 拡張機能のバージョンが足りない。何も作らない。 */
  | {
      readonly status: 'rejected';
      readonly reason: 'versionTooLow';
      readonly current: string;
      readonly required: string;
    }
  /** `origins` の権限がない。何も作らない。`origins` は必要なサイト。 */
  | {
      readonly status: 'rejected';
      readonly reason: 'permissionMissing';
      readonly origins: readonly string[];
    }
  /** そのタブは別の役割に対応付け済み。`force: true` で付け替える。何も変えない。 */
  | { readonly status: 'confirmBind'; readonly boundRole: string }
  /** 状態管理が扱わないメッセージ（REMOVE・RELOAD・ログ関係など）。 */
  | { readonly status: 'unhandled' };

/** `GET_STATE` の応答は `PanelView` そのもの。それ以外の操作は `SessionResponse`。 */
export type PanelResponse = PanelView | SessionResponse;
export type PageResponse = SessionResponse;
