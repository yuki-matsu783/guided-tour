/**
 * ページ側の起動。バックグラウンドからのメッセージを検証して実行器へ渡し、起動時に HELLO を送る。
 * 同じ文書に二重に組み込まれても、動くのは最初の1つだけ（`window` に置く印で見分ける）。
 * 印は二重の起動を避けるための判定にだけ使い、他の用途には使わない。
 */
import { defaultEnv, locate } from '../core/locator/index.ts';
import {
  createLogger,
  createMessageSink,
  type Level,
  type Logger,
} from '../shared/logger/index.ts';
import { parseBgToPage, type PageToBg } from '../shared/messages/index.ts';
import { createMiniGuide } from './miniguide/index.ts';
import { createOverlay } from './overlay/index.ts';
import { createRuntime, type Runtime } from './runtime/index.ts';
import { createDomObserver } from './runtime/observer.ts';

const MARK_KEY = '__guidedTourContentStarted';

export interface RuntimeApi {
  onMessage: {
    addListener(
      listener: (message: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => boolean | undefined,
    ): void;
  };
  sendMessage(message: unknown): unknown;
}

export interface BootstrapDeps {
  win: Window & typeof globalThis;
  runtime: RuntimeApi;
  /** ログのレベルの取得元を作る。二重に組み込まれたときは呼ばれない。 */
  createLevel: () => () => Level;
}

/** 起動したら true。すでに動いているときは何もせず false。 */
export function startContent(deps: BootstrapDeps): boolean {
  const { win, runtime } = deps;
  if (Reflect.get(win, MARK_KEY) === true) return false;
  Reflect.set(win, MARK_KEY, true);

  const sendRaw = (message: unknown): void => {
    try {
      void Promise.resolve(runtime.sendMessage(message)).catch(() => undefined);
    } catch {
      // 受け手がいなくてもページ側は止めない
    }
  };
  const send = (message: PageToBg): void => {
    sendRaw(message);
  };

  const logger: Logger = createLogger('content', createMessageSink(sendRaw), deps.createLevel());
  const doc = win.document;
  const env = defaultEnv(win);

  let current: Runtime | null = null;
  const overlay = createOverlay({
    doc,
    send,
    getSessionId: () => current?.getSessionId() ?? null,
    viewport: () => env.viewport(),
  });
  const miniGuide = createMiniGuide({ doc, send, viewport: () => env.viewport() });
  const stepRuntime = createRuntime({
    doc,
    env,
    locate,
    now: () => Date.now(),
    requestFrame: (fn) => win.requestAnimationFrame(fn),
    cancelFrame: (id) => {
      win.cancelAnimationFrame(id);
    },
    createObserver: createDomObserver(win.MutationObserver),
    send,
    overlay,
    miniGuide,
    logger,
  });

  current = stepRuntime;
  runtime.onMessage.addListener((raw, _sender, sendResponse) => {
    const message = parseBgToPage(raw, logger);
    if (message === null) return undefined;
    if (message.type === 'PING') {
      sendResponse({ ok: true });
      return undefined;
    }
    stepRuntime.handle(message);
    return undefined;
  });

  send({ type: 'HELLO' });
  return true;
}
