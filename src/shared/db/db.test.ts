/**
 * IndexedDB の定義のテスト（ストア・索引・鍵・補助関数）。
 */
import { IDBDatabase, IDBFactory, IDBVersionChangeEvent } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { DB_NAME, DB_VERSION, INDEX, STORE, forEachCursor, openDb, requestToPromise, withTx } from './index.ts';

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

describe('第1段のレビュー指摘の修正（DB）', () => {
  it('R-LOG-7: onblocked で失敗した後に onsuccess が来たら、その接続を閉じる', async () => {
    const close = vi.spyOn(IDBDatabase.prototype, 'close');
    try {
      class BlockedFactory extends IDBFactory {
        override open(name: string, version?: number): IDBOpenDBRequest {
          const request = super.open(name, version);
          // 実際の open が成功する前に、blocked を通知する（ハンドラが付いた後に届くよう、次の微小タスクで）
          queueMicrotask(() => {
            request.onblocked?.call(request, new IDBVersionChangeEvent('blocked'));
          });
          return request;
        }
      }
      await expect(openDb(new BlockedFactory())).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
    }
  });
});

describe('forEachCursor', () => {
  it('R-LOG-2: visit が例外を投げたら止まって reject し、イベントの中で未処理にならない', async () => {
    const db = await openDb(new IDBFactory());
    await withTx(db, STORE.meta, 'readwrite', async (tx) => {
      await requestToPromise(tx.objectStore(STORE.meta).put({ key: 'a', value: 1 }));
    });
    const boom = new Error('visit が投げた');
    let visited = 0;
    await expect(
      withTx(db, STORE.meta, 'readonly', (tx) =>
        forEachCursor(tx.objectStore(STORE.meta).openCursor(), () => {
          visited += 1;
          throw boom;
        }),
      ),
    ).rejects.toBe(boom);
    expect(visited).toBe(1);
  });
});
