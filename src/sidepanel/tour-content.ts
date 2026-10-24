/**
 * 実行中のツアーの、`PanelView` に無い項目（説明文・補足画像・対象・完了の目安・開く URL・タブの表示名）を読む。
 * 取り込みは IndexedDB の `tours` の `compiled`（`CompiledTourSchema` で検証）と `files` の Blob、
 * 同梱は `tours/<id>/tour.yaml` と `tours/<id>/<path>` の取得で得る。読めないものは null（呼び出し側が代替を出す）。
 * 取り込みは `hash` が実行中のものと違えば（上書きされた後など）旧版の内容は無いので null。
 */
import { TOUR_FILE, resolveRelative } from '../core/package/index.ts';
import { CompiledTourSchema, parseTour } from '../core/tour/index.ts';
import type { Step, Tour } from '../core/tour/index.ts';
import type { TourSource } from '../shared/messages/index.ts';
import type { PanelDeps } from './deps.ts';

type ContentDeps = Pick<PanelDeps, 'getUrl' | 'fetchText' | 'readTourRecord' | 'readStoredFile'>;

/** 画面が使うツアーの内容。 */
export interface TourContent {
  steps: readonly Step[];
  tabs: Tour['tabs'];
}

export async function loadTourContent(
  deps: ContentDeps,
  source: TourSource,
  tourId: string,
  hash: string,
): Promise<TourContent | null> {
  try {
    if (source === 'bundled') {
      const text = await deps.fetchText(deps.getUrl(`tours/${tourId}/${TOUR_FILE}`));
      if (text === null) return null;
      const parsed = parseTour(text, TOUR_FILE);
      return parsed.ok ? { steps: parsed.tour.steps, tabs: parsed.tour.tabs } : null;
    }
    const record = await deps.readTourRecord(tourId);
    if (record?.hash !== hash) return null;
    const compiled = CompiledTourSchema.safeParse(record.compiled);
    return compiled.success ? { steps: compiled.data.steps, tabs: compiled.data.tabs } : null;
  } catch {
    return null;
  }
}

/** ステップの説明文。`baseFile` は、Markdown 内の画像の相対パスの起点（パッケージ内のパス）。 */
export interface StepBody {
  text: string;
  baseFile: string;
}

export async function loadStepBody(
  deps: ContentDeps,
  source: TourSource,
  tourId: string,
  hash: string,
  step: Pick<Step, 'body' | 'bodyFile'>,
): Promise<StepBody | null> {
  if (step.body !== undefined) return { text: step.body, baseFile: TOUR_FILE };
  if (step.bodyFile === undefined) return { text: '', baseFile: TOUR_FILE };
  const resolved = resolveRelative(TOUR_FILE, step.bodyFile);
  if (!resolved.ok) return null;
  try {
    if (source === 'bundled') {
      const text = await deps.fetchText(deps.getUrl(`tours/${tourId}/${resolved.path}`));
      return text === null ? null : { text, baseFile: resolved.path };
    }
    const blob = await deps.readStoredFile(tourId, hash, resolved.path);
    return blob === null ? null : { text: await blob.text(), baseFile: resolved.path };
  } catch {
    return null;
  }
}
