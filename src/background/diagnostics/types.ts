/**
 * 保守記録が受け取る要素特定の要約の形。
 * 型は要素特定エンジンの `LocateSummary`（文字列を含まない）。取り込み時に zod で検査し、
 * 知らない項目（名前の文字列や URL など）は落とす。
 */
import { z } from 'zod';
import {
  LocateReasonSchema,
  TierCountSchema,
  TierSchema,
  type LocateReason,
  type Tier,
  type TierCount,
} from '../../shared/logger/index.ts';
import type { LocateSummary } from '../../core/locator/index.ts';

export type { LocateReason, Tier, TierCount };

export const LocateSummarySchema = z.object({
  found: z.boolean(),
  tier: TierSchema.nullable(),
  topTier: TierSchema.nullable(),
  reasons: z.array(LocateReasonSchema),
  counts: z.array(TierCountSchema).max(5),
});

/** 要素特定エンジンの要約の型。スキーマの出力がこれに合うことを型で確かめる。 */
export type { LocateSummary };
type MustBeSummary<T extends LocateSummary> = T;
export type CheckedLocateSummary = MustBeSummary<z.output<typeof LocateSummarySchema>>;
