/**
 * 受信したメッセージの検証。形が合わないもの・送信元が違うものは null を返し、例外は外へ出さない。
 * 捨てたときは、渡されたロガーに debug で出来事の名前と理由コードだけを残す（内容・URL は残さない）。
 * ページ側の本文にある自己申告の項目（`sender` など）は、スキーマが知らない項目として落とす。
 */
import type { z } from 'zod';
import type { Logger } from '../logger/index.ts';
import { BgToPageSchema, type BgToPage } from './bg-to-page.ts';
import { BgToPanelSchema, type BgToPanel } from './bg-to-panel.ts';
import { PageToBgSchema, type PageToBg } from './page-to-bg.ts';
import { PanelToBgSchema, type PanelToBg } from './panel-to-bg.ts';

/** 受信側が使うロガーの口（debug だけ）。 */
export type DropLogger = Pick<Logger, 'debug'>;

/** Chrome が付ける送信元のうち、ここで使う項目。 */
export interface SenderLike {
  url?: string | undefined;
}

function noteDropped(logger: DropLogger | undefined, reason: 'message' | 'permission'): void {
  try {
    logger?.debug('error', { name: 'ZodError', reason });
  } catch {
    // 記録の失敗で受信処理を止めない
  }
}

function parseWith<S extends z.ZodType>(
  schema: S,
  raw: unknown,
  logger: DropLogger | undefined,
): z.output<S> | null {
  try {
    const r = schema.safeParse(raw);
    if (r.success) return r.data;
  } catch {
    // 検証中の例外も捨てる扱い
  }
  noteDropped(logger, 'message');
  return null;
}

/** `sender.url` が `chrome-extension://<extensionId>/sidepanel.html` か。 */
export function isSidePanelSender(sender: SenderLike, extensionId: string): boolean {
  if (sender.url === undefined) return false;
  try {
    const url = new URL(sender.url);
    return (
      url.protocol === 'chrome-extension:' &&
      url.hostname === extensionId &&
      url.pathname === '/sidepanel.html'
    );
  } catch {
    return false;
  }
}

/** サイドパネルからのメッセージ。送信元がサイドパネルのページでなければ null。 */
export function parsePanelToBg(
  raw: unknown,
  sender: SenderLike,
  extensionId: string,
  logger?: DropLogger,
): PanelToBg | null {
  if (!isSidePanelSender(sender, extensionId)) {
    noteDropped(logger, 'permission');
    return null;
  }
  return parseWith(PanelToBgSchema, raw, logger);
}

/** ページ側からのメッセージ。送信元（tab・frame・document）の確認は、受け取った側が `sender` で行う。 */
export function parsePageToBg(raw: unknown, logger?: DropLogger): PageToBg | null {
  return parseWith(PageToBgSchema, raw, logger);
}

/** バックグラウンドからページ側へ届いたメッセージ。 */
export function parseBgToPage(raw: unknown, logger?: DropLogger): BgToPage | null {
  return parseWith(BgToPageSchema, raw, logger);
}

/** バックグラウンドからサイドパネルへ届いたメッセージ。 */
export function parseBgToPanel(raw: unknown, logger?: DropLogger): BgToPanel | null {
  return parseWith(BgToPanelSchema, raw, logger);
}
