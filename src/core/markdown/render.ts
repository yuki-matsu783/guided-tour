/**
 * Markdown を、許可リストに沿った DOM に描画する（サイドパネル用）。
 * markdown-it（html: false・linkify: false）のトークンから `createElement` で組み立てる。
 * innerHTML 系は使わない。許可リストにないものは、内容を文字列として表示する。
 * 画像の URL の解決は呼び出し側（`resolveAsset`）に任せ、ここでは結果の方式だけを検査する。
 */
import MarkdownIt from 'markdown-it';
import type { Token } from 'markdown-it';
import { isAllowedImageUrl, parseHttpLink, toHostnameSet } from './urls';

/** 入れ子の上限（markdown-it の既定と同じ）。 */
const MAX_NESTING = 100;

/** 入れ子を作るブロックの規則と、1回開くときに増える入れ子の段数（リストは list と item の2段）。 */
const CONTAINER_RULE_COST: Readonly<Record<string, number>> = { blockquote: 1, list: 2 };

const md = new MarkdownIt({ html: false, linkify: false, maxNesting: MAX_NESTING });

/**
 * markdown-it は入れ子の上限を超えると、残りの本文を黙って捨てる。
 * 上限に届く位置では引用・リストを開かない規則にして、超えた分は段落（文字列）として出す。
 */
function keepTextBeyondNesting(parser: InstanceType<typeof MarkdownIt>): void {
  for (const rule of Array.from(parser.block.ruler.__rules__)) {
    const cost = CONTAINER_RULE_COST[rule.name];
    if (cost === undefined) continue;
    const original = rule.fn;
    parser.block.ruler.at(
      rule.name,
      (state, startLine, endLine, silent) =>
        state.level + cost >= MAX_NESTING ? false : original(state, startLine, endLine, silent),
      { alt: rule.alt },
    );
  }
}
keepTextBeyondNesting(md);

/** 要素にそのまま対応させるトークンの種類（開き側）。 */
const SIMPLE_TAGS: Readonly<Record<string, string>> = {
  paragraph_open: 'p',
  strong_open: 'strong',
  em_open: 'em',
  bullet_list_open: 'ul',
  ordered_list_open: 'ol',
  list_item_open: 'li',
  blockquote_open: 'blockquote',
  table_open: 'table',
  thead_open: 'thead',
  tbody_open: 'tbody',
  tr_open: 'tr',
};

/** 見出しは h1〜h4 を 1 段下げて h2〜h5 にする。それより深いものは段落。 */
const MAX_HEADING_LEVEL = 4;

const ALIGN_CLASSES: Readonly<Record<string, string>> = {
  left: 'md-align-left',
  center: 'md-align-center',
  right: 'md-align-right',
};

interface Frame {
  /** 子を追加する先。許可リスト外の要素は親をそのまま使う。 */
  readonly node: Node;
  /** 閉じるときに親へ追加する後続のテキスト（リンクのホスト名など）。 */
  readonly after: string | null;
}

interface Context {
  readonly resolveAsset: (src: string) => string | null;
  readonly hosts: ReadonlySet<string>;
}

/**
 * `src` を Markdown として解析し、`container` の中身を置き換える。
 *
 * @param resolveAsset 画像の相対パスなどを表示できる URL に変える。null は解決失敗（代替文を表示）。
 * @param origins ツアーが宣言したオリジン。リンク先のホスト名がなければ「宣言外のサイト」と示す。
 */
export function renderMarkdown(
  src: string,
  container: HTMLElement,
  resolveAsset: (src: string) => string | null,
  origins: string[],
): void {
  container.replaceChildren();
  const tokens = md.parse(src, {});
  const ctx: Context = { resolveAsset, hosts: toHostnameSet(origins) };
  renderTokens(tokens, container, ctx);
}

/** トークン列を `root` の下へ組み立てる。インラインの子トークンも同じ規則で処理する。 */
function renderTokens(tokens: readonly Token[], root: Node, ctx: Context): void {
  const stack: Frame[] = [];
  const current = (): Node => stack[stack.length - 1]?.node ?? root;

  for (const token of tokens) {
    if (token.nesting === 1) {
      stack.push(open(token, current(), ctx));
    } else if (token.nesting === -1) {
      const frame = stack.pop();
      if (frame?.after != null) current().appendChild(document.createTextNode(frame.after));
    } else {
      leaf(token, current(), ctx);
    }
  }
}

/** 開きトークンを処理して、子の追加先を返す。 */
function open(token: Token, parent: Node, ctx: Context): Frame {
  if (token.hidden) return { node: parent, after: null };

  const tag = elementFor(token);
  if (tag !== null) {
    const el = attach(parent, document.createElement(tag));
    // 番号付きリストの開始番号。数字だけのときに限る
    const start = tag === 'ol' ? attr(token, 'start') : null;
    if (start !== null && /^\d{1,9}$/u.test(start)) el.setAttribute('start', start);
    return { node: el, after: null };
  }

  if (token.type === 'th_open' || token.type === 'td_open') {
    const cell = attach(parent, document.createElement(token.type === 'th_open' ? 'th' : 'td'));
    const align = alignClass(token);
    if (align !== null) cell.className = align;
    return { node: cell, after: null };
  }
  if (token.type === 'link_open') return openLink(token, parent, ctx);

  // 許可リストにないもの（取り消し線など）は、内容だけを親へそのまま出す。
  return { node: parent, after: null };
}

/** 開きトークンに対応する要素名。許可リストにないものは null。 */
function elementFor(token: Token): string | null {
  const simple = SIMPLE_TAGS[token.type];
  if (simple !== undefined) return simple;
  if (token.type === 'heading_open') {
    const level = Number(token.tag.slice(1));
    return level >= 1 && level <= MAX_HEADING_LEVEL ? `h${String(level + 1)}` : 'p';
  }
  return null;
}

/** 属性を文字列として取り出す（markdown-it は数値も返し得る）。 */
function attr(token: Token, name: string): string | null {
  const value = token.attrGet(name);
  return value === null ? null : String(value);
}

function attach<T extends Node>(parent: Node, child: T): T {
  parent.appendChild(child);
  return child;
}

/** 表のセルの揃えを、クラス名に変える（markdown-it は style 属性で渡す）。 */
function alignClass(token: Token): string | null {
  const style = attr(token, 'style');
  if (style === null) return null;
  const match = /text-align:\s*(left|center|right)/.exec(style);
  const key = match?.[1];
  return key === undefined ? null : (ALIGN_CLASSES[key] ?? null);
}

/** http / https のリンクだけを `a` にする。それ以外は文字列として表示する。 */
function openLink(token: Token, parent: Node, ctx: Context): Frame {
  const href = attr(token, 'href') ?? '';
  const parsed = parseHttpLink(href);
  if (parsed === null) return { node: parent, after: ` (${href})` };

  const a = attach(parent, document.createElement('a'));
  a.setAttribute('href', href);
  a.setAttribute('target', '_blank');
  a.setAttribute('rel', 'noopener noreferrer');
  const declared = ctx.hosts.has(parsed.hostname);
  return {
    node: a,
    after: declared ? ` (${parsed.hostname})` : ` (${parsed.hostname}；宣言外のサイト)`,
  };
}

/** 子を持たないトークン（テキスト・コード・改行・画像・水平線）を処理する。 */
function leaf(token: Token, parent: Node, ctx: Context): void {
  switch (token.type) {
    case 'text':
      parent.appendChild(document.createTextNode(token.content));
      return;
    case 'softbreak':
      parent.appendChild(document.createTextNode('\n'));
      return;
    case 'hardbreak':
      parent.appendChild(document.createElement('br'));
      return;
    case 'hr':
      parent.appendChild(document.createElement('hr'));
      return;
    case 'code_inline': {
      const code = attach(parent, document.createElement('code'));
      code.textContent = token.content;
      return;
    }
    case 'fence':
    case 'code_block': {
      const pre = attach(parent, document.createElement('pre'));
      attach(pre, document.createElement('code')).textContent = token.content;
      return;
    }
    case 'inline':
      renderTokens(token.children ?? [], parent, ctx);
      return;
    case 'image':
      renderImage(token, parent, ctx);
      return;
    default:
      // 未知のトークンは内容だけを文字列で表示する。
      if (token.content !== '') parent.appendChild(document.createTextNode(token.content));
  }
}

/** 子トークンの文字列だけを連ねた平文（`**` などの記法を残さない）。 */
function plainText(tokens: readonly Token[]): string {
  let text = '';
  for (const token of tokens) {
    if (token.type === 'text' || token.type === 'code_inline') text += token.content;
    else if (token.type === 'softbreak' || token.type === 'hardbreak') text += '\n';
    else if (token.type === 'image') text += plainText(token.children ?? []);
  }
  return text;
}

/**
 * 画像のパスを decodeURIComponent で戻す（取り込みは同じ関数で戻したパスで保存している。`img%2Fa.png` は `img/a.png`）。
 * 戻せない（不正な %）ときは null。
 */
function decodePath(src: string): string | null {
  try {
    return decodeURIComponent(src);
  } catch {
    return null;
  }
}

/** 画像を `img` にする。解決できない・許可されない URL・読み込み失敗のときは代替文を表示する。 */
function renderImage(token: Token, parent: Node, ctx: Context): void {
  const alt = plainText(token.children ?? []);
  const path = decodePath(attr(token, 'src') ?? '');
  const resolved = path === null ? null : ctx.resolveAsset(path);
  if (resolved === null || !isAllowedImageUrl(resolved)) {
    parent.appendChild(document.createTextNode(alt));
    return;
  }
  const img = attach(parent, document.createElement('img'));
  img.setAttribute('src', resolved);
  img.setAttribute('alt', alt);
  img.addEventListener('error', () => {
    img.replaceWith(document.createTextNode(alt));
  });
}
