/**
 * data URL の検査と復号のテスト。
 */
import { describe, expect, it } from 'vitest';
import { decodeDataUrl } from './data-url.ts';
import { dataUrl, gif, jpeg, png, toBase64, webpVp8 } from './fixtures/builders.ts';

describe('decodeDataUrl', () => {
  it('T-PKG-56: 許可した4種の MIME 型の base64 を受け付け、復号した中身を返す', () => {
    const cases = [
      ['image/png', png(5, 5), 'png'],
      ['image/jpeg', jpeg(5, 5), 'jpeg'],
      ['image/gif', gif(5, 5), 'gif'],
      ['image/webp', webpVp8(5, 5), 'webp'],
    ] as const;
    for (const [mime, bytes, kind] of cases) {
      const result = decodeDataUrl(dataUrl(mime, bytes));
      expect(result.ok, mime).toBe(true);
      if (result.ok) {
        expect(result.kind).toBe(kind);
        expect([...result.bytes]).toEqual([...bytes]);
      }
    }
  });

  it('T-PKG-57: svg・html・octet-stream・MIME 型なしの data URL は失敗する', () => {
    const cases = [
      'data:image/svg+xml,%3Csvg%3E%3C/svg%3E',
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      'data:text/html,<b>x</b>',
      `data:application/octet-stream;base64,${toBase64(png(1, 1))}`,
      `data:;base64,${toBase64(png(1, 1))}`,
      `data:base64,${toBase64(png(1, 1))}`,
    ];
    for (const src of cases) expect(decodeDataUrl(src).ok, src).toBe(false);
  });

  it('T-PKG-60: base64 として不正な data URL は例外にならず失敗する', () => {
    for (const body of ['!!!!', 'abc', 'AAA=A', '=AAA', 'あいうえ']) {
      expect(() => decodeDataUrl(`data:image/png;base64,${body}`)).not.toThrow();
      expect(decodeDataUrl(`data:image/png;base64,${body}`).ok, body).toBe(false);
    }
    expect(decodeDataUrl('data:image/png;base64').ok).toBe(false);
    expect(decodeDataUrl(`data:image/png,${toBase64(png(1, 1))}`).ok).toBe(false);
  });

  it('T-PKG-56: 画像の上限を超える大きさの data URL は復号せずに失敗する', () => {
    const big = `data:image/png;base64,${'A'.repeat(8_000_000)}`;
    const result = decodeDataUrl(big);
    expect(result.ok).toBe(false);
  });
});
