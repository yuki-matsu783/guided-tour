/**
 * ステップ実行器。バックグラウンドの描画指示（RENDER など）を受け、1つのステップの
 * 探索・追従・再検証・目安の監視・表示を、ライフサイクルに沿って管理する。
 *
 * - 描画の版 `rev` が受け取った最大より小さい指示は捨てる
 * - `(sessionId, gen, pageSeq)` が同じ RENDER は、表示の状態だけを更新する。違えば処理をすべて止めて始め直す
 * - `selected` が偽の間は、探索・監視・追従をすべて止める
 * - 非同期に届く結果は、開始時の `(sessionId, gen, pageSeq, rev)` と処理の回が今と同じときだけ採用する
 * - 時刻・タイマー・requestAnimationFrame・観測器・送信・`locate` は注入できる
 */
import type { LocateResult, LocatorEnv } from '../../core/locator/index.ts';
import { locate as defaultLocate } from '../../core/locator/index.ts';
import type { SessionId } from '../../shared/ids/index.ts';
import type { Logger } from '../../shared/logger/index.ts';
import type { BgToPage, Hint, PageToBg, Render } from '../../shared/messages/index.ts';
import { rectKey, rectOf, type Rect, type Size } from '../geometry.ts';
import { hintKind, hintText, TEXT_FALLBACK_DEFAULT } from '../hint-text.ts';
import type { MiniGuide } from '../miniguide/index.ts';
import type { Overlay } from '../overlay/index.ts';
import { defaultTimers, type TimerDeps, type TimerHandle } from '../timers.ts';
import { evaluateDone, createWatchTriggers, type DoneState, type LocateFn, type WatchTriggers } from '../watch/index.ts';
import { hasForeignChange, type CreateObserver, type ObserverLike } from './observer.ts';

/** 初回の探索・喪失後の探し直しの長さ（ミリ秒）。 */
export const SEARCH_WINDOW_MS = 8000;
/** ページの変化に伴う再探索・再検証の最短の間隔。 */
export const THROTTLE_MS = 250;
/** 追従中の定期的な再検証の間隔。 */
export const REVALIDATE_MS = 1000;
/** 8秒以降の低い頻度での探索の間隔。 */
export const LOW_FREQUENCY_MS = 2000;

export interface RuntimeDeps extends Partial<TimerDeps> {
  doc: Document;
  env: LocatorEnv;
  locate?: LocateFn;
  now: () => number;
  requestFrame: (fn: () => void) => number;
  cancelFrame: (id: number) => void;
  createObserver: CreateObserver;
  send: (message: PageToBg) => void;
  overlay: Overlay;
  miniGuide: MiniGuide;
  /** 要素の矩形。既定は getBoundingClientRect。 */
  measure?: (el: Element) => Rect;
  /** 要素を見える位置までスクロールする。 */
  scrollIntoView?: (el: Element) => void;
  logger?: Pick<Logger, 'debug'>;
}

export interface Runtime {
  handle(message: BgToPage): void;
  /** 表示中の実行回の ID。何も表示していなければ null。 */
  getSessionId(): SessionId | null;
  dispose(): void;
}

type Phase = 'idle' | 'searching' | 'lost' | 'low' | 'following';

interface Held {
  target: Element;
  highlightEl: Element;
  /** 採用したときから一意でなかったか。 */
  conflict: boolean;
}

interface Run {
  render: Render;
  /** 処理の回。止めるたびに増え、古い回の結果を捨てるのに使う。 */
  epoch: number;
  phase: Phase;
  enteredAt: number;
  searchStartedAt: number;
  held: Held | null;
  scrollChance: boolean;
  dirty: boolean;
  lastLocateAt: number | null;
  lastKey: string | null;
  lastResult: LocateResult | null;
  hint: { met: boolean; unsupported: boolean };
  locateTimer: TimerHandle | null;
  deadlineTimer: TimerHandle | null;
  frame: number | null;
  frameRectKey: string | null;
  observer: ObserverLike | null;
  watch: WatchTriggers | null;
}

interface Token {
  run: Run;
  epoch: number;
  rev: number;
}

const EMPTY_RESULT: LocateResult = {
  found: false,
  tier: null,
  topTier: null,
  reasons: ['missing'],
  counts: [],
  target: null,
  highlightEl: null,
};

function sameIdentity(a: Render, b: Render): boolean {
  return a.sessionId === b.sessionId && a.gen === b.gen && a.pageSeq === b.pageSeq;
}

function resultKey(r: LocateResult): string {
  return `${String(r.found)}|${String(r.tier)}|${String(r.topTier)}|${r.reasons.join(',')}`;
}

function intersects(rect: Rect, viewport: Size): boolean {
  return rect.bottom > 0 && rect.top < viewport.height && rect.right > 0 && rect.left < viewport.width;
}

export function createRuntime(deps: RuntimeDeps): Runtime {
  const { doc, env } = deps;
  const locate: LocateFn = deps.locate ?? defaultLocate;
  const setTimer = deps.setTimer ?? defaultTimers.setTimer;
  const clearTimer = deps.clearTimer ?? defaultTimers.clearTimer;
  const measure = deps.measure ?? rectOf;
  const scrollIntoView =
    deps.scrollIntoView ??
    ((el: Element): void => {
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
    });

  let maxRev = -1;
  let run: Run | null = null;
  let epochCounter = 0;

  // ---- 表示 ----

  function currentHint(r: Run): Hint {
    const { render } = r;
    if (r.phase === 'idle' && render.donePage) {
      return { met: render.hint.met, unsupported: render.hint.unsupported, stopped: !render.selected };
    }
    return { met: r.hint.met, unsupported: r.hint.unsupported, stopped: !render.selected };
  }

  function present(): void {
    if (run === null) return;
    const r = run;
    const { render } = r;
    const { step } = render;
    const hasGoal = step.done !== undefined || render.donePage;
    const kind = hintKind(hasGoal, currentHint(r));
    const text = hintText(kind, step.done?.hint);
    const searchesTarget = step.target !== undefined && render.selected && !render.donePage;
    const missing = searchesTarget && r.held === null && r.phase === 'low';

    deps.miniGuide.renderMiniGuide(
      {
        sessionId: render.sessionId,
        gen: render.gen,
        index: render.index,
        total: render.total,
        title: step.title,
        tip: step.tip,
        hintKind: kind,
        hintText: text,
        fallbackText: missing ? (render.fallbackText ?? TEXT_FALLBACK_DEFAULT) : null,
        isLast: render.isLast,
        overlayHidden: render.overlay.hidden,
        hasTarget: !render.donePage && step.target !== undefined,
        shortcut: render.shortcut,
      },
      render.ui,
    );

    if (r.held !== null && render.selected && !render.donePage) {
      deps.overlay.paint(
        r.held.highlightEl,
        { title: step.title, tip: step.tip },
        { hidden: render.overlay.hidden, miniGuideEnabled: render.ui.enabled },
        text,
        render.ui.enabled ? deps.miniGuide.getRect() : null,
      );
    } else {
      deps.overlay.clear();
    }
  }

  // ---- 後始末 ----

  function stopWork(r: Run): void {
    r.epoch = ++epochCounter;
    if (r.locateTimer !== null) clearTimer(r.locateTimer);
    if (r.deadlineTimer !== null) clearTimer(r.deadlineTimer);
    if (r.frame !== null) deps.cancelFrame(r.frame);
    r.observer?.disconnect();
    r.watch?.stop();
    r.locateTimer = null;
    r.deadlineTimer = null;
    r.frame = null;
    r.frameRectKey = null;
    r.observer = null;
    r.watch = null;
  }

  function clearAll(): void {
    if (run !== null) stopWork(run);
    run = null;
    deps.overlay.clear();
    deps.miniGuide.remove();
  }

  // ---- トークン ----

  function tokenOf(r: Run): Token {
    return { run: r, epoch: r.epoch, rev: r.render.rev };
  }

  /** 結果を採用してよいか。回が違えば捨てる。同じ回で版だけ違うときは、捨てて探し直しを予約する。 */
  function accept(token: Token): boolean {
    const r = token.run;
    if (run !== r || r.epoch !== token.epoch) return false;
    if (r.render.rev !== token.rev) {
      r.dirty = true;
      scheduleLocate(r);
      return false;
    }
    return true;
  }

  // ---- 探索 ----

  function active(r: Run): boolean {
    return r.phase !== 'idle';
  }

  function scheduleLocate(r: Run): void {
    if (r.locateTimer !== null) {
      clearTimer(r.locateTimer);
      r.locateTimer = null;
    }
    if (run !== r || !active(r)) return;
    const last = r.lastLocateAt ?? Number.NEGATIVE_INFINITY;
    let due: number | null = null;
    if (r.phase === 'searching' || r.phase === 'lost') {
      if (r.dirty) due = last + THROTTLE_MS;
    } else if (r.phase === 'low') {
      if (r.dirty) due = last + LOW_FREQUENCY_MS;
    } else {
      due = last + REVALIDATE_MS;
      if (r.dirty) due = Math.min(due, last + THROTTLE_MS);
    }
    if (due === null) return;
    r.locateTimer = setTimer(() => {
      r.locateTimer = null;
      locateNow(r);
    }, Math.max(0, due - deps.now()));
  }

  function locateNow(r: Run): void {
    const target = r.render.step.target;
    if (run !== r || target === undefined || !active(r)) return;
    if (r.locateTimer !== null) {
      clearTimer(r.locateTimer);
      r.locateTimer = null;
    }
    r.lastLocateAt = deps.now();
    r.dirty = false;
    const token = tokenOf(r);
    let result: LocateResult | Promise<LocateResult>;
    try {
      result = locate(target, doc, env);
    } catch {
      result = EMPTY_RESULT;
    }
    if (result instanceof Promise) {
      void result.then(
        (v) => {
          applyLocate(token, v);
        },
        () => {
          applyLocate(token, EMPTY_RESULT);
        },
      );
    } else {
      applyLocate(token, result);
    }
  }

  function report(r: Run, result: LocateResult): void {
    const key = resultKey(result);
    if (key === r.lastKey) return;
    r.lastKey = key;
    const summary = {
      found: result.found,
      tier: result.tier,
      topTier: result.topTier,
      reasons: result.reasons,
      counts: result.counts,
    };
    deps.send({
      type: 'LOCATE_RESULT',
      sessionId: r.render.sessionId,
      gen: r.render.gen,
      pageSeq: r.render.pageSeq,
      result: summary,
    });
    try {
      deps.logger?.debug('locator.result', {
        tier: result.tier,
        topTier: result.topTier,
        reasons: result.reasons,
        counts: result.counts,
      });
    } catch {
      // ログの失敗で探索を止めない
    }
  }

  function adopt(r: Run, result: LocateResult, target: Element, highlightEl: Element): void {
    const first = r.phase !== 'following';
    r.held = { target, highlightEl, conflict: result.reasons.includes('conflict') };
    r.phase = 'following';
    if (r.deadlineTimer !== null) {
      clearTimer(r.deadlineTimer);
      r.deadlineTimer = null;
    }
    if (first && r.scrollChance) {
      r.scrollChance = false;
      const withinWindow = deps.now() - r.enteredAt <= SEARCH_WINDOW_MS;
      if (r.render.attended && withinWindow && !intersects(measure(highlightEl), env.viewport())) {
        scrollIntoView(highlightEl);
      }
    }
    report(r, result);
    r.frameRectKey = rectKey(measure(highlightEl));
    startFollow(r);
    present();
  }

  function startDeadline(r: Run): void {
    if (r.deadlineTimer !== null) clearTimer(r.deadlineTimer);
    r.deadlineTimer = setTimer(() => {
      r.deadlineTimer = null;
      if (run !== r || (r.phase !== 'searching' && r.phase !== 'lost')) return;
      r.phase = 'low';
      report(r, r.lastResult ?? EMPTY_RESULT);
      present();
      scheduleLocate(r);
    }, Math.max(0, r.searchStartedAt + SEARCH_WINDOW_MS - deps.now()));
  }

  /** ハイライトを消して、喪失後の探し直し（8秒）に移る。 */
  function lose(r: Run, result: LocateResult): void {
    r.held = null;
    r.phase = 'lost';
    r.searchStartedAt = deps.now();
    if (r.frame !== null) deps.cancelFrame(r.frame);
    r.frame = null;
    r.frameRectKey = null;
    deps.overlay.clear();
    report(r, result);
    startDeadline(r);
    present();
  }

  function applyLocate(token: Token, result: LocateResult): void {
    if (!accept(token)) return;
    const r = token.run;
    r.lastResult = result;
    const { target, highlightEl } = result;
    const found = result.found && target !== null && highlightEl !== null;

    if (r.phase === 'following' && r.held !== null) {
      const held = r.held;
      if (!found) {
        lose(r, result);
      } else if (result.reasons.includes('conflict') && !held.conflict) {
        lose(r, result);
      } else if (target !== held.target || highlightEl !== held.highlightEl) {
        // 要素が入れ替わった。古い枠をすぐ消してから、新しい要素に移る
        deps.overlay.clear();
        adopt(r, result, target, highlightEl);
      } else {
        // 補助の照合（名前）だけの変化は、枠を残して報告する
        report(r, result);
      }
    } else if (found) {
      adopt(r, result, target, highlightEl);
    }
    scheduleLocate(r);
  }

  // ---- 追従 ----

  function startFollow(r: Run): void {
    if (r.frame !== null) return;
    const tick = (): void => {
      if (run !== r || r.held === null) return;
      const key = rectKey(measure(r.held.highlightEl));
      if (key !== r.frameRectKey) {
        r.frameRectKey = key;
        present();
      }
      r.frame = deps.requestFrame(tick);
    };
    r.frame = deps.requestFrame(tick);
  }

  // ---- 目安の監視 ----

  function applyHint(token: Token, state: DoneState): void {
    if (!accept(token)) return;
    const r = token.run;
    const next = { met: state === 'met', unsupported: state === 'unsupported' };
    if (next.met === r.hint.met && next.unsupported === r.hint.unsupported) return;
    r.hint = next;
    deps.send({
      type: 'HINT_STATE',
      sessionId: r.render.sessionId,
      gen: r.render.gen,
      pageSeq: r.render.pageSeq,
      met: next.met,
      unsupported: next.unsupported,
    });
    present();
  }

  function watchOnce(r: Run): void {
    const { done } = r.render.step;
    if (run !== r || done === undefined) return;
    const token = tokenOf(r);
    const state = evaluateDone(done, { doc, env, locate });
    if (state instanceof Promise) {
      void state.then((s) => {
        applyHint(token, s);
      });
    } else {
      applyHint(token, state);
    }
  }

  // ---- 開始・停止 ----

  /** 探索・監視・観測を始める（selected が真で、完了ページでないとき）。 */
  function startActivity(r: Run): void {
    r.phase = r.render.step.target === undefined ? 'idle' : 'searching';
    r.searchStartedAt = deps.now();
    r.dirty = false;
    r.lastLocateAt = null;

    const observer = deps.createObserver((records) => {
      if (run !== r || !hasForeignChange(records, env)) return;
      r.dirty = true;
      scheduleLocate(r);
      r.watch?.poke();
    });
    r.observer = observer;
    observer.observe(doc);

    if (r.render.step.done !== undefined) {
      r.watch = createWatchTriggers({
        doc,
        now: deps.now,
        setTimer,
        clearTimer,
        run: () => {
          watchOnce(r);
        },
      });
      r.watch.start();
    }
    if (r.phase === 'searching') {
      startDeadline(r);
      locateNow(r);
    }
  }

  /** 探索・監視・追従を止め、ハイライトを消す。ミニガイドは残す。 */
  function stopActivity(r: Run): void {
    stopWork(r);
    r.phase = 'idle';
    r.held = null;
    r.dirty = false;
    deps.overlay.clear();
  }

  function shouldWork(render: Render): boolean {
    return render.selected && !render.donePage;
  }

  function onRender(m: Render): void {
    if (run === null || !sameIdentity(run.render, m)) {
      if (run !== null) stopWork(run);
      deps.overlay.clear();
      const r: Run = {
        render: m,
        epoch: ++epochCounter,
        phase: 'idle',
        enteredAt: deps.now(),
        searchStartedAt: deps.now(),
        held: null,
        scrollChance: true,
        dirty: false,
        lastLocateAt: null,
        lastKey: null,
        lastResult: null,
        hint: { met: m.hint.met, unsupported: m.hint.unsupported },
        locateTimer: null,
        deadlineTimer: null,
        frame: null,
        frameRectKey: null,
        observer: null,
        watch: null,
      };
      run = r;
      if (shouldWork(m)) startActivity(r);
      present();
      return;
    }

    const r = run;
    const before = shouldWork(r.render);
    r.render = m;
    const after = shouldWork(m);
    if (before && !after) stopActivity(r);
    else if (!before && after) startActivity(r);
    present();
  }

  function onRecheck(): void {
    if (run === null || !shouldWork(run.render)) return;
    const r = run;
    stopActivity(r);
    startActivity(r);
    present();
  }

  function onScrollToTarget(): void {
    if (run?.held == null) return;
    scrollIntoView(run.held.highlightEl);
  }

  /** 受け取った最大の `rev` より小さければ false。 */
  function takeRev(rev: number): boolean {
    if (rev < maxRev) return false;
    maxRev = rev;
    return true;
  }

  return {
    handle(message) {
      switch (message.type) {
        case 'PING':
          return;
        case 'SYNC':
          if (!takeRev(message.rev)) return;
          if (run !== null && (run.render.sessionId !== message.sessionId || run.render.gen !== message.gen)) {
            clearAll();
          }
          return;
        case 'RENDER':
          if (takeRev(message.rev)) onRender(message);
          return;
        case 'RECHECK':
          if (takeRev(message.rev)) onRecheck();
          return;
        case 'SCROLL_TO_TARGET':
          if (takeRev(message.rev)) onScrollToTarget();
          return;
        case 'CLEAR':
          if (takeRev(message.rev)) clearAll();
          return;
      }
    },
    getSessionId: () => run?.render.sessionId ?? null,
    dispose: clearAll,
  };
}
