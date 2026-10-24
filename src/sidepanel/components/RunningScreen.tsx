/**
 * 実行中の画面。n/N・見出し・説明文・補足画像・完了の目安・タブの操作・移動と中断・全ステップの一覧を出す。
 * `PanelView` に無いステップの項目（説明文・補足画像・対象・完了の目安・開く URL）は、
 * `use-content` が読む。読めない間・読めなかったときも、見出しと移動の操作は使える。
 * 案内だけの手順（guide）は、ページ上の操作を持たず「ブラウザの外などで行う手順です」と示す。
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { Done, Step } from '../../core/tour/index.ts';
import type { Hint } from '../../shared/messages/index.ts';
import { usePanel } from '../context.ts';
import { roleLabelOf } from '../role-label.ts';
import { useAssetUrl, useStepBody, useTourContent } from '../use-content.ts';
import { Markdown } from './Markdown.tsx';
import { PauseStopExplanation, RestartedNotice, SaveErrorNotice, ScreenLinks, TourHeading } from './common.tsx';
import type { ScreenNav } from './common.tsx';
import { TabControls } from './TabControls.tsx';

export const HINT_TEXT = {
  met: '次へ進めます',
  unmet: 'まだ完了の目安を満たしていません',
  unsupported: 'この項目は確認できません',
  stopped: '確認を停止中',
} as const;

type HintKind = keyof typeof HINT_TEXT;

/** 完了の目安の状態。優先順位は、確認の停止、確認できない、満たした、まだ、の順。 */
function hintKind(hint: Hint): HintKind {
  if (hint.stopped) return 'stopped';
  if (hint.unsupported) return 'unsupported';
  return hint.met ? 'met' : 'unmet';
}

function HintView({ done, hint }: { done: Done | undefined; hint: Hint }): ReactNode {
  const kind = hintKind(hint);
  // 内容が読めていないときは、満たしたときだけ示す
  if (done === undefined && kind !== 'met') return null;
  const detail =
    kind === 'unmet' || kind === 'unsupported'
      ? done?.hint
      : kind === 'met'
        ? done?.doneHint
        : undefined;
  return (
    <section className={`hint hint-${kind}`} aria-label="完了の目安">
      <h3>完了の目安</h3>
      <p role="status">
        <strong>{HINT_TEXT[kind]}</strong>
      </p>
      {detail !== undefined && detail !== '' && <p>{detail}</p>}
    </section>
  );
}

function MediaImage({ url, alt }: { url: string; alt: string }): ReactNode {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className="media-alt">{alt}</span>;
  return (
    <img
      src={url}
      alt={alt}
      onError={() => {
        setFailed(true);
      }}
    />
  );
}

function StepMedia({ media }: { media: NonNullable<Step['media']> }): ReactNode {
  const { view, assets } = usePanel();
  const url = useAssetUrl(assets, view.tour, media.src);
  return (
    <figure className="media">
      {typeof url === 'string' ? <MediaImage key={url} url={url} alt={media.alt} /> : <span className="media-alt">{media.alt}</span>}
      {media.caption !== undefined && media.caption !== '' && <figcaption>{media.caption}</figcaption>}
    </figure>
  );
}

function StepList(): ReactNode {
  const { view, ops } = usePanel();
  return (
    <section aria-labelledby="steps-title">
      <h2 id="steps-title">全ステップ</h2>
      <ol className="step-list">
        {view.steps.map((s, i) => {
          const position = i < view.stepIndex ? 'before' : i === view.stepIndex ? 'current' : 'after';
          const mark = position === 'before' ? '前' : position === 'current' ? '現在' : '後';
          return (
            <li key={s.id}>
              <button
                type="button"
                className={`step step-${position}`}
                aria-current={position === 'current' ? 'step' : undefined}
                data-focus-id={`step-${String(i)}`}
                onClick={() => {
                  ops.goto(i);
                }}
              >
                <span className="step-mark" aria-hidden="true">
                  {mark}
                </span>
                <span className="step-title">{`${String(i + 1)}. ${s.title}`}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function RunningScreen({ onOpenList, onOpenSettings }: ScreenNav): ReactNode {
  const { deps, view, ops, assets } = usePanel();
  const tour = view.tour;
  const content = useTourContent(deps, tour);
  const summary = view.steps[view.stepIndex];
  const found = content?.steps[view.stepIndex];
  // 内容と写しのステップが食い違うときは、内容を使わない
  const step = found !== undefined && found.id === summary?.id ? found : undefined;
  const body = useStepBody(deps, tour, step ?? null);
  const total = view.steps.length;
  const isLast = view.stepIndex >= total - 1;
  const isGuide = summary?.kind === 'guide';
  const tab = view.tabStatus;
  const role = tab?.role ?? step?.tab ?? '';
  const roleLabel = view.roles.some((r) => r.id === role)
    ? roleLabelOf(view.roles, role)
    : (content?.tabs?.[role]?.label ?? role);
  const openUrl = step?.open ?? content?.tabs?.[role]?.open;
  const canOpen = content == null || openUrl !== undefined;

  return (
    <div className="screen screen-running">
      <TourHeading view={view}>
        <ScreenLinks onOpenList={onOpenList} onOpenSettings={onOpenSettings} />
      </TourHeading>
      <SaveErrorNotice view={view} />
      <RestartedNotice view={view} />
      <article className="step-body">
        <h2>{summary?.title ?? ''}</h2>
        {isGuide && (
          <p className="notice" role="status">
            ブラウザの外などで行う手順です
          </p>
        )}
        {tour !== null && body != null && body.text !== '' && (
          <Markdown
            text={body.text}
            baseFile={body.baseFile}
            tourId={tour.id}
            hash={tour.hash}
            origins={tour.origins}
            assets={assets}
          />
        )}
        {body === null && <p className="meta">説明文を読み込めませんでした</p>}
        {step?.media !== undefined && <StepMedia media={step.media} />}
      </article>
      {!isGuide && <HintView done={step?.done} hint={view.hint} />}
      {!isGuide && tab === null && (
        <p className="meta" role="status">
          タブの状態を確認しています…
        </p>
      )}
      {!isGuide && tab !== null && <TabControls tab={tab} roleLabel={roleLabel} canOpen={canOpen} />}
      {!isGuide && (
        <div className="actions">
          <button
            type="button"
            data-focus-id="scroll"
            disabled={tab?.status !== 'ok' || (step !== undefined && step.target === undefined)}
            onClick={ops.scrollToTarget}
          >
            対象を表示
          </button>
          <button type="button" data-focus-id="recheck" onClick={ops.recheck}>
            再確認
          </button>
          <button
            type="button"
            data-focus-id="overlay"
            aria-pressed={view.overlayHidden}
            onClick={() => {
              ops.setOverlay(!view.overlayHidden);
            }}
          >
            {view.overlayHidden ? '表示を戻す' : '表示を消す'}
          </button>
        </div>
      )}
      <nav className="actions nav" aria-label="ステップの移動">
        <button
          type="button"
          data-focus-id="prev"
          disabled={view.stepIndex === 0}
          onClick={() => {
            ops.goto(view.stepIndex - 1);
          }}
        >
          戻る
        </button>
        <button
          type="button"
          className="primary"
          data-focus-id="next"
          onClick={() => {
            ops.goto(view.stepIndex + 1);
          }}
        >
          {isLast ? '完了' : '次へ'}
        </button>
      </nav>
      <div className="actions">
        <button type="button" data-focus-id="pause" onClick={ops.pause}>
          一時中断
        </button>
        <button type="button" className="danger-text" data-focus-id="stop" onClick={ops.stop}>
          終了
        </button>
      </div>
      <PauseStopExplanation />
      <StepList />
    </div>
  );
}
