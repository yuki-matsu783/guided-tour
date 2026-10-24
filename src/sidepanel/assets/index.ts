/**
 * 説明文と補足画像の参照を、表示できる URL に変える（画像の URL 管理）。
 * 同梱は `getUrl`、data URL はそのまま、取り込みは保存済みの Blob から `createObjectUrl` で作る。
 * `(tourId, hash, path)` ごとに結果を使い回し、表示するツアーや `hash` が変わったとき（`keep`）と
 * サイドパネルを閉じるとき（`revokeAll`）に、作った blob URL を解放する。
 * 解決できないもの（Blob が無いなど）は null を返し、呼び出し側が代替文を出す。
 */
import { isDataUrl } from '../../core/package/index.ts';
import type { TourSource } from '../../shared/messages/index.ts';

export interface AssetDeps {
  getUrl(path: string): string;
  readStoredFile(tourId: string, hash: string, path: string): Promise<Blob | null>;
  createObjectUrl(blob: Blob): string;
  revokeObjectUrl(url: string): void;
  /** そのツアーの出所。分からなければ null（取り込みとして扱わず、解決しない）。 */
  sourceOf(tourId: string): TourSource | null;
}

export interface Assets {
  /** `path` はパッケージ内のパス（または data URL）。表示できる URL か null。 */
  resolve(tourId: string, hash: string, path: string): Promise<string | null>;
  /** 指定したツアー・`hash` 以外の blob URL を解放する。`null` なら全部。 */
  keep(current: { tourId: string; hash: string } | null): void;
  revokeAll(): void;
}

interface Entry {
  tourId: string;
  hash: string;
  url: Promise<{ url: string | null; owned: boolean }>;
}

const KEY_SEPARATOR = '\u0000';

export function createAssets(deps: AssetDeps): Assets {
  const entries = new Map<string, Entry>();

  const make = async (
    tourId: string,
    hash: string,
    path: string,
  ): Promise<{ url: string | null; owned: boolean }> => {
    if (isDataUrl(path)) return { url: path, owned: false };
    if (deps.sourceOf(tourId) === 'bundled') {
      return { url: deps.getUrl(`tours/${tourId}/${path}`), owned: false };
    }
    try {
      const blob = await deps.readStoredFile(tourId, hash, path);
      return blob === null ? { url: null, owned: false } : { url: deps.createObjectUrl(blob), owned: true };
    } catch {
      return { url: null, owned: false };
    }
  };

  const release = (entry: Entry): void => {
    void entry.url.then(({ url, owned }) => {
      if (owned && url !== null) deps.revokeObjectUrl(url);
    });
  };

  return {
    async resolve(tourId, hash, path) {
      // 出所が分からない間は、結果を覚えずに解決しない
      if (!isDataUrl(path) && deps.sourceOf(tourId) === null) return null;
      // 同じ参照は同じ Promise を返す（処理中の重複も1回にまとめる）
      const key = [tourId, hash, path].join(KEY_SEPARATOR);
      let entry = entries.get(key);
      if (entry === undefined) {
        entry = { tourId, hash, url: make(tourId, hash, path) };
        entries.set(key, entry);
      }
      return (await entry.url).url;
    },
    keep(current) {
      for (const [key, entry] of entries) {
        if (current !== null && entry.tourId === current.tourId && entry.hash === current.hash) continue;
        release(entry);
        entries.delete(key);
      }
    },
    revokeAll() {
      for (const entry of entries.values()) release(entry);
      entries.clear();
    },
  };
}
