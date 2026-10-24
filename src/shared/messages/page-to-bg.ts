/**
 * ページ側 → バックグラウンドのメッセージ。`type` で判別する。
 * 報告（LOCATE_RESULT・HINT_STATE）は `sessionId`・`gen`・`pageSeq` を持つ。
 * 操作（GOTO など）はミニガイド・吹き出しへの利用者の実際の操作（isTrusted）のときだけ送られる。
 * 送信元の確認は本文の自己申告ではなく、受け取った側が Chrome の `sender` で行う。
 */
import { z } from 'zod';
import { GenSchema, PageSeqSchema, SessionIdSchema } from '../ids/index.ts';
import { LocateSummarySchema, LogMessageSchema } from './common.ts';
import { GotoSchema, PageSetUiSchema, ScrollToTargetSchema, SetOverlaySchema } from './operations.ts';

const report = { sessionId: SessionIdSchema, gen: GenSchema, pageSeq: PageSeqSchema } as const;

export const PageToBgSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('HELLO') }),
  z.object({ type: z.literal('LOCATE_RESULT'), ...report, result: LocateSummarySchema }),
  z.object({
    type: z.literal('HINT_STATE'),
    ...report,
    met: z.boolean(),
    unsupported: z.boolean(),
  }),
  GotoSchema,
  ScrollToTargetSchema,
  SetOverlaySchema,
  PageSetUiSchema,
  LogMessageSchema,
]);
export type PageToBg = z.output<typeof PageToBgSchema>;
