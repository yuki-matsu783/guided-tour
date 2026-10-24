/** 実行中・一時中断中の画面に共通の小さな部品（ツアー名の見出し・保存の失敗・一時中断と終了の違い）。 */
import type { ReactNode } from 'react';
import type { PanelView } from '../../shared/messages/index.ts';
import { SOURCE_LABEL } from '../format.ts';

export const SAVE_ERROR_TEXT = '保存されていません。再起動すると前の位置に戻る可能性があります';

export function TourHeading({ view, children }: { view: PanelView; children?: ReactNode }): ReactNode {
  const tour = view.tour;
  const total = view.steps.length;
  return (
    <header className="screen-header">
      <div>
        <h1 tabIndex={-1} data-focus-fallback>
          {tour?.name ?? 'ツアー'}
        </h1>
        <p className="badges">
          {tour !== null && <span className={`badge badge-${tour.source}`}>{SOURCE_LABEL[tour.source]}</span>}
          {total > 0 && (
            <span className="badge" aria-label={`${String(view.stepIndex + 1)} / ${String(total)} ステップ`}>
              {`${String(view.stepIndex + 1)}/${String(total)}`}
            </span>
          )}
        </p>
      </div>
      {children}
    </header>
  );
}

export function SaveErrorNotice({ view }: { view: PanelView }): ReactNode {
  if (!view.saveError) return null;
  return (
    <p className="notice notice-error" role="alert">
      {SAVE_ERROR_TEXT}
    </p>
  );
}

export function RestartedNotice({ view }: { view: PanelView }): ReactNode {
  if (view.notice !== 'restartedFromFirst') return null;
  return (
    <p className="notice" role="status">
      ツアーが更新されたため最初から開始します
    </p>
  );
}

export function PauseStopExplanation(): ReactNode {
  return (
    <div className="explain">
      <p>
        <strong>一時中断</strong>
        ：ページ上の表示を消して止めます。進捗は残るので、あとで続きから再開できます。
      </p>
      <p>
        <strong>終了</strong>：ツアーをやめて、進捗を破棄します。次回は最初から始まります。
      </p>
    </div>
  );
}
