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

  it('T-PKG-15: 中央ディレクトリが少なく申告していても、501 個目を展開せずに拒否する（中央ディレクトリにない項目として）', async () => {
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
    expect(errorsOf(result).join()).toContain('中央ディレクトリにない');
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

  describe('中央ディレクトリを信頼できない形', () => {
    const link = () =>
      buildZip([
        { name: 'tour.yaml', data: 'x' },
        { name: 'steps/a.md', data: '/etc/passwd', symlink: true },
      ]);
    const eocdOf = (zip: Uint8Array) => zip.length - 22;

    it('T-PKG-14: EOCD の件数が 0xffff（zip64）の zip は、シンボリックリンクを含んでいても拒否する（追加）', async () => {
      const forged = link().slice();
      forged[eocdOf(forged) + 10] = 0xff;
      forged[eocdOf(forged) + 11] = 0xff;
      expect((await unzipPackage(forged, 'p.zip')).ok).toBe(false);
    });

    it('T-PKG-14: EOCD の件数が 0 の zip は拒否する（追加）', async () => {
      const forged = link().slice();
      for (const at of [8, 9, 10, 11]) forged[eocdOf(forged) + at] = 0;
      expect((await unzipPackage(forged, 'p.zip')).ok).toBe(false);
    });

    it('T-PKG-14: 中央ディレクトリの名前とローカルヘッダーの名前が食い違う zip は拒否する（追加）', async () => {
      const forged = link().slice();
      const text = new TextDecoder('latin1').decode(forged);
      forged[text.lastIndexOf('steps/a.md')] = 'S'.charCodeAt(0);
      const result = await unzipPackage(forged, 'p.zip');
      expect(result.ok).toBe(false);
    });

    it('T-PKG-14: 中央ディレクトリの件数がローカルヘッダーより少ない zip は拒否する（追加）', async () => {
      const zip = buildZip([
        { name: 'a.txt', data: 'x' },
        { name: 'b.txt', data: 'y' },
      ]);
      const forged = zip.slice();
      forged[eocdOf(forged) + 8] = 1;
      forged[eocdOf(forged) + 10] = 1;
      expect((await unzipPackage(forged, 'p.zip')).ok).toBe(false);
    });

    it('T-PKG-14: 正しい zip（シンボリックリンクなし）は通り、シンボリックリンクは拒否される（追加）', async () => {
      expect((await unzipPackage(buildZip([{ name: 'a.txt', data: 'x' }]), 'p.zip')).ok).toBe(true);
      expect((await unzipPackage(link(), 'p.zip')).ok).toBe(false);
    });
  });

  describe('項目の総数', () => {
    const dirs = (n: number) => buildZip(Array.from({ length: n }, (_, i) => ({ name: `d${String(i)}/` })));

    it('T-PKG-97: ディレクトリの項目だけの 2,000 件は通り、2,001 件は拒否され、上限が表示される', async () => {
      const limit = PACKAGE_LIMITS.entryCount;
      expect(limit).toBe(2000);
      expect((await unzipPackage(dirs(limit), 'p.zip')).ok).toBe(true);
      const over = await unzipPackage(dirs(limit + 1), 'p.zip');
      expect(over.ok).toBe(false);
      expect(errorsOf(over).join()).toContain('2,000');
    });

    it('T-PKG-97: 名前の不正な項目も総数に数え、上限で展開を打ち切る（エラーを積み続けない）', async () => {
      const bad = buildZip(Array.from({ length: 2001 }, (_, i) => ({ name: `../x${String(i)}.txt`, data: 'x' })));
      const result = await unzipPackage(bad, 'p.zip');
      expect(result.ok).toBe(false);
      expect(errorsOf(result).join()).toContain('2,000');
    });

    it('T-PKG-97: 中央ディレクトリが少なく申告しても、ローカルヘッダーの数が上限を超えれば打ち切る', async () => {
      const zip = dirs(2001);
      const forged = zip.slice();
      const eocd = forged.length - 22;
      forged[eocd + 8] = 5;
      forged[eocd + 10] = 5;
      expect((await unzipPackage(forged, 'p.zip')).ok).toBe(false);
    });
  });
});
