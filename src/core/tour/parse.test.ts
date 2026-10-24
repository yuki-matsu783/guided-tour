import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { CompiledTourSchema } from './schema.ts';
import { parseTour } from './parse.ts';
import type { Issue } from './parse.ts';

const ORIGIN = 'https://example.com';
const FILE = 'my-tour.yaml';

type Obj = Record<string, unknown>;

const pageStep = (over: Obj = {}): Obj => ({
  id: 's1',
  title: '手順',
  url: { origin: ORIGIN },
  ...over,
});
const guideStep = (id: string, over: Obj = {}): Obj => ({ id, title: id, kind: 'guide', ...over });

function tourObj(over: Obj = {}): Obj {
  return {
    schemaVersion: 3,
    id: 'tour-1',
    name: 'ツアー',
    origins: [ORIGIN],
    steps: [pageStep()],
    ...over,
  };
}

const run = (obj: Obj) => parseTour(stringify(obj), FILE);
const errorsOf = (r: ReturnType<typeof parseTour>): Issue[] => (r.ok ? [] : r.errors);
const pathsOf = (r: ReturnType<typeof parseTour>): string[] => errorsOf(r).map((e) => e.path);
const withStep = (step: Obj, over: Obj = {}) => run(tourObj({ steps: [step], ...over }));
const withTarget = (target: Obj) => withStep(pageStep({ target }));

describe('正しい例・型', () => {
  it('T-TOUR-01: 最小の正しいツアーが、エラーなし・警告なしで返る', () => {
    const r = run(tourObj());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.warnings).toEqual([]);
      expect(r.tour.id).toBe('tour-1');
    }
  });

  it('T-TOUR-02: 任意項目をすべて持つ正しいツアーが通る', () => {
    const r = run(
      tourObj({
        description: '説明',
        updatedAt: '2026-01-02',
        minExtensionVersion: '1.2.3',
        tabs: {
          main: { label: 'メイン', open: `${ORIGIN}/start`, url: { origin: ORIGIN, path: { prefix: '/app' } } },
          admin: { label: '管理', open: `${ORIGIN}/admin` },
        },
        steps: [
          pageStep({
            kind: 'page',
            tab: 'main',
            open: `${ORIGIN}/open`,
            body: '本文',
            tip: 'ヒント',
            media: { src: 'images/a.png', alt: '代替', caption: '図' },
            target: {
              tourId: 't',
              testId: 'x',
              role: 'button',
              name: ['保存'],
              label: ['名前'],
              text: ['保存'],
              textTag: ['button', 'a'],
              match: 'contains',
              css: ['#save'],
              within: { css: 'form' },
              require: { role: 'button', inputType: 'text', region: 'main', name: ['保存'] },
              highlight: { closest: 'li' },
              fallbackText: '保存ボタン',
            },
            done: {
              type: 'state',
              target: { css: ['#a'], name: ['A'] },
              state: 'filled',
              minLength: 3,
              allowHidden: true,
              hint: 'h',
              doneHint: 'd',
            },
          }),
          pageStep({
            id: 's2',
            tab: 'admin',
            bodyFile: 'steps/a.md',
            done: { type: 'page', url: { origin: ORIGIN, path: { exact: '/done' } } },
          }),
          pageStep({ id: 's3', done: { type: 'element', target: { testId: 'ok' }, hint: 'h' } }),
          guideStep('s4', { body: 'ガイド', tip: 'ヒント', media: { src: 'a.png', alt: 'a' } }),
        ],
      }),
    );
    expect(errorsOf(r)).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('T-TOUR-03: kind と tab を省略すると、kind は page、tab は main になる', () => {
    const r = run(tourObj());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tour.steps[0]?.kind).toBe('page');
      expect(r.tour.steps[0]?.tab).toBe('main');
    }
  });

  it('T-TOUR-04: schemaVersion が 2・4・省略のとき、schemaVersion のエラーになる', () => {
    for (const v of [2, 4, undefined]) {
      const r = run(tourObj({ schemaVersion: v }));
      expect(r.ok).toBe(false);
      expect(pathsOf(r)).toContain('schemaVersion');
    }
  });

  it('T-TOUR-05: id は英数字・.・_・- だけ成功し、空白・/・日本語・空文字は id のエラーになる', () => {
    expect(run(tourObj({ id: 'a.B_c-1' })).ok).toBe(true);
    for (const id of ['a b', 'a/b', '日本語', '']) {
      const r = run(tourObj({ id }));
      expect(r.ok).toBe(false);
      expect(pathsOf(r)).toEqual(['id']);
    }
  });

  it('T-TOUR-06: 型の誤りは、それぞれ該当項目の場所と理由を持つエラーになる', () => {
    const cases: [Obj, string][] = [
      [tourObj({ steps: 'x' }), 'steps'],
      [tourObj({ name: 5 }), 'name'],
      [tourObj({ steps: [{ id: 's', url: { origin: ORIGIN } }] }), 'steps[0].title'],
      [tourObj({ steps: [pageStep({ kind: 'other' })] }), 'steps[0].kind'],
    ];
    for (const [obj, path] of cases) {
      const r = run(obj);
      expect(r.ok).toBe(false);
      const e = errorsOf(r).find((x) => x.path === path);
      expect(e?.message.length).toBeGreaterThan(0);
    }
  });

  it('T-TOUR-07: done.type・done.state・target.match が範囲外の値のとき、該当項目のエラーになる', () => {
    const t = { css: ['#a'] };
    expect(pathsOf(withStep(pageStep({ done: { type: 'x', url: { origin: ORIGIN } } })))).toContain(
      'steps[0].done.type',
    );
    expect(pathsOf(withStep(pageStep({ done: { type: 'state', target: t, state: 'open' } })))).toContain(
      'steps[0].done.state',
    );
    expect(pathsOf(withTarget({ css: ['#a'], match: 'regex' }))).toContain('steps[0].target.match');
    for (const s of ['filled', 'checked', 'selected', 'expanded', 'pressed']) {
      expect(withStep(pageStep({ done: { type: 'state', target: t, state: s } })).ok).toBe(true);
    }
  });

  it('T-TOUR-08: 未知の項目は、ツアー・step・target・done のどこでもエラーになる', () => {
    const r = run({ ...tourObj(), extra: 1 });
    expect(pathsOf(r)).toEqual(['extra']);
    expect(pathsOf(withStep(pageStep({ extra: 1 })))).toEqual(['steps[0].extra']);
    expect(pathsOf(withTarget({ css: ['#a'], typo: 1 }))).toEqual(['steps[0].target.typo']);
    expect(
      pathsOf(withStep(pageStep({ done: { type: 'page', url: { origin: ORIGIN }, typo: 1 } }))),
    ).toEqual(['steps[0].done.typo']);
  });

  it('T-TOUR-09: done の type ごとに必要な項目があれば通り、欠ければ done の場所のエラーになる', () => {
    const t = { css: ['#a'] };
    expect(withStep(pageStep({ done: { type: 'page', url: { origin: ORIGIN } } })).ok).toBe(true);
    expect(withStep(pageStep({ done: { type: 'element', target: t } })).ok).toBe(true);
    expect(withStep(pageStep({ done: { type: 'state', target: t, state: 'checked' } })).ok).toBe(true);
    for (const done of [{ type: 'page' }, { type: 'element' }, { type: 'state', state: 'filled' }, { type: 'state', target: t }]) {
      const r = withStep(pageStep({ done }));
      expect(r.ok).toBe(false);
      expect(errorsOf(r).every((e) => e.path.startsWith('steps[0].done'))).toBe(true);
    }
  });

  it('T-TOUR-10: done.type: page に target・state、element・state に url を書くとエラーになる', () => {
    const t = { css: ['#a'] };
    const u = { origin: ORIGIN };
    expect(pathsOf(withStep(pageStep({ done: { type: 'page', url: u, target: t } })))).toContain('steps[0].done.target');
    expect(pathsOf(withStep(pageStep({ done: { type: 'page', url: u, state: 'filled' } })))).toContain('steps[0].done.state');
    expect(pathsOf(withStep(pageStep({ done: { type: 'element', target: t, url: u } })))).toContain('steps[0].done.url');
    expect(pathsOf(withStep(pageStep({ done: { type: 'element', target: t, state: 'filled' } })))).toContain('steps[0].done.state');
    expect(pathsOf(withStep(pageStep({ done: { type: 'state', target: t, state: 'filled', url: u } })))).toContain('steps[0].done.url');
  });

  it('T-TOUR-11: within の3つの形、require・highlight・fallbackText を持つ target が通る', () => {
    expect(withTarget({ css: ['#a'], within: { role: 'dialog', name: ['設定'] } }).ok).toBe(true);
    expect(withTarget({ css: ['#a'], within: { label: ['設定'] } }).ok).toBe(true);
    expect(withTarget({ css: ['#a'], within: { css: 'form' } }).ok).toBe(true);
    expect(
      withTarget({
        css: ['#a'],
        require: { role: 'button', inputType: 'text', region: 'form', name: ['x'] },
        highlight: { closest: 'li' },
        fallbackText: 'x',
      }).ok,
    ).toBe(true);
    const bad = withTarget({ css: ['#a'], within: { role: 'dialog' } });
    expect(bad.ok).toBe(false);
    expect(pathsOf(bad)).toContain('steps[0].target.within');
    expect(pathsOf(withTarget({ css: ['#a'], require: { region: 'footer' } }))).toContain('steps[0].target.require.region');
  });

  it('T-TOUR-11: 手がかりのない target は、手がかりが必要というエラーになる', () => {
    const r = withTarget({ name: ['保存'], fallbackText: 'x' });
    expect(pathsOf(r)).toEqual(['steps[0].target']);
  });
});

describe('origins', () => {
  it('T-TOUR-12: origins が空または省略のとき、origins のエラーになる', () => {
    expect(pathsOf(run(tourObj({ origins: [] })))).toContain('origins');
    expect(pathsOf(run(tourObj({ origins: undefined })))).toContain('origins');
  });

  it('T-TOUR-13: ワイルドカードのホストはエラーになる', () => {
    for (const o of ['*.example.com', 'https://*', 'https://*.example.com']) {
      const r = run(tourObj({ origins: [o], steps: [guideStep('g')] }));
      expect(pathsOf(r)).toEqual(['origins[0]']);
      expect(errorsOf(r)[0]?.message).toContain('ワイルドカード');
    }
  });

  it('T-TOUR-14: http/https 以外のスキームはエラーになる', () => {
    for (const o of ['ftp://example.com', 'chrome://settings', 'file:///tmp']) {
      expect(pathsOf(run(tourObj({ origins: [o], steps: [guideStep('g')] })))).toEqual(['origins[0]']);
    }
  });

  it('T-TOUR-15: ポート付きのオリジンは通る', () => {
    const o = 'http://localhost:8080';
    expect(run(tourObj({ origins: [o], steps: [pageStep({ url: { origin: o } })] })).ok).toBe(true);
  });

  it('T-TOUR-16: tabs.<役割>.open が origins の外ならその項目のエラー、中なら通る', () => {
    const r = run(tourObj({ tabs: { main: { open: 'https://evil.example.org/x' } } }));
    expect(pathsOf(r)).toEqual(['tabs.main.open']);
    expect(run(tourObj({ tabs: { main: { open: `${ORIGIN}/x` } } })).ok).toBe(true);
  });

  it('T-TOUR-17: steps[].open が origins の外ならその項目のエラーになる', () => {
    const r = withStep(pageStep({ open: 'https://evil.example.org/x' }));
    expect(pathsOf(r)).toEqual(['steps[0].open']);
    expect(withStep(pageStep({ open: `${ORIGIN}/x` })).ok).toBe(true);
  });

  it('T-TOUR-18: step の url.origin が origins と完全一致でないときエラーになる', () => {
    for (const o of ['https://other.example.org', 'http://example.com', 'https://example.com:8443', 'https://example.com/path', 'https://example.com/']) {
      const r = withStep(pageStep({ url: { origin: o } }));
      expect(pathsOf(r)).toEqual(['steps[0].url.origin']);
    }
  });

  it('T-TOUR-19: done.url.origin が origins の外のときエラーになる', () => {
    const r = withStep(pageStep({ done: { type: 'page', url: { origin: 'https://other.example.org' } } }));
    expect(pathsOf(r)).toEqual(['steps[0].done.url.origin']);
  });
});

describe('step の種類ごとの規則', () => {
  it('T-TOUR-20: page の step が url を持てば（tabs の url なしで）通る', () => {
    expect(withStep(pageStep()).ok).toBe(true);
  });

  it('T-TOUR-21: url がなくても、その役割（tab 省略時は main）の tabs.<役割>.url があれば通る', () => {
    const tabs = { main: { url: { origin: ORIGIN } } };
    expect(withStep({ id: 's', title: 't' }, { tabs }).ok).toBe(true);
    const sub = { main: {}, sub: { url: { origin: ORIGIN } } };
    expect(withStep({ id: 's', title: 't', tab: 'sub' }, { tabs: sub }).ok).toBe(true);
  });

  it('T-TOUR-22: url も tabs.<役割>.url もない page の step は、その step の場所のエラーになる', () => {
    const r = withStep({ id: 's', title: 't', kind: 'page' });
    expect(pathsOf(r)).toEqual(['steps[0]']);
  });

  it('T-TOUR-23: kind 省略（既定の page）で URL 条件がないときも同じエラーになる', () => {
    const r = withStep({ id: 's', title: 't' });
    expect(pathsOf(r)).toEqual(['steps[0]']);
  });

  it('T-TOUR-24: 別の役割にだけ url がなく main にだけ url があるとき、main で代用せずエラーになる', () => {
    const tabs = { main: { url: { origin: ORIGIN } }, sub: { open: `${ORIGIN}/x` } };
    const r = withStep({ id: 's', title: 't', tab: 'sub' }, { tabs });
    expect(pathsOf(r)).toEqual(['steps[0]']);
  });

  it('T-TOUR-24: tabs に定義のない役割を page の step が使うとエラーになる', () => {
    const r = withStep(pageStep({ tab: 'ghost' }));
    expect(pathsOf(r)).toEqual(['steps[0].tab']);
    expect(withStep(pageStep({ tab: 'ghost' }), { tabs: { ghost: {} } }).ok).toBe(true);
  });

  it('T-TOUR-25: guide が target を持つとエラーになる', () => {
    const r = withStep(guideStep('g', { target: { css: ['#a'] } }));
    expect(pathsOf(r)).toEqual(['steps[0].target']);
  });

  it('T-TOUR-26: guide が url を持つとエラーになる', () => {
    const r = withStep(guideStep('g', { url: { origin: ORIGIN } }));
    expect(pathsOf(r)).toEqual(['steps[0].url']);
  });

  it('T-TOUR-27: guide が done を持つとエラーになる', () => {
    const r = withStep(guideStep('g', { done: { type: 'page', url: { origin: ORIGIN } } }));
    expect(pathsOf(r)).toEqual(['steps[0].done']);
  });

  it('T-TOUR-28: guide は title・body だけで通り、tip・media も持てる。tab・open は持てない', () => {
    expect(withStep(guideStep('g', { body: '本文' })).ok).toBe(true);
    expect(withStep(guideStep('g', { tip: 't', media: { src: 'a.png', alt: 'a' }, bodyFile: 'a.md' })).ok).toBe(true);
    expect(pathsOf(withStep(guideStep('g', { tab: 'main' })))).toEqual(['steps[0].tab']);
    expect(pathsOf(withStep(guideStep('g', { open: `${ORIGIN}/x` })))).toEqual(['steps[0].open']);
  });

  it('T-TOUR-29: 同じ id の step が2つあるとエラーになる', () => {
    const r = run(tourObj({ steps: [guideStep('same'), guideStep('same')] }));
    expect(pathsOf(r)).toEqual(['steps[1].id']);
  });

  it('T-TOUR-29: body と bodyFile の両方、.md 以外の bodyFile はエラーになる', () => {
    expect(pathsOf(withStep(guideStep('g', { body: 'a', bodyFile: 'a.md' })))).toEqual(['steps[0].bodyFile']);
    expect(pathsOf(withStep(guideStep('g', { bodyFile: 'a.txt' })))).toEqual(['steps[0].bodyFile']);
  });
});

describe('URL 条件の検証', () => {
  const withPath = (path: Obj) => withStep(pageStep({ url: { origin: ORIGIN, path } }));

  it('T-TOUR-30: パスに ( [ \\ $ を含むとき、それぞれ正規表現を使えないことを示すエラーになる', () => {
    for (const ch of ['(', '[', '\\', '$']) {
      const r = withPath({ exact: `/a${ch}b` });
      expect(pathsOf(r)).toEqual(['steps[0].url.path.exact']);
      expect(errorsOf(r)[0]?.message).toContain('正規表現');
    }
  });

  it('T-TOUR-31: ^ + ? { | ) ] } など他の正規表現らしい記号もエラーになる', () => {
    for (const ch of ['^', '+', '?', '{', '|', ')', ']', '}']) {
      expect(withPath({ prefix: `/a${ch}` }).ok).toBe(false);
    }
    // 区間の途中の * もエラー
    expect(pathsOf(withPath({ glob: '/a/b*' }))).toEqual(['steps[0].url.path.glob']);
    expect(withPath({ glob: '/a/*/**' }).ok).toBe(true);
  });

  it('T-TOUR-32: path に exact・prefix・glob を2つ以上、または0個書くとエラーになる', () => {
    expect(pathsOf(withPath({ exact: '/a', prefix: '/a' }))).toContain('steps[0].url.path');
    expect(pathsOf(withPath({ exact: '/a', prefix: '/a', glob: '/a' }))).toContain('steps[0].url.path');
    expect(pathsOf(withPath({}))).toContain('steps[0].url.path');
    for (const k of ['exact', 'prefix', 'glob']) expect(withPath({ [k]: '/a' }).ok).toBe(true);
  });

  it('T-TOUR-33: path を省略した URL 条件は通る', () => {
    expect(withStep(pageStep({ url: { origin: ORIGIN } })).ok).toBe(true);
  });

  it('T-TOUR-34: パスが200文字ちょうどなら通り、201文字ならエラーになる', () => {
    expect(withPath({ exact: `/${'a'.repeat(199)}` }).ok).toBe(true);
    expect(pathsOf(withPath({ exact: `/${'a'.repeat(200)}` }))).toEqual(['steps[0].url.path.exact']);
  });

  it('T-TOUR-35: パスが32区間ちょうどなら通り、33区間ならエラーになる', () => {
    expect(withPath({ exact: '/a'.repeat(32) }).ok).toBe(true);
    expect(pathsOf(withPath({ exact: '/a'.repeat(33) }))).toEqual(['steps[0].url.path.exact']);
  });

  it('T-TOUR-36: glob の ** が4個なら通り、5個ならエラーになる', () => {
    expect(withPath({ glob: '/**/a/**/b/**/c/**' }).ok).toBe(true);
    expect(pathsOf(withPath({ glob: '/**/a/**/b/**/c/**/d/**' }))).toEqual(['steps[0].url.path.glob']);
  });

  it('T-TOUR-37: 上限の検査は step の url・done.url・tabs の url のすべてに効く', () => {
    const bad = { origin: ORIGIN, path: { exact: `/${'a'.repeat(200)}` } };
    expect(pathsOf(withStep(pageStep({ done: { type: 'page', url: bad } })))).toEqual(['steps[0].done.url.path.exact']);
    expect(pathsOf(withStep(pageStep({ url: bad })))).toEqual(['steps[0].url.path.exact']);
    expect(pathsOf(run(tourObj({ tabs: { main: { url: bad } } })))).toEqual(['tabs.main.url.path.exact']);
  });
});

describe('警告（必須の照合がない）', () => {
  const warnOf = (target: Obj) => {
    const r = withTarget(target);
    expect(r.ok).toBe(true);
    return r.ok ? r.warnings : [];
  };

  it('T-TOUR-38: require も名前の候補もなく testId だけの target は、警告が1件付く', () => {
    expect(warnOf({ testId: 'save' })).toHaveLength(1);
  });

  it('T-TOUR-39: css だけの target は警告が付く', () => {
    expect(warnOf({ css: ['#save'] })).toHaveLength(1);
  });

  it('T-TOUR-40: testId と css だけ（段階1と5）でも警告が付く', () => {
    expect(warnOf({ testId: 'save', css: ['#save'] })).toHaveLength(1);
  });

  it('T-TOUR-41: 段階1か5だけでも require があれば警告は付かない', () => {
    expect(warnOf({ testId: 'save', require: { role: 'button' } })).toEqual([]);
    expect(warnOf({ css: ['#a'], require: { region: 'main' } })).toEqual([]);
  });

  it('T-TOUR-42: 段階2〜4（role・label・text）を含む target は警告が付かない', () => {
    expect(warnOf({ role: 'button', name: ['保存'] })).toEqual([]);
    expect(warnOf({ label: ['名前'] })).toEqual([]);
    expect(warnOf({ text: ['保存'] })).toEqual([]);
    expect(warnOf({ css: ['#a'], role: 'button', name: ['保存'] })).toEqual([]);
  });

  it('T-TOUR-43: 段階1か5だけでも名前の候補（name・label・text）があれば警告は付かない', () => {
    expect(warnOf({ testId: 'save', name: ['保存'] })).toEqual([]);
    expect(warnOf({ css: ['#a'], name: ['保存'] })).toEqual([]);
    expect(warnOf({ css: ['#a'], label: ['保存'] })).toEqual([]);
    expect(warnOf({ css: ['#a'], text: ['保存'] })).toEqual([]);
  });

  it('T-TOUR-44: 警告があってもツアーは返り、警告に step の場所・行番号・メッセージが入る', () => {
    const r = parseTour(
      [
        'schemaVersion: 3',
        'id: t',
        'name: n',
        'origins: [https://example.com]',
        'steps:',
        '  - id: a',
        '    title: A',
        '    url: {origin: "https://example.com"}',
        '    target:',
        '      testId: save',
      ].join('\n'),
      FILE,
    );
    expect(r.ok).toBe(true);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatchObject({ file: FILE, path: 'steps[0].target', line: 9 });
    expect(r.warnings[0]?.message.length).toBeGreaterThan(0);
  });
});

describe('YAML の解析と制限', () => {
  const head = ['schemaVersion: 3', 'id: t', 'name: n', 'origins: [https://example.com]'];
  const guideSteps = ['steps:', '  - {id: a, title: A, kind: guide}'];
  const valid = [...head, ...guideSteps].join('\n');

  it('T-TOUR-45: 構文の誤り（インデント・閉じていない引用符）はエラーに行番号が入る', () => {
    const quote = parseTour([...head.slice(0, 2), 'name: "abc', ...head.slice(3), ...guideSteps].join('\n'), FILE);
    expect(quote.ok).toBe(false);
    expect(errorsOf(quote).every((e) => typeof e.line === 'number')).toBe(true);
    const indent = parseTour(['a:', '  b: 1', ' c: 2'].join('\n'), FILE);
    expect(indent.ok).toBe(false);
    expect(errorsOf(indent)[0]?.line).toBe(3);
  });

  it('T-TOUR-46: 独自タグはエラーになる', () => {
    for (const tag of ['!custom', '!!python/object']) {
      const r = parseTour(valid.replace('name: n', `name: ${tag} n`), FILE);
      expect(r.ok).toBe(false);
      expect(errorsOf(r)[0]?.message).toContain('タグ');
      expect(errorsOf(r)[0]?.line).toBe(3);
    }
  });

  it('T-TOUR-47: マージキーはマージされず、エラーになる', () => {
    const r = parseTour(`base: &b {a: 1}\n<<: *b\n${valid}`, FILE);
    expect(r.ok).toBe(false);
    const e = errorsOf(r).find((x) => x.message.includes('マージキー'));
    expect(e?.line).toBe(2);
  });

  it('T-TOUR-48: 重複キーはエラーになり、重複したキーの行番号が入る', () => {
    const r = parseTour(['schemaVersion: 3', 'id: t', 'name: a', 'name: b'].join('\n'), FILE);
    expect(r.ok).toBe(false);
    expect(errorsOf(r)).toHaveLength(1);
    expect(errorsOf(r)[0]?.line).toBe(4);
  });

  it('T-TOUR-49: エイリアスの展開が100回ちょうどなら通り、101回ならエラーになる', () => {
    const build = (aliases: number): string => {
      const steps = [`  - {id: s0, title: &t タイトル, kind: guide}`];
      for (let i = 1; i <= aliases; i++) steps.push(`  - {id: s${String(i)}, title: *t, kind: guide}`);
      return [...head, 'steps:', ...steps].join('\n');
    };
    expect(parseTour(build(100), FILE).ok).toBe(true);
    const over = parseTour(build(101), FILE);
    expect(over.ok).toBe(false);
    expect(errorsOf(over)[0]?.message).toContain('エイリアス');
    expect(errorsOf(over)[0]?.line).not.toBeNull();
  });

  it('T-TOUR-50: 入れ子の深さが32ちょうどなら深さのエラーにならず、33ならエラーになる', () => {
    const nest = (inner: number): string => `x: ${'{a: '.repeat(inner)}1${'}'.repeat(inner)}`;
    // 最上位の対応表が深さ1、値の flow 対応表が inner 個
    const ok = parseTour(nest(31), FILE);
    expect(errorsOf(ok).some((e) => e.message.includes('入れ子'))).toBe(false);
    const over = parseTour(nest(32), FILE);
    expect(over.ok).toBe(false);
    expect(errorsOf(over)).toHaveLength(1);
    expect(errorsOf(over)[0]?.message).toContain('入れ子');
  });

  it('T-TOUR-51: yaml が警告を返す入力は、警告もエラーとして扱う', () => {
    const r = parseTour(valid.replace('id: t', 'id: !unknown t'), FILE);
    expect(r.ok).toBe(false);
    expect(errorsOf(r)).toHaveLength(1);
  });

  it('T-TOUR-52: YAML 1.2 の規則で yes・on が文字列、0o17 が数値、1_000 が文字列になる', () => {
    const ok = parseTour(valid.replace('name: n', 'name: yes\ndescription: on'), FILE);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.tour.name).toBe('yes');
      expect(ok.tour.description).toBe('on');
    }
    const no = parseTour(valid.replace('name: n', 'name: no\ndescription: off'), FILE);
    expect(no.ok).toBe(true);
    const underscore = parseTour(valid.replace('name: n', 'name: 1_000'), FILE);
    expect(underscore.ok && underscore.tour.name).toBe('1_000');
    // 0o17 は数値なので、文字列の項目に書くと型のエラーになる
    const octal = parseTour(valid.replace('name: n', 'name: 0o17'), FILE);
    expect(octal.ok).toBe(false);
    expect(pathsOf(octal)).toEqual(['name']);
  });

  it('T-TOUR-53: 空・コメントだけ・複数ドキュメント・最上位が配列は、それぞれエラーになる', () => {
    for (const text of ['', '# コメントだけ\n', `${valid}\n---\n${valid}`, '- a\n- b', 'text']) {
      const r = parseTour(text, FILE);
      expect(r.ok).toBe(false);
      expect(errorsOf(r).length).toBeGreaterThan(0);
      expect(r.warnings).toEqual([]);
    }
  });

  it('T-TOUR-54: steps が200件ちょうどなら通り、201件ならエラーになる', () => {
    const many = (n: number): Obj => tourObj({ steps: Array.from({ length: n }, (_, i) => guideStep(`s${String(i)}`)) });
    expect(run(many(200)).ok).toBe(true);
    expect(pathsOf(run(many(201)))).toEqual(['steps']);
  });

  it('T-TOUR-55: 手がかりの候補が20件ちょうどなら通り、21件ならエラーになる', () => {
    const list = (n: number): string[] => Array.from({ length: n }, (_, i) => `c${String(i)}`);
    for (const key of ['name', 'label', 'text', 'css']) {
      const base: Obj = key === 'name' ? { role: 'button' } : {};
      expect(withTarget({ ...base, [key]: list(20) }).ok).toBe(true);
      expect(pathsOf(withTarget({ ...base, [key]: list(21) }))).toEqual([`steps[0].target.${key}`]);
    }
    expect(pathsOf(run(tourObj({ origins: Array.from({ length: 21 }, (_, i) => `https://h${String(i)}.example.com`) })))).toEqual(['origins']);
  });
});

describe('行番号の対応付け・エラーの件数', () => {
  const lines = [
    'schemaVersion: 3', // 1
    'id: t', // 2
    'name: n', // 3
    'origins:', // 4
    '  - https://example.com', // 5
    'steps:', // 6
    '  - id: a', // 7
    '    title: A', // 8
    '    kind: guide', // 9
    '  - id: b', // 10
    '    title: B', // 11
    '    kind: guide', // 12
    '  - id: c', // 13
    '    title: C', // 14
    '    url:', // 15
    '      origin: https://example.com', // 16
    '    target:', // 17
    '      role: button', // 18
    '      name:', // 19
    '        - ok', // 20
    '        - 123', // 21
  ];

  it('T-TOUR-56: 深い場所の型の誤りは、その値のある行と場所を指す', () => {
    const r = parseTour(lines.join('\n'), FILE);
    expect(r.ok).toBe(false);
    expect(errorsOf(r)).toHaveLength(1);
    expect(errorsOf(r)[0]).toMatchObject({ path: 'steps[2].target.name[1]', line: 21 });
  });

  it('T-TOUR-57: 項目の欠落は、それを含む親の対応表の行を指す', () => {
    const text = lines.filter((l) => l !== '    title: B').join('\n');
    const r = parseTour(text, FILE);
    expect(errorsOf(r)[0]).toMatchObject({ path: 'steps[1].title', line: 10 });
    const noOrigins = parseTour(['schemaVersion: 3', 'id: t', 'name: n', 'steps:', '  - {id: a, title: A, kind: guide}'].join('\n'), FILE);
    expect(errorsOf(noOrigins)[0]).toMatchObject({ path: 'origins', line: 1 });
  });

  it('T-TOUR-58: 規則違反（origins 外・URL 条件の欠落・guide の禁止項目）にも line と path が入る', () => {
    const rules = [
      'schemaVersion: 3',
      'id: t',
      'name: n',
      'origins: [https://example.com]',
      'steps:',
      '  - id: a',
      '    title: A',
      '    url:',
      '      origin: https://evil.example.org',
      '  - id: b',
      '    title: B',
    ].join('\n');
    expect(errorsOf(parseTour(rules, FILE)).map((e) => [e.path, e.line])).toEqual([
      ['steps[0].url.origin', 9],
      ['steps[1]', 10],
    ]);
    const guide = [
      'schemaVersion: 3',
      'id: t',
      'name: n',
      'origins: [https://example.com]',
      'steps:',
      '  - id: c',
      '    title: C',
      '    kind: guide',
      '    target:',
      '      css: ["#a"]',
    ].join('\n');
    expect(errorsOf(parseTour(guide, FILE)).map((e) => [e.path, e.line])).toEqual([['steps[0].target', 9]]);
  });

  it('T-TOUR-59: 複数行の文字列・コメント・日本語があっても行番号がずれない', () => {
    const text = [
      '# 日本語のコメント', // 1
      'schemaVersion: 3', // 2
      'id: t', // 3
      'name: 日本語のツアー', // 4
      'description: |', // 5
      '  1行目', // 6
      '  2行目', // 7
      '', // 8
      '  4行目', // 9
      'origins: [https://example.com]', // 10
      'steps:', // 11
      '  # コメント', // 12
      '  - id: a', // 13
      '    title: >-', // 14
      '      折りたたみ', // 15
      '      文字列', // 16
      '    kind: guide', // 17
      '    tip: 5', // 18
    ].join('\n');
    const r = parseTour(text, FILE);
    expect(errorsOf(r)).toHaveLength(1);
    expect(errorsOf(r)[0]).toMatchObject({ path: 'steps[0].tip', line: 18 });
  });

  it('T-TOUR-60: すべてのエラーの file に、渡した fileName が入る', () => {
    const syntax = parseTour('a: [', 'x/y.yaml');
    const schema = parseTour('schemaVersion: 2', 'x/y.yaml');
    const rules = run(tourObj({ steps: [{ id: 's', title: 't' }] }));
    for (const e of [...errorsOf(syntax), ...errorsOf(schema)]) expect(e.file).toBe('x/y.yaml');
    for (const e of errorsOf(rules)) expect(e.file).toBe(FILE);
    expect(errorsOf(schema).length).toBeGreaterThan(0);
  });

  it('T-TOUR-61: エラーがちょうど20件なら20件すべて、21件以上なら20件だけが返る', () => {
    const noTitle = (n: number): Obj =>
      tourObj({ steps: Array.from({ length: n }, (_, i) => ({ id: `s${String(i)}`, kind: 'guide' })) });
    expect(errorsOf(run(noTitle(20)))).toHaveLength(20);
    expect(errorsOf(run(noTitle(21)))).toHaveLength(20);
    expect(errorsOf(run(noTitle(60)))).toHaveLength(20);
  });

  it('T-TOUR-62: 警告も最大20件で、エラーと警告は別の一覧で返る', () => {
    const weak = (n: number, extra: Obj[] = []): Obj =>
      tourObj({
        steps: [
          ...Array.from({ length: n }, (_, i) => pageStep({ id: `s${String(i)}`, target: { css: ['#a'] } })),
          ...extra,
        ],
      });
    const ok = run(weak(25));
    expect(ok.ok).toBe(true);
    expect(ok.warnings).toHaveLength(20);
    const failed = run(weak(3, [{ id: 'bad', title: 't' }]));
    expect(failed.ok).toBe(false);
    expect(errorsOf(failed)).toHaveLength(1);
    expect(failed.warnings).toHaveLength(3);
  });

  it('T-TOUR-63: 構文エラーのときは形式の検証に進まず、構文エラーだけが返る', () => {
    const r = parseTour('schemaVersion: 2\nname: "abc', FILE);
    expect(r.ok).toBe(false);
    expect(errorsOf(r).length).toBeGreaterThan(0);
    expect(errorsOf(r).every((e) => e.path === '')).toBe(true);
  });
});

describe('解析済みツアーの再検証', () => {
  it('CompiledTourSchema は parseTour の結果を通し、既定値が欠けたものや未知の項目を拒否する', () => {
    const r = run(tourObj({ steps: [pageStep(), guideStep('g')] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(CompiledTourSchema.safeParse(r.tour).success).toBe(true);
    const noKind = { ...r.tour, steps: [{ id: 'a', title: 'A', url: { origin: ORIGIN } }] };
    expect(CompiledTourSchema.safeParse(noKind).success).toBe(false);
    expect(CompiledTourSchema.safeParse({ ...r.tour, extra: 1 }).success).toBe(false);
  });
});

/** YAML の文字列から読む。ツアーの本体は最小で、`extra` を最上位に足す。 */
const HEADER = ['schemaVersion: 3', 'id: t', 'name: n', 'origins: [https://example.com]'];
const STEPS = ['steps:', '  - id: a', '    title: A', '    url: {origin: "https://example.com"}'];
const yamlRun = (...lines: string[]) => parseTour(lines.join('\n'), FILE);
const messagesOf = (r: ReturnType<typeof parseTour>): string[] => errorsOf(r).map((e) => e.message);

describe('第1段のレビュー指摘の修正（ツアー形式）', () => {
  it('R-TOUR-1: キーは文字列として比べ、1 と "1" は重複になる', () => {
    const r = yamlRun(...HEADER, 'tabs:', '  "1": {}', '  1: {}', ...STEPS);
    expect(r.ok).toBe(false);
    expect(messagesOf(r).some((m) => m.includes('重複'))).toBe(true);
  });

  it('R-TOUR-1: 文字列でないキー（数値・真偽値・null・対応表）はエラーになる', () => {
    for (const key of ['1: {}', 'true: {}', '~: {}', '? {a: 1}\n  : {}']) {
      const r = yamlRun(...HEADER, 'tabs:', `  ${key}`, ...STEPS);
      expect(r.ok, key).toBe(false);
      expect(messagesOf(r).some((m) => m.includes('文字列')), key).toBe(true);
    }
  });

  it('R-TOUR-2: エイリアスの展開後に深さが32を超えるとき、深さのエラーになる', () => {
    const deep = `${'{a: '.repeat(24)}1${'}'.repeat(24)}`;
    const r = yamlRun(...HEADER, `x: &d ${deep}`, `y: ${'['.repeat(10)}*d${']'.repeat(10)}`, ...STEPS);
    expect(r.ok).toBe(false);
    expect(messagesOf(r)).toEqual([expect.stringContaining('入れ子が深すぎ')]);
  });

  it('R-TOUR-2: 展開後も32以内なら深さのエラーにならない', () => {
    const deep = `${'{a: '.repeat(10)}1${'}'.repeat(10)}`;
    const r = yamlRun(...HEADER, `x: &d ${deep}`, `y: [*d]`, ...STEPS);
    expect(messagesOf(r).some((m) => m.includes('入れ子が深すぎ'))).toBe(false);
  });

  it('R-TOUR-3: 未知の項目のエラーでは、キーの制御文字を除き40文字で切って示す', () => {
    const key = 'ab\u0007c'.repeat(30);
    const shown = 'abc'.repeat(14).slice(0, 40);
    const r = withTarget({ testId: 'x', [key]: 1 });
    const [e] = errorsOf(r);
    expect(errorsOf(r)).toHaveLength(1);
    expect(e?.path).toBe(`steps[0].target.${shown}`);
    expect(e?.message).toContain(shown);
    expect(e?.message).not.toContain(key);
    expect(/\p{Cc}/u.test(`${e?.path ?? ''}${e?.message ?? ''}`)).toBe(false);
    expect(e?.line).not.toBeNull();
  });

  it('R-TOUR-4: tabs.<役割>.url の origin が origins の外ならエラーになる', () => {
    const r = run(tourObj({ tabs: { admin: { url: { origin: 'https://other.example.com' } } } }));
    expect(pathsOf(r)).toEqual(['tabs.admin.url.origin']);
  });

  it('R-TOUR-4: tabs は20件ちょうどなら通り、21件ならエラーになる', () => {
    const tabs = (n: number): Obj => Object.fromEntries(Array.from({ length: n }, (_, i) => [`r${String(i)}`, {}]));
    expect(run(tourObj({ tabs: tabs(20) })).ok).toBe(true);
    expect(pathsOf(run(tourObj({ tabs: tabs(21) })))).toEqual(['tabs']);
  });

  it('R-TOUR-4: textTag・within.name・require.name の候補は20件ちょうどなら通り、21件ならエラーになる', () => {
    const list = (n: number): string[] => Array.from({ length: n }, (_, i) => `c${String(i)}`);
    const cases: [string, (n: number) => Obj][] = [
      ['textTag', (n) => ({ text: ['x'], textTag: list(n) })],
      ['within.name', (n) => ({ text: ['x'], within: { role: 'main', name: list(n) } })],
      ['require.name', (n) => ({ testId: 't', require: { name: list(n) } })],
    ];
    for (const [key, make] of cases) {
      expect(withTarget(make(20)).ok, key).toBe(true);
      // within の形の誤りは within の場所で報告される
      const place = key === 'within.name' ? 'within' : key;
      expect(pathsOf(withTarget(make(21))), key).toEqual([`steps[0].target.${place}`]);
    }
  });

  it('R-TOUR-4: パスが / で始まらないとき、exact・prefix・glob のどれでもエラーになる', () => {
    for (const key of ['exact', 'prefix', 'glob']) {
      const r = withStep(pageStep({ url: { origin: ORIGIN, path: { [key]: 'a/b' } } }));
      expect(pathsOf(r), key).toEqual([`steps[0].url.path.${key}`]);
    }
  });

  it('R-TOUR-4: exact・prefix に * を書くとエラーになり、glob では書ける', () => {
    for (const key of ['exact', 'prefix']) {
      const r = withStep(pageStep({ url: { origin: ORIGIN, path: { [key]: '/a/*' } } }));
      expect(pathsOf(r), key).toEqual([`steps[0].url.path.${key}`]);
    }
    expect(withStep(pageStep({ url: { origin: ORIGIN, path: { glob: '/a/*' } } })).ok).toBe(true);
  });

  it('R-TOUR-4: 解析できない open はエラーになる（steps・tabs のどちらでも）', () => {
    expect(pathsOf(withStep(pageStep({ open: 'これは URL ではない' })))).toEqual(['steps[0].open']);
    expect(pathsOf(run(tourObj({ tabs: { main: { open: '::' } } })))).toEqual(['tabs.main.open']);
  });

  it('R-TOUR-4: done.target にも警告が付き、場所は steps[].done.target になる', () => {
    const r = withStep(pageStep({ done: { type: 'element', target: { testId: 'x' } } }));
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.path)).toEqual(['steps[0].done.target']);
  });
});

describe('手がかりごとの範囲と role だけの手がかり', () => {
  const ok = (target: Obj): boolean => withTarget(target).ok;

  it('T-TOUR-64: name・label・text・css を { values, within } の形で書ける（within は範囲か page）', () => {
    expect(ok({ role: 'button', name: { values: ['保存'], within: 'page' } })).toBe(true);
    expect(ok({ label: { values: ['名前'], within: { css: 'form' } } })).toBe(true);
    expect(ok({ text: { values: ['保存'], within: { role: 'main', name: ['本文'] } } })).toBe(true);
    expect(ok({ css: { values: ['#a'], within: { label: ['検索'] } }, require: { role: 'button' } })).toBe(true);
    expect(ok({ text: { values: ['保存'] } })).toBe(true);
  });

  it('T-TOUR-64: within に範囲か page 以外を書くと、その場所のエラーになる', () => {
    for (const within of ['other', 5, {}, { css: '' }, { role: 'main' }]) {
      const r = withTarget({ label: { values: ['x'], within } });
      const paths = pathsOf(r);
      expect(paths, JSON.stringify(within)).toHaveLength(1);
      expect(paths[0], JSON.stringify(within)).toMatch(/^steps\[0\]\.target\.label\.within/u);
    }
  });

  it('T-TOUR-64: values が空・欠落、未知の項目があるときはエラーになる', () => {
    expect(pathsOf(withTarget({ label: { values: [] } }))).toEqual(['steps[0].target.label.values']);
    expect(withTarget({ label: { within: 'page' } }).ok).toBe(false);
    expect(pathsOf(withTarget({ label: { values: ['x'], extra: 1 } }))).toEqual(['steps[0].target.label.extra']);
    expect(withTarget({ label: 'x' }).ok).toBe(false);
  });

  it('T-TOUR-65: role があり name がない target は取り込めて、FR-10 の警告が出る', () => {
    const r = withTarget({ role: 'button' });
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.path)).toEqual(['steps[0].target']);
    const done = withStep(pageStep({ done: { type: 'element', target: { role: 'button' } } }));
    expect(done.warnings.map((w) => w.path)).toEqual(['steps[0].done.target']);
  });

  it('T-TOUR-65: role と name があれば警告は付かず、name が { values } の形でも付かない', () => {
    expect(withTarget({ role: 'button', name: ['保存'] }).warnings).toEqual([]);
    expect(withTarget({ role: 'button', name: { values: ['保存'], within: 'page' } }).warnings).toEqual([]);
  });
});
