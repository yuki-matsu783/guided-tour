/**
 * タブ管理のテスト（判定・候補・介入前の確認・イベントのデバウンス・開く／前面／送信）。
 * Chrome の API は偽物を差し込む。状態管理に属するもの（`pageSeq` の加算・`HELLO` の記録・対応付けの更新・
 * 描画指示の送信）は状態管理のテストで確かめ、ここでは、そのもとになるイベントと API の呼び出しを確かめる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseTour } from '../../core/tour/index.ts';
import { RevSchema } from '../../shared/ids/index.ts';
import type { Step, Tour } from '../../core/tour/index.ts';
import type { RoleBinding, TabEvent } from '../ports.ts';
import { DEBOUNCE_MS, createTabs } from './index.ts';
import type { NavigationDetails, TabLike, TabsDeps } from './index.ts';

const TOUR_YAML = `
schemaVersion: 3
id: demo
name: デモ
origins:
  - https://a.example
  - https://b.example
tabs:
  main:
    url: { origin: "https://a.example" }
  second:
    url: { origin: "https://b.example" }
steps:
  - id: s1
    title: 一つ目
    url: { origin: "https://a.example", path: { prefix: /app } }
  - id: s2
    title: 完了ページ付き
    url: { origin: "https://a.example", path: { prefix: /app } }
    done:
      type: page
      url: { origin: "https://a.example", path: { exact: /done } }
  - id: s3
    title: 二つ目のタブ
    tab: second
  - id: g1
    title: ガイド
    kind: guide
`;

function loadTour(): Tour {
  const result = parseTour(TOUR_YAML, 'tour.yaml');
  if (!result.ok) throw new Error('fixture invalid');
  return result.tour;
}

function stepOf(tour: Tour, id: string): Step {
  const step = tour.steps.find((s) => s.id === id);
  if (step === undefined) throw new Error('no step');
  return step;
}

type Listener<A extends unknown[]> = (...args: A) => void;

function emitter<A extends unknown[]>(): {
  addListener: (l: Listener<A>) => void;
  removeListener: (l: Listener<A>) => void;
  fire: (...args: A) => void;
} {
  const set = new Set<Listener<A>>();
  return {
    addListener: (l) => set.add(l),
    removeListener: (l) => set.delete(l),
    fire: (...args) => {
      for (const l of set) l(...args);
    },
  };
}

interface Env {
  deps: TabsDeps;
  tabs: TabLike[];
  focusedWindows: Set<number>;
  granted: { value: boolean };
  scripting: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn<TabsDeps["tabs"]["sendMessage"]>>;
  windowsUpdate: ReturnType<typeof vi.fn>;
  shortcuts: { name: string; shortcut: string }[];
  fire: {
    activated: () => void;
    focusChanged: () => void;
    removed: (tabId: number) => void;
    created: (tabId: number) => void;
    updated: (tabId: number, change: { url?: string; status?: string }) => void;
    committed: (d: NavigationDetails) => void;
    history: (d: NavigationDetails) => void;
    completed: (d: NavigationDetails) => void;
  };
}

function tab(id: number, url: string, over: Partial<TabLike> = {}): TabLike {
  return { id, url, title: `t${String(id)}`, active: false, windowId: 1, ...over };
}

function makeEnv(initial: TabLike[]): Env {
  const tabs = [...initial];
  const focusedWindows = new Set<number>([1]);
  const granted = { value: true };
  const onActivated = emitter<[unknown]>();
  const onRemoved = emitter<[number, unknown]>();
  const onCreated = emitter<[{ id?: number | undefined }]>();
  const onUpdated = emitter<[number, { url?: string | undefined; status?: string | undefined }, unknown]>();
  const onFocusChanged = emitter<[number]>();
  const onCommitted = emitter<[NavigationDetails]>();
  const onHistory = emitter<[NavigationDetails]>();
  const onCompleted = emitter<[NavigationDetails]>();
  const scripting = vi.fn(() => Promise.resolve([]));
  const create = vi.fn((p: { url: string }) => {
    const created = tab(100, p.url, { active: true });
    tabs.push(created);
    return Promise.resolve(created);
  });
  const update = vi.fn((id: number, p: { url?: string; active?: boolean }) => {
    const found = tabs.find((t) => t.id === id);
    if (found === undefined) return Promise.reject(new Error('no tab'));
    if (p.url !== undefined) found.url = p.url;
    if (p.active === true) found.active = true;
    return Promise.resolve(found);
  });
  const sendMessage = vi.fn<(tabId: number, message: unknown, options?: { frameId: number }) => Promise<unknown>>(
    () => Promise.resolve(undefined),
  );
  const windowsUpdate = vi.fn(() => Promise.resolve({}));
  const shortcuts = [{ name: '_execute_action', shortcut: 'Ctrl+Shift+Y' }];
  const deps: TabsDeps = {
    tabs: {
      get: (id) => {
        const found = tabs.find((t) => t.id === id);
        return found === undefined ? Promise.reject(new Error('no tab')) : Promise.resolve(found);
      },
      query: (q) =>
        Promise.resolve(
          tabs.filter((t) => (q.active === undefined || t.active === q.active) && (q.lastFocusedWindow !== true || focusedWindows.has(t.windowId))),
        ),
      create,
      update,
      sendMessage,
      onActivated,
      onRemoved,
      onCreated,
      onUpdated,
    },
    windows: {
      get: (id) => Promise.resolve({ focused: focusedWindows.has(id) }),
      update: windowsUpdate,
      onFocusChanged,
    },
    webNavigation: { onCommitted, onHistoryStateUpdated: onHistory, onCompleted },
    scripting: { executeScript: scripting },
    commands: { getAll: () => Promise.resolve(shortcuts) },
    contentScriptFile: 'content.js',
    permissions: { contains: () => Promise.resolve(granted.value) },
  };
  return {
    deps,
    tabs,
    focusedWindows,
    granted,
    scripting,
    create,
    update,
    sendMessage,
    windowsUpdate,
    shortcuts,
    fire: {
      activated: () => {
        onActivated.fire({});
      },
      focusChanged: () => {
        onFocusChanged.fire(1);
      },
      removed: (id) => {
        onRemoved.fire(id, {});
      },
      created: (id) => {
        onCreated.fire({ id });
      },
      updated: (id, change) => {
        onUpdated.fire(id, change, {});
      },
      committed: (d) => {
        onCommitted.fire(d);
      },
      history: (d) => {
        onHistory.fire(d);
      },
      completed: (d) => {
        onCompleted.fire(d);
      },
    },
  };
}

const bind = (tabId: number): RoleBinding => ({ tabId, documentId: null });

describe('evaluate の判定', () => {
  const tour = loadTour();

  it('T-TAB-01 T-TAB-15: origins 内で URL 条件に合えば ok（クエリ・フラグメントは無視する）', async () => {
    const env = makeEnv([tab(1, 'https://a.example/app/x?q=1#frag', { active: true })]);
    const tabs = createTabs(env.deps);
    const result = await tabs.evaluate(tour, stepOf(tour, 's1'), { main: bind(1) });
    expect(result.status).toBe('ok');
    expect(result.role).toBe('main');
  });

  it('T-TAB-02 T-TAB-09: 完了ページの条件に合えば、ステップの URL 条件に合わなくても donePage', async () => {
    const env = makeEnv([tab(1, 'https://a.example/done')]);
    const result = await createTabs(env.deps).evaluate(tour, stepOf(tour, 's2'), { main: bind(1) });
    expect(result.status).toBe('donePage');
  });

  it('T-TAB-03: どちらにも合わなければ mismatch', async () => {
    const env = makeEnv([tab(1, 'https://a.example/other')]);
    const result = await createTabs(env.deps).evaluate(tour, stepOf(tour, 's2'), { main: bind(1) });
    expect(result.status).toBe('mismatch');
    expect(result.candidates).toEqual([]);
  });

  it('T-TAB-04: 役割にタブが対応付けられていなければ missing', async () => {
    const env = makeEnv([tab(1, 'https://a.example/app')]);
    const result = await createTabs(env.deps).evaluate(tour, stepOf(tour, 's1'), {});
    expect(result.status).toBe('missing');
  });

  it('T-TAB-05: 組み込みに失敗したタブは unsupported', async () => {
    const env = makeEnv([tab(1, 'https://a.example/app')]);
    env.scripting.mockRejectedValueOnce(new Error('x'));
    const tabs = createTabs(env.deps);
    expect(await tabs.inject(tour, 1)).toBe(false);
    const result = await tabs.evaluate(tour, stepOf(tour, 's1'), { main: bind(1) });
    expect(result.status).toBe('unsupported');
  });

  it('T-TAB-05: 組み込みに成功し直せば ok に戻る', async () => {
    const env = makeEnv([tab(1, 'https://a.example/app')]);
    env.scripting.mockRejectedValueOnce(new Error('x'));
    const tabs = createTabs(env.deps);
    await tabs.inject(tour, 1);
    expect(await tabs.inject(tour, 1)).toBe(true);
    expect((await tabs.evaluate(tour, stepOf(tour, 's1'), { main: bind(1) })).status).toBe('ok');
  });

  it('T-TAB-06: URL 条件にも完了ページにも合えば donePage が ok より優先される', async () => {
    const yaml = TOUR_YAML.replace('path: { prefix: /app } }\n    done', 'path: { prefix: / } }\n    done');
    const result = parseTour(yaml, 'tour.yaml');
    if (!result.ok) throw new Error('invalid');
    const env = makeEnv([tab(1, 'https://a.example/done')]);
    const evaluation = await createTabs(env.deps).evaluate(result.tour, stepOf(result.tour, 's2'), { main: bind(1) });
    expect(evaluation.status).toBe('donePage');
  });

  it('T-TAB-07: donePage が mismatch より優先される（ステップの条件に合わない完了ページ）', async () => {
    const env = makeEnv([tab(1, 'https://a.example/done')]);
    const result = await createTabs(env.deps).evaluate(tour, stepOf(tour, 's2'), { main: bind(1) });
    expect(result.status).not.toBe('mismatch');
  });

  it('T-TAB-08: donePage の判定は候補を返さず、タブも作らない（案内は出さない）', async () => {
    const env = makeEnv([tab(1, 'https://a.example/done'), tab(2, 'https://a.example/app')]);
    const result = await createTabs(env.deps).evaluate(tour, stepOf(tour, 's2'), { main: bind(1) });
    expect(result.status).toBe('donePage');
    expect(result.candidates).toEqual([]);
    expect(result.focusedCandidate).toBeNull();
  });

  it('T-TAB-10 T-TAB-11: mismatch の判定は新しいタブを作らず、送信もしない', async () => {
    const env = makeEnv([tab(1, 'https://a.example/other')]);
    const result = await createTabs(env.deps).evaluate(tour, stepOf(tour, 's1'), { main: bind(1) });
    expect(result.status).toBe('mismatch');
    expect(env.create).not.toHaveBeenCalled();
    expect(env.sendMessage).not.toHaveBeenCalled();
  });

  it('T-TAB-12: URL 条件に合っても origins の外なら ok にならない', async () => {
    // 別のツアーが得た権限で、origins に無いホストのタブが条件に合う状況
    const env = makeEnv([tab(1, 'https://b.example/app')]);
    const loose: Tour = { ...tour, origins: ['https://a.example'] };
    const step: Step = { ...stepOf(loose, 's1'), url: { origin: 'https://b.example' } };
    const result = await createTabs(env.deps).evaluate(loose, step, { main: bind(1) });
    expect(result.status).toBe('mismatch');
  });

  it('T-TAB-13: guide のステップは判定せず、Chrome の API を呼ばない。CLEAR は全タブへ broadcast で送れる', async () => {
    const env = makeEnv([tab(1, 'https://a.example/app'), tab(2, 'https://b.example/'), tab(3, 'chrome://extensions')]);
    const tabs = createTabs(env.deps);
    const spy = vi.spyOn(env.deps.tabs, 'get');
    await tabs.evaluate(tour, stepOf(tour, 'g1'), {});
    expect(spy).not.toHaveBeenCalled();
    await tabs.broadcast({ type: 'CLEAR', rev: RevSchema.parse(1) });
    expect(env.sendMessage.mock.calls.map((c) => c[0])).toEqual([1, 2]);
    expect(env.sendMessage.mock.calls[0]?.[1]).toEqual({ type: 'CLEAR', rev: RevSchema.parse(1) });
  });

  it('T-TAB-14: 役割に対応付けのないタブには、判定でも送信でも何もしない', async () => {
    const env = makeEnv([tab(1, 'https://a.example/app'), tab(2, 'https://a.example/app')]);
    await createTabs(env.deps).evaluate(tour, stepOf(tour, 's1'), { main: bind(1) });
    expect(env.sendMessage).not.toHaveBeenCalled();
    expect(env.scripting).not.toHaveBeenCalled();
  });

  it('T-TAB-47: origins に含まれても権限がなければ、組み込まれず unsupported になる', async () => {
    const env = makeEnv([tab(1, 'https://a.example/app')]);
    env.granted.value = false;
    const tabs = createTabs(env.deps);
    expect(await tabs.inject(tour, 1)).toBe(false);
    expect(env.scripting).not.toHaveBeenCalled();
    expect((await tabs.evaluate(tour, stepOf(tour, 's1'), { main: bind(1) })).status).toBe('unsupported');
  });
});

describe('selected / attended', () => {
  const tour = loadTour();
  const step = stepOf(tour, 's1');

  it('T-TAB-16 T-TAB-18: active でウィンドウにフォーカスがあれば selected・attended が真', async () => {
    const env = makeEnv([tab(1, 'https://a.example/app', { active: true })]);
    const result = await createTabs(env.deps).evaluate(tour, step, { main: bind(1) });
    expect(result).toMatchObject({ selected: true, attended: true });
  });

  it('T-TAB-17 T-TAB-21: active でなければ selected・attended がともに偽', async () => {
    const env = makeEnv([tab(1, 'https://a.example/app', { active: false })]);
    const result = await createTabs(env.deps).evaluate(tour, step, { main: bind(1) });
    expect(result).toMatchObject({ selected: false, attended: false });
  });

  it('T-TAB-19 T-TAB-20: active でもウィンドウにフォーカスがなければ selected が真で attended が偽', async () => {
    const env = makeEnv([tab(1, 'https://a.example/app', { active: true })]);
    env.focusedWindows.clear();
    const result = await createTabs(env.deps).evaluate(tour, step, { main: bind(1) });
    expect(result).toMatchObject({ selected: true, attended: false });
  });

  it('T-TAB-25 T-TAB-26: missing のとき、注目中のタブが条件に合っても自動では対応付けず、切り替えもしない', async () => {
    const env = makeEnv([tab(1, 'https://a.example/app', { active: true })]);
    const result = await createTabs(env.deps).evaluate(tour, step, {});
    expect(result.status).toBe('missing');
    expect(result.focusedCandidate).toBe(1);
    expect(result).toMatchObject({ selected: false, attended: false });
    expect(env.update).not.toHaveBeenCalled();
    expect(env.windowsUpdate).not.toHaveBeenCalled();
  });
});

describe('candidates', () => {
  const tour = loadTour();
  const step = stepOf(tour, 's1');

  it('T-TAB-27 T-TAB-28: 条件に合う既存のタブが、別のウィンドウのものも含めて入る', async () => {
    const env = makeEnv([
      tab(1, 'https://a.example/app', { windowId: 1, title: 'one' }),
      tab(2, 'https://a.example/app/b', { windowId: 2, title: 'two' }),
    ]);
    const result = await createTabs(env.deps).evaluate(tour, step, {});
    expect(result.candidates).toEqual([
      { tabId: 1, title: 'one', windowId: 1, boundRole: null },
      { tabId: 2, title: 'two', windowId: 2, boundRole: null },
    ]);
  });

  it('T-TAB-29: URL 条件に合わないタブは入らない', async () => {
    const env = makeEnv([tab(1, 'https://a.example/other'), tab(2, 'https://a.example/app')]);
    const result = await createTabs(env.deps).evaluate(tour, step, {});
    expect(result.candidates.map((c) => c.tabId)).toEqual([2]);
  });

  it('T-TAB-30: origins の外のタブは、URL が条件に合っても入らない', async () => {
    const env = makeEnv([tab(1, 'https://evil.example/app'), tab(2, 'chrome://extensions')]);
    const loose: Step = { ...step, url: { origin: 'https://evil.example' } };
    const result = await createTabs(env.deps).evaluate(tour, loose, {});
    expect(result.candidates).toEqual([]);
  });

  it('T-TAB-31: 別の役割に対応付け済みのタブには、その役割の印が付く', async () => {
    const env = makeEnv([tab(1, 'https://a.example/app'), tab(2, 'https://a.example/app')]);
    const result = await createTabs(env.deps).evaluate(tour, step, { second: bind(2) });
    expect(result.candidates.map((c) => [c.tabId, c.boundRole])).toEqual([
      [1, null],
      [2, 'second'],
    ]);
  });

  it('T-TAB-32: 注目中のタブが条件に合えば、そのタブ ID が返る', async () => {
    const env = makeEnv([tab(1, 'https://a.example/app'), tab(2, 'https://a.example/app', { active: true })]);
    const result = await createTabs(env.deps).evaluate(tour, step, {});
    expect(result.focusedCandidate).toBe(2);
  });

  it('T-TAB-33: 注目中のタブが条件に合わなければ null', async () => {
    const env = makeEnv([tab(1, 'https://a.example/app'), tab(2, 'https://a.example/other', { active: true })]);
    const result = await createTabs(env.deps).evaluate(tour, step, {});
    expect(result.focusedCandidate).toBeNull();
  });

  it('T-TAB-34: 条件に合うタブがなければ candidates が空（開くボタンは状態管理が案内する）', async () => {
    const env = makeEnv([tab(1, 'https://a.example/other', { active: true })]);
    const result = await createTabs(env.deps).evaluate(tour, step, {});
    expect(result).toMatchObject({ status: 'missing', candidates: [], focusedCandidate: null });
  });

  it('T-TAB-62: 対応付けのタブが閉じられていれば、判定は missing で候補が返る', async () => {
    const env = makeEnv([tab(2, 'https://a.example/app')]);
    const result = await createTabs(env.deps).evaluate(tour, step, { main: bind(99) });
    expect(result.status).toBe('missing');
    expect(result.candidates.map((c) => c.tabId)).toEqual([2]);
  });
});

describe('イベント', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function collect(env: Env): { events: TabEvent[]; tabs: ReturnType<typeof createTabs> } {
    const tabs = createTabs(env.deps);
    const events: TabEvent[] = [];
    tabs.onEvent((e) => events.push(e));
    return { events, tabs };
  }

  it('T-TAB-35 T-TAB-36: frameId 0 の onCommitted・onHistoryStateUpdated が、デバウンスの後に流れる', () => {
    const env = makeEnv([]);
    const { events } = collect(env);
    env.fire.committed({ tabId: 1, frameId: 0 });
    env.fire.history({ tabId: 2, frameId: 0 });
    expect(events).toEqual([]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(events).toEqual([
      { kind: 'committed', tabId: 1 },
      { kind: 'historyStateUpdated', tabId: 2 },
    ]);
  });

  it('T-TAB-37: frameId が 0 でないイベントは流れない', () => {
    const env = makeEnv([]);
    const { events } = collect(env);
    env.fire.committed({ tabId: 1, frameId: 3 });
    env.fire.history({ tabId: 1, frameId: 3 });
    env.fire.completed({ tabId: 1, frameId: 3 });
    vi.advanceTimersByTime(1000);
    expect(events).toEqual([]);
  });

  it('T-TAB-39: onCommitted が流れ、受け手が組み込み直せる（組み込みはツアーと tabId で行える）', async () => {
    vi.useRealTimers();
    const tour = loadTour();
    const env = makeEnv([tab(1, 'https://a.example/app')]);
    const tabs = createTabs(env.deps);
    expect(await tabs.inject(tour, 1)).toBe(true);
    expect(env.scripting).toHaveBeenCalledWith({ target: { tabId: 1 }, files: ['content.js'] });
  });

  it('T-TAB-40: 同じタブの onCommitted が150ミリ秒以内に続けば、1回にまとまる', () => {
    const env = makeEnv([]);
    const { events } = collect(env);
    env.fire.committed({ tabId: 1, frameId: 0 });
    vi.advanceTimersByTime(100);
    env.fire.committed({ tabId: 1, frameId: 0 });
    vi.advanceTimersByTime(100);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(50);
    expect(events).toEqual([{ kind: 'committed', tabId: 1 }]);
  });

  it('T-TAB-40: 別のタブのイベントはまとめない', () => {
    const env = makeEnv([]);
    const { events } = collect(env);
    env.fire.committed({ tabId: 1, frameId: 0 });
    env.fire.committed({ tabId: 2, frameId: 0 });
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(events).toHaveLength(2);
  });

  it('T-TAB-40: 同じタブの committed と completed は、取りこぼさず順に流れる', () => {
    const env = makeEnv([]);
    const { events } = collect(env);
    env.fire.completed({ tabId: 1, frameId: 0 });
    env.fire.committed({ tabId: 1, frameId: 0 });
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(events).toEqual([
      { kind: 'committed', tabId: 1 },
      { kind: 'completed', tabId: 1 },
    ]);
  });

  it('T-TAB-41: onCompleted で、組み込みに失敗していたタブの組み込みが再試行される', async () => {
    const tour = loadTour();
    const env = makeEnv([tab(1, 'https://a.example/app')]);
    const { events, tabs } = collect(env);
    tabs.setActiveTour(tour);
    env.scripting.mockRejectedValueOnce(new Error('x'));
    await tabs.inject(tour, 1);
    expect(env.scripting).toHaveBeenCalledTimes(1);
    env.fire.completed({ tabId: 1, frameId: 0 });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(env.scripting).toHaveBeenCalledTimes(2);
    expect(events).toEqual([{ kind: 'completed', tabId: 1 }]);
    expect((await tabs.evaluate(tour, stepOf(tour, 's1'), { main: bind(1) })).status).toBe('ok');
  });

  it('T-TAB-41: 実行中のツアーがないとき（終了・完了・一時中断の後）、onCompleted で組み込みを再試行しない（追加）', async () => {
    const tour = loadTour();
    const env = makeEnv([tab(1, 'https://a.example/app')]);
    const { tabs } = collect(env);
    tabs.setActiveTour(tour);
    env.scripting.mockRejectedValueOnce(new Error('x'));
    await tabs.inject(tour, 1);
    tabs.setActiveTour(null);
    env.fire.completed({ tabId: 1, frameId: 0 });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(env.scripting).toHaveBeenCalledTimes(1);
  });

  it('T-TAB-41: 判定・組み込みを依頼されただけでは、実行中のツアーとして覚えない（追加）', async () => {
    const tour = loadTour();
    const env = makeEnv([tab(1, 'https://a.example/app')]);
    const { tabs } = collect(env);
    env.scripting.mockRejectedValueOnce(new Error('x'));
    await tabs.inject(tour, 1);
    await tabs.evaluate(tour, stepOf(tour, 's1'), { main: bind(1) });
    env.fire.completed({ tabId: 1, frameId: 0 });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(env.scripting).toHaveBeenCalledTimes(1);
  });

  it('R-B3: currentTabId は今のウィンドウの注目中のタブの ID を返し、無ければ null', async () => {
    const withActive = collect(makeEnv([tab(1, 'https://a.example/app'), tab(2, 'https://a.example/b', { active: true })]));
    expect(await withActive.tabs.currentTabId()).toBe(2);
    const none = collect(makeEnv([tab(1, 'https://a.example/app')]));
    expect(await none.tabs.currentTabId()).toBeNull();
  });

  it('T-TAB-41: 組み込みに失敗していないタブでは、onCompleted で組み込み直さない', async () => {
    const env = makeEnv([tab(1, 'https://a.example/app')]);
    const { events } = collect(env);
    env.fire.completed({ tabId: 1, frameId: 0 });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(env.scripting).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
  });

  it('T-TAB-22 T-TAB-23: onActivated・onFocusChanged が、待たずに流れる', () => {
    const env = makeEnv([]);
    const { events } = collect(env);
    env.fire.activated();
    env.fire.focusChanged();
    expect(events).toEqual([{ kind: 'activated' }, { kind: 'focusChanged' }]);
  });

  it('T-TAB-61 T-TAB-65: タブが閉じられたら removed が流れ、新しいタブは作られない。待機中のイベントは捨てる', () => {
    const env = makeEnv([]);
    const { events } = collect(env);
    env.fire.committed({ tabId: 1, frameId: 0 });
    env.fire.removed(1);
    vi.advanceTimersByTime(1000);
    expect(events).toEqual([{ kind: 'removed', tabId: 1 }]);
    expect(env.create).not.toHaveBeenCalled();
  });

  it('タブの作成と、URL・読み込み状態の変化が changed として待たずに流れる（タイトルなど他の変化は流れない）', () => {
    const env = makeEnv([]);
    const { events } = collect(env);
    env.fire.created(5);
    env.fire.updated(5, { url: 'https://a.example/app' });
    env.fire.updated(5, { status: 'complete' });
    env.fire.updated(5, {});
    expect(events).toEqual([
      { kind: 'changed', tabId: 5 },
      { kind: 'changed', tabId: 5 },
      { kind: 'changed', tabId: 5 },
    ]);
  });

  it('解除した受け手には流れない', () => {
    const env = makeEnv([]);
    const tabs = createTabs(env.deps);
    const seen: TabEvent[] = [];
    const off = tabs.onEvent((e) => seen.push(e));
    off();
    env.fire.activated();
    expect(seen).toEqual([]);
  });
});

describe('介入の前の確認', () => {
  const tour = loadTour();

  it('T-TAB-45 T-TAB-54: 組み込みの前に、タブの URL が origins に含まれることを確かめる', async () => {
    const env = makeEnv([tab(1, 'https://a.example/app'), tab(2, 'https://evil.example/')]);
    const tabs = createTabs(env.deps);
    expect(await tabs.isWithinOrigins(tour, 1)).toBe(true);
    expect(await tabs.isWithinOrigins(tour, 2)).toBe(false);
    expect(await tabs.isWithinOrigins(tour, 404)).toBe(false);
    expect(await tabs.inject(tour, 2)).toBe(false);
    expect(env.scripting).not.toHaveBeenCalled();
  });

  it('T-TAB-45: 送信の前にも確かめ、範囲内なら frameId 0 へ送る', async () => {
    const env = makeEnv([tab(1, 'https://a.example/app')]);
    await createTabs(env.deps).send(tour, 1, { type: 'PING' });
    expect(env.sendMessage).toHaveBeenCalledWith(1, { type: 'PING' }, { frameId: 0 });
  });

  it('T-TAB-46: origins の外のタブには、他のツアーで権限があっても、組み込みも送信も行わない', async () => {
    const env = makeEnv([tab(1, 'https://evil.example/app')]);
    env.granted.value = true;
    const tabs = createTabs(env.deps);
    expect(await tabs.inject(tour, 1)).toBe(false);
    await tabs.send(tour, 1, { type: 'PING' });
    expect(env.scripting).not.toHaveBeenCalled();
    expect(env.sendMessage).not.toHaveBeenCalled();
  });

  it('送信の失敗（ページ側が無い）は例外にならない', async () => {
    const env = makeEnv([tab(1, 'https://a.example/app')]);
    env.sendMessage.mockRejectedValueOnce(new Error('no receiver'));
    await expect(createTabs(env.deps).send(tour, 1, { type: 'PING' })).resolves.toBeUndefined();
  });
});

describe('open / focus / shortcut', () => {
  it('T-TAB-55: current は今のタブで URL を開き、そのタブ ID を返す', async () => {
    const env = makeEnv([tab(7, 'https://a.example/', { active: true }), tab(8, 'https://a.example/z')]);
    const id = await createTabs(env.deps).open('current', 'https://a.example/app');
    expect(id).toBe(7);
    expect(env.update).toHaveBeenCalledWith(7, { url: 'https://a.example/app' });
  });

  it('T-TAB-56: new は新しいタブを作り、そのタブ ID を返す', async () => {
    const env = makeEnv([]);
    const id = await createTabs(env.deps).open('new', 'https://a.example/app');
    expect(id).toBe(100);
    expect(env.create).toHaveBeenCalledWith({ url: 'https://a.example/app' });
  });

  it('T-TAB-57: http/https 以外の URL は開かず null を返す', async () => {
    const env = makeEnv([tab(7, 'https://a.example/', { active: true })]);
    const tabs = createTabs(env.deps);
    expect(await tabs.open('new', 'javascript:alert(1)')).toBeNull();
    expect(await tabs.open('current', 'chrome://settings')).toBeNull();
    expect(env.create).not.toHaveBeenCalled();
    expect(env.update).not.toHaveBeenCalled();
  });

  it('T-TAB-55: 今のタブが無いとき null を返す', async () => {
    const env = makeEnv([]);
    expect(await createTabs(env.deps).open('current', 'https://a.example/')).toBeNull();
  });

  it('T-TAB-59: focus はタブを active にし、そのウィンドウを前面に出す', async () => {
    const env = makeEnv([tab(1, 'https://a.example/', { windowId: 5 })]);
    await createTabs(env.deps).focus(1);
    expect(env.update).toHaveBeenCalledWith(1, { active: true });
    expect(env.windowsUpdate).toHaveBeenCalledWith(5, { focused: true });
  });

  it('T-TAB-60: 存在しないタブの focus は例外にならず、何も起きない', async () => {
    const env = makeEnv([]);
    await expect(createTabs(env.deps).focus(1)).resolves.toBeUndefined();
    expect(env.windowsUpdate).not.toHaveBeenCalled();
  });

  it('shortcut は _execute_action の割り当てを返し、無ければ null', async () => {
    const env = makeEnv([]);
    const tabs = createTabs(env.deps);
    expect(await tabs.shortcut()).toBe('Ctrl+Shift+Y');
    env.shortcuts[0] = { name: '_execute_action', shortcut: '' };
    expect(await tabs.shortcut()).toBeNull();
    env.shortcuts.length = 0;
    expect(await tabs.shortcut()).toBeNull();
  });
});
