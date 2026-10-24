/**
 * zip の逐次展開のテスト（上限での打ち切り、名前・重複・シンボリックリンク、宣言サイズの偽り）。
 */
import { Unzip } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildZip, utf8 } from './fixtures/builders.ts';
import { PACKAGE_LIMITS } from './limits.ts';
import { unzipPackage } from './unzip.ts';

const MB = 1024 * 1024;

afterEach(() => {
  vi.restoreAllMocks();
});

function errorsOf(result: Awaited<ReturnType<typeof unzipPackage>>): string[] {
  return result.ok ? [] : result.errors.map((e) => e.message);
}

describe('unzipPackage の展開', () => {
  it('通常の zip を展開し、ディレクトリのエントリは結果に含めない', async () => {
    const zip = buildZip([
      { name: 'tour.yaml', data: 'a: 1' },
      { name: 'images/' },
      { name: 'images/図1.png', data: new Uint8Array([1, 2, 3]), method: 'store' },
    ]);
    const result = await unzipPackage(zip, 'p.zip');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect([...result.entries.keys()].sort()).toEqual(['images/図1.png', 'tour.yaml']);
      expect([...(result.entries.get('images/図1.png') ?? [])]).toEqual([1, 2, 3]);
    }
  });

  it('T-PKG-12: 展開後の合計が 50 MB ちょうどなら成功し、+1 バイトになった時点で打ち切られる', async () => {
    const ok = await unzipPackage(buildZip([{ name: 'big.bin', data: new Uint8Array(50 * MB) }]), 'p.zip');
    expect(ok.ok).toBe(true);
    const over = await unzipPackage(buildZip([{ name: 'big.bin', data: new Uint8Array(50 * MB + 1) }]), 'p.zip');
    expect(over.ok).toBe(false);
    expect(errorsOf(over).join()).toContain('50 MB');
  });

  it('T-PKG-13: 宣言サイズを小さく偽った zip でも、実際に展開した量で数えて打ち切る', async () => {
    const zip = buildZip([{ name: 'lie.bin', data: new Uint8Array(60 * MB), declaredSize: 10 }]);
    const result = await unzipPackage(zip, 'p.zip');
    expect(result.ok).toBe(false);
    expect(errorsOf(result).join()).toContain('50 MB');
  });

  it('T-PKG-14: zip 爆弾は上限に達した時点で展開を止め、残りの圧縮データを渡さない', async () => {
    const zip = buildZip([{ name: 'bomb.bin', data: new Uint8Array(120 * MB) }]);
    const push = vi.spyOn(Unzip.prototype, 'push');
    const result = await unzipPackage(zip, 'p.zip');
    expect(result.ok).toBe(false);
    const allChunks = Math.ceil(zip.length / PACKAGE_LIMITS.chunkBytes);
    expect(push.mock.calls.length).toBeLessThan(allChunks);
    expect(push.mock.calls.every(([chunk]) => chunk.length <= PACKAGE_LIMITS.chunkBytes)).toBe(true);
  }, 30_000);

  it('T-PKG-14: 圧縮側の区切りごとに処理を譲る（sliceMs が 0 のとき区切りごと）', async () => {
    const zip = buildZip([{ name: 'a.bin', data: new Uint8Array(3 * MB).map((_, i) => (i * 7) % 251) }]);
    const yieldToHost = vi.fn(() => Promise.resolve());
    const result = await unzipPackage(zip, 'p.zip', { yieldToHost, sliceMs: 0 });
    expect(result.ok).toBe(true);
    expect(yieldToHost.mock.calls.length).toBeGreaterThanOrEqual(Math.floor(zip.length / PACKAGE_LIMITS.chunkBytes));
  });

  it('T-PKG-15: ファイル数が 500 ちょうどなら成功し、501 なら打ち切られる', async () => {
    const make = (n: number) => buildZip(Array.from({ length: n }, (_, i) => ({ name: `f${String(i)}.txt`, data: 'x' })));
    expect((await unzipPackage(make(500), 'p.zip')).ok).toBe(true);
    const over = await unzipPackage(make(501), 'p.zip');
    expect(over.ok).toBe(false);
    expect(errorsOf(over).join()).toContain('500');
  });

  it('T-PKG-15: 中央ディレクトリが少なく申告していても、展開中に 501 番目で打ち切る', async () => {
    const zip = buildZip(Array.from({ length: 501 }, (_, i) => ({ name: `f${String(i)}.txt`, data: 'x' })));
    // EOCD の件数・中央ディレクトリのサイズを 1 件にして申告を偽る
    const eocd = zip.length - 22;
    const forged = zip.slice();
    forged[eocd + 10] = 1;
    forged[eocd + 8] = 1;
    const central = new DataView(forged.buffer).getUint32(eocd + 16, true);
    const firstEntry = 46 + 'f0.txt'.length;
    new DataView(forged.buffer).setUint32(eocd + 12, firstEntry, true);
    expect(central).toBeGreaterThan(0);
    const result = await unzipPackage(forged, 'p.zip');
    expect(result.ok).toBe(false);
    expect(errorsOf(result).join()).toContain('500');
  });

  it('T-PKG-16: 打ち切りのエラーに、超えた上限の名前と値が含まれる', async () => {
    const expanded = await unzipPackage(buildZip([{ name: 'b', data: new Uint8Array(51 * MB) }]), 'p.zip');
    expect(errorsOf(expanded).join()).toMatch(/展開後の合計サイズ.*50 MB/);
    const count = await unzipPackage(
      buildZip(Array.from({ length: 501 }, (_, i) => ({ name: `f${String(i)}`, data: 'x' }))),
      'p.zip',
    );
    expect(errorsOf(count).join()).toMatch(/ファイル数.*500/);
  });

  it('T-PKG-17: 壊れた zip・zip でないファイルはエラーになる', async () => {
    expect((await unzipPackage(utf8('これは zip ではありません。'.repeat(5)), 'p.zip')).ok).toBe(false);
    expect((await unzipPackage(new Uint8Array(0), 'p.zip')).ok).toBe(false);
    const zip = buildZip([{ name: 'a.txt', data: 'hello world '.repeat(100) }]);
    expect((await unzipPackage(zip.subarray(0, zip.length - 30), 'p.zip')).ok).toBe(false);
    const corrupt = zip.slice();
    for (let i = 40; i < 60; i++) corrupt[i] = 0xff;
    await expect(unzipPackage(corrupt, 'p.zip')).resolves.toBeDefined();
  });
});

describe('unzipPackage のエントリの検査', () => {
  const rejected = async (specs: Parameters<typeof buildZip>[0]) => unzipPackage(buildZip(specs), 'p.zip');

  it('T-PKG-19〜25: 不正な名前のエントリは、エラーの場所にエントリ名を示して拒否する', async () => {
    for (const name of ['a\\b.md', 'a\u00a5b.md', 'a\0b.md', '/etc/x', 'C:/x', 'c:x', 'a//b', '../x', 'a/../b']) {
      const result = await rejected([{ name: 'tour.yaml', data: 'a' }, { name, data: 'x' }]);
      expect(result.ok, name).toBe(false);
      if (!result.ok) {
        expect(result.errors[0]?.file).toBe('p.zip');
        expect(result.errors[0]?.path.length).toBeGreaterThan(0);
      }
    }
  });

  it('T-PKG-26・T-PKG-30: ..a・a..b・日本語・サブディレクトリの名前は拒否されない', async () => {
    const result = await rejected([
      { name: '..a', data: 'x' },
      { name: 'a..b', data: 'x' },
      { name: 'images/図1.png', data: 'x' },
    ]);
    expect(result.ok).toBe(true);
  });

  it('T-PKG-27: シンボリックリンクのエントリは拒否する', async () => {
    const result = await rejected([{ name: 'link', data: 'target', symlink: true }]);
    expect(result.ok).toBe(false);
    expect(errorsOf(result).join()).toContain('シンボリックリンク');
  });

  it('T-PKG-28: 大文字・小文字の違いだけで重複する名前は拒否する', async () => {
    const result = await rejected([{ name: 'a.png', data: '1' }, { name: 'A.PNG', data: '2' }]);
    expect(result.ok).toBe(false);
    expect(errorsOf(result).join()).toContain('同じ名前');
  });

  it('T-PKG-29: まったく同じ名前の重複エントリは拒否する', async () => {
    const result = await rejected([{ name: 'a.png', data: '1' }, { name: 'a.png', data: '2' }]);
    expect(result.ok).toBe(false);
  });

  it('T-PKG-31: ディレクトリのエントリは拒否せず、ファイル数にも数えない', async () => {
    const specs = [
      ...Array.from({ length: 500 }, (_, i) => ({ name: `f${String(i)}.txt`, data: 'x' })),
      { name: 'dir1/' },
      { name: 'dir2/' },
    ];
    const result = await rejected(specs);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entries.size).toBe(500);
  });

  it('エラーは 20 件までに切る', async () => {
    const result = await rejected(Array.from({ length: 30 }, (_, i) => ({ name: `a\\${String(i)}`, data: 'x' })));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toHaveLength(20);
  });
});
