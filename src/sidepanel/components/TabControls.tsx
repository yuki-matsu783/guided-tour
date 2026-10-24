/**
 * 現在のステップの役割のタブについての表示と操作。
 * タブが無い・別のページのときは、既存タブの選択（「このタブを○○として使う」を含む）と、
 * 「今のタブで開く」「新しいタブで開く」を出す。注目中でないときは「○○のタブへ移動」、
 * ページ側を組み込めないときは「このページでは表示できません」を示す（「再確認」は操作の列にある）。
 * 別の役割に対応付け済みのタブを選んだときの確認は、バックグラウンドの応答を受けて上位が出す。
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { TabCandidate, TabView } from '../../shared/messages/index.ts';
import { usePanel } from '../context.ts';
import { roleLabelOf } from '../role-label.ts';

interface TabControlsProps {
  tab: TabView;
  roleLabel: string;
  /** 開く URL がある（または分からない）。 */
  canOpen: boolean;
}

function candidateLabel(c: TabCandidate, roleLabel: string, isActive: boolean): string {
  if (isActive) return `このタブを「${roleLabel}」として使う`;
  const title = c.title === '' ? '無題のタブ' : c.title;
  return `「${title}」を「${roleLabel}」として使う`;
}

export function TabControls({ tab, roleLabel, canOpen }: TabControlsProps): ReactNode {
  const { deps, ops, view } = usePanel();
  const roles = view.roles;
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const needsBinding = tab.status === 'missing' || tab.status === 'mismatch';
  const candidateKey = tab.candidates.map((c) => c.tabId).join(',');

  // 注目中のタブが候補にあるときは、「このタブを使う」として先頭に出す
  useEffect(() => {
    if (!needsBinding || candidateKey === '') return;
    let cancelled = false;
    void deps.getActiveTabId().then((id) => {
      if (!cancelled) setActiveTabId(id);
    });
    return () => {
      cancelled = true;
    };
  }, [deps, needsBinding, candidateKey]);

  const candidates = [...tab.candidates].sort(
    (a, b) => Number(b.tabId === activeTabId) - Number(a.tabId === activeTabId),
  );

  return (
    <section className="tab-controls" aria-label="タブの操作">
      {tab.status === 'unsupported' && (
        <p className="notice" role="status">
          このページでは表示できません（読み込み中、またはブラウザが制限しているページです）。ページを開き直してから、「再確認」を押してください
        </p>
      )}
      {tab.status === 'missing' && (
        <p className="notice" role="status">
          {`「${roleLabel}」のタブがありません。次のどれかを選んでください`}
        </p>
      )}
      {tab.status === 'mismatch' && (
        <p className="notice" role="status">
          {`「${roleLabel}」のタブが、このステップのページとは別のページを表示しています。ページを開くか、別のタブを選んでください`}
        </p>
      )}
      {!tab.attended && tab.status !== 'missing' && (
        <button type="button" data-focus-id="focus-role" onClick={ops.focusRole}>
          {`「${roleLabel}」のタブへ移動`}
        </button>
      )}
      {needsBinding && candidates.length > 0 && (
        <div>
          <h3>既存のタブから選ぶ</h3>
          <ul className="candidates">
            {candidates.map((c) => (
              <li key={c.tabId}>
                <button
                  type="button"
                  data-focus-id={`bind-${String(c.tabId)}`}
                  onClick={() => {
                    ops.bindTab(c.tabId, false);
                  }}
                >
                  {candidateLabel(c, roleLabel, c.tabId === activeTabId)}
                </button>
                {c.boundRole !== null && <span className="meta">{`（「${roleLabelOf(roles, c.boundRole)}」に対応付け済み）`}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {needsBinding && canOpen && (
        <div className="actions">
          <button
            type="button"
            data-focus-id="open-current"
            onClick={() => {
              ops.openIn('current');
            }}
          >
            今のタブで開く
          </button>
          <button
            type="button"
            data-focus-id="open-new"
            onClick={() => {
              ops.openIn('new');
            }}
          >
            新しいタブで開く
          </button>
        </div>
      )}
    </section>
  );
}
