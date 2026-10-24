/**
 * 吹き出しとミニガイドの短い補足を描画する小さな字句解析（`**強調**`・`*強調*`・`` `コード` ``）。
 * ページ側から読まれるため、markdown-it に依存しない。HTML を含め、それ以外はすべて文字列のまま表示する。
 * 強調は CommonMark の区切りの規則（前後が空白でない `*` だけが開き・閉じになる）に近づけて解析する。
 * innerHTML 系は使わず、`createElement` と `createTextNode` だけで組み立てる。
 */

/** 解析結果の木。区切り（`*` の連続）は、対応が決まるまで delim として持つ。 */
type InlineNode =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'code'; readonly value: string }
  | { readonly kind: 'el'; readonly tag: 'strong' | 'em'; readonly children: InlineNode[] }
  | { kind: 'delim'; count: number; readonly original: number; readonly canOpen: boolean; readonly canClose: boolean };

const WHITESPACE = /\s/u;
const PUNCTUATION = /[\p{P}\p{S}]/u;

/** 文字列の端は空白として扱う。 */
function isSpace(ch: string): boolean {
  return ch === '' || WHITESPACE.test(ch);
}

function isPunct(ch: string): boolean {
  return ch !== '' && PUNCTUATION.test(ch);
}

/** `*` の連続が、開き・閉じになれるか（left-/right-flanking）。 */
function flanking(before: string, after: string): { canOpen: boolean; canClose: boolean } {
  const left = !isSpace(after) && (!isPunct(after) || isSpace(before) || isPunct(before));
  const right = !isSpace(before) && (!isPunct(before) || isSpace(after) || isPunct(after));
  return { canOpen: left, canClose: right };
}

/** 閉じ記号を探す。見つからない・中身が空のときは -1。 */
function findClose(src: string, marker: string, from: number): number {
  const end = src.indexOf(marker, from);
  return end > from ? end : -1;
}

/** コードと `*` の連続に分ける。それ以外は文字列。 */
function tokenize(src: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let text = '';
  const flush = (): void => {
    if (text !== '') nodes.push({ kind: 'text', value: text });
    text = '';
  };
  let i = 0;
  while (i < src.length) {
    const ch = src.charAt(i);
    if (ch === '`') {
      const end = findClose(src, '`', i + 1);
      if (end !== -1) {
        flush();
        nodes.push({ kind: 'code', value: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    } else if (ch === '*') {
      let j = i;
      while (src.charAt(j) === '*') j += 1;
      flush();
      const { canOpen, canClose } = flanking(src.charAt(i - 1), src.charAt(j));
      nodes.push({ kind: 'delim', count: j - i, original: j - i, canOpen, canClose });
      i = j;
      continue;
    }
    text += ch;
    i += 1;
  }
  flush();
  return nodes;
}

/** 対応の決まらなかった区切りを文字列に戻す。 */
function settle(nodes: readonly InlineNode[]): InlineNode[] {
  return nodes.map((n) => (n.kind === 'delim' ? { kind: 'text', value: '*'.repeat(n.count) } : n));
}

/** 閉じの区切りに対応する開きを、手前から探す（3の倍数の規則を含む）。 */
function findOpener(nodes: readonly InlineNode[], closerIndex: number, closer: Extract<InlineNode, { kind: 'delim' }>): number {
  for (let j = closerIndex - 1; j >= 0; j -= 1) {
    const o = nodes[j];
    if (o?.kind !== 'delim' || !o.canOpen || o.count === 0) continue;
    const bothSides = o.canClose || closer.canOpen;
    if (bothSides && (o.original + closer.original) % 3 === 0 && !(o.original % 3 === 0 && closer.original % 3 === 0)) {
      continue;
    }
    return j;
  }
  return -1;
}

/** 区切りの対応を決め、強調（`em`・`strong`）の木にする。 */
function resolveEmphasis(nodes: InlineNode[]): InlineNode[] {
  let i = 0;
  while (i < nodes.length) {
    const closer = nodes[i];
    if (closer?.kind !== 'delim' || !closer.canClose || closer.count === 0) {
      i += 1;
      continue;
    }
    const openerIndex = findOpener(nodes, i, closer);
    const opener = nodes[openerIndex];
    if (opener?.kind !== 'delim') {
      i += 1;
      continue;
    }
    const use = opener.count >= 2 && closer.count >= 2 ? 2 : 1;
    const inner = settle(nodes.slice(openerIndex + 1, i));
    opener.count -= use;
    closer.count -= use;
    const el: InlineNode = { kind: 'el', tag: use === 2 ? 'strong' : 'em', children: inner };
    nodes.splice(openerIndex + 1, i - openerIndex - 1, el);
    i = openerIndex + 2;
  }
  return settle(nodes);
}

/** 木を DOM にして `parent` に追加する。 */
function build(nodes: readonly InlineNode[], parent: Node): void {
  for (const n of nodes) {
    if (n.kind === 'text') {
      parent.appendChild(document.createTextNode(n.value));
    } else if (n.kind === 'code') {
      const code = document.createElement('code');
      code.textContent = n.value;
      parent.appendChild(code);
    } else if (n.kind === 'el') {
      const el = document.createElement(n.tag);
      build(n.children, el);
      parent.appendChild(el);
    }
  }
}

/** `container` の中身を、`src` を描画した結果に置き換える。 */
export function renderInline(src: string, container: HTMLElement): void {
  container.replaceChildren();
  build(resolveEmphasis(tokenize(src)), container);
}
