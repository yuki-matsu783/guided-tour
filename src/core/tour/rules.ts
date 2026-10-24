/**
 * ツアー全体にまたがる検証の規則（スキーマだけでは書けないもの）。
 * 入力は構造の検証を通った `Tour`。戻り値は場所（path）と日本語のメッセージで、行番号は付けない（parseTour が付ける）。
 * 見るもの: origins との突き合わせ、page ステップの URL、役割（tab）の定義、step の id の重複、必須の照合・name がない警告。
 */
import type { Target, Tour, UrlCond } from './schema.ts';

/** 規則違反1件。`path` は Tour の中の場所（例: `['steps', 2, 'url', 'origin']`）。 */
export interface RuleIssue {
  path: (string | number)[];
  message: string;
}

export interface RuleResult {
  errors: RuleIssue[];
  warnings: RuleIssue[];
}

/** ツアーが対象にするオリジンの一覧（重複なし、書かれた順）。 */
export function originsOf(tour: Pick<Tour, 'origins'>): string[] {
  return [...new Set(tour.origins)];
}

const NOT_IN_ORIGINS = 'origins に含まれていません。origins に追加するか、書き間違いを直してください';

/** 開く URL のオリジンが origins にあるかを確かめる。 */
function checkOpenUrl(
  value: string,
  path: (string | number)[],
  origins: Set<string>,
  errors: RuleIssue[],
): void {
  let origin: string;
  try {
    origin = new URL(value).origin;
  } catch {
    errors.push({ path, message: 'URL として解釈できません。https://example.com/... の形で書いてください' });
    return;
  }
  if (!origins.has(origin)) errors.push({ path, message: `開く URL のオリジンが${NOT_IN_ORIGINS}` });
}

/** URL 条件の origin が origins のいずれかと完全一致するかを確かめる。 */
function checkUrlCond(
  cond: UrlCond,
  path: (string | number)[],
  origins: Set<string>,
  errors: RuleIssue[],
): void {
  if (!origins.has(cond.origin)) {
    errors.push({ path: [...path, 'origin'], message: `URL 条件の origin が${NOT_IN_ORIGINS}（完全一致が必要です）` });
  }
}

/** 手がかりが段階1か5だけで、必須の照合も名前の候補もない target か。 */
function isWeakTarget(t: Target): boolean {
  if (t.require !== undefined) return false;
  if (t.role !== undefined || t.label !== undefined || t.text !== undefined) return false;
  if (t.name !== undefined) return false;
  return true;
}

/** `role` があるのに `name` がない target か（役割だけでは同じ役割の別の要素と取り違える）。 */
function isRoleWithoutName(t: Target): boolean {
  return t.role !== undefined && t.name === undefined;
}

const WEAK_MESSAGE =
  '手がかりが testId・css だけで、require も名前の候補（name・label・text）もありません。別の要素と取り違えても気づけないため、require か名前の候補を足してください';

const ROLE_WITHOUT_NAME_MESSAGE =
  'role だけで name がありません。同じ役割の要素が複数あると別の要素と取り違えるため、name を足してください';

/** target の警告のメッセージ。警告がなければ undefined（1つの target に警告は1件）。 */
function targetWarning(t: Target): string | undefined {
  if (isWeakTarget(t)) return WEAK_MESSAGE;
  if (isRoleWithoutName(t)) return ROLE_WITHOUT_NAME_MESSAGE;
  return undefined;
}

/** ツアー全体の規則を検査する。エラーがあっても、見つかったものはすべて返す。 */
export function validateTourRules(tour: Tour): RuleResult {
  const errors: RuleIssue[] = [];
  const warnings: RuleIssue[] = [];
  const origins = new Set(tour.origins);
  const tabs = tour.tabs ?? {};
  // 役割 main は tabs に書かなくても使える
  const roleDefined = (role: string): boolean => role === 'main' || Object.hasOwn(tabs, role);

  for (const [role, tab] of Object.entries(tabs)) {
    if (tab.open !== undefined) checkOpenUrl(tab.open, ['tabs', role, 'open'], origins, errors);
    if (tab.url !== undefined) checkUrlCond(tab.url, ['tabs', role, 'url'], origins, errors);
  }

  const seenIds = new Set<string>();
  tour.steps.forEach((step, i) => {
    const at = ['steps', i];
    if (seenIds.has(step.id)) {
      errors.push({ path: [...at, 'id'], message: 'step の id が重複しています。id はツアー内で一意にしてください' });
    }
    seenIds.add(step.id);

    if (step.open !== undefined) checkOpenUrl(step.open, [...at, 'open'], origins, errors);
    if (step.url !== undefined) checkUrlCond(step.url, [...at, 'url'], origins, errors);
    if (step.done?.url !== undefined) checkUrlCond(step.done.url, [...at, 'done', 'url'], origins, errors);

    if (step.kind === 'page') {
      if (!roleDefined(step.tab)) {
        errors.push({ path: [...at, 'tab'], message: 'tab に指定した役割が tabs に定義されていません' });
      } else if (step.url === undefined && tabs[step.tab]?.url === undefined) {
        errors.push({
          path: at,
          message: 'kind が page のステップには url か、役割の tabs.<役割>.url のどちらかが必要です',
        });
      }
    }

    const stepWarning = step.target === undefined ? undefined : targetWarning(step.target);
    if (stepWarning !== undefined) warnings.push({ path: [...at, 'target'], message: stepWarning });
    const doneWarning = step.done?.target === undefined ? undefined : targetWarning(step.done.target);
    if (doneWarning !== undefined) warnings.push({ path: [...at, 'done', 'target'], message: doneWarning });
  });

  return { errors, warnings };
}
