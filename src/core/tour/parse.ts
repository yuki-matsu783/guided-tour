/**
 * ツアー YAML の解析と検証（parseTour）。
 * 入力は YAML 文字列とファイル名。戻り値は、検証済みの `Tour` と警告、またはエラー（最大20件）と警告。
 * エラーは利用者向けの日本語で、場所（path）と行番号（取れないときは null）を持つ。入力の中身（値）はメッセージに含めない。
 *
 * 処理フロー:
 * 1. yaml で解析する（YAML 1.2、マージキー無効、重複キー・独自タグ・警告はエラー）。構文のエラーがあればここで返す
 * 2. 構文木を調べる（最上位が対応表か、マージキー、キーが文字列か・文字列として重複していないか、入れ子の深さ）
 * 3. JS の値にする（エイリアス展開は100まで）。展開後の値の入れ子の深さも調べる
 * 4. zod で形式を検証し、エラーの場所を YAML の行に対応付ける
 * 5. `validateTourRules` でツアー全体の規則と警告を調べる
 */
import { isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument } from 'yaml';
import type { Document } from 'yaml';
import type { z } from 'zod';
import { TOUR_LIMITS } from './limits.ts';
import { validateTourRules } from './rules.ts';
import type { RuleIssue } from './rules.ts';
import { TourSchema } from './schema.ts';
import type { Tour } from './schema.ts';

/** 利用者に見せる問題1件。`line` は1始まり。 */
export interface Issue {
  file: string;
  line: number | null;
  path: string;
  message: string;
}

export type ParseResult =
  | { ok: true; tour: Tour; warnings: Issue[] }
  | { ok: false; errors: Issue[]; warnings: Issue[] };

type PathSegment = string | number;

/** `steps[2].target.name[1]` の形の場所の表記にする。 */
export function formatPath(path: readonly PathSegment[]): string {
  return path.reduce<string>(
    (acc, seg) => (typeof seg === 'number' ? `${acc}[${String(seg)}]` : acc === '' ? seg : `${acc}.${seg}`),
    '',
  );
}

// ---- YAML の位置 ----

type Doc = Document.Parsed;

/** 利用者の書いたキーを、メッセージ・場所に出すときの形にする。制御文字を除き、40文字で切る。 */
export function safeKey(key: string): string {
  return Array.from(key.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ''))
    .slice(0, KEY_DISPLAY_CHARS)
    .join('');
}

const KEY_DISPLAY_CHARS = 40;

/** 場所から行番号を求める。ノードがない（項目の欠落など）ときは、あるところまで親をさかのぼる。 */
function lineOfPath(doc: Doc, lc: LineCounter, path: readonly PathSegment[]): number | null {
  for (let len = path.length; len >= 0; len--) {
    const here = path.slice(0, len);
    const last = here.at(-1);
    // 対応表の項目は、キーの行を指す（値が複数行でも項目の書き出しの行になる）
    if (typeof last === 'string') {
      const line = keyLineIn(doc, lc, here.slice(0, -1), last);
      if (line !== null) return line;
    }
    const node = len === 0 ? doc.contents : doc.getIn(here, true);
    if (node !== null && typeof node === 'object' && 'range' in node && Array.isArray(node.range)) {
      const start: unknown = node.range[0];
      if (typeof start === 'number') return lc.linePos(start).line;
    }
  }
  return null;
}

/** 対応表 `parent` の中のキー `key` の行番号。なければ null。 */
function keyLineIn(doc: Doc, lc: LineCounter, parent: readonly PathSegment[], key: string): number | null {
  const node = parent.length === 0 ? doc.contents : doc.getIn(parent, true);
  if (!isMap(node)) return null;
  for (const pair of node.items) {
    if (isScalar(pair.key) && pair.key.value === key && pair.key.range) {
      return lc.linePos(pair.key.range[0]).line;
    }
  }
  return null;
}

// ---- YAML の構文木の検査 ----

interface TreeFinding {
  offset: number;
  message: string;
}

interface TreeReport {
  findings: TreeFinding[];
  aliasOffsets: number[];
}

/** マージキーと入れ子の深さを調べ、エイリアスの位置を集める。深さを超えたら、それ以上は降りない。 */
function inspectTree(root: unknown): TreeReport {
  const report: TreeReport = { findings: [], aliasOffsets: [] };
  let tooDeep = false;
  const walk = (node: unknown, depth: number): void => {
    if (tooDeep) return;
    if (isAlias(node)) {
      if (node.range) report.aliasOffsets.push(node.range[0]);
      return;
    }
    if (!isMap(node) && !isSeq(node)) return;
    if (depth > TOUR_LIMITS.yamlDepth) {
      tooDeep = true;
      report.findings.push({
        offset: node.range?.[0] ?? 0,
        message: `入れ子が深すぎます。深さは${String(TOUR_LIMITS.yamlDepth)}までです`,
      });
      return;
    }
    if (isSeq(node)) {
      for (const item of node.items) walk(item, depth + 1);
      return;
    }
    // キーは文字列として比べる（1 と "1" は重複）。文字列でないキーはエラー
    const seen = new Set<string>();
    for (const pair of node.items) {
      if (isScalar(pair.key) && pair.key.value === '<<' && pair.key.range) {
        report.findings.push({
          offset: pair.key.range[0],
          message: 'マージキー（<<）は使えません。値を直接書いてください',
        });
      }
      const key = pair.key;
      if (isScalar(key) || isMap(key) || isSeq(key)) {
        const offset = key.range?.[0] ?? node.range?.[0] ?? 0;
        if (!isScalar(key) || typeof key.value !== 'string') {
          report.findings.push({
            offset,
            message: 'キーは文字列で書いてください（数値・真偽値・null・対応表・リストはキーにできません）。数字のキーは引用符で囲みます',
          });
        }
        if (isScalar(key)) {
          const text = String(key.value);
          if (seen.has(text)) {
            report.findings.push({
              offset,
              message: '同じキーが重複しています。同じ階層に同じキーは書けません（数値と文字列の違いは区別しません）',
            });
          }
          seen.add(text);
        }
      }
      walk(pair.value, depth + 1);
    }
  };
  walk(root, 1);
  return report;
}

/** 展開後の値の入れ子が上限を超えるか。上限を超えた時点で止める（循環していても終わる）。 */
function exceedsDepth(value: unknown, depth: number): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (depth > TOUR_LIMITS.yamlDepth) return true;
  const children: unknown[] = Array.isArray(value) ? value : Object.values(value);
  return children.some((child) => exceedsDepth(child, depth + 1));
}

// ---- zod のエラーの日本語化 ----

function getByPath(data: unknown, path: readonly PathSegment[]): unknown {
  let cur = data;
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = Reflect.get(cur, seg);
  }
  return cur;
}

function fieldName(path: readonly PathSegment[]): string {
  const last = path.at(-1);
  if (typeof last === 'string') return safeKey(last);
  if (typeof last === 'number') return `${String(last + 1)}番目の要素`;
  return 'この値';
}

const TYPE_NAMES: Record<string, string> = {
  string: '文字列',
  number: '数値',
  int: '整数',
  boolean: '真偽値（true / false）',
  array: 'リスト',
  object: 'キーと値の組（対応表）',
};

function plainPath(path: readonly PropertyKey[]): PathSegment[] {
  return path.filter((s): s is PathSegment => typeof s !== 'symbol');
}

/** 対応表・リストのどちらでもないという型の誤りだけの形は除き、最初に当てはまりそうな形のエラーを返す。 */
function likelyBranch(branches: readonly (readonly z.core.$ZodIssue[])[]): readonly z.core.$ZodIssue[] | undefined {
  return branches.find((b) => !(b.length === 1 && b[0]?.code === 'invalid_type' && b[0].path.length === 0));
}

/** zod のエラー1件を、場所つきの日本語のメッセージ（1件以上）にする。 */
function describeZodIssue(issue: z.core.$ZodIssue, data: unknown): RuleIssue[] {
  const path = plainPath(issue.path);
  const name = fieldName(path);
  const missing = getByPath(data, path) === undefined;
  const one = (message: string): RuleIssue[] => [{ path, message }];

  switch (issue.code) {
    case 'invalid_type':
      return one(
        missing
          ? `必須の項目「${name}」がありません`
          : `「${name}」は${TYPE_NAMES[issue.expected] ?? issue.expected}で書いてください`,
      );
    case 'invalid_value': {
      const values = issue.values.map(String);
      if (missing) {
        return one(`必須の項目「${name}」がありません（${values.join('・')} を書いてください）`);
      }
      return one(
        values.length === 1
          ? `「${name}」は ${values.join('')} にしてください（この拡張機能が対応しているのはこの値だけです）`
          : `「${name}」に書ける値は ${values.join('・')} のいずれかです`,
      );
    }
    case 'too_small': {
      const min = String(issue.minimum);
      if (issue.origin === 'string') return one(`「${name}」は${min}文字以上で書いてください（空にはできません）`);
      if (issue.origin === 'array') return one(`「${name}」は${min}件以上書いてください`);
      return one(`「${name}」は${min}以上にしてください`);
    }
    case 'too_big': {
      const max = String(issue.maximum);
      if (issue.origin === 'string') return one(`「${name}」は${max}文字以内で書いてください`);
      if (issue.origin === 'array') return one(`「${name}」は${max}件以内で書いてください`);
      return one(`「${name}」は${max}以下にしてください`);
    }
    case 'unrecognized_keys':
      return issue.keys.map((key) => ({
        path: [...path, key],
        message: `項目「${safeKey(key)}」は仕様にありません。書き間違いか、この版では使えない項目です`,
      }));
    case 'invalid_union': {
      // 既定の文言のままなら、どの形にも当てはまらなかった理由を、当てはまりそうな形のエラーから取り出す
      const detail = issue.message === 'Invalid input' ? likelyBranch(issue.errors) : undefined;
      if (detail === undefined) return one(issue.message);
      return detail.flatMap((d) => describeZodIssue({ ...d, path: [...issue.path, ...d.path] }, data));
    }
    case 'invalid_format':
    case 'custom':
      return one(issue.message);
    default:
      return one(`「${name}」の値が正しくありません`);
  }
}

// ---- YAML のエラーの日本語化 ----

function yamlMessage(code: string): string {
  switch (code) {
    case 'DUPLICATE_KEY':
      return '同じキーが重複しています。同じ階層に同じキーは書けません';
    case 'MULTIPLE_DOCS':
      return '複数のドキュメント（---）は使えません。ツアーは1つのドキュメントで書いてください';
    case 'TAG_RESOLVE_FAILED':
      return '独自タグ（! で始まる指定）は使えません';
    default:
      return 'YAML の書き方に誤りがあります。インデント、引用符や括弧の閉じ忘れを確かめてください';
  }
}

// ---- 入口 ----

export function parseTour(yamlText: string, fileName: string): ParseResult {
  const make = (line: number | null, path: readonly PathSegment[], message: string): Issue => ({
    file: fileName,
    line,
    path: formatPath(path),
    message,
  });
  const fail = (errors: Issue[], warnings: Issue[] = []): ParseResult => ({
    ok: false,
    errors: errors.slice(0, TOUR_LIMITS.issues),
    warnings: warnings.slice(0, TOUR_LIMITS.issues),
  });

  // 1. 解析
  const lc = new LineCounter();
  let doc: Doc;
  try {
    doc = parseDocument(yamlText, {
      version: '1.2',
      merge: false,
      uniqueKeys: true,
      prettyErrors: false,
      lineCounter: lc,
    });
  } catch {
    return fail([make(null, [], 'YAML を解析できませんでした。入れ子が深すぎるなど、構造を見直してください')]);
  }
  const syntax = [...doc.errors, ...doc.warnings];
  if (syntax.length > 0) {
    return fail(syntax.map((e) => make(lc.linePos(e.pos[0]).line, [], yamlMessage(e.code))));
  }
  const root = doc.contents;
  if (root === null) return fail([make(null, [], 'ツアーの内容が空です')]);
  if (!isMap(root)) {
    return fail([make(lc.linePos(root.range[0]).line, [], '最上位はキーと値の組（対応表）で書いてください')]);
  }

  // 2. 構文木
  const tree = inspectTree(root);
  if (tree.findings.length > 0) {
    return fail(tree.findings.map((f) => make(lc.linePos(f.offset).line, [], f.message)));
  }

  // 3. JS の値へ
  let data: unknown;
  try {
    // yaml はアンカー自身の1回も数えるので、エイリアス100回までを通すには上限を1つ上げる
    data = doc.toJS({ maxAliasCount: TOUR_LIMITS.yamlAliases + 1 });
  } catch (e) {
    const tooMany = e instanceof Error && e.message.includes('alias count');
    const offset = tooMany ? tree.aliasOffsets[TOUR_LIMITS.yamlAliases] : tree.aliasOffsets[0];
    return fail([
      make(
        offset === undefined ? null : lc.linePos(offset).line,
        [],
        tooMany
          ? `エイリアスの展開が多すぎます。上限は${String(TOUR_LIMITS.yamlAliases)}回です`
          : 'エイリアス（*）を解決できません。先に書いたアンカー（&）を指してください',
      ),
    ]);
  }

  if (exceedsDepth(data, 1)) {
    return fail([
      make(null, [], `入れ子が深すぎます（エイリアスの展開後）。深さは${String(TOUR_LIMITS.yamlDepth)}までです`),
    ]);
  }

  // 4. 形式
  const parsed = TourSchema.safeParse(data);
  if (!parsed.success) {
    const found = parsed.error.issues.flatMap((issue) => describeZodIssue(issue, data));
    return fail(found.map((f) => toIssue(f)));
  }

  // 5. ツアー全体の規則
  const rules = validateTourRules(parsed.data);
  const warnings = rules.warnings.map((w) => toIssue(w)).slice(0, TOUR_LIMITS.issues);
  if (rules.errors.length > 0) return fail(rules.errors.map((r) => toIssue(r)), warnings);
  return { ok: true, tour: parsed.data, warnings };

  function toIssue(found: RuleIssue): Issue {
    // 行番号は元のキーで探し、表示する場所はキーを整えた形にする
    const shown = found.path.map((seg) => (typeof seg === 'string' ? safeKey(seg) : seg));
    return make(lineOfPath(doc, lc, found.path), shown, found.message);
  }
}
