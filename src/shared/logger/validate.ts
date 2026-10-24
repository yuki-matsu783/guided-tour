/**
 * ログの項目と1行分の検査。ロガー本体と、受信側（バックグラウンド）の再検査が同じ関数を使う。
 * 通らなかったものは内容を返さず、出来事の名前（登録済みなら）だけを返す。
 */
import { z } from 'zod';
import { eventSchemas, isEventName, type EventName } from './events.ts';
import { CtxSchema, LevelSchema, type Ctx, type Level } from './primitives.ts';

export interface LogEntry {
  ts: number;
  level: Level;
  ctx: Ctx;
  event: EventName;
  fields: Record<string, unknown>;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; event: EventName | 'unknown' };

const FieldsSchema = z.record(z.string(), z.unknown());
const EnvelopeSchema = z.object({
  ts: z.number(),
  level: LevelSchema,
  ctx: CtxSchema,
  event: z.string(),
  fields: z.unknown(),
});

/** 出来事名と項目をスキーマで検査する。 */
export function checkFields(
  event: string,
  fields: unknown,
): Checked<{ event: EventName; fields: Record<string, unknown> }> {
  if (!isEventName(event)) return { ok: false, event: 'unknown' };
  const schema: z.ZodType = eventSchemas[event];
  const parsed = schema.safeParse(fields);
  if (!parsed.success) return { ok: false, event };
  const record = FieldsSchema.safeParse(parsed.data);
  if (!record.success) return { ok: false, event };
  return { ok: true, value: { event, fields: record.data } };
}

/** 外から来た1行分（ts・level・ctx・event・fields）を検査する。 */
export function parseLogEntry(raw: unknown): Checked<LogEntry> {
  const envelope = EnvelopeSchema.safeParse(raw);
  if (!envelope.success) return { ok: false, event: 'unknown' };
  const { ts, level, ctx } = envelope.data;
  const checked = checkFields(envelope.data.event, envelope.data.fields);
  if (!checked.ok) return checked;
  return { ok: true, value: { ts, level, ctx, ...checked.value } };
}
