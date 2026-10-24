/**
 * 出来事名ごとの項目のスキーマの表。
 * 項目は列挙値・数値・真偽値・内部 ID だけにする。出来事を足すときは EVENT_NAMES と表の両方に足す
 * （表は satisfies で EVENT_NAMES と食い違うと型エラーになる）。
 */
import { z } from 'zod';
import {
  LocateReasonSchema,
  TierCountStrictSchema,
  TierSchema,
} from './primitives.ts';

export const EVENT_NAMES = [
  'locator.result',
  'tabs.status',
  'session.goto',
  'session.start',
  'session.stop',
  'session.pause',
  'session.resume',
  'session.complete',
  'session.discard',
  'import.result',
  'error',
  'logger.invalid',
] as const;
export type EventName = (typeof EVENT_NAMES)[number];

/** 例外の理由コード。呼び出し側が列挙値として渡す。 */
export const ERROR_REASONS = [
  'unknown',
  'storage',
  'quota',
  'message',
  'permission',
  'import',
  'timeout',
  'invalid',
] as const;
export type ErrorReason = (typeof ERROR_REASONS)[number];

/** 記録してよい例外名。これ以外の名前は `Unknown` にする。 */
export const ERROR_NAMES = [
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'EvalError',
  'URIError',
  'ZodError',
  'AbortError',
  'NotFoundError',
  'QuotaExceededError',
  'InvalidStateError',
  'DataError',
  'DataCloneError',
  'ConstraintError',
  'TransactionInactiveError',
  'ReadOnlyError',
  'VersionError',
  'UnknownError',
  'SecurityError',
  'NetworkError',
  'TimeoutError',
  'Unknown',
] as const;
export type ErrorName = (typeof ERROR_NAMES)[number];

/** 古い・重複した操作や報告を捨てた理由。 */
export const DISCARD_REASONS = [
  'staleSession',
  'staleGen',
  'duplicateOp',
  'staleReport',
  'outOfRange',
  'senderMismatch',
] as const;

/** ツアーの役割名（空でない文字列）。長さは64文字まで、制御文字は不可。 */
const tourRole = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[^\p{Cc}]+$/u);
const index = z.number().int().nonnegative();

export const eventSchemas = {
  'locator.result': z.strictObject({
    tier: TierSchema.nullable(),
    topTier: TierSchema.nullable(),
    reasons: z.array(LocateReasonSchema).max(4),
    counts: z.array(TierCountStrictSchema).max(5),
  }),
  'tabs.status': z.strictObject({
    role: tourRole,
    status: z.enum(['ok', 'donePage', 'mismatch', 'missing', 'unsupported']),
  }),
  'session.goto': z.strictObject({ from: index, to: index, accepted: z.boolean() }),
  'session.start': z.strictObject({ resume: z.boolean() }),
  'session.stop': z.strictObject({}),
  'session.pause': z.strictObject({ reason: z.enum(['user', 'permission', 'overwritten']) }),
  'session.resume': z.strictObject({}),
  'session.complete': z.strictObject({}),
  'session.discard': z.strictObject({ reason: z.enum(DISCARD_REASONS) }),
  'import.result': z.strictObject({
    result: z.enum(['imported', 'cancelled', 'rejected', 'failed']),
    files: index,
    bytes: index,
  }),
  error: z.strictObject({
    name: z.enum(ERROR_NAMES),
    reason: z.enum(ERROR_REASONS),
  }),
  'logger.invalid': z.strictObject({
    event: z.enum([...EVENT_NAMES, 'unknown'] as const),
  }),
} satisfies Record<EventName, z.ZodType>;

export type EventFields = { [K in EventName]: z.input<(typeof eventSchemas)[K]> };

const eventNameSet: ReadonlySet<string> = new Set(EVENT_NAMES);

export function isEventName(value: unknown): value is EventName {
  return typeof value === 'string' && eventNameSet.has(value);
}

/**
 * 例外から、記録してよい項目（名前の列挙値と理由コード）だけを作る。
 * メッセージとスタックは読まない。Error でない値の名前は `Unknown` になる。
 */
export function errorFields(
  thrown: unknown,
  reason: ErrorReason = 'unknown',
): EventFields['error'] {
  let name: ErrorName;
  try {
    // name が getter で、読むと投げることがある
    const raw = thrown instanceof Error ? thrown.name : 'Unknown';
    name = ERROR_NAMES.find((n) => n === raw) ?? 'Unknown';
  } catch {
    name = 'Unknown';
  }
  return { name, reason };
}
