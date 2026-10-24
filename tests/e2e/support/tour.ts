/**
 * テスト用ツアーの組み立てと、サイドパネルへ取り込むためのファイル。
 *
 * 使い方:
 * - `tourYaml(spec)`: ツアーの定義（`TourSpec`）から YAML を作る。`origins` は `http://localhost:<port>` のように書く
 *   （`server.origin`）。誤ったツアーを作るときは、型を緩めた `spec` を渡すか、YAML の文字列を直接 `yamlFile` へ渡す。
 * - `yamlFile(specOrText, fileName?)`: `ImportFile`（取り込む1ファイル）にする。`panel.importFiles([...])` へ渡す。
 * - `zipFile(fileName, entries)`: zip のパッケージにする。`entries` はパス → 文字列かバイト列。
 * - `standardTour(options)`: 全担当が使う、P-C（`/internal/`）向けの標準ツアー。ステップ4つ（既定）。
 *   ステップは、`s1`〜`sN`。`s1` は入力欄、`s2` はメール欄、`s3` はチェック、`s4` は「申請する」ボタン。
 * - `tourOn(origin, path, steps, options?)`: 役割 `main` のタブ1つだけのツアー。`path`（`{exact}`など）がその URL 条件と開く URL になる。
 * - `urlCond(origin, path?)`: URL 条件（`{origin, path: {prefix|exact|glob}}`）。
 */
import { zipSync, strToU8 } from 'fflate';
import { stringify } from 'yaml';

/** ステップ・ツアーの項目。形は src/core/tour/schema.ts と同じ。型は緩めてあり、誤ったツアーも作れる。 */
export interface StepSpec {
  id: string;
  title: string;
  kind?: 'page' | 'guide';
  body?: string;
  bodyFile?: string;
  tip?: string;
  tab?: string;
  url?: unknown;
  open?: string;
  target?: Record<string, unknown>;
  done?: Record<string, unknown>;
  media?: Record<string, unknown>;
  [extra: string]: unknown;
}

export interface TabSpec {
  label?: string;
  open?: string;
  url?: unknown;
}

export interface TourSpec {
  schemaVersion?: number;
  id: string;
  name: string;
  description?: string;
  minExtensionVersion?: string;
  origins: string[];
  tabs?: Record<string, TabSpec>;
  steps: StepSpec[];
  [extra: string]: unknown;
}

export interface ImportFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export type PathCond = { exact: string } | { prefix: string } | { glob: string };

export function urlCond(origin: string, path?: PathCond): { origin: string; path?: PathCond } {
  return path === undefined ? { origin } : { origin, path };
}

export function tourYaml(spec: TourSpec): string {
  return stringify({ schemaVersion: 3, ...spec });
}

export function yamlFile(source: TourSpec | string, fileName?: string): ImportFile {
  const text = typeof source === 'string' ? source : tourYaml(source);
  const name = fileName ?? (typeof source === 'string' ? 'tour.yaml' : `${source.id}.yaml`);
  return { name, mimeType: 'application/x-yaml', buffer: Buffer.from(text, 'utf8') };
}

export function zipFile(fileName: string, entries: Record<string, string | Uint8Array>): ImportFile {
  const files: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(entries)) {
    files[path] = typeof content === 'string' ? strToU8(content) : content;
  }
  return { name: fileName, mimeType: 'application/zip', buffer: Buffer.from(zipSync(files)) };
}

export interface TourOnOptions {
  id?: string;
  name?: string;
  description?: string;
  minExtensionVersion?: string;
  /** `origins` に足すオリジン。 */
  extraOrigins?: string[];
  /** 開く URL（既定は `origin` + `path` の exact か prefix の値）。 */
  open?: string;
}

/** 役割 `main` のタブ1つだけのツアー。ID は `e2e-tour`、名称は `E2E テストツアー`。 */
export function tourOn(origin: string, path: PathCond, steps: StepSpec[], options: TourOnOptions = {}): TourSpec {
  const first = 'exact' in path ? path.exact : 'prefix' in path ? path.prefix : '/';
  return {
    id: options.id ?? 'e2e-tour',
    name: options.name ?? 'E2E テストツアー',
    ...(options.description === undefined ? {} : { description: options.description }),
    ...(options.minExtensionVersion === undefined ? {} : { minExtensionVersion: options.minExtensionVersion }),
    origins: [origin, ...(options.extraOrigins ?? [])],
    tabs: { main: { label: '練習ページ', open: options.open ?? `${origin}${first}`, url: urlCond(origin, path) } },
    steps,
  };
}

export interface StandardTourOptions {
  /** `server.origin` など。ツアーの `origins` と URL 条件になる。 */
  origin: string;
  id?: string;
  name?: string;
  /** ステップ数（1〜4。既定 4）。 */
  steps?: number;
  /** `/internal/` 以外のページを使うときの URL 条件の path。 */
  path?: PathCond;
  minExtensionVersion?: string;
  /** 追加の `origins`（複数サイトのツアー用）。 */
  extraOrigins?: string[];
}

/** P-C（`/internal/`）向けの標準ツアー。 */
export function standardTour(options: StandardTourOptions): TourSpec {
  const { origin } = options;
  const path = options.path ?? { prefix: '/internal' };
  const all: StepSpec[] = [
    {
      id: 's1',
      title: '申請者名を入力する',
      tip: '**申請者名**の欄に入力します',
      body: '申請者名の欄に、名前を入力してください。',
      target: { tourId: 'applicant-name', fallbackText: '申請者名の欄が対象です' },
      done: { type: 'state', state: 'filled', target: { tourId: 'applicant-name' }, hint: '名前を入力してください', doneHint: '入力できました' },
    },
    {
      id: 's2',
      title: 'メールアドレスを入力する',
      body: 'メールアドレスの欄に入力してください。',
      target: { tourId: 'applicant-mail', fallbackText: 'メールアドレスの欄が対象です' },
      done: { type: 'state', state: 'filled', target: { tourId: 'applicant-mail' }, hint: 'メールアドレスを入力してください', doneHint: '入力できました' },
    },
    {
      id: 's3',
      title: '規約に同意する',
      body: '利用規約のチェックを入れてください。',
      target: { tourId: 'agree-check', fallbackText: '同意のチェックが対象です' },
      done: { type: 'state', state: 'checked', target: { tourId: 'agree-check' }, hint: 'チェックを入れてください', doneHint: 'チェックできました' },
    },
    {
      id: 's4',
      title: '申請する',
      body: '「申請する」ボタンの場所を確認してください。',
      target: { tourId: 'submit-button', fallbackText: '申請ボタンが対象です' },
    },
  ];
  const count = Math.min(Math.max(options.steps ?? 4, 1), all.length);
  return {
    id: options.id ?? 'e2e-standard',
    name: options.name ?? 'E2E 標準ツアー',
    description: 'E2E 用の標準ツアー',
    ...(options.minExtensionVersion === undefined ? {} : { minExtensionVersion: options.minExtensionVersion }),
    origins: [origin, ...(options.extraOrigins ?? [])],
    tabs: {
      main: { label: '申請ページ', open: `${origin}/internal/`, url: urlCond(origin, path) },
    },
    steps: all.slice(0, count),
  };
}
