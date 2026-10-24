/**
 * サイドパネルに渡す状態の写し（`PanelView`）の組み立て。ページから読んだ名前の文字列は含めない。
 * 一覧の進捗は、削除待ちの `{ tourId, sessionId }` に当たるものを出さない（完了・終了した実行回の「続きから」を出さないため）。
 */
import type { Tour } from '../../core/tour/index.ts';
import { has } from '../../shared/permissions/index.ts';
import type { CatalogEntry, PanelView, TabView } from '../../shared/messages/index.ts';
import type { CatalogPort, TabEvaluation } from '../ports.ts';
import type { Store } from './store.ts';
import { DEFAULT_UI, type Settings, type TourState } from './state.ts';
import type { SessionDeps } from './types.ts';
import { DEFAULT_LEVEL } from '../../shared/logger/index.ts';

export interface ViewInput {
  readonly deps: SessionDeps;
  readonly store: Store;
  readonly state: TourState | null;
  /** 固定したツアーの内容（取れなければ null）。 */
  readonly pinned: { readonly tour: Tour; readonly source: 'bundled' | 'imported' } | null;
  readonly settings: Settings | null;
  /** 現在のステップの、役割のタブの今の評価（実行中の page ステップだけ）。 */
  readonly evaluation: TabEvaluation | null;
}

async function catalogView(
  deps: SessionDeps,
  store: Store,
  catalog: CatalogPort,
): Promise<CatalogEntry[]> {
  const [entries, progress, pending] = await Promise.all([
    catalog.list().catch(() => []),
    store.readProgress(),
    store.readPendingDeletes(),
  ]);
  const pendingList = pending ?? [];
  return Promise.all(
    entries.map(async (entry) => {
      const tour = entry.tour;
      const saved = progress?.get(tour.id) ?? null;
      const hidden =
        saved !== null &&
        pendingList.some((p) => p.tourId === tour.id && p.sessionId === saved.sessionId);
      const [hasPermission, needsReview] = await Promise.all([
        has(tour, deps.permissions),
        deps.diagnostics.needsReview(tour.id).catch(() => false),
      ]);
      return {
        id: tour.id,
        name: tour.name,
        description: tour.description ?? null,
        stepCount: tour.steps.length,
        origins: [...tour.origins],
        source: entry.source,
        hasPermission,
        needsReview,
        progress:
          saved === null || hidden
            ? null
            : { stepIndex: saved.stepIndex, stepId: saved.stepId, savedAt: saved.savedAt },
      };
    }),
  );
}

function tabView(evaluation: TabEvaluation): TabView {
  return {
    role: evaluation.role,
    status: evaluation.status,
    candidates: evaluation.candidates.map((c) => ({
      tabId: c.tabId,
      title: c.title,
      windowId: c.windowId,
      boundRole: c.boundRole,
    })),
    attended: evaluation.attended,
    selected: evaluation.selected,
  };
}

export async function buildView(input: ViewInput): Promise<PanelView> {
  const { deps, store, state, pinned, settings, evaluation } = input;
  const catalog = await catalogView(deps, store, deps.catalog);
  const ui = settings?.miniGuide ?? DEFAULT_UI;
  const logLevel = settings?.logLevel ?? DEFAULT_LEVEL;
  if (state === null) {
    return {
      status: 'idle',
      pauseReason: null,
      sessionId: null,
      gen: null,
      tour: null,
      steps: [],
      stepIndex: 0,
      tabStatus: null,
      overlayHidden: false,
      hint: { met: false, unsupported: false, stopped: false },
      saveError: false,
      notice: null,
      catalog,
      ui,
      logLevel,
    };
  }
  const running = state.status === 'running';
  const hintFresh = running && state.hint.gen === state.gen;
  const donePage = evaluation?.status === 'donePage';
  return {
    status: state.status,
    pauseReason: state.status === 'paused' ? state.pauseReason : null,
    sessionId: state.sessionId,
    gen: state.gen,
    tour:
      pinned === null
        ? null
        : {
            id: pinned.tour.id,
            name: pinned.tour.name,
            hash: state.hash,
            origins: [...pinned.tour.origins],
            source: pinned.source,
          },
    steps: pinned === null ? [] : pinned.tour.steps.map((s) => ({ id: s.id, title: s.title, kind: s.kind })),
    stepIndex: state.stepIndex,
    tabStatus: running && evaluation !== null ? tabView(evaluation) : null,
    overlayHidden: state.overlayHidden,
    hint: {
      met: donePage || (hintFresh && state.hint.met),
      unsupported: hintFresh && state.hint.unsupported,
      stopped: running && evaluation !== null && !evaluation.selected,
    },
    saveError: state.saveError,
    notice: state.notice,
    catalog,
    ui,
    logLevel,
  };
}
