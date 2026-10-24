/**
 * 完了の目安の監視。要素の出現・状態（入力済み・チェック済み・選択・展開・押下）を判定する。
 * 判定は `evaluateDone`（その場で求めて返すだけ）、いつ判定するかは `createWatchTriggers`
 * （input・change イベント、ページの変化、1秒ごとの定期確認）が決める。
 * 入力欄の値は文字数を求めるためにその場で参照するだけで、変数に残さず、比較・記録・送信もしない。
 * `type="password"` の欄は判定しない（文字数も見ない）。
 * 完了ページ（`done.type: page`）はバックグラウンドが判定するので、ここでは扱わない。
 */
import type { LocateOptions, LocateResult, LocatorEnv, LocatorTarget } from '../../core/locator/index.ts';
import type { PageDone } from '../../shared/messages/index.ts';
import { defaultTimers, type TimerDeps, type TimerHandle } from '../timers.ts';

export type DoneState = 'met' | 'unmet' | 'unsupported';

export type LocateFn = (
  target: LocatorTarget,
  doc: Document,
  env: LocatorEnv,
  options?: LocateOptions,
) => LocateResult | Promise<LocateResult>;

export interface EvaluateDeps {
  doc: Document;
  env: LocatorEnv;
  locate: LocateFn;
}

/** 入力済みの最小の文字数（`minLength` を省いたとき）。 */
const DEFAULT_MIN_LENGTH = 1;
/** 定期確認の間隔（ミリ秒）。 */
export const POLL_MS = 1000;
/** ページの変化に伴う判定の最短の間隔（ミリ秒）。 */
export const THROTTLE_MS = 250;

function isPassword(el: Element): boolean {
  return el instanceof HTMLInputElement && el.type.toLowerCase() === 'password';
}

/** 値の文字数だけを返す。値そのものは呼び出し元へ渡さない。 */
function valueLength(el: Element): number {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    return el.value.length;
  }
  return el.textContent.length;
}

function ariaIsTrue(el: Element, name: string): boolean {
  return el.getAttribute(name) === 'true';
}

function judge(done: PageDone, el: Element): DoneState {
  if (done.type === 'element') return 'met';
  switch (done.state) {
    case 'filled':
      if (isPassword(el)) return 'unsupported';
      return valueLength(el) >= (done.minLength ?? DEFAULT_MIN_LENGTH) ? 'met' : 'unmet';
    case 'checked': {
      const prop = el instanceof HTMLInputElement && el.checked;
      return prop || ariaIsTrue(el, 'aria-checked') ? 'met' : 'unmet';
    }
    case 'selected':
      return ariaIsTrue(el, 'aria-selected') ? 'met' : 'unmet';
    case 'expanded':
      return ariaIsTrue(el, 'aria-expanded') ? 'met' : 'unmet';
    case 'pressed':
      return ariaIsTrue(el, 'aria-pressed') ? 'met' : 'unmet';
  }
}

function fromLocate(done: PageDone, result: LocateResult): DoneState {
  if (!result.found || result.target === null) return 'unmet';
  return judge(done, result.target);
}

/**
 * 完了の目安を今の状態で判定する。目安の対象（`done.target`）は、ハイライトする要素とは別に探す。
 * 注入された `locate` が Promise を返すときだけ、結果も Promise になる。
 */
export function evaluateDone(done: PageDone, deps: EvaluateDeps): DoneState | Promise<DoneState> {
  const options: LocateOptions = done.allowHidden === true ? { allowHidden: true } : {};
  let result: LocateResult | Promise<LocateResult>;
  try {
    result = deps.locate(done.target, deps.doc, deps.env, options);
  } catch {
    return 'unmet';
  }
  if (result instanceof Promise) {
    return result.then(
      (r) => fromLocate(done, r),
      () => 'unmet' as const,
    );
  }
  return fromLocate(done, result);
}

export interface WatchTriggersDeps extends Partial<TimerDeps> {
  doc: Document;
  now: () => number;
  /** 判定を1回行う。 */
  run: () => void;
}

export interface WatchTriggers {
  /** 監視を始める。すぐに1回判定する。 */
  start(): void;
  stop(): void;
  /** ページが変化したことを知らせる（最短250ミリ秒の間引きで判定する）。 */
  poke(): void;
}

export function createWatchTriggers(deps: WatchTriggersDeps): WatchTriggers {
  const setTimer = deps.setTimer ?? defaultTimers.setTimer;
  const clearTimer = deps.clearTimer ?? defaultTimers.clearTimer;
  let active = false;
  const isActive = (): boolean => active;
  let lastRunAt = Number.NEGATIVE_INFINITY;
  let pollTimer: TimerHandle | null = null;
  let throttleTimer: TimerHandle | null = null;

  function run(): void {
    if (!isActive()) return;
    lastRunAt = deps.now();
    deps.run();
  }

  function onEvent(): void {
    run();
  }

  function poll(): void {
    pollTimer = null;
    if (!isActive()) return;
    run();
    if (isActive()) pollTimer = setTimer(poll, POLL_MS);
  }

  return {
    start() {
      if (active) return;
      active = true;
      deps.doc.addEventListener('input', onEvent, true);
      deps.doc.addEventListener('change', onEvent, true);
      run();
      if (isActive()) pollTimer = setTimer(poll, POLL_MS);
    },
    stop() {
      active = false;
      deps.doc.removeEventListener('input', onEvent, true);
      deps.doc.removeEventListener('change', onEvent, true);
      if (pollTimer !== null) clearTimer(pollTimer);
      if (throttleTimer !== null) clearTimer(throttleTimer);
      pollTimer = null;
      throttleTimer = null;
    },
    poke() {
      if (!active || throttleTimer !== null) return;
      const wait = Math.max(0, lastRunAt + THROTTLE_MS - deps.now());
      throttleTimer = setTimer(() => {
        throttleTimer = null;
        run();
      }, wait);
    },
  };
}
