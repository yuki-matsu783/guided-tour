/**
 * テスト用ページを書くための共通の部品。`pages/*.ts` から使う。
 * ページは HTML 文字列で書く。拡張機能のコードは入れない（拡張機能が組み込まれる前の素のページにする）。
 */

/** HTML の特殊文字を無害にする（ページに差し込む文字列用）。 */
export function esc(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export interface LayoutOptions {
  lang?: string;
  /** `<head>` に足す内容（`<style>` など）。 */
  head?: string;
  /** `<body>` の末尾に足す内容（`<script>` など）。 */
  script?: string;
}

/** 最小の HTML 文書。title は日本語でもよい。 */
export function layout(title: string, body: string, options: LayoutOptions = {}): string {
  return `<!doctype html>
<html lang="${options.lang ?? 'ja'}">
<head><meta charset="utf-8"><title>${esc(title)}</title>${options.head ?? ''}</head>
<body>
${body}
${options.script ?? ''}
</body>
</html>`;
}
