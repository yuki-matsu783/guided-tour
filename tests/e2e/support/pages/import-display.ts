/**
 * 取り込みと表示の E2E 用のページ。
 * - P-B（GitLab 風）`/gitlab/tokens?lang=en|ja`: トークン発行画面を模す。`data-tour-id` が無く、役割と名前で特定する構成。
 *   言語で名前が変わる。トークン名の入力欄（label「Token name」「トークン名」）と、追加ボタン（「Add new token」「新しいトークンを追加」）を持つ。
 * - P-D（社内ツール風・英語版）`/internal-en/`: `data-tour-id` が無く、文字列の候補で照合する。
 *   見出し「Access request」、ボタン「Submit request」、リンク「Help center」を持つ。
 */
import { layout } from '../page-kit.ts';
import type { PageDef } from '../server.ts';

const TEXTS = {
  en: { title: 'Personal access tokens', name: 'Token name', add: 'Add new token', note: 'Create a token for API access.' },
  ja: { title: '個人用アクセストークン', name: 'トークン名', add: '新しいトークンを追加', note: 'API で使うトークンを作成します。' },
} as const;

const internalEn = `
<main>
  <h1>Access request</h1>
  <p>Request access to the internal tool.</p>
  <button type="button">Submit request</button>
  <a href="#help">Help center</a>
</main>`;

export const pages: PageDef[] = [
  {
    path: '/gitlab/tokens',
    html: ({ url }) => {
      const lang = url.searchParams.get('lang') === 'en' ? 'en' : 'ja';
      const t = TEXTS[lang];
      return layout(
        t.title,
        `<main>
  <h1>${t.title}</h1>
  <p>${t.note}</p>
  <form onsubmit="return false">
    <label for="token-name-input">${t.name}</label>
    <input type="text" id="token-name-input" name="token_name">
    <button type="button">${t.add}</button>
  </form>
</main>`,
        { lang },
      );
    },
  },
  { path: '/internal-en/', html: layout('Internal tool', internalEn, { lang: 'en' }) },
  { path: '/internal-en', html: layout('Internal tool', internalEn, { lang: 'en' }) },
];
