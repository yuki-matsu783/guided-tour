/**
 * 同梱ツアーの読み込み。`tours/index.json`（`{ "tours": ["<id>", ...] }`）と各 `tours/<id>/tour.yaml` を取得し、
 * `parseTour` で解析して、`tour.yaml` の内容の SHA-256（16進）を `hash` にする。
 * 同梱は信頼できるデータなのでバックグラウンドで解析してよい。1件の失敗は、その1件だけを外す。
 */
import { z } from 'zod';
import { parseTour } from '../../core/tour/index.ts';
import type { Tour } from '../../core/tour/index.ts';

export interface BundledTour {
  readonly tour: Tour;
  readonly hash: string;
}

export interface BundledSource {
  /** `chrome.runtime.getURL` と同じ形。 */
  getUrl(path: string): string;
  fetch(url: string): Promise<{ ok: boolean; text(): Promise<string> }>;
}

const IndexSchema = z.object({ tours: z.array(z.string()) });
/** ディレクトリ名に使える ID（パスをたどる文字を含むものは読まない）。 */
const SAFE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function fetchText(source: BundledSource, path: string): Promise<string | null> {
  try {
    const response = await source.fetch(source.getUrl(path));
    return response.ok ? await response.text() : null;
  } catch {
    return null;
  }
}

async function loadOne(source: BundledSource, id: string): Promise<BundledTour | null> {
  const yamlText = await fetchText(source, `tours/${id}/tour.yaml`);
  if (yamlText === null) return null;
  const parsed = parseTour(yamlText, 'tour.yaml');
  // ディレクトリ名と ID が違うものは、取り違えを避けるため外す
  if (!parsed.ok || parsed.tour.id !== id) return null;
  return { tour: parsed.tour, hash: await sha256Hex(yamlText) };
}

/** 一覧に載った同梱ツアーをすべて読む。一覧が読めなければ空。 */
export async function loadBundledTours(source: BundledSource): Promise<BundledTour[]> {
  const raw = await fetchText(source, 'tours/index.json');
  if (raw === null) return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return [];
  }
  const index = IndexSchema.safeParse(json);
  if (!index.success) return [];
  const loaded = await Promise.all(index.data.tours.filter((id) => SAFE_ID.test(id)).map((id) => loadOne(source, id)));
  return loaded.flatMap((t) => (t === null ? [] : [t]));
}
