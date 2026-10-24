/**
 * 取り込みのテストが共有する部品（依存の組み立て、DB の読み出し・スナップショット、資料の補助）。
 * 製品のコードからは使わない。
 */
import { IDBFactory } from 'fake-indexeddb';
import { vi } from 'vitest';
import type { Bytes } from '../../core/package/index.ts';
import { utf8 } from '../../core/package/fixtures/builders.ts';
import {
  FileRecordSchema,
  MetaRecordSchema,
  STORE,
  TOTAL_BYTES_KEY,
  TourRecordSchema,
  openDb,
  readAll,
  requestToPromise,
  withTx,
} from '../../shared/db/index.ts';
import type { FileRecord, TourRecord } from '../../shared/db/index.ts';
import type { CatalogChange, ImportDeps, OverwriteRequest } from './types.ts';

export const MB = 1024 * 1024;

export interface Env {
  factory: IDBFactory;
  db: IDBDatabase;
  deps: ImportDeps;
  confirm: ReturnType<typeof vi.fn<(request: OverwriteRequest) => Promise<boolean>>>;
  notify: ReturnType<typeof vi.fn<(change: CatalogChange) => Promise<void>>>;
}

export async function setup(overrides: Partial<ImportDeps> = {}): Promise<Env> {
  const factory = new IDBFactory();
  const db = await openDb(factory);
  const confirm = vi.fn<(request: OverwriteRequest) => Promise<boolean>>(() => Promise.resolve(true));
  const notify = vi.fn<(change: CatalogChange) => Promise<void>>(() => Promise.resolve());
  const deps: ImportDeps = {
    db,
    confirmOverwrite: confirm,
    getBundledTourIds: () => [],
    getRunningTourId: () => null,
    notifyCatalogChanged: notify,
    now: () => 1_700_000_000_000,
    unzip: { sliceMs: 1000 },
    ...overrides,
  };
  return { factory, db, deps, confirm, notify };
}

export interface Snapshot {
  tours: TourRecord[];
  files: { key: string; size: number; mime: string; width?: number; height?: number }[];
  total: number | null;
}

/** tours・files・meta の中身（ファイルは鍵・サイズ・MIME・寸法）を読む。 */
export async function snapshot(db: IDBDatabase): Promise<Snapshot> {
  return withTx(db, [STORE.tours, STORE.files, STORE.meta], 'readonly', async (tx) => {
    const tours = await readAll(tx.objectStore(STORE.tours), TourRecordSchema);
    const files = await readAll(tx.objectStore(STORE.files), FileRecordSchema);
    const meta: unknown = await requestToPromise(tx.objectStore(STORE.meta).get(TOTAL_BYTES_KEY));
    const parsed = MetaRecordSchema.safeParse(meta);
    return {
      tours,
      files: files.map((f) => ({
        key: `${f.tourId}/${f.hash}/${f.path}`,
        size: f.size,
        mime: f.mime,
        ...(f.width === undefined ? {} : { width: f.width }),
        ...(f.height === undefined ? {} : { height: f.height }),
      })),
      total: parsed.success ? parsed.data.value : null,
    };
  });
}

export async function readFiles(db: IDBDatabase): Promise<FileRecord[]> {
  return withTx(db, STORE.files, 'readonly', (tx) => readAll(tx.objectStore(STORE.files), FileRecordSchema));
}

export async function setTotal(db: IDBDatabase, value: number): Promise<void> {
  await withTx(db, STORE.meta, 'readwrite', async (tx) => {
    await requestToPromise(tx.objectStore(STORE.meta).put({ key: TOTAL_BYTES_KEY, value }));
  });
}

/** 取り込み済みの DB が空（tours・files が0件、meta.totalBytes が未設定か 0）か。 */
export async function isEmpty(db: IDBDatabase): Promise<boolean> {
  const s = await snapshot(db);
  return s.tours.length === 0 && s.files.length === 0 && (s.total === null || s.total === 0);
}

/** YAML のテキストを、末尾のコメントでちょうど `size` バイトにする。 */
export function padYaml(text: string, size: number): string {
  const needed = size - utf8(text).length;
  if (needed < 0) throw new Error('padYaml: すでに大きい');
  if (needed === 0) return text;
  if (needed === 1) return `${text}\n`;
  return `${text}\n#${'a'.repeat(needed - 2)}`;
}

export function file(name: string, content: Bytes | string): File {
  return new File([content], name);
}
