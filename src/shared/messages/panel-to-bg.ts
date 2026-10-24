/**
 * サイドパネル → バックグラウンドのメッセージ。`type` で判別する。
 * `sender.url` の確認は `parse.ts` の `parsePanelToBg` が行う。
 */
import { z } from 'zod';
import { GenSchema, OpIdSchema, SessionIdSchema } from '../ids/index.ts';
import { LogMessageSchema } from './common.ts';
import { GotoSchema, ScrollToTargetSchema, SetOverlaySchema, SetUiSchema } from './operations.ts';

const session = { sessionId: SessionIdSchema, opId: OpIdSchema } as const;
const sessionGen = { ...session, gen: GenSchema } as const;

export const OPEN_IN_MODES = ['current', 'new'] as const;
export const OpenInModeSchema = z.enum(OPEN_IN_MODES);
export type OpenInMode = z.output<typeof OpenInModeSchema>;

export const RESUME_NEW_MODES = ['continue', 'restart'] as const;
export const ResumeNewModeSchema = z.enum(RESUME_NEW_MODES);
export type ResumeNewMode = z.output<typeof ResumeNewModeSchema>;

const tourId = z.string().min(1);

export const PanelToBgSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('GET_STATE') }),
  z.object({ type: z.literal('START'), tourId, resume: z.boolean(), opId: OpIdSchema }),
  GotoSchema,
  z.object({ type: z.literal('PAUSE'), ...session }),
  z.object({ type: z.literal('RESUME'), ...session }),
  z.object({ type: z.literal('STOP'), ...session }),
  z.object({ type: z.literal('RESTART'), ...session }),
  z.object({ type: z.literal('RESUME_NEW'), mode: ResumeNewModeSchema, ...session }),
  z.object({ type: z.literal('BIND_TAB'), tabId: z.int(), force: z.boolean(), ...sessionGen }),
  z.object({ type: z.literal('OPEN_IN'), mode: OpenInModeSchema, ...sessionGen }),
  z.object({ type: z.literal('FOCUS_ROLE'), ...sessionGen }),
  z.object({ type: z.literal('RECHECK'), ...sessionGen }),
  ScrollToTargetSchema,
  SetOverlaySchema,
  SetUiSchema,
  z.object({ type: z.literal('CATALOG_CHANGED'), tourId, hash: z.string().min(1) }),
  z.object({ type: z.literal('REMOVE'), tourId }),
  z.object({ type: z.literal('RELOAD') }),
  z.object({ type: z.literal('GET_DIAGNOSTICS') }),
  z.object({ type: z.literal('EXPORT_LOGS') }),
  z.object({ type: z.literal('CLEAR_LOGS') }),
  LogMessageSchema,
]);
export type PanelToBg = z.output<typeof PanelToBgSchema>;
