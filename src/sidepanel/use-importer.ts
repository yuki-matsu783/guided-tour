/**
 * ツアーの取り込みの進行・結果・上書きの確認の列を、画面の部品ではなくアプリの状態として持つ。
 * 画面が変わっても（ツアーを開始する、設定へ移るなど）取り込みは続き、結果は失われず、一覧に戻ったときに示せる。
 * 別々の取り込みが重なっても、上書きの確認は列にして1つずつ出し、それぞれの取り込みへ答えを返す。
 * 取り込みの結果は、閉じるまで残す。取り込みが続いていないときに新しく始めたら、前の結果は消す。続いている間に重ねて始めたものは、結果を貯める。
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { CatalogEntry, PanelView } from '../shared/messages/index.ts';
import type { PanelDeps } from './deps.ts';
import type { ImportResult, OverwriteRequest } from './import/index.ts';

const UNEXPECTED: ImportResult = {
  status: 'rejected',
  fileName: '',
  errors: [{ file: '', line: null, path: '', message: '取り込み中に予期しないエラーが起きました' }],
};

interface PendingConfirm {
  request: OverwriteRequest;
  resolve: (ok: boolean) => void;
}

export interface Importer {
  /** 取り込みが続いているか。 */
  busy: boolean;
  /** まだ閉じていない結果（古い順）。無ければ null。 */
  results: readonly ImportResult[] | null;
  /** いま答えを待っている上書きの確認（列の先頭）。 */
  pending: OverwriteRequest | null;
  /** 先頭の後ろで待っている確認の数。 */
  waiting: number;
  run: (files: File[]) => void;
  dismissResults: () => void;
  /** 先頭の確認に答える。 */
  answer: (ok: boolean) => void;
}

interface ImporterHost {
  deps: PanelDeps;
  getView: () => PanelView | null;
  /** 取り込みが1つ終わった（一覧を取り直す）。 */
  refresh: () => void;
}

/** ログに残す結果の種類。 */
function summarize(results: readonly ImportResult[]): 'imported' | 'cancelled' | 'rejected' {
  if (results.some((r) => r.status === 'imported')) return 'imported';
  if (results.some((r) => r.status === 'cancelled')) return 'cancelled';
  return 'rejected';
}

function bundledIdsOf(catalog: readonly CatalogEntry[]): string[] {
  return catalog.filter((e) => e.source === 'bundled').map((e) => e.id);
}

export function useImporter(host: ImporterHost): Importer {
  const { deps, getView, refresh } = host;
  const [running, setRunning] = useState(0);
  const [results, setResults] = useState<readonly ImportResult[] | null>(null);
  const [queue, setQueue] = useState<readonly PendingConfirm[]>([]);
  const queueRef = useRef<PendingConfirm[]>([]);
  const runningRef = useRef(0);

  const confirmOverwrite = useCallback((request: OverwriteRequest): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      queueRef.current = [...queueRef.current, { request, resolve }];
      setQueue(queueRef.current);
    });
  }, []);

  const answer = useCallback((ok: boolean): void => {
    const [head, ...rest] = queueRef.current;
    if (head === undefined) return;
    queueRef.current = rest;
    setQueue(rest);
    head.resolve(ok);
  }, []);

  const run = useCallback(
    (files: File[]): void => {
      if (files.length === 0) return;
      if (runningRef.current === 0) setResults(null);
      runningRef.current += 1;
      setRunning((n) => n + 1);
      const bytes = files.reduce((sum, f) => sum + f.size, 0);
      const append = (done: readonly ImportResult[]): void => {
        setResults((previous) => [...(previous ?? []), ...done]);
      };
      void deps
        .importFiles(files, {
          confirmOverwrite,
          getRunningTourId: () => {
            const view = getView();
            return view?.status === 'running' ? (view.tour?.id ?? null) : null;
          },
          getBundledTourIds: async () => [
            ...new Set([...(await deps.bundledTourIds()), ...bundledIdsOf(getView()?.catalog ?? [])]),
          ],
          notifyCatalogChanged: async (change) => {
            await deps.send({ type: 'CATALOG_CHANGED', tourId: change.tourId, hash: change.hash });
          },
        })
        .then(
          (done) => {
            deps.logger.info('import.result', { result: summarize(done), files: files.length, bytes });
            append(done);
          },
          () => {
            deps.logger.info('import.result', { result: 'failed', files: files.length, bytes });
            append([UNEXPECTED]);
          },
        )
        .finally(() => {
          runningRef.current -= 1;
          setRunning((n) => n - 1);
          refresh();
        });
    },
    [deps, confirmOverwrite, getView, refresh],
  );

  const dismissResults = useCallback((): void => {
    setResults(null);
  }, []);

  return useMemo(
    () => ({
      busy: running > 0,
      results,
      pending: queue[0]?.request ?? null,
      waiting: Math.max(0, queue.length - 1),
      run,
      dismissResults,
      answer,
    }),
    [running, results, queue, run, dismissResults, answer],
  );
}
