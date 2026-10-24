/**
 * 名前の正規化と照合。
 * 要素特定エンジンの名前の照合と、完了の目安の監視で同じ規則を使うために公開する。
 */

/** NFKC 正規化、空白のまとめ、前後の空白の削除、英字の小文字化を行う。 */
export function normalizeName(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
}

/** 正規化後の完全一致。候補のいずれかに一致すれば真。 */
export function matchesAnyName(value: string, candidates: readonly string[]): boolean {
  const normalized = normalizeName(value);
  return candidates.some((c) => normalizeName(c) === normalized);
}

/** 正規化後の部分一致。候補のいずれかを含めば真。 */
export function containsAnyName(value: string, candidates: readonly string[]): boolean {
  const normalized = normalizeName(value);
  return candidates.some((c) => normalized.includes(normalizeName(c)));
}
