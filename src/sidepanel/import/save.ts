/**
 * 取り込んだツアーの保存。1つの書き込みトランザクションの中で、合計容量を予約し、新版のファイルを書き、
 * `tours` の向き先を新版に切り替え、旧版のファイルを消す。途中で失敗したら全体が巻き戻る。
 * IndexedDB のトランザクションは重なる範囲を順に処理するため、同時に取り込んでも合計容量の上限を超えない。
 */
import { PACKAGE_LIMITS } from '../../core/package/index.ts';
import type { PackageFile } from '../../core/package/index.ts';
import type { Tour } from '../../core/tour/index.ts';
import {
  FileRecordSchema,
  INDEX,
  MetaRecordSchema,
  STORE,
  TOTAL_BYTES_KEY,
  TourRecordSchema,
  forEachCursor,
  requestToPromise,
  withTx,
} from '../../shared/db/index.ts';
import type { FileRecord, MetaRecord, TourRecord } from '../../shared/db/index.ts';

export interface SaveInput {
  /** パス解決済みのツアー（`compiled` に保存する） */
  tour: Tour;
  yamlText: string;
  fileName: string;
  files: readonly PackageFile[];
  hash: string;
  importedAt: number;
}

export type SaveOutcome = { ok: true } | { ok: false; reason: 'quota' };

const encoder = new TextEncoder();

/** 保存するツアーの容量。保存するファイルの `size` の合計と、YAML 本文のバイト数。 */
export function tourTotalBytes(yamlText: string, files: readonly PackageFile[]): number {
  return files.reduce((sum, f) => sum + f.bytes.length, encoder.encode(yamlText).length);
}

const OldTourSchema = TourRecordSchema.pick({ hash: true, totalBytes: true });

export async function saveTour(db: IDBDatabase, input: SaveInput): Promise<SaveOutcome> {
  const tourId = input.tour.id;
  const totalBytes = tourTotalBytes(input.yamlText, input.files);
  return withTx(db, [STORE.tours, STORE.files, STORE.meta], 'readwrite', async (tx) => {
    const tours = tx.objectStore(STORE.tours);
    const files = tx.objectStore(STORE.files);
    const meta = tx.objectStore(STORE.meta);

    // 容量の予約。旧版の分は差し引いて判定する
    const metaRow = MetaRecordSchema.safeParse(await requestToPromise(meta.get(TOTAL_BYTES_KEY)));
    const old = OldTourSchema.safeParse(await requestToPromise(tours.get(tourId)));
    const used = metaRow.success ? metaRow.data.value : 0;
    const next = used - (old.success ? old.data.totalBytes : 0) + totalBytes;
    if (next > PACKAGE_LIMITS.totalBytes) return { ok: false, reason: 'quota' };

    // 新版のファイルを書く。要求は先にまとめて出し、途中で例外が出ても未処理の拒否を残さない
    const writes: Promise<unknown>[] = [];
    try {
      for (const file of input.files) {
        const record: FileRecord = {
          tourId,
          hash: input.hash,
          path: file.path,
          blob: new Blob([file.bytes], { type: file.mime }),
          mime: file.mime,
          size: file.bytes.length,
          ...(file.width === undefined ? {} : { width: file.width }),
          ...(file.height === undefined ? {} : { height: file.height }),
        };
        writes.push(requestToPromise(files.put(record)));
      }

      // 向き先を新版に切り替える
      const record: TourRecord = {
        id: tourId,
        hash: input.hash,
        compiled: input.tour,
        yamlText: input.yamlText,
        fileName: input.fileName,
        importedAt: input.importedAt,
        totalBytes,
      };
      writes.push(requestToPromise(tours.put(record)));

      // 旧版のファイルを消す（同じ内容の取り込みでは、いま書いた分を消さない）
      if (old.success && old.data.hash !== input.hash) {
        const oldHash = old.data.hash;
        writes.push(
          forEachCursor(files.index(INDEX.filesByTour).openCursor(tourId), (cursor) => {
            const row = FileRecordSchema.pick({ hash: true }).safeParse(cursor.value);
            if (row.success && row.data.hash === oldHash) cursor.delete();
            return true;
          }),
        );
      }

      const total: MetaRecord = { key: TOTAL_BYTES_KEY, value: Math.max(0, next) };
      writes.push(requestToPromise(meta.put(total)));
      await Promise.all(writes);
    } catch (error) {
      for (const pending of writes) pending.catch(() => undefined);
      throw error;
    }
    return { ok: true };
  });
}
