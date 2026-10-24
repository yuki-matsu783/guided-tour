/**
 * URL 条件と URL の照合。
 * 入力は検証済みの `UrlCond` と任意の文字列で、戻り値は真偽値だけ。解析できない URL は例外にせず不一致とする。
 * 手間は「パターンの区間数 × URL の区間数」以内で、正規表現は使わない。
 */
import { TOUR_LIMITS } from './limits.ts';
import type { UrlCond } from './schema.ts';

/** パスを区間に分ける。空の区間（連続する `/`、末尾の `/`）は詰める。 */
export function splitSegments(path: string): string[] {
  return path.split('/').filter((s) => s !== '');
}

/** 照合の手間を測るためのカウンタ（テスト用。省略可）。 */
export interface MatchStats {
  steps: number;
}

/**
 * 区間単位の glob 照合。`*` は1区間、`**` は0個以上の区間に一致する。
 * 動的計画法で、状態数は pattern.length × segments.length に収まる。
 */
export function matchGlobSegments(
  pattern: readonly string[],
  segments: readonly string[],
  stats?: MatchStats,
): boolean {
  const n = segments.length;
  // next[j]: 「パターンの i+1 以降」が「URL の j 以降」に一致するか
  let next: boolean[] = Array.from({ length: n + 1 }, (_, j) => j === n);
  for (let i = pattern.length - 1; i >= 0; i--) {
    const p = pattern[i];
    const cur: boolean[] = new Array<boolean>(n + 1).fill(false);
    const isStarStar = p === '**';
    cur[n] = isStarStar && (next[n] ?? false);
    for (let j = n - 1; j >= 0; j--) {
      if (stats) stats.steps += 1;
      if (isStarStar) {
        // 0区間で抜ける、または1区間を飲み込んで続ける
        cur[j] = (next[j] ?? false) || (cur[j + 1] ?? false);
      } else if (p === '*' || p === segments[j]) {
        cur[j] = next[j + 1] ?? false;
      }
    }
    next = cur;
  }
  return next[0] ?? false;
}

function matchPath(path: NonNullable<UrlCond['path']>, segments: string[]): boolean {
  if (path.exact !== undefined) {
    const p = splitSegments(path.exact);
    return p.length === segments.length && p.every((s, i) => s === segments[i]);
  }
  if (path.prefix !== undefined) {
    const p = splitSegments(path.prefix);
    return p.length <= segments.length && p.every((s, i) => s === segments[i]);
  }
  if (path.glob !== undefined) {
    return matchGlobSegments(splitSegments(path.glob), segments);
  }
  return false;
}

/**
 * URL が URL 条件に一致するかを返す。
 * クエリ・フラグメント・末尾の `/` は無視し、大文字・小文字は区別する。
 * 解析できない URL、http/https 以外、区間が256を超える URL は一致しない。
 */
export function matchUrl(cond: UrlCond, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.origin !== cond.origin) return false;
  const segments = splitSegments(parsed.pathname);
  if (segments.length > TOUR_LIMITS.urlSegments) return false;
  if (cond.path === undefined) return true;
  return matchPath(cond.path, segments);
}
