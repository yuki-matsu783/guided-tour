/**
 * 吹き出しとミニガイドの短い補足を描画する小さな字句解析（`**強調**`・`*強調*`・`` `コード` ``）。
 * ページ側から読まれるため、markdown-it に依存しない。HTML を含め、それ以外はすべて文字列のまま表示する。
 * innerHTML 系は使わず、`createElement` と `createTextNode` だけで組み立てる。
 */

/** 閉じ記号を探す。見つからない・中身が空のときは -1。 */
function findClose(src: string, marker: string, from: number): number {
  const end = src.indexOf(marker, from);
  return end > from ? end : -1;
}

/** `src` を解析して `parent` に追加する。閉じていない記号は文字列として扱う。 */
function append(src: string, parent: Node): void {
  let text = '';
  const flush = (): void => {
    if (text !== '') parent.appendChild(document.createTextNode(text));
    text = '';
  };

  let i = 0;
  while (i < src.length) {
    const ch = src.charAt(i);
    if (ch === '`') {
      const end = findClose(src, '`', i + 1);
      if (end !== -1) {
        flush();
        const code = document.createElement('code');
        code.textContent = src.slice(i + 1, end);
        parent.appendChild(code);
        i = end + 1;
        continue;
      }
    } else if (ch === '*') {
      const marker = src.startsWith('**', i) ? '**' : '*';
      const end = findClose(src, marker, i + marker.length);
      if (end !== -1) {
        flush();
        const el = document.createElement(marker === '**' ? 'strong' : 'em');
        append(src.slice(i + marker.length, end), el);
        parent.appendChild(el);
        i = end + marker.length;
        continue;
      }
    }
    text += ch;
    i += 1;
  }
  flush();
}

/** `container` の中身を、`src` を描画した結果に置き換える。 */
export function renderInline(src: string, container: HTMLElement): void {
  container.replaceChildren();
  append(src, container);
}
