/**
 * P-O（右端の要素）。対象要素が画面の右端に張り付くページ。ミニガイドと吹き出しの重なりの確認用。
 * 対象は `<button data-tour-id="edge-button">右端のボタン</button>`（右端に固定、縦は画面の上から 200px）。
 */
import { layout } from '../page-kit.ts';
import type { PageDef } from '../server.ts';

const body = `
<main>
  <h1>右端に要素があるページ</h1>
  <p>対象のボタンは、画面の右端に張り付いています。</p>
  <button type="button" data-tour-id="edge-button" style="position:fixed;right:0;top:200px;">右端のボタン</button>
</main>`;

export const pages: PageDef[] = [{ path: '/right-edge', html: layout('右端のページ', body) }];
