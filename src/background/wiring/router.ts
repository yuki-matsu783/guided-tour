/**
 * `chrome.runtime.onMessage` の振り分け。送信元で、サイドパネル（`sender.url` で確認）とページ側
 * （`sender.tab` があり `sender.frameId === 0`）に分け、それぞれのスキーマで検証する。
 * 検証に通らないもの・どちらでもない送信元のものは捨てる（応答しない）。
 * 状態管理が扱わない操作（REMOVE・RELOAD・ログ関係）と、ツアー管理・ログの保管・保守記録の呼び出しはここで行う。
 * Chrome API は注入されるので、単体テストできる。
 */
import type { Ctx, Logger } from '../../shared/logger/index.ts';
import { errorFields } from '../../shared/logger/index.ts';
import {
  isSidePanelSender,
  parsePageToBg,
  parsePanelToBg,
  type OpResponse,
  type PageToBg,
  type PanelToBg,
  type PanelView,
} from '../../shared/messages/index.ts';
import type { Diagnostics } from '../diagnostics/index.ts';
import type { LogStore } from '../logstore/index.ts';
import type { CatalogPort } from '../ports.ts';
import type { PageSender, Session, SessionResponse } from '../session/index.ts';

/** `chrome.runtime.MessageSender` のうち、ここで使う項目。 */
export interface MessageSenderLike {
  readonly url?: string | undefined;
  readonly frameId?: number | undefined;
  readonly documentId?: string | undefined;
  readonly tab?: { readonly id?: number | undefined } | undefined;
}

export interface RouterDeps {
  readonly extensionId: string;
  readonly session: {
    handlePanel(msg: PanelToBg): Promise<unknown>;
    handlePage: (msg: PageToBg, sender: PageSender) => Promise<unknown>;
    onCatalogChanged: Session['onCatalogChanged'];
    onCatalogRemoved: Session['onCatalogRemoved'];
    view: Session['view'];
  };
  readonly catalog: Pick<CatalogPort, 'reload' | 'remove'>;
  readonly diagnostics: Pick<Diagnostics, 'list' | 'export' | 'clear'>;
  /** `ingest` には検証前の元の LOG メッセージと、送り手の実行場所を渡す。 */
  readonly logstore: {
    ingest(message: unknown, ctx: Ctx): void;
    exportJsonl: LogStore['exportJsonl'];
    clear: LogStore['clear'];
  };
  readonly logger: Pick<Logger, 'debug' | 'warn' | 'error'>;
  /** 状態の写しをサイドパネルへ通知する（失敗は呼び出し側で握りつぶす）。 */
  readonly notifyPanel: (view: PanelView) => void | Promise<void>;
  /** 起動時の処理が終わるまで待つ。失敗しても解決する。 */
  readonly ready: () => Promise<void>;
}

export type SendResponse = (response: unknown) => void;

/**
 * 状態管理の応答は、サイドパネルが検証するスキーマの出力に代入できる（型での確認）。
 * `permissionMissing` の `origins` だけは、状態管理側が readonly 配列でスキーマ側が可変配列のため、そのまま代入できない
 * （送るときに複製されるので実害はない）。ここでは `origins` の型だけを読み替えて確かめる。
 */
type WithMutableOrigins<T> = T extends { readonly origins: readonly string[] }
  ? Omit<T, 'origins'> & { origins: string[] }
  : T;
export const assertSessionResponseIsOp = (r: WithMutableOrigins<SessionResponse>): OpResponse => r;

const ACK_OK = { ok: true } as const;
const ACK_NG = { ok: false } as const;

export function createRouter(deps: RouterDeps): {
  onMessage(raw: unknown, sender: MessageSenderLike, sendResponse: SendResponse): boolean;
} {
  const { session, catalog, diagnostics, logstore, logger } = deps;

  function notify(): void {
    void session
      .view()
      .then((view) => deps.notifyPanel(view))
      .catch(() => undefined);
  }

  async function panelOp(msg: PanelToBg): Promise<unknown> {
    switch (msg.type) {
      case 'GET_STATE':
        return session.handlePanel(msg);
      case 'CATALOG_CHANGED': {
        await catalog.reload();
        await session.handlePanel(msg);
        return ACK_OK;
      }
      case 'REMOVE': {
        const removed = await catalog.remove(msg.tourId);
        if (!removed) return ACK_NG;
        await session.onCatalogRemoved(msg.tourId);
        return ACK_OK;
      }
      case 'RELOAD': {
        await catalog.reload();
        notify();
        return ACK_OK;
      }
      case 'GET_DIAGNOSTICS':
        return { entries: await diagnostics.list() };
      case 'EXPORT_LOGS': {
        const [logs, entries] = await Promise.all([logstore.exportJsonl(), diagnostics.export()]);
        return { logs, diagnostics: JSON.stringify(entries) };
      }
      case 'CLEAR_LOGS': {
        await Promise.all([logstore.clear(), diagnostics.clear()]);
        notify();
        return ACK_OK;
      }
      case 'LOG':
        // 呼び出し側で処理済み（応答しない）
        return undefined;
      default:
        return session.handlePanel(msg);
    }
  }

  /** 操作の失敗は、応答の形に合わせて返す（例外の内容は記録しない）。 */
  function failureOf(msg: PanelToBg): unknown {
    switch (msg.type) {
      case 'GET_DIAGNOSTICS':
        return { entries: [] };
      case 'EXPORT_LOGS':
        return { logs: '', diagnostics: '[]' };
      case 'CATALOG_CHANGED':
      case 'REMOVE':
      case 'RELOAD':
      case 'CLEAR_LOGS':
        return ACK_NG;
      default:
        return { status: 'rejected', reason: 'internal' };
    }
  }

  function handlePanelMessage(msg: PanelToBg, raw: unknown, sendResponse: SendResponse): boolean {
    // LOG は、検証で各行の形が変わる前の元のメッセージを渡す（ログの保管が各行を検査し直す）
    if (msg.type === 'LOG') {
      logstore.ingest(raw, 'sidepanel');
      return false;
    }
    void deps
      .ready()
      .then(() => panelOp(msg))
      .then(sendResponse)
      .catch((error: unknown) => {
        logger.error('error', errorFields(error, 'message'));
        sendResponse(failureOf(msg));
      });
    return true;
  }

  function handlePageMessage(
    raw: unknown,
    sender: MessageSenderLike,
    sendResponse: SendResponse,
  ): boolean {
    const msg = parsePageToBg(raw, logger);
    if (msg === null) return false;
    if (msg.type === 'LOG') {
      logstore.ingest(raw, 'content');
      return false;
    }
    const pageSender = {
      tabId: sender.tab?.id,
      frameId: sender.frameId,
      documentId: sender.documentId,
    };
    void deps
      .ready()
      .then(() => session.handlePage(msg, pageSender))
      .then(sendResponse)
      .catch((error: unknown) => {
        logger.error('error', errorFields(error, 'message'));
        sendResponse({ status: 'rejected', reason: 'internal' });
      });
    return true;
  }

  return {
    onMessage(raw, sender, sendResponse) {
      // サイドパネルを通常のタブで開いたときも `sender.tab` が付くので、先に `sender.url` で確かめる
      if (isSidePanelSender(sender, deps.extensionId)) {
        const msg = parsePanelToBg(raw, sender, deps.extensionId, logger);
        return msg === null ? false : handlePanelMessage(msg, raw, sendResponse);
      }
      if (sender.tab !== undefined && sender.frameId === 0) {
        return handlePageMessage(raw, sender, sendResponse);
      }
      logger.debug('error', { name: 'Error', reason: 'permission' });
      return false;
    },
  };
}
