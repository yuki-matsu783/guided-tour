// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { locate } from '../../core/locator/index.ts';
import type { PageDone } from '../../shared/messages/index.ts';
import { makeEnv } from '../test-support.ts';
import { createWatchTriggers, evaluateDone, type DoneState } from './index.ts';

function stateDone(
  state: 'filled' | 'checked' | 'selected' | 'expanded' | 'pressed',
  extra: Partial<PageDone> = {},
): PageDone {
  return { type: 'state', state, target: { css: ['#t'] }, ...extra };
}

function evalNow(done: PageDone, html: string): DoneState {
  document.body.innerHTML = html;
  const r = evaluateDone(done, { doc: document, env: makeEnv(), locate });
  if (r instanceof Promise) throw new Error('同期で返るはず');
  return r;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('判定', () => {
  it('T-WATCH-01: filled の対象に1文字以上の値があるとき満たしている', () => {
    expect(evalNow(stateDone('filled'), '<input id="t" value="a">')).toBe('met');
  });

  it('T-WATCH-02: filled の対象の値が空のとき満たしていない', () => {
    expect(evalNow(stateDone('filled'), '<input id="t" value="">')).toBe('unmet');
  });

  it('T-WATCH-03・T-WATCH-04: type=password は値が入っていても空でも unsupported', () => {
    expect(evalNow(stateDone('filled'), '<input id="t" type="password" value="x">')).toBe('unsupported');
    expect(evalNow(stateDone('filled'), '<input id="t" type="password" value="">')).toBe('unsupported');
  });

  it('T-WATCH-05: filled の判定結果は状態だけで、値そのものを含まない（文字数だけが使われる）', () => {
    const secret = 'ひみつの値-12345';
    const r = evalNow(stateDone('filled', { minLength: 3 }), `<input id="t" value="${secret}">`);
    expect(r).toBe('met');
    expect(JSON.stringify(r)).not.toContain(secret);
    // minLength を満たさなければ、文字数の比較だけで満たさない
    expect(evalNow(stateDone('filled', { minLength: 100 }), `<input id="t" value="${secret}">`)).toBe('unmet');
  });

  it('T-WATCH-06: checked は checked プロパティが真のとき満たしている', () => {
    expect(evalNow(stateDone('checked'), '<input id="t" type="checkbox" checked>')).toBe('met');
  });

  it('T-WATCH-07: checked は aria-checked="true" のとき満たしている', () => {
    expect(evalNow(stateDone('checked'), '<div id="t" role="checkbox" aria-checked="true"></div>')).toBe('met');
  });

  it('T-WATCH-08: checked はプロパティが偽・aria-checked="false" のとき満たしていない', () => {
    expect(evalNow(stateDone('checked'), '<input id="t" type="checkbox">')).toBe('unmet');
    expect(evalNow(stateDone('checked'), '<div id="t" role="checkbox" aria-checked="false"></div>')).toBe('unmet');
  });

  it.each([
    ['T-WATCH-09', 'selected', 'aria-selected'],
    ['T-WATCH-10', 'expanded', 'aria-expanded'],
    ['T-WATCH-11', 'pressed', 'aria-pressed'],
  ] as const)('%s: %s は %s が "true" のときだけ満たしている', (_id, state, attr) => {
    expect(evalNow(stateDone(state), `<div id="t" ${attr}="true"></div>`)).toBe('met');
    expect(evalNow(stateDone(state), `<div id="t" ${attr}="false"></div>`)).toBe('unmet');
    expect(evalNow(stateDone(state), '<div id="t"></div>')).toBe('unmet');
  });

  it('T-WATCH-12・T-WATCH-13: element は見つかるあいだ満たし、見つからなくなったら戻る', () => {
    const done: PageDone = { type: 'element', target: { css: ['#t'] } };
    expect(evalNow(done, '<div id="t"></div>')).toBe('met');
    expect(evalNow(done, '<div id="other"></div>')).toBe('unmet');
  });

  it('T-WATCH-14: 目安の対象（done.target）で判定する。ハイライトの対象とは別', () => {
    // ハイライトするのはラベル、状態を読むのはチェックボックス
    const done = stateDone('checked');
    expect(
      evalNow(done, '<label id="hl"><input id="t" type="checkbox" checked></label>'),
    ).toBe('met');
    expect(evalNow(done, '<label id="t"><input type="checkbox" checked></label>')).toBe('unmet');
  });

  it('T-WATCH-15・T-WATCH-16: allowHidden があれば非表示の対象も判定し、無ければ対象にしない', () => {
    const html = '<div data-hidden><input id="t" value="a"></div>';
    expect(evalNow(stateDone('filled', { allowHidden: true }), html)).toBe('met');
    expect(evalNow(stateDone('filled'), html)).toBe('unmet');
  });

  it('T-WATCH-22: 満たしていた目安が、入力を消すと満たさない状態に戻る', () => {
    document.body.innerHTML = '<input id="t" value="a">';
    const done = stateDone('filled');
    const ev = () => evaluateDone(done, { doc: document, env: makeEnv(), locate });
    expect(ev()).toBe('met');
    const input = document.getElementById('t');
    if (!(input instanceof HTMLInputElement)) throw new Error('準備に失敗');
    input.value = '';
    expect(ev()).toBe('unmet');
  });

  it('非同期の locate では結果も Promise になる', async () => {
    const done = stateDone('filled');
    const r = evaluateDone(done, {
      doc: document,
      env: makeEnv(),
      locate: () => Promise.reject(new Error('x')),
    });
    expect(r).toBeInstanceOf(Promise);
    await expect(r).resolves.toBe('unmet');
  });
});

describe('判定の契機', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const run = vi.fn();
    const w = createWatchTriggers({ doc: document, now: () => Date.now(), run });
    return { run, w };
  }

  it('T-WATCH-17: input イベントが起きたとき、すぐに判定される', () => {
    const { run, w } = setup();
    w.start();
    run.mockClear();
    document.dispatchEvent(new Event('input', { bubbles: true }));
    expect(run).toHaveBeenCalledTimes(1);
    w.stop();
  });

  it('T-WATCH-18: change イベントが起きたとき、すぐに判定される', () => {
    const { run, w } = setup();
    w.start();
    run.mockClear();
    document.dispatchEvent(new Event('change', { bubbles: true }));
    expect(run).toHaveBeenCalledTimes(1);
    w.stop();
  });

  it('T-WATCH-19: ページが変化したとき、判定が行われる（最短250ミリ秒の間引き）', () => {
    const { run, w } = setup();
    w.start();
    run.mockClear();
    w.poke();
    w.poke();
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(run).toHaveBeenCalledTimes(1);
    w.stop();
  });

  it('T-WATCH-20: イベントを伴わない変化も、1秒ごとの定期確認で判定される', () => {
    const { run, w } = setup();
    w.start();
    run.mockClear();
    vi.advanceTimersByTime(999);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(run).toHaveBeenCalledTimes(2);
    w.stop();
  });

  it('T-WATCH-21: 止めている間は、イベントも定期確認も判定されない', () => {
    const { run, w } = setup();
    w.start();
    w.stop();
    run.mockClear();
    document.dispatchEvent(new Event('input', { bubbles: true }));
    w.poke();
    vi.advanceTimersByTime(5000);
    expect(run).not.toHaveBeenCalled();
  });
});
