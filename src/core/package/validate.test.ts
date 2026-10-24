/**
 * パッケージ全体の検証（相対パスの解決、Markdown 内の画像、画像・data URL の検査、保存するファイルの決定）のテスト。
 */
import { describe, expect, it } from 'vitest';
import { CompiledTourSchema } from '../tour/index.ts';
import {
  dataUrl,
  gif,
  guideStep,
  jpeg,
  padTo,
  png,
  tourYaml,
  utf8,
  webpVp8,
  webpVp8l,
  webpVp8x,
} from './fixtures/builders.ts';
import type { Bytes } from './bytes.ts';
import { validatePackage } from './validate.ts';
import type { PackageResult } from './validate.ts';

type Entries = Record<string, Bytes | string>;

function pack(yamlText: string, files: Entries | null): PackageResult {
  const entries =
    files === null
      ? null
      : new Map(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? utf8(v) : v] as const));
  return validatePackage({ fileName: 'p.zip', yamlText, entries });
}

function errorsOf(result: PackageResult): { file: string; line: number | null; path: string; message: string }[] {
  return result.ok ? [] : result.errors;
}

const okPng = png(10, 20);

describe('validatePackage の参照の解決', () => {
  it('T-PKG-32: bodyFile は tour.yaml の場所を起点に解決され、Markdown が保存の対象になる', () => {
    const result = pack(tourYaml({ steps: guideStep('a', { bodyFile: 'steps/a.md' }) }), { 'steps/a.md': '# 手順' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tour.steps[0]?.bodyFile).toBe('steps/a.md');
      const file = result.files.find((f) => f.path === 'steps/a.md');
      expect(file?.mime).toBe('text/markdown');
      expect(new TextDecoder().decode(file?.bytes)).toBe('# 手順');
    }
  });

  it('T-PKG-33: media.src はサブディレクトリでも tour.yaml の場所を起点に解決される', () => {
    const result = pack(tourYaml({ steps: guideStep('a', { media: 'images/a.png' }) }), { 'images/a.png': okPng });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tour.steps[0]?.media?.src).toBe('images/a.png');
      expect(result.files).toHaveLength(1);
      expect(result.files[0]).toMatchObject({ path: 'images/a.png', mime: 'image/png', width: 10, height: 20 });
    }
  });

  it('T-PKG-34: Markdown 内の画像は、その Markdown の場所を起点に解決される（tour.yaml からではない）', () => {
    const yaml = tourYaml({ steps: guideStep('a', { bodyFile: 'steps/a.md' }) });
    const good = pack(yaml, { 'steps/a.md': '![図](img/a.png)', 'steps/img/a.png': okPng });
    expect(good.ok).toBe(true);
    const bad = pack(yaml, { 'steps/a.md': '![図](img/a.png)', 'img/a.png': okPng });
    expect(bad.ok).toBe(false);
  });

  it('T-PKG-35: steps/a.md の ../images/a.png は、パッケージ内に留まるので解決できる', () => {
    const yaml = tourYaml({ steps: guideStep('a', { bodyFile: 'steps/a.md' }) });
    const result = pack(yaml, { 'steps/a.md': '![図](../images/a.png)', 'images/a.png': okPng });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.files.map((f) => f.path).sort()).toEqual(['images/a.png', 'steps/a.md']);
  });

  it('T-PKG-34: Markdown の画像が日本語のパスでも（パーセントエンコードされても）解決できる', () => {
    const yaml = tourYaml({ steps: guideStep('a', { bodyFile: 'a.md' }) });
    const result = pack(yaml, { 'a.md': '![図](images/図1.png)\n\n![b](<images/a b.png>)', 'images/図1.png': okPng, 'images/a b.png': okPng });
    expect(result.ok).toBe(true);
  });

  it('T-PKG-36: パッケージの外に出る参照は、参照元の場所を示すエラーになる', () => {
    const yaml = tourYaml({
      steps: guideStep('a', { media: '../outside.png' }) + guideStep('b', { bodyFile: 'steps/../../x.md' }),
    });
    const errors = errorsOf(pack(yaml, {}));
    expect(errors.map((e) => e.path)).toEqual(['steps[0].media.src', 'steps[1].bodyFile']);
    expect(errors.every((e) => e.file === 'p.zip/tour.yaml' && e.line !== null)).toBe(true);
    expect(errors[0]?.message).toContain('パッケージの外');
  });

  it('T-PKG-36: Markdown の中の外への参照は、その Markdown の場所を示す', () => {
    const yaml = tourYaml({ steps: guideStep('a', { bodyFile: 'steps/a.md' }) });
    const errors = errorsOf(pack(yaml, { 'steps/a.md': '行1\n\n![図](../../x.png)' }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ file: 'p.zip/steps/a.md', line: 3 });
  });

  it('T-PKG-37: 参照先が存在しないとき、参照元の場所を示すエラーになる', () => {
    const yaml = tourYaml({ steps: guideStep('a', { media: 'images/none.png', bodyFile: 'none.md' }) });
    const errors = errorsOf(pack(yaml, {}));
    expect(errors.map((e) => e.path).sort()).toEqual(['steps[0].bodyFile', 'steps[0].media.src']);
    expect(errors.every((e) => e.message.includes('見つかりません'))).toBe(true);
  });

  it('T-PKG-38: 絶対パスの参照はエラーになる', () => {
    const yaml = tourYaml({ steps: guideStep('a', { media: '/images/a.png' }) });
    const errors = errorsOf(pack(yaml, { '/images/a.png': okPng, 'images/a.png': okPng }));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('絶対パス');
  });

  it('T-PKG-39: bodyFile の Markdown は 200 KB ちょうどが通り、+1 バイトはエラーになる', () => {
    const yaml = tourYaml({ steps: guideStep('a', { bodyFile: 'a.md' }) });
    const limit = 200 * 1024;
    const body = (n: number) => padTo(utf8('# a\n'), n).fill(0x20, 4);
    expect(pack(yaml, { 'a.md': body(limit) }).ok).toBe(true);
    const over = errorsOf(pack(yaml, { 'a.md': body(limit + 1) }));
    expect(over).toHaveLength(1);
    expect(over[0]?.message).toContain('200 KB');
  });

  it('T-PKG-40: 参照されないファイルはエラーにならず、保存の対象にもならない', () => {
    const yaml = tourYaml({ steps: guideStep('a', { media: 'images/a.png' }) });
    const result = pack(yaml, { 'images/a.png': okPng, 'unused.png': okPng, 'bad.svg': 'x', 'notes.txt': 'memo' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.files.map((f) => f.path)).toEqual(['images/a.png']);
  });

  it('T-PKG-40: 同じ画像を複数の場所から参照しても、保存は1つ', () => {
    const yaml = tourYaml({
      steps: guideStep('a', { media: 'i.png', bodyFile: 'a.md' }) + guideStep('b', { media: 'i.png', bodyFile: 'a.md' }),
    });
    const result = pack(yaml, { 'i.png': okPng, 'a.md': '![x](i.png)' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.files.map((f) => f.path).sort()).toEqual(['a.md', 'i.png']);
  });

  it('T-PKG-41: bodyFile と body を両方書くとエラーになる', () => {
    const yaml = tourYaml({ steps: guideStep('a', { bodyFile: 'a.md', body: '本文' }) });
    const errors = errorsOf(pack(yaml, { 'a.md': '#' }));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.path).toBe('steps[0].bodyFile');
  });

  it('T-PKG-42: bodyFile が .md ではないファイルを指すとエラーになる', () => {
    const yaml = tourYaml({ steps: guideStep('a', { bodyFile: 'a.txt' }) });
    expect(errorsOf(pack(yaml, { 'a.txt': '#' })).length).toBeGreaterThan(0);
  });

  it('compiled（返すツアー）は CompiledTourSchema を通る', () => {
    const yaml = tourYaml({ steps: guideStep('a', { bodyFile: './steps/../steps/a.md', media: 'images/./a.png' }) });
    const result = pack(yaml, { 'steps/a.md': '本文', 'images/a.png': okPng });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(CompiledTourSchema.safeParse(result.tour).success).toBe(true);
      expect(result.tour.steps[0]?.bodyFile).toBe('steps/a.md');
      expect(result.tour.steps[0]?.media?.src).toBe('images/a.png');
    }
  });
});

describe('validatePackage の画像の検査', () => {
  const withImage = (name: string, bytes: Bytes | string) =>
    pack(tourYaml({ steps: guideStep('a', { media: name }) }), { [name]: bytes });

  it('T-PKG-43: 拡張子と署名が一致する PNG・JPEG・GIF・WebP を受け付け、縦横を files に持つ', () => {
    const cases: [string, Bytes, number, number][] = [
      ['a.png', png(11, 12), 11, 12],
      ['a.jpg', jpeg(13, 14), 13, 14],
      ['a.JPEG', jpeg(15, 16), 15, 16],
      ['a.gif', gif(17, 18), 17, 18],
      ['a.webp', webpVp8(19, 20), 19, 20],
      ['b.webp', webpVp8l(21, 22), 21, 22],
      ['c.webp', webpVp8x(23, 24), 23, 24],
    ];
    for (const [name, bytes, w, h] of cases) {
      const result = withImage(name, bytes);
      expect(result.ok, name).toBe(true);
      if (result.ok) expect(result.files[0], name).toMatchObject({ width: w, height: h });
    }
  });

  it('T-PKG-44: 拡張子と中身が一致しないとエラーになる', () => {
    expect(withImage('a.png', jpeg(5, 5)).ok).toBe(false);
    expect(withImage('a.gif', png(5, 5)).ok).toBe(false);
  });

  it('T-PKG-45: 許可外の拡張子はエラーになる', () => {
    for (const name of ['a.bmp', 'a.svg', 'a.tiff', 'a']) {
      expect(withImage(name, okPng).ok, name).toBe(false);
    }
  });

  it('T-PKG-46: ヘッダーが切れた画像はエラーになる', () => {
    expect(withImage('a.png', png(5, 5).slice(0, 12)).ok).toBe(false);
    expect(withImage('a.jpg', jpeg(5, 5, { noSof: true })).ok).toBe(false);
  });

  it('T-PKG-47・T-PKG-48・T-PKG-49: 寸法の上限を超える画像はエラーになる', () => {
    expect(withImage('a.png', png(4097, 10)).ok).toBe(false);
    expect(withImage('a.png', png(4000, 4001)).ok).toBe(false);
    expect(withImage('a.png', png(4000, 4000)).ok).toBe(true);
    expect(withImage('a.png', padTo(png(65535, 65535), 400)).ok).toBe(false);
  });

  it('T-PKG-50: 画像は 5 MB ちょうどが通り、+1 バイトはエラーになる', () => {
    const limit = 5 * 1024 * 1024;
    expect(withImage('a.png', padTo(png(10, 10), limit)).ok).toBe(true);
    expect(withImage('a.png', padTo(png(10, 10), limit + 1)).ok).toBe(false);
  });

  it('T-PKG-54: 画像の検査は media.src と Markdown 内の画像の両方に行われる', () => {
    const yaml = tourYaml({ steps: guideStep('a', { media: 'm.png', bodyFile: 'a.md' }) });
    const errors = errorsOf(pack(yaml, { 'm.png': jpeg(5, 5), 'a.md': '![x](n.png)', 'n.png': png(5000, 5) }));
    expect(errors).toHaveLength(2);
    expect(errors.map((e) => e.file).sort()).toEqual(['p.zip/a.md', 'p.zip/tour.yaml']);
  });

  it('T-PKG-55: media.alt がないとエラーになり、Markdown の代替文が空でもエラーになる', () => {
    const yaml = tourYaml({
      steps: `  - id: a
    title: a
    kind: guide
    media:
      src: images/a.png
`,
    });
    const errors = errorsOf(pack(yaml, { 'images/a.png': okPng }));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toContain('alt');
    const md = tourYaml({ steps: guideStep('a', { bodyFile: 'a.md' }) });
    expect(pack(md, { 'a.md': '![](i.png)', 'i.png': okPng }).ok).toBe(false);
  });

  it('T-PKG-61: 画像の参照が .svg のとき、zip の中にあってもエラーになる', () => {
    const errors = errorsOf(withImage('a.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>'));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('SVG');
  });
});

describe('validatePackage の data URL・外部 URL・単体 YAML', () => {
  const yamlWith = (src: string) => tourYaml({ steps: guideStep('a', { media: src }) });

  it('T-PKG-56: 許可した data URL は受け付け、画像と同じ検査を受ける', () => {
    expect(pack(yamlWith(dataUrl('image/png', png(5, 5))), null).ok).toBe(true);
    expect(pack(yamlWith(dataUrl('image/jpeg', jpeg(5, 5))), null).ok).toBe(true);
    expect(pack(yamlWith(dataUrl('image/gif', gif(5, 5))), null).ok).toBe(true);
    expect(pack(yamlWith(dataUrl('image/webp', webpVp8(5, 5))), null).ok).toBe(true);
    expect(pack(yamlWith(dataUrl('image/png', padTo(png(5, 5), 5 * 1024 * 1024 + 1))), null).ok).toBe(false);
    // 5 MB を超える data URL を YAML に埋めて解析するので重い。ほかの重いテストと同じ時間切れにする
  }, 30_000);

  it('T-PKG-57: 画像でない data URL はエラーになる', () => {
    for (const src of [
      'data:image/svg+xml,%3Csvg%2F%3E',
      'data:text/html,<b>x</b>',
      'data:application/octet-stream;base64,AAAA',
      'data:;base64,AAAA',
    ]) {
      expect(pack(yamlWith(src), null).ok, src).toBe(false);
    }
  });

  it('T-PKG-58: MIME 型は png だが中身が PNG ではない data URL はエラーになる', () => {
    expect(pack(yamlWith(dataUrl('image/png', jpeg(5, 5))), null).ok).toBe(false);
    expect(pack(yamlWith(dataUrl('image/png', utf8('plain text'))), null).ok).toBe(false);
  });

  it('T-PKG-59: 寸法が巨大な小さい data URL の画像はエラーになる', () => {
    expect(pack(yamlWith(dataUrl('image/png', png(65535, 65535))), null).ok).toBe(false);
  });

  it('T-PKG-60: base64 として不正な data URL は、例外にならずエラーになる', () => {
    expect(() => pack(yamlWith('data:image/png;base64,@@@@'), null)).not.toThrow();
    expect(pack(yamlWith('data:image/png;base64,@@@@'), null).ok).toBe(false);
  });

  it('T-PKG-62: 外部 URL の画像（http・https・//host）はエラーになる', () => {
    for (const src of ['http://example.com/a.png', 'https://example.com/a.png', '//example.com/a.png']) {
      const errors = errorsOf(pack(yamlWith(src), { 'a.png': okPng }));
      expect(errors, src).toHaveLength(1);
      expect(errors[0]?.message).toContain('外部');
    }
  });

  it('T-PKG-63: Markdown 内の画像が SVG・外部 URL・パッケージ外のとき、それぞれエラーになる', () => {
    const yaml = tourYaml({ steps: guideStep('a', { bodyFile: 'a.md' }) });
    const md = ['![a](x.svg)', '![b](https://example.com/b.png)', '![c](../c.png)', '![d](//h/d.png)'].join('\n\n');
    const errors = errorsOf(pack(yaml, { 'a.md': md, 'x.svg': '<svg/>' }));
    expect(errors).toHaveLength(4);
    expect(errors.map((e) => e.line)).toEqual([1, 3, 5, 7]);
  });

  it('T-PKG-64: 単体の .yaml が相対パスで bodyFile・media.src を参照するとエラーになる', () => {
    const yaml = tourYaml({ steps: guideStep('a', { bodyFile: 'a.md', media: 'a.png' }) });
    const result = validatePackage({ fileName: 't.yaml', yamlText: yaml, entries: null });
    expect(errorsOf(result).map((e) => e.path).sort()).toEqual(['steps[0].bodyFile', 'steps[0].media.src']);
    expect(errorsOf(result).every((e) => e.file === 't.yaml')).toBe(true);
  });

  it('T-PKG-65: 単体の .yaml が許可した data URL の画像を使うと取り込める', () => {
    const result = validatePackage({
      fileName: 't.yaml',
      yamlText: yamlWith(dataUrl('image/png', png(5, 5))),
      entries: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.files).toEqual([]);
  });

  it('インラインの body に書いた Markdown の画像も、同じ規則で検査される', () => {
    const yaml = tourYaml({ steps: guideStep('a', { body: '![x](a.png)' }) });
    expect(pack(yaml, { 'a.png': okPng }).ok).toBe(true);
    expect(errorsOf(pack(yaml, {}))[0]?.path).toBe('steps[0].body');
    expect(validatePackage({ fileName: 't.yaml', yamlText: yaml, entries: null }).ok).toBe(false);
  });
});

describe('validatePackage の形式・警告', () => {
  it('T-PKG-08: 形式のエラーはファイル名・行番号・項目の場所・理由を持つ', () => {
    const errors = errorsOf(pack('schemaVersion: 3\nid: a b\n', {}));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatchObject({ file: 'p.zip/tour.yaml' });
    expect(errors[0]?.line).not.toBeNull();
    expect(errors[0]?.message.length).toBeGreaterThan(0);
  });

  it('T-PKG-07: 警告は結果に含まれ、ツアーは返る', () => {
    const yaml = `schemaVersion: 3
id: warn
name: 警告
origins:
  - https://example.com
steps:
  - id: s1
    title: ボタン
    url:
      origin: https://example.com
    target:
      testId: save
`;
    const result = pack(yaml, {});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings).toHaveLength(1);
  });
});

describe('Markdown の画像の記法で、markdown-it が拒否する URL', () => {
  const bodyOf = (body: string) => tourYaml({ steps: guideStep('s1', { body }) });

  it.each([
    '![x](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)',
    '![x](javascript:alert(1))',
    '![x](file:///etc/passwd)',
    '![x](vbscript:run)',
    '文の途中に ![図](javascript:void(0)) がある',
  ])('T-PKG-61: 本文の %s はエラーになる（追加）', (body) => {
    const errors = errorsOf(pack(bodyOf(body), null));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.map((e) => e.message).join()).toContain('使えない URL');
  });

  it('T-PKG-61: bodyFile の Markdown に書かれた拒否される URL もエラーになる（追加）', () => {
    const yaml = tourYaml({ steps: guideStep('s1', { bodyFile: 'a.md' }) });
    const result = pack(yaml, { 'a.md': '![x](javascript:alert(1))' });
    expect(result.ok).toBe(false);
  });

  it('T-PKG-54: コードの中の記法や、通常の画像は影響を受けない（追加）', () => {
    expect(pack(bodyOf('`![x](javascript:a)`'), null).ok).toBe(true);
    expect(pack(bodyOf('```\n![x](javascript:a)\n```'), null).ok).toBe(true);
    expect(pack(bodyOf(`![ok](${dataUrl('image/png', png(5, 5))})`), null).ok).toBe(true);
  });
});
