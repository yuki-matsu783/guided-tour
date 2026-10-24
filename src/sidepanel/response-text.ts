/**
 * バックグラウンドの応答（`OpResponse`）を、利用者に見せる日本語の文言にする。
 * 成功（done）と、確認が要る応答（confirmBind）は文言を持たない（null）。
 * 拒否の理由ごとの文言は表で持ち、理由を足すと表の更新漏れが型エラーになる。
 */
import { DISCARD_REASONS } from '../shared/logger/index.ts';
import { REJECT_REASONS } from '../shared/messages/index.ts';
import type { OpResponse } from '../shared/messages/index.ts';

type RejectReason = (typeof REJECT_REASONS)[number];
type DiscardReason = (typeof DISCARD_REASONS)[number];

const REJECT_TEXT = {
  busy: '別の操作を処理中です。少し待ってから、もう一度操作してください',
  notRunning: 'ツアーは実行中ではありません',
  notPaused: 'ツアーは一時中断中ではありません',
  notResumable: 'このツアーは再開できません',
  notRestartable: 'このツアーは最初からやり直せません',
  notOverwritten: 'ツアーは上書きされていません',
  tourNotFound: 'ツアーが見つかりません。一覧を再読み込みしてください',
  permissionNotRestored: 'サイトへのアクセスがまだ許可されていません。許可してから再開してください',
  outsideOrigins: '開こうとしたページは、ツアーに書かれたサイトの外にあります',
  noPageStep: 'このステップは、ブラウザの外などで行う手順です',
  notBound: 'このステップの役割のタブが、まだ対応付けられていません',
  noOpenUrl: 'このステップには、開くページが定められていません',
  openFailed: 'ページを開けませんでした',
  tabBoundToOtherRole: '今のタブは別の役割に使われています。「新しいタブで開く」を使ってください',
  internal: '内部のエラーが起きました。もう一度操作してください',
} as const satisfies Record<RejectReason, string>;

const STALE_TEXT = '古い表示からの操作だったため、取り消しました。表示を更新しました';

const DISCARD_TEXT = {
  staleSession: STALE_TEXT,
  staleGen: STALE_TEXT,
  duplicateOp: null,
  staleReport: null,
  outOfRange: STALE_TEXT,
  senderMismatch: null,
} as const satisfies Record<DiscardReason, string | null>;

/** 必要なサイトを並べた文言。 */
export function permissionMissingText(origins: readonly string[]): string {
  return `次のサイトへのアクセスが許可されていません: ${origins.join('、')}`;
}

export function describeResponse(response: OpResponse): string | null {
  switch (response.status) {
    case 'done':
    case 'confirmBind':
      return null;
    case 'discarded':
      return DISCARD_TEXT[response.reason];
    case 'unhandled':
      return '操作を処理できませんでした。サイドパネルを開き直してください';
    case 'rejected':
      if (response.reason === 'versionTooLow') {
        return `拡張機能のバージョンが足りないため開始できません（現在 ${response.current}、必要 ${response.required} 以上）`;
      }
      if (response.reason === 'permissionMissing') return permissionMissingText(response.origins);
      return REJECT_TEXT[response.reason];
  }
}
