/**
 * ツアー形式（schemaVersion 3）の zod スキーマと型。
 * 外から入るツアー（YAML・IndexedDB）はここを通した値だけを内側へ渡す。未知の項目はエラーにする。
 * 説明文は `body`（直接）か `bodyFile`（パス）のまま持つ。パスの解決は取り込み側が行う。
 * origins との突き合わせ・page ステップの URL・警告などツリー全体にまたがる規則は `rules.ts` が担う。
 */
import { z } from 'zod';
import { TOUR_LIMITS } from './limits.ts';

type Path = (string | number)[];
interface RefineCtx {
  addIssue: (issue: { code: 'custom'; message: string; path: Path }) => void;
}

function addIssue(ctx: RefineCtx, path: Path, message: string): void {
  ctx.addIssue({ code: 'custom', message, path });
}

/** 手がかりの候補の列。1〜20件。 */
const candidateList = z.array(z.string().min(1)).min(1).max(TOUR_LIMITS.candidates);

const nonEmpty = z.string().min(1);

// ---- URL 条件 ----

/** パスで使えない記号。正規表現らしい記号を、書けないことでエラーにする。 */
const FORBIDDEN_PATH_CHARS = ['(', ')', '[', ']', '{', '}', '\\', '$', '^', '+', '?', '|'];

const PATH_KEYS = ['exact', 'prefix', 'glob'] as const;
type PathKey = (typeof PATH_KEYS)[number];

/** パーセントエンコードを戻した文字列。戻せないときはそのまま。文字数は、書かれた文字で数えるために使う。 */
function decodedForLength(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * パスの区間1つを、ブラウザが URL の `pathname` に入れる形（非 ASCII・空白などのパーセントエンコード）にする。
 * `*`・`**` の区間はそのまま。`.`・`..` のようにブラウザが畳む区間も、書かれたまま残す（URL 側には現れないので、一致しないだけ）。
 */
function browserSegment(segment: string): string {
  if (segment === '*' || segment === '**') return segment;
  try {
    // `#` はそのままでは URL のフラグメントになるので、先に区間の文字として符号化する
    const { pathname } = new URL(`http://localhost/${segment.replaceAll('#', '%23')}`);
    const encoded = pathname.slice(1);
    return encoded === '' ? segment : encoded;
  } catch {
    return segment;
  }
}

/** 条件のパスを、照合の相手（ブラウザの `pathname`）と同じ形にそろえる。同じ入力に何度かけても結果は変わらない。 */
function browserPath(value: string): string {
  return value.split('/').map(browserSegment).join('/');
}

/** パス1つの問題点を日本語で返す。問題がなければ空。 */
function pathProblems(kind: PathKey, value: string): string[] {
  const problems: string[] = [];
  if (!value.startsWith('/')) problems.push('パスは / で始めてください');
  // 解析済みのツアーを検証し直すときは、条件のパスがパーセントエンコード済み。書かれた文字数で数える
  if (decodedForLength(value).length > TOUR_LIMITS.pathChars) {
    problems.push(`パスは${String(TOUR_LIMITS.pathChars)}文字以内にしてください`);
  }
  if (FORBIDDEN_PATH_CHARS.some((c) => value.includes(c))) {
    problems.push(
      `パスに正規表現は使えません。次の記号は書けません: ${FORBIDDEN_PATH_CHARS.join(' ')}`,
    );
  }
  const segments = value.split('/').filter((s) => s !== '');
  if (segments.length > TOUR_LIMITS.pathSegments) {
    problems.push(`パスは${String(TOUR_LIMITS.pathSegments)}区間以内にしてください`);
  }
  if (kind !== 'glob' && value.includes('*')) {
    problems.push('exact・prefix では * は使えません。ワイルドカードは glob に書いてください');
  }
  if (kind === 'glob') {
    if (segments.some((s) => s.includes('*') && s !== '*' && s !== '**')) {
      problems.push('* と ** は区間全体としてだけ書けます（/a/b* のように区間の途中には書けません）');
    }
    if (segments.filter((s) => s === '**').length > TOUR_LIMITS.globStars) {
      problems.push(`** は${String(TOUR_LIMITS.globStars)}個までです`);
    }
  }
  return problems;
}

const PathCondSchema = z
  .strictObject({
    exact: z.string().optional(),
    prefix: z.string().optional(),
    glob: z.string().optional(),
  })
  .superRefine((p, ctx) => {
    const present = PATH_KEYS.filter((k) => p[k] !== undefined);
    if (present.length !== 1) {
      addIssue(ctx, [], 'path には exact・prefix・glob のうち1つだけを書いてください');
    }
    for (const key of present) {
      const value = p[key];
      if (value === undefined) continue;
      for (const message of pathProblems(key, value)) addIssue(ctx, [key], message);
    }
  })
  // 解析の時点で、条件のパスを URL の `pathname` と同じ形にそろえる（照合の側は `pathname` をそのまま使う）
  .transform((p) => ({
    ...(p.exact !== undefined ? { exact: browserPath(p.exact) } : {}),
    ...(p.prefix !== undefined ? { prefix: browserPath(p.prefix) } : {}),
    ...(p.glob !== undefined ? { glob: browserPath(p.glob) } : {}),
  }));

/** URL 条件。`origin` が origins のいずれかと一致するかは rules.ts で確かめる。 */
export const UrlCondSchema = z.strictObject({
  origin: nonEmpty,
  path: PathCondSchema.optional(),
});
export type UrlCond = z.output<typeof UrlCondSchema>;

// ---- origins ----

/** オリジン1つの問題点（ワイルドカード・スキーム・形）を返す。問題がなければ undefined。 */
function originProblem(value: string): string | undefined {
  if (value.includes('*')) return 'origins にワイルドカードは使えません。ホストを1つずつ書いてください';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'origins は https://example.com のように、スキームから書いてください';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'origins のスキームは http か https だけです';
  }
  if (url.origin !== value) {
    return 'origins はスキーム・ホスト・ポートだけで、小文字で書いてください（パスや末尾の / は付けません。既定のポートは省きます）';
  }
  return undefined;
}

const OriginSchema = z.string().superRefine((v, ctx) => {
  const problem = originProblem(v);
  if (problem !== undefined) addIssue(ctx, [], problem);
});

// ---- target ----

const LANDMARKS = [
  'main',
  'navigation',
  'form',
  'banner',
  'contentinfo',
  'complementary',
  'search',
  'region',
] as const;

const WithinSchema = z.union(
  [
    z.strictObject({ role: nonEmpty, name: candidateList }),
    z.strictObject({ label: candidateList }),
    z.strictObject({ css: nonEmpty }),
  ],
  { error: 'within は「role と name」「label」「css」のいずれか1つの形で書いてください' },
);

/** 手がかり（name・label・text・css）の範囲の上書き。範囲か、ページ全体を明示する `page`。 */
const ClueWithinSchema = z.union([z.literal('page'), WithinSchema], {
  error: 'within は範囲（「role と name」「label」「css」のいずれか1つの形）か page で書いてください',
});

/**
 * 手がかり1つ。候補の配列か、`{ values, within? }`。
 * `within` を書いた手がかりは、`target.within` の代わりにその範囲で探す。`page` はページ全体。
 */
const clueSchema = z.union([
  candidateList,
  z.strictObject({ values: candidateList, within: ClueWithinSchema.optional() }),
]);
export type Clue = z.output<typeof clueSchema>;

const RequireSchema = z.strictObject({
  role: nonEmpty.optional(),
  inputType: nonEmpty.optional(),
  region: z.enum(LANDMARKS).optional(),
  name: candidateList.optional(),
});

export const TargetSchema = z
  .strictObject({
    tourId: nonEmpty.optional(),
    testId: nonEmpty.optional(),
    role: nonEmpty.optional(),
    name: clueSchema.optional(),
    label: clueSchema.optional(),
    text: clueSchema.optional(),
    textTag: candidateList.optional(),
    match: z.enum(['exact', 'contains']).optional(),
    css: clueSchema.optional(),
    within: WithinSchema.optional(),
    require: RequireSchema.optional(),
    highlight: z.strictObject({ closest: nonEmpty }).optional(),
    fallbackText: z.string().optional(),
  })
  .superRefine((t, ctx) => {
    const hasCue =
      t.tourId !== undefined ||
      t.testId !== undefined ||
      t.role !== undefined ||
      t.label !== undefined ||
      t.text !== undefined ||
      t.css !== undefined;
    if (!hasCue) {
      addIssue(
        ctx,
        [],
        'target には探す手がかりを1つ以上書いてください（testId・tourId・role・label・text・css のいずれか）',
      );
    }
  });
export type Target = z.output<typeof TargetSchema>;

// ---- done ----

export const DoneSchema = z
  .strictObject({
    type: z.enum(['page', 'element', 'state']),
    url: UrlCondSchema.optional(),
    target: TargetSchema.optional(),
    state: z.enum(['filled', 'checked', 'selected', 'expanded', 'pressed']).optional(),
    minLength: z.int().min(0).optional(),
    allowHidden: z.boolean().optional(),
    hint: z.string().optional(),
    doneHint: z.string().optional(),
  })
  .superRefine((d, ctx) => {
    const need = (key: 'url' | 'target' | 'state'): void => {
      if (d[key] === undefined) {
        addIssue(ctx, [], `done.type が ${d.type} のときは ${key} が必要です`);
      }
    };
    const forbid = (key: 'url' | 'target' | 'state'): void => {
      if (d[key] !== undefined) {
        addIssue(ctx, [key], `done.type が ${d.type} のときは ${key} を書けません`);
      }
    };
    if (d.type === 'page') {
      need('url');
      forbid('target');
      forbid('state');
    } else if (d.type === 'element') {
      need('target');
      forbid('url');
      forbid('state');
    } else {
      need('target');
      need('state');
      forbid('url');
    }
  });
export type Done = z.output<typeof DoneSchema>;

// ---- media ----

export const MediaSchema = z.strictObject({
  src: nonEmpty,
  alt: nonEmpty,
  caption: z.string().optional(),
});
export type Media = z.output<typeof MediaSchema>;

// ---- step ----

const KindSchema = z.enum(['page', 'guide']);
const RoleSchema = nonEmpty;

const stepBase = {
  id: nonEmpty,
  title: nonEmpty,
  url: UrlCondSchema.optional(),
  open: nonEmpty.optional(),
  body: z.string().optional(),
  bodyFile: nonEmpty.optional(),
  tip: z.string().optional(),
  media: MediaSchema.optional(),
  target: TargetSchema.optional(),
  done: DoneSchema.optional(),
};

interface StepLike {
  kind: 'page' | 'guide';
  tab?: string | undefined;
  open?: string | undefined;
  url?: unknown;
  target?: unknown;
  done?: unknown;
  body?: string | undefined;
  bodyFile?: string | undefined;
}

/**
 * ステップ単体の規則。説明文の書き方と、guide が持てない項目を確かめる。
 * `fromSource` は YAML から読んだ形のとき真。tab の既定値が入る前なので、guide に tab を書いたかを区別できる。
 */
function checkStep(s: StepLike, ctx: RefineCtx, fromSource: boolean): void {
  if (s.body !== undefined && s.bodyFile !== undefined) {
    addIssue(ctx, ['bodyFile'], 'body と bodyFile は同時に書けません。どちらか一方にしてください');
  }
  if (s.bodyFile !== undefined && !s.bodyFile.toLowerCase().endsWith('.md')) {
    addIssue(ctx, ['bodyFile'], 'bodyFile は .md のファイルだけ指定できます');
  }
  if (s.kind !== 'guide') return;
  const forbidden: [string, boolean][] = [
    ['target', s.target !== undefined],
    ['url', s.url !== undefined],
    ['done', s.done !== undefined],
    ['open', s.open !== undefined],
    ['tab', fromSource && s.tab !== undefined],
  ];
  for (const [key, present] of forbidden) {
    if (present) addIssue(ctx, [key], `kind が guide のステップには ${key} を書けません`);
  }
}

/** YAML から読んだ形のステップ。kind と tab の既定値を埋める。 */
export const StepSchema = z
  .strictObject({ ...stepBase, kind: KindSchema.default('page'), tab: RoleSchema.optional() })
  .superRefine((s, ctx) => {
    checkStep(s, ctx, true);
  })
  .transform((s) => ({ ...s, tab: s.tab ?? 'main' }));
export type Step = z.output<typeof StepSchema>;

/** 既定値を埋めた後のステップ（IndexedDB から読んだ compiled 用）。 */
const CompiledStepSchema = z
  .strictObject({ ...stepBase, kind: KindSchema, tab: RoleSchema })
  .superRefine((s, ctx) => {
    checkStep(s, ctx, false);
  });

// ---- tour ----

const TabSchema = z.strictObject({
  label: z.string().optional(),
  open: nonEmpty.optional(),
  url: UrlCondSchema.optional(),
});

/** 役割の名前にできない名前。オブジェクトの組み込みの名前と衝突し、値が落ちたり読み違えたりするため。 */
const RESERVED_ROLE_NAMES = ['__proto__', 'constructor', 'prototype'];

/** 入力の段階で役割名を調べる。`z.record` は `__proto__` の項目を落とすので、落ちる前に見る。 */
const RoleNamesSchema = z.custom<Record<string, unknown>>((v) => typeof v === 'object' && v !== null).superRefine(
  (tabs, ctx) => {
    for (const role of Reflect.ownKeys(tabs)) {
      if (typeof role === 'string' && RESERVED_ROLE_NAMES.includes(role)) {
        addIssue(ctx, [role], '役割の名前に __proto__・constructor・prototype は使えません');
      }
    }
  },
);

const TabsSchema = RoleNamesSchema.pipe(z.record(nonEmpty, TabSchema))
  .refine((tabs) => Object.keys(tabs).length <= TOUR_LIMITS.candidates, {
    error: `tabs は${String(TOUR_LIMITS.candidates)}件までです`,
  });

const tourBase = {
  schemaVersion: z.literal(3),
  id: z
    .string()
    .regex(/^[A-Za-z0-9._-]+$/, { error: 'id は英数字・.・_・- だけで、1文字以上にしてください' }),
  name: nonEmpty,
  description: z.string().optional(),
  updatedAt: z.string().optional(),
  minExtensionVersion: z
    .string()
    .regex(/^\d+(\.\d+){0,3}$/, { error: 'minExtensionVersion は 1.2.3 のような数字とドットの形で書いてください' })
    .optional(),
  origins: z.array(OriginSchema).min(1).max(TOUR_LIMITS.candidates),
  tabs: TabsSchema.optional(),
};

/** YAML から読んだ形のツアー。 */
export const TourSchema = z.strictObject({
  ...tourBase,
  steps: z.array(StepSchema).min(1).max(TOUR_LIMITS.steps),
});
export type Tour = z.output<typeof TourSchema>;

/** 解析済み（既定値を埋めた）ツアーの再検証用。IndexedDB の `compiled` を読み直すときに使う。 */
export const CompiledTourSchema = z.strictObject({
  ...tourBase,
  steps: z.array(CompiledStepSchema).min(1).max(TOUR_LIMITS.steps),
});
