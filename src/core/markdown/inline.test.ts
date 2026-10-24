// @vitest-environment jsdom
/**
 * renderInline のテスト。強調・インラインコードだけを扱い、HTML は文字列のまま表示する。
 */
import { describe, expect, it } from 'vitest';
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
});
