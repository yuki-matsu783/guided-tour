/**
 * 技術検証 1 用。IndexedDB に Blob を書く・読む。サイドパネル（拡張機能のページ）と
 * Service Worker の両方に同じコードを載せ、同じオリジンのデータを共有できるかを確かめる。
 */
const DB_NAME = 'tech-check';
const STORE = 'blobs';

export interface BlobSummary {
  readonly key: string;
  readonly size: number;
  readonly type: string;
  readonly head: readonly number[];
  readonly checksum: number;
  readonly context: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(req.error ?? new Error('open failed'));
    };
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error('tx failed'));
    };
    tx.onabort = () => {
      reject(tx.error ?? new Error('tx aborted'));
    };
  });
}

/** 指定サイズの Blob（バイト値は i % 251）を書く。 */
export async function idbWriteBlob(key: string, size: number, context: string): Promise<BlobSummary> {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = i % 251;
  const blob = new Blob([bytes], { type: 'application/x-tech-check' });
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put(blob, key);
  await done(tx);
  db.close();
  return summarize(key, blob, context);
}

async function summarize(key: string, blob: Blob, context: string): Promise<BlobSummary> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let checksum = 0;
  for (const b of bytes) checksum = (checksum + b) % 1_000_000_007;
  return { key, size: blob.size, type: blob.type, head: Array.from(bytes.subarray(0, 8)), checksum, context };
}

/** 書かれた Blob を読み、概要を返す。無ければ null。 */
export async function idbReadBlob(key: string, context: string): Promise<BlobSummary | null> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readonly');
  const req = tx.objectStore(STORE).get(key);
  await done(tx);
  db.close();
  const value: unknown = req.result;
  if (!(value instanceof Blob)) return null;
  return summarize(key, value, context);
}
