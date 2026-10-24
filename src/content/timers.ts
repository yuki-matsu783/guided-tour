/**
 * 時刻・タイマーの注入口。本番は window の関数、試験は偽のタイマーを渡す。
 */

export type TimerHandle = ReturnType<typeof setTimeout>;

export interface TimerDeps {
  setTimer: (fn: () => void, ms: number) => TimerHandle;
  clearTimer: (id: TimerHandle) => void;
}

export const defaultTimers: TimerDeps = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (id) => {
    clearTimeout(id);
  },
};
