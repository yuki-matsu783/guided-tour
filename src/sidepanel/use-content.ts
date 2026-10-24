/**
 * 実行中のツアーの内容（ステップの全項目・説明文・補足画像の URL）を、画面が非同期に読むための hook。
 * 読み終えるまでは `undefined`、読めなかったときは `null`。ツアーやステップが変わったら読み直す。
 * 引数の識別（出所・ID・`hash`）は文字列で比べるので、写しが描き直されても読み直さない。
 */
import { useCallback, useEffect, useState } from 'react';
import type { Step } from '../core/tour/index.ts';
import type { PanelView } from '../shared/messages/index.ts';
import type { Assets } from './assets/index.ts';
import type { PanelDeps } from './deps.ts';
import { loadStepBody, loadTourContent } from './tour-content.ts';
import type { StepBody, TourContent } from './tour-content.ts';

type RunningTour = NonNullable<PanelView['tour']>;

interface Loaded<T> {
  key: string;
  value: T;
}

/** `key` が変わる（または `load` が変わる）たびに読み、`key` が今のものと一致する結果だけを返す。 */
function useLoaded<T>(key: string | null, load: () => Promise<T>): T | undefined {
  const [loaded, setLoaded] = useState<Loaded<T> | null>(null);
  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    void load().then((value) => {
      if (!cancelled) setLoaded({ key, value });
    });
    return () => {
      cancelled = true;
    };
  }, [key, load]);
  return key !== null && loaded?.key === key ? loaded.value : undefined;
}

const SEP = '\u0000';

export function useTourContent(
  deps: PanelDeps,
  tour: RunningTour | null,
): TourContent | null | undefined {
  const source = tour?.source ?? null;
  const id = tour?.id ?? null;
  const hash = tour?.hash ?? null;
  const load = useCallback(
    () =>
      source === null || id === null || hash === null
        ? Promise.resolve(null)
        : loadTourContent(deps, source, id, hash),
    [deps, source, id, hash],
  );
  const key = source === null ? null : [source, id, hash].join(SEP);
  return useLoaded(key, load);
}

export function useStepBody(
  deps: PanelDeps,
  tour: RunningTour | null,
  step: Pick<Step, 'id' | 'body' | 'bodyFile'> | null,
): StepBody | null | undefined {
  const source = tour?.source ?? null;
  const id = tour?.id ?? null;
  const hash = tour?.hash ?? null;
  const stepId = step?.id ?? null;
  const body = step?.body;
  const bodyFile = step?.bodyFile;
  const load = useCallback(
    () =>
      source === null || id === null || hash === null || stepId === null
        ? Promise.resolve(null)
        : loadStepBody(deps, source, id, hash, { body, bodyFile }),
    [deps, source, id, hash, stepId, body, bodyFile],
  );
  const key = source === null || stepId === null ? null : [source, id, hash, stepId].join(SEP);
  return useLoaded(key, load);
}

/** 補足画像の表示用 URL。読むまでは `undefined`、解決できなければ `null`。 */
export function useAssetUrl(
  assets: Assets,
  tour: Pick<RunningTour, 'id' | 'hash'> | null,
  path: string | null,
): string | null | undefined {
  const id = tour?.id ?? null;
  const hash = tour?.hash ?? null;
  const load = useCallback(
    () =>
      id === null || hash === null || path === null
        ? Promise.resolve(null)
        : assets.resolve(id, hash, path),
    [assets, id, hash, path],
  );
  const key = id === null || path === null ? null : [id, hash, path].join(SEP);
  return useLoaded(key, load);
}
