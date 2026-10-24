/**
 * Markdown 描画で使う URL の判定（リンクの方式・画像の許可・宣言済みホストの照合）。
 * 入力は文字列だけで、DOM にも拡張機能 API にも触れない。
 * 判定に失敗した値は「許可しない」側に倒す（例外は外へ出さない）。
 */

/** リンクとして有効な URL を解析した結果。 */
export interface ParsedLink {
  /** 正規化後のホスト名（日本語ドメインは punycode、小文字）。 */
  readonly hostname: string;
}

/**
 * http / https のリンクだけを解析する。
 * 相対パス・方式なし・その他の方式（javascript: や mailto: など）は null。
 * 方式の大文字小文字は URL の解析が吸収する。
 */
export function parseHttpLink(href: string): ParsedLink | null {
  try {
    const url = new URL(href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.hostname === '') return null;
    return { hostname: url.hostname };
  } catch {
    return null;
  }
}

/**
 * `origins` の各要素からホスト名を取り出して集める。
 * URL として読めない要素は、ホスト名そのものとして小文字で扱う。
 * 方式・ポートは比較に使わない。サブドメインは別のホスト。
 */
export function toHostnameSet(origins: readonly string[]): Set<string> {
  const hosts = new Set<string>();
  for (const origin of origins) {
    try {
      hosts.add(new URL(origin).hostname);
    } catch {
      hosts.add(origin.toLowerCase());
    }
  }
  return hosts;
}

/** 許可する data URL（画像の種類を限る。SVG は含めない）。 */
const ALLOWED_DATA_URL = /^data:image\/(?:png|jpeg|gif|webp)[;,]/i;

/** 拡張機能内の URL と blob URL の先頭。 */
const ALLOWED_PREFIXES = ['chrome-extension://', 'blob:'];

/** 画像の `src` に使ってよい URL か。許可するのは拡張機能内・blob・許可された data URL だけ。 */
export function isAllowedImageUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    ALLOWED_PREFIXES.some((prefix) => lower.startsWith(prefix)) ||
    ALLOWED_DATA_URL.test(url)
  );
}
