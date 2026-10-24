/**
 * 状態管理（バックグラウンド）。実行中のツアーの状態を持ち、操作を1本の直列化キューで処理する。
 *
 * 1つの操作は次の順で進める（途中のどこで Service Worker が止まっても、`recover()` で復帰できる）。
 *   1. 識別子（`opId`・`sessionId`・`gen`・`sender`）の検証  2. 次の状態の計算（タブの評価など、読むだけの処理を含む）
 *   3. storage.session へ書く（確定）  4. 進捗を storage.local へ書く  5. 外への作用（ページ側・サイドパネル）  6. 応答
 * 完了・終了は、状態を `ended`（`sessionId` を残す）として確定してから、進捗を削除する。
 * 書き込みに失敗したらメモリ上の状態で続け、`saveError` を立てる。次の確定で再び試し、すべて成功したら下ろす。
 * キューの中で、YAML・zip・画像の解析のような重い処理は行わない。
 */
import type { Step, Tour } from '../../core/tour/index.ts';
import {
  FIRST_GEN,
  INITIAL_PAGE_SEQ,
  INITIAL_REV,
  newSessionId,
  nextGen,
  nextPageSeq,
  parseSessionId,
  type Gen,
  type OpId,
} from '../../shared/ids/index.ts';
import { errorFields } from '../../shared/logger/index.ts';
import {
  OP_REQUIREMENTS,
  type Notice,
  type PageToBg,
  type PanelToBg,
  type PanelView,
  type PauseReason,
  type ResumeNewMode,
  type OpenInMode,
  type UiSettings,
} from '../../shared/messages/index.ts';
import { has } from '../../shared/permissions/index.ts';
import type { CatalogTour, RoleBinding, TabEvaluation, TabEvent } from '../ports.ts';
import {
  isShown,
  pageStepOf,
  planDisplay,
  sameSnapshot,
  snapshotOf,
  type DisplayMode,
  type Plan,
} from './display.ts';
import {
  DEFAULT_UI,
  RECENT_OP_LIMIT,
  SettingsSchema,
  clampWidth,
  type PendingDelete,
  type Settings,
  type TourState,
} from './state.ts';
import { createStore } from './store.ts';
import type {
  DiscardReason,
  PageResponse,
  PageSender,
  PanelResponse,
  RejectReason,
  SessionDeps,
  SessionResponse,
} from './types.ts';
import { ownValue } from './own.ts';
import { compareVersions } from './version.ts';
import { buildView } from './view.ts';

export interface Session {
  handlePanel(msg: { readonly type: 'GET_STATE' }): Promise<PanelView>;
  handlePanel(msg: PanelToBg): Promise<PanelResponse>;
  handlePage(msg: PageToBg, sender: PageSender): Promise<PageResponse>;
  onTabEvent(event: TabEvent): Promise<void>;
  onCatalogChanged(tourId: string, hash: string): Promise<void>;
  /** 取り込み版の削除。同じ ID の同梱版が残っていても、上書きにはせず終了する。 */
  onCatalogRemoved(tourId: string): Promise<void>;
  /** `permissions.onRemoved` で、実行中のツアーの権限が失われたとき。 */
  onPermissionLost(): Promise<void>;
  /** Service Worker 起動時の復帰（手順1〜4）。起動したらまず呼ぶ。 */
  recover(): Promise<void>;
  view(): Promise<PanelView>;
  /** 実行中のツアーの `origins`（`watchRemoved` に渡す）。実行中でなければ null。 */
  runningTour(): Pick<Tour, 'origins'> | null;
}

const DONE: SessionResponse = { status: 'done' };

function rejected(reason: RejectReason): SessionResponse {
  return { status: 'rejected', reason };
}

function pushOp(list: readonly OpId[], opId: OpId | undefined): OpId[] {
  if (opId === undefined) return [...list];
  return [...list, opId].slice(-RECENT_OP_LIMIT);
}

function findRole(state: TourState, tabId: number): string | undefined {
  return Object.entries(state.tabs).find(([, binding]) => binding.tabId === tabId)?.[0];
}

/** ツアーが使う役割（page ステップの役割と、`tabs` に宣言された役割）。 */
function rolesOfTour(tour: Tour): Set<string> {
  const roles = new Set(Object.keys(tour.tabs ?? {}));
  for (const step of tour.steps) {
    if (step.kind === 'page') roles.add(step.tab);
  }
  return roles;
}

function urlWithinOrigins(tour: Tour, url: string): boolean {
  try {
    return tour.origins.includes(new URL(url).origin);
  } catch {
    return false;
  }
}

type Ctx =
  | { readonly ok: true; readonly st: TourState; readonly tour: Tour }
  | { readonly ok: false; readonly res: SessionResponse };

/** 確定の1回分の指定。 */
interface FinishSpec {
  /** `rev`・`tabStatus` を除いた次の状態。 */
  readonly next: TourState;
  /** `plan`: 評価して描画指示を決める（一時中断・終了・guide は CLEAR）。`none`: 表示に触れない。 */
  readonly display: 'plan' | 'none';
  readonly mode?: DisplayMode;
  readonly sync?: boolean;
  readonly progress: 'save' | 'delete' | 'none';
  /** 計算済みの評価があれば再評価しない。 */
  readonly evaluation?: TabEvaluation | null;
  readonly ui?: UiSettings;
  /** 進捗と同じ段階で storage.local に書く設定。 */
  readonly settings?: Settings;
  /** 表示の後に行う外への作用。 */
  readonly extra?: () => Promise<void>;
}

export function createSession(deps: SessionDeps): Session {
  const store = createStore(deps.storageSession, deps.storageLocal);
  const log = deps.logger;

  let state: TourState | null = null;
  let loaded: Promise<void> | null = null;
  /** 進捗の書き込みに失敗していて、次の確定でやり直す必要があるか。 */
  let progressDirty = false;
  let settingsMemo: Settings | null = null;
  /** タブ管理へ最後に知らせた実行中のツアー（まだ知らせていなければ undefined）。 */
  let announcedTour: Tour | null | undefined;
  /** 固定したツアーの内容（同じ `hash` の内容は変わらないので、実行回の間はメモリに持つ）。 */
  const pinnedCache = new Map<string, CatalogTour>();
  /** 処理した操作の応答（重複して届いたとき、同じ結果を返す）。 */
  const results = new Map<string, SessionResponse>();

  // ---- 直列化キュー ----

  let tail: Promise<unknown> = Promise.resolve();
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function ensureLoaded(): Promise<void> {
    loaded ??= store.readState().then((s) => {
      state = s;
    });
    return loaded;
  }

  // ---- 読み取り（外への作用ではない） ----

  const cacheKey = (tourId: string, hash: string): string => `${tourId}\u0000${hash}`;

  function remember(entry: CatalogTour): void {
    pinnedCache.clear();
    pinnedCache.set(cacheKey(entry.tour.id, entry.hash), entry);
  }

  async function pinnedOf(st: TourState): Promise<CatalogTour | null> {
    const hit = pinnedCache.get(cacheKey(st.tourId, st.hash));
    if (hit !== undefined) return hit;
    try {
      const got = await deps.catalog.getPinned(st.tourId, st.hash);
      if (got !== null) remember(got);
      return got;
    } catch {
      return null;
    }
  }

  async function settings(): Promise<Settings> {
    const read = await store.readSettings();
    if (read !== null) {
      settingsMemo = read;
      return read;
    }
    return settingsMemo ?? SettingsSchema.parse({});
  }

  async function evaluate(tour: Tour, st: TourState): Promise<TabEvaluation | null> {
    const step = tour.steps[st.stepIndex];
    if (step?.kind !== 'page') return null;
    const roles: Record<string, RoleBinding> = Object.fromEntries(
      Object.entries(st.tabs).map(([role, b]) => [role, { tabId: b.tabId, documentId: b.documentId }]),
    );
    try {
      return await deps.tabs.evaluate(tour, step, roles);
    } catch (e) {
      log.error('error', errorFields(e, 'unknown'));
      return {
        role: step.tab,
        status: 'unsupported',
        selected: false,
        attended: false,
        candidates: [],
        focusedCandidate: null,
      };
    }
  }

  async function shortcutOf(): Promise<string | null> {
    try {
      return await deps.tabs.shortcut();
    } catch {
      return null;
    }
  }

  async function currentView(): Promise<PanelView> {
    await ensureLoaded();
    const st = state;
    const pinned = st === null ? null : await pinnedOf(st);
    const evaluation =
      st?.status === 'running' && pinned !== null ? await evaluate(pinned.tour, st) : null;
    return buildView({
      deps,
      store,
      state: st,
      pinned: pinned === null ? null : { tour: pinned.tour, source: pinned.source },
      settings: await settings(),
      evaluation,
    });
  }

  async function notify(): Promise<void> {
    try {
      await deps.notifyPanel(await currentView());
    } catch (e) {
      log.warn('error', errorFields(e, 'message'));
    }
  }

  // ---- 確定と外への作用 ----

  async function removeProgressOrPend(st: TourState): Promise<void> {
    if (await store.removeProgress(st.tourId, st.sessionId)) return;
    const list = await store.readPendingDeletes();
    if (list === null) {
      log.warn('error', { name: 'Unknown', reason: 'storage' });
      return;
    }
    if (list.some((p) => p.tourId === st.tourId && p.sessionId === st.sessionId)) return;
    await store.writePendingDeletes([...list, { tourId: st.tourId, sessionId: st.sessionId }]);
  }

  /** 状態の確定（storage.session）→ 進捗（storage.local）。失敗しても続け、`saveError` に反映する。 */
  async function commit(next: TourState, spec: Pick<FinishSpec, 'progress' | 'settings'>): Promise<void> {
    state = next;
    let ok = await store.writeState(next);
    let progress = spec.progress;
    if (progress === 'none' && progressDirty && next.status !== 'ended') progress = 'save';
    if (progress === 'save') {
      const saved = await store.saveProgress(next, deps.now());
      progressDirty = !saved;
      ok = ok && saved;
    } else if (progress === 'delete') {
      progressDirty = false;
      await removeProgressOrPend(next);
    }
    if (spec.settings !== undefined) {
      settingsMemo = spec.settings;
      if (!(await store.writeSettings(spec.settings))) {
        log.warn('error', { name: 'Unknown', reason: 'storage' });
      }
    }
    state = { ...next, saveError: !ok };
    // storage.session には、今回の進捗の結果を反映した値を残す（書き込み自体の成否は書けない）
    if (state.saveError !== next.saveError) await store.writeState(state);
  }

  /** 実行中のツアーをタブ管理に知らせる（実行中でなければ null）。変わったときだけ呼ぶ。 */
  async function announceTour(next: TourState): Promise<void> {
    const active = next.status === 'running' ? ((await pinnedOf(next))?.tour ?? null) : null;
    if (active === announcedTour) return;
    announcedTour = active;
    try {
      deps.tabs.setActiveTour(active);
    } catch (e) {
      log.warn('error', errorFields(e, 'message'));
    }
  }

  /** 計画した指示を送る。組み込みに失敗したら true。 */
  async function perform(plan: Plan, tour: Tour | null): Promise<boolean> {
    for (const send of plan.sends) {
      try {
        if (send.to === 'all') await deps.tabs.broadcast(send.message);
        else if (tour !== null) await deps.tabs.send(tour, send.tabId, send.message);
      } catch (e) {
        log.warn('error', errorFields(e, 'message'));
      }
    }
    if (plan.inject === null || tour === null) return false;
    try {
      return !(await deps.tabs.inject(tour, plan.inject));
    } catch (e) {
      log.warn('error', errorFields(e, 'message'));
      return true;
    }
  }

  function windowIdOf(next: TourState, tour: Tour | null, evaluation: TabEvaluation | null): number | null {
    const step = pageStepOf(tour, next);
    const binding = step === undefined ? undefined : ownValue(next.tabs, step.tab);
    if (binding === undefined || evaluation === null) return next.windowId;
    return evaluation.candidates.find((c) => c.tabId === binding.tabId)?.windowId ?? next.windowId;
  }

  async function finish(spec: FinishSpec): Promise<void> {
    const prev = state;
    let next = spec.next;
    let plan: Plan = { rev: next.rev, sends: [], inject: null };
    let tour: Tour | null = null;
    let ui: UiSettings = spec.ui ?? DEFAULT_UI;
    if (spec.display === 'plan') {
      if (next.status === 'running') tour = (await pinnedOf(next))?.tour ?? null;
      let evaluation: TabEvaluation | null = null;
      if (tour !== null) {
        evaluation = spec.evaluation !== undefined ? spec.evaluation : await evaluate(tour, next);
      }
      ui = spec.ui ?? (await settings()).miniGuide;
      const shortcut = evaluation !== null && isShown(evaluation.status) ? await shortcutOf() : null;
      plan = planDisplay({
        prev,
        next,
        tour,
        evaluation,
        ui,
        shortcut,
        mode: spec.mode ?? 'render',
        sync: spec.sync ?? false,
      });
      next = {
        ...next,
        rev: plan.rev,
        tabStatus: snapshotOf(evaluation),
        windowId: windowIdOf(next, tour, evaluation),
      };
    }

    await commit(next, spec);
    await announceTour(next);

    const injectFailed = await perform(plan, tour);
    if (spec.extra !== undefined) await spec.extra();
    if (injectFailed && tour !== null) await settleAfterInjectFailure(tour, ui);
    await notify();
  }

  /** 組み込みに失敗したとき、タブの状態（`unsupported` など）が変わっていれば1回だけ確定し直す。 */
  async function settleAfterInjectFailure(tour: Tour, ui: UiSettings): Promise<void> {
    const st = state;
    if (st?.status !== 'running') return;
    const evaluation = await evaluate(tour, st);
    if (sameSnapshot(snapshotOf(evaluation), st.tabStatus)) return;
    const shortcut = evaluation !== null && isShown(evaluation.status) ? await shortcutOf() : null;
    const plan = planDisplay({
      prev: st,
      next: st,
      tour,
      evaluation,
      ui,
      shortcut,
      mode: 'render',
      sync: false,
    });
    await commit({ ...st, rev: plan.rev, tabStatus: snapshotOf(evaluation) }, { progress: 'none' });
    await perform(plan, tour);
  }

  // ---- 受け付けの確認 ----

  function discard(reason: DiscardReason): SessionResponse {
    log.debug('session.discard', { reason });
    return { status: 'discarded', reason };
  }

  function identityProblem(
    msg: Extract<PanelToBg, { sessionId: unknown }>,
    st: TourState | null,
  ): DiscardReason | null {
    if (st === null || st.status === 'ended') return 'staleSession';
    if (msg.sessionId !== st.sessionId) return 'staleSession';
    if (OP_REQUIREMENTS[msg.type] === 'sessionGen' && 'gen' in msg && msg.gen !== st.gen) {
      return 'staleGen';
    }
    return null;
  }

  function rememberResult(opId: OpId, res: SessionResponse): void {
    results.set(opId, res);
    if (results.size > RECENT_OP_LIMIT) {
      const oldest = results.keys().next();
      if (!oldest.done) results.delete(oldest.value);
    }
  }

  /** 実行中で、固定したツアーの内容が取れるとき。 */
  async function needRunning(): Promise<Ctx> {
    const st = state;
    if (st?.status !== 'running') return { ok: false, res: rejected('notRunning') };
    const pinned = await pinnedOf(st);
    if (pinned === null) return { ok: false, res: rejected('tourNotFound') };
    return { ok: true, st, tour: pinned.tour };
  }

  // ---- 実行回の作成 ----

  function freshSessionId(): ReturnType<typeof newSessionId> {
    return parseSessionId(deps.randomId()) ?? newSessionId();
  }

  function newRun(a: {
    prev: TourState | null;
    entry: CatalogTour;
    index: number;
    notice: Notice | null;
    carryTabs: boolean;
    opId: OpId;
  }): TourState | null {
    const step = a.entry.tour.steps[a.index];
    if (step === undefined) return null;
    let tabs: TourState['tabs'] = {};
    if (a.carryTabs && a.prev !== null) {
      const roles = rolesOfTour(a.entry.tour);
      tabs = Object.fromEntries(Object.entries(a.prev.tabs).filter(([role]) => roles.has(role)));
    }
    return {
      status: 'running',
      pauseReason: null,
      sessionId: freshSessionId(),
      gen: FIRST_GEN,
      pageSeq: a.prev?.pageSeq ?? INITIAL_PAGE_SEQ,
      rev: a.prev?.rev ?? INITIAL_REV,
      tourId: a.entry.tour.id,
      hash: a.entry.hash,
      stepIndex: a.index,
      stepId: step.id,
      windowId: a.carryTabs ? (a.prev?.windowId ?? null) : null,
      tabs,
      overlayHidden: false,
      hint: { gen: FIRST_GEN, met: false, unsupported: false },
      tabStatus: null,
      saveError: a.prev?.saveError ?? false,
      notice: a.notice,
      recentOpIds: pushOp(a.prev?.recentOpIds ?? [], a.opId),
    };
  }

  /** バージョンと権限の確認（開始・新版での再開・最初からのやり直しに共通）。通れば null。 */
  async function precheck(tour: Tour): Promise<SessionResponse | null> {
    const required = tour.minExtensionVersion;
    if (required !== undefined && compareVersions(required, deps.extensionVersion) > 0) {
      return {
        status: 'rejected',
        reason: 'versionTooLow',
        current: deps.extensionVersion,
        required,
      };
    }
    if (!(await has(tour, deps.permissions))) {
      return { status: 'rejected', reason: 'permissionMissing', origins: [...tour.origins] };
    }
    return null;
  }

  // ---- 操作 ----

  async function start(tourId: string, resume: boolean, opId: OpId): Promise<SessionResponse> {
    const prev = state;
    if (prev !== null && prev.status !== 'ended') return rejected('busy');
    let entry: CatalogTour | null;
    try {
      entry = await deps.catalog.get(tourId);
    } catch {
      entry = null;
    }
    if (entry === null) return rejected('tourNotFound');
    const problem = await precheck(entry.tour);
    if (problem !== null) return problem;

    let index = 0;
    let notice: Notice | null = null;
    if (resume) {
      const saved = (await store.readProgress())?.get(tourId);
      if (saved !== undefined) {
        const found = entry.tour.steps.findIndex((s) => s.id === saved.stepId);
        if (found >= 0) index = found;
        else notice = 'restartedFromFirst';
      }
    }
    remember(entry);
    const next = newRun({ prev, entry, index, notice, carryTabs: false, opId });
    if (next === null) return rejected('tourNotFound');
    log.info('session.start', { resume });
    await finish({ next, display: 'plan', progress: 'save' });
    return DONE;
  }

  async function endRun(
    st: TourState,
    kind: 'stop' | 'complete' | 'removed',
    opId?: OpId,
  ): Promise<void> {
    if (kind === 'complete') log.info('session.complete', {});
    else log.info('session.stop', {});
    const next: TourState = {
      ...st,
      status: 'ended',
      pauseReason: null,
      notice: kind === 'removed' ? 'tourRemoved' : null,
      recentOpIds: pushOp(st.recentOpIds, opId),
    };
    await finish({ next, display: 'plan', progress: 'delete' });
  }

  async function goto(to: number, opId: OpId): Promise<SessionResponse> {
    const c = await needRunning();
    if (!c.ok) return c.res;
    const { st, tour } = c;
    const total = tour.steps.length;
    if (!Number.isInteger(to) || to < 0 || to > total) return discard('outOfRange');
    if (to === total) {
      await endRun(st, 'complete', opId);
      return DONE;
    }
    const step = tour.steps[to];
    if (step === undefined) return discard('outOfRange');
    const gen: Gen = nextGen(st.gen);
    log.info('session.goto', { from: st.stepIndex, to, accepted: true });
    await finish({
      next: {
        ...st,
        gen,
        stepIndex: to,
        stepId: step.id,
        hint: { gen, met: false, unsupported: false },
        notice: null,
        recentOpIds: pushOp(st.recentOpIds, opId),
      },
      display: 'plan',
      progress: 'save',
    });
    return DONE;
  }

  async function pauseWith(reason: PauseReason, opId?: OpId): Promise<SessionResponse> {
    const st = state;
    if (st?.status !== 'running') return rejected('notRunning');
    log.info('session.pause', { reason });
    await finish({
      next: { ...st, status: 'paused', pauseReason: reason, recentOpIds: pushOp(st.recentOpIds, opId) },
      display: 'plan',
      progress: 'none',
    });
    return DONE;
  }

  async function resume(opId: OpId): Promise<SessionResponse> {
    const st = state;
    if (st?.status !== 'paused') return rejected('notPaused');
    if (st.pauseReason === 'overwritten') return rejected('notResumable');
    const pinned = await pinnedOf(st);
    if (pinned === null) return rejected('tourNotFound');
    if (!(await has(pinned.tour, deps.permissions))) return rejected('permissionNotRestored');
    const gen = nextGen(st.gen);
    log.info('session.resume', {});
    await finish({
      next: {
        ...st,
        status: 'running',
        pauseReason: null,
        gen,
        hint: { gen, met: false, unsupported: false },
        notice: null,
        recentOpIds: pushOp(st.recentOpIds, opId),
      },
      display: 'plan',
      progress: 'save',
    });
    return DONE;
  }

  async function stop(opId: OpId): Promise<SessionResponse> {
    const st = state;
    if (st === null || st.status === 'ended') return rejected('notRunning');
    await endRun(st, 'stop', opId);
    return DONE;
  }

  async function restart(opId: OpId): Promise<SessionResponse> {
    const st = state;
    if (st === null || st.status === 'ended') return rejected('notRunning');
    if (st.status === 'paused' && st.pauseReason === 'overwritten') return rejected('notRestartable');
    const pinned = await pinnedOf(st);
    if (pinned === null) return rejected('tourNotFound');
    const problem = await precheck(pinned.tour);
    if (problem !== null) return problem;
    const next = newRun({ prev: st, entry: pinned, index: 0, notice: null, carryTabs: true, opId });
    if (next === null) return rejected('tourNotFound');
    log.info('session.start', { resume: false });
    await finish({ next, display: 'plan', progress: 'save' });
    return DONE;
  }

  async function resumeNew(mode: ResumeNewMode, opId: OpId): Promise<SessionResponse> {
    const st = state;
    if (st?.status !== 'paused' || st.pauseReason !== 'overwritten') return rejected('notOverwritten');
    let entry: CatalogTour | null;
    try {
      entry = await deps.catalog.get(st.tourId);
    } catch {
      entry = null;
    }
    if (entry === null) return rejected('tourNotFound');
    const problem = await precheck(entry.tour);
    if (problem !== null) return problem;

    let index = 0;
    let notice: Notice | null = null;
    if (mode === 'continue') {
      const found = entry.tour.steps.findIndex((s) => s.id === st.stepId);
      if (found >= 0) index = found;
      else notice = 'restartedFromFirst';
    }
    remember(entry);
    const next = newRun({ prev: st, entry, index, notice, carryTabs: true, opId });
    if (next === null) return rejected('tourNotFound');
    log.info('session.start', { resume: mode === 'continue' });
    await finish({ next, display: 'plan', progress: 'save' });
    return DONE;
  }

  /** 役割にタブを対応付ける（付け替えを含む）。ページ側の組み込みと描画は、`HELLO` を受けてから行う。 */
  async function bindInto(
    st: TourState,
    role: string,
    tabId: number,
    opId: OpId | undefined,
  ): Promise<SessionResponse> {
    const current = ownValue(st.tabs, role);
    const same = current?.tabId === tabId;
    const tabs: TourState['tabs'] = {
      ...Object.fromEntries(Object.entries(st.tabs).filter(([r, b]) => r === role || b.tabId !== tabId)),
      [role]: { tabId, documentId: same ? current.documentId : null },
    };
    await finish({
      next: {
        ...st,
        tabs,
        pageSeq: same ? st.pageSeq : nextPageSeq(st.pageSeq),
        recentOpIds: pushOp(st.recentOpIds, opId),
      },
      display: 'plan',
      progress: 'none',
    });
    return DONE;
  }

  async function bindTab(tabId: number, force: boolean, opId: OpId): Promise<SessionResponse> {
    const c = await needRunning();
    if (!c.ok) return c.res;
    const { st, tour } = c;
    const step = pageStepOf(tour, st);
    if (step === undefined) return rejected('noPageStep');
    const within = await deps.tabs.isWithinOrigins(tour, tabId).catch(() => false);
    if (!within) return rejected('outsideOrigins');
    const other = findRole(st, tabId);
    if (other !== undefined && other !== step.tab && !force) {
      return { status: 'confirmBind', boundRole: other };
    }
    return bindInto(st, step.tab, tabId, opId);
  }

  async function openIn(mode: OpenInMode, opId: OpId): Promise<SessionResponse> {
    const c = await needRunning();
    if (!c.ok) return c.res;
    const { st, tour } = c;
    const step: Step | undefined = pageStepOf(tour, st);
    if (step === undefined) return rejected('noPageStep');
    const url = step.open ?? ownValue(tour.tabs, step.tab)?.open;
    if (url === undefined) return rejected('noOpenUrl');
    // タブ管理は開く URL の `origins` を確かめないので、ここで確かめる
    if (!urlWithinOrigins(tour, url)) return rejected('outsideOrigins');
    if (mode === 'current') {
      // 今のタブが別の役割に対応付け済みなら、確認なしでは奪わない
      const here = await deps.tabs.currentTabId().catch(() => null);
      const owner = here === null ? undefined : findRole(st, here);
      if (owner !== undefined && owner !== step.tab) return rejected('tabBoundToOtherRole');
    }
    // 1回目の確定: この `opId` を処理済みにしてから開く（打ち切り後の再送で二重に開かないため）
    const opened: { tabId: number | null } = { tabId: null };
    await finish({
      next: { ...st, recentOpIds: pushOp(st.recentOpIds, opId) },
      display: 'none',
      progress: 'none',
      extra: async () => {
        try {
          opened.tabId = await deps.tabs.open(mode, url);
        } catch {
          opened.tabId = null;
        }
      },
    });
    if (opened.tabId === null) {
      const res = rejected('openFailed');
      rememberResult(opId, res);
      return res;
    }
    // 2回目の確定: 開けたタブを役割に対応付ける
    const after = state;
    if (after?.status !== 'running' || after.sessionId !== st.sessionId) return DONE;
    return bindInto(after, step.tab, opened.tabId, undefined);
  }

  async function focusRole(opId: OpId): Promise<SessionResponse> {
    const c = await needRunning();
    if (!c.ok) return c.res;
    const { st, tour } = c;
    const step = pageStepOf(tour, st);
    if (step === undefined) return rejected('noPageStep');
    const binding = ownValue(st.tabs, step.tab);
    if (binding === undefined) return rejected('notBound');
    await finish({
      next: { ...st, recentOpIds: pushOp(st.recentOpIds, opId) },
      display: 'none',
      progress: 'none',
      extra: async () => {
        try {
          await deps.tabs.focus(binding.tabId);
        } catch (e) {
          log.warn('error', errorFields(e, 'message'));
        }
      },
    });
    return DONE;
  }

  /** 再確認・対象を表示。直前も描画していれば専用の指示を、そうでなければ描画の指示を送る。 */
  async function displayOp(mode: 'recheck' | 'scroll', opId: OpId): Promise<SessionResponse> {
    const c = await needRunning();
    if (!c.ok) return c.res;
    if (pageStepOf(c.tour, c.st) === undefined) return rejected('noPageStep');
    await finish({
      next: { ...c.st, recentOpIds: pushOp(c.st.recentOpIds, opId) },
      display: 'plan',
      mode,
      progress: 'none',
    });
    return DONE;
  }

  async function setOverlay(hidden: boolean, opId: OpId): Promise<SessionResponse> {
    const c = await needRunning();
    if (!c.ok) return c.res;
    await finish({
      next: { ...c.st, overlayHidden: hidden, recentOpIds: pushOp(c.st.recentOpIds, opId) },
      display: 'plan',
      progress: 'none',
    });
    return DONE;
  }

  async function setUi(msg: Extract<PanelToBg, { type: 'SET_UI' }>): Promise<SessionResponse> {
    const cur = await settings();
    const miniGuide: UiSettings = {
      enabled: msg.enabled ?? cur.miniGuide.enabled,
      mode: msg.mode ?? cur.miniGuide.mode,
      width: clampWidth(msg.width ?? cur.miniGuide.width),
    };
    const next: Settings = { ...cur, miniGuide };
    const c = await needRunning();
    if (c.ok) {
      await finish({
        next: c.st,
        display: 'plan',
        progress: 'none',
        ui: miniGuide,
        settings: next,
      });
    } else {
      settingsMemo = next;
      if (!(await store.writeSettings(next))) log.warn('error', { name: 'Unknown', reason: 'storage' });
      await notify();
    }
    return DONE;
  }

  async function catalogChanged(tourId: string, hash: string): Promise<void> {
    await ensureLoaded();
    const st = state;
    if (st === null || st.status === 'ended' || st.tourId !== tourId) return;
    let current: CatalogTour | null;
    try {
      current = await deps.catalog.get(tourId);
    } catch {
      return;
    }
    if (current === null) {
      await endRun(st, 'removed');
      return;
    }
    if (hash === st.hash) return;
    if (st.status === 'paused') {
      if (st.pauseReason === 'overwritten') return;
      // 利用者・許可の取り消しで一時中断中でも、上書きされたら理由を改める（一時中断のまま）
      log.info('session.pause', { reason: 'overwritten' });
      await finish({
        next: { ...st, pauseReason: 'overwritten' },
        display: 'plan',
        progress: 'none',
      });
      return;
    }
    await pauseWith('overwritten');
  }

  async function catalogRemoved(tourId: string): Promise<void> {
    await ensureLoaded();
    const st = state;
    if (st === null || st.status === 'ended' || st.tourId !== tourId) return;
    await endRun(st, 'removed');
  }

  // ---- ページ側からの受け付け ----

  /** 送信元が、現在のステップの役割のタブ・最上位フレーム・記録済みの文書か。 */
  async function senderProblem(sender: PageSender): Promise<DiscardReason | null> {
    const st = state;
    if (st === null || st.status === 'ended') return 'staleSession';
    if (sender.tabId === undefined || sender.frameId !== 0 || sender.documentId === undefined) {
      return 'senderMismatch';
    }
    const pinned = await pinnedOf(st);
    const step = pageStepOf(pinned?.tour ?? null, st);
    const binding = step === undefined ? undefined : ownValue(st.tabs, step.tab);
    if (
      binding?.tabId !== sender.tabId ||
      binding.documentId === null ||
      binding.documentId !== sender.documentId
    ) {
      return 'senderMismatch';
    }
    return null;
  }

  /** `HELLO`：ページ側が組み込まれた。文書 ID を記録し、現在の役割のタブなら描画する。 */
  async function hello(sender: PageSender): Promise<SessionResponse> {
    const st = state;
    if (st === null || st.status === 'ended') return discard('staleSession');
    if (sender.tabId === undefined || sender.frameId !== 0 || sender.documentId === undefined) {
      return discard('senderMismatch');
    }
    const role = findRole(st, sender.tabId);
    const known = role === undefined ? undefined : ownValue(st.tabs, role);
    if (role === undefined || known === undefined) return discard('senderMismatch');
    const changedDocument = known.documentId !== null && known.documentId !== sender.documentId;
    const next: TourState = {
      ...st,
      tabs: { ...st.tabs, [role]: { tabId: sender.tabId, documentId: sender.documentId } },
      pageSeq: changedDocument ? nextPageSeq(st.pageSeq) : st.pageSeq,
    };
    const pinned = st.status === 'running' ? await pinnedOf(st) : null;
    const isCurrent = pageStepOf(pinned?.tour ?? null, st)?.tab === role;
    await finish({
      next,
      display: st.status === 'running' && isCurrent ? 'plan' : 'none',
      progress: 'none',
    });
    return DONE;
  }

  interface PageOutcome {
    readonly res: SessionResponse;
    readonly after?: () => Promise<void>;
  }

  async function fromPage(msg: PageToBg, sender: PageSender): Promise<PageOutcome> {
    await ensureLoaded();
    switch (msg.type) {
      case 'HELLO':
        return { res: await hello(sender) };
      case 'GOTO':
      case 'SCROLL_TO_TARGET':
      case 'SET_OVERLAY':
      case 'SET_UI': {
        const bad = await senderProblem(sender);
        if (bad !== null) return { res: discard(bad) };
        return { res: await execute(msg) };
      }
      case 'LOCATE_RESULT':
      case 'HINT_STATE': {
        const bad = await senderProblem(sender);
        if (bad !== null) return { res: discard(bad) };
        const st = state;
        if (st?.status !== 'running') return { res: discard('staleReport') };
        if (msg.sessionId !== st.sessionId) return { res: discard('staleSession') };
        if (msg.gen !== st.gen || msg.pageSeq !== st.pageSeq) return { res: discard('staleReport') };
        if (msg.type === 'LOCATE_RESULT') {
          const { tourId, stepId, sessionId, gen } = st;
          return {
            res: DONE,
            after: () => deps.diagnostics.record(tourId, stepId, sessionId, gen, msg.result),
          };
        }
        const unchanged =
          st.hint.gen === st.gen && st.hint.met === msg.met && st.hint.unsupported === msg.unsupported;
        if (unchanged) return { res: DONE };
        await finish({
          next: { ...st, hint: { gen: st.gen, met: msg.met, unsupported: msg.unsupported } },
          display: 'none',
          progress: 'none',
        });
        return { res: DONE };
      }
      case 'LOG':
        return { res: { status: 'unhandled' } };
    }
  }

  // ---- パネルからの受け付け ----

  async function dispatch(msg: PanelToBg): Promise<SessionResponse> {
    switch (msg.type) {
      case 'START':
        return start(msg.tourId, msg.resume, msg.opId);
      case 'GOTO':
        return goto(msg.to, msg.opId);
      case 'PAUSE':
        return pauseWith('user', msg.opId);
      case 'RESUME':
        return resume(msg.opId);
      case 'STOP':
        return stop(msg.opId);
      case 'RESTART':
        return restart(msg.opId);
      case 'RESUME_NEW':
        return resumeNew(msg.mode, msg.opId);
      case 'BIND_TAB':
        return bindTab(msg.tabId, msg.force, msg.opId);
      case 'OPEN_IN':
        return openIn(msg.mode, msg.opId);
      case 'FOCUS_ROLE':
        return focusRole(msg.opId);
      case 'RECHECK':
        return displayOp('recheck', msg.opId);
      case 'SCROLL_TO_TARGET':
        return displayOp('scroll', msg.opId);
      case 'SET_OVERLAY':
        return setOverlay(msg.hidden, msg.opId);
      case 'SET_UI':
        return setUi(msg);
      case 'CATALOG_CHANGED':
        await catalogChanged(msg.tourId, msg.hash);
        return DONE;
      case 'GET_STATE':
      case 'REMOVE':
      case 'RELOAD':
      case 'GET_DIAGNOSTICS':
      case 'EXPORT_LOGS':
      case 'CLEAR_LOGS':
      case 'LOG':
        return { status: 'unhandled' };
    }
  }

  /** 識別子の確認（重複 → 実行回・世代）を通った操作だけを処理する。キューの中で呼ぶ。 */
  async function execute(msg: PanelToBg): Promise<SessionResponse> {
    await ensureLoaded();
    if ('opId' in msg && state?.recentOpIds.includes(msg.opId) === true) {
      log.debug('session.discard', { reason: 'duplicateOp' });
      return results.get(msg.opId) ?? DONE;
    }
    if ('sessionId' in msg) {
      const reason = identityProblem(msg, state);
      if (reason !== null) return discard(reason);
    }
    const res = await dispatch(msg);
    if ('opId' in msg && res.status === 'done') rememberResult(msg.opId, res);
    return res;
  }

  // ---- 復帰 ----

  async function retryPendingDeletes(): Promise<void> {
    const list = await store.readPendingDeletes();
    if (list === null || list.length === 0) return;
    const remaining: PendingDelete[] = [];
    for (const p of list) {
      if (!(await store.removeProgress(p.tourId, p.sessionId))) remaining.push(p);
    }
    if (remaining.length !== list.length) await store.writePendingDeletes(remaining);
  }

  async function reconcileProgress(st: TourState): Promise<void> {
    const map = await store.readProgress();
    if (map === null) {
      progressDirty = true;
      return;
    }
    const saved = map.get(st.tourId);
    if (saved?.sessionId !== st.sessionId || saved.gen < st.gen) {
      progressDirty = !(await store.saveProgress(st, deps.now()));
    }
  }

  async function recoverInner(): Promise<void> {
    // 手順1: storage.session から状態を読む
    state = await store.readState();
    loaded = Promise.resolve();
    progressDirty = false;
    const st = state;
    // 手順2: 削除待ちをやり直す
    await retryPendingDeletes();
    if (st === null) return;
    // 手順3: 進捗の突き合わせ
    if (st.status === 'ended') await removeProgressOrPend(st);
    else await reconcileProgress(st);
    // 手順4: `rev` を進め、`SYNC` と現在のステップの描画を送る（実行中でなければ表示を消す）
    await pinnedOf(st);
    await finish({
      next: { ...st, saveError: false },
      display: 'plan',
      sync: st.status === 'running',
      progress: 'none',
    });
  }

  // ---- 公開 ----

  async function pageOps(msg: PageToBg, sender: PageSender): Promise<PageResponse> {
    const outcome = await enqueue(() => fromPage(msg, sender));
    if (outcome.after !== undefined) await outcome.after();
    return outcome.res;
  }

  async function panelOps(msg: PanelToBg): Promise<PanelResponse> {
    try {
      return await enqueue(() => execute(msg));
    } catch (e) {
      log.error('error', errorFields(e, 'unknown'));
      return rejected('internal');
    }
  }

  function handlePanel(msg: { readonly type: 'GET_STATE' }): Promise<PanelView>;
  function handlePanel(msg: PanelToBg): Promise<PanelResponse>;
  function handlePanel(msg: PanelToBg): Promise<PanelResponse> {
    if (msg.type === 'GET_STATE') return currentView();
    return panelOps(msg);
  }

  async function handlePage(msg: PageToBg, sender: PageSender): Promise<PageResponse> {
    try {
      return await pageOps(msg, sender);
    } catch (e) {
      log.error('error', errorFields(e, 'unknown'));
      return rejected('internal');
    }
  }

  async function refresh(st: TourState): Promise<void> {
    if (st.status !== 'running') return;
    const pinned = await pinnedOf(st);
    const tour = pinned?.tour ?? null;
    const step = pageStepOf(tour, st);
    if (tour === null || step === undefined) return;
    const evaluation = await evaluate(tour, st);
    if (sameSnapshot(snapshotOf(evaluation), st.tabStatus)) return;
    await finish({ next: st, display: 'plan', progress: 'none', evaluation });
  }

  async function tabEvent(e: TabEvent): Promise<void> {
    await ensureLoaded();
    const st = state;
    if (st === null || st.status === 'ended') return;
    if (!('tabId' in e)) {
      await refresh(st);
      return;
    }
    const role = findRole(st, e.tabId);
    const binding = role === undefined ? undefined : ownValue(st.tabs, role);
    if (role === undefined || binding === undefined) {
      // 役割のタブが無い間は、条件に合うタブの増減や移動で「既存のタブから選ぶ」の一覧が変わるので、パネルへ通知する
      if (st.status === 'running' && st.tabStatus?.status === 'missing') await notify();
      return;
    }
    const running = st.status === 'running';
    const pinned = running ? await pinnedOf(st) : null;
    const isCurrent = pageStepOf(pinned?.tour ?? null, st)?.tab === role;
    switch (e.kind) {
      case 'removed': {
        const tabs = Object.fromEntries(Object.entries(st.tabs).filter(([r]) => r !== role));
        await finish({
          next: { ...st, tabs, windowId: null },
          display: running ? 'plan' : 'none',
          progress: 'none',
        });
        return;
      }
      case 'committed':
        // 新しい文書。ページ側の `HELLO` を受けるまで文書 ID を持たない
        await finish({
          next: {
            ...st,
            tabs: { ...st.tabs, [role]: { tabId: binding.tabId, documentId: null } },
            pageSeq: isCurrent ? nextPageSeq(st.pageSeq) : st.pageSeq,
          },
          display: running && isCurrent ? 'plan' : 'none',
          progress: 'none',
          extra: async () => {
            // 表示を出さない状態でも、のちに戻ったときのために組み込み直す（描画する場合は計画の中で済んでいる）
            const now = state;
            const shown = now?.tabStatus !== null && now?.tabStatus !== undefined && isShown(now.tabStatus.status);
            const tour = (await pinnedOf(st))?.tour;
            if (!running || tour === undefined || (shown && isCurrent)) return;
            try {
              await deps.tabs.inject(tour, binding.tabId);
            } catch (err) {
              log.warn('error', errorFields(err, 'message'));
            }
          },
        });
        return;
      case 'changed':
        return;
      case 'historyStateUpdated':
        if (!running || !isCurrent) return;
        await finish({
          next: { ...st, pageSeq: nextPageSeq(st.pageSeq) },
          display: 'plan',
          progress: 'none',
        });
        return;
      case 'completed':
        // 組み込みの再試行はタブ管理が行う。ここでは判定し直すだけ
        if (isCurrent) await refresh(st);
        return;
    }
  }

  return {
    handlePanel,
    handlePage,
    onTabEvent: (e) => enqueue(() => tabEvent(e)),
    onCatalogChanged: (tourId, hash) => enqueue(() => catalogChanged(tourId, hash)),
    onCatalogRemoved: (tourId) => enqueue(() => catalogRemoved(tourId)),
    onPermissionLost: () =>
      enqueue(async () => {
        await ensureLoaded();
        if (state?.status === 'running') await pauseWith('permission');
      }).then(() => undefined),
    recover: () => enqueue(recoverInner),
    view: currentView,
    runningTour: () => {
      const st = state;
      if (st?.status !== 'running') return null;
      return pinnedCache.get(cacheKey(st.tourId, st.hash))?.tour ?? null;
    },
  };
}
