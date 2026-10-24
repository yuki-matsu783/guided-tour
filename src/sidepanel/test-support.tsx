/**
 * サイドパネルの画面のテストが共有する部品（描画・操作・偽の依存・写しの組み立て）。
 * `@testing-library` は使わず、React の `createRoot` と `act` だけで描く。製品のコードからは使わない。
 */
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { vi } from 'vitest';
import { GenSchema, SessionIdSchema } from '../shared/ids/index.ts';
import type { CatalogEntry, PanelToBg, PanelView } from '../shared/messages/index.ts';
import type { PanelDeps } from './deps.ts';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

export interface Mounted {
  container: HTMLElement;
  unmount: () => Promise<void>;
}

const mounted: Mounted[] = [];

export async function mount(ui: ReactNode): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  await flush(1);
  const result: Mounted = {
    container,
    unmount: async () => {
      act(() => {
        root.unmount();
      });
      container.remove();
      await flush(1);
    },
  };
  mounted.push(result);
  return result;
}

/** 描いたものをすべて片付ける（afterEach で呼ぶ）。 */
export async function unmountAll(): Promise<void> {
  for (const m of mounted.splice(0)) await m.unmount();
  document.body.replaceChildren();
}

/** 待っている Promise と描き直しを流す。 */
export async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

export function buttons(root: ParentNode): HTMLButtonElement[] {
  return [...root.querySelectorAll('button')];
}

/** ボタンの名前（読み上げに使われない aria-hidden の部分を除いた文字列）。 */
export function buttonName(button: Element): string {
  const copy = button.cloneNode(true);
  if (!(copy instanceof HTMLElement)) return '';
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return copy.textContent.trim();
}

/** 名前が一致するボタン。無ければ null。 */
export function findButton(root: ParentNode, name: string): HTMLButtonElement | null {
  return buttons(root).find((b) => buttonName(b) === name) ?? null;
}

export function getButton(root: ParentNode, name: string): HTMLButtonElement {
  const found = findButton(root, name);
  if (found === null) {
    throw new Error(`ボタン「${name}」が無い。ある: ${buttons(root).map(buttonName).join(' / ')}`);
  }
  return found;
}

export async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await flush();
}

export function textOf(root: ParentNode): string {
  return root instanceof Node ? (root.textContent ?? '') : '';
}

export const SESSION = SessionIdSchema.parse('session-1');
export const GEN = GenSchema.parse(3);

export function makeView(over: Partial<PanelView> = {}): PanelView {
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
    catalog: [],
    ui: { enabled: true, mode: 'expanded', width: 320 },
    logLevel: 'warn',
    ...over,
  };
}

export function entry(over: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: 'demo',
    name: 'デモツアー',
    description: '使い方の例です',
    stepCount: 3,
    origins: ['https://example.com'],
    source: 'bundled',
    hasPermission: true,
    needsReview: false,
    progress: null,
    ...over,
  };
}

/** 実際の時間で待つ（間引きの待ちなど）。 */
export async function wait(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** 実行中の写し。ツアー `demo`（同梱）の3ステップ目標。 */
export function runningView(over: Partial<PanelView> = {}): PanelView {
  return makeView({
    status: 'running',
    sessionId: SESSION,
    gen: GEN,
    tour: {
      id: 'demo',
      name: 'デモツアー',
      hash: 'h1',
      origins: ['https://example.com'],
      source: 'bundled',
    },
    steps: [
      { id: 's1', title: '最初のステップ', kind: 'page' },
      { id: 's2', title: '次のステップ', kind: 'guide' },
      { id: 's3', title: '最後のステップ', kind: 'page' },
    ],
    stepIndex: 0,
    tabStatus: { role: 'main', status: 'ok', candidates: [], attended: true, selected: true },
    ...over,
  });
}

export interface FakeDeps extends PanelDeps {
  sent: PanelToBg[];
  /** `GET_STATE` が返す写し。null なら拒否する（応答なし）。 */
  state: { view: PanelView | null };
  /** `send` の応答を操作の種類ごとに決める（既定は done）。 */
  respond: (message: PanelToBg) => unknown;
  /** バックグラウンドからの通知を流す。 */
  emit: (raw: unknown) => void;
  files: Map<string, Blob>;
  texts: Map<string, string>;
  saved: { name: string; text: string; mime: string }[];
  request: ReturnType<typeof vi.fn<(query: { origins: string[] }) => Promise<boolean>>>;
}

export function makeDeps(view: PanelView | null = makeView()): FakeDeps {
  const listeners = new Set<(raw: unknown) => void>();
  const files = new Map<string, Blob>();
  const texts = new Map<string, string>();
  const saved: FakeDeps['saved'] = [];
  const request = vi.fn<(query: { origins: string[] }) => Promise<boolean>>(() => Promise.resolve(true));
  const deps: FakeDeps = {
    sent: [],
    state: { view },
    respond: () => ({ status: 'done' }),
    files,
    texts,
    saved,
    request,
    emit: (raw) => {
      for (const l of listeners) l(raw);
    },
    send(message) {
      deps.sent.push(message);
      if (message.type === 'GET_STATE') {
        return deps.state.view === null
          ? Promise.reject(new Error('no receiver'))
          : Promise.resolve(deps.state.view);
      }
      return Promise.resolve(deps.respond(message));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    permissions: { request },
    getUrl: (path) => `chrome-extension://test/${path}`,
    fetchText: (url) => Promise.resolve(texts.get(url) ?? null),
    readTourRecord: () => Promise.resolve(null),
    readStoredFile: (tourId, hash, path) => Promise.resolve(files.get([tourId, hash, path].join('/')) ?? null),
    importFiles: () => Promise.resolve([]),
    bundledTourIds: () => Promise.resolve([]),
    getActiveTabId: () => Promise.resolve(null),
    writeLogLevel: () => Promise.resolve(true),
    saveFile: (name, text, mime) => {
      saved.push({ name, text, mime });
    },
    createObjectUrl: () => 'blob:fake',
    revokeObjectUrl: () => undefined,
    now: () => 0,
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  };
  return deps;
}
