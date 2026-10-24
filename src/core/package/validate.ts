/**
 * パッケージ全体の検証。ツアー YAML を解析し、説明文・画像の参照を解決して検査し、保存するファイルを決める。
 * 入力は YAML の文字列と、展開済みのエントリ（単体 YAML のときは null）。拡張機能 API にも IndexedDB にも触れない。
 * 出力は、パス解決済みのツアー・警告・保存するファイルの一覧、またはエラーの一覧。
 *
 * 処理フロー:
 * 1. `parseTour` で形式と規則を検証する（失敗ならそのエラーを返す）
 * 2. 各ステップの `bodyFile`・`media.src`・インライン `body` の画像を、参照元の場所を起点に解決する
 * 3. 画像は拡張子・署名・容量・ヘッダーの寸法を、Markdown は容量・文字コードと中の画像を検査する
 * 4. 参照されたファイルだけを保存の対象にする（参照されないファイルは捨てる）
 */
import { isMap, LineCounter, parseDocument } from 'yaml';
import { parseTour, formatPath } from '../tour/index.ts';
import type { Issue, Tour } from '../tour/index.ts';
import type { Bytes } from './bytes.ts';
import { decodeDataUrl, isDataUrl } from './data-url.ts';
import { displayName } from './entry-name.ts';
import { imageKindOfExtension, inspectImage } from './image.ts';
import type { ImageInfo } from './image.ts';
import { formatBytesLimit, PACKAGE_LIMITS } from './limits.ts';
import { decodeImagePath, extractMarkdownImages } from './md-images.ts';
import { extensionOf, resolveRelative } from './path.ts';

/** `tour.yaml` の、パッケージ内の名前。 */
export const TOUR_FILE = 'tour.yaml';

export interface PackageFile {
  /** パッケージ内の正規化したパス */
  path: string;
  bytes: Bytes;
  mime: string;
  width?: number;
  height?: number;
}

export interface PackageInput {
  /** 取り込むファイルの名前（zip なら zip の名前、単体 YAML ならその名前） */
  fileName: string;
  yamlText: string;
  /** zip の展開結果。単体の YAML のときは null（相対パスの参照はエラーになる） */
  entries: ReadonlyMap<string, Bytes> | null;
}

export type PackageResult =
  | { ok: true; tour: Tour; yamlText: string; warnings: Issue[]; files: PackageFile[] }
  | { ok: false; errors: Issue[] };

/** エラーの場所。行番号は必要になったときだけ求める。 */
interface Where {
  file: string;
  path: string;
  line: () => number | null;
}

type Resolved = { kind: 'file'; path: string } | { kind: 'data' } | { kind: 'error' };

type ImageOutcome = { ok: true; info: ImageInfo; bytes: Bytes } | { ok: false; message: string };

/** YAML の `path`（例: `['steps', 1, 'media', 'src']`）の行番号。分からなければ null。 */
function lineOfYamlPath(yamlText: string, path: readonly (string | number)[]): number | null {
  try {
    const lc = new LineCounter();
    const doc = parseDocument(yamlText, { version: '1.2', merge: false, lineCounter: lc });
    const last = path.at(-1);
    if (typeof last === 'string') {
      const parent = path.length === 1 ? doc.contents : doc.getIn(path.slice(0, -1), true);
      if (isMap(parent)) {
        for (const pair of parent.items) {
          const key: unknown = pair.key;
          if (typeof key === 'object' && key !== null && 'value' in key && key.value === last && 'range' in key) {
            const range: unknown = key.range;
            if (Array.isArray(range) && typeof range[0] === 'number') return lc.linePos(range[0]).line;
          }
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function validatePackage(input: PackageInput): PackageResult {
  const { entries, yamlText } = input;
  const yamlLabel = entries === null ? input.fileName : `${input.fileName}/${TOUR_FILE}`;
  const parsed = parseTour(yamlText, yamlLabel);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };

  const errors: Issue[] = [];
  const files = new Map<string, PackageFile>();
  const images = new Map<string, ImageOutcome>();
  const markdowns = new Set<string>();

  const report = (where: Where, message: string): void => {
    if (errors.length >= PACKAGE_LIMITS.issues) return;
    errors.push({ file: where.file, line: where.line(), path: where.path, message });
  };
  const yamlWhere = (path: readonly (string | number)[]): Where => ({
    file: yamlLabel,
    path: formatPath(path),
    line: () => lineOfYamlPath(yamlText, path),
  });

  /** パスの参照を解決する。参照元（base）は、パッケージ内のパス。 */
  const resolve = (base: string, ref: string, where: Where): string | null => {
    const result = resolveRelative(base, ref);
    if (!result.ok) {
      report(where, result.message);
      return null;
    }
    if (entries === null) {
      report(where, '.yaml 単体では相対パスで参照できません。zip にまとめるか、画像は data URL で書いてください');
      return null;
    }
    return result.path;
  };

  const inspectFile = (path: string, bytes: Bytes): ImageOutcome => {
    const cached = images.get(path);
    if (cached) return cached;
    const kind = imageKindOfExtension(extensionOf(path));
    if (kind === null) return { ok: false, message: '画像の拡張子が正しくありません' };
    const result = inspectImage(bytes, kind);
    const outcome: ImageOutcome = result.ok ? { ok: true, info: result.info, bytes } : result;
    images.set(path, outcome);
    return outcome;
  };

  /** 画像の参照1つ（ファイルか data URL）を検査する。`decode` は Markdown 由来の参照のとき真。 */
  const checkImage = (src: string, base: string, where: Where, decode: boolean): Resolved => {
    if (isDataUrl(src)) {
      const data = decodeDataUrl(src);
      if (!data.ok) {
        report(where, data.message);
        return { kind: 'error' };
      }
      const inspected = inspectImage(data.bytes, data.kind);
      if (!inspected.ok) {
        report(where, `data URL の画像: ${inspected.message}`);
        return { kind: 'error' };
      }
      return { kind: 'data' };
    }
    const ref = decode ? decodeImagePath(src) : src;
    if (ref === null) {
      report(where, '画像のパスを読み取れません（パーセントエンコードが正しくありません）');
      return { kind: 'error' };
    }
    const path = resolve(base, ref, where);
    if (path === null) return { kind: 'error' };
    const ext = extensionOf(path);
    if (ext === 'svg') {
      report(where, 'SVG の画像は使えません。PNG・JPEG・GIF・WebP を使ってください');
      return { kind: 'error' };
    }
    if (imageKindOfExtension(ext) === null) {
      report(where, '画像の拡張子は png・jpg・jpeg・gif・webp のいずれかにしてください');
      return { kind: 'error' };
    }
    const bytes = entries?.get(path);
    if (bytes === undefined) {
      report(where, '参照先のファイルがパッケージの中に見つかりません');
      return { kind: 'error' };
    }
    const outcome = inspectFile(path, bytes);
    if (!outcome.ok) {
      report(where, outcome.message);
      return { kind: 'error' };
    }
    if (!files.has(path)) {
      files.set(path, {
        path,
        bytes: outcome.bytes,
        mime: outcome.info.mime,
        width: outcome.info.width,
        height: outcome.info.height,
      });
    }
    return { kind: 'file', path };
  };

  /** Markdown の本文に含まれる画像を検査する。`labelFor` は画像1つのエラーの場所を作る。 */
  const checkMarkdownImages = (
    text: string,
    base: string,
    labelFor: (src: string, line: number) => Where,
  ): void => {
    for (const image of extractMarkdownImages(text)) {
      const where = labelFor(displayName(image.src), image.line);
      if (image.rejected) {
        report(where, '画像の参照として使えない URL です。パッケージ内の画像のパスか、許可した data URL を書いてください');
        continue;
      }
      if (image.alt === '') report(where, '画像には代替文が必要です（![代替文](パス) の形で書いてください）');
      checkImage(image.src, base, where, true);
    }
  };

  const checkBodyFile = (stepIndex: number, bodyFile: string): string | null => {
    const where = yamlWhere(['steps', stepIndex, 'bodyFile']);
    const path = resolve(TOUR_FILE, bodyFile, where);
    if (path === null) return null;
    const bytes = entries?.get(path);
    if (bytes === undefined) {
      report(where, '参照先のファイルがパッケージの中に見つかりません');
      return null;
    }
    if (markdowns.has(path)) return path;
    markdowns.add(path);
    if (bytes.length > PACKAGE_LIMITS.markdownBytes) {
      report(where, `Markdown ファイルが上限（1つ ${formatBytesLimit(PACKAGE_LIMITS.markdownBytes)}）を超えています`);
      return path;
    }
    const text = decodeUtf8(bytes);
    if (text === null) {
      report(where, 'Markdown ファイルを UTF-8 として読めません');
      return path;
    }
    files.set(path, { path, bytes, mime: 'text/markdown' });
    checkMarkdownImages(text, path, (src, line) => ({
      file: `${input.fileName}/${path}`,
      path: src,
      line: () => line,
    }));
    return path;
  };

  const steps = parsed.tour.steps.map((step, index) => {
    let { bodyFile, media } = step;
    if (bodyFile !== undefined) {
      const path = checkBodyFile(index, bodyFile);
      if (path !== null) bodyFile = path;
    }
    if (media !== undefined) {
      const resolved = checkImage(media.src, TOUR_FILE, yamlWhere(['steps', index, 'media', 'src']), false);
      if (resolved.kind === 'file') media = { ...media, src: resolved.path };
    }
    if (step.body !== undefined) {
      const where = yamlWhere(['steps', index, 'body']);
      checkMarkdownImages(step.body, TOUR_FILE, () => where);
    }
    return { ...step, ...(bodyFile === undefined ? {} : { bodyFile }), ...(media === undefined ? {} : { media }) };
  });

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    tour: { ...parsed.tour, steps },
    yamlText,
    warnings: parsed.warnings,
    files: [...files.values()],
  };
}
