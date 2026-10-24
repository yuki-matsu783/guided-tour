// @vitest-environment jsdom
/**
 * renderInline のテスト。強調・インラインコードだけを扱い、HTML は文字列のまま表示する。
 */
import { describe, expect, it, vi } from 'vitest';
import { PACKAGE_LIMITS } from '../package/limits';
import { renderInline } from './inline';

function render(src: string): HTMLElement {
  const c = document.createElement('div');
  renderInline(src, c);
  return c;
}

describe('renderInline', () => {
  it('強調・斜体・コードを要素にする', () => {
    const c = render('a **b** *c* `d`');
    expect(c.querySelector('strong')?.textContent).toBe('b');
    expect(c.querySelector('em')?.textContent).toBe('c');
    expect(c.querySelector('code')?.textContent).toBe('d');
    expect(c.textContent).toBe('a b c d');
  });

  it('HTML は要素にならず文字列のまま', () => {
    const c = render('<b>x</b> <script>1</script>');
    expect(c.querySelector('b, script')).toBeNull();
    expect(c.textContent).toBe('<b>x</b> <script>1</script>');
  });

  it('コードの中の記号は解釈しない', () => {
    const c = render('`**a**`');
    expect(c.querySelector('strong')).toBeNull();
    expect(c.querySelector('code')?.textContent).toBe('**a**');
  });

  it('閉じていない記号は文字列のまま', () => {
    expect(render('**a').textContent).toBe('**a');
    expect(render('`a').textContent).toBe('`a');
    expect(render('****').textContent).toBe('****');
  });

  it('リンクや画像の記法は文字列のまま', () => {
    const c = render('[a](https://example.com) ![b](c.png)');
    expect(c.querySelector('a, img')).toBeNull();
    expect(c.textContent).toBe('[a](https://example.com) ![b](c.png)');
  });

  it('再描画で中身を置き換える', () => {
    const c = document.createElement('div');
    renderInline('**一**', c);
    renderInline('二', c);
    expect(c.innerHTML).toBe('二');
  });

  it('R-MD-5: 強調の中に強調を入れられる（*a **b** c*）', () => {
    const c = render('*a **b** c*');
    expect(c.querySelector('em > strong')?.textContent).toBe('b');
    expect(c.querySelector('em')?.textContent).toBe('a b c');
    expect(c.textContent).toBe('a b c');
  });

  it('R-MD-5: 空白に挟まれた * は強調にしない（2 * 3 * 4）', () => {
    const c = render('2 * 3 * 4');
    expect(c.querySelector('em, strong')).toBeNull();
    expect(c.textContent).toBe('2 * 3 * 4');
  });

  it('R-MD-5: ***a*** は em の中の strong になる', () => {
    const c = render('***a***');
    expect(c.querySelector('em > strong')?.textContent).toBe('a');
    expect(c.textContent).toBe('a');
  });

  it('R-MD-5: 対応のない * は文字列のまま残る', () => {
    expect(render('*a').textContent).toBe('*a');
    expect(render('a**').textContent).toBe('a**');
  });

  it('R-MD-6: innerHTML・outerHTML・insertAdjacentHTML を呼ばない', () => {
    const setter = vi.fn();
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    const outer = Object.getOwnPropertyDescriptor(Element.prototype, 'outerHTML');
    Object.defineProperty(Element.prototype, 'innerHTML', { ...descriptor, set: setter });
    Object.defineProperty(Element.prototype, 'outerHTML', { ...outer, set: setter });
    const adjacent = vi.spyOn(Element.prototype, 'insertAdjacentHTML');
    try {
      render('a **b** *c* `d` <b>e</b> ***f***');
      expect(setter).not.toHaveBeenCalled();
      expect(adjacent).not.toHaveBeenCalled();
    } finally {
      if (descriptor) Object.defineProperty(Element.prototype, 'innerHTML', descriptor);
      if (outer) Object.defineProperty(Element.prototype, 'outerHTML', outer);
      adjacent.mockRestore();
    }
  });
});

describe('強調の解析の手間（最悪の入力）', () => {
  const MAX_MS = 5000;
  const repeatTo = (unit: string, bytes: number): string => unit.repeat(Math.floor(bytes / unit.length));
  /** `tip` は YAML の中の文字列なので、YAML の上限に入る長さが最大。 */
  const TIP_BYTES = PACKAGE_LIMITS.yamlBytes - 64;

  it('R-FINAL-03: 区切りの手順どおりの結果になる（開きが見つからない閉じが手前にあっても、あとの対応を見落とさない）', () => {
    expect(render('a* b *c d* e*').innerHTML).toBe('a* b <em>c d</em> e*');
    expect(render('*a* b* c*').innerHTML).toBe('<em>a</em> b* c*');
    expect(render('**a* b*').innerHTML).toBe('<em><em>a</em> b</em>');
    expect(render('*a **b** c* d**').innerHTML).toBe('<em>a <strong>b</strong> c</em> d**');
    expect(render('*foo**bar**baz*').innerHTML).toBe('<em>foo<strong>bar</strong>baz</em>');
    expect(render('*foo**bar*').innerHTML).toBe('<em>foo**bar</em>');
    expect(render('x ** y **z**').innerHTML).toBe('x ** y <strong>z</strong>');
  });

  it('R-FINAL-03: 3 の倍数の規則（*foo**bar*・**foo*bar*** など）が今までと同じ結果になる', () => {
    expect(render('**foo*bar***').innerHTML).toBe('<strong>foo<em>bar</em></strong>');
    expect(render('***a** b*').innerHTML).toBe('<em><strong>a</strong> b</em>');
  });

  it('R-FINAL-03: 強調の入れ子が深すぎるときは、深い側を要素にせず記号を文字列のまま残す（DOM の深さに上限がある）', () => {
    const depthOf = (el: Element): number => {
      let max = 0;
      for (const child of Array.from(el.children)) max = Math.max(max, depthOf(child));
      return max + 1;
    };
    const n = 500;
    const c = render(`${'*a '.repeat(n)}${'a* '.repeat(n)}`);
    expect(depthOf(c) - 1).toBeLessThanOrEqual(100);
    // 記号を除いた文字列は変わらない
    expect(c.textContent.replaceAll('*', '')).toBe(`${'a '.repeat(n)}${'a '.repeat(n)}`);
    // 浅ければ今までどおり要素になる
    expect(render('*a *b *c c* b* a*').querySelectorAll('em')).toHaveLength(3);
  });

  const cases: [string, string][] = [
    ['`*a ` の連続（開きだけが並ぶ）', repeatTo('*a ', TIP_BYTES)],
    ['`a* ` の連続（閉じだけが並ぶ）', repeatTo('a* ', TIP_BYTES)],
    ['`**a *` の連続', repeatTo('**a *', TIP_BYTES)],
    ['`*` だけの連続', repeatTo('*', TIP_BYTES)],
    ['開きが前半・閉じが後半に並ぶ（入れ子）', `${repeatTo('*a ', TIP_BYTES / 2)}${repeatTo('a* ', TIP_BYTES / 2)}`],
    ['3 の倍数の規則で対応しない組が並ぶ', `${repeatTo('***a ', TIP_BYTES / 2)}${repeatTo('a* ', TIP_BYTES / 2)}`],
  ];
  it.each(cases)(
    'R-FINAL-03 R-FINAL-04: tip が YAML の上限いっぱいの長さ（%s）でも、5 秒以内に描画できる',
    (_name, src) => {
      expect(src.length).toBeLessThanOrEqual(PACKAGE_LIMITS.yamlBytes);
      const started = performance.now();
      render(src);
      expect(performance.now() - started).toBeLessThan(MAX_MS);
    },
    30_000,
  );

  it(
    'R-FINAL-03 R-FINAL-04: 対応する強調が大量に並ぶ入力（256 KB）も、5 秒以内に描画できる',
    () => {
      const src = repeatTo('*a* ', 256 * 1024);
      const started = performance.now();
      const c = render(src);
      expect(performance.now() - started).toBeLessThan(MAX_MS);
      expect(c.querySelectorAll('em').length).toBe(src.length / 4);
    },
    30_000,
  );
});
