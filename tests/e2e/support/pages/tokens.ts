/**
 * P-I（完了ページへ遷移）。`/tokens/new` のフォームで作成すると `/tokens/created` へ遷移する。
 * 入力欄には `data-tour-id="token-name"`、作成ボタンには `data-tour-id="token-create"` が付く。
 */
import { layout } from '../page-kit.ts';
import type { PageDef } from '../server.ts';

const newBody = `
<main>
  <h1>トークンを作成</h1>
  <form id="f" action="/tokens/created" method="get">
    <label>トークン名 <input type="text" id="token-name" name="name" data-tour-id="token-name"></label>
    <button type="submit" data-tour-id="token-create">作成</button>
  </form>
</main>`;

const createdBody = `
<main>
  <h1>トークンを作成しました</h1>
  <p>作成が完了しました。</p>
</main>`;

export const pages: PageDef[] = [
  { path: '/tokens/new', html: layout('トークンの作成', newBody) },
  { path: '/tokens/created', html: layout('トークンを作成しました', createdBody) },
];
