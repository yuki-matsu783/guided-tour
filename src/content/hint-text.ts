/**
 * 完了の目安の状態と、吹き出し・ミニガイドに出す日本語の文言。
 * 状態の優先順位は、確認の停止、確認できない、満たした、まだ、の順。
 */
import type { Hint } from '../shared/messages/index.ts';

export type HintKind = 'none' | 'met' | 'unmet' | 'unsupported' | 'stopped';

export const TEXT_MET = '次へ進めます';
export const TEXT_UNMET_DEFAULT = 'まだ完了の目安を満たしていません';
export const TEXT_UNSUPPORTED = 'この項目は確認できません';
export const TEXT_STOPPED = '確認を停止中';
export const TEXT_FALLBACK_DEFAULT = '対象が見つかりません。説明に沿って操作してください';

/** `hasGoal` は、完了の目安があるか。無ければ状態は出さない。 */
export function hintKind(hasGoal: boolean, hint: Hint): HintKind {
  if (!hasGoal) return 'none';
  if (hint.stopped) return 'stopped';
  if (hint.unsupported) return 'unsupported';
  if (hint.met) return 'met';
  return 'unmet';
}

/** `unmetHint` は、ツアーが書いた未達成の案内（`done.hint`）。 */
export function hintText(kind: HintKind, unmetHint: string | undefined): string | null {
  switch (kind) {
    case 'none':
      return null;
    case 'met':
      return TEXT_MET;
    case 'unmet':
      return unmetHint !== undefined && unmetHint !== '' ? unmetHint : TEXT_UNMET_DEFAULT;
    case 'unsupported':
      return TEXT_UNSUPPORTED;
    case 'stopped':
      return TEXT_STOPPED;
  }
}
