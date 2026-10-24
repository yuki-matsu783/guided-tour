/**
 * サイドパネルに渡す状態の写し（`PanelView`）の組み立て。ページから読んだ名前の文字列は含めない。
 * 固定した版が取れない一時中断では、`tour` を一覧の現在の版から補う。
 * 一覧の進捗は、削除待ちの `{ tourId, sessionId }` に当たるものを出さない（完了・終了した実行回の「続きから」を出さないため）。
 */
import type { Tour } from '../../core/tour/index.ts';
import { has } from '../../shared/permissions/index.ts';
import type { CatalogEntry, PanelView, TabView } from '../../shared/messages/index.ts';
import type { CatalogEntry as CatalogEntryInternal, CatalogPort, TabEvaluation } from '../ports.ts';
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
): Promise<{ views: CatalogEntry[]; entries: CatalogEntryInternal[] }> {
  const [entries, progress, pending] = await Promise.all([
    catalog.list().catch(() => []),
    store.readProgress(),
    store.readPendingDeletes(),
  ]);
  const pendingList = pending ?? [];
  const views = await Promise.all(
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
  return { views, entries };
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

/** 役割の ID と表示名の一覧。役割 `main` は `tabs` に書かなくても使えるので、先頭に補う。 */
function roleLabels(tour: Tour): PanelView['roles'] {
  const tabs = tour.tabs ?? {};
  const roles = Object.entries(tabs).map(([id, tab]) => ({ id, label: tab.label ?? id }));
  return Object.hasOwn(tabs, 'main') ? roles : [{ id: 'main', label: 'main' }, ...roles];
}

/**
 * 固定した版が取れない一時中断（再起動後に上書きされたとき）の `tour`。
 * 名前・`origins` は、ツアー管理の現在の版（新版）から取る。現在の版も無ければ null。
 */
function currentTourView(state: TourState, entries: readonly CatalogEntryInternal[]): PanelView['tour'] {
  if (state.status !== 'paused') return null;
  const current = entries.find((e) => e.tour.id === state.tourId);
  if (current === undefined) return null;
  return {
    id: current.tour.id,
    name: current.tour.name,
    hash: current.hash,
    origins: [...current.tour.origins],
    source: current.source,
  };
}

export async function buildView(input: ViewInput): Promise<PanelView> {
  const { deps, store, state, pinned, settings, evaluation } = input;
  const { views: catalog, entries } = await catalogView(deps, store, deps.catalog);
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
      roles: [],
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
        ? currentTourView(state, entries)
        : {
            id: pinned.tour.id,
            name: pinned.tour.name,
            hash: state.hash,
            origins: [...pinned.tour.origins],
            source: pinned.source,
          },
    steps: pinned === null ? [] : pinned.tour.steps.map((s) => ({ id: s.id, title: s.title, kind: s.kind })),
    stepIndex: state.stepIndex,
    roles: pinned === null ? [] : roleLabels(pinned.tour),
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
