/**
 * メッセージの各方向で共有する部品。ミニガイドの設定、ページ側に送るステップ、要素特定の要約、LOG。
 * 受信側が検証する値なので、知らない項目は落とす（ただし形が合わないものは受け付けない）。
 */
import { z } from 'zod';
import type { LocateSummary } from '../../core/locator/index.ts';
import { TargetSchema, type Done, type Step } from '../../core/tour/index.ts';
import { LocateReasonSchema, TierCountSchema, TierSchema } from '../logger/index.ts';
import { parseLogEntry } from '../logger/index.ts';

/** ミニガイドの幅の範囲（px）。 */
export const UI_WIDTH_MIN = 240;
export const UI_WIDTH_MAX = 560;

export const UiModeSchema = z.enum(['expanded', 'minimized', 'hover']);
export type UiMode = z.output<typeof UiModeSchema>;

const widthSchema = z.int().min(UI_WIDTH_MIN).max(UI_WIDTH_MAX);
/** 範囲外の幅を捨てず、範囲内に丸めて受け付ける幅（バックグラウンド → ページ側の描画指示用）。 */
const clampedWidthSchema = z.int().transform((w) => Math.min(UI_WIDTH_MAX, Math.max(UI_WIDTH_MIN, w)));

/** ミニガイドの設定（サイドパネルの写しが運ぶ）。幅が範囲外なら捨てる。 */
export const UiSettingsSchema = z.object({
  enabled: z.boolean(),
  mode: UiModeSchema,
  width: widthSchema,
});
export type UiSettings = z.output<typeof UiSettingsSchema>;

/** 描画指示（RENDER）が運ぶミニガイドの設定。幅が範囲外でも指示全体は捨てず、範囲内に丸める。 */
export const RenderUiSchema = z.object({
  enabled: z.boolean(),
  mode: UiModeSchema,
  width: clampedWidthSchema,
});

/** サイドパネルからの `SET_UI` の本体。一部だけでもよい。 */
export const SetUiFields = {
  enabled: z.boolean().optional(),
  mode: UiModeSchema.optional(),
  width: widthSchema.optional(),
} as const;

/** ページ側からの `SET_UI` の本体。`enabled` は変えられない（含むメッセージは捨てる）。 */
export const PageSetUiFields = {
  mode: UiModeSchema.optional(),
  width: widthSchema.optional(),
} as const;

/** 目安の状態（ページに表示するもの）。 */
export const HintSchema = z.object({
  met: z.boolean(),
  unsupported: z.boolean(),
  stopped: z.boolean(),
});
export type Hint = z.output<typeof HintSchema>;

// ---- ページ側に送るステップ ----

const doneCommon = {
  target: TargetSchema,
  minLength: z.int().min(0).optional(),
  allowHidden: z.boolean().optional(),
  hint: z.string().optional(),
  doneHint: z.string().optional(),
};

/** ページ側が使う完了の目安。`type: page` はバックグラウンドが判定するので含めない。 */
export const PageDoneSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('element'), ...doneCommon }),
  z.object({
    type: z.literal('state'),
    state: z.enum(['filled', 'checked', 'selected', 'expanded', 'pressed']),
    ...doneCommon,
  }),
]);
export type PageDone = z.output<typeof PageDoneSchema>;

/** ページ側に要るものだけに絞ったステップ。説明文（body）・画像・URL 条件は送らない。 */
export const PageStepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  tip: z.string().optional(),
  target: TargetSchema.optional(),
  done: PageDoneSchema.optional(),
});
export type PageStep = z.output<typeof PageStepSchema>;

function toPageDone(done: Done | undefined): PageDone | undefined {
  if (done?.target === undefined) return undefined;
  const common = {
    target: done.target,
    minLength: done.minLength,
    allowHidden: done.allowHidden,
    hint: done.hint,
    doneHint: done.doneHint,
  };
  if (done.type === 'element') return { type: 'element', ...common };
  if (done.type === 'state' && done.state !== undefined) {
    return { type: 'state', state: done.state, ...common };
  }
  return undefined;
}

/** ツアーのステップから、ページ側に送る形を作る。 */
export function toPageStep(step: Step): PageStep {
  return {
    id: step.id,
    title: step.title,
    tip: step.tip,
    target: step.target,
    done: toPageDone(step.done),
  };
}

// ---- 要素特定の要約 ----

/** `LocateSummary`（core/locator）と同じ形。background に置かれた同名スキーマとは別に、shared に持つ。 */
export const LocateSummarySchema = z.object({
  found: z.boolean(),
  tier: TierSchema.nullable(),
  topTier: TierSchema.nullable(),
  reasons: z.array(LocateReasonSchema).max(4),
  counts: z.array(TierCountSchema).max(5),
});
type MustBeLocateSummary<T extends LocateSummary> = T;
type MustAcceptLocateSummary<T extends z.output<typeof LocateSummarySchema>> = T;
/** スキーマの出力と `LocateSummary` が相互に代入できることを、型で確かめる。 */
export type CheckedLocateSummary = MustBeLocateSummary<z.output<typeof LocateSummarySchema>>;
export type AcceptedLocateSummary = MustAcceptLocateSummary<LocateSummary>;

// ---- LOG ----

/**
 * `LOG{entries[]}`。各行はロガーのスキーマで検査し直し、通らない行は内容を捨てて出来事の名前だけにする。
 */
export const LogMessageSchema = z.object({
  type: z.literal('LOG'),
  entries: z.array(z.unknown().transform((e) => parseLogEntry(e))),
});
export type LogInbound = z.output<typeof LogMessageSchema>;
