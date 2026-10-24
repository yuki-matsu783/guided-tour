/**
 * zip のエントリ名の検査と、パッケージ内のパスの正規化。
 * 入力は文字列だけ。問題があれば日本語の理由を返す（入力の値はメッセージに含めない）。
 */

/** 区切り文字に見せかけられる文字（円記号・ウォン記号・全角スラッシュなど）。 */
const LOOKALIKE_SEPARATORS = ['¥', '₩', '／', '＼', '∕', '⁄'];

/** パスに使えない文字を含むか。理由を返す。含まなければ null。 */
export function forbiddenCharProblem(text: string): string | null {
  if (text.includes('\0')) return 'NUL 文字は使えません';
  if (text.includes('\\')) return '\\ は使えません。区切りは / だけです';
  if (LOOKALIKE_SEPARATORS.some((c) => text.includes(c))) {
    return '区切り文字に似た文字（¥ ／ ＼ など）は使えません';
  }
  return null;
}

/**
 * エントリ名1つを検査する。ディレクトリのエントリ（末尾が `/`）は、末尾の `/` を除いて同じ規則で見る。
 * 拒否するもの: 空、NUL・`\`・区切りに似た文字、絶対パス、ドライブ名、空の区間、`.`・`..` の区間。
 */
export function checkEntryName(rawName: string): string | null {
  if (rawName === '') return 'ファイル名が空です';
  const chars = forbiddenCharProblem(rawName);
  if (chars !== null) return `ファイル名: ${chars}`;
  const name = rawName.endsWith('/') ? rawName.slice(0, -1) : rawName;
  if (name.startsWith('/')) return 'ファイル名に絶対パスは使えません';
  if (/^[A-Za-z]:/.test(name)) return 'ファイル名にドライブ名は使えません';
  for (const segment of name.split('/')) {
    if (segment === '') return 'ファイル名に空の区間（// など）は使えません';
    if (segment === '..') return 'ファイル名に .. は使えません';
    if (segment === '.') return 'ファイル名に . の区間は使えません';
  }
  return null;
}

/** パスを NFC にそろえる（macOS の分解形のファイル名と、YAML に書いた形を一致させる）。 */
export function normalizePath(path: string): string {
  return path.normalize('NFC');
}

/** 重複の判定に使う鍵。大文字・小文字と、Unicode の正規形の違いを無視する。 */
export function duplicateKey(name: string): string {
  const trimmed = name.endsWith('/') ? name.slice(0, -1) : name;
  return trimmed.normalize('NFKC').toLowerCase();
}

/** 表示用に、制御文字を除いて長さを切る。 */
export function displayName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, '?');
  return clean.length > 100 ? `${clean.slice(0, 100)}…` : clean;
}
