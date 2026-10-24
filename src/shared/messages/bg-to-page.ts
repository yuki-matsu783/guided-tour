/**
 * バックグラウンド → ページ側のメッセージ。`type` で判別する。
 * 描画の指示（SYNC 以外）は `rev` を必ず持ち、ページ側は受け取った最大の `rev` より小さいものを捨てる。
 */
import { z } from 'zod';
import { GenSchema, PageSeqSchema, RevSchema, SessionIdSchema } from '../ids/index.ts';
import { HintSchema, PageStepSchema, RenderUiSchema } from './common.ts';

export const RenderSchema = z.object({
  type: z.literal('RENDER'),
  sessionId: SessionIdSchema,
  gen: GenSchema,
  pageSeq: PageSeqSchema,
  rev: RevSchema,
  step: PageStepSchema,
  index: z.int().nonnegative(),
  total: z.int().positive(),
  overlay: z.object({ hidden: z.boolean() }),
  ui: RenderUiSchema,
  selected: z.boolean(),
  attended: z.boolean(),
  donePage: z.boolean(),
  hint: HintSchema,
  /** 拡張機能を開くショートカットキーの表示。未設定なら null。 */
  shortcut: z.string().nullable(),
  /** 対象が見つからないときの文章だけの案内の文。通常は null。 */
  fallbackText: z.string().nullable(),
  isLast: z.boolean(),
});
export type Render = z.output<typeof RenderSchema>;

export const BgToPageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('PING') }),
  z.object({
    type: z.literal('SYNC'),
    sessionId: SessionIdSchema,
    gen: GenSchema,
    rev: RevSchema,
  }),
  RenderSchema,
  z.object({ type: z.literal('RECHECK'), rev: RevSchema }),
  z.object({ type: z.literal('SCROLL_TO_TARGET'), rev: RevSchema }),
  z.object({ type: z.literal('CLEAR'), rev: RevSchema }),
]);
export type BgToPage = z.output<typeof BgToPageSchema>;
