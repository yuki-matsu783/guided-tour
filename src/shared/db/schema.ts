/**
 * IndexedDB `guided-tour` の定義（名前・版・ストア・索引）と、各ストアの値の zod スキーマ。
 * tours の `compiled` は検証せず `unknown` のまま持つ（検証はツアー管理が行う）。
 * `meta` は `{ key, value }` の組で、容量の集計は `key: 'totalBytes'` に入れる。
 */
import { z } from 'zod';
import {
  CtxSchema,
  LevelSchema,
  LocateReasonSchema,
  TierCountSchema,
  TierSchema,
} from '../logger/primitives.ts';

export const DB_NAME = 'guided-tour';
export const DB_VERSION = 1;

export const STORE = {
  tours: 'tours',
  files: 'files',
  meta: 'meta',
  logs: 'logs',
  diagnostics: 'diagnostics',
} as const;

export const INDEX = {
  filesByTour: 'tourId',
  logsByTs: 'ts',
  diagnosticsByTour: 'tourId',
  diagnosticsByLastAt: 'lastAt',
} as const;

export const TOTAL_BYTES_KEY = 'totalBytes';

export const TourRecordSchema = z.object({
  id: z.string(),
  hash: z.string(),
  compiled: z.unknown(),
  yamlText: z.string(),
  fileName: z.string(),
  importedAt: z.number(),
  totalBytes: z.number().int().nonnegative(),
});
export type TourRecord = z.infer<typeof TourRecordSchema>;

export const FileRecordSchema = z.object({
  tourId: z.string(),
  hash: z.string(),
  path: z.string(),
  blob: z.instanceof(Blob),
  mime: z.string(),
  size: z.number().int().nonnegative(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
export type FileRecord = z.infer<typeof FileRecordSchema>;

export const MetaRecordSchema = z.object({
  key: z.string(),
  value: z.number(),
});
export type MetaRecord = z.infer<typeof MetaRecordSchema>;

/** `id` は自動採番。書き込み前は持たない。 */
export const LogRecordSchema = z.object({
  id: z.number().int().optional(),
  ts: z.number(),
  level: LevelSchema,
  ctx: CtxSchema,
  event: z.string(),
  fields: z.record(z.string(), z.unknown()),
});
export type LogRecord = z.infer<typeof LogRecordSchema>;

/** `lastKey` は直前に数えた `sessionId:gen`。重複の判定にだけ使い、書き出さない。 */
export const DiagnosticRecordSchema = z.object({
  tourId: z.string(),
  stepId: z.string(),
  reason: LocateReasonSchema,
  tier: TierSchema.nullable(),
  topTier: TierSchema.nullable(),
  counts: z.array(TierCountSchema).max(5),
  total: z.number().int().positive(),
  lastAt: z.number(),
  lastKey: z.string(),
});
export type DiagnosticRecord = z.infer<typeof DiagnosticRecordSchema>;
