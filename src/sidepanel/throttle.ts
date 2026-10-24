/**
 * 値を間引いて渡す。`push` された最新の値だけを、最初の `push` から `intervalMs` 後に1回 `apply` する。
 * 間に来た値は上書きされる（描き直しを減らすため、途中の状態は捨ててよい）。
 */
export interface Coalescer<T> {
  push(value: T): void;
  /** 待っている値を捨てる。 */
  cancel(): void;
}

export function createCoalescer<T>(intervalMs: number, apply: (value: T) => void): Coalescer<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latest: { value: T } | null = null;
  return {
    push(value) {
      latest = { value };
      timer ??= setTimeout(() => {
        timer = null;
        const pending = latest;
        latest = null;
        if (pending !== null) apply(pending.value);
      }, intervalMs);
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      latest = null;
    },
  };
}
