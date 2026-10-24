/**
 * 吹き出しとミニガイドの短い補足を描画する小さな字句解析（`**強調**`・`*強調*`・`` `コード` ``）。
 * ページ側から読まれるため、markdown-it に依存しない。HTML を含め、それ以外はすべて文字列のまま表示する。
 * 強調は CommonMark の区切りの規則（前後が空白でない `*` だけが開き・閉じになる）に近づけて解析する。
 * innerHTML 系は使わず、`createElement` と `createTextNode` だけで組み立てる。
 */

/**
 * 強調の入れ子の上限。超える強調は要素にせず、記号を文字列のまま残す（`*a *b *c ...` を並べた入力で DOM を深くしない）。
 * markdown-it の入れ子の上限と同じ値にそろえる。
 */
const MAX_EMPHASIS_DEPTH = 100;

/** 解析結果の木。区切り（`*` の連続）は、対応が決まるまで delim として持つ。 */
type InlineNode =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'code'; readonly value: string }
  | { readonly kind: 'el'; readonly tag: 'strong' | 'em'; readonly children: InlineNode[]; readonly depth: number }
  | { readonly kind: 'group'; readonly children: InlineNode[]; readonly depth: number }
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

type Delim = Extract<InlineNode, { kind: 'delim' }>;

/** 解析中の節点の並び（双方向の連結リスト）。強調で囲むときに、配列のように詰め直さずに済ませる。 */
interface Cell {
  node: InlineNode;
  prev: Cell | null;
  next: Cell | null;
}

/** 区切りだけの連結リスト。開きを探すときに、文字列やコードを飛ばして区切りだけを辿る。 */
interface Entry {
  readonly cell: Cell;
  readonly delim: Delim;
  /** 出現順の番号。探索の下限（`openersBottom`）の比較に使う（途中で消されても比べられる）。 */
  readonly seq: number;
  prev: Entry | null;
  next: Entry | null;
}

/** 節点の中の強調の入れ子の深さ。 */
function depthOf(n: InlineNode): number {
  return n.kind === 'el' || n.kind === 'group' ? n.depth : 0;
}

/** 対応の決まらなかった区切りを文字列に戻す。 */
function settleNode(n: InlineNode): InlineNode {
  return n.kind === 'delim' ? { kind: 'text', value: '*'.repeat(n.count) } : n;
}

/** 開きとして使えるか（3の倍数の規則を含む）。 */
function matches(opener: Delim, closer: Delim): boolean {
  if (!opener.canOpen || opener.count === 0) return false;
  const bothSides = opener.canClose || closer.canOpen;
  return !(bothSides && (opener.original + closer.original) % 3 === 0 && !(opener.original % 3 === 0 && closer.original % 3 === 0));
}

/** 探索の下限を引く鍵。閉じの「開きにもなれるか」と元の長さの 3 での余りで、探す相手が決まる。 */
function bottomKey(closer: Delim): number {
  return (closer.canOpen ? 3 : 0) + (closer.original % 3);
}

/**
 * 区切りの対応を決め、強調（`em`・`strong`）の木にする。
 * CommonMark の区切りの手順どおり、開きが見つからなかった閉じは、その手前までを探索の下限（`openersBottom`）に記録する。
 * 同じ鍵の閉じは下限より手前を探さないので、手間は入力の長さにほぼ比例する。
 */
function resolveEmphasis(nodes: InlineNode[]): InlineNode[] {
  const head: Cell = { node: { kind: 'text', value: '' }, prev: null, next: null };
  let tail = head;
  const entries: Entry[] = [];
  for (const node of nodes) {
    const cell: Cell = { node, prev: tail, next: null };
    tail.next = cell;
    tail = cell;
    // 開きにも閉じにもなれない区切りは、対応に関わらないので区切りのリストに入れない
    if (node.kind === 'delim' && (node.canOpen || node.canClose)) {
      const entry: Entry = { cell, delim: node, seq: entries.length, prev: entries.at(-1) ?? null, next: null };
      const last = entries.at(-1);
      if (last) last.next = entry;
      entries.push(entry);
    }
  }

  const unlink = (e: Entry): void => {
    if (e.prev) e.prev.next = e.next;
    if (e.next) e.next.prev = e.prev;
  };
  const openersBottom = new Map<number, number>();

  let closerEntry: Entry | null = entries[0] ?? null;
  while (closerEntry !== null) {
    const closer: Delim = closerEntry.delim;
    if (!closer.canClose || closer.count === 0) {
      closerEntry = closerEntry.next;
      continue;
    }
    const key = bottomKey(closer);
    const bottom = openersBottom.get(key) ?? -1;
    let opener: Entry | null = closerEntry.prev;
    while (opener !== null && opener.seq > bottom && !matches(opener.delim, closer)) opener = opener.prev;
    if (opener === null || opener.seq <= bottom) {
      // 開きがなかった。次から同じ鍵の閉じは、ここより手前を探さない。閉じにしかなれない区切りは、以後は文字列として扱う
      openersBottom.set(key, closerEntry.prev?.seq ?? -1);
      const next: Entry | null = closerEntry.next;
      if (!closer.canOpen) unlink(closerEntry);
      closerEntry = next;
      continue;
    }

    const use = opener.delim.count >= 2 && closer.count >= 2 ? 2 : 1;
    // 開きと閉じの間にある節点を、対応の決まらなかった区切りを文字列に戻して、強調の中身にする
    const inner: InlineNode[] = [];
    let innerDepth = 0;
    for (let c = opener.cell.next; c !== null && c !== closerEntry.cell; c = c.next) {
      const settled = settleNode(c.node);
      inner.push(settled);
      innerDepth = Math.max(innerDepth, depthOf(settled));
    }
    opener.delim.count -= use;
    closer.count -= use;
    const marks = '*'.repeat(use);
    const wrapped: InlineNode =
      innerDepth < MAX_EMPHASIS_DEPTH
        ? { kind: 'el', tag: use === 2 ? 'strong' : 'em', children: inner, depth: innerDepth + 1 }
        : {
            kind: 'group',
            children: [{ kind: 'text', value: marks }, ...inner, { kind: 'text', value: marks }],
            depth: innerDepth,
          };
    const el: Cell = { node: wrapped, prev: opener.cell, next: closerEntry.cell };
    opener.cell.next = el;
    closerEntry.cell.prev = el;
    // 間にあった区切りは使えなくなる
    opener.next = closerEntry;
    closerEntry.prev = opener;
    if (opener.delim.count === 0) unlink(opener);
    if (closer.count === 0) {
      const next: Entry | null = closerEntry.next;
      unlink(closerEntry);
      closerEntry = next;
    }
  }

  const result: InlineNode[] = [];
  for (let c = head.next; c !== null; c = c.next) result.push(settleNode(c.node));
  return result;
}

/**
 * 木を DOM にして `parent` に追加する。入れ子が深くても呼び出しの深さが増えないよう、自前の積み方で辿る。
 * 隣り合う文字列は1つの Text にまとめる（対応のなかった `*` が多数並んでも節点が増えない）。
 */
function build(nodes: readonly InlineNode[], parent: Node): void {
  interface Frame {
    readonly nodes: readonly InlineNode[];
    index: number;
    readonly parent: Node;
    readonly pending: string[];
  }
  const flush = (frame: Frame): void => {
    if (frame.pending.length === 0) return;
    frame.parent.appendChild(document.createTextNode(frame.pending.join('')));
    frame.pending.length = 0;
  };
  const stack: Frame[] = [{ nodes, index: 0, parent, pending: [] }];
  for (let frame = stack.at(-1); frame !== undefined; frame = stack.at(-1)) {
    const n = frame.nodes[frame.index];
    if (n === undefined) {
      flush(frame);
      stack.pop();
      continue;
    }
    frame.index += 1;
    if (n.kind === 'text') {
      frame.pending.push(n.value);
      continue;
    }
    flush(frame);
    if (n.kind === 'code') {
      const code = document.createElement('code');
      code.textContent = n.value;
      frame.parent.appendChild(code);
    } else if (n.kind === 'el') {
      const el = document.createElement(n.tag);
      frame.parent.appendChild(el);
      stack.push({ nodes: n.children, index: 0, parent: el, pending: [] });
    } else if (n.kind === 'group') {
      stack.push({ nodes: n.children, index: 0, parent: frame.parent, pending: [] });
    }
  }
}

/** `container` の中身を、`src` を描画した結果に置き換える。 */
export function renderInline(src: string, container: HTMLElement): void {
  container.replaceChildren();
  build(resolveEmphasis(tokenize(src)), container);
}
