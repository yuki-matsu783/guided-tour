/**
 * importFiles の入力の受け付け・zip の上限・エントリ名・相対パスの解決・data URL・上書きの確認・悪意ある資料のテスト。
 * 保存の中身・容量の予約・通知は import-storage.test.ts。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildZip,
  dataUrl,
  gif,
  guideStep,
  jpeg,
  padTo,
  png,
  tourYaml,
  utf8,
} from '../../core/package/fixtures/builders.ts';
import type { Bytes } from '../../core/package/index.ts';
import { importFiles } from './import-files.ts';
import type { ImportResult } from './types.ts';
import { MB, file, isEmpty, padYaml, setup, snapshot } from './test-support.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

function messages(result: ImportResult | undefined): string {
  return result?.status === 'rejected' ? result.errors.map((e) => e.message).join('\n') : '';
}

const warnYaml = `schemaVersion: 3
id: warn
name: 警告あり
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

describe('入力の受け付け', () => {
  it('T-PKG-01: .yaml 単体を検証・保存し、結果にツアー名と対象サイトが入る', async () => {
    const { deps, db } = await setup();
    const [result] = await importFiles([file('tour.yaml', tourYaml({ id: 'one', name: '最初のツアー' }))], deps);
    expect(result).toMatchObject({
      status: 'imported',
      tourId: 'one',
      name: '最初のツアー',
      origins: ['https://example.com'],
      warnings: [],
    });
    expect((await snapshot(db)).tours.map((t) => t.id)).toEqual(['one']);
  });

  it('T-PKG-02: .yml 単体も .yaml と同じく取り込める（拡張子は大文字でもよい）', async () => {
    const { deps } = await setup();
    const results = await importFiles(
      [file('a.yml', tourYaml({ id: 'a' })), file('B.YAML', tourYaml({ id: 'b' }))],
      deps,
    );
    expect(results.map((r) => r.status)).toEqual(['imported', 'imported']);
  });

  it('T-PKG-03: 最上位に tour.yaml を含む .zip を取り込める', async () => {
    const { deps } = await setup();
    const zip = buildZip([{ name: 'tour.yaml', data: tourYaml({ id: 'z' }) }]);
    const [result] = await importFiles([file('pkg.zip', zip)], deps);
    expect(result?.status).toBe('imported');
  });

  it('T-PKG-04: tour.yaml が最上位になく（サブディレクトリの中だけ）、または存在しない zip はエラーになる', async () => {
    const { deps, db } = await setup();
    const sub = buildZip([{ name: 'dir/tour.yaml', data: tourYaml() }]);
    const none = buildZip([{ name: 'readme.txt', data: 'x' }]);
    const results = await importFiles([file('sub.zip', sub), file('none.zip', none)], deps);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(messages(results[0])).toContain('tour.yaml');
    expect(await isEmpty(db)).toBe(true);
  });

  it('T-PKG-05: .yaml・.yml・.zip 以外の拡張子のファイルはエラーになる', async () => {
    const { deps, db } = await setup();
    const results = await importFiles(
      [file('a.txt', tourYaml()), file('b.json', '{}'), file('c', tourYaml()), file('d.zip.bak', 'x')],
      deps,
    );
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(await isEmpty(db)).toBe(true);
  });

  it('T-PKG-06: 複数のファイルを渡すと、ファイルごとに結果が返り、不正なものがあっても他は保存される', async () => {
    const { deps, db } = await setup();
    const results = await importFiles(
      [
        file('good1.yaml', tourYaml({ id: 'g1' })),
        file('bad.yaml', 'schemaVersion: 3\nid: ["x"]\n'),
        file('good2.zip', buildZip([{ name: 'tour.yaml', data: tourYaml({ id: 'g2' }) }])),
        file('broken.zip', utf8('not a zip')),
      ],
      deps,
    );
    expect(results.map((r) => [r.fileName, r.status])).toEqual([
      ['good1.yaml', 'imported'],
      ['bad.yaml', 'rejected'],
      ['good2.zip', 'imported'],
      ['broken.zip', 'rejected'],
    ]);
    expect((await snapshot(db)).tours.map((t) => t.id).sort()).toEqual(['g1', 'g2']);
  });

  it('T-PKG-07: 警告のあるツアーは保存され、結果に警告が入る', async () => {
    const { deps, db } = await setup();
    const [result] = await importFiles([file('w.yaml', warnYaml)], deps);
    expect(result?.status).toBe('imported');
    if (result?.status === 'imported') {
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]?.path).toContain('steps[0]');
    }
    expect((await snapshot(db)).tours).toHaveLength(1);
  });

  it('T-PKG-08: エラーのあるツアーは保存されず、結果にファイル名・行番号・項目の場所・理由が入る', async () => {
    const { deps, db, notify } = await setup();
    const text = tourYaml({ steps: '  - id: s1\n    title: 1\n    kind: weird\n' });
    const [result] = await importFiles([file('bad.yaml', text)], deps);
    expect(result?.status).toBe('rejected');
    if (result?.status === 'rejected') {
      const e = result.errors[0];
      expect(e?.file).toBe('bad.yaml');
      expect(typeof e?.line).toBe('number');
      expect(e?.path).toMatch(/^steps\[0\]/);
      expect(e?.message.length).toBeGreaterThan(0);
    }
    expect(await isEmpty(db)).toBe(true);
    expect(notify).not.toHaveBeenCalled();
  });

  it('T-PKG-09: zip 内の tour.yaml は 1 MB ちょうどが解析され、+1 バイトは上限超過のエラーになる', async () => {
    const { deps, db } = await setup();
    const exact = buildZip([{ name: 'tour.yaml', data: padYaml(tourYaml({ id: 'big' }), MB) }]);
    const over = buildZip([{ name: 'tour.yaml', data: padYaml(tourYaml({ id: 'big2' }), MB + 1) }]);
    const [a, b] = await importFiles([file('exact.zip', exact), file('over.zip', over)], deps);
    expect(a?.status).toBe('imported');
    expect(b?.status).toBe('rejected');
    expect(messages(b)).toContain('1 MB');
    expect((await snapshot(db)).tours.map((t) => t.id)).toEqual(['big']);
  });

  it('T-PKG-10: 単体の .yaml が 1 MB+1 バイトなら上限超過のエラーになる（1 MB ちょうどは通る）', async () => {
    const { deps } = await setup();
    const [exact, over] = await importFiles(
      [file('a.yaml', padYaml(tourYaml({ id: 'a' }), MB)), file('b.yaml', padYaml(tourYaml({ id: 'b' }), MB + 1))],
      deps,
    );
    expect(exact?.status).toBe('imported');
    expect(over?.status).toBe('rejected');
    expect(messages(over)).toContain('1 MB');
  });
});

describe('zip の展開と上限', () => {
  /** 圧縮サイズがちょうど `size` バイトの zip（stored の詰め物で調整する）。 */
  function zipOfSize(size: number): Bytes {
    const specs = (pad: number) => [
      { name: 'tour.yaml', data: tourYaml({ id: 'sized' }) },
      { name: 'pad.bin', data: new Uint8Array(pad), method: 'store' as const },
    ];
    return buildZip(specs(size - buildZip(specs(0)).length));
  }

  it('T-PKG-11: 圧縮サイズが 20 MB ちょうどの zip は展開に進み、+1 バイトは展開せずに上限超過になる', async () => {
    const { deps } = await setup();
    const exact = zipOfSize(20 * MB);
    expect(exact.length).toBe(20 * MB);
    const [ok] = await importFiles([file('exact.zip', exact)], deps);
    expect(ok?.status).toBe('imported');
    const [over] = await importFiles([file('over.zip', zipOfSize(20 * MB + 1))], deps);
    expect(over?.status).toBe('rejected');
    expect(messages(over)).toContain('20 MB');
    expect(messages(over)).toContain('展開はしません');
  }, 30_000);

  it('T-PKG-12: 展開後の合計が 50 MB ちょうどなら成功し、+1 バイトで打ち切られる', async () => {
    const { deps } = await setup();
    const yaml = tourYaml({ id: 'fifty' });
    const make = (extra: number) =>
      buildZip([
        { name: 'tour.yaml', data: yaml },
        { name: 'big.bin', data: new Uint8Array(50 * MB - utf8(yaml).length + extra) },
      ]);
    const [ok] = await importFiles([file('a.zip', make(0))], deps);
    expect(ok?.status).toBe('imported');
    const [over] = await importFiles([file('b.zip', make(1))], deps);
    expect(over?.status).toBe('rejected');
    expect(messages(over)).toContain('50 MB');
  }, 30_000);

  it('T-PKG-13: 宣言サイズを偽った zip は、実際に展開した量で数えて拒否される', async () => {
    const { deps, db } = await setup();
    const zip = buildZip([
      { name: 'tour.yaml', data: tourYaml(), declaredSize: 5 },
      { name: 'lie.bin', data: new Uint8Array(60 * MB), declaredSize: 1 },
    ]);
    const [result] = await importFiles([file('lie.zip', zip)], deps);
    expect(result?.status).toBe('rejected');
    expect(messages(result)).toContain('50 MB');
    expect(await isEmpty(db)).toBe(true);
  }, 30_000);

  it('T-PKG-14: zip 爆弾は上限で止まり、取り込み中は処理を譲りながら進む', async () => {
    const yieldToHost = vi.fn(() => Promise.resolve());
    const { deps, db } = await setup({ unzip: { yieldToHost, sliceMs: 0 } });
    const zip = buildZip([
      { name: 'tour.yaml', data: tourYaml() },
      { name: 'bomb.bin', data: new Uint8Array(150 * MB) },
    ]);
    const [result] = await importFiles([file('bomb.zip', zip)], deps);
    expect(result?.status).toBe('rejected');
    expect(yieldToHost).toHaveBeenCalled();
    expect(await isEmpty(db)).toBe(true);
  }, 30_000);

  it('T-PKG-15: ファイル数が 500 ちょうどなら成功し、501 なら打ち切られる', async () => {
    const { deps } = await setup();
    const make = (n: number) =>
      buildZip([
        { name: 'tour.yaml', data: tourYaml({ id: 'many' }) },
        ...Array.from({ length: n - 1 }, (_, i) => ({ name: `f${String(i)}.txt`, data: 'x' })),
      ]);
    const [ok] = await importFiles([file('a.zip', make(500))], deps);
    expect(ok?.status).toBe('imported');
    const [over] = await importFiles([file('b.zip', make(501))], deps);
    expect(over?.status).toBe('rejected');
  });

  it('T-PKG-16: 打ち切りのエラーに、超えた上限の名前と値が含まれる', async () => {
    const { deps } = await setup();
    const count = buildZip(Array.from({ length: 501 }, (_, i) => ({ name: `f${String(i)}.txt`, data: 'x' })));
    const [a, b] = await importFiles(
      [file('count.zip', count), file('size.zip', zipBig())],
      deps,
    );
    expect(messages(a)).toMatch(/ファイル数.*500/);
    expect(messages(b)).toMatch(/圧縮|サイズ/);
    function zipBig(): Bytes {
      return padTo(buildZip([{ name: 'tour.yaml', data: tourYaml() }]), 20 * MB + 1);
    }
  });

  it('T-PKG-17: 壊れた zip・zip でないファイルはエラーになり、保存されない', async () => {
    const { deps, db } = await setup();
    const good = buildZip([{ name: 'tour.yaml', data: tourYaml() }]);
    const results = await importFiles(
      [file('a.zip', utf8('plain text')), file('b.zip', good.slice(0, good.length - 10)), file('c.zip', new Uint8Array(0))],
      deps,
    );
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(await isEmpty(db)).toBe(true);
  });

  it('T-PKG-18: 展開の途中で打ち切られたとき、IndexedDB の files・tours・meta が変わらない', async () => {
    const { deps, db } = await setup();
    await importFiles([file('first.yaml', tourYaml({ id: 'first' }))], deps);
    const before = await snapshot(db);
    const zip = buildZip([
      { name: 'tour.yaml', data: tourYaml({ id: 'second' }) },
      { name: 'big.bin', data: new Uint8Array(60 * MB) },
    ]);
    const [result] = await importFiles([file('big.zip', zip)], deps);
    expect(result?.status).toBe('rejected');
    expect(await snapshot(db)).toEqual(before);
  }, 30_000);
});

describe('エントリ名の検査（取り込み）', () => {
  const withEntry = (name: string) =>
    buildZip([{ name: 'tour.yaml', data: tourYaml({ id: 'names' }) }, { name, data: 'x' }]);

  it('T-PKG-19〜25: 不正な名前を含む zip は拒否され、保存されない', async () => {
    const { deps, db } = await setup();
    const names = ['a\\b.md', 'a\u00a5b.md', 'a\0b.md', '/etc/x', 'C:/x', 'c:x', 'a//b', '../x', 'a/../b'];
    const results = await importFiles(names.map((n, i) => file(`p${String(i)}.zip`, withEntry(n))), deps);
    expect(results.map((r) => r.status)).toEqual(names.map(() => 'rejected'));
    expect(await isEmpty(db)).toBe(true);
  });

  it('T-PKG-20: ¥・₩・全角のスラッシュ・全角の円記号などを含む名前は拒否される', async () => {
    const { deps } = await setup();
    const names = ['a\u20a9b', 'a\uff0fb', 'a\uff3cb', 'a\u2215b', 'a\u2044b'];
    const results = await importFiles(names.map((n, i) => file(`p${String(i)}.zip`, withEntry(n))), deps);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
  });

  it('T-PKG-26・T-PKG-30・T-PKG-31: ..a・a..b・日本語・サブディレクトリ・ディレクトリのエントリは拒否されない', async () => {
    const { deps } = await setup();
    const zip = buildZip([
      { name: 'tour.yaml', data: tourYaml({ id: 'ok' }) },
      { name: '..a', data: 'x' },
      { name: 'a..b', data: 'x' },
      { name: 'images/' },
      { name: 'images/図1.png', data: png(3, 3) },
    ]);
    const [result] = await importFiles([file('ok.zip', zip)], deps);
    expect(result?.status).toBe('imported');
  });

  it('T-PKG-27: シンボリックリンクのエントリを含む zip は拒否される', async () => {
    const { deps } = await setup();
    const zip = buildZip([
      { name: 'tour.yaml', data: tourYaml() },
      { name: 'link.md', data: 'tour.yaml', symlink: true },
    ]);
    const [result] = await importFiles([file('link.zip', zip)], deps);
    expect(result?.status).toBe('rejected');
  });

  it('T-PKG-28・T-PKG-29: 大文字・小文字だけの違い、または完全に同じ名前のエントリを含む zip は拒否される', async () => {
    const { deps, db } = await setup();
    const base = { name: 'tour.yaml', data: tourYaml() };
    const results = await importFiles(
      [
        file('case.zip', buildZip([base, { name: 'a.png', data: png(1, 1) }, { name: 'A.PNG', data: png(1, 1) }])),
        file('same.zip', buildZip([base, { name: 'a.png', data: png(1, 1) }, { name: 'a.png', data: png(2, 2) }])),
      ],
      deps,
    );
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(await isEmpty(db)).toBe(true);
  });
});

describe('相対パスの解決（取り込み）', () => {
  it('T-PKG-32〜35: bodyFile・media・Markdown 内の画像が、参照元の場所を起点に解決される', async () => {
    const { deps, db } = await setup();
    const yaml = tourYaml({
      id: 'paths',
      steps: guideStep('a', { bodyFile: 'steps/a.md', media: 'images/top.png' }),
    });
    const zip = buildZip([
      { name: 'tour.yaml', data: yaml },
      { name: 'steps/a.md', data: '# 手順\n\n![図](../images/inner.gif)\n\n![同じ階層](near.png)' },
      { name: 'images/top.png', data: png(8, 8) },
      { name: 'images/inner.gif', data: gif(9, 9) },
      { name: 'steps/near.png', data: png(7, 7) },
    ]);
    const [result] = await importFiles([file('p.zip', zip)], deps);
    expect(result?.status).toBe('imported');
    expect((await snapshot(db)).files.map((f) => f.key.split('/').slice(2).join('/')).sort()).toEqual([
      'images/inner.gif',
      'images/top.png',
      'steps/a.md',
      'steps/near.png',
    ]);
  });

  it('T-PKG-36〜38: 外へ出る参照・存在しない参照・絶対パスは、参照元を示して拒否される', async () => {
    const { deps, db } = await setup();
    const yaml = tourYaml({
      steps:
        guideStep('a', { media: '../outside.png' }) +
        guideStep('b', { media: 'none.png' }) +
        guideStep('c', { media: '/images/a.png' }),
    });
    const [result] = await importFiles([file('p.zip', buildZip([{ name: 'tour.yaml', data: yaml }]))], deps);
    expect(result?.status).toBe('rejected');
    if (result?.status === 'rejected') {
      expect(result.errors.map((e) => e.path)).toEqual(['steps[0].media.src', 'steps[1].media.src', 'steps[2].media.src']);
    }
    expect(await isEmpty(db)).toBe(true);
  });

  it('T-PKG-39〜42: bodyFile の Markdown の上限・body との併用・拡張子の制限が取り込みでも効く', async () => {
    const { deps } = await setup();
    const limit = 200 * 1024;
    const md = (n: number) => padTo(utf8('# a\n'), n).fill(0x20, 4);
    const zip = (steps: string, files: { name: string; data: Uint8Array | string }[]) =>
      file('p.zip', buildZip([{ name: 'tour.yaml', data: tourYaml({ steps }) }, ...files]));
    const results = await importFiles(
      [
        zip(guideStep('a', { bodyFile: 'a.md' }), [{ name: 'a.md', data: md(limit) }]),
        zip(guideStep('a', { bodyFile: 'a.md' }), [{ name: 'a.md', data: md(limit + 1) }]),
        zip(guideStep('a', { bodyFile: 'a.md', body: 'x' }), [{ name: 'a.md', data: 'x' }]),
        zip(guideStep('a', { bodyFile: 'a.txt' }), [{ name: 'a.txt', data: 'x' }]),
      ],
      deps,
    );
    expect(results.map((r) => r.status)).toEqual(['imported', 'rejected', 'rejected', 'rejected']);
  });

  it('T-PKG-40: 参照されていないファイルは取り込みを妨げず、保存もされない', async () => {
    const { deps, db } = await setup();
    const zip = buildZip([
      { name: 'tour.yaml', data: tourYaml() },
      { name: 'unused.png', data: png(2, 2) },
      { name: 'memo.txt', data: 'memo' },
    ]);
    const [result] = await importFiles([file('p.zip', zip)], deps);
    expect(result?.status).toBe('imported');
    expect((await snapshot(db)).files).toEqual([]);
  });
});

describe('画像・data URL（取り込み）', () => {
  it('T-PKG-43〜55: 画像の検査が取り込みの結果に反映される', async () => {
    const { deps } = await setup();
    const make = (name: string, bytes: Uint8Array) =>
      file(
        `${name}.zip`,
        buildZip([
          { name: 'tour.yaml', data: tourYaml({ steps: guideStep('a', { media: name }) }) },
          { name, data: bytes },
        ]),
      );
    const results = await importFiles(
      [
        make('ok.png', png(10, 10)),
        make('mismatch.png', jpeg(10, 10)),
        make('anim.bmp', png(10, 10)),
        make('cut.png', png(10, 10).slice(0, 12)),
        make('huge.png', padTo(png(65535, 65535), 300)),
        make('wide.png', png(4097, 10)),
      ],
      deps,
    );
    expect(results.map((r) => r.status)).toEqual(['imported', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected']);
  });

  it('T-PKG-56・T-PKG-57・T-PKG-58・T-PKG-59・T-PKG-60: data URL の許可・不許可が取り込みに効く', async () => {
    const { deps } = await setup();
    const yamlWith = (id: string, src: string) => file(`${id}.yaml`, tourYaml({ id, steps: guideStep('a', { media: src }) }));
    const results = await importFiles(
      [
        yamlWith('ok', dataUrl('image/png', png(5, 5))),
        yamlWith('svg', 'data:image/svg+xml,%3Csvg%2F%3E'),
        yamlWith('html', 'data:text/html,hi'),
        yamlWith('liar', dataUrl('image/png', jpeg(5, 5))),
        yamlWith('huge', dataUrl('image/png', png(65535, 65535))),
        yamlWith('b64', 'data:image/png;base64,@@@'),
      ],
      deps,
    );
    expect(results.map((r) => r.status)).toEqual(['imported', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected']);
  });

  it('T-PKG-61・T-PKG-63: .svg の参照と、Markdown 内の SVG・外部 URL・パッケージ外はエラーになる', async () => {
    const { deps } = await setup();
    const results = await importFiles(
      [
        file(
          'svg.zip',
          buildZip([
            { name: 'tour.yaml', data: tourYaml({ steps: guideStep('a', { media: 'a.svg' }) }) },
            { name: 'a.svg', data: '<svg/>' },
          ]),
        ),
        file(
          'md.zip',
          buildZip([
            { name: 'tour.yaml', data: tourYaml({ steps: guideStep('a', { bodyFile: 'a.md' }) }) },
            { name: 'a.md', data: '![a](x.svg)\n\n![b](https://example.com/b.png)\n\n![c](../c.png)' },
          ]),
        ),
      ],
      deps,
    );
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    if (results[1]?.status === 'rejected') expect(results[1].errors).toHaveLength(3);
  });

  it('T-PKG-62: 外部 URL の画像はエラーになり、どこにも通信しない', async () => {
    const { deps } = await setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const make = (id: string, src: string) =>
      file(`${id}.yaml`, tourYaml({ id, steps: guideStep('a', { media: src }) }));
    const results = await importFiles(
      [
        make('a', 'http://example.com/a.png'),
        make('b', 'https://example.com/a.png'),
        make('c', '//example.com/a.png'),
      ],
      deps,
    );
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('T-PKG-64: 単体の .yaml が相対パスで bodyFile・media.src を参照するとエラーになる', async () => {
    const { deps, db } = await setup();
    const [result] = await importFiles(
      [file('t.yaml', tourYaml({ steps: guideStep('a', { bodyFile: 'a.md', media: 'a.png' }) }))],
      deps,
    );
    expect(result?.status).toBe('rejected');
    expect(await isEmpty(db)).toBe(true);
  });

  it('T-PKG-65: 単体の .yaml が許可した data URL の画像を使うと取り込める', async () => {
    const { deps } = await setup();
    const yaml = tourYaml({ steps: guideStep('a', { media: dataUrl('image/gif', gif(4, 4)) }) });
    const [result] = await importFiles([file('t.yaml', yaml)], deps);
    expect(result?.status).toBe('imported');
  });
});

describe('上書きの確認', () => {
  it('T-PKG-66: 同じ ID が取り込み済みのとき、保存の前に確認が呼ばれ、承認されれば新しい版が保存される', async () => {
    const { deps, db, confirm } = await setup();
    await importFiles([file('v1.yaml', tourYaml({ id: 'same', name: '旧' }))], deps);
    expect(confirm).not.toHaveBeenCalled();
    const [result] = await importFiles([file('v2.yaml', tourYaml({ id: 'same', name: '新' }))], deps);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith({ fileName: 'v2.yaml', tourName: '新', tourId: 'same', existingSource: 'imported', running: false });
    expect(result?.status).toBe('imported');
    const tours = (await snapshot(db)).tours;
    expect(tours).toHaveLength(1);
    expect(tours[0]?.fileName).toBe('v2.yaml');
  });

  it('T-PKG-67: 確認が承認されなければ何も保存されず、通知も送られず、結果は取り消しになる', async () => {
    const { deps, db, confirm, notify } = await setup();
    await importFiles([file('v1.yaml', tourYaml({ id: 'same' }))], deps);
    const before = await snapshot(db);
    notify.mockClear();
    confirm.mockResolvedValue(false);
    const [result] = await importFiles([file('v2.yaml', tourYaml({ id: 'same', name: '新' }))], deps);
    expect(result).toMatchObject({ status: 'cancelled', tourId: 'same', name: '新' });
    expect(await snapshot(db)).toEqual(before);
    expect(notify).not.toHaveBeenCalled();
  });

  it('T-PKG-68: 置き換え対象が同梱ツアーのとき、確認に同梱版の置き換えであることが渡される', async () => {
    const { deps, confirm } = await setup({ getBundledTourIds: () => Promise.resolve(['bundled-1']) });
    await importFiles([file('a.yaml', tourYaml({ id: 'bundled-1' }))], deps);
    expect(confirm).toHaveBeenCalledWith({ fileName: 'a.yaml', tourName: 'サンプル', tourId: 'bundled-1', existingSource: 'bundled', running: false });
  });

  it('T-PKG-69: 置き換え対象が実行中のツアーのとき、確認に実行中であることが渡される', async () => {
    const { deps, confirm } = await setup({
      getBundledTourIds: () => ['run'],
      getRunningTourId: () => Promise.resolve('run'),
    });
    await importFiles([file('a.yaml', tourYaml({ id: 'run' }))], deps);
    expect(confirm).toHaveBeenCalledWith({ fileName: 'a.yaml', tourName: 'サンプル', tourId: 'run', existingSource: 'bundled', running: true });
  });

  it('T-PKG-70: 同じ ID がなければ、確認は呼ばれない', async () => {
    const { deps, confirm } = await setup({ getBundledTourIds: () => ['other'] });
    await importFiles([file('a.yaml', tourYaml({ id: 'fresh' }))], deps);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('T-PKG-71: 検証でエラーになったツアーは、同じ ID があっても確認を出さずに失敗する', async () => {
    const { deps, confirm } = await setup({ getBundledTourIds: () => ['dup'] });
    await importFiles([file('a.yaml', tourYaml({ id: 'dup' }))], deps);
    confirm.mockClear();
    const bad = tourYaml({ id: 'dup', steps: '  - id: s1\n    title: x\n    kind: nope\n' });
    const [result] = await importFiles([file('b.yaml', bad)], deps);
    expect(result?.status).toBe('rejected');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('T-PKG-72: 1回の取り込みに同じ ID のファイルが複数あれば、後のものをエラーにする', async () => {
    const { deps, db, confirm } = await setup();
    const results = await importFiles(
      [file('a.yaml', tourYaml({ id: 'twin', name: '先' })), file('b.yaml', tourYaml({ id: 'twin', name: '後' }))],
      deps,
    );
    expect(results.map((r) => r.status)).toEqual(['imported', 'rejected']);
    expect(confirm).not.toHaveBeenCalled();
    expect((await snapshot(db)).tours.map((t) => t.fileName)).toEqual(['a.yaml']);
  });
});

describe('悪意ある資料と対象サイト', () => {
  const aliasBomb = `${tourYaml()}base: &a x\nlist: [${new Array<string>(150).fill('*a').join(', ')}]\n`;
  const dupKey = `${tourYaml()}name: 重複\n`;
  const zipWith = (...entries: { name: string; data?: Uint8Array | string }[]) =>
    buildZip([{ name: 'tour.yaml', data: tourYaml() }, ...entries]);

  it('T-PKG-94: 悪意ある資料の各ファイルはすべて拒否され、理由が結果に入り、IndexedDB に何も残らない', async () => {
    const { deps, db } = await setup();
    const files = [
      file('nonimage.yaml', tourYaml({ steps: guideStep('a', { media: 'data:text/html;base64,PGI+eDwvYj4=' }) })),
      file('bomb.zip', zipWith({ name: 'bomb.bin', data: new Uint8Array(120 * MB) })),
      file('dupname.zip', zipWith({ name: 'a.png', data: 'x' }, { name: 'A.png', data: 'y' })),
      file('alias.yaml', aliasBomb),
      file('dupkey.yaml', dupKey),
      file(
        'hugepix.zip',
        buildZip([
          { name: 'tour.yaml', data: tourYaml({ steps: guideStep('a', { media: 'h.png' }) }) },
          { name: 'h.png', data: padTo(png(60000, 60000), 200) },
        ]),
      ),
      file('many.zip', zipWith(...Array.from({ length: 600 }, (_, i) => ({ name: `f${String(i)}.txt`, data: 'x' })))),
    ];
    const results = await importFiles(files, deps);
    expect(results.map((r) => r.status)).toEqual(files.map(() => 'rejected'));
    expect(results.every((r) => r.status === 'rejected' && r.errors.length > 0 && r.errors.every((e) => e.message !== ''))).toBe(true);
    expect(await isEmpty(db)).toBe(true);
  }, 30_000);

  it('T-PKG-95: 正規表現の URL 条件と、上限を超える長さ・区間数の URL 条件は取り込まれず、理由が入る', async () => {
    const { deps, db } = await setup();
    const step = (path: string) =>
      `  - id: s1\n    title: t\n    url:\n      origin: https://example.com\n      path:\n        exact: ${JSON.stringify(path)}\n`;
    const results = await importFiles(
      [
        file('regex.yaml', tourYaml({ steps: step('/a/(b|c)+$') })),
        file('long.yaml', tourYaml({ steps: step(`/${'a'.repeat(201)}`) })),
        file('deep.yaml', tourYaml({ steps: step(`/${new Array<string>(33).fill('a').join('/')}`) })),
      ],
      deps,
    );
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(messages(results[0])).toContain('正規表現');
    expect(await isEmpty(db)).toBe(true);
  });

  it('T-PKG-96: origins の外の URL を持つツアーは取り込まれず、権限の要求も行われない', async () => {
    const { deps, db, notify } = await setup();
    expect('chrome' in globalThis).toBe(false);
    const yaml = tourYaml({
      extra: 'tabs:\n  main:\n    open: https://evil.example.org/start\n',
      steps: `  - id: s1\n    title: t\n    url:\n      origin: https://other.example.net\n`,
    });
    const [result] = await importFiles([file('out.yaml', yaml)], deps);
    expect(result?.status).toBe('rejected');
    expect(await isEmpty(db)).toBe(true);
    expect(notify).not.toHaveBeenCalled();
  });
});
