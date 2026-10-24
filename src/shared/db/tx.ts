/**
 * IndexedDB の要求・カーソル・トランザクションを Promise で扱う小さな補助。
 * トランザクションの中で IndexedDB 以外の非同期処理を待つと、自動で確定してしまう点に注意する。
 */
import type { z } from 'zod';

export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('indexeddb request failed'));
    };
  });
}

/**
 * カーソルを順に訪ねる。visit が true を返す間だけ次へ進み、false で止める。
 * visit の中で `cursor.delete()` などをしてよい（同じトランザクションの中）。
 */
export function forEachCursor(
  request: IDBRequest<IDBCursorWithValue | null>,
  visit: (cursor: IDBCursorWithValue) => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || !visit(cursor)) {
        resolve();
        return;
      }
      cursor.continue();
    };
    request.onerror = () => {
      reject(request.error ?? new Error('indexeddb cursor failed'));
    };
  });
}

/** 全件（または query に合うもの）を読み、スキーマで検証して返す。 */
export async function readAll<S extends z.ZodType>(
  source: IDBObjectStore | IDBIndex,
  schema: S,
  query?: IDBValidKey,
): Promise<z.output<S>[]> {
  const rows = await requestToPromise(source.getAll(query));
  return rows.map((row: unknown) => schema.parse(row));
}

/**
 * トランザクションを開いて fn を実行し、確定まで待つ。fn が失敗したら中止して同じ例外を投げる。
 */
export async function withTx<T>(
  db: IDBDatabase,
  stores: string | string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  const tx = db.transaction(stores, mode);
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error('indexeddb transaction failed'));
    };
    tx.onabort = () => {
      reject(tx.error ?? new Error('indexeddb transaction aborted'));
    };
  });
  // fn の失敗で先に中止したとき、done の拒否が未処理にならないようにする
  done.catch(() => undefined);
  let result: T;
  try {
    result = await fn(tx);
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // すでに終わっている
    }
    throw error;
  }
  await done;
  return result;
}
