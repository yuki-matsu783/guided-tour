/**
 * バックグラウンドの状態の写し（`PanelView`）を持つ。
 * 最初に `GET_STATE` で取得し、応答が無い・形が違う間は1秒ごとに取り直す（それまでは null）。
 * `TOUR_STATE_CHANGED` は検証して、120 ミリ秒に間引いて反映する。`refresh` は取り直し。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { PanelViewSchema, parseBgToPanel } from '../shared/messages/index.ts';
import type { PanelView } from '../shared/messages/index.ts';
import type { PanelDeps } from './deps.ts';
import { createCoalescer } from './throttle.ts';

/** 通知を描き直しに反映する間隔（ミリ秒）。 */
export const RENDER_INTERVAL_MS = 120;
/** 最初の取得が失敗したときの再試行の間隔（ミリ秒）。 */
export const RETRY_INTERVAL_MS = 1000;

export interface PanelViewState {
  view: PanelView | null;
  refresh: () => void;
}

export function usePanelView(deps: Pick<PanelDeps, 'send' | 'subscribe'>): PanelViewState {
  const [view, setView] = useState<PanelView | null>(null);
  const loadRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const coalescer = createCoalescer<PanelView>(RENDER_INTERVAL_MS, (next) => {
      if (!disposed) setView(next);
    });

    const scheduleRetry = (): void => {
      if (disposed || retry !== null) return;
      retry = setTimeout(() => {
        retry = null;
        load();
      }, RETRY_INTERVAL_MS);
    };

    function load(): void {
      deps.send({ type: 'GET_STATE' }).then(
        (raw) => {
          if (disposed) return;
          const parsed = PanelViewSchema.safeParse(raw);
          if (!parsed.success) {
            scheduleRetry();
            return;
          }
          // 取得は、待っている通知より新しい。すぐに反映する
          coalescer.cancel();
          setView(parsed.data);
        },
        () => {
          scheduleRetry();
        },
      );
    }
    loadRef.current = load;

    const unsubscribe = deps.subscribe((raw) => {
      const message = parseBgToPanel(raw);
      if (message !== null) coalescer.push(message.view);
    });
    load();

    return () => {
      disposed = true;
      unsubscribe();
      coalescer.cancel();
      if (retry !== null) clearTimeout(retry);
    };
  }, [deps]);

  const refresh = useCallback(() => {
    loadRef.current();
  }, []);

  return { view, refresh };
}
