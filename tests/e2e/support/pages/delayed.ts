/**
 * P-K（遅延追加）。対象要素が最初は無く、後から追加される。
 * 追加される要素: `<button data-tour-id="late-button">遅れて出るボタン</button>`。
 * - `?delay=<秒>`: そのページを開いてから自動で追加する。指定が無い（または 0）ときは自動では追加しない。
 * - `window.addLateButton()`: 好きなタイミングで追加する（`page.evaluate`）。2回目以降は何もしない。
 * - `?far=1`: 追加先を、縦に長い余白の下（画面の外）にする。追加でスクロールしないことの確認用。
 */
import { layout } from '../page-kit.ts';
import type { PageDef } from '../server.ts';

export const pages: PageDef[] = [
  {
    path: '/delayed',
    html: ({ url }) => {
      const delay = Number(url.searchParams.get('delay') ?? '0');
      const far = url.searchParams.get('far') === '1';
      return layout(
        '遅延追加のページ',
        `<main><h1>遅れて要素が出るページ</h1>${far ? '<div style="height:3000px">余白</div>' : ''}<div id="slot"></div></main>`,
        {
          script: `<script>
window.addLateButton = function () {
  if (document.querySelector('[data-tour-id="late-button"]')) return;
  var b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('data-tour-id', 'late-button');
  b.textContent = '遅れて出るボタン';
  document.getElementById('slot').appendChild(b);
};
${delay > 0 ? `setTimeout(window.addLateButton, ${String(delay * 1000)});` : ''}
</script>`,
        },
      );
    },
  },
];
