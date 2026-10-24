/**
 * サイドパネルの操作に対するバックグラウンドの応答の形。
 * バックグラウンドの状態管理の応答（`SessionResponse`）と、ログ・保守記録・ツアー管理の操作の応答を、
 * サイドパネルが受け取ったときに検証するためのスキーマ。
 */
import { z } from 'zod';
import { DISCARD_REASONS, LocateReasonSchema, TierCountSchema, TierSchema } from '../logger/index.ts';

export const REJECT_REASONS = [
  'busy',
  'notRunning',
  'notPaused',
  'notResumable',
  'notRestartable',
  'notOverwritten',
  'tourNotFound',
  'permissionNotRestored',
  'outsideOrigins',
  'noPageStep',
  'notBound',
  'noOpenUrl',
  'openFailed',
  'internal',
] as const;

/** 状態管理への操作の応答。 */
export const OpResponseSchema = z.union([
  z.object({ status: z.literal('done') }),
  z.object({ status: z.literal('discarded'), reason: z.enum(DISCARD_REASONS) }),
  z.object({
    status: z.literal('rejected'),
    reason: z.literal('versionTooLow'),
    current: z.string(),
    required: z.string(),
  }),
  z.object({
    status: z.literal('rejected'),
    reason: z.literal('permissionMissing'),
    origins: z.array(z.string()),
  }),
  z.object({ status: z.literal('rejected'), reason: z.enum(REJECT_REASONS) }),
  z.object({ status: z.literal('confirmBind'), boundRole: z.string() }),
  z.object({ status: z.literal('unhandled') }),
]);
export type OpResponse = z.output<typeof OpResponseSchema>;

/** 保守記録の1件（`lastKey` は含めない）。 */
export const DiagnosticEntrySchema = z.object({
  tourId: z.string(),
  stepId: z.string(),
  reason: LocateReasonSchema,
  tier: TierSchema.nullable(),
  topTier: TierSchema.nullable(),
  counts: z.array(TierCountSchema).max(5),
  total: z.number().int().positive(),
  lastAt: z.number(),
});
export type DiagnosticEntryView = z.output<typeof DiagnosticEntrySchema>;

/** `GET_DIAGNOSTICS` の応答。 */
export const DiagnosticsResponseSchema = z.object({ entries: z.array(DiagnosticEntrySchema) });

/** `EXPORT_LOGS` の応答。ログ（JSON Lines）と保守記録（JSON）の文字列。サイドパネルがファイルとして保存する。 */
export const ExportLogsResponseSchema = z.object({ logs: z.string(), diagnostics: z.string() });

/** `CLEAR_LOGS`・`REMOVE`・`RELOAD`・`CATALOG_CHANGED`・`SET_UI` の応答。 */
export const AckResponseSchema = z.object({ ok: z.boolean() });
