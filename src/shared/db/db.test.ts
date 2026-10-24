/**
 * IndexedDB の定義のテスト（ストア・索引・鍵・補助関数）。
 */
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { DB_NAME, DB_VERSION, INDEX, STORE, openDb, requestToPromise, withTx } from './index.ts';

describe('openDb', () => {
  it('名前・版・5つのストアと索引ができる', async () => {
    const db = await openDb(new IDBFactory());
    expect(db.name).toBe(DB_NAME);
    expect(db.version).toBe(DB_VERSION);
    expect([...db.objectStoreNames].sort()).toEqual(
      ['diagnostics', 'files', 'logs', 'meta', 'tours'],
    );
    await withTx(db, Object.values(STORE), 'readonly', (tx) => {
      expect(tx.objectStore(STORE.tours).keyPath).toBe('id');
      expect(tx.objectStore(STORE.files).keyPath).toEqual(['tourId', 'hash', 'path']);
      expect([...tx.objectStore(STORE.files).indexNames]).toEqual([INDEX.filesByTour]);
      expect(tx.objectStore(STORE.meta).keyPath).toBe('key');
      expect(tx.objectStore(STORE.logs).autoIncrement).toBe(true);
      expect([...tx.objectStore(STORE.logs).indexNames]).toEqual([INDEX.logsByTs]);
      expect(tx.objectStore(STORE.diagnostics).keyPath).toEqual(['tourId', 'stepId', 'reason']);
      expect([...tx.objectStore(STORE.diagnostics).indexNames].sort()).toEqual(
        [INDEX.diagnosticsByLastAt, INDEX.diagnosticsByTour].sort(),
      );
      return Promise.resolve();
    });
  });

  it('開き直しても既存のデータが残る', async () => {
    const factory = new IDBFactory();
    const first = await openDb(factory);
    await withTx(first, STORE.meta, 'readwrite', async (tx) => {
      await requestToPromise(tx.objectStore(STORE.meta).put({ key: 'totalBytes', value: 5 }));
    });
    first.close();
    const second = await openDb(factory);
    const row: unknown = await withTx(second, STORE.meta, 'readonly', (tx) =>
      requestToPromise(tx.objectStore(STORE.meta).get('totalBytes')),
    );
    expect(row).toEqual({ key: 'totalBytes', value: 5 });
  });
});

describe('withTx', () => {
  it('fn が失敗したらトランザクションを中止し、同じ例外を投げる', async () => {
    const db = await openDb(new IDBFactory());
    const boom = new Error('boom');
    await expect(
      withTx(db, STORE.meta, 'readwrite', async (tx) => {
        await requestToPromise(tx.objectStore(STORE.meta).put({ key: 'a', value: 1 }));
        throw boom;
      }),
    ).rejects.toBe(boom);
    const rows: unknown = await withTx(db, STORE.meta, 'readonly', (tx) =>
      requestToPromise(tx.objectStore(STORE.meta).getAll()),
    );
    expect(rows).toEqual([]);
  });
});
