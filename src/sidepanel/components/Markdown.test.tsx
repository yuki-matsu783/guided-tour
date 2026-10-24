// @vitest-environment jsdom
/**
 * Markdown コンポーネントのテスト。画像のパスを、取り込みが保存する形（decodeURIComponent したパス）で
 * 画像の URL 管理に渡し、日本語やスペースを含む名前の画像も表示できることを確かめる。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Assets } from '../assets/index.ts';
import { flush, mount, unmountAll } from '../test-support.tsx';
import { Markdown } from './Markdown.tsx';

afterEach(async () => {
  await unmountAll();
});

/** 保存済みのパスだけを blob URL に解決する偽の画像の URL 管理。 */
function fakeAssets(stored: readonly string[]): { assets: Assets; asked: string[] } {
  const asked: string[] = [];
  const assets: Assets = {
    resolve: vi.fn((_tourId: string, _hash: string, path: string) => {
      asked.push(path);
      return Promise.resolve(stored.includes(path) ? `blob:fake/${encodeURIComponent(path)}` : null);
    }),
    keep: vi.fn(),
    revokeAll: vi.fn(),
  };
  return { assets, asked };
}

async function show(text: string, stored: readonly string[], baseFile = 'steps/01.md') {
  const { assets, asked } = fakeAssets(stored);
  const { container } = await mount(
    <Markdown text={text} baseFile={baseFile} tourId="t" hash="h" origins={[]} assets={assets} />,
  );
  await flush();
  return { container, asked };
}

describe('Markdown の画像のパス', () => {
  it('R-FINAL-05: 日本語を含むファイル名の画像（![図](img/画像.png)）が表示される', async () => {
    const { container, asked } = await show('![図](img/画像.png)', ['steps/img/画像.png']);
    expect(asked).toEqual(['steps/img/画像.png']);
    const img = container.querySelector('img');
    expect(img?.getAttribute('alt')).toBe('図');
    expect(img?.getAttribute('src')).toBe(`blob:fake/${encodeURIComponent('steps/img/画像.png')}`);
  });

  it('R-FINAL-05: スペースを含むファイル名（![a b](img/a%20b.png)）が、取り込みが保存する img/a b.png で解決され表示される', async () => {
    const { container, asked } = await show('![a b](img/a%20b.png)', ['steps/img/a b.png']);
    expect(asked).toEqual(['steps/img/a b.png']);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(`blob:fake/${encodeURIComponent('steps/img/a b.png')}`);
  });

  it('R-FINAL-05: パーセントエンコードした日本語（%E7%94%BB%E5%83%8F.png）も、同じパスで解決される', async () => {
    const { container } = await show('![図](../img/%E7%94%BB%E5%83%8F.png)', ['img/画像.png']);
    expect(container.querySelector('img')).not.toBeNull();
  });

  it('R-FINAL-05: 英数字だけのパスも、これまでどおり表示される', async () => {
    const { container } = await show('![x](img/a.png)', ['steps/img/a.png']);
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('x');
  });

  it('R-FINAL-05: 戻せないパス（不正な %）と保存されていない画像は、代替文になる', async () => {
    const { container } = await show('![壊れ](img/%E0%A4%A.png) ![無い](img/none.png)', []);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('壊れ');
    expect(container.textContent).toContain('無い');
  });
});
