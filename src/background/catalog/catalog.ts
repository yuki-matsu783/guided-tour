/**
 * ツアー管理。同梱ツアーと取り込んだツアー（IndexedDB の `tours`）をまとめた一覧をメモリに持つ。
 * 同じ ID は取り込み版を優先し、同梱版が隠れていれば `shadowsBundled` を立てる。
 * 取り込んだツアーは、保存済みの `compiled` を `CompiledTourSchema` で検証し直して使う（YAML は解析しない）。
 * 検証に通らないものは一覧から外し、他には影響させない。
 * キャッシュは `reload()`・`remove()` で捨てる。保存済みのデータだけから組み立て直せる。
 * `list()`・`get()` のたびに、`tours` の `id` と `hash` だけを読み、キャッシュを作ったときと違えば組み立て直す
 * （別の場所での取り込み・上書きで、キャッシュが古いままにならないため）。
 * 固定した `hash` の内容は、現在の版と `hash` が同じときだけ返す（旧版の内容は保存していない）。
 */
import { z } from 'zod';
import { CompiledTourSchema } from '../../core/tour/index.ts';
import {
  INDEX,
  MetaRecordSchema,
  STORE,
  TOTAL_BYTES_KEY,
  TourRecordSchema,
  forEachCursor,
  requestToPromise,
  withTx,
} from '../../shared/db/index.ts';
import type { TourRecord } from '../../shared/db/index.ts';
import type { Diagnostics } from '../diagnostics/index.ts';
import type { CatalogEntry, CatalogPort, CatalogTour } from '../ports.ts';
import type { BundledTour } from './bundled.ts';

export interface CatalogDeps {
  getDb: () => Promise<IDBDatabase>;
  loadBundled: () => Promise<BundledTour[]>;
  diagnostics: Pick<Diagnostics, 'removeTour'>;
}

function importedTour(record: TourRecord): CatalogTour | null {
  const parsed = CompiledTourSchema.safeParse(record.compiled);
  if (!parsed.success || parsed.data.id !== record.id) return null;
  return { tour: parsed.data, hash: record.hash, source: 'imported' };
}

const IdHashSchema = z.object({ id: z.string(), hash: z.string() });

export function createCatalog(deps: CatalogDeps): CatalogPort {
  /** `signature` は、組み立てたときの `tours` の `id` と `hash` の一覧。 */
  let cache: { readonly signature: string; readonly entries: Promise<CatalogEntry[]> } | null = null;

  /** `tours` の `id` と `hash` だけを集め、並べ順に依らない文字列にする。 */
  async function readSignature(): Promise<string> {
    const db = await deps.getDb();
    const pairs: string[] = [];
    await withTx(db, STORE.tours, 'readonly', (tx) =>
      forEachCursor(tx.objectStore(STORE.tours).openCursor(), (cursor) => {
        const parsed = IdHashSchema.safeParse(cursor.value);
        pairs.push(parsed.success ? JSON.stringify([parsed.data.id, parsed.data.hash]) : 'invalid');
        return true;
      }),
    );
    return pairs.sort().join('\n');
  }

  async function readImported(): Promise<CatalogTour[]> {
    const db = await deps.getDb();
    const rows = await withTx(db, STORE.tours, 'readonly', (tx) => {
      const request = tx.objectStore(STORE.tours).getAll();
      return requestToPromise(request);
    });
    const records = rows.flatMap((row: unknown) => {
      const parsed = TourRecordSchema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    });
    records.sort((a, b) => b.importedAt - a.importedAt);
    return records.flatMap((r) => {
      const tour = importedTour(r);
      return tour === null ? [] : [tour];
    });
  }

  async function build(): Promise<CatalogEntry[]> {
    const [bundled, imported] = await Promise.all([
      deps.loadBundled().catch((): BundledTour[] => []),
      readImported(),
    ]);
    const bundledIds = new Set(bundled.map((b) => b.tour.id));
    const importedIds = new Set(imported.map((i) => i.tour.id));
    const entries: CatalogEntry[] = [];
    for (const b of bundled) {
      if (importedIds.has(b.tour.id)) continue;
      entries.push({ tour: b.tour, hash: b.hash, source: 'bundled', shadowsBundled: false });
    }
    for (const i of imported) {
      entries.push({ ...i, shadowsBundled: bundledIds.has(i.tour.id) });
    }
    return entries;
  }

  async function entries(): Promise<CatalogEntry[]> {
    let signature: string | null;
    try {
      signature = await readSignature();
    } catch {
      signature = null;
    }
    // 読めなかったときは、あるキャッシュで続ける（無ければ組み立てて、その失敗を返す）
    if (cache !== null && (signature === null || cache.signature === signature)) return cache.entries;
    const pending = build();
    const slot = { signature: signature ?? '', entries: pending };
    cache = slot;
    // 失敗は残さず、次の呼び出しで組み立て直す
    pending.catch(() => {
      if (cache === slot) cache = null;
    });
    return pending;
  }

  async function get(tourId: string): Promise<CatalogTour | null> {
    const found = (await entries()).find((e) => e.tour.id === tourId);
    return found ?? null;
  }

  async function remove(tourId: string): Promise<boolean> {
    const db = await deps.getDb();
    const removed = await withTx(db, [STORE.tours, STORE.files, STORE.meta], 'readwrite', async (tx) => {
      const tours = tx.objectStore(STORE.tours);
      const found: unknown = await requestToPromise(tours.get(tourId));
      const parsed = TourRecordSchema.safeParse(found);
      if (!parsed.success) return false;
      const files = tx.objectStore(STORE.files).index(INDEX.filesByTour);
      await forEachCursor(files.openCursor(tourId), (cursor) => {
        cursor.delete();
        return true;
      });
      await requestToPromise(tours.delete(tourId));
      const meta = tx.objectStore(STORE.meta);
      const total: unknown = await requestToPromise(meta.get(TOTAL_BYTES_KEY));
      const parsedTotal = MetaRecordSchema.safeParse(total);
      const current = parsedTotal.success ? parsedTotal.data.value : 0;
      await requestToPromise(
        meta.put({ key: TOTAL_BYTES_KEY, value: Math.max(0, current - parsed.data.totalBytes) }),
      );
      return true;
    });
    cache = null;
    if (!removed) return false;
    try {
      await deps.diagnostics.removeTour(tourId);
    } catch {
      // 保守記録の削除に失敗しても、ツアーの削除は完了している（記録は件数の上限で古いものから消える）
    }
    return true;
  }

  return {
    list: entries,
    get,
    async getPinned(tourId, hash) {
      const current = await get(tourId);
      return current !== null && current.hash === hash ? current : null;
    },
    remove,
    reload() {
      cache = null;
      return Promise.resolve();
    },
  };
}
