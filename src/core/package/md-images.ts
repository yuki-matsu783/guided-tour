/**
 * Markdown の中の画像参照を取り出す。markdown-it（html: false）で解析し、画像のトークンを集める。
 * `src` は markdown-it が整えた形（非 ASCII はパーセントエンコード済み）のまま返す。
 * markdown-it は `javascript:`・`data:image/svg+xml`・`file:` などの URL を危険として画像にせず、ただの文字列に戻す。
 * 検査を通り抜けないよう、そうした文字列の中の `![...](...)` を字句で拾い、`rejected` を立てて返す
 * （コードの中の記法は文字列ではないので拾わない）。
 */
import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: false, linkify: false });

export interface MarkdownImage {
  src: string;
  alt: string;
  /** 画像を含む段落の先頭の行（1 始まり） */
  line: number;
  /** markdown-it が画像として受け付けなかった記法。使えない参照としてエラーにする。 */
  rejected: boolean;
}

/** 文字列に残った画像の記法。URL の中の括弧は、閉じるものまでを拾えれば足りる。 */
const IMAGE_SYNTAX = /!\[([^\]]*)\]\(([^)]*)\)/g;

export function extractMarkdownImages(markdown: string): MarkdownImage[] {
  const found: MarkdownImage[] = [];
  for (const block of md.parse(markdown, {})) {
    if (block.type !== 'inline' || !block.children) continue;
    const line = (block.map?.[0] ?? 0) + 1;
    for (const token of block.children) {
      if (token.type === 'text') {
        for (const match of token.content.matchAll(IMAGE_SYNTAX)) {
          found.push({ src: (match[2] ?? '').trim(), alt: (match[1] ?? '').trim(), line, rejected: true });
        }
        continue;
      }
      if (token.type !== 'image') continue;
      const src = token.attrGet('src');
      found.push({ src: typeof src === 'string' ? src : '', alt: token.content.trim(), line, rejected: false });
    }
  }
  return found;
}
