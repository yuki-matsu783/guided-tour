/**
 * パッケージ内の参照（`bodyFile`・`media.src`・Markdown 内の画像）を、参照元ファイルの場所を起点に解決する。
 * 入力は参照元のパスと参照の文字列。パッケージの外に出るもの・絶対パス・外部の指定は理由つきで失敗にする。
 */
import { forbiddenCharProblem, normalizePath } from './entry-name.ts';

export type ResolveResult = { ok: true; path: string } | { ok: false; message: string };

/** `http:`・`c:` のようなスキーム（ドライブ名を含む）で始まるか。 */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** パスの最後の区間の拡張子（小文字）。なければ空文字。 */
export function extensionOf(path: string): string {
  const last = path.split('/').at(-1) ?? '';
  const dot = last.lastIndexOf('.');
  return dot <= 0 ? '' : last.slice(dot + 1).toLowerCase();
}

/**
 * `baseFile`（パッケージ内のパス。例: `steps/a.md`）のあるディレクトリを起点に `ref` を解決する。
 * 結果は NFC にそろえた、`/` 区切りで `.`・`..` を含まないパス。
 */
export function resolveRelative(baseFile: string, ref: string): ResolveResult {
  if (ref === '') return { ok: false, message: '参照先が空です' };
  if (ref.startsWith('//') || SCHEME.test(ref)) {
    return {
      ok: false,
      message: 'URL や外部のファイルは参照できません。パッケージ内の相対パスで書いてください',
    };
  }
  const chars = forbiddenCharProblem(ref);
  if (chars !== null) return { ok: false, message: `参照先のパス: ${chars}` };
  if (ref.startsWith('/')) {
    return { ok: false, message: '絶対パスは使えません。参照元からの相対パスで書いてください' };
  }
  const stack = baseFile.split('/').slice(0, -1);
  for (const segment of ref.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (stack.length === 0) {
        return { ok: false, message: '参照先がパッケージの外を指しています' };
      }
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  if (stack.length === 0) return { ok: false, message: '参照先のファイルが指定されていません' };
  return { ok: true, path: normalizePath(stack.join('/')) };
}
