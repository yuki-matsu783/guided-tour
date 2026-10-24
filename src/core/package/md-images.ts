/**
 * Markdown の中の画像参照を取り出す。markdown-it（html: false）で解析し、画像のトークンだけを集める。
 * `src` は markdown-it が整えた形（非 ASCII はパーセントエンコード済み）のまま返す。
 */
import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: false, linkify: false });

export interface MarkdownImage {
  src: string;
  alt: string;
  /** 画像を含む段落の先頭の行（1 始まり） */
  line: number;
}

export function extractMarkdownImages(markdown: string): MarkdownImage[] {
  const found: MarkdownImage[] = [];
  for (const block of md.parse(markdown, {})) {
    if (block.type !== 'inline' || !block.children) continue;
    const line = (block.map?.[0] ?? 0) + 1;
    for (const token of block.children) {
      if (token.type !== 'image') continue;
      const src = token.attrGet('src');
      found.push({ src: typeof src === 'string' ? src : '', alt: token.content.trim(), line });
    }
  }
  return found;
}
