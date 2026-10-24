/**
 * 配線の最小の確認。振り分け・送信元の確認・未知のメッセージの破棄・起動時の順序。
 * Chrome API と部品は偽物を差し込む。
 */
import { describe, expect, it, vi } from 'vitest';
import { parseLogMessage } from '../../shared/logger/index.ts';
import { PanelViewSchema } from '../../shared/messages/index.ts';
import { createRouter, type MessageSenderLike, type RouterDeps } from './router.ts';
import { createStartup } from './startup.ts';

const EXT = 'abcdefghijklmnopabcdefghijklmnop';
const PANEL: MessageSenderLike = { url: `chrome-extension://${EXT}/sidepanel.html` };
const PAGE: MessageSenderLike = {
  url: 'https://example.com/a',
  frameId: 0,
  documentId: 'doc-1',
  tab: { id: 7 },
};

const VIEW = PanelViewSchema.parse({
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
  catalog: [],
  ui: { enabled: true, mode: 'expanded', width: 320 },
  logLevel: 'warn',
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

function setup() {
  const calls: string[] = [];
  const session = {
    handlePanel: vi.fn((msg: { type: string }) => {
      calls.push(`panel:${msg.type}`);
      return Promise.resolve({ status: 'done' });
    }),
    handlePage: vi.fn(() => Promise.resolve({ status: 'done' })),
    onCatalogChanged: vi.fn((tourId: string, hash: string) => {
      calls.push(`changed:${tourId}:${hash}`);
      return Promise.resolve();
    }),
    onCatalogRemoved: vi.fn((tourId: string) => {
      calls.push(`removed:${tourId}`);
      return Promise.resolve();
    }),
    view: vi.fn(() => Promise.resolve(VIEW)),
  };
  const catalog = {
    reload: vi.fn(() => {
      calls.push('reload');
      return Promise.resolve();
    }),
    remove: vi.fn(() => {
      calls.push('remove');
      return Promise.resolve(true);
    }),
  };
  const logstore = {
    ingest: vi.fn(),
    exportJsonl: vi.fn(() => Promise.resolve('')),
    clear: vi.fn(() => Promise.resolve()),
  };
  const diagnostics = {
    list: vi.fn(() => Promise.resolve([])),
    export: vi.fn(() => Promise.resolve([])),
    clear: vi.fn(() => Promise.resolve()),
  };
  const deps: RouterDeps = {
    extensionId: EXT,
    session,
    catalog,
    diagnostics,
    logstore,
    logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    notifyPanel: vi.fn(),
    ready: () => Promise.resolve(),
  };
  return { router: createRouter(deps), session, catalog, logstore, diagnostics, calls };
}

describe('配線', () => {
  it('R-WIRE-01: サイドパネルのメッセージは状態管理へ渡し、応答を返す', async () => {
    const t = setup();
    const send = vi.fn();
    const keep = t.router.onMessage({ type: 'GET_STATE' }, PANEL, send);
    await flush();
    expect(keep).toBe(true);
    expect(t.session.handlePanel).toHaveBeenCalledWith({ type: 'GET_STATE' });
    expect(send).toHaveBeenCalledWith({ status: 'done' });
  });

  it('R-WIRE-02: サイドパネル以外の拡張機能ページ・別のページの URL を名乗る送信元は捨てる', async () => {
    const t = setup();
    const send = vi.fn();
    const others: MessageSenderLike[] = [
      { url: `chrome-extension://${EXT}/other.html` },
      { url: 'chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/sidepanel.html' },
      {},
    ];
    for (const sender of others) {
      expect(t.router.onMessage({ type: 'GET_STATE' }, sender, send)).toBe(false);
    }
    await flush();
    expect(t.session.handlePanel).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('R-WIRE-03: ページ側のメッセージは sender の tab・frame・document を付けて状態管理へ渡す', async () => {
    const t = setup();
    const send = vi.fn();
    expect(t.router.onMessage({ type: 'HELLO' }, PAGE, send)).toBe(true);
    await flush();
    expect(t.session.handlePage).toHaveBeenCalledWith(
      { type: 'HELLO' },
      { tabId: 7, frameId: 0, documentId: 'doc-1' },
    );
    expect(send).toHaveBeenCalledWith({ status: 'done' });
  });

  it('R-WIRE-04: 子フレーム・タブのない送信元のページ側メッセージと、ページ側からのパネル専用メッセージは捨てる', async () => {
    const t = setup();
    const send = vi.fn();
    expect(t.router.onMessage({ type: 'HELLO' }, { ...PAGE, frameId: 3 }, send)).toBe(false);
    expect(t.router.onMessage({ type: 'HELLO' }, { url: PAGE.url, frameId: 0 }, send)).toBe(false);
    expect(t.router.onMessage({ type: 'RELOAD' }, PAGE, send)).toBe(false);
    expect(t.router.onMessage({ type: 'CLEAR_LOGS' }, PAGE, send)).toBe(false);
    await flush();
    expect(t.session.handlePage).not.toHaveBeenCalled();
    expect(t.catalog.reload).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('R-WIRE-05: 未知・不正な形のメッセージは捨てる', async () => {
    const t = setup();
    const send = vi.fn();
    for (const raw of [{ type: 'UNKNOWN' }, null, 'x', { type: 'START' }]) {
      expect(t.router.onMessage(raw, PANEL, send)).toBe(false);
      expect(t.router.onMessage(raw, PAGE, send)).toBe(false);
    }
    await flush();
    expect(t.session.handlePanel).not.toHaveBeenCalled();
    expect(t.session.handlePage).not.toHaveBeenCalled();
  });

  it('R-WIRE-06: LOG は送り手の実行場所を付けて logstore へ渡し、応答しない', () => {
    const t = setup();
    const send = vi.fn();
    const log = { type: 'LOG', entries: [] };
    expect(t.router.onMessage(log, PANEL, send)).toBe(false);
    expect(t.router.onMessage(log, PAGE, send)).toBe(false);
    expect(t.logstore.ingest).toHaveBeenNthCalledWith(1, log, 'sidepanel');
    expect(t.logstore.ingest).toHaveBeenNthCalledWith(2, log, 'content');
  });

  it('R-WIRE-07: CATALOG_CHANGED は reload の後に状態管理へ、REMOVE は remove の後に削除として通知する', async () => {
    const t = setup();
    const send = vi.fn();
    t.router.onMessage({ type: 'CATALOG_CHANGED', tourId: 'a', hash: 'h' }, PANEL, send);
    await flush();
    t.router.onMessage({ type: 'REMOVE', tourId: 'a' }, PANEL, send);
    await flush();
    expect(t.calls).toEqual(['reload', 'panel:CATALOG_CHANGED', 'remove', 'removed:a']);
    expect(send).toHaveBeenNthCalledWith(1, { ok: true });
    expect(send).toHaveBeenNthCalledWith(2, { ok: true });
  });

  it('R-WIRE-08: GET_DIAGNOSTICS・EXPORT_LOGS・CLEAR_LOGS は応答の形で返し、CLEAR_LOGS はログと保守記録の両方を消す', async () => {
    const t = setup();
    const send = vi.fn();
    t.router.onMessage({ type: 'GET_DIAGNOSTICS' }, PANEL, send);
    t.router.onMessage({ type: 'EXPORT_LOGS' }, PANEL, send);
    t.router.onMessage({ type: 'CLEAR_LOGS' }, PANEL, send);
    await flush();
    expect(send).toHaveBeenCalledWith({ entries: [] });
    expect(send).toHaveBeenCalledWith({ logs: '', diagnostics: '[]' });
    expect(send).toHaveBeenCalledWith({ ok: true });
    expect(t.logstore.clear).toHaveBeenCalled();
    expect(t.diagnostics.clear).toHaveBeenCalled();
  });

  it('R-WIRE-09: 起動時は reload → logstore.start → recover → サイドパネルの設定の順に行い、二重には行わない', async () => {
    const order: string[] = [];
    const step = (name: string) => () => {
      order.push(name);
      return Promise.resolve();
    };
    const startup = createStartup({
      catalog: { reload: step('reload') },
      logstore: { start: step('logstore') },
      session: { recover: step('recover') },
      sidePanel: {
        setPanelBehavior: (b) => {
          order.push(`panel:${String(b.openPanelOnActionClick)}`);
          return Promise.resolve();
        },
      },
      logger: { error: vi.fn() },
    });
    await Promise.all([startup.start(), startup.start()]);
    await startup.ready();
    expect(order).toEqual(['reload', 'logstore', 'recover', 'panel:true']);
  });

  it('R-WIRE-10: 起動の1段階が失敗しても残りを続ける', async () => {
    const order: string[] = [];
    const error = vi.fn();
    const startup = createStartup({
      catalog: { reload: () => Promise.reject(new Error('x')) },
      logstore: { start: () => Promise.resolve(void order.push('logstore')) },
      session: { recover: () => Promise.resolve(void order.push('recover')) },
      sidePanel: { setPanelBehavior: () => Promise.resolve(void order.push('panel')) },
      logger: { error },
    });
    await startup.start();
    expect(order).toEqual(['logstore', 'recover', 'panel']);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('R-WIRE-11: サイドパネルとページ側の LOG は、ログの保管がそのまま検査し直せる元の形で渡す', () => {
    const t = setup();
    const entry = {
      ts: 1,
      level: 'info',
      ctx: 'sidepanel',
      event: 'import.result',
      fields: { result: 'imported', files: 1, bytes: 10 },
    };
    const log = { type: 'LOG', entries: [entry] };
    t.router.onMessage(log, PANEL, vi.fn());
    t.router.onMessage({ ...log, entries: [{ ...entry, ctx: 'content' }] }, PAGE, vi.fn());
    expect(t.logstore.ingest).toHaveBeenCalledTimes(2);
    for (const [message] of t.logstore.ingest.mock.calls) {
      const parsed = parseLogMessage(message);
      expect(parsed?.map((r) => r.ok)).toEqual([true]);
    }
  });
});
