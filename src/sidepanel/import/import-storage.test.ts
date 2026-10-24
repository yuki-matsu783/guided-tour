/**
 * importFiles の保存（IndexedDB の中身・ハッシュ・容量の予約・同時の取り込み・巻き戻し）、
 * 保存したデータだけからの組み立て直し、バックグラウンドへの通知のテスト。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildZip,
  dataUrl,
  gif,
  guideStep,
  padTo,
  png,
  tourYaml,
  utf8,
} from '../../core/package/fixtures/builders.ts';
import { CompiledTourSchema } from '../../core/tour/index.ts';
import { PACKAGE_LIMITS } from '../../core/package/index.ts';
import { openDb } from '../../shared/db/index.ts';
import { importFiles } from './import-files.ts';
import { removeTourData } from './remove.ts';
import type { ImportResult } from './types.ts';
import { MB, file, isEmpty, readFiles, setTotal, setup, snapshot } from './test-support.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

const LIMIT = PACKAGE_LIMITS.totalBytes;

/** 画像1枚つきの zip。`seed` で画像の中身（容量はそのまま）を変えられる。 */
function imageZip(id: string, image: Uint8Array, name = 'images/a.png') {
  const yaml = tourYaml({ id, steps: guideStep('a', { media: name }) });
  return { zip: buildZip([{ name: 'tour.yaml', data: yaml }, { name, data: image }]), yaml };
}

function statuses(results: ImportResult[]): string[] {
  return results.map((r) => r.status);
}

describe('保存するデータ', () => {
  it('T-PKG-73: tours と files に、設計どおりの項目が入る', async () => {
    const { deps, db } = await setup();
    const { zip, yaml } = imageZip('rec', png(30, 20));
    await importFiles([file('rec.zip', zip)], deps);
    const snap = await snapshot(db);
    const tour = snap.tours[0];
    expect(tour).toMatchObject({
      id: 'rec',
      yamlText: yaml,
      fileName: 'rec.zip',
      importedAt: 1_700_000_000_000,
      totalBytes: utf8(yaml).length + png(30, 20).length,
    });
    expect(tour?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(CompiledTourSchema.safeParse(tour?.compiled).success).toBe(true);
    const files = await readFiles(db);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      tourId: 'rec',
      hash: tour?.hash,
      path: 'images/a.png',
      mime: 'image/png',
      size: png(30, 20).length,
      width: 30,
      height: 20,
    });
    expect(files[0]?.blob.size).toBe(png(30, 20).length);
  });

  it('T-PKG-74: 同じ内容なら hash が同じで、1 バイト違えば hash が変わる', async () => {
    const hashOf = async (yaml: string, image?: Uint8Array) => {
      const { deps, db } = await setup();
      const f = image
        ? file('t.zip', buildZip([{ name: 'tour.yaml', data: yaml }, { name: 'images/a.png', data: image }]))
        : file('t.yaml', yaml);
      await importFiles([f], deps);
      return (await snapshot(db)).tours[0]?.hash;
    };
    const yaml = tourYaml({ id: 'h', steps: guideStep('a', { media: 'images/a.png' }) });
    const base = await hashOf(yaml, png(5, 5));
    expect(await hashOf(yaml, png(5, 5))).toBe(base);
    expect(await hashOf(yaml, padTo(png(5, 5), png(5, 5).length + 1))).not.toBe(base);
    expect(await hashOf(`${yaml}# 1\n`, png(5, 5))).not.toBe(base);
  });

  it('T-PKG-75: 新規に取り込むと、meta.totalBytes が保存したツアーの totalBytes だけ増える', async () => {
    const { deps, db } = await setup();
    await importFiles([file('a.yaml', tourYaml({ id: 'a' }))], deps);
    const first = (await snapshot(db)).total;
    expect(first).toBe(utf8(tourYaml({ id: 'a' })).length);
    const { zip } = imageZip('b', png(5, 5));
    await importFiles([file('b.zip', zip)], deps);
    const after = await snapshot(db);
    expect(after.total).toBe(after.tours.reduce((sum, t) => sum + t.totalBytes, 0));
    expect(after.total).toBeGreaterThan(first ?? 0);
  });

  it('T-PKG-76: 上書きすると向き先が新しい hash になり、旧版の files が消え、他のツアーの files は残る', async () => {
    const { deps, db } = await setup();
    await importFiles([file('other.zip', imageZip('other', png(3, 3)).zip)], deps);
    await importFiles([file('v1.zip', imageZip('x', png(4, 4)).zip)], deps);
    const v1 = (await snapshot(db)).tours.find((t) => t.id === 'x')?.hash;
    await importFiles([file('v2.zip', imageZip('x', png(6, 6)).zip)], deps);
    const snap = await snapshot(db);
    const v2 = snap.tours.find((t) => t.id === 'x')?.hash;
    expect(v2).not.toBe(v1);
    const keys = snap.files.map((f) => f.key);
    expect(keys.filter((k) => k.startsWith('x/'))).toEqual([`x/${v2 ?? ''}/images/a.png`]);
    expect(keys.filter((k) => k.startsWith('other/'))).toHaveLength(1);
  });

  it('T-PKG-76: 同じ内容の上書きでは、いま書いたファイルを消さない', async () => {
    const { deps, db } = await setup();
    const { zip } = imageZip('x', png(4, 4));
    await importFiles([file('v1.zip', zip)], deps);
    const before = await snapshot(db);
    await importFiles([file('v1-again.zip', zip)], deps);
    const after = await snapshot(db);
    expect(after.files).toEqual(before.files);
    expect(after.total).toBe(before.total);
  });

  it('T-PKG-77: 上書きすると meta.totalBytes は、旧版の分を減らし新版の分を加えた値になる', async () => {
    const { deps, db } = await setup();
    await importFiles([file('other.yaml', tourYaml({ id: 'other' }))], deps);
    await importFiles([file('v1.zip', imageZip('x', padTo(png(4, 4), 5000)).zip)], deps);
    const mid = await snapshot(db);
    const otherBytes = mid.tours.find((t) => t.id === 'other')?.totalBytes ?? 0;
    await importFiles([file('v2.zip', imageZip('x', padTo(png(4, 4), 100)).zip)], deps);
    const after = await snapshot(db);
    const x = after.tours.find((t) => t.id === 'x');
    expect(after.total).toBe(otherBytes + (x?.totalBytes ?? 0));
  });

  it('T-PKG-84: 容量の確認は、展開後の合計ではなく保存する blob と YAML の合計で行われる', async () => {
    const { deps, db } = await setup();
    const yaml = tourYaml({ id: 'q' });
    const zip = buildZip([
      { name: 'tour.yaml', data: yaml },
      { name: 'unused.bin', data: new Uint8Array(30 * MB) },
    ]);
    await setTotal(db, LIMIT - utf8(yaml).length);
    const [result] = await importFiles([file('q.zip', zip)], deps);
    expect(result?.status).toBe('imported');
    expect((await snapshot(db)).tours[0]?.totalBytes).toBe(utf8(yaml).length);
    expect((await snapshot(db)).total).toBe(LIMIT);
  });
});

describe('合計容量の上限', () => {
  const yamlOf = (id: string) => tourYaml({ id });
  const size = utf8(yamlOf('aa')).length;

  it('T-PKG-78: 合計が 200 MB ちょうどになる取り込みは成功し、+1 バイトは拒否されて上限が示される', async () => {
    const exact = await setup();
    await setTotal(exact.db, LIMIT - size);
    const [ok] = await importFiles([file('a.yaml', yamlOf('aa'))], exact.deps);
    expect(ok?.status).toBe('imported');
    expect((await snapshot(exact.db)).total).toBe(LIMIT);

    const over = await setup();
    await setTotal(over.db, LIMIT - size + 1);
    const [ng] = await importFiles([file('a.yaml', yamlOf('aa'))], over.deps);
    expect(ng?.status).toBe('rejected');
    if (ng?.status === 'rejected') expect(ng.errors[0]?.message).toContain('200 MB');
  });

  it('T-PKG-79: 合計容量の上限で拒否されたとき、files・tours・meta.totalBytes のどれも変化しない', async () => {
    const { deps, db, notify } = await setup();
    await importFiles([file('x.zip', imageZip('x', png(3, 3)).zip)], deps);
    await setTotal(db, LIMIT - 10);
    const before = await snapshot(db);
    notify.mockClear();
    const [result] = await importFiles([file('y.zip', imageZip('y', png(4, 4)).zip)], deps);
    expect(result?.status).toBe('rejected');
    expect(await snapshot(db)).toEqual(before);
    expect(notify).not.toHaveBeenCalled();
  });

  it('T-PKG-79: 上書きでも、新版が上限を超えるときは旧版が残る', async () => {
    const { deps, db } = await setup();
    await importFiles([file('v1.zip', imageZip('x', png(3, 3)).zip)], deps);
    const before = await snapshot(db);
    await setTotal(db, LIMIT - 1);
    const [result] = await importFiles([file('v2.zip', imageZip('x', padTo(png(3, 3), 200)).zip)], deps);
    expect(result?.status).toBe('rejected');
    const after = await snapshot(db);
    expect(after.tours).toEqual(before.tours);
    expect(after.files).toEqual(before.files);
  });

  it('T-PKG-80: 上限の近くで複数を同時に取り込むと、成功した分の合計が 200 MB を超えず、超える分は拒否される', async () => {
    const { deps, db } = await setup();
    await setTotal(db, LIMIT - size - 1);
    const results = (
      await Promise.all([
        importFiles([file('a.yaml', yamlOf('aa'))], deps),
        importFiles([file('b.yaml', yamlOf('bb'))], deps),
        importFiles([file('c.yaml', yamlOf('cc'))], deps),
      ])
    ).flat();
    expect(results.filter((r) => r.status === 'imported')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(2);
    expect(rejected.every((r) => r.errors.some((e) => e.message.includes('200 MB')))).toBe(true);
    const snap = await snapshot(db);
    expect(snap.tours).toHaveLength(1);
    expect(snap.total).toBe(LIMIT - 1);
  });

  it('T-PKG-81: 同時に取り込む2件の合計が上限内なら、2件とも成功し、meta.totalBytes は両方の合計になる', async () => {
    const { deps, db } = await setup();
    const results = (
      await Promise.all([
        importFiles([file('a.yaml', yamlOf('aa'))], deps),
        importFiles([file('b.zip', imageZip('bb', png(5, 5)).zip)], deps),
      ])
    ).flat();
    expect(statuses(results)).toEqual(['imported', 'imported']);
    const snap = await snapshot(db);
    expect(snap.total).toBe(snap.tours.reduce((sum, t) => sum + t.totalBytes, 0));
    expect(snap.tours).toHaveLength(2);
  });

  it('T-PKG-82: 同じ ID を同時に2件取り込むと、片方の新版だけが向き先になり、孤立した版の files が残らない', async () => {
    const { deps, db } = await setup();
    await Promise.all([
      importFiles([file('a.zip', imageZip('same', png(5, 5)).zip)], deps),
      importFiles([file('b.zip', imageZip('same', png(6, 6)).zip)], deps),
    ]);
    const snap = await snapshot(db);
    expect(snap.tours).toHaveLength(1);
    const tour = snap.tours[0];
    expect(snap.files).toHaveLength(1);
    expect(snap.files[0]?.key).toBe(`same/${tour?.hash ?? ''}/images/a.png`);
    expect(snap.total).toBe(tour?.totalBytes);
  });

  it('T-PKG-83: 保存の途中（files を書いた後、向き先の切り替え前）で失敗すると、全体が巻き戻り旧版が使える', async () => {
    const { deps, db } = await setup();
    await importFiles([file('v1.zip', imageZip('x', png(3, 3)).zip)], deps);
    const before = await snapshot(db);
    const realTransaction = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementation((stores, mode) => {
      const tx = realTransaction(stores, mode);
      const realObjectStore = tx.objectStore.bind(tx);
      vi.spyOn(tx, 'objectStore').mockImplementation((name) => {
        const store = realObjectStore(name);
        if (name === 'tours') {
          vi.spyOn(store, 'put').mockImplementation(() => {
            throw new Error('boom');
          });
        }
        return store;
      });
      return tx;
    });
    const [result] = await importFiles([file('v2.zip', imageZip('x', png(9, 9)).zip)], deps);
    expect(result?.status).toBe('rejected');
    vi.restoreAllMocks();
    expect(await snapshot(db)).toEqual(before);
  });
});

describe('保存したデータだけからの組み立て直し', () => {
  it('T-PKG-85・T-PKG-86: 開き直した DB の tours・files だけから、ツアー・説明文・画像を元どおり組み立てられる', async () => {
    const { deps, db, factory } = await setup();
    const yaml = tourYaml({
      id: 'rebuild',
      steps: guideStep('a', { bodyFile: 'steps/a.md', media: 'images/top.gif' }),
    });
    const md = '# 手順\n\n![図](../images/inner.png)\n';
    const topGif = gif(12, 8);
    const inner = png(20, 10);
    const zip = buildZip([
      { name: 'tour.yaml', data: yaml },
      { name: 'steps/a.md', data: md },
      { name: 'images/top.gif', data: topGif },
      { name: 'images/inner.png', data: inner },
    ]);
    await importFiles([file('r.zip', zip)], deps);
    db.close();

    const reopened = await openDb(factory);
    const snap = await snapshot(reopened);
    const record = snap.tours[0];
    const tour = CompiledTourSchema.parse(record?.compiled);
    const files = await readFiles(reopened);
    const find = (path: string) => files.find((f) => f.tourId === tour.id && f.hash === record?.hash && f.path === path);

    const step = tour.steps[0];
    expect(step?.bodyFile).toBe('steps/a.md');
    expect(await find(step?.bodyFile ?? '')?.blob.text()).toBe(md);
    // Markdown 内の画像は、その Markdown の場所を起点にした鍵で見つかる
    const innerRecord = find('images/inner.png');
    expect(innerRecord).toMatchObject({ mime: 'image/png', width: 20, height: 10 });
    expect([...new Uint8Array((await innerRecord?.blob.arrayBuffer()) ?? new ArrayBuffer(0))]).toEqual([...inner]);
    const media = find(step?.media?.src ?? '');
    expect(media).toMatchObject({ mime: 'image/gif', width: 12, height: 8 });
    expect(files).toHaveLength(3);
  });

  it('T-PKG-87: 単体 YAML（画像なし・data URL の画像あり）も、tours だけで組み立て直せる', async () => {
    const { deps, db, factory } = await setup();
    const src = dataUrl('image/png', png(4, 4));
    await importFiles(
      [
        file('plain.yaml', tourYaml({ id: 'plain' })),
        file('inline.yaml', tourYaml({ id: 'inline', steps: guideStep('a', { media: src }) })),
      ],
      deps,
    );
    db.close();
    const reopened = await openDb(factory);
    const snap = await snapshot(reopened);
    expect(snap.files).toEqual([]);
    const inline = snap.tours.find((t) => t.id === 'inline');
    expect(CompiledTourSchema.parse(inline?.compiled).steps[0]?.media?.src).toBe(src);
    expect(CompiledTourSchema.parse(snap.tours.find((t) => t.id === 'plain')?.compiled).name).toBe('サンプル');
  });

  it('T-PKG-88: 取り込み済みツアーを削除すると、tours と全版の files が消え、meta.totalBytes が減る', async () => {
    const { deps, db } = await setup();
    await importFiles([file('keep.zip', imageZip('keep', png(3, 3)).zip)], deps);
    await importFiles([file('v1.zip', imageZip('gone', png(4, 4)).zip)], deps);
    await importFiles([file('v2.zip', imageZip('gone', png(5, 5)).zip)], deps);
    const before = await snapshot(db);
    const keepBytes = before.tours.find((t) => t.id === 'keep')?.totalBytes;
    expect(await removeTourData(db, 'gone')).toBe(true);
    const after = await snapshot(db);
    expect(after.tours.map((t) => t.id)).toEqual(['keep']);
    expect(after.files.every((f) => f.key.startsWith('keep/'))).toBe(true);
    expect(after.total).toBe(keepBytes);
    expect(await removeTourData(db, 'gone')).toBe(false);
    expect(await removeTourData(db, 'keep')).toBe(true);
    expect(await isEmpty(db)).toBe(true);
  });
});

describe('バックグラウンドへの通知', () => {
  it('T-PKG-89: 保存に成功したとき、CATALOG_CHANGED{tourId, hash} が保存後の hash で1回送られる', async () => {
    const { deps, db, notify } = await setup();
    await importFiles([file('a.yaml', tourYaml({ id: 'n1' }))], deps);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({ tourId: 'n1', hash: (await snapshot(db)).tours[0]?.hash });
  });

  it('T-PKG-90: 送られるメッセージに、ファイルの中身（yamlText・画像・blob）が含まれない', async () => {
    const { deps, notify } = await setup();
    const { zip } = imageZip('n2', png(3, 3));
    await importFiles([file('a.zip', zip)], deps);
    const [message] = notify.mock.calls[0] ?? [];
    expect(Object.keys(message ?? {}).sort()).toEqual(['hash', 'tourId']);
    const text = JSON.stringify(message);
    expect(text).not.toContain('schemaVersion');
    expect(text.length).toBeLessThan(200);
  });

  it('T-PKG-91: 検証の失敗・上限超過・上書きの拒否のとき、CATALOG_CHANGED は送られない', async () => {
    const { deps, db, notify, confirm } = await setup();
    await importFiles([file('first.yaml', tourYaml({ id: 'dup' }))], deps);
    notify.mockClear();
    confirm.mockResolvedValue(false);
    await importFiles([file('declined.yaml', tourYaml({ id: 'dup', name: '別' }))], deps);
    await importFiles([file('bad.yaml', 'schemaVersion: 9\n')], deps);
    await importFiles([file('huge.zip', padTo(buildZip([{ name: 'tour.yaml', data: tourYaml({ id: 'h' }) }]), 20 * MB + 1))], deps);
    await setTotal(db, LIMIT);
    await importFiles([file('full.yaml', tourYaml({ id: 'full' }))], deps);
    expect(notify).not.toHaveBeenCalled();
  });

  it('T-PKG-92: 複数のファイルを取り込むとき、成功したファイルごとにメッセージが送られる', async () => {
    const { deps, notify } = await setup();
    await importFiles(
      [
        file('a.yaml', tourYaml({ id: 'a' })),
        file('bad.yaml', 'x: ['),
        file('b.zip', buildZip([{ name: 'tour.yaml', data: tourYaml({ id: 'b' }) }])),
      ],
      deps,
    );
    expect(notify.mock.calls.map(([m]) => m.tourId)).toEqual(['a', 'b']);
  });

  it('T-PKG-93: 通知の送信が失敗しても、保存は残り、結果は成功として返る', async () => {
    const { deps, db, notify } = await setup();
    notify.mockRejectedValueOnce(new Error('no receiver'));
    const [rejectedSend] = await importFiles([file('a.yaml', tourYaml({ id: 'a' }))], deps);
    expect(rejectedSend?.status).toBe('imported');
    notify.mockImplementationOnce(() => {
      throw new Error('sync failure');
    });
    const [throwingSend] = await importFiles([file('b.yaml', tourYaml({ id: 'b' }))], deps);
    expect(throwingSend?.status).toBe('imported');
    expect((await snapshot(db)).tours.map((t) => t.id).sort()).toEqual(['a', 'b']);
  });
});
