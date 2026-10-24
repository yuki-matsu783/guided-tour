/**
 * Markdown 描画の公開入口。
 * `renderInline` は markdown-it を含まないため、ページ側は `./inline` から直接読む。
 */
export { renderMarkdown } from './render';
export { renderInline } from './inline';
