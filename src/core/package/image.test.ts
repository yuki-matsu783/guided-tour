/**
 * 画像のヘッダー検査のテスト（署名・寸法・上限・切れたヘッダー）。
 */
import { describe, expect, it } from 'vitest';
import { gif, jpeg, padTo, png, webpVp8, webpVp8l, webpVp8x } from './fixtures/builders.ts';
import { inspectImage } from './image.ts';
import { PACKAGE_LIMITS } from './limits.ts';

function size(result: ReturnType<typeof inspectImage>): [number, number] | string {
  return result.ok ? [result.info.width, result.info.height] : result.message;
}

describe('inspectImage の形式と寸法', () => {
  it('T-PKG-43: PNG・JPEG・GIF・WebP（VP8・VP8L・VP8X）の縦横をヘッダーから読む', () => {
    expect(size(inspectImage(png(120, 80), 'png'))).toEqual([120, 80]);
    expect(size(inspectImage(jpeg(300, 200), 'jpeg'))).toEqual([300, 200]);
    expect(size(inspectImage(gif(64, 32), 'gif'))).toEqual([64, 32]);
    expect(size(inspectImage(webpVp8(640, 480), 'webp'))).toEqual([640, 480]);
    expect(size(inspectImage(webpVp8l(1000, 700), 'webp'))).toEqual([1000, 700]);
    expect(size(inspectImage(webpVp8x(2000, 1500), 'webp'))).toEqual([2000, 1500]);
    const info = inspectImage(png(1, 1), 'png');
    expect(info.ok && info.info.mime).toBe('image/png');
  });

  it('T-PKG-44: 拡張子と署名が一致しないときは失敗する', () => {
    expect(inspectImage(jpeg(10, 10), 'png').ok).toBe(false);
    expect(inspectImage(png(10, 10), 'gif').ok).toBe(false);
    expect(inspectImage(gif(10, 10), 'webp').ok).toBe(false);
    expect(inspectImage(webpVp8(10, 10), 'jpeg').ok).toBe(false);
    expect(inspectImage(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 'png').ok).toBe(false);
  });

  it('T-PKG-46: 署名が正しくてもヘッダーが切れている画像は、例外にならず失敗する', () => {
    const cases: [Uint8Array, 'png' | 'jpeg' | 'gif' | 'webp'][] = [
      [png(10, 10).subarray(0, 14), 'png'],
      [png(10, 10).subarray(0, 8), 'png'],
      [jpeg(10, 10, { noSof: true }), 'jpeg'],
      [jpeg(10, 10).subarray(0, 8), 'jpeg'],
      [gif(10, 10).subarray(0, 8), 'gif'],
      [webpVp8(10, 10).subarray(0, 20), 'webp'],
      [webpVp8l(10, 10).subarray(0, 22), 'webp'],
      [webpVp8x(10, 10).subarray(0, 26), 'webp'],
    ];
    for (const [bytes, kind] of cases) {
      expect(() => inspectImage(bytes, kind)).not.toThrow();
      expect(inspectImage(bytes, kind).ok, `${kind}:${String(bytes.length)}`).toBe(false);
    }
  });

  it('T-PKG-47: 4096×4096 以内は通り、幅または高さが 4097 だと失敗する', () => {
    expect(inspectImage(png(4096, 1), 'png').ok).toBe(true);
    expect(inspectImage(png(1, 4096), 'png').ok).toBe(true);
    expect(inspectImage(png(4097, 1), 'png').ok).toBe(false);
    expect(inspectImage(png(1, 4097), 'png').ok).toBe(false);
  });

  it('T-PKG-48: 画素数は 1,600 万ちょうどが通り、+1 画素は 4096 以内でも失敗する', () => {
    expect(inspectImage(png(4000, 4000), 'png').ok).toBe(true);
    const over = inspectImage(png(4000, 4001), 'png');
    expect(over.ok).toBe(false);
    expect(!over.ok && over.message).toContain('16,000,000');
    expect(inspectImage(png(4096, 4096), 'png').ok).toBe(false);
  });

  it('T-PKG-49: 数百バイトで寸法が巨大な画像は、デコードせずに失敗する', () => {
    const huge = padTo(png(65535, 65535), 300);
    const result = inspectImage(huge, 'png');
    expect(result.ok).toBe(false);
    expect(inspectImage(gif(65535, 65535), 'gif').ok).toBe(false);
    expect(inspectImage(jpeg(65535, 65535), 'jpeg').ok).toBe(false);
    expect(inspectImage(webpVp8x(16777216, 16777216), 'webp').ok).toBe(false);
  });

  it('T-PKG-50: 画像は 5 MB ちょうどが通り、+1 バイトで失敗する', () => {
    const limit = PACKAGE_LIMITS.imageBytes;
    expect(inspectImage(padTo(png(10, 10), limit), 'png').ok).toBe(true);
    const over = inspectImage(padTo(png(10, 10), limit + 1), 'png');
    expect(over.ok).toBe(false);
    expect(!over.ok && over.message).toContain('5 MB');
  });

  it('T-PKG-51: GIF は論理画面記述子から寸法を読む（フレーム数に関わらない）', () => {
    const frames = new Uint8Array(5000).fill(0x21);
    const animated = new Uint8Array([...gif(40, 30), ...frames]);
    expect(size(inspectImage(animated, 'gif'))).toEqual([40, 30]);
    expect(size(inspectImage(gif(7, 9, '87a'), 'gif'))).toEqual([7, 9]);
  });

  it('T-PKG-52: JPEG は APP などを飛ばして SOF を読み、SOF0・SOF2 など複数の種類を読める', () => {
    expect(size(inspectImage(jpeg(111, 222, { segments: [16, 4000, 20] }), 'jpeg'))).toEqual([111, 222]);
    for (const sof of [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc9, 0xcf]) {
      expect(size(inspectImage(jpeg(50, 60, { sof }), 'jpeg')), sof.toString(16)).toEqual([50, 60]);
    }
    expect(size(inspectImage(jpeg(50, 60, { fill: 3 }), 'jpeg'))).toEqual([50, 60]);
  });

  it('T-PKG-53: JPEG で SOF が見つからないまま走査が続くと、範囲の上限で打ち切られて失敗する', () => {
    const manyMarkers = jpeg(10, 10, { segments: new Array<number>(PACKAGE_LIMITS.jpegScanMarkers + 10).fill(2) });
    expect(inspectImage(manyMarkers, 'jpeg').ok).toBe(false);
    const longFill = jpeg(10, 10, { fill: PACKAGE_LIMITS.jpegScanBytes + 100 });
    expect(inspectImage(longFill, 'jpeg').ok).toBe(false);
    const justInside = jpeg(10, 10, { segments: new Array<number>(PACKAGE_LIMITS.jpegScanMarkers - 10).fill(2) });
    expect(inspectImage(justInside, 'jpeg').ok).toBe(true);
  });
});
