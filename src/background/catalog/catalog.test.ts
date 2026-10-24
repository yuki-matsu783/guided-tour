/**
 * ツアー管理のテスト。IndexedDB は fake-indexeddb、同梱ツアーの読み込みは偽物（実体の fetch 版は別に確かめる）。
 * 保守記録は本物の `createDiagnostics` を同じ DB につなぎ、削除が届くことまで確かめる。
 * `CATALOG_CHANGED`・`runtime.onInstalled` の受信は起動側の配線が `reload()` を呼ぶ形なので、
 * ここでは `reload()` でキャッシュが捨てられ、保存済みのデータから組み立て直されることを確かめる。
 */
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseTour } from '../../core/tour/index.ts';
import type { Tour } from '../../core/tour/index.ts';
import { STORE, TOTAL_BYTES_KEY, openDb, requestToPromise, withTx } from '../../shared/db/index.ts';
import type { FileRecord, TourRecord } from '../../shared/db/index.ts';
import { createDiagnostics } from '../diagnostics/index.ts';
import { createCatalog, loadBundledTours, sha256Hex } from './index.ts';
import type { BundledSource, BundledTour } from './index.ts';

function yamlOf(id: string, name = id): string {
  return `schemaVersion: 3
id: ${id}
name: ${name}
origins:
  - https://example.com
steps:
  - id: s1
    title: 一つ目
    url: { origin: "https://example.com" }
`;
}

function tourOf(id: string, name = id): Tour {
  const parsed = parseTour(yamlOf(id, name), 'tour.yaml');
  if (!parsed.ok) throw new Error('fixture invalid');
  return parsed.tour;
}

async function bundledOf(id: string, name = id): Promise<BundledTour> {
  return { tour: tourOf(id, name), hash: await sha256Hex(yamlOf(id, name)) };
}

interface Env {
  db: IDBDatabase;
  bundled: { value: BundledTour[] };
  loadBundled: ReturnType<typeof vi.fn<() => Promise<BundledTour[]>>>;
  catalog: ReturnType<typeof createCatalog>;
  diagnostics: ReturnType<typeof createDiagnostics>;
}

async function makeEnv(): Promise<Env> {
  const db = await openDb(new IDBFactory());
  const bundled: { value: BundledTour[] } = { value: [] };
  const loadBundled = vi.fn<() => Promise<BundledTour[]>>(() => Promise.resolve(bundled.value));
  const diagnostics = createDiagnostics({ getDb: () => Promise.resolve(db) });
  const catalog = createCatalog({ getDb: () => Promise.resolve(db), loadBundled, diagnostics });
  return { db, bundled, loadBundled, catalog, diagnostics };
}

async function putTour(
  db: IDBDatabase,
  id: string,
  over: Partial<TourRecord> & { name?: string } = {},
  files: string[] = [],
): Promise<void> {
  const { name, ...rest } = over;
  const record: TourRecord = {
    id,
    hash: `hash-${id}`,
    compiled: tourOf(id, name ?? id),
    yamlText: yamlOf(id),
    fileName: `${id}.zip`,
    importedAt: 1,
    totalBytes: 100,
    ...rest,
  };
  await withTx(db, [STORE.tours, STORE.files], 'readwrite', async (tx) => {
    await requestToPromise(tx.objectStore(STORE.tours).put(record));
    for (const path of files) {
      const file: FileRecord = { tourId: id, hash: record.hash, path, blob: new Blob(['x']), mime: 'text/plain', size: 1 };
      await requestToPromise(tx.objectStore(STORE.files).put(file));
    }
  });
}

async function setTotal(db: IDBDatabase, value: number): Promise<void> {
  await withTx(db, STORE.meta, 'readwrite', async (tx) => {
    await requestToPromise(tx.objectStore(STORE.meta).put({ key: TOTAL_BYTES_KEY, value }));
  });
}

async function readTotal(db: IDBDatabase): Promise<unknown> {
  return withTx(db, STORE.meta, 'readonly', (tx) => requestToPromise(tx.objectStore(STORE.meta).get(TOTAL_BYTES_KEY)));
}

async function countOf(db: IDBDatabase, store: string): Promise<number> {
  return withTx(db, store, 'readonly', (tx) => requestToPromise(tx.objectStore(store).count()));
}

async function recordDiagnostic(env: Env, tourId: string): Promise<void> {
  await env.diagnostics.record(tourId, 's1', 'sess', 1, {
    found: false,
    tier: null,
    topTier: null,
    reasons: ['missing'],
    counts: [],
  });
}

let env: Env;
beforeEach(async () => {
  env = await makeEnv();
});

describe('一覧', () => {
  it('T-CAT-01: 同梱と取り込みの両方が返る', async () => {
    env.bundled.value = [await bundledOf('b1')];
    await putTour(env.db, 'i1');
    const list = await env.catalog.list();
    expect(list.map((e) => [e.tour.id, e.source]).sort()).toEqual([
      ['b1', 'bundled'],
      ['i1', 'imported'],
    ]);
  });

  it('T-CAT-02 T-CAT-03: 同じ ID は取り込みが優先され、出所が imported、同梱を隠していると分かる', async () => {
    const bundled = await bundledOf('same', '同梱版');
    env.bundled.value = [bundled];
    await putTour(env.db, 'same', { name: '取り込み版', hash: 'imp' });
    const list = await env.catalog.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ source: 'imported', hash: 'imp', shadowsBundled: true });
    expect(list[0]?.tour.name).toBe('取り込み版');
  });

  it('T-CAT-03: 隠していないものは shadowsBundled が偽', async () => {
    env.bundled.value = [await bundledOf('b1')];
    await putTour(env.db, 'i1');
    expect((await env.catalog.list()).map((e) => e.shadowsBundled)).toEqual([false, false]);
  });

  it('T-CAT-04: 取り込み版を remove すると、同じ ID の同梱版が再び使われる', async () => {
    const bundled = await bundledOf('same', '同梱版');
    env.bundled.value = [bundled];
    await putTour(env.db, 'same', { name: '取り込み版' });
    expect(await env.catalog.remove('same')).toBe(true);
    const found = await env.catalog.get('same');
    expect(found).toMatchObject({ source: 'bundled', hash: bundled.hash });
  });

  it('T-CAT-05: 同梱だけのツアーは remove できず、一覧に残る', async () => {
    env.bundled.value = [await bundledOf('b1')];
    expect(await env.catalog.remove('b1')).toBe(false);
    expect((await env.catalog.list()).map((e) => e.tour.id)).toEqual(['b1']);
  });

  it('同梱の読み込みが失敗しても、取り込みの一覧は返る', async () => {
    await putTour(env.db, 'i1');
    env.loadBundled.mockRejectedValueOnce(new Error('x'));
    expect((await env.catalog.list()).map((e) => e.tour.id)).toEqual(['i1']);
  });
});

describe('get / getPinned', () => {
  it('T-CAT-06: 存在する ID は返り、無い ID は null', async () => {
    await putTour(env.db, 'i1');
    expect((await env.catalog.get('i1'))?.tour.id).toBe('i1');
    expect(await env.catalog.get('none')).toBeNull();
  });

  it('T-CAT-07: getPinned は固定した hash の内容を返す', async () => {
    await putTour(env.db, 'i1', { hash: 'h1' });
    const pinned = await env.catalog.getPinned('i1', 'h1');
    expect(pinned).toMatchObject({ hash: 'h1', source: 'imported' });
    expect(await env.catalog.getPinned('i1', 'other')).toBeNull();
    expect(await env.catalog.getPinned('none', 'h1')).toBeNull();
  });

  it('T-CAT-08: 上書きの後、旧 hash は保存されていないため null、新 hash の内容は返る', async () => {
    await putTour(env.db, 'i1', { hash: 'old' });
    expect(await env.catalog.getPinned('i1', 'old')).not.toBeNull();
    await putTour(env.db, 'i1', { hash: 'new' });
    await env.catalog.reload();
    expect(await env.catalog.getPinned('i1', 'old')).toBeNull();
    expect((await env.catalog.getPinned('i1', 'new'))?.hash).toBe('new');
  });

  it('T-CAT-08: 同梱ツアーも、現在の hash なら固定の内容として返る', async () => {
    const bundled = await bundledOf('b1');
    env.bundled.value = [bundled];
    expect(await env.catalog.getPinned('b1', bundled.hash)).toMatchObject({ source: 'bundled' });
  });
});

describe('取り込んだツアーの検証', () => {
  it('T-CAT-09: compiled を zod で検証して使い、YAML（yamlText）は読まない', async () => {
    await putTour(env.db, 'i1', { yamlText: 'これは YAML として壊れている: [' });
    expect((await env.catalog.get('i1'))?.tour.name).toBe('i1');
  });

  it('T-CAT-10: compiled が検証に通らないものは一覧から除かれ、他には影響しない', async () => {
    await putTour(env.db, 'good');
    await putTour(env.db, 'bad', { compiled: { schemaVersion: 3, id: 'bad' } });
    await putTour(env.db, 'wrong', { compiled: tourOf('another') });
    expect((await env.catalog.list()).map((e) => e.tour.id)).toEqual(['good']);
    expect(await env.catalog.get('bad')).toBeNull();
  });

  it('T-CAT-10: 検証に通らない取り込みは、同じ ID の同梱版を隠さない', async () => {
    env.bundled.value = [await bundledOf('same')];
    await putTour(env.db, 'same', { compiled: 'broken' });
    expect(await env.catalog.get('same')).toMatchObject({ source: 'bundled' });
  });
});

describe('同梱ツアーの読み込み', () => {
  function sourceOf(files: Record<string, string>): BundledSource {
    return {
      getUrl: (path) => `chrome-extension://x/${path}`,
      fetch: (url) => {
        const body = files[url.replace('chrome-extension://x/', '')];
        return Promise.resolve({
          ok: body !== undefined,
          text: () => Promise.resolve(body ?? ''),
        });
      },
    };
  }

  it('T-CAT-11: index.json の一覧どおりに読み込んで解析し、hash は tour.yaml の SHA-256（16進）', async () => {
    const files = { 'tours/index.json': '{"tours":["a"]}', 'tours/a/tour.yaml': yamlOf('a') };
    const [loaded] = await loadBundledTours(sourceOf(files));
    expect(loaded?.tour.id).toBe('a');
    expect(loaded?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded?.hash).toBe(await sha256Hex(yamlOf('a')));
  });

  it('T-CAT-11: 一覧が空・読めない・壊れているときは空。1件の失敗はその1件だけを外す', async () => {
    expect(await loadBundledTours(sourceOf({ 'tours/index.json': '{"tours":[]}' }))).toEqual([]);
    expect(await loadBundledTours(sourceOf({}))).toEqual([]);
    expect(await loadBundledTours(sourceOf({ 'tours/index.json': 'not json' }))).toEqual([]);
    const partial = {
      'tours/index.json': '{"tours":["a","broken","missing","../x"]}',
      'tours/a/tour.yaml': yamlOf('a'),
      'tours/broken/tour.yaml': 'schemaVersion: 3',
    };
    expect((await loadBundledTours(sourceOf(partial))).map((t) => t.tour.id)).toEqual(['a']);
  });

  it('T-CAT-12: 更新後（読み直し）は、同梱ツアーの最新版が一覧に反映される', async () => {
    env.bundled.value = [await bundledOf('b1', '旧')];
    expect((await env.catalog.list())[0]?.tour.name).toBe('旧');
    env.bundled.value = [await bundledOf('b1', '新')];
    await env.catalog.reload();
    expect((await env.catalog.list())[0]?.tour.name).toBe('新');
  });

  it('T-CAT-13: 同じ内容は同じ hash、違う内容は違う hash', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await sha256Hex(yamlOf('a'))).toBe(await sha256Hex(yamlOf('a')));
    expect(await sha256Hex(yamlOf('a'))).not.toBe(await sha256Hex(yamlOf('a', '別')));
  });
});

describe('remove', () => {
  it('T-CAT-14: ツアー本体とファイルが IndexedDB から消える', async () => {
    await putTour(env.db, 'i1', {}, ['a.png', 'b.md']);
    expect(await env.catalog.remove('i1')).toBe(true);
    expect(await countOf(env.db, STORE.tours)).toBe(0);
    expect(await countOf(env.db, STORE.files)).toBe(0);
  });

  it('T-CAT-15: 保守記録も消える', async () => {
    await putTour(env.db, 'i1');
    await recordDiagnostic(env, 'i1');
    expect(await env.diagnostics.list('i1')).toHaveLength(1);
    await env.catalog.remove('i1');
    expect(await env.diagnostics.list('i1')).toEqual([]);
  });

  it('T-CAT-16: meta.totalBytes が、そのツアーの totalBytes の分だけ戻る', async () => {
    await putTour(env.db, 'i1', { totalBytes: 300 });
    await putTour(env.db, 'i2', { totalBytes: 200 });
    await setTotal(env.db, 500);
    await env.catalog.remove('i1');
    expect(await readTotal(env.db)).toEqual({ key: TOTAL_BYTES_KEY, value: 200 });
  });

  it('T-CAT-16: 合計が足りないときも負にならない', async () => {
    await putTour(env.db, 'i1', { totalBytes: 300 });
    await setTotal(env.db, 100);
    await env.catalog.remove('i1');
    expect(await readTotal(env.db)).toEqual({ key: TOTAL_BYTES_KEY, value: 0 });
  });

  it('T-CAT-17: 他のツアーのファイル・保守記録・容量は変わらない', async () => {
    await putTour(env.db, 'i1', { totalBytes: 300 }, ['a.png']);
    await putTour(env.db, 'i2', { totalBytes: 200 }, ['b.png', 'c.png']);
    await setTotal(env.db, 500);
    await recordDiagnostic(env, 'i1');
    await recordDiagnostic(env, 'i2');
    await env.catalog.remove('i1');
    expect(await countOf(env.db, STORE.files)).toBe(2);
    expect(await countOf(env.db, STORE.tours)).toBe(1);
    expect(await env.diagnostics.list('i2')).toHaveLength(1);
    expect((await env.catalog.list()).map((e) => e.tour.id)).toEqual(['i2']);
  });

  it('T-CAT-18: 存在しない ID の remove は false で、何も変わらない', async () => {
    await putTour(env.db, 'i1', {}, ['a.png']);
    await setTotal(env.db, 100);
    await recordDiagnostic(env, 'i1');
    expect(await env.catalog.remove('none')).toBe(false);
    expect(await countOf(env.db, STORE.tours)).toBe(1);
    expect(await countOf(env.db, STORE.files)).toBe(1);
    expect(await readTotal(env.db)).toEqual({ key: TOTAL_BYTES_KEY, value: 100 });
    expect(await env.diagnostics.list('i1')).toHaveLength(1);
  });

  it('T-CAT-19: remove の後にキャッシュが破棄され、list に反映される', async () => {
    await putTour(env.db, 'i1');
    expect(await env.catalog.list()).toHaveLength(1);
    await env.catalog.remove('i1');
    expect(await env.catalog.list()).toEqual([]);
  });
});

describe('キャッシュ', () => {
  it('キャッシュ中は保存済みのデータを読み直さない', async () => {
    await putTour(env.db, 'i1');
    await env.catalog.list();
    await env.catalog.list();
    expect(env.loadBundled).toHaveBeenCalledTimes(1);
    await putTour(env.db, 'i2');
    expect(await env.catalog.list()).toHaveLength(1);
  });

  it('T-CAT-20 T-CAT-21 T-CAT-22: reload() でキャッシュが捨てられ、保存済みのデータから組み立て直される', async () => {
    await putTour(env.db, 'i1');
    await env.catalog.list();
    await putTour(env.db, 'i2');
    await env.catalog.reload();
    expect((await env.catalog.list()).map((e) => e.tour.id).sort()).toEqual(['i1', 'i2']);
    expect(env.loadBundled).toHaveBeenCalledTimes(2);
  });

  it('T-CAT-23: 別のカタログ（Service Worker の再起動後）でも、保存済みのデータだけから同じ結果になる', async () => {
    env.bundled.value = [await bundledOf('b1')];
    await putTour(env.db, 'i1');
    const before = await env.catalog.list();
    const restarted = createCatalog({
      getDb: () => Promise.resolve(env.db),
      loadBundled: () => Promise.resolve(env.bundled.value),
      diagnostics: env.diagnostics,
    });
    expect(await restarted.list()).toEqual(before);
  });

  it('T-CAT-24: 同じ ID の更新の後に reload すると、新しい hash の内容が get で返る', async () => {
    await putTour(env.db, 'i1', { hash: 'h1', name: '旧' });
    expect((await env.catalog.get('i1'))?.hash).toBe('h1');
    await putTour(env.db, 'i1', { hash: 'h2', name: '新' });
    await env.catalog.reload();
    const found = await env.catalog.get('i1');
    expect(found?.hash).toBe('h2');
    expect(found?.tour.name).toBe('新');
  });

  it('DB の読み出しに失敗したら、結果を残さず次の呼び出しで組み立て直す', async () => {
    let fail = true;
    const catalog = createCatalog({
      getDb: () => (fail ? Promise.reject(new Error('x')) : Promise.resolve(env.db)),
      loadBundled: () => Promise.resolve([]),
      diagnostics: env.diagnostics,
    });
    await expect(catalog.list()).rejects.toThrow();
    fail = false;
    await putTour(env.db, 'i1');
    expect(await catalog.list()).toHaveLength(1);
  });
});
