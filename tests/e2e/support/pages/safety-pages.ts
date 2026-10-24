/**
 * 安全性（safety.spec.ts）のためのテスト用ページ。パスは `/safety/`・`/long/` で始める。
 * - P-B/P-N（`/safety/token...`）: トークン発行風のページ。入力欄・password 欄・ページの文字列に、ログへ出てはならない目印の文字列を置く
 * - P-J（`/long/...`）: 非常に長い URL のページ（`**` を使う URL 条件の確認用）。パスは何でもよい
 */
import { layout } from '../page-kit.ts';
import type { PageDef } from '../server.ts';

/** ログに出てはならない目印。入力値・ページの文字列・URL の断片。 */
export const MARKERS = {
  input: 'INPUTMARK-4f81',
  password: 'PWMARK-b7e2',
  pageText: 'PAGETEXT-c93d',
  urlQuery: 'URLQUERY-12ab',
  urlFragment: 'URLFRAG-77ee',
  urlPath: 'URLPATH-5d0e',
  exception: 'EXCMARK-88aa',
} as const;

const tokenBody = `
<main>
  <h1>${MARKERS.pageText} トークンの発行</h1>
  <form onsubmit="return false">
    <label>トークン名 <input type="text" data-tour-id="t-name" value="${MARKERS.input}"></label><br>
    <label>パスワード <input type="password" data-tour-id="t-pass" value="${MARKERS.password}"></label><br>
    <button type="button" data-tour-id="t-submit">発行 ${MARKERS.pageText}</button>
  </form>
</main>`;

export const pages: PageDef[] = [
  { path: /^\/safety\/token/, html: layout('トークンの発行', tokenBody) },
  { path: /^\/long\//, html: layout('長い URL', `<main><h1>長い URL のページ</h1><button type="button" data-tour-id="long-button">ボタン</button></main>`) },
];
