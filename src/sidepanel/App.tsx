/**
 * サイドパネルの最上位。状態の写し（`PanelView`）の状態に応じて、一覧・実行中・一時中断中・設定のどれかを出す。
 * 実行中・一時中断中の画面からは、一覧（取り込み・削除。開始は出さない）と設定へ移れる。
 * 確認の画面（上書き・付け替え・削除・消去）はここで持ち、出している間は背後を操作できなくする（inert）。
 * 上書きの確認は取り込みごとに列になり、1つずつ出す。取り込みの進行と結果もここ（`useImporter`）で持つ。
 * 写しがまだ無い間は、応答待ちの表示だけを出す。
 */
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { CatalogEntry, PanelView } from '../shared/messages/index.ts';
import { createAssets } from './assets/index.ts';
import { BACK_LABEL, ListScreen } from './components/ListScreen.tsx';
import type { Flash } from './components/ListScreen.tsx';
import { PausedScreen } from './components/PausedScreen.tsx';
import { RunningScreen } from './components/RunningScreen.tsx';
import { SettingsScreen } from './components/SettingsScreen.tsx';
import { PanelContext } from './context.ts';
import type { PanelContextValue } from './context.ts';
import type { PanelDeps } from './deps.ts';
import { ConfirmDialog, useFocusRestore } from './focus.tsx';
import type { OverwriteRequest } from './import/index.ts';
import { createOps } from './ops.ts';
import { roleLabelOf } from './role-label.ts';
import { useImporter } from './use-importer.ts';
import { usePanelView } from './use-panel-view.ts';

type DialogState =
  | { kind: 'bind'; tabId: number; boundRole: string }
  | { kind: 'remove'; entry: CatalogEntry }
  | { kind: 'clear'; proceed: () => void };

/** 表示する画面。`list` は、実行中・一時中断中の画面から開いた一覧。設定は開いた元（`from`）へ戻る。 */
type Screen = { kind: 'main' } | { kind: 'list' } | { kind: 'settings'; from: 'main' | 'list' };

function OverwriteDialogBody({
  request,
  running,
  waiting,
}: {
  request: OverwriteRequest;
  /** 確認を出している間に実行が始まったときも示すため、確認の要求の時点の値とは別に受け取る。 */
  running: boolean;
  waiting: number;
}): ReactNode {
  return (
    <>
      <p>{`ファイル「${request.fileName}」のツアー「${request.tourName}」（ID「${request.tourId}」）は、同じ ID のツアーがすでにあります。取り込んだもので上書きしますか。`}</p>
      {request.existingSource === 'bundled' && (
        <p>同梱されたツアーを、取り込んだもので置き換えます。取り込んだものを削除すると、同梱版が再び使われます。</p>
      )}
      {running && <p>このツアーは実行中です。上書きすると、一時中断になります。</p>}
      {waiting > 0 && <p className="meta">{`このあと、${String(waiting)} 件の上書きの確認があります。`}</p>}
    </>
  );
}

interface ViewHolder {
  get: () => PanelView | null;
  set: (view: PanelView | null) => void;
}

function createViewHolder(): ViewHolder {
  let current: PanelView | null = null;
  return {
    get: () => current,
    set: (view) => {
      current = view;
    },
  };
}

export function App({ deps }: { deps: PanelDeps }): ReactNode {
  const { view, refresh } = usePanelView(deps);
  const [notice, setNotice] = useState<string | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [screen, setScreen] = useState<Screen>({ kind: 'main' });
  const { onClickCapture, rootRef } = useFocusRestore();

  // 非同期の処理から最新の写しを読むための入れ物。子の effect より先に更新する
  const [holder] = useState(createViewHolder);
  useLayoutEffect(() => {
    holder.set(view);
  }, [holder, view]);

  const assets = useMemo(
    () =>
      createAssets({
        getUrl: (path) => deps.getUrl(path),
        readStoredFile: (tourId, hash, path) => deps.readStoredFile(tourId, hash, path),
        createObjectUrl: (blob) => deps.createObjectUrl(blob),
        revokeObjectUrl: (url) => {
          deps.revokeObjectUrl(url);
        },
        sourceOf: (tourId) => {
          const tour = holder.get()?.tour;
          return tour?.id === tourId ? tour.source : null;
        },
      }),
    [deps, holder],
  );

  // 表示するツアーや hash が変わったら、前のものの blob URL を解放する。閉じるときも解放する
  const tourId = view?.tour?.id ?? null;
  const tourHash = view?.tour?.hash ?? null;
  useEffect(() => {
    assets.keep(tourId !== null && tourHash !== null ? { tourId, hash: tourHash } : null);
  }, [assets, tourId, tourHash]);
  useEffect(() => {
    const onPageHide = (): void => {
      assets.revokeAll();
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      assets.revokeAll();
    };
  }, [assets]);

  const ops = useMemo(
    () =>
      createOps({
        deps,
        getView: holder.get,
        notify: setNotice,
        refresh,
        askBind: (request) => {
          setDialog({ kind: 'bind', ...request });
        },
        finished: (kind, tourName) => {
          setFlash(kind === 'complete' ? { kind: 'completed', tourName } : { kind: 'stopped' });
        },
      }),
    [deps, holder, refresh],
  );

  // 新しい表示（gen の変化）が届いたことを、移動の操作の受け付けに伝える
  const viewGen = view?.gen ?? null;
  useLayoutEffect(() => {
    ops.shown(viewGen);
  }, [ops, viewGen]);

  const importer = useImporter({ deps, getView: holder.get, refresh });

  // 実行の状態が変わったら（一時中断になった、終了したなど）、開いていた一覧を閉じて、その状態の画面を出す
  const status = view?.status ?? null;
  const [seenStatus, setSeenStatus] = useState(status);
  if (seenStatus !== status) {
    setSeenStatus(status);
    setScreen((current) => (current.kind === 'list' ? { kind: 'main' } : current));
  }

  const value = useMemo<PanelContextValue | null>(
    () => (view === null ? null : { deps, view, ops, assets, refresh }),
    [deps, view, ops, assets, refresh],
  );

  const tourOngoing = view?.status === 'running' || view?.status === 'paused';

  const closeDialog = (): void => {
    setDialog(null);
  };

  const renderScreen = (current: PanelView): ReactNode => {
    const active = current.status === 'running' || current.status === 'paused';
    const mainLabel = current.status === 'running' ? BACK_LABEL.running : current.status === 'paused' ? BACK_LABEL.paused : '一覧へ戻る';
    const openSettings = (): void => {
      setFlash(null);
      setScreen({ kind: 'settings', from: screen.kind === 'list' ? 'list' : 'main' });
    };
    if (screen.kind === 'settings') {
      const from = screen.from;
      return (
        <SettingsScreen
          backLabel={from === 'list' ? '一覧へ戻る' : mainLabel}
          onBack={() => {
            setScreen({ kind: from });
          }}
          confirmClear={(proceed) => {
            setDialog({ kind: 'clear', proceed });
          }}
        />
      );
    }
    const nav = {
      onOpenList: () => {
        setScreen({ kind: 'list' });
      },
      onOpenSettings: openSettings,
    };
    if (active && screen.kind !== 'list') {
      return current.status === 'running' ? <RunningScreen {...nav} /> : <PausedScreen {...nav} />;
    }
    return (
      <ListScreen
        flash={flash}
        importer={importer}
        onOpenSettings={openSettings}
        onRemove={(entry) => {
          setDialog({ kind: 'remove', entry });
        }}
        onBack={
          active
            ? () => {
                setScreen({ kind: 'main' });
              }
            : null
        }
      />
    );
  };

  return (
    <div className="app" ref={rootRef} onClickCapture={onClickCapture}>
      <div className="app-main" inert={dialog !== null || importer.pending !== null}>
        {notice !== null && (
          <div className="notice notice-error banner" role="alert">
            <span>{notice}</span>
            <button
              type="button"
              onClick={() => {
                setNotice(null);
              }}
            >
              閉じる
            </button>
          </div>
        )}
        {view === null || value === null ? (
          <p className="waiting" role="status">
            バックグラウンドの応答を待っています…
          </p>
        ) : (
          <PanelContext.Provider value={value}>{renderScreen(view)}</PanelContext.Provider>
        )}
      </div>
      {dialog === null && importer.pending !== null && (
        <ConfirmDialog
          key={`${importer.pending.fileName}\n${importer.pending.tourId}`}
          title="上書きの確認"
          confirmLabel="上書きする"
          cancelLabel="上書きしない"
          onConfirm={() => {
            importer.answer(true);
          }}
          onCancel={() => {
            importer.answer(false);
          }}
        >
          <OverwriteDialogBody
            request={importer.pending}
            running={importer.pending.running || (view?.status === 'running' && view.tour?.id === importer.pending.tourId)}
            waiting={importer.waiting}
          />
        </ConfirmDialog>
      )}
      {dialog?.kind === 'bind' && (
        <ConfirmDialog
          title="タブの付け替えの確認"
          confirmLabel="付け替える"
          cancelLabel="やめる"
          onConfirm={() => {
            closeDialog();
            ops.bindTab(dialog.tabId, true);
          }}
          onCancel={closeDialog}
        >
          <p>{`このタブは、すでに「${roleLabelOf(view?.roles ?? [], dialog.boundRole)}」に対応付けられています。付け替えますか。`}</p>
        </ConfirmDialog>
      )}
      {dialog?.kind === 'remove' && (
        <ConfirmDialog
          title="ツアーの削除の確認"
          confirmLabel="削除する"
          cancelLabel="やめる"
          onConfirm={() => {
            closeDialog();
            ops.remove(dialog.entry.id);
          }}
          onCancel={closeDialog}
        >
          <p>{`「${dialog.entry.name}」を削除します。同じ ID の同梱版があれば、再びそちらが使われます。`}</p>
          {tourOngoing && view.tour?.id === dialog.entry.id && (
            <p>
              {view.status === 'running'
                ? 'このツアーは実行中です。削除すると、ツアーは終了し、進捗も消えます。'
                : 'このツアーは一時中断中です。削除すると、ツアーは終了し、進捗も消えます。'}
            </p>
          )}
        </ConfirmDialog>
      )}
      {dialog?.kind === 'clear' && (
        <ConfirmDialog
          title="消去の確認"
          confirmLabel="消去する"
          cancelLabel="やめる"
          onConfirm={() => {
            closeDialog();
            dialog.proceed();
          }}
          onCancel={closeDialog}
        >
          <p>ログと保守記録をすべて消去します。元に戻せません。</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
