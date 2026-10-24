/**
 * P-C（社内ツール風・日本語版）。日本語の名前・ラベルのフォーム。`data-tour-id` あり。
 * `/internal/` は複数ステップのテスト用ツアーが指す入力欄・チェックボックス・ボタンを持つ。
 */
import { layout } from '../page-kit.ts';
import type { PageDef } from '../server.ts';

const body = `
<main>
  <h1>社内ツール 利用申請</h1>
  <form onsubmit="return false">
    <label>申請者名 <input type="text" name="applicant" data-tour-id="applicant-name"></label><br>
    <label>メールアドレス <input type="email" name="mail" data-tour-id="applicant-mail"></label><br>
    <label><input type="checkbox" name="agree" data-tour-id="agree-check"> 利用規約に同意する</label><br>
    <button type="button" data-tour-id="submit-button">申請する</button>
  </form>
</main>`;

export const pages: PageDef[] = [
  { path: '/internal/', html: layout('社内ツール', body) },
  { path: '/internal', html: layout('社内ツール', body) },
];
