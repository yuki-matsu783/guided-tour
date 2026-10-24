/**
 * IndexedDB `guided-tour` を開く。初回（版 0 → 1）にストアと索引を作る。
 * factory を渡せば試験用の実装に差し替えられる。他の接続が版を上げに来たら自分から閉じる。
 */
import { DB_NAME, DB_VERSION, INDEX, STORE } from './schema.ts';

function createStores(db: IDBDatabase): void {
  const names = new Set(db.objectStoreNames);
  if (!names.has(STORE.tours)) db.createObjectStore(STORE.tours, { keyPath: 'id' });
  if (!names.has(STORE.files)) {
    const files = db.createObjectStore(STORE.files, { keyPath: ['tourId', 'hash', 'path'] });
    files.createIndex(INDEX.filesByTour, 'tourId');
  }
  if (!names.has(STORE.meta)) db.createObjectStore(STORE.meta, { keyPath: 'key' });
  if (!names.has(STORE.logs)) {
    const logs = db.createObjectStore(STORE.logs, { keyPath: 'id', autoIncrement: true });
    logs.createIndex(INDEX.logsByTs, 'ts');
  }
  if (!names.has(STORE.diagnostics)) {
    const diagnostics = db.createObjectStore(STORE.diagnostics, {
      keyPath: ['tourId', 'stepId', 'reason'],
    });
    diagnostics.createIndex(INDEX.diagnosticsByTour, 'tourId');
    diagnostics.createIndex(INDEX.diagnosticsByLastAt, 'lastAt');
  }
}

export function openDb(factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      createStores(request.result);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
      };
      resolve(db);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('indexeddb open failed'));
    };
    request.onblocked = () => {
      reject(new Error('indexeddb open blocked'));
    };
  });
}
