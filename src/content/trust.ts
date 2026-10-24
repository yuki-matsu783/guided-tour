/**
 * 利用者の実際の操作かの判定。ページのスクリプトが発生させたイベントは `isTrusted` が偽になる。
 * 判定は差し替えられる（試験では jsdom が `isTrusted` を真にできないため）。
 */

export type TrustCheck = (event: Event) => boolean;

export const defaultTrust: TrustCheck = (event) => event.isTrusted;
