/**
 * ログと保守記録で共有する基本の型と zod スキーマ（レベル・実行場所・段階・理由・段階ごとの件数）。
 * 値はすべて列挙値と数値だけで、ページの文字列を持てない。
 */
import { z } from 'zod';

export const LEVELS = ['error', 'warn', 'info', 'debug'] as const;
export type Level = (typeof LEVELS)[number];
export const LevelSchema = z.enum(LEVELS);

/** 出力するかの判定に使う。小さいほど重大。 */
export const LEVEL_RANK = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
} as const satisfies Record<Level, number>;

export const DEFAULT_LEVEL: Level = 'warn';

export const CTXS = ['background', 'content', 'sidepanel'] as const;
export type Ctx = (typeof CTXS)[number];
export const CtxSchema = z.enum(CTXS);

export const TierSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);
export type Tier = z.infer<typeof TierSchema>;

export const LOCATE_REASONS = ['degraded', 'conflict', 'missing', 'nameMismatch'] as const;
export type LocateReason = (typeof LOCATE_REASONS)[number];
export const LocateReasonSchema = z.enum(LOCATE_REASONS);

const count = z.number().int().nonnegative();
const tierCountShape = {
  tier: TierSchema,
  collected: count,
  required: count,
  visible: count,
};
/** 余計な項目を許さない（ログの検査用）。 */
export const TierCountStrictSchema = z.strictObject(tierCountShape);
/** 余計な項目を落とす（外から来た要約を取り込む用）。 */
export const TierCountSchema = z.object(tierCountShape);
export type TierCount = z.infer<typeof TierCountSchema>;
