/**
 * ページ側の起動。バックグラウンドからのメッセージを検証して実行器へ渡し、起動時に HELLO を送る。
 * 同じ文書に二重に組み込まれても、動く実行器は最初の1つだけ（`window` に置く印で見分ける）。
 * 2回目以降の組み込みは実行器を作らず、HELLO だけ送り直す。バックグラウンドが文書 ID を記録し直して、
 * すでに動いている実行器へ描画指示を送れるようにするため（ツアーの終了後に同じタブで開始し直すと、組み込みだけが再び走る）。
 * 印は二重の起動を避けるための判定にだけ使い、他の用途には使わない。
 * 拡張機能の再読み込み・更新で文脈が無効になったら（送信の失敗のあとに `contextValid` が偽になる）、
 * 自分の表示（ミニガイド・ハイライト・吹き出し・表示を戻すボタン）をすべて消し、監視を止める。
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
  /** 拡張機能の文脈がまだ有効か（`chrome.runtime.id` が残っているか）。無ければ常に有効とみなす。 */
  contextValid?: () => boolean;
}

export interface BootstrapDeps {
  win: Window & typeof globalThis;
  runtime: RuntimeApi;
  /** ログのレベルの取得元を作る。二重に組み込まれたときは呼ばれない。 */
  createLevel: () => () => Level;
}

/** 起動したら true。すでに動いているときは HELLO だけ送り直して false。 */
export function startContent(deps: BootstrapDeps): boolean {
  const { win, runtime } = deps;
  let disposed = false;
  let stepRuntime: Runtime | null = null;
  /** 送信の失敗のあと、文脈が無効になっていれば、表示を消して監視を止める。 */
  const checkContext = (): void => {
    if (disposed || runtime.contextValid?.() !== false) return;
    disposed = true;
    stepRuntime?.dispose();
  };
  const sendRaw = (message: unknown): void => {
    if (disposed) return;
    try {
      void Promise.resolve(runtime.sendMessage(message)).catch(checkContext);
    } catch {
      // 受け手がいなくてもページ側は止めない
      checkContext();
    }
  };
  /** 応答を返す送信。失敗は握りつぶし、応答が無いものとして null を返す。 */
  const sendForResponse = (message: PageToBg): Promise<unknown> => {
    if (disposed) return Promise.resolve(null);
    try {
      return Promise.resolve(runtime.sendMessage(message)).catch(() => {
        checkContext();
        return null;
      });
    } catch {
      checkContext();
      return Promise.resolve(null);
    }
  };
  if (Reflect.get(win, MARK_KEY) === true) {
    sendRaw({ type: 'HELLO' } satisfies PageToBg);
    return false;
  }
  Reflect.set(win, MARK_KEY, true);

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
  const miniGuide = createMiniGuide({ doc, send: sendForResponse, viewport: () => env.viewport() });
  const created = createRuntime({
    doc,
    env,
    locate,
    // 経過時間の比較に使う時計。壁時計は巻き戻るので、単調に進む performance.now を使う
    now: () => performance.now(),
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

  stepRuntime = created;
  current = created;
  runtime.onMessage.addListener((raw, _sender, sendResponse) => {
    const message = parseBgToPage(raw, logger);
    if (message === null) return undefined;
    if (message.type === 'PING') {
      sendResponse({ ok: true });
      return undefined;
    }
    if (disposed) return undefined;
    created.handle(message);
    return undefined;
  });

  send({ type: 'HELLO' });
  return true;
}
