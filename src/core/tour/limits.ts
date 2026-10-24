/**
 * ツアー形式・URL 条件の上限値。
 * 値の正は docs/design/constraints.md の「上限値」。スキーマ・照合・テストが同じ値を参照する。
 */
export const TOUR_LIMITS = {
  /** ステップ数 */
  steps: 200,
  /** 1つの手がかり（name・label・text・css など）や origins・tabs の件数 */
  candidates: 20,
  /** URL 条件のパスの文字数 */
  pathChars: 200,
  /** URL 条件のパスの区間数 */
  pathSegments: 32,
  /** URL 条件の glob に書ける `**` の個数 */
  globStars: 4,
  /** 照合する URL の区間数。超えたら一致しないとみなす */
  urlSegments: 256,
  /** YAML のエイリアス展開数 */
  yamlAliases: 100,
  /** YAML の入れ子の深さ */
  yamlDepth: 32,
  /** parseTour が返すエラー・警告の最大件数 */
  issues: 20,
} as const;
