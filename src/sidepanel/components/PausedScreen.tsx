/**
 * 一時中断中の画面。中断の理由を示し、理由ごとの選択肢を出す。
 * 許可の取り消しと上書きでは、再開の操作の中で（ops が）権限を要求してから送る。
 */
import type { ReactNode } from 'react';
import type { PauseReason } from '../../shared/messages/index.ts';
import { usePanel } from '../context.ts';
import { PauseStopExplanation, SaveErrorNotice, ScreenLinks, TourHeading } from './common.tsx';
import type { ScreenNav } from './common.tsx';

const REASON_TEXT = {
  user: '一時中断中です。ページ上の表示とミニガイドは消えています',
  permission:
    'サイトへのアクセスの許可が取り消されたため、一時中断しました。再び許可すると再開できます',
  overwritten:
    '同じ ID のツアーが新しい内容に上書きされたため、一時中断しました。新しい内容で続けるか、終了を選んでください',
} as const satisfies Record<PauseReason, string>;

export function PausedScreen({ onOpenList, onOpenSettings }: ScreenNav): ReactNode {
  const { view, ops } = usePanel();
  const reason = view.pauseReason ?? 'user';
  const stepTitle = view.steps[view.stepIndex]?.title;

  return (
    <div className="screen screen-paused">
      <TourHeading view={view}>
        <ScreenLinks onOpenList={onOpenList} onOpenSettings={onOpenSettings} />
      </TourHeading>
      <SaveErrorNotice view={view} />
      <p className="notice" role="status">
        {REASON_TEXT[reason]}
      </p>
      {stepTitle !== undefined && <p className="meta">{`中断したステップ: ${stepTitle}`}</p>}
      {reason === 'permission' && view.tour !== null && (
        <p className="meta">{`必要なサイト: ${view.tour.origins.join('、')}`}</p>
      )}
      <div className="actions">
        {reason === 'user' && (
          <>
            <button type="button" className="primary" data-focus-id="resume" onClick={ops.resume}>
              再開
            </button>
            <button type="button" data-focus-id="restart" onClick={ops.restart}>
              最初からやり直し
            </button>
          </>
        )}
        {reason === 'permission' && (
          <button type="button" className="primary" data-focus-id="resume" onClick={ops.resume}>
            再び許可して再開
          </button>
        )}
        {reason === 'overwritten' && (
          <>
            <button
              type="button"
              className="primary"
              data-focus-id="resume-continue"
              onClick={() => {
                ops.resumeNew('continue');
              }}
            >
              新版で続きから
            </button>
            <button
              type="button"
              data-focus-id="resume-restart"
              onClick={() => {
                ops.resumeNew('restart');
              }}
            >
              新版で最初から
            </button>
          </>
        )}
        <button type="button" className="danger-text" data-focus-id="stop" onClick={ops.stop}>
          終了
        </button>
      </div>
      <PauseStopExplanation />
    </div>
  );
}
