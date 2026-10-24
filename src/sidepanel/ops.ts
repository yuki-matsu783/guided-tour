/**
 * 画面の操作を、バックグラウンドへのメッセージにして送る。
 * 状態管理への操作には、表示中の `sessionId`・`gen` と、操作ごとに新しい `opId` を付ける。
 * 表示中の写しに `sessionId`（と `gen`）が無いときは、何も送らない。
 * 権限が要る開始・再開は、クリックの処理の中で await を挟まずに最初に権限を要求し、許可されたときだけ送る。
 * 応答は検証して文言にし、`host.notify` で画面に出す。確認が要る応答（付け替え）は `host.askBind` に渡す。
 */
import { newOpId } from '../shared/ids/index.ts';
import type { Gen, SessionId } from '../shared/ids/index.ts';
import { errorFields } from '../shared/logger/index.ts';
import { OpResponseSchema } from '../shared/messages/index.ts';
import type {
  CatalogEntry,
  OpenInMode,
  OpResponse,
  PanelToBg,
  PanelView,
  ResumeNewMode,
} from '../shared/messages/index.ts';
import { request } from '../shared/permissions/index.ts';
import type { PanelDeps } from './deps.ts';
import { createMoveGate } from '../shared/move-gate/index.ts';
import { describeResponse, permissionMissingText } from './response-text.ts';

export interface OpsHost {
  deps: Pick<PanelDeps, 'send' | 'permissions' | 'logger' | 'now'>;
  getView(): PanelView | null;
  /** 画面に出す結果の文言。null で消す。 */
  notify(text: string | null): void;
  /** 写しを取り直す。 */
  refresh(): void;
  /** 付け替えの確認を出す。 */
  askBind(request: { tabId: number; boundRole: string }): void;
  /** 完了・終了の操作が受け付けられた。`tourName` は操作したときのツアー名。 */
  finished(kind: 'complete' | 'stop', tourName: string | null): void;
}

export interface Ops {
  /** 表示（写し）が届いたときに呼ぶ。`gen` の変化で、移動の操作の受け付けの待ちをやり直す。 */
  shown: (gen: Gen | null) => void;
  start: (entry: CatalogEntry, resume: boolean) => void;
  goto: (to: number) => void;
  pause: () => void;
  /** 一時中断中の再開。権限を要求してから送る。 */
  resume: () => void;
  stop: () => void;
  restart: () => void;
  /** 上書きによる一時中断からの再開。新版の `origins` の権限を要求してから送る。 */
  resumeNew: (mode: ResumeNewMode) => void;
  bindTab: (tabId: number, force: boolean) => void;
  openIn: (mode: OpenInMode) => void;
  focusRole: () => void;
  recheck: () => void;
  scrollToTarget: () => void;
  setOverlay: (hidden: boolean) => void;
  setMiniGuide: (enabled: boolean) => void;
  remove: (tourId: string) => void;
  reload: () => void;
}

export function createOps(host: OpsHost): Ops {
  const { deps } = host;
  const gate = createMoveGate(() => deps.now());

  /** 送って応答を検証し、文言を出す。送れない・読めないときは null。 */
  const dispatch = async (message: PanelToBg): Promise<OpResponse | null> => {
    let raw: unknown;
    try {
      raw = await deps.send(message);
    } catch (thrown) {
      deps.logger.error('error', errorFields(thrown, 'message'));
      host.notify('バックグラウンドと通信できませんでした。しばらくしてからもう一度操作してください');
      return null;
    }
    const parsed = OpResponseSchema.safeParse(raw);
    if (!parsed.success) {
      deps.logger.error('error', { name: 'ZodError', reason: 'message' });
      host.notify('バックグラウンドの応答を読めませんでした');
      return null;
    }
    host.notify(describeResponse(parsed.data));
    if (parsed.data.status === 'confirmBind' || parsed.data.status === 'discarded') host.refresh();
    return parsed.data;
  };

  const session = (): { sessionId: SessionId; gen: Gen | null } | null => {
    const view = host.getView();
    if (view?.sessionId == null) return null;
    return { sessionId: view.sessionId, gen: view.gen };
  };

  /** `sessionId` だけを付ける操作。 */
  const withSession = (build: (ids: { sessionId: SessionId }) => PanelToBg): void => {
    const s = session();
    if (s === null) return;
    void dispatch(build({ sessionId: s.sessionId }));
  };

  /** `sessionId` と `gen` を付ける操作。 */
  const withGen = (build: (ids: { sessionId: SessionId; gen: Gen }) => PanelToBg): Promise<OpResponse | null> => {
    const s = session();
    if (s?.gen == null) return Promise.resolve(null);
    return dispatch(build({ sessionId: s.sessionId, gen: s.gen }));
  };

  /** 権限を要求し、許可されたときだけ `then` を呼ぶ。拒否なら必要なサイトを出す。 */
  const afterPermission = (origins: string[], then: () => void): void => {
    // クリックの処理の中で、await を挟まずに最初に呼ぶ
    const granted = request({ origins }, deps.permissions);
    void granted.then((ok) => {
      if (ok) then();
      else host.notify(permissionMissingText(origins));
    });
  };

  const ack = async (message: PanelToBg): Promise<void> => {
    try {
      await deps.send(message);
    } catch (thrown) {
      deps.logger.error('error', errorFields(thrown, 'message'));
      host.notify('バックグラウンドと通信できませんでした。しばらくしてからもう一度操作してください');
    }
    host.refresh();
  };

  /** 新版（一覧にある同じ ID の最新）の `origins`。無ければ実行中のツアーの `origins`。 */
  const originsForResume = (): string[] => {
    const view = host.getView();
    if (view?.tour == null) return [];
    const id = view.tour.id;
    return view.catalog.find((e) => e.id === id)?.origins ?? view.tour.origins;
  };

  return {
    start(entry, resume) {
      afterPermission(entry.origins, () => {
        void dispatch({ type: 'START', tourId: entry.id, resume, opId: newOpId() });
      });
    },
    shown(gen) {
      gate.shown(gen);
    },
    goto(to) {
      // 新しい表示（PanelView の gen の変化）が届くまで、また届いてから 500 ミリ秒の間は、移動を送らない
      if (!gate.tryMove()) return;
      const view = host.getView();
      const total = view?.steps.length ?? 0;
      const tourName = view?.tour?.name ?? null;
      const sentGen = view?.gen ?? null;
      void withGen((ids) => ({ type: 'GOTO', to, ...ids, opId: newOpId() })).then((response) => {
        // 受け付けられなかった移動は、新しい表示が来ないので、次の移動を許す
        // 応答が遅れて、すでに新しい表示になっているときは、新しい表示の待ちを解かない
        if (response?.status !== 'done' && host.getView()?.gen === sentGen) gate.release();
        if (response?.status === 'done' && to === total) host.finished('complete', tourName);
      });
    },
    pause() {
      withSession((ids) => ({ type: 'PAUSE', ...ids, opId: newOpId() }));
    },
    resume() {
      afterPermission(originsForResume(), () => {
        withSession((ids) => ({ type: 'RESUME', ...ids, opId: newOpId() }));
      });
    },
    stop() {
      const s = session();
      if (s === null) return;
      const tourName = host.getView()?.tour?.name ?? null;
      void dispatch({ type: 'STOP', sessionId: s.sessionId, opId: newOpId() }).then((response) => {
        if (response?.status === 'done') host.finished('stop', tourName);
      });
    },
    restart() {
      withSession((ids) => ({ type: 'RESTART', ...ids, opId: newOpId() }));
    },
    resumeNew(mode) {
      afterPermission(originsForResume(), () => {
        withSession((ids) => ({ type: 'RESUME_NEW', mode, ...ids, opId: newOpId() }));
      });
    },
    bindTab(tabId, force) {
      void withGen((ids) => ({ type: 'BIND_TAB', tabId, force, ...ids, opId: newOpId() })).then((response) => {
        if (response?.status === 'confirmBind') host.askBind({ tabId, boundRole: response.boundRole });
      });
    },
    openIn(mode) {
      void withGen((ids) => ({ type: 'OPEN_IN', mode, ...ids, opId: newOpId() }));
    },
    focusRole() {
      void withGen((ids) => ({ type: 'FOCUS_ROLE', ...ids, opId: newOpId() }));
    },
    recheck() {
      void withGen((ids) => ({ type: 'RECHECK', ...ids, opId: newOpId() }));
    },
    scrollToTarget() {
      void withGen((ids) => ({ type: 'SCROLL_TO_TARGET', ...ids, opId: newOpId() }));
    },
    setOverlay(hidden) {
      withSession((ids) => ({ type: 'SET_OVERLAY', hidden, ...ids, opId: newOpId() }));
    },
    setMiniGuide(enabled) {
      void ack({ type: 'SET_UI', enabled });
    },
    remove(tourId) {
      void ack({ type: 'REMOVE', tourId });
    },
    reload() {
      void ack({ type: 'RELOAD' });
    },
  };
}
