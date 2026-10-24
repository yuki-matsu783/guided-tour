/**
 * タブ管理。役割とタブの対応付けは状態管理が持ち、ここは渡された対応付けを元に、ステップごとのタブの状態を判定する。
 * 依頼されたときだけ、開く・前面に出す・ページ側を組み込む・送る。役割を自動では対応付けない。
 * ページの URL は `chrome.tabs` から取った値だけで判定する（`sender.url` は使わない）。
 * 介入（組み込み・送信）の前に、タブの URL が実行中のツアーの `origins` に含まれることを確かめる。
 * Chrome の API は `TabsDeps` として注入する。ログやエラーにページの URL や文字列は入れない。
 */
import { matchUrl, originsOf } from '../../core/tour/index.ts';
import type { Step, Tour, UrlCond } from '../../core/tour/index.ts';
import type { BgToPage } from '../../shared/messages/index.ts';
import { patternsOf } from '../../shared/permissions/index.ts';
import type {
  RoleBinding,
  TabCandidate,
  TabEvaluation,
  TabEvent,
  TabsPort,
} from '../ports.ts';
import { ownValue } from '../session/own.ts';
import type { NavigationDetails, TabLike, TabsDeps } from './types.ts';

/** 遷移検知のデバウンス（タブごと）。 */
export const DEBOUNCE_MS = 150;

type NavigationKind = 'committed' | 'historyStateUpdated' | 'completed';
/** まとめて流すときの順序。 */
const NAVIGATION_ORDER: readonly NavigationKind[] = ['committed', 'historyStateUpdated', 'completed'];

interface Pending {
  timer: ReturnType<typeof setTimeout>;
  kinds: Set<NavigationKind>;
}

function isHttp(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function withinOrigins(tour: Tour, url: string | undefined): boolean {
  if (url === undefined || !isHttp(url)) return false;
  try {
    return originsOf(tour).includes(new URL(url).origin);
  } catch {
    return false;
  }
}

function matches(cond: UrlCond | undefined, url: string): boolean {
  return cond !== undefined && matchUrl(cond, url);
}

export function createTabs(deps: TabsDeps): TabsPort {
  const listeners = new Set<(event: TabEvent) => void>();
  const pending = new Map<number, Pending>();
  /** ページ側の組み込みに失敗したタブ。組み込みに成功するか、タブが閉じられるまで残る。 */
  const injectFailed = new Set<number>();
  /** 組み込みの再試行に使う、実行中のツアー。状態管理が知らせる。null の間は再試行しない。 */
  let activeTour: Tour | null = null;

  function emit(event: TabEvent): void {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // 1つの受け手の失敗で、ほかの受け手や後続のイベントを止めない
      }
    }
  }

  async function getTab(tabId: number): Promise<TabLike | null> {
    try {
      return await deps.tabs.get(tabId);
    } catch {
      return null;
    }
  }

  async function windowFocused(windowId: number): Promise<boolean> {
    try {
      return (await deps.windows.get(windowId)).focused;
    } catch {
      return false;
    }
  }

  async function hasPermission(tour: Tour): Promise<boolean> {
    try {
      return await deps.permissions.contains({ origins: patternsOf(tour) });
    } catch {
      return false;
    }
  }

  async function isWithinOrigins(tour: Tour, tabId: number): Promise<boolean> {
    const tab = await getTab(tabId);
    return tab !== null && withinOrigins(tour, tab.url);
  }

  async function inject(tour: Tour, tabId: number): Promise<boolean> {
    if (!(await isWithinOrigins(tour, tabId)) || !(await hasPermission(tour))) {
      injectFailed.add(tabId);
      return false;
    }
    try {
      await deps.scripting.executeScript({ target: { tabId }, files: [deps.contentScriptFile] });
    } catch {
      injectFailed.add(tabId);
      return false;
    }
    injectFailed.delete(tabId);
    return true;
  }

  /** 全ウィンドウのタブから、URL 条件に合うものを候補にする。 */
  async function candidatesFor(
    tour: Tour,
    role: string,
    cond: UrlCond | undefined,
    roles: Readonly<Record<string, RoleBinding>>,
  ): Promise<{ candidates: TabCandidate[]; focusedCandidate: number | null }> {
    if (cond === undefined) return { candidates: [], focusedCandidate: null };
    let all: TabLike[];
    let focused: TabLike[];
    try {
      all = await deps.tabs.query({});
      focused = await deps.tabs.query({ active: true, lastFocusedWindow: true });
    } catch {
      return { candidates: [], focusedCandidate: null };
    }
    const candidates: TabCandidate[] = [];
    for (const tab of all) {
      if (tab.id === undefined || tab.url === undefined) continue;
      if (!withinOrigins(tour, tab.url) || !matches(cond, tab.url)) continue;
      const tabId = tab.id;
      const other = Object.entries(roles).find(([r, b]) => r !== role && b.tabId === tabId);
      candidates.push({
        tabId,
        title: tab.title ?? '',
        windowId: tab.windowId,
        boundRole: other === undefined ? null : other[0],
      });
    }
    const focusedId = focused[0]?.id;
    const focusedCandidate =
      focusedId !== undefined && candidates.some((c) => c.tabId === focusedId) ? focusedId : null;
    return { candidates, focusedCandidate };
  }

  /**
   * 処理フロー:
   * 1. guide は判定しない（呼ぶ側が全タブへ CLEAR を送る）
   * 2. 役割のタブが無い・閉じられていれば missing（候補と注目中のタブを添える）
   * 3. 完了ページ → ステップの URL 条件 → それ以外（mismatch）の順に判定する
   * 4. 描画する状態で、権限が無い・組み込みに失敗していれば unsupported
   */
  async function evaluate(
    tour: Tour,
    step: Step,
    roles: Readonly<Record<string, RoleBinding>>,
  ): Promise<TabEvaluation> {
    const role = step.tab;
    if (step.kind === 'guide') {
      return { role, status: 'ok', selected: true, attended: true, candidates: [], focusedCandidate: null };
    }
    const cond = step.url ?? ownValue(tour.tabs, role)?.url;
    const binding = ownValue(roles, role);
    const tab = binding === undefined ? null : await getTab(binding.tabId);
    if (binding === undefined || tab === null) {
      const found = await candidatesFor(tour, role, cond, roles);
      return { role, status: 'missing', selected: false, attended: false, ...found };
    }
    const url = tab.url ?? '';
    const inside = withinOrigins(tour, url);
    const doneCond = step.done?.type === 'page' ? step.done.url : undefined;
    let status: TabEvaluation['status'] = 'mismatch';
    if (inside && matches(doneCond, url)) status = 'donePage';
    else if (inside && matches(cond, url)) status = 'ok';
    if (
      (status === 'ok' || status === 'donePage') &&
      (injectFailed.has(binding.tabId) || !(await hasPermission(tour)))
    ) {
      status = 'unsupported';
    }
    const selected = tab.active;
    const attended = selected && (await windowFocused(tab.windowId));
    return { role, status, selected, attended, candidates: [], focusedCandidate: null };
  }

  async function open(mode: 'current' | 'new', url: string): Promise<number | null> {
    if (!isHttp(url)) return null;
    try {
      if (mode === 'new') return (await deps.tabs.create({ url })).id ?? null;
      const [current] = await deps.tabs.query({ active: true, lastFocusedWindow: true });
      if (current?.id === undefined) return null;
      await deps.tabs.update(current.id, { url });
      return current.id;
    } catch {
      return null;
    }
  }

  async function currentTabId(): Promise<number | null> {
    try {
      const [current] = await deps.tabs.query({ active: true, lastFocusedWindow: true });
      return current?.id ?? null;
    } catch {
      return null;
    }
  }

  function setActiveTour(tour: Tour | null): void {
    activeTour = tour;
  }

  async function focus(tabId: number): Promise<void> {
    try {
      const tab = await deps.tabs.update(tabId, { active: true });
      const windowId = tab?.windowId ?? (await deps.tabs.get(tabId)).windowId;
      await deps.windows.update(windowId, { focused: true });
    } catch {
      // タブが閉じられているなど。何もしない
    }
  }

  async function sendTo(tabId: number, message: BgToPage): Promise<void> {
    try {
      await deps.tabs.sendMessage(tabId, message, { frameId: 0 });
    } catch {
      // ページ側が組み込まれていないタブへの送信の失敗は無視する
    }
  }

  async function send(tour: Tour, tabId: number, message: BgToPage): Promise<void> {
    if (!(await isWithinOrigins(tour, tabId))) return;
    await sendTo(tabId, message);
  }

  async function broadcast(message: BgToPage): Promise<void> {
    let all: TabLike[];
    try {
      all = await deps.tabs.query({});
    } catch {
      return;
    }
    await Promise.all(
      all.flatMap((tab) =>
        tab.id !== undefined && tab.url !== undefined && isHttp(tab.url) ? [sendTo(tab.id, message)] : [],
      ),
    );
  }

  async function shortcut(): Promise<string | null> {
    try {
      const commands = await deps.commands.getAll();
      const found = commands.find((c) => c.name === '_execute_action')?.shortcut;
      return found !== undefined && found !== '' ? found : null;
    } catch {
      return null;
    }
  }

  // ---- イベント ----

  async function flush(tabId: number, kinds: Set<NavigationKind>): Promise<void> {
    for (const kind of NAVIGATION_ORDER) {
      if (!kinds.has(kind)) continue;
      if (kind === 'completed' && injectFailed.has(tabId) && activeTour !== null) {
        await inject(activeTour, tabId);
      }
      emit({ kind, tabId });
    }
  }

  function schedule(tabId: number, kind: NavigationKind): void {
    const existing = pending.get(tabId);
    if (existing !== undefined) {
      existing.kinds.add(kind);
      clearTimeout(existing.timer);
    }
    const kinds = existing?.kinds ?? new Set<NavigationKind>([kind]);
    const timer = setTimeout(() => {
      pending.delete(tabId);
      void flush(tabId, kinds);
    }, DEBOUNCE_MS);
    pending.set(tabId, { timer, kinds });
  }

  function navigation(kind: NavigationKind): (details: NavigationDetails) => void {
    return (details) => {
      if (details.frameId === 0) schedule(details.tabId, kind);
    };
  }

  deps.webNavigation.onCommitted.addListener(navigation('committed'));
  deps.webNavigation.onHistoryStateUpdated.addListener(navigation('historyStateUpdated'));
  deps.webNavigation.onCompleted.addListener(navigation('completed'));
  deps.tabs.onActivated.addListener(() => {
    emit({ kind: 'activated' });
  });
  deps.windows.onFocusChanged.addListener(() => {
    emit({ kind: 'focusChanged' });
  });
  deps.tabs.onRemoved.addListener((tabId) => {
    const timer = pending.get(tabId);
    if (timer !== undefined) clearTimeout(timer.timer);
    pending.delete(tabId);
    injectFailed.delete(tabId);
    emit({ kind: 'removed', tabId });
  });

  return {
    evaluate,
    isWithinOrigins,
    inject,
    currentTabId,
    setActiveTour,
    open,
    focus,
    send,
    broadcast,
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    shortcut,
  };
}
