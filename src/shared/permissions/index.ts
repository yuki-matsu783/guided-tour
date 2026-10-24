/**
 * ツアーの `origins` から、ホスト単位のマッチパターンを作り、権限の確認・要求・取り消しの監視を行う。
 * パターンは `origins` だけから作る（ステップの URL は使わない）。ポートは捨て、ワイルドカードのホストは作らない。
 * `api` は `chrome.permissions` と同じ形の注入。テストでは偽物を渡す。
 */
import type { Tour } from '../../core/tour/index.ts';

/** `origins` だけを読む。ツアー全体を渡してもよい。 */
export type TourOrigins = Pick<Tour, 'origins'>;

export interface PermissionsQuery {
  origins: string[];
}

/** `chrome.permissions.onRemoved` が渡す値のうち、ここで使う項目。 */
export interface RemovedPermissions {
  origins?: string[] | undefined;
}

export interface PermissionsApi {
  contains(query: PermissionsQuery): Promise<boolean>;
  request(query: PermissionsQuery): Promise<boolean>;
  onRemoved: {
    addListener(listener: (removed: RemovedPermissions) => void): void;
    removeListener(listener: (removed: RemovedPermissions) => void): void;
  };
}

/** `origins` の各オリジンから、ホスト単位のパターン（`https://host/*`）を作る。重複は除く。 */
export function patternsOf(tour: TourOrigins): string[] {
  const patterns = new Set<string>();
  for (const origin of tour.origins) {
    if (origin.includes('*')) continue;
    try {
      const url = new URL(origin);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      patterns.add(`${url.protocol}//${url.hostname}/*`);
    } catch {
      // 解析できないオリジンはパターンにしない
    }
  }
  return [...patterns];
}

/** このツアーの全パターンの権限があるか。 */
export function has(tour: TourOrigins, api: Pick<PermissionsApi, 'contains'>): Promise<boolean> {
  return api.contains({ origins: patternsOf(tour) }).catch(() => false);
}

/**
 * このツアーのパターンの権限を要求する。許可されたら true。拒否・失敗は false（必要なサイトは `patternsOf` で分かる）。
 * 利用者の操作の中で呼ぶため、await を挟まずに `api.request` を呼ぶ。
 */
export function request(tour: TourOrigins, api: Pick<PermissionsApi, 'request'>): Promise<boolean> {
  let pending: Promise<boolean>;
  try {
    pending = api.request({ origins: patternsOf(tour) });
  } catch {
    return Promise.resolve(false);
  }
  return pending.catch(() => false);
}

/**
 * 権限が取り消されたとき、実行中のツアーのパターンが1つでも失われていれば `onLost` を呼ぶ。
 * 通知の中身（`https://host/*`・`*://host/*`・`<all_urls>` など）には頼らず、通知のたびに `contains` で確かめ直す。
 * 実行中のツアーがないときは何もしない。解除用の関数を返す。
 */
export function watchRemoved(
  api: Pick<PermissionsApi, 'onRemoved' | 'contains'>,
  getRunningTour: () => TourOrigins | null,
  onLost: () => void,
): () => void {
  const listener = (): void => {
    const tour = getRunningTour();
    if (tour === null) return;
    void has(tour, api).then((granted) => {
      if (!granted) onLost();
    });
  };
  api.onRemoved.addListener(listener);
  return () => {
    api.onRemoved.removeListener(listener);
  };
}
