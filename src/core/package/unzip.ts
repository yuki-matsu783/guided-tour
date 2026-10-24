/**
 * zip の逐次展開。実際に展開したバイト数で数え、上限を超えた時点で打ち切る。
 * 入力は zip のバイト列とファイル名。出力は、エントリ名（ディレクトリを除く）からバイト列への対応表、またはエラー。
 *
 * 処理フロー:
 * 1. 中央ディレクトリを読み、シンボリックリンクの名前とファイル数を先に調べる（宣言サイズは使わない）。
 *    件数が 0・zip64 など読み切れない形や、項目の総数が上限を超える形は拒否する
 * 2. 圧縮側を 4 KB ずつ fflate の Unzip に渡す。ローカルヘッダーが出るたびに、中央ディレクトリにある名前か、
 *    項目の総数、名前・重複・ファイル数を検査する。終わったら、中央ディレクトリの項目がすべて出たかを確かめる
 * 3. 展開結果を受け取るたびに合計を確かめ、50 MB を超えたら以降を渡さずに打ち切る
 * 4. 一定時間ごとに await で処理を譲り、画面を長く占有しない
 */
import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate';
import type { Issue } from '../tour/index.ts';
import { concatBytes, u16le, u32le } from './bytes.ts';
import type { Bytes } from './bytes.ts';
import { checkEntryName, displayName, duplicateKey, normalizePath } from './entry-name.ts';
import { formatBytesLimit, PACKAGE_LIMITS } from './limits.ts';

export type UnzipResult =
  | { ok: true; entries: Map<string, Bytes> }
  | { ok: false; errors: Issue[] };

export interface UnzipOptions {
  /** 処理を譲る方法。既定は setTimeout(0)。 */
  yieldToHost?: () => Promise<void>;
  /** この時間（ミリ秒）以上続けて処理したら譲る。0 なら圧縮側の区切りごとに譲る。 */
  sliceMs?: number;
}

const DEFAULT_SLICE_MS = 8;

function defaultYield(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

// ---- 中央ディレクトリ ----

interface CentralInfo {
  /** シンボリックリンクのエントリ名 */
  symlinks: Set<string>;
  /** ディレクトリを含む、すべてのエントリ名（中央ディレクトリの並び順） */
  names: string[];
  /** ディレクトリを除くエントリの数 */
  fileCount: number;
}

/** 読めない（zip ではない・壊れている）か、信頼できない形（検査の根拠にできない）か。 */
type CentralResult = { kind: 'ok'; info: CentralInfo } | { kind: 'unreadable' } | { kind: 'untrusted' };

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_MIN = 22;
const UNIX = 3;
const S_IFMT = 0xf000;
const S_IFLNK = 0xa000;

function decodeName(raw: Uint8Array, utf8: boolean): string {
  if (utf8) return new TextDecoder('utf-8').decode(raw);
  let out = '';
  for (const byte of raw) out += String.fromCharCode(byte);
  return out;
}

/**
 * 中央ディレクトリを読む。シンボリックリンクと名前の検査の根拠にするので、件数が 0 や zip64（0xffff など）の
 * ように読み切れない形は、信頼できないものとして扱う。
 */
function readCentralDirectory(data: Uint8Array): CentralResult {
  if (data.length < EOCD_MIN) return { kind: 'unreadable' };
  let eocd = -1;
  const lowest = Math.max(0, data.length - EOCD_MIN - 0xffff);
  for (let i = data.length - EOCD_MIN; i >= lowest; i--) {
    if (u32le(data, i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return { kind: 'unreadable' };
  const total = u16le(data, eocd + 10);
  const size = u32le(data, eocd + 12);
  const offset = u32le(data, eocd + 16);
  if (total === 0 || total === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    return { kind: 'untrusted' };
  }
  if (total > PACKAGE_LIMITS.entryCount) return { kind: 'untrusted' };
  if (offset + size > data.length) return { kind: 'unreadable' };
  const symlinks = new Set<string>();
  const names: string[] = [];
  let fileCount = 0;
  let pos = offset;
  for (let i = 0; i < total; i++) {
    if (pos + 46 > data.length || u32le(data, pos) !== CENTRAL_SIGNATURE) return { kind: 'unreadable' };
    const madeBy = u16le(data, pos + 4);
    const flags = u16le(data, pos + 8);
    const nameLength = u16le(data, pos + 28);
    const extraLength = u16le(data, pos + 30);
    const commentLength = u16le(data, pos + 32);
    const attributes = u32le(data, pos + 38);
    const end = pos + 46 + nameLength + extraLength + commentLength;
    if (end > data.length) return { kind: 'unreadable' };
    const name = decodeName(data.subarray(pos + 46, pos + 46 + nameLength), (flags & 0x800) !== 0);
    names.push(name);
    if (!name.endsWith('/')) fileCount++;
    if (madeBy >>> 8 === UNIX && ((attributes >>> 16) & S_IFMT) === S_IFLNK) symlinks.add(name);
    pos = end;
  }
  return { kind: 'ok', info: { symlinks, names, fileCount } };
}

// ---- 展開 ----

export async function unzipPackage(
  data: Uint8Array,
  fileName: string,
  options: UnzipOptions = {},
): Promise<UnzipResult> {
  const issue = (path: string, message: string): Issue => ({ file: fileName, line: null, path, message });
  const countMessage = `パッケージ内のファイル数が上限（${String(PACKAGE_LIMITS.fileCount)} 個）を超えています`;
  const entriesMessage = `zip の項目の総数が上限（${PACKAGE_LIMITS.entryCount.toLocaleString('en-US')} 個）を超えているため、展開を打ち切りました`;
  const untrustedMessage = `zip の中央ディレクトリを信頼できません（項目が無い・zip64・総数が上限（${PACKAGE_LIMITS.entryCount.toLocaleString('en-US')} 個）を超えている、のいずれかです）`;
  const expandedMessage = `展開後の合計サイズが上限（${formatBytesLimit(PACKAGE_LIMITS.expandedBytes)}）を超えたため、展開を打ち切りました`;

  const result = readCentralDirectory(data);
  if (result.kind === 'unreadable') {
    return { ok: false, errors: [issue('', 'zip として読めません。壊れているか、zip ではないファイルです')] };
  }
  if (result.kind === 'untrusted') {
    return { ok: false, errors: [issue('', untrustedMessage)] };
  }
  const central = result.info;
  if (central.fileCount > PACKAGE_LIMITS.fileCount) {
    return { ok: false, errors: [issue('', countMessage)] };
  }

  const entries = new Map<string, Bytes>();
  const errors: Issue[] = [];
  const seen = new Set<string>();
  let fileCount = 0;
  let expanded = 0;
  /** ローカルヘッダーで出会った項目の数。 */
  let entryCount = 0;
  /** 中央ディレクトリの名前ごとの、まだ出会っていない数。 */
  const unmatched = new Map<string, number>();
  for (const name of central.names) unmatched.set(name, (unmatched.get(name) ?? 0) + 1);
  /** 上限を超えた・展開に失敗した。以降は何も受け取らない。 */
  const stop: { issue: Issue | null } = { issue: null };

  const unzip = new Unzip((file) => {
    if (stop.issue) return;
    entryCount++;
    if (entryCount > PACKAGE_LIMITS.entryCount) {
      stop.issue = issue('', entriesMessage);
      return;
    }
    const name = file.name;
    const shown = displayName(name);
    const remaining = unmatched.get(name) ?? 0;
    if (remaining === 0) {
      errors.push(issue(shown, '中央ディレクトリにない項目があります。zip の構造が正しくありません'));
      return;
    }
    unmatched.set(name, remaining - 1);
    const problem = checkEntryName(name);
    if (problem !== null) {
      errors.push(issue(shown, problem));
      return;
    }
    if (central.symlinks.has(name)) {
      errors.push(issue(shown, 'シンボリックリンクは使えません'));
      return;
    }
    const key = duplicateKey(name);
    if (seen.has(key)) {
      errors.push(issue(shown, '同じ名前のファイルが複数あります（大文字・小文字の違いだけのものを含みます）'));
      return;
    }
    seen.add(key);
    // ディレクトリのエントリは無視し、ファイル数にも数えない
    if (name.endsWith('/')) return;
    fileCount++;
    if (fileCount > PACKAGE_LIMITS.fileCount) {
      stop.issue = issue('', countMessage);
      return;
    }
    const parts: Uint8Array[] = [];
    let size = 0;
    file.ondata = (error, chunk, final) => {
      if (stop.issue) return;
      if (error) {
        stop.issue = issue(shown, 'ファイルを展開できません。zip が壊れています');
        return;
      }
      expanded += chunk.length;
      if (expanded > PACKAGE_LIMITS.expandedBytes) {
        stop.issue = issue('', expandedMessage);
        return;
      }
      size += chunk.length;
      parts.push(chunk);
      if (final) entries.set(normalizePath(name), concatBytes(parts, size));
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);

  const yieldToHost = options.yieldToHost ?? defaultYield;
  const sliceMs = options.sliceMs ?? DEFAULT_SLICE_MS;
  let sliceStart = performance.now();
  try {
    for (let offset = 0; offset < data.length; offset += PACKAGE_LIMITS.chunkBytes) {
      const end = Math.min(offset + PACKAGE_LIMITS.chunkBytes, data.length);
      unzip.push(data.subarray(offset, end), end === data.length);
      if (stop.issue) break;
      if (performance.now() - sliceStart >= sliceMs) {
        await yieldToHost();
        sliceStart = performance.now();
      }
    }
  } catch {
    stop.issue ??= issue('', 'zip を展開できません。壊れているか、対応していない形式です');
  }

  if (stop.issue) return { ok: false, errors: [stop.issue] };
  if (errors.length === 0 && entryCount !== central.names.length) {
    errors.push(issue('', '中央ディレクトリの項目と、ファイルの項目が一致しません。zip の構造が正しくありません'));
  }
  if (errors.length > 0) return { ok: false, errors: errors.slice(0, PACKAGE_LIMITS.issues) };
  return { ok: true, entries };
}
