/**
 * extractMarkdownImages・findImageSyntax のテスト。画像の記法の抽出が、`![` を並べた最悪の入力でも
 * 入力の長さに比例する手間で終わることと、正規表現による抽出と同じ結果を返すことを確かめる。
 */
import { describe, expect, it } from 'vitest';
import { PACKAGE_LIMITS } from './limits.ts';
import { extractMarkdownImages, findImageSyntax } from './md-images.ts';

/** 抽出の基準にする正規表現（文字列に残った画像の記法）。 */
const REFERENCE = /!\[([^\]]*)\]\(([^)]*)\)/g;
const referenceOf = (text: string): { alt: string; src: string }[] =>
  [...text.matchAll(REFERENCE)].map((m) => ({ alt: m[1] ?? '', src: m[2] ?? '' }));

const MAX_MS = 5000;
const repeatTo = (unit: string, bytes: number, tail = ''): string => unit.repeat(Math.floor((bytes - tail.length) / unit.length)) + tail;

describe('findImageSyntax', () => {
  it('R-FINAL-02: 画像の記法を先頭から順に拾い、alt と src を返す', () => {
    expect(findImageSyntax('x ![a](b) y ![c d](e f) z')).toEqual([
      { alt: 'a', src: 'b' },
      { alt: 'c d', src: 'e f' },
    ]);
    expect(findImageSyntax('![](x)')).toEqual([{ alt: '', src: 'x' }]);
  });

  it('R-FINAL-02: 閉じのないもの・`](` が続かないものは拾わず、あとの正しい記法は拾う', () => {
    expect(findImageSyntax('![a ![b](c)')).toEqual([{ alt: 'a ![b', src: 'c' }]);
    expect(findImageSyntax('![a] ![b](c)')).toEqual([{ alt: 'b', src: 'c' }]);
    expect(findImageSyntax('![a](b')).toEqual([]);
    expect(findImageSyntax('![a]')).toEqual([]);
  });

  it('R-FINAL-02: 記号を並べたランダムな入力で、正規表現と同じ結果になる', () => {
    const alphabet = ['!', '[', ']', '(', ')', 'a', ' ', '\n'];
    let seed = 12345;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let n = 0; n < 3000; n++) {
      const length = next() % 24;
      let text = '';
      for (let i = 0; i < length; i++) text += alphabet[next() % alphabet.length] ?? '';
      expect(findImageSyntax(text), JSON.stringify(text)).toEqual(referenceOf(text));
    }
  });
});

describe('extractMarkdownImages', () => {
  it('R-FINAL-02: 画像と、画像として受け付けられなかった記法（rejected）を、行番号つきで返す', () => {
    const images = extractMarkdownImages('# t\n\n![ok](img/a.png)\n\n![bad](javascript:alert(1))\n');
    expect(images).toEqual([
      { src: 'img/a.png', alt: 'ok', line: 3, rejected: false },
      { src: 'javascript:alert(1', alt: 'bad', line: 5, rejected: true },
    ]);
  });

  it('R-FINAL-02: コードの中の記法は拾わない', () => {
    expect(extractMarkdownImages('`![a](b.png)`\n\n```\n![a](c.png)\n```\n')).toEqual([]);
  });
});

describe('画像の記法の抽出の手間（最悪の入力）', () => {
  const cases: [string, string][] = [
    ['`![ ` の連続', repeatTo('![ ', PACKAGE_LIMITS.markdownBytes)],
    ['`![` の連続', repeatTo('![', PACKAGE_LIMITS.markdownBytes)],
    ['`![a](` の連続', repeatTo('![a](', PACKAGE_LIMITS.markdownBytes)],
    ['危険な URL の記法の連続', repeatTo('![a](javascript:', PACKAGE_LIMITS.markdownBytes)],
    ['閉じ括弧だけが末尾にある', repeatTo('![a](', PACKAGE_LIMITS.markdownBytes, ')')],
    ['`]` だけが末尾にある', repeatTo('![ ', PACKAGE_LIMITS.markdownBytes, ']')],
  ];
  it.each(cases)(
    'R-FINAL-02 R-FINAL-04: 上限ちょうどの Markdown（%s）でも、5 秒以内に終わる',
    (_name, text) => {
      expect(text.length).toBeLessThanOrEqual(PACKAGE_LIMITS.markdownBytes);
      const started = performance.now();
      extractMarkdownImages(text);
      expect(performance.now() - started).toBeLessThan(MAX_MS);
    },
    30_000,
  );
});
