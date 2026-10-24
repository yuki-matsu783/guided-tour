/** 画面に出す日時・出所などの文言の整形。 */
import type { TourSource } from '../shared/messages/index.ts';

export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export const SOURCE_LABEL = {
  bundled: '同梱',
  imported: '取り込み',
} as const satisfies Record<TourSource, string>;
