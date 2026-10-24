/**
 * バックグラウンド → サイドパネルのメッセージと、サイドパネルの描画に要る「状態の写し」`PanelView`。
 * `GET_STATE` の応答も `PanelView`。ページから読んだ名前の文字列は含めない。
 * タブの `title` は利用者自身のブラウザの情報で外へ出ないので含めてよい。
 */
import { z } from 'zod';
import { GenSchema, SessionIdSchema } from '../ids/index.ts';
import { LevelSchema } from '../logger/index.ts';
import { HintSchema, UiSettingsSchema } from './common.ts';

export const PANEL_STATUSES = ['idle', 'running', 'paused', 'ended'] as const;
export const PauseReasonSchema = z.enum(['user', 'permission', 'overwritten']);
export type PauseReason = z.output<typeof PauseReasonSchema>;

export const TourSourceSchema = z.enum(['bundled', 'imported']);
export type TourSource = z.output<typeof TourSourceSchema>;

export const TAB_STATUSES = ['ok', 'donePage', 'mismatch', 'missing', 'unsupported'] as const;
export const TabStatusKindSchema = z.enum(TAB_STATUSES);
export type TabStatusKind = z.output<typeof TabStatusKindSchema>;

/** サイドパネルに出す通知。`restartedFromFirst` は新版で同じステップが無く最初から始めたとき。 */
export const NoticeSchema = z.enum(['restartedFromFirst', 'tourRemoved']);
export type Notice = z.output<typeof NoticeSchema>;

export const TabCandidateSchema = z.object({
  tabId: z.int(),
  title: z.string(),
  windowId: z.int(),
  /** 別の役割に対応付け済みならその役割。 */
  boundRole: z.string().nullable(),
});
export type TabCandidate = z.output<typeof TabCandidateSchema>;

export const TabViewSchema = z.object({
  role: z.string(),
  status: TabStatusKindSchema,
  candidates: z.array(TabCandidateSchema),
  attended: z.boolean(),
  selected: z.boolean(),
});
export type TabView = z.output<typeof TabViewSchema>;

export const CatalogEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  stepCount: z.int().nonnegative(),
  origins: z.array(z.string()),
  source: TourSourceSchema,
  hasPermission: z.boolean(),
  needsReview: z.boolean(),
  progress: z
    .object({ stepIndex: z.int().nonnegative(), stepId: z.string(), savedAt: z.number() })
    .nullable(),
});
export type CatalogEntry = z.output<typeof CatalogEntrySchema>;

export const PanelViewSchema = z.object({
  status: z.enum(PANEL_STATUSES),
  pauseReason: PauseReasonSchema.nullable(),
  sessionId: SessionIdSchema.nullable(),
  gen: GenSchema.nullable(),
  /** 実行中（一時中断・終了を含む）のツアー。無ければ null。 */
  tour: z
    .object({
      id: z.string(),
      name: z.string(),
      hash: z.string(),
      origins: z.array(z.string()),
      source: TourSourceSchema,
    })
    .nullable(),
  steps: z.array(
    z.object({ id: z.string(), title: z.string(), kind: z.enum(['page', 'guide']) }),
  ),
  stepIndex: z.int().nonnegative(),
  /** 現在のステップの役割のタブの状態。`guide` のステップや実行中でないときは null。 */
  tabStatus: TabViewSchema.nullable(),
  overlayHidden: z.boolean(),
  hint: HintSchema,
  saveError: z.boolean(),
  notice: NoticeSchema.nullable(),
  catalog: z.array(CatalogEntrySchema),
  ui: UiSettingsSchema,
  logLevel: LevelSchema,
});
export type PanelView = z.output<typeof PanelViewSchema>;

/** `GET_STATE` の応答。 */
export const GetStateResponseSchema = PanelViewSchema;
export type GetStateResponse = PanelView;

export const BgToPanelSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('TOUR_STATE_CHANGED'), view: PanelViewSchema }),
]);
export type BgToPanel = z.output<typeof BgToPanelSchema>;
