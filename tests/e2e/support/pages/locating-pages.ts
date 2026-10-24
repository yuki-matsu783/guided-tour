/**
 * 誤った案内の防止（locating.spec.ts）のためのテスト用ページ。パスは `/loc/` で始める。
 * - P-L（`/loc/ambiguous`・`/loc/same-ancestor`・`/loc/within`）: 候補が複数になる画面
 * - P-G（`/loc/guard-role`・`/loc/guard-region`・`/loc/guard-name`）: ID は合うが必須の照合に合わない要素
 * - P-M（`/loc/body-closest`・`/loc/long-form`）: 読み替え先が `body` になる指定と、長いフォーム
 * - P-H（`/loc/contents`）: `display: contents` の祖先を持つ要素
 * - P-E（`/loc/swap`）: 対象要素を入れ替えられるページ
 * - P-F（`/loc/mutable`）: 役割・領域・可視性・名前を変えられる対象要素のページ
 */
import { layout } from '../page-kit.ts';
import type { PageDef } from '../server.ts';

const ambiguous = `
<main>
  <h1>ユーザー一覧</h1>
  <table>
    <tr><td>山田</td><td><button type="button" data-row="1">削除</button></td></tr>
    <tr><td>佐藤</td><td><button type="button" data-row="2">削除</button></td></tr>
  </table>
  <p><a href="#only" id="only-link" data-final="yes">最後の手がかり用のリンク</a></p>
</main>`;

const sameAncestor = `
<main>
  <h1>行の操作</h1>
  <div class="row" style="border:1px solid #888;padding:8px">
    <button type="button">編集</button>
    <button type="button">編集</button>
  </div>
</main>`;

const within = `
<main>
  <h1>範囲の指定</h1>
  <section aria-label="設定"><button type="button">閉じる</button></section>
  <section aria-label="設定"><button type="button">閉じる</button></section>
  <button type="button" id="outside">保存</button>
</main>`;

export const pages: PageDef[] = [
  { path: '/loc/ambiguous', html: layout('候補が複数', ambiguous) },
  { path: '/loc/same-ancestor', html: layout('同じ祖先', sameAncestor) },
  { path: '/loc/within', html: layout('範囲の指定', within) },
  {
    path: '/loc/guard-role',
    html: layout(
      '役割が違う',
      `<main><h1>役割が違う要素</h1><a href="#x" data-tour-id="g-target" role="link">対象のリンク</a></main>`,
    ),
  },
  {
    path: '/loc/guard-region',
    html: layout(
      '領域が違う',
      `<main><h1>メイン</h1></main><aside aria-label="補足"><button type="button" data-tour-id="g-target">対象ボタン</button></aside>`,
    ),
  },
  {
    path: '/loc/guard-name',
    html: layout(
      '名前が違う',
      `<main><h1>名前が違う要素</h1><button type="button" data-tour-id="g-target">削除</button></main>`,
    ),
  },
  {
    path: '/loc/body-closest',
    html: layout('body に読み替え', `<main><h1>読み替え</h1><button type="button" data-tour-id="b-target">ボタン</button></main>`),
  },
  {
    path: '/loc/long-form',
    html: layout(
      '長いフォーム',
      `<main><form style="width:50%;height:3000px;border:1px solid #888" onsubmit="return false">
<button type="button" data-tour-id="b-target">送信</button></form></main>`,
    ),
  },
  {
    path: '/loc/contents',
    html: layout(
      'display: contents',
      `<main><h1>表示の確認</h1><div style="display:contents"><div style="display:contents"><button type="button" data-tour-id="h-target">対象ボタン</button></div></div></main>`,
    ),
  },
  {
    path: '/loc/swap',
    html: layout(
      '入れ替え',
      `<main id="m"><h1>入れ替えるページ</h1><div id="slot"><button type="button" data-tour-id="e-target" style="margin-top:20px">最初のボタン</button></div></main>`,
      {
        script: `<script>
window.swapNow = function (marginTop) {
  var slot = document.getElementById('slot');
  var b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('data-tour-id', 'e-target');
  b.style.marginTop = marginTop + 'px';
  b.textContent = '入れ替えたボタン';
  slot.replaceChildren(b);
};
window.removeNow = function () { document.getElementById('slot').replaceChildren(); };
</script>`,
      },
    ),
  },
  {
    path: '/loc/mutable',
    html: layout(
      '変化するページ',
      `<main id="m"><h1>変化するページ</h1><button type="button" data-tour-id="f-target">対象ボタン</button></main><aside id="side" aria-label="補足"></aside>`,
    ),
  },
];
