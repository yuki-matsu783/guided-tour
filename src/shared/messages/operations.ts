/**
 * サイドパネルとページ側の両方が送れる操作のスキーマ。
 * 受け付け条件（識別子の一致）は `requirements.ts` の表と、バックグラウンドの状態管理が決める。
 */
import { z } from 'zod';
import { GenSchema, OpIdSchema, SessionIdSchema } from '../ids/index.ts';
import { PageSetUiFields, SetUiFields } from './common.ts';

export const GotoSchema = z.object({
  type: z.literal('GOTO'),
  to: z.int(),
  sessionId: SessionIdSchema,
  gen: GenSchema,
  opId: OpIdSchema,
});

export const ScrollToTargetSchema = z.object({
  type: z.literal('SCROLL_TO_TARGET'),
  sessionId: SessionIdSchema,
  gen: GenSchema,
  opId: OpIdSchema,
});

export const SetOverlaySchema = z.object({
  type: z.literal('SET_OVERLAY'),
  hidden: z.boolean(),
  sessionId: SessionIdSchema,
  opId: OpIdSchema,
});

/** サイドパネルからの `SET_UI`。 */
export const SetUiSchema = z.object({ type: z.literal('SET_UI'), ...SetUiFields });

/** ページ側からの `SET_UI`。`mode` と `width` だけ。知らない項目（`enabled` を含む）があれば受け付けない。 */
export const PageSetUiSchema = z.strictObject({ type: z.literal('SET_UI'), ...PageSetUiFields });
