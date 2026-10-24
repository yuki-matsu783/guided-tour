/**
 * 取り込み済みツアーのデータの削除（`tours`・全版の `files`・`meta.totalBytes`）。
 * 取り込みと同じ容量の数え方で、削除したツアーの分を合計から引く。
 */
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

const TotalOnlySchema = TourRecordSchema.pick({ totalBytes: true });

/** 削除したら true。取り込み済みがなければ false。 */
export async function removeTourData(db: IDBDatabase, tourId: string): Promise<boolean> {
  return withTx(db, [STORE.tours, STORE.files, STORE.meta], 'readwrite', async (tx) => {
    const tours = tx.objectStore(STORE.tours);
    const old = TotalOnlySchema.safeParse(await requestToPromise(tours.get(tourId)));
    if (!old.success) return false;
    const writes: Promise<unknown>[] = [requestToPromise(tours.delete(tourId))];
    const files = tx.objectStore(STORE.files);
    writes.push(
      forEachCursor(files.index(INDEX.filesByTour).openCursor(tourId), (cursor) => {
        cursor.delete();
        return true;
      }),
    );
    const meta = tx.objectStore(STORE.meta);
    const row = MetaRecordSchema.safeParse(await requestToPromise(meta.get(TOTAL_BYTES_KEY)));
    const used = row.success ? row.data.value : 0;
    writes.push(requestToPromise(meta.put({ key: TOTAL_BYTES_KEY, value: Math.max(0, used - old.data.totalBytes) })));
    await Promise.all(writes);
    return true;
  });
}
