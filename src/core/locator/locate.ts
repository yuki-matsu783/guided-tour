/**
 * 要素特定エンジン。target の手がかりを段階1〜5の順に試し、一意に決まる操作対象と、ハイライトする要素を返す。
 * 入力は target・Document・env。DOM は読むだけで変更しない。
 * 返す結果は列挙値・数値・要素だけで、名前や表示文字列は含めない（照合の結果だけを使う）。
 * 失敗しても例外は投げず、`missing` として返す。再検証の間隔やスクロールは呼ぶ側の責務。
 */
import { containsAnyName, matchesAnyName } from './normalize';
import type {
  LocateOptions,
  LocateReason,
  LocateResult,
  LocatorEnv,
  LocatorTarget,
  LocatorWithin,
  Tier,
  TierCount,
} from './types';

const TIERS: readonly Tier[] = [1, 2, 3, 4, 5];
const DEFAULT_TEXT_TAGS = ['button', 'a', 'label', '[role]'];
/** 段階3で、ラベルの照合の対象にするフォーム部品（タグと役割）。 */
const FORM_CONTROL_TAGS = new Set(['input', 'select', 'textarea', 'meter', 'progress', 'output']);
const FORM_CONTROL_ROLES = new Set([
  'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'listbox',
]);
/** 読み替え先が表示領域を覆うかの判定の許容（px）。 */
const COVER_TOLERANCE = 1;

/** 手がかり（候補の配列か `{ values, within? }`）。 */
type Clue = NonNullable<LocatorTarget['name']>;

/** 手がかりの候補。書かれていなければ空。 */
function clueValues(clue: Clue | undefined): readonly string[] {
  if (clue === undefined) return [];
  return Array.isArray(clue) ? clue : clue.values;
}

/** 手がかりに書かれた範囲の上書き。なければ undefined、`page` はページ全体の明示。 */
function clueWithin(clue: Clue | undefined): LocatorWithin | 'page' | undefined {
  if (clue === undefined || Array.isArray(clue)) return undefined;
  return clue.within;
}

/** 段階の手がかりが書かれているか。 */
function hasClue(target: LocatorTarget, tier: Tier): boolean {
  switch (tier) {
    case 1: return target.tourId !== undefined || target.testId !== undefined;
    case 2: return target.role !== undefined;
    case 3: return clueValues(target.label).length > 0;
    case 4: return clueValues(target.text).length > 0;
    case 5: return clueValues(target.css).length > 0;
  }
}

function safeQueryAll(root: ParentNode, selector: string): Element[] {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

/** 自前の表示のホスト要素、またはその中身か。 */
function isInsideOwnHost(el: Element, env: LocatorEnv): boolean {
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (env.isOwnHost(node)) return true;
  }
  return false;
}

function isFormControl(el: Element, env: LocatorEnv): boolean {
  const tag = el.localName;
  if (FORM_CONTROL_TAGS.has(tag)) {
    return !(tag === 'input' && el.getAttribute('type')?.toLowerCase() === 'hidden');
  }
  const role = env.computeRole(el);
  return role !== null && FORM_CONTROL_ROLES.has(role);
}

/** root の子孫のうち、自前の表示のホスト以外の要素。 */
function descendants(root: ParentNode, env: LocatorEnv): Element[] {
  return safeQueryAll(root, '*').filter((el) => !isInsideOwnHost(el, env));
}

function byRoleAndName(
  root: ParentNode,
  role: string,
  names: readonly string[],
  env: LocatorEnv,
): Element[] {
  return descendants(root, env).filter(
    (el) =>
      env.computeRole(el) === role &&
      (names.length === 0 || matchesAnyName(env.computeName(el), names)),
  );
}

function byLabel(root: ParentNode, labels: readonly string[], env: LocatorEnv): Element[] {
  return descendants(root, env).filter(
    (el) => isFormControl(el, env) && matchesAnyName(env.computeName(el), labels),
  );
}

/** 処理1: `within` を解決する。ちょうど1件でなければ null（その手がかりは失敗）。 */
function resolveWithin(within: LocatorWithin, doc: Document, env: LocatorEnv): Element | null {
  let found: Element[];
  if ('css' in within) {
    found = safeQueryAll(doc, within.css).filter((el) => !isInsideOwnHost(el, env));
  } else if ('label' in within) {
    found = byLabel(doc, within.label, env);
  } else {
    found = byRoleAndName(doc, within.role, within.name, env);
  }
  const [only] = found;
  return found.length === 1 && only ? only : null;
}

/**
 * 段階4の「最も内側」: 一致した要素のうち、別の一致した要素を子孫に持つものを除く。
 * 各要素の祖先を辿り、集合に入っている祖先を外す（要素数 × 深さ）。
 */
function keepInnermost(matched: readonly Element[]): Element[] {
  const inSet = new Set<Element>(matched);
  const outer = new Set<Element>();
  for (const el of matched) {
    for (let node = el.parentElement; node; node = node.parentElement) {
      if (inSet.has(node)) outer.add(node);
    }
  }
  return matched.filter((el) => !outer.has(el));
}

function collectTier1(target: LocatorTarget, root: ParentNode, env: LocatorEnv): Element[] {
  const found = new Set<Element>();
  if (target.tourId !== undefined) {
    for (const el of safeQueryAll(root, '[data-tour-id]')) {
      if (el.getAttribute('data-tour-id') === target.tourId) found.add(el);
    }
  }
  if (target.testId !== undefined) {
    for (const el of safeQueryAll(root, '[data-testid]')) {
      if (el.getAttribute('data-testid') === target.testId) found.add(el);
    }
  }
  return Array.from(found).filter((el) => !isInsideOwnHost(el, env));
}

function collectTier4(target: LocatorTarget, root: ParentNode, env: LocatorEnv): Element[] {
  const texts = clueValues(target.text);
  const selector = (target.textTag ?? DEFAULT_TEXT_TAGS).join(',');
  const test = target.match === 'contains' ? containsAnyName : matchesAnyName;
  // 最も内側への絞り込みは、必須の照合と表示の確認の後に evaluate が行う
  return safeQueryAll(root, selector).filter(
    (el) => !isInsideOwnHost(el, env) && test(env.visibleText(el), texts),
  );
}

/** header・footer が banner・contentinfo にならない祖先（HTML-AAM）。 */
const SECTIONING_TAGS = new Set(['article', 'aside', 'main', 'nav', 'section']);

/** aria-label か、中身のある aria-labelledby で名前が付いているか。 */
function hasLabelAttribute(el: Element): boolean {
  if ((el.getAttribute('aria-label') ?? '').trim() !== '') return true;
  const ids = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/u).filter((id) => id !== '');
  return ids.some((id) => el.ownerDocument.getElementById(id) !== null);
}

/**
 * ランドマークの役割を HTML-AAM に合わせて求める。
 * role 属性があればその計算結果を使う。header・footer は sectioning 要素の中では banner・contentinfo にならず、
 * section・form は名前（aria-label・aria-labelledby）があるときだけ region・form になる。
 */
function landmarkRole(el: Element, env: LocatorEnv): string | null {
  const role = env.computeRole(el);
  if ((el.getAttribute('role') ?? '').trim() !== '') return role;
  switch (el.localName) {
    case 'header':
    case 'footer':
      for (let node = el.parentElement; node; node = node.parentElement) {
        if (SECTIONING_TAGS.has(node.localName)) return null;
      }
      return role;
    case 'section':
    case 'form':
      return hasLabelAttribute(el) ? role : null;
    default:
      return role;
  }
}

/** 領域（ランドマーク）の中にあるか。要素自身は数えない。 */
function isInRegion(el: Element, region: string, env: LocatorEnv): boolean {
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (landmarkRole(node, env) === region) return true;
  }
  return false;
}

function satisfiesRequire(el: Element, require: NonNullable<LocatorTarget['require']>, env: LocatorEnv): boolean {
  if (require.role !== undefined && env.computeRole(el) !== require.role) return false;
  if (require.inputType !== undefined) {
    // ブラウザが正規化した type（属性が無い・未知の値は text）で比べる
    if (el.localName !== 'input' || !('type' in el) || typeof el.type !== 'string') return false;
    if (el.type.toLowerCase() !== require.inputType.toLowerCase()) return false;
  }
  if (require.region !== undefined && !isInRegion(el, require.region, env)) return false;
  if (require.name !== undefined && !matchesAnyName(env.computeName(el), require.name)) return false;
  return true;
}

/** 読み替え先が `html`・`body`、または表示領域全体を覆う要素か。 */
function isIneligible(el: Element, env: LocatorEnv): boolean {
  if (el.localName === 'html' || el.localName === 'body') return true;
  const { width, height } = env.viewport();
  // 表示領域の大きさが分からないときは判定しない
  if (width <= 0 || height <= 0) return false;
  const r = el.getBoundingClientRect();
  // 表示領域を包み、かつ表示領域より大きくない要素だけが「覆う」。大きいフォーム・表は採用する
  return (
    r.left <= COVER_TOLERANCE &&
    r.top <= COVER_TOLERANCE &&
    r.right >= width - COVER_TOLERANCE &&
    r.bottom >= height - COVER_TOLERANCE &&
    r.right - r.left <= width + COVER_TOLERANCE &&
    r.bottom - r.top <= height + COVER_TOLERANCE
  );
}

function closestOrNull(el: Element, selector: string): Element | null {
  try {
    // 操作対象自身は含めず、親から探す
    return el.parentElement?.closest(selector) ?? null;
  } catch {
    return null;
  }
}

/** 1回の試行（1つの候補の集まり）の結果。 */
interface Attempt {
  counts: { collected: number; required: number; visible: number };
  conflict: boolean;
  adopted: { target: Element; highlightEl: Element } | null;
}

/** 処理3〜7: 必須の照合、表示の確認、一意性、読み替え、不適格の確認。 */
function evaluate(
  tier: Tier,
  candidates: Element[],
  target: LocatorTarget,
  env: LocatorEnv,
  allowHidden: boolean,
): Attempt {
  const require = target.require;
  // 段階4は、各段階で絞った後に最も内側だけを残す
  const settle = (els: Element[]): Element[] => (tier === 4 ? keepInnermost(els) : els);
  const requiredAll = require ? candidates.filter((el) => satisfiesRequire(el, require, env)) : candidates;
  const visibleAll = allowHidden ? requiredAll : requiredAll.filter((el) => env.isVisible(el));
  const required = settle(requiredAll);
  const visible = settle(visibleAll);
  // 絞る前がちょうど1件で、それが捨てられたときだけ矛盾
  const conflict = settle(candidates).length === 1 && required.length === 0;
  const counts = { collected: settle(candidates).length, required: required.length, visible: visible.length };

  const [only] = visible;
  // 一意性の確認は読み替えの前に行う（同じ祖先に読み替えられる2件は採用しない）
  if (visible.length !== 1 || !only) return { counts, conflict, adopted: null };

  const highlightEl = target.highlight ? closestOrNull(only, target.highlight.closest) : only;
  if (!highlightEl) return { counts, conflict, adopted: null };
  if (!allowHidden && !env.isVisible(highlightEl)) return { counts, conflict, adopted: null };
  if (isIneligible(highlightEl, env)) return { counts, conflict, adopted: null };
  return { counts, conflict, adopted: { target: only, highlightEl } };
}

/** 段階の手がかりのうち、範囲を上書きできるもの。段階1は上書きできない。 */
function clueOfTier(tier: Tier, target: LocatorTarget): Clue | undefined {
  switch (tier) {
    case 1: return undefined;
    case 2: return target.name;
    case 3: return target.label;
    case 4: return target.text;
    case 5: return target.css;
  }
}

/** 段階の候補の集まりを、試行の単位ごとに返す。範囲の解決に失敗したら空配列（試行なし）。 */
function collectTries(
  tier: Tier,
  target: LocatorTarget,
  doc: Document,
  env: LocatorEnv,
): Element[][] | null {
  // 処理1: 探す範囲。その段階の手がかりの within（`page` はページ全体）、なければ target.within。段階1は target.within
  const within = clueWithin(clueOfTier(tier, target)) ?? target.within;
  let root: ParentNode = doc;
  if (within !== undefined && within !== 'page') {
    const scope = resolveWithin(within, doc, env);
    if (!scope) return null;
    root = scope;
  }
  // 処理2: 候補を集める
  switch (tier) {
    case 1: return [collectTier1(target, root, env)];
    case 2: return [byRoleAndName(root, target.role ?? '', clueValues(target.name), env)];
    case 3: return [byLabel(root, clueValues(target.label), env)];
    case 4: return [collectTier4(target, root, env)];
    case 5: return clueValues(target.css).map((css) => safeQueryAll(root, css).filter((el) => !isInsideOwnHost(el, env)));
  }
}

/** 処理8: 段階1・5の補助の照合。名前が一致しなければ真（nameMismatch）。 */
function hasNameMismatch(tier: Tier, target: LocatorTarget, el: Element, env: LocatorEnv): boolean {
  if (tier !== 1 && tier !== 5) return false;
  if (target.require?.name !== undefined) return false;
  const names = [...clueValues(target.name), ...clueValues(target.label), ...clueValues(target.text)];
  if (names.length === 0) return false;
  return !matchesAnyName(env.computeName(el), names);
}

/**
 * target から、一意に決まる操作対象とハイライトする要素を探す。
 *
 * 処理フロー:
 * 1. 手がかりが書かれた段階を、1〜5 の順に試す（最初の段階が `topTier`）。段階ごとに範囲を解決する（その段階の手がかりの `within`、なければ `target.within`。`page` かどちらもなければページ全体）。0件か2件以上ならその段階は失敗（ページ全体には広げない）
 * 2. 候補を集める（collectTries）。自前の表示のホスト要素とその中身は常に除外する。段階5は `css[]` の選択子ごとに別の試行にする
 * 3. 必須の照合で絞る（evaluate、satisfiesRequire）。絞る前がちょうど1件で捨てられたら `conflict` を記録する
 * 4. `allowHidden` がなければ、表示されていない候補を除く。段階4は、各絞り込みの後に「最も内側」だけを残す
 * 5. 操作対象がちょうど1件か確認する。そうでなければ次の試行・次の段階へ進む
 * 6. `highlight.closest` があれば、ハイライトする要素を祖先に読み替える
 * 7. 読み替えた要素（読み替えがなければ操作対象）が表示されていて、`html`・`body`・表示領域全体を覆う要素でないか確認する（isIneligible）。不適格なら失敗として次へ進む
 * 8. 段階1・5で採用し、名前の候補があり `require.name` がなければ、読み上げ名を照合する。不一致なら `nameMismatch` を記録する（採用はする）
 *
 * `counts` は、段階5では採用した選択子の数（採用がなければ最後に試した選択子の数）を入れる。
 * 全段階で失敗したら `missing`。上位の段階で失敗して下位で成功したら `degraded`。
 */
export function locate(
  target: LocatorTarget,
  doc: Document,
  env: LocatorEnv,
  options: LocateOptions = {},
): LocateResult {
  const allowHidden = options.allowHidden === true;
  const tiers = TIERS.filter((tier) => hasClue(target, tier));
  const topTier = tiers[0] ?? null;
  const counts: TierCount[] = [];
  let conflict = false;
  let adopted: { tier: Tier; target: Element; highlightEl: Element } | null = null;

  for (const tier of tiers) {
    const tries = collectTries(tier, target, doc, env);
    if (!tries) {
      counts.push({ tier, collected: 0, required: 0, visible: 0 });
      continue;
    }
    let last: Attempt | null = null;
    for (const candidates of tries) {
      const attempt = evaluate(tier, candidates, target, env, allowHidden);
      last = attempt;
      conflict ||= attempt.conflict;
      if (attempt.adopted) {
        adopted = { tier, ...attempt.adopted };
        break;
      }
    }
    counts.push({ tier, ...(last?.counts ?? { collected: 0, required: 0, visible: 0 }) });
    if (adopted) break;
  }

  const reasons: LocateReason[] = [];
  if (adopted && adopted.tier !== topTier) reasons.push('degraded');
  if (conflict) reasons.push('conflict');
  if (!adopted) reasons.push('missing');
  if (adopted && hasNameMismatch(adopted.tier, target, adopted.target, env)) reasons.push('nameMismatch');

  return {
    found: adopted !== null,
    tier: adopted?.tier ?? null,
    topTier,
    reasons,
    counts,
    target: adopted?.target ?? null,
    highlightEl: adopted?.highlightEl ?? null,
  };
}
