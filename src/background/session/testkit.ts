/**
 * 状態管理のテスト用の偽物と道具。storage・タブ管理・ツアー管理・権限・ログを差し込み、
 * 「指定した処理の前後で打ち切る（Service Worker が止まる）」ことと、同じ storage の上で復帰することを試せる。
 */
import { TourSchema, type Tour } from '../../core/tour/index.ts';
import {
  GenSchema,
  OpIdSchema,
  SessionIdSchema,
  type Gen,
  type OpId,
  type SessionId,
} from '../../shared/ids/index.ts';
import type { PanelToBg, PageToBg, PanelView, BgToPage } from '../../shared/messages/index.ts';
import type { Logger } from '../../shared/logger/index.ts';
import type {
  CatalogEntry,
  CatalogPort,
  CatalogTour,
  RoleBinding,
  TabEvaluation,
  TabEvent,
  TabsPort,
} from '../ports.ts';
import { createSession, type Session } from './session.ts';
import { STATE_KEY, type TourState, TourStateSchema } from './state.ts';
import type { PageSender, SessionDeps, StorageArea } from './types.ts';

export const ORIGIN = 'https://example.com';

export function makeTour(over: { id?: string; minExtensionVersion?: string; extraStep?: boolean } = {}): Tour {
  const page = (id: string, tab?: string): Record<string, unknown> => ({
    id,
    title: `手順 ${id}`,
    url: { origin: ORIGIN },
    target: { testId: `t-${id}` },
    done: { type: 'element', target: { testId: `d-${id}` } },
    ...(tab === undefined ? {} : { tab }),
  });
  return TourSchema.parse({
    schemaVersion: 3,
    id: over.id ?? 't1',
    name: 'テスト用ツアー',
    origins: [ORIGIN],
    ...(over.minExtensionVersion === undefined ? {} : { minExtensionVersion: over.minExtensionVersion }),
    tabs: { main: { open: `${ORIGIN}/start` }, other: {} },
    steps: [
      { ...page('s1'), open: `${ORIGIN}/start` },
      page('s2'),
      { id: 's3', title: '案内', kind: 'guide' },
      page('s4', 'other'),
      ...(over.extraStep === true ? [page('s5')] : []),
    ],
  });
}

export const sid = (s: string): SessionId => SessionIdSchema.parse(s);
export const opId = (n: number | string): OpId => OpIdSchema.parse(`op-${String(n)}`);
export const gen = (n: number): Gen => GenSchema.parse(n);

// ---- 打ち切り ----

const never = (): Promise<never> => new Promise<never>(() => undefined);

/** 指定した回数目の処理の前か後で止める。止まった後の処理はすべて返らない（古い実体は動かない）。 */
export class Crash {
  crashed = false;
  /** 完了した処理の順（ラベル）。 */
  readonly events: string[] = [];
  private readonly counts = new Map<string, number>();
  private target: { label: string; nth: number; when: 'before' | 'after' } | null = null;

  arm(label: string, when: 'before' | 'after', nth = 1): void {
    this.target = { label, nth, when };
  }

  count(label: string): number {
    return this.counts.get(label) ?? 0;
  }

  async guard<T>(label: string, op: () => Promise<T>): Promise<T> {
    if (this.crashed) return never();
    const n = this.count(label) + 1;
    this.counts.set(label, n);
    const hit = this.target?.label === label && this.target.nth === n;
    if (hit && this.target?.when === 'before') {
      this.crashed = true;
      return never();
    }
    const result = await op();
    this.events.push(label);
    if (hit && this.target?.when === 'after') {
      this.crashed = true;
      return never();
    }
    return result;
  }
}

// ---- storage ----

export class FakeArea {
  readonly data = new Map<string, unknown>();
  /** 真なら set が失敗する。関数なら、書く鍵（カンマ区切り）を見て失敗するかを決める。 */
  failSet: boolean | ((keys: string) => boolean) = false;
  failRemove = false;
  failGet = false;
  /** set・remove の呼び出しの記録（順序の確認用）。 */
  readonly ops: string[] = [];
  /** 同時に走っている書き込みの数の最大値。 */
  maxConcurrent = 0;
  private running = 0;
  /** 非同期の揺らぎ（直列化の確認用）。 */
  delay = false;

  constructor(readonly name: string) {}

  private async tick(): Promise<void> {
    if (this.delay) await new Promise((r) => setTimeout(r, 1));
    else await Promise.resolve();
  }

  /** 書き込みの実体。`ops` に記録し、同時実行数を測る。 */
  private async write(label: string, fn: () => void, fail: boolean): Promise<void> {
    this.running += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.running);
    try {
      await this.tick();
      if (fail) throw new Error('storage failure');
      fn();
      this.ops.push(`${this.name}.${label}`);
    } finally {
      this.running -= 1;
    }
  }

  area(crash?: Crash): StorageArea {
    const guard = <T>(label: string, op: () => Promise<T>): Promise<T> =>
      crash === undefined ? op() : crash.guard(`${this.name}.${label}`, op);
    return {
      get: (key) =>
        guard('get', async () => {
          await this.tick();
          if (this.failGet) throw new Error('storage failure');
          return this.data.has(key) ? { [key]: structuredClone(this.data.get(key)) } : {};
        }),
      set: (items) =>
        guard('set', () =>
          this.write(
            `set:${Object.keys(items).join(',')}`,
            () => {
              for (const [k, v] of Object.entries(items)) this.data.set(k, structuredClone(v));
            },
            typeof this.failSet === 'function' ? this.failSet(Object.keys(items).join(',')) : this.failSet,
          ),
        ),
      remove: (key) =>
        guard('remove', () => this.write(`remove:${key}`, () => this.data.delete(key), this.failRemove)),
    };
  }
}

// ---- タブ管理 ----

export interface SentRecord {
  readonly to: 'all' | number;
  readonly message: BgToPage;
}

export class FakeTabs {
  readonly sent: SentRecord[] = [];
  readonly injected: number[] = [];
  readonly opened: { mode: 'current' | 'new'; url: string }[] = [];
  readonly focused: number[] = [];
  /** 評価の差し替え。既定は「対応付け済みなら ok、なければ missing」。 */
  evaluateImpl: (tour: Tour, role: string, roles: Readonly<Record<string, RoleBinding>>) => Partial<TabEvaluation> = (
    _t,
    role,
    roles,
  ) => ({ status: roles[role] === undefined ? 'missing' : 'ok' });
  within = true;
  injectOk = true;
  openResult: number | null = 99;
  shortcutValue: string | null = 'Alt+Shift+G';
  private listeners: ((e: TabEvent) => void)[] = [];

  port(crash?: Crash): TabsPort {
    const guard = <T>(label: string, op: () => Promise<T>): Promise<T> =>
      crash === undefined ? op() : crash.guard(label, op);
    return {
      evaluate: (tour, step, roles) => {
        const part = this.evaluateImpl(tour, step.tab, roles);
        return Promise.resolve({
          role: step.tab,
          status: 'ok',
          selected: true,
          attended: true,
          candidates: [],
          focusedCandidate: null,
          ...part,
        });
      },
      isWithinOrigins: () => Promise.resolve(this.within),
      inject: (_tour, tabId) =>
        guard('tabs.inject', () => {
          this.injected.push(tabId);
          return Promise.resolve(this.injectOk);
        }),
      open: (mode, url) =>
        guard('tabs.open', () => {
          this.opened.push({ mode, url });
          return Promise.resolve(this.openResult);
        }),
      focus: (tabId) =>
        guard('tabs.focus', () => {
          this.focused.push(tabId);
          return Promise.resolve();
        }),
      send: (_tour, tabId, message) =>
        guard('tabs.send', () => {
          this.sent.push({ to: tabId, message });
          return Promise.resolve();
        }),
      broadcast: (message) =>
        guard('tabs.broadcast', () => {
          this.sent.push({ to: 'all', message });
          return Promise.resolve();
        }),
      onEvent: (listener) => {
        this.listeners.push(listener);
        return () => {
          this.listeners = this.listeners.filter((l) => l !== listener);
        };
      },
      shortcut: () => Promise.resolve(this.shortcutValue),
    };
  }

  messages<T extends BgToPage['type']>(type: T): Extract<BgToPage, { type: T }>[] {
    return this.sent
      .map((r) => r.message)
      .filter((m): m is Extract<BgToPage, { type: T }> => m.type === type);
  }

  types(): string[] {
    return this.sent.map((r) => r.message.type);
  }

  clear(): void {
    this.sent.length = 0;
    this.injected.length = 0;
    this.opened.length = 0;
    this.focused.length = 0;
  }
}

// ---- ツアー管理 ----

export class FakeCatalog {
  /** 現在の版。無ければ削除済み。 */
  readonly current = new Map<string, CatalogTour>();
  /** 固定できる版（`hash` ごと）。 */
  readonly versions = new Map<string, CatalogTour>();
  /** 旧版が取れなくなったことにするか。 */
  dropOldVersions = false;

  set(tour: Tour, hash: string): void {
    const entry: CatalogTour = { tour, hash, source: 'imported' };
    if (this.dropOldVersions) this.versions.clear();
    this.current.set(tour.id, entry);
    this.versions.set(`${tour.id}:${hash}`, entry);
  }

  remove(id: string): void {
    this.current.delete(id);
  }

  port(): CatalogPort {
    return {
      list: () =>
        Promise.resolve(
          [...this.current.values()].map((e): CatalogEntry => ({ ...e, shadowsBundled: false })),
        ),
      get: (id) => Promise.resolve(this.current.get(id) ?? null),
      getPinned: (id, hash) => Promise.resolve(this.versions.get(`${id}:${hash}`) ?? null),
      remove: (id) => Promise.resolve(this.current.delete(id)),
      reload: () => Promise.resolve(),
    };
  }
}

// ---- 環境 ----

export interface LogRecord {
  readonly level: string;
  readonly event: string;
  readonly fields: unknown;
}

export interface Env {
  readonly sessionArea: FakeArea;
  readonly localArea: FakeArea;
  readonly tabs: FakeTabs;
  readonly catalog: FakeCatalog;
  readonly logs: LogRecord[];
  readonly panels: PanelView[];
  readonly records: { tourId: string; stepId: string; sessionId: string; gen: number; summary: unknown }[];
  readonly perms: { has: boolean };
  readonly clock: { t: number };
  readonly ids: { n: number };
  readonly version: { value: string };
  session: Session;
  /** Service Worker の再起動。同じ storage の上で、新しい実体を作る。 */
  restart(): Session;
  /** 打ち切りの制御を付けた実体に作り替える（それまでの状態は storage にある）。 */
  withCrash(crash: Crash): Session;
  /** storage.session の状態（検証済み）。 */
  state(): TourState | null;
  progress(): Record<string, Record<string, unknown> | undefined>;
}

export function createEnv(tour: Tour = makeTour()): Env {
  const sessionArea = new FakeArea('session');
  const localArea = new FakeArea('local');
  const tabs = new FakeTabs();
  const catalog = new FakeCatalog();
  catalog.set(tour, 'h1');
  const logs: LogRecord[] = [];
  const panels: PanelView[] = [];
  const records: Env['records'] = [];
  const perms = { has: true };
  const clock = { t: 1000 };
  const ids = { n: 0 };
  const version = { value: '1.0.0' };
  const logger: Logger = (() => {
    const mk =
      (level: string) =>
      (event: string, fields: unknown): void => {
        logs.push({ level, event, fields });
      };
    return { error: mk('error'), warn: mk('warn'), info: mk('info'), debug: mk('debug') };
  })();

  const build = (crash?: Crash): Session => {
    const guard = <T>(label: string, op: () => Promise<T>): Promise<T> =>
      crash === undefined ? op() : crash.guard(label, op);
    const deps: SessionDeps = {
      storageSession: sessionArea.area(crash),
      storageLocal: localArea.area(crash),
      catalog: catalog.port(),
      tabs: tabs.port(crash),
      permissions: { contains: () => Promise.resolve(perms.has) },
      diagnostics: {
        record: (tourId, stepId, sessionId, g, summary) => {
          records.push({ tourId, stepId, sessionId, gen: g, summary });
          return Promise.resolve();
        },
        needsReview: () => Promise.resolve(false),
      },
      logger,
      notifyPanel: (view) =>
        guard('panel', () => {
          panels.push(view);
          return Promise.resolve();
        }),
      extensionVersion: version.value,
      now: () => (clock.t += 1),
      randomId: () => `sess-${String((ids.n += 1))}`,
    };
    return createSession(deps);
  };

  const env: Env = {
    sessionArea,
    localArea,
    tabs,
    catalog,
    logs,
    panels,
    records,
    perms,
    clock,
    ids,
    version,
    session: build(),
    restart() {
      env.session = build();
      return env.session;
    },
    withCrash(crash) {
      env.session = build(crash);
      return env.session;
    },
    state() {
      const parsed = TourStateSchema.safeParse(sessionArea.data.get(STATE_KEY));
      return parsed.success ? parsed.data : null;
    },
    progress() {
      const raw = localArea.data.get('progress');
      return typeof raw === 'object' && raw !== null ? { ...raw } : {};
    },
  };
  return env;
}

// ---- 操作の補助 ----

export const SENDER_DOC = 'doc-1';
export const ROLE_TAB = 10;

export function sender(tabId: number | undefined = ROLE_TAB, documentId: string | undefined = SENDER_DOC, frameId: number | undefined = 0): PageSender {
  return { tabId, frameId, documentId };
}

let opCounter = 1000;
export const freshOp = (): OpId => opId((opCounter += 1));

/** ツアーを開始して、現在の `sessionId`・`gen` を返す。 */
export async function startTour(env: Env, resume = false, tourId = 't1'): Promise<void> {
  await env.session.handlePanel({ type: 'START', tourId, resume, opId: freshOp() });
}

export function cur(env: Env): { sessionId: SessionId; gen: Gen } {
  const st = env.state();
  if (st === null) throw new Error('状態がない');
  return { sessionId: st.sessionId, gen: st.gen };
}

/** 現在の役割のタブを対応付け、`HELLO` まで済ませる（組み込み済みの状態にする）。 */
export async function bindAndHello(env: Env, tabId = ROLE_TAB, doc = SENDER_DOC): Promise<void> {
  const { sessionId, gen: g } = cur(env);
  await env.session.handlePanel({ type: 'BIND_TAB', tabId, force: false, sessionId, gen: g, opId: freshOp() });
  await env.session.handlePage({ type: 'HELLO' }, sender(tabId, doc));
}

export async function startBound(env: Env): Promise<void> {
  await startTour(env);
  await bindAndHello(env);
  env.tabs.clear();
}

export function gotoMsg(env: Env, to: number, id: OpId = freshOp()): PanelToBg {
  const { sessionId, gen: g } = cur(env);
  return { type: 'GOTO', to, sessionId, gen: g, opId: id };
}

export function pageGoto(env: Env, to: number): PageToBg {
  const { sessionId, gen: g } = cur(env);
  return { type: 'GOTO', to, sessionId, gen: g, opId: freshOp() };
}

export function sessionOp<T extends 'PAUSE' | 'RESUME' | 'STOP' | 'RESTART'>(env: Env, type: T): { type: T; sessionId: SessionId; opId: OpId } {
  return { type, sessionId: cur(env).sessionId, opId: freshOp() };
}

/** 打ち切りが起きるまで待つ（起きなければ失敗）。 */
export async function waitCrash(crash: Crash): Promise<void> {
  for (let i = 0; i < 200 && !crash.crashed; i++) await new Promise((r) => setTimeout(r, 0));
  if (!crash.crashed) throw new Error('打ち切りの位置に達しなかった');
}

/** 非同期の後始末を流す。 */
export async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}
