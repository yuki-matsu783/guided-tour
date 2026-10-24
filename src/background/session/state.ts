/**
 * 状態管理が保存するデータの zod スキーマ。
 * 実行中の状態は storage.session `tour`、進捗・削除待ち・設定は storage.local に置く。
 * 外（storage）から読んだ値は必ずここを通し、通らなければ「無い」ものとして扱う。
 */
import { z } from 'zod';
import {
  GenSchema,
  OpIdSchema,
  PageSeqSchema,
  RevSchema,
  SessionIdSchema,
} from '../../shared/ids/index.ts';
import { LevelSchema, DEFAULT_LEVEL } from '../../shared/logger/index.ts';
import {
  NoticeSchema,
  PauseReasonSchema,
  TabStatusKindSchema,
  UI_WIDTH_MAX,
  UI_WIDTH_MIN,
  UiModeSchema,
  type UiSettings,
} from '../../shared/messages/index.ts';

/** 処理済みの操作 ID を覚える件数。 */
export const RECENT_OP_LIMIT = 50;

export const RoleBindingStateSchema = z.object({
  tabId: z.int(),
  /** `HELLO` の `sender.documentId`。組み込み前・ページ移動直後は null。 */
  documentId: z.string().nullable(),
});

/** 最後に評価したタブの状態。描画指示の要否と、変化の検知に使う。`guide` のステップでは持たない。 */
export const TabStatusSnapshotSchema = z.object({
  role: z.string(),
  status: TabStatusKindSchema,
  selected: z.boolean(),
  attended: z.boolean(),
});
export type TabStatusSnapshot = z.output<typeof TabStatusSnapshotSchema>;

/**
 * 役割 → タブの対応表。`z.record` は `__proto__` の項目を落とすので、自分のキーを1つずつ検証して作り直す。
 * 項目が1つでも形に合わなければ全体を拒否する。
 */
const RoleTabsSchema = z
  .custom<object>((v) => typeof v === 'object' && v !== null && !Array.isArray(v))
  .transform((obj, ctx) => {
    const entries: [string, z.output<typeof RoleBindingStateSchema>][] = [];
    for (const [role, value] of Object.entries(obj)) {
      const parsed = RoleBindingStateSchema.safeParse(value);
      if (!parsed.success) {
        ctx.addIssue({ code: 'custom', message: '役割に対応付けたタブの形が正しくありません', path: [role] });
        return z.NEVER;
      }
      entries.push([role, parsed.data]);
    }
    return Object.fromEntries(entries);
  });

export const TourStateSchema = z.object({
  status: z.enum(['running', 'paused', 'ended']),
  pauseReason: PauseReasonSchema.nullable(),
  sessionId: SessionIdSchema,
  gen: GenSchema,
  pageSeq: PageSeqSchema,
  rev: RevSchema,
  tourId: z.string().min(1),
  hash: z.string().min(1),
  stepIndex: z.int().nonnegative(),
  stepId: z.string().min(1),
  windowId: z.int().nullable(),
  tabs: RoleTabsSchema,
  overlayHidden: z.boolean(),
  hint: z.object({ gen: GenSchema, met: z.boolean(), unsupported: z.boolean() }),
  tabStatus: TabStatusSnapshotSchema.nullable(),
  saveError: z.boolean(),
  notice: NoticeSchema.nullable(),
  recentOpIds: z.array(OpIdSchema).max(RECENT_OP_LIMIT),
});
export type TourState = z.output<typeof TourStateSchema>;

export const STATE_KEY = 'tour';

// ---- 進捗・削除待ち ----

export const ProgressSchema = z.object({
  sessionId: SessionIdSchema,
  gen: GenSchema,
  stepId: z.string().min(1),
  stepIndex: z.int().nonnegative(),
  savedAt: z.number(),
});
export type Progress = z.output<typeof ProgressSchema>;

export const PendingDeleteSchema = z.object({
  tourId: z.string().min(1),
  sessionId: SessionIdSchema,
});
export type PendingDelete = z.output<typeof PendingDeleteSchema>;

export const PROGRESS_KEY = 'progress';
export const PENDING_DELETES_KEY = 'pendingDeletes';
export const SETTINGS_KEY = 'settings';

// ---- 設定 ----

export const DEFAULT_UI: UiSettings = { enabled: true, mode: 'expanded', width: 320 };

const UiSchema = z.object({
  enabled: z.boolean().catch(DEFAULT_UI.enabled),
  mode: UiModeSchema.catch(DEFAULT_UI.mode),
  width: z.int().min(UI_WIDTH_MIN).max(UI_WIDTH_MAX).catch(DEFAULT_UI.width),
});

/** 知らない項目は触らずに残す（ほかの画面が書く項目を消さないため）。 */
export const SettingsSchema = z.looseObject({
  logLevel: LevelSchema.catch(DEFAULT_LEVEL),
  miniGuide: UiSchema.catch(DEFAULT_UI),
});
export type Settings = z.output<typeof SettingsSchema>;

/** ミニガイドの幅を範囲内の整数に収める。 */
export function clampWidth(width: number): number {
  const w = Number.isFinite(width) ? Math.round(width) : DEFAULT_UI.width;
  return Math.min(UI_WIDTH_MAX, Math.max(UI_WIDTH_MIN, w));
}
