/**
 * 拡張機能のバージョン（`1.2.3` のような数字とドット）の比較。
 */

function parts(version: string): number[] {
  return version.split('.').map((p) => {
    const n = Number.parseInt(p, 10);
    return Number.isNaN(n) ? 0 : n;
  });
}

/** `a` が新しければ正、同じなら 0、古ければ負。足りない桁は 0 とみなす。 */
export function compareVersions(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
