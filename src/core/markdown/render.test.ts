// @vitest-environment jsdom
/**
 * renderMarkdown のテスト（T-MD-01〜T-MD-50）。
 * 許可リスト・HTML の文字列表示・リンクと画像の方式・再描画を DOM で確かめる。
 */
import { describe, expect, it, vi } from 'vitest';
import { renderMarkdown } from './render';

const ALLOWED = new Set([
  'p', 'h2', 'h3', 'h4', 'h5', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li',
  'blockquote', 'hr', 'br', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'img',
]);
const EXT = 'chrome-extension://abc/';
const identity = (src: string): string | null => src;
const asExt = (src: string): string | null => `${EXT}${src}`;

function render(
  src: string,
  opts: { resolve?: (s: string) => string | null; origins?: string[] } = {},
): HTMLElement {
  const container = document.createElement('div');
  renderMarkdown(src, container, opts.resolve ?? asExt, opts.origins ?? []);
  return container;
}

describe('HTML を文字列のまま表示', () => {
  it('T-MD-01: <b> は要素にならず文字列で表示される', () => {
    const c = render('これは <b>重要</b> です');
    expect(c.querySelector('b')).toBeNull();
    expect(c.textContent).toContain('<b>重要</b>');
  });

  it('T-MD-02: script は要素にならず文字列で表示される', () => {
    const c = render('<script>alert(1)</script>');
    expect(c.querySelector('script')).toBeNull();
    expect(c.textContent).toContain('<script>alert(1)</script>');
  });

  it('T-MD-03: img タグの HTML は要素にならず文字列で表示される', () => {
    const c = render('<img src=x onerror=alert(1)>');
    expect(c.querySelector('img')).toBeNull();
    expect(c.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('T-MD-04: HTML ブロックの div は要素にならず文字列で表示される', () => {
    const c = render('<div>本文</div>\n\n後ろ');
    expect(c.querySelector('div')).toBeNull();
    expect(c.textContent).toContain('<div>本文</div>');
  });

  it('T-MD-05: コードブロックとインラインコードの中の HTML は文字列のまま', () => {
    const c = render('`<b>x</b>`\n\n```\n<div>y</div>\n```');
    expect(c.querySelector('b')).toBeNull();
    expect(c.querySelector('div')).toBeNull();
    expect(c.querySelector('p code')?.textContent).toBe('<b>x</b>');
    expect(c.querySelector('pre code')?.textContent).toBe('<div>y</div>\n');
  });

  it('T-MD-06: 結果に許可リストにない要素が含まれない', () => {
    const src = [
      '# h', '', '<script>x</script>', '', '~~del~~', '', '| a | b |', '|---|---|', '| 1 | 2 |', '',
      '[l](https://example.com) ![a](a.png)', '', '> q', '', '- x', '', '1. y', '', '---', '', 'a  ', 'b',
    ].join('\n');
    const c = render(src, { origins: ['https://example.com'] });
    for (const el of c.querySelectorAll('*')) {
      expect(ALLOWED.has(el.tagName.toLowerCase())).toBe(true);
    }
  });

  it('T-MD-07: innerHTML・outerHTML・insertAdjacentHTML を呼ばない', () => {
    const setter = vi.fn();
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    const outer = Object.getOwnPropertyDescriptor(Element.prototype, 'outerHTML');
    Object.defineProperty(Element.prototype, 'innerHTML', { ...descriptor, set: setter });
    Object.defineProperty(Element.prototype, 'outerHTML', { ...outer, set: setter });
    const adjacent = vi.spyOn(Element.prototype, 'insertAdjacentHTML');
    try {
      render('# a\n\n**b** `c`\n\n```\nd\n```\n\n| a |\n|---|\n| 1 |\n\n[l](https://e.com) ![i](i.png)');
      expect(setter).not.toHaveBeenCalled();
      expect(adjacent).not.toHaveBeenCalled();
    } finally {
      if (descriptor) Object.defineProperty(Element.prototype, 'innerHTML', descriptor);
      if (outer) Object.defineProperty(Element.prototype, 'outerHTML', outer);
      adjacent.mockRestore();
    }
  });
});

describe('許可リスト', () => {
  it('T-MD-08: 段落・強調・インラインコード・コードブロックが変換される', () => {
    const c = render('段落 **強** *調* `コード`\n\n```\nblock\n```');
    expect(c.querySelector('p strong')?.textContent).toBe('強');
    expect(c.querySelector('p em')?.textContent).toBe('調');
    expect(c.querySelector('p code')?.textContent).toBe('コード');
    expect(c.querySelector('pre > code')?.textContent).toBe('block\n');
  });

  it('T-MD-09: 箇条書きと番号付きリストが変換される', () => {
    const c = render('- a\n- b\n\n1. c\n2. d');
    expect(c.querySelectorAll('ul > li')).toHaveLength(2);
    expect(c.querySelectorAll('ol > li')).toHaveLength(2);
  });

  it('T-MD-10: 引用・水平線・改行が変換される', () => {
    const c = render('> 引用\n\n---\n\n行1  \n行2');
    expect(c.querySelector('blockquote')).not.toBeNull();
    expect(c.querySelector('hr')).not.toBeNull();
    expect(c.querySelector('br')).not.toBeNull();
  });

  it('T-MD-11: 表が変換される', () => {
    const c = render('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(c.querySelectorAll('table > thead > tr > th')).toHaveLength(2);
    expect(c.querySelectorAll('table > tbody > tr > td')).toHaveLength(2);
  });

  it('T-MD-12: 付く属性は a の href・img の src と alt・揃えのクラスだけ', () => {
    const src = '[l](https://example.com "title")\n\n![alt](a.png "t")\n\n| a |\n|:-:|\n| 1 |\n\n# h';
    const c = render(src, { origins: ['https://example.com'] });
    const allowedAttrs: Record<string, string[]> = {
      a: ['href', 'target', 'rel'],
      img: ['src', 'alt'],
      th: ['class'],
      td: ['class'],
    };
    for (const el of c.querySelectorAll('*')) {
      const names = el.getAttributeNames();
      expect(names.every((n) => (allowedAttrs[el.tagName.toLowerCase()] ?? []).includes(n))).toBe(true);
    }
  });

  it('T-MD-13: h5・h6 は見出し要素にならず段落（文字列）で表示される', () => {
    const c = render('##### 五\n\n###### 六');
    expect(c.querySelector('h5, h6')).toBeNull();
    expect(Array.from(c.querySelectorAll('p')).map((p) => p.textContent)).toEqual(['五', '六']);
  });

  it('T-MD-14: 取り消し線は要素にならず内容が文字列で表示される', () => {
    const c = render('前 ~~消す~~ 後');
    expect(c.querySelector('s, del, strike')).toBeNull();
    expect(c.textContent).toBe('前 消す 後');
  });

  it('T-MD-15: URL だけを書いてもリンクにならない', () => {
    const c = render('https://example.com');
    expect(c.querySelector('a')).toBeNull();
    expect(c.textContent).toBe('https://example.com');
  });
});

describe('見出しの1段下げ', () => {
  it('T-MD-16: # は h2 になる', () => {
    expect(render('# 見出し').querySelector('h2')?.textContent).toBe('見出し');
  });
  it('T-MD-17: ## は h3 になる', () => {
    expect(render('## 見出し').querySelector('h3')?.textContent).toBe('見出し');
  });
  it('T-MD-18: ### は h4 になる', () => {
    expect(render('### 見出し').querySelector('h4')?.textContent).toBe('見出し');
  });
  it('T-MD-19: #### は h5 になる（Q8：h1〜h4 を h2〜h5 で表示）', () => {
    const c = render('#### 見出し');
    expect(c.querySelector('h5')?.textContent).toBe('見出し');
    expect(c.querySelector('h1')).toBeNull();
  });
});

describe('表の揃え', () => {
  const table = (sep: string): HTMLElement => render(`| a |\n|${sep}|\n| 1 |`);
  it('T-MD-20: 左揃えのクラスが th・td に付く', () => {
    const c = table(':---');
    expect(c.querySelector('th')?.className).toBe('md-align-left');
    expect(c.querySelector('td')?.className).toBe('md-align-left');
  });
  it('T-MD-21: 中央揃えのクラスが th・td に付く', () => {
    const c = table(':---:');
    expect(c.querySelector('th')?.className).toBe('md-align-center');
    expect(c.querySelector('td')?.className).toBe('md-align-center');
  });
  it('T-MD-22: 右揃えのクラスが th・td に付く', () => {
    const c = table('---:');
    expect(c.querySelector('th')?.className).toBe('md-align-right');
    expect(c.querySelector('td')?.className).toBe('md-align-right');
  });
  it('T-MD-23: 揃えの指定がなければクラスも style も付かない', () => {
    const c = table('---');
    for (const cell of c.querySelectorAll('th, td')) {
      expect(cell.hasAttribute('class')).toBe(false);
      expect(cell.hasAttribute('style')).toBe(false);
    }
  });
});

describe('リンク', () => {
  const link = (md: string, origins: string[] = []): HTMLElement => render(md, { origins });

  it('T-MD-24: https のリンクは a になり href がリンク先になる', () => {
    expect(link('[x](https://example.com/p?q=1)').querySelector('a')?.getAttribute('href')).toBe(
      'https://example.com/p?q=1',
    );
  });
  it('T-MD-25: http のリンクは a になり href がリンク先になる', () => {
    expect(link('[x](http://example.com/p)').querySelector('a')?.getAttribute('href')).toBe(
      'http://example.com/p',
    );
  });
  it('T-MD-26: javascript: のリンクは a にならず文字列で表示される', () => {
    const c = link('[x](javascript:alert(1))');
    expect(c.querySelector('a')).toBeNull();
    expect(c.textContent).toContain('x');
  });
  it('T-MD-27: data・file・mailto・chrome-extension は a にならず文字列で表示される', () => {
    for (const url of [
      'data:text/html,hi',
      'file:///etc/passwd',
      'mailto:a@example.com',
      'chrome-extension://abc/x.html',
    ]) {
      const c = link(`[リンク](${url})`);
      expect(c.querySelector('a')).toBeNull();
      expect(c.textContent).toContain('リンク');
    }
  });
  it('T-MD-28: JAVASCRIPT: は無効、HTTPS: は http/https として扱う', () => {
    expect(link('[x](JAVASCRIPT:alert(1))').querySelector('a')).toBeNull();
    expect(link('[x](HTTPS://example.com/)').querySelector('a')).not.toBeNull();
  });
  it('T-MD-29: 空白・制御文字で方式を隠したリンクは a にならない', () => {
    expect(link('[x](java\tscript:alert(1))').querySelector('a')).toBeNull();
    expect(link('[x](java%09script:alert(1))').querySelector('a')).toBeNull();
    expect(link('[x](jav&#x09;ascript:alert(1))').querySelector('a')).toBeNull();
  });
  it('T-MD-30: 相対パスと //example.com は a にならず文字列で表示される', () => {
    for (const url of ['./a.html', '/a', '../a', '//example.com/a']) {
      const c = link(`[x](${url})`);
      expect(c.querySelector('a')).toBeNull();
      expect(c.textContent).toContain('x');
    }
  });
  it('T-MD-31: 有効なリンクに target と rel が付く', () => {
    const a = link('[x](https://example.com)').querySelector('a');
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer');
  });
  it('T-MD-32: リンクの後ろにホスト名が添えられる', () => {
    const c = link('[x](https://example.com/a)', ['https://example.com']);
    expect(c.querySelector('p')?.textContent).toBe('x (example.com)');
  });
  it('T-MD-33: origins に含まれるホストには「宣言外のサイト」が付かない', () => {
    const c = link('[x](https://example.com/a)', ['https://example.com']);
    expect(c.textContent).not.toContain('宣言外のサイト');
  });
  it('T-MD-34: origins に含まれないホストには「宣言外のサイト」が付く', () => {
    const c = link('[x](https://other.example.org/a)', ['https://example.com']);
    expect(c.textContent).toContain('other.example.org');
    expect(c.textContent).toContain('宣言外のサイト');
  });
  it('T-MD-35: ポート付きでもホスト名だけで origins と比べる（Q3）', () => {
    const c = link('[x](https://example.com:8443/a)', ['https://example.com']);
    expect(c.textContent).not.toContain('宣言外のサイト');
    expect(link('[x](https://example.com/a)', ['https://example.com:8443']).textContent).not.toContain(
      '宣言外のサイト',
    );
  });
  it('T-MD-36: 方式が違っても同じホストなら宣言済みとして扱う（Q3：方式は見ない）', () => {
    const c = link('[x](http://example.com/a)', ['https://example.com']);
    expect(c.textContent).not.toContain('宣言外のサイト');
  });
  it('T-MD-37: 画像をリンクの文字にしたとき画像とリンクの両方が処理される', () => {
    const c = link('[![代替](pic.png)](https://example.com/a)', ['https://example.com']);
    expect(c.querySelector('a > img')?.getAttribute('src')).toBe(`${EXT}pic.png`);
    expect(c.querySelector('a')?.getAttribute('href')).toBe('https://example.com/a');
  });
  it('T-MD-38: 大文字・日本語ドメインのホスト名はブラウザの正規化した形で示される', () => {
    expect(link('[x](https://EXAMPLE.com/a)').textContent).toContain('(example.com');
    const host = new URL('https://例え.jp/').hostname;
    expect(link('[x](https://例え.jp/a)').textContent).toContain(host);
    expect(host).toMatch(/^xn--/);
  });
});

describe('画像', () => {
  const img = (md: string, resolve: (s: string) => string | null): HTMLElement =>
    render(md, { resolve });

  it('T-MD-39: 相対パスは resolveAsset の結果が src になる', () => {
    const resolve = vi.fn(asExt);
    const c = img('![a](images/a.png)', resolve);
    expect(resolve).toHaveBeenCalledWith('images/a.png');
    expect(c.querySelector('img')?.getAttribute('src')).toBe(`${EXT}images/a.png`);
  });
  it('T-MD-40: 拡張機能内の URL が src に使われる', () => {
    const c = img('![a](x.png)', () => 'chrome-extension://id/assets/x.png');
    expect(c.querySelector('img')?.getAttribute('src')).toBe('chrome-extension://id/assets/x.png');
  });
  it('T-MD-41: blob URL が src に使われる', () => {
    const c = img('![a](x.png)', () => 'blob:chrome-extension://id/uuid');
    expect(c.querySelector('img')?.getAttribute('src')).toBe('blob:chrome-extension://id/uuid');
  });
  it('T-MD-42: 許可された data URL が src に使われる', () => {
    for (const type of ['png', 'jpeg', 'gif', 'webp']) {
      const url = `data:image/${type};base64,AAAA`;
      expect(img('![a](x.png)', () => url).querySelector('img')?.getAttribute('src')).toBe(url);
    }
  });
  it('T-MD-43: 許可リスト外の URL が返されたら img は作られない', () => {
    for (const url of [
      'https://example.com/a.png',
      'javascript:alert(1)',
      'data:image/svg+xml;base64,AAAA',
    ]) {
      const c = img('![代替](x.png)', () => url);
      expect(c.querySelector('img')).toBeNull();
      expect(c.textContent).toBe('代替');
    }
  });
  it('T-MD-44: alt が img の alt 属性になる', () => {
    expect(img('![説明文](x.png)', asExt).querySelector('img')?.getAttribute('alt')).toBe('説明文');
  });
  it('T-MD-45: 解決に失敗したとき代替文が表示される', () => {
    const c = img('![代替文](x.png)', () => null);
    expect(c.querySelector('img')).toBeNull();
    expect(c.querySelector('p')?.textContent).toBe('代替文');
  });
  it('T-MD-46: 読み込みに失敗したとき代替文が表示される', () => {
    const c = img('![代替文](x.png)', asExt);
    const el = c.querySelector('img');
    expect(el).not.toBeNull();
    el?.dispatchEvent(new Event('error'));
    expect(c.querySelector('img')).toBeNull();
    expect(c.querySelector('p')?.textContent).toBe('代替文');
  });
  it('T-MD-47: 外部 URL の画像は img が作られない', () => {
    for (const resolve of [identity, () => null]) {
      const c = img('![a](https://example.com/a.png)', resolve);
      expect(c.querySelector('img')).toBeNull();
    }
  });
  it('T-MD-48: 代替文が空の画像でも壊れず、alt が空の img になる（Q9）', () => {
    const c = img('![](x.png)', asExt);
    expect(c.querySelector('img')?.getAttribute('alt')).toBe('');
    expect(() => img('![](x.png)', () => null)).not.toThrow();
  });
});

describe('描画の呼び出し方', () => {
  it('T-MD-49: 同じコンテナに続けて描画すると前の内容が置き換わる（Q10）', () => {
    const c = document.createElement('div');
    renderMarkdown('# 一回目', c, asExt, []);
    renderMarkdown('二回目', c, asExt, []);
    expect(c.querySelector('h2')).toBeNull();
    expect(c.textContent).toBe('二回目');
    expect(c.children).toHaveLength(1);
  });
  it('T-MD-50: 空文字列ならコンテナは空になり例外は出ない', () => {
    const c = document.createElement('div');
    c.textContent = '前';
    expect(() => {
      renderMarkdown('', c, asExt, []);
    }).not.toThrow();
    expect(c.childNodes).toHaveLength(0);
  });
});
