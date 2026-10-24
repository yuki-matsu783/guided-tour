/**
 * パッケージ取り込みの上限値。
 * 値の正は docs/design/constraints.md の「上限値」。MB・KB は 2 進（1 MB = 1,048,576 バイト）で数える。
 */
const KB = 1024;
const MB = 1024 * KB;

export const PACKAGE_LIMITS = {
  /** zip ファイル（圧縮時）のバイト数 */
  zipBytes: 20 * MB,
  /** 展開後の合計バイト数（実際に展開した量で数える） */
  expandedBytes: 50 * MB,
  /** パッケージ内のファイル数（ディレクトリのエントリは数えない） */
  fileCount: 500,
  /** zip の項目の総数（ファイル・ディレクトリ・名前の不正な項目をすべて数える） */
  entryCount: 2000,
  /** 取り込み済みツアー全体の合計容量 */
  totalBytes: 200 * MB,
  /** 画像1枚のバイト数 */
  imageBytes: 5 * MB,
  /** 画像の幅・高さの上限（px） */
  imageSide: 4096,
  /** 画像の画素数の上限 */
  imagePixels: 16_000_000,
  /** `tour.yaml`・単体 YAML のバイト数 */
  yamlBytes: 1 * MB,
  /** Markdown ファイル1つのバイト数 */
  markdownBytes: 200 * KB,
  /** zip の圧縮側を展開器へ渡す1回の大きさ（打ち切りの精度を決める） */
  chunkBytes: 4 * KB,
  /** JPEG の SOF を探して走査する最大のバイト数 */
  jpegScanBytes: 1 * MB,
  /** JPEG の SOF を探して辿る最大のマーカー数 */
  jpegScanMarkers: 4096,
  /** 返すエラーの最大件数 */
  issues: 20,
} as const;

/** 上限のバイト数を「20 MB」「200 KB」の形にする。 */
export function formatBytesLimit(bytes: number): string {
  if (bytes >= MB && bytes % MB === 0) return `${String(bytes / MB)} MB`;
  if (bytes >= KB && bytes % KB === 0) return `${String(bytes / KB)} KB`;
  return `${String(bytes)} バイト`;
}
