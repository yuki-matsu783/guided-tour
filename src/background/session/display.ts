/**
 * 描画指示の計画（純粋関数）。状態とタブの評価から、どのタブへ何を送るかと、`rev` を決める。
 * - 現在のステップが page で、評価が `ok` か `donePage` のときだけ `RENDER` を役割のタブへ送る。
 *   それ以外（guide・mismatch・missing・unsupported・一時中断・終了）は全タブへ `CLEAR` を送る
 * - 役割のタブに `documentId` が無い（ページ側がまだ `HELLO` を送っていない）ときは、描画を送らず組み込みだけを依頼する
 *   （`HELLO` を受けたときに描画する）
 * - 同じ指示の中の `rev` は1つ。復帰の `SYNC` だけは、描画より小さい `rev` を使う
 * 外への作用は行わない。送る順序と確定の順序は呼び出し側（session.ts）が守る。
 */
import type { Step, Tour } from '../../core/tour/index.ts';
import { nextRev, type Rev } from '../../shared/ids/index.ts';
import {
  toPageStep,
  type BgToPage,
  type Render,
  type UiSettings,
} from '../../shared/messages/index.ts';
import type { TabEvaluation } from '../ports.ts';
import { ownValue } from './own.ts';
import type { TabStatusSnapshot, TourState } from './state.ts';

/** 描画の指示の種類。`recheck`・`scroll` は、直前も描画していたときだけ専用の指示にする。 */
export type DisplayMode = 'render' | 'recheck' | 'scroll';

export type Send =
  | { readonly to: 'all'; readonly message: BgToPage }
  | { readonly to: 'tab'; readonly tabId: number; readonly message: BgToPage };

export interface Plan {
  /** 指示を送った後の `rev`。何も送らなければ元のまま。 */
  readonly rev: Rev;
  readonly sends: readonly Send[];
  /** ページ側の組み込みを依頼するタブ。 */
  readonly inject: number | null;
}

export interface PlanInput {
  readonly prev: TourState | null;
  readonly next: TourState;
  readonly tour: Tour | null;
  readonly evaluation: TabEvaluation | null;
  readonly ui: UiSettings;
  readonly shortcut: string | null;
  readonly mode: DisplayMode;
  /** 復帰のとき真。組み込み済みの役割のタブに `SYNC` を先に送る。 */
  readonly sync: boolean;
}

/** その評価でページ上に表示を出すか。 */
export function isShown(status: TabEvaluation['status']): boolean {
  return status === 'ok' || status === 'donePage';
}

export function snapshotOf(evaluation: TabEvaluation | null): TabStatusSnapshot | null {
  if (evaluation === null) return null;
  return {
    role: evaluation.role,
    status: evaluation.status,
    selected: evaluation.selected,
    attended: evaluation.attended,
  };
}

export function sameSnapshot(a: TabStatusSnapshot | null, b: TabStatusSnapshot | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.role === b.role &&
    a.status === b.status &&
    a.selected === b.selected &&
    a.attended === b.attended
  );
}

/** 現在のステップ（page のときだけ）。 */
export function pageStepOf(tour: Tour | null, state: TourState): Step | undefined {
  const step = tour?.steps[state.stepIndex];
  return step?.kind === 'page' ? step : undefined;
}

function renderMessage(
  input: PlanInput,
  step: Step,
  evaluation: TabEvaluation,
  tour: Tour,
  rev: Rev,
): Render {
  const { next } = input;
  const hintFresh = next.hint.gen === next.gen;
  const donePage = evaluation.status === 'donePage';
  return {
    type: 'RENDER',
    sessionId: next.sessionId,
    gen: next.gen,
    pageSeq: next.pageSeq,
    rev,
    step: toPageStep(step),
    index: next.stepIndex,
    total: tour.steps.length,
    overlay: { hidden: next.overlayHidden },
    ui: input.ui,
    selected: evaluation.selected,
    attended: evaluation.attended,
    donePage,
    hint: {
      met: donePage || (hintFresh && next.hint.met),
      unsupported: hintFresh && next.hint.unsupported,
      stopped: !evaluation.selected,
    },
    shortcut: input.shortcut,
    fallbackText: step.target?.fallbackText ?? null,
    isLast: next.stepIndex === tour.steps.length - 1,
  };
}

export function planDisplay(input: PlanInput): Plan {
  const { prev, next, tour, evaluation } = input;
  const step = next.status === 'running' ? pageStepOf(tour, next) : undefined;
  const shown = step !== undefined && evaluation !== null && isShown(evaluation.status);
  const binding = step === undefined ? undefined : ownValue(next.tabs, step.tab);

  // 直前の描画先（役割が変わったとき、前のタブの表示を消すために使う）
  let prevTabId: number | undefined;
  if (prev?.status === 'running' && prev.tabStatus !== null && isShown(prev.tabStatus.status)) {
    prevTabId = ownValue(prev.tabs, prev.tabStatus.role)?.tabId;
  }

  let rev = next.rev;
  const take = (): Rev => {
    rev = nextRev(rev);
    return rev;
  };
  const sends: Send[] = [];
  let inject: number | null = null;

  if (input.sync) {
    const bound = new Set<number>();
    for (const b of Object.values(next.tabs)) {
      if (b.documentId !== null) bound.add(b.tabId);
    }
    if (bound.size > 0) {
      const syncRev = take();
      for (const tabId of bound) {
        sends.push({
          to: 'tab',
          tabId,
          message: { type: 'SYNC', sessionId: next.sessionId, gen: next.gen, rev: syncRev },
        });
      }
    }
  }

  if (step === undefined || evaluation === null || !shown || binding === undefined || tour === null) {
    sends.push({ to: 'all', message: { type: 'CLEAR', rev: take() } });
    // 再確認では、ページ側が未組み込みの `unsupported` のタブに組み込みをやり直す
    if (
      input.mode === 'recheck' &&
      evaluation?.status === 'unsupported' &&
      binding?.documentId === null
    ) {
      inject = binding.tabId;
    }
  } else if (binding.documentId === null) {
    inject = binding.tabId;
    if (prevTabId !== undefined && prevTabId !== binding.tabId) {
      sends.push({ to: 'tab', tabId: prevTabId, message: { type: 'CLEAR', rev: take() } });
    }
  } else {
    const r = take();
    const sameTab = prevTabId === binding.tabId;
    let message: BgToPage;
    if (input.mode === 'recheck' && sameTab) message = { type: 'RECHECK', rev: r };
    else if (input.mode === 'scroll' && sameTab) message = { type: 'SCROLL_TO_TARGET', rev: r };
    else message = renderMessage(input, step, evaluation, tour, r);
    sends.push({ to: 'tab', tabId: binding.tabId, message });
    if (prevTabId !== undefined && !sameTab) {
      sends.push({ to: 'tab', tabId: prevTabId, message: { type: 'CLEAR', rev: r } });
    }
  }
  return { rev, sends, inject };
}
