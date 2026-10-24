/**
 * 操作ごとの受け付け条件の表。状態管理が、識別子の確認にこの表を使う。
 * `session` は `sessionId` の一致、`sessionGen` は `sessionId` と `gen` の一致が要る。
 * `sessionId` を持つ操作を足すと、この表に行がないため型エラーになる。
 */
import type { PanelToBg } from './panel-to-bg.ts';

/** `sessionId` を持つ操作の `type`。 */
export type SessionOpType = Extract<PanelToBg, { sessionId: unknown }>['type'];

export type OpRequirement = 'session' | 'sessionGen';

export const OP_REQUIREMENTS = {
  STOP: 'session',
  PAUSE: 'session',
  RESUME: 'session',
  RESTART: 'session',
  RESUME_NEW: 'session',
  SET_OVERLAY: 'session',
  GOTO: 'sessionGen',
  BIND_TAB: 'sessionGen',
  OPEN_IN: 'sessionGen',
  FOCUS_ROLE: 'sessionGen',
  RECHECK: 'sessionGen',
  SCROLL_TO_TARGET: 'sessionGen',
} as const satisfies Record<SessionOpType, OpRequirement>;
