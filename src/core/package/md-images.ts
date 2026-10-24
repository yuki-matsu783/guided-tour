/**
 * Markdown の中の画像参照を取り出す。markdown-it（html: false）で解析し、画像のトークンを集める。
 * `src` は markdown-it が整えた形（非 ASCII はパーセントエンコード済み）のまま返す。
 * markdown-it は `javascript:`・`data:image/svg+xml`・`file:` などの URL を危険として画像にせず、ただの文字列に戻す。
 * 検査を通り抜けないよう、そうした文字列の中の `![...](...)` を字句で拾い、`rejected` を立てて返す
 * （コードの中の記法は文字列ではないので拾わない）。
 * 文字列の中の記法は、入力の長さに比例する手間の走査で拾う（`![` を多数並べた入力で手間が増えないようにする）。
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

/**
 * `from` 以降で最初の `ch` の位置を返す関数。`from` は呼ぶたびに増えることを前提に、見つかった位置を覚えて、
 * その位置より手前から探すときは探し直さない（見つからない結果も覚える）。
 */
function monotonicFinder(text: string, ch: string): (from: number) => number {
  let cached = -2;
  return (from) => {
    if (cached === -1) return -1;
    if (cached < from) cached = text.indexOf(ch, from);
    return cached;
  };
}

/**
 * 文字列に残った画像の記法 `![alt](src)` を、先頭から順に拾う。alt に `]`、src に `)` は含められない
 * （URL の中の括弧は、閉じるものまでを拾えれば足りる）。重ならない最も左の一致を採る。
 */
export function findImageSyntax(text: string): { alt: string; src: string }[] {
  const found: { alt: string; src: string }[] = [];
  const nextClose = monotonicFinder(text, ']');
  const nextParen = monotonicFinder(text, ')');
  let at = text.indexOf('![');
  while (at !== -1) {
    const close = nextClose(at + 2);
    // `]` がもう無ければ、これより後ろにも一致はない
    if (close === -1) break;
    if (text.charAt(close + 1) === '(') {
      const end = nextParen(close + 2);
      if (end === -1) break;
      found.push({ alt: text.slice(at + 2, close), src: text.slice(close + 2, end) });
      at = text.indexOf('![', end + 1);
    } else {
      at = text.indexOf('![', at + 1);
    }
  }
  return found;
}

/**
 * Markdown の画像の参照 `src`（`extractMarkdownImages` が返す、パーセントエンコード済みの形）を、パッケージ内のパスの形に戻す。
 * 取り込み（検査と保存）・表示の組み立て・`renderMarkdown` が使うパスは、すべてこの形（decodeURIComponent した文字列）にそろえる。
 * 戻せない（不正な `%`）ときは null。
 */
export function decodeImagePath(src: string): string | null {
  try {
    return decodeURIComponent(src);
  } catch {
    return null;
  }
}

export function extractMarkdownImages(markdown: string): MarkdownImage[] {
  const found: MarkdownImage[] = [];
  for (const block of md.parse(markdown, {})) {
    if (block.type !== 'inline' || !block.children) continue;
    const line = (block.map?.[0] ?? 0) + 1;
    for (const token of block.children) {
      if (token.type === 'text') {
        for (const syntax of findImageSyntax(token.content)) {
          found.push({ src: syntax.src.trim(), alt: syntax.alt.trim(), line, rejected: true });
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
