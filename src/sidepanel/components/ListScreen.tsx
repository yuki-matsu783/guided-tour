/**
 * 一覧の画面。ツアーごとに、出所・許可・要確認・ステップ数・対象サイトを示し、
 * 開始（進捗があれば「続きから」と「最初から」）と削除（取り込みのみ）を置く。取り込みエリア・再読み込み・設定への入口もここにある。
 * 実行中・一時中断中に開いたときは、開始のボタンを出さず、元の画面へ戻る入口を出す（取り込み・削除・再読み込み・設定は使える）。
 */
import type { ReactNode } from 'react';
import type { CatalogEntry } from '../../shared/messages/index.ts';
import { usePanel } from '../context.ts';
import { SOURCE_LABEL, formatDateTime } from '../format.ts';
import type { Importer } from '../use-importer.ts';
import { ImportArea } from './ImportArea.tsx';

/** 完了・終了のあとに一覧の先頭へ出す知らせ。 */
export type Flash = { kind: 'completed'; tourName: string | null } | { kind: 'stopped' };

/** 実行中・一時中断中の画面から開いたときの戻り先の表示名。 */
export const BACK_LABEL = {
  running: '実行中の画面へ戻る',
  paused: '一時中断中の画面へ戻る',
} as const;

interface ListScreenProps {
  flash: Flash | null;
  importer: Importer;
  onOpenSettings: () => void;
  onRemove: (entry: CatalogEntry) => void;
  /** 実行中・一時中断中の画面から開いたとき、元の画面へ戻る。それ以外は null。 */
  onBack: (() => void) | null;
}

function progressText(entry: CatalogEntry): string | null {
  const p = entry.progress;
  if (p === null) return null;
  return `${String(p.stepIndex + 1)}/${String(entry.stepCount)} ステップまで進みました（保存: ${formatDateTime(p.savedAt)}）`;
}

function TourCard({
  entry,
  canStart,
  onRemove,
}: {
  entry: CatalogEntry;
  canStart: boolean;
  onRemove: (e: CatalogEntry) => void;
}): ReactNode {
  const { ops } = usePanel();
  const progress = progressText(entry);
  return (
    <li className="tour-card" data-tour-id={entry.id}>
      <h3>{entry.name}</h3>
      <p className="badges">
        <span className={`badge badge-${entry.source}`}>{SOURCE_LABEL[entry.source]}</span>
        <span className={entry.hasPermission ? 'badge badge-ok' : 'badge badge-warn'}>
          {entry.hasPermission ? 'サイトの許可あり' : 'サイトの許可なし'}
        </span>
        {entry.needsReview && <span className="badge badge-warn">要確認</span>}
      </p>
      {entry.description !== null && entry.description !== '' && <p>{entry.description}</p>}
      <dl className="facts">
        <div>
          <dt>ステップ数</dt>
          <dd>{entry.stepCount}</dd>
        </div>
        <div>
          <dt>対象サイト</dt>
          <dd>{entry.origins.join('、')}</dd>
        </div>
      </dl>
      {progress !== null && <p className="meta">{progress}</p>}
      <div className="actions">
        {canStart && entry.progress !== null && (
          <button
            type="button"
            className="primary"
            data-focus-id={`resume-${entry.id}`}
            onClick={() => {
              ops.start(entry, true);
            }}
          >
            続きから
          </button>
        )}
        {canStart && (
          <button
            type="button"
            className={entry.progress === null ? 'primary' : undefined}
            data-focus-id={`start-${entry.id}`}
            onClick={() => {
              ops.start(entry, false);
            }}
          >
            最初から
          </button>
        )}
        {entry.source === 'imported' && (
          <button
            type="button"
            className="danger-text"
            data-focus-id={`remove-${entry.id}`}
            onClick={() => {
              onRemove(entry);
            }}
          >
            削除
          </button>
        )}
      </div>
    </li>
  );
}

export function ListScreen(props: ListScreenProps): ReactNode {
  const { flash, importer, onOpenSettings, onRemove, onBack } = props;
  const { view, ops } = usePanel();
  const canStart = view.status !== 'running' && view.status !== 'paused';

  return (
    <div className="screen screen-list">
      <header className="screen-header">
        <h1 tabIndex={-1} data-focus-fallback>
          ツアー一覧
        </h1>
        <div className="header-actions">
          {onBack !== null && (
            <button type="button" className="primary" data-focus-id="back-to-tour" onClick={onBack}>
              {view.status === 'paused' ? BACK_LABEL.paused : BACK_LABEL.running}
            </button>
          )}
          <button type="button" data-focus-id="reload" onClick={ops.reload}>
            再読み込み
          </button>
          <button type="button" data-focus-id="open-settings" onClick={onOpenSettings}>
            設定
          </button>
        </div>
      </header>
      {flash?.kind === 'completed' && (
        <p className="flash" role="status">
          <strong>完了しました</strong>
          {flash.tourName !== null && `（${flash.tourName}）`}
        </p>
      )}
      {flash?.kind === 'stopped' && (
        <p className="flash" role="status">
          ツアーを終了しました。進捗は破棄したので、次回は最初から始まります
        </p>
      )}
      {view.notice === 'tourRemoved' && (
        <p className="flash" role="status">
          実行中のツアーが削除されたため、終了しました
        </p>
      )}
      {view.catalog.length === 0 ? (
        <p className="empty">利用できるツアーがありません。下の取り込みエリアからツアーを取り込んでください。</p>
      ) : (
        <ul className="tour-list" aria-label="ツアーの一覧">
          {view.catalog.map((entry) => (
            <TourCard key={entry.id} entry={entry} canStart={canStart} onRemove={onRemove} />
          ))}
        </ul>
      )}
      <ImportArea importer={importer} />
    </div>
  );
}
