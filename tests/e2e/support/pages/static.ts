/**
 * P-A（静的）・P-P（不一致ページ）。対象要素が最初から存在し、変化しないページ。
 * P-Q（別オリジン）は、同じページを `127.0.0.1` で開く（`server.url(path, '127.0.0.1')`）。
 */
import { layout } from '../page-kit.ts';
import type { PageDef } from '../server.ts';

const staticBody = `
<main>
  <h1>静的なテストページ</h1>
  <p>対象要素が最初から存在し、変化しません。</p>
  <label>名前 <input type="text" name="name" data-tour-id="static-input"></label>
  <button type="button" data-tour-id="static-button">送信</button>
</main>`;

export const pages: PageDef[] = [
  { path: '/static', html: layout('静的ページ', staticBody) },
  // URL 条件が /project の前方一致のとき、/project と /project/settings は合い、/project-danger は合わない
  { path: '/project', html: layout('プロジェクト', staticBody) },
  { path: '/project/settings', html: layout('プロジェクトの設定', staticBody) },
  { path: '/project-danger', html: layout('危険なプロジェクト', staticBody) },
  // 画面の外にある要素。ページの最下部へ置く
  {
    path: '/static-tall',
    html: layout(
      '縦に長い静的ページ',
      `<main><h1>縦に長いページ</h1><div style="height:3000px">余白</div>
<button type="button" data-tour-id="far-button">下の方のボタン</button></main>`,
    ),
  },
];
