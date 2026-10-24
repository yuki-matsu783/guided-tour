/**
 * 設定の画面。ログレベル、ミニガイドを表示しないか、保守記録の確認（ツアー別・ステップ別）、
 * ログと保守記録の書き出し（ファイルの保存）と消去を扱う。
 * ログレベルは `storage.local` の設定へ書く。保守記録は開いたときと消去のあとに読み直す。
 */
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { LEVELS, LevelSchema } from '../../shared/logger/index.ts';
import type { Level } from '../../shared/logger/index.ts';
import { DiagnosticsResponseSchema, ExportLogsResponseSchema } from '../../shared/messages/index.ts';
import type { DiagnosticEntryView } from '../../shared/messages/index.ts';
import { usePanel } from '../context.ts';
import { formatDateTime } from '../format.ts';

interface SettingsScreenProps {
  onBack: () => void;
  /** 消去の確認を出す。承認されたら `proceed` を呼ぶ。 */
  confirmClear: (proceed: () => void) => void;
}

const LEVEL_LABEL = {
  error: 'エラー',
  warn: '警告',
  info: '情報',
  debug: '詳細',
} as const satisfies Record<Level, string>;

const REASON_LABEL = {
  degraded: '劣化（下位の手がかりで特定）',
  conflict: '矛盾（必須の照合で除外）',
  missing: '未検出',
  nameMismatch: '名前不一致',
} as const satisfies Record<DiagnosticEntryView['reason'], string>;

type Diagnostics = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; entries: DiagnosticEntryView[] };

function DiagnosticsList({ entries, nameOf }: { entries: readonly DiagnosticEntryView[]; nameOf: (id: string) => string }): ReactNode {
  if (entries.length === 0) return <p className="meta">保守記録はありません</p>;
  const byTour = new Map<string, DiagnosticEntryView[]>();
  for (const e of entries) byTour.set(e.tourId, [...(byTour.get(e.tourId) ?? []), e]);
  return (
    <div className="diagnostics">
      {[...byTour].map(([tourId, rows]) => {
        const total = rows.reduce((sum, r) => sum + r.total, 0);
        return (
          <section key={tourId} className="diag-tour" aria-label={`ツアー ${nameOf(tourId)} の保守記録`}>
            <h4>{nameOf(tourId)}</h4>
            <p className="meta">{`${String(rows.length)} 件（累計 ${String(total)} 回）`}</p>
            <ul>
              {rows
                .toSorted((a, b) => b.lastAt - a.lastAt)
                .map((r) => (
                  <li key={`${r.stepId}:${r.reason}`}>
                    <span className="diag-step">{`ステップ ${r.stepId}`}</span>
                    <span className="badge badge-warn">{REASON_LABEL[r.reason]}</span>
                    <span>{`${String(r.total)} 回`}</span>
                    <span className="meta">
                      {r.tier === null ? '' : `採用した段階 ${String(r.tier)}`}
                      {r.topTier === null || r.topTier === r.tier ? '' : `（最上位 ${String(r.topTier)}）`}
                    </span>
                    <span className="meta">{`最終 ${formatDateTime(r.lastAt)}`}</span>
                  </li>
                ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

export function SettingsScreen({ onBack, confirmClear }: SettingsScreenProps): ReactNode {
  const { deps, view, ops } = usePanel();
  const [localLevel, setLocalLevel] = useState<Level | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics>({ status: 'loading' });
  const [message, setMessage] = useState<string | null>(null);

  const loadDiagnostics = useCallback(() => {
    deps.send({ type: 'GET_DIAGNOSTICS' }).then(
      (raw) => {
        const parsed = DiagnosticsResponseSchema.safeParse(raw);
        setDiagnostics(parsed.success ? { status: 'ready', entries: parsed.data.entries } : { status: 'failed' });
      },
      () => {
        setDiagnostics({ status: 'failed' });
      },
    );
  }, [deps]);

  useEffect(() => {
    loadDiagnostics();
  }, [loadDiagnostics]);

  const level = localLevel ?? view.logLevel;
  const nameOf = (id: string): string => view.catalog.find((e) => e.id === id)?.name ?? id;

  const changeLevel = (next: Level): void => {
    setLocalLevel(next);
    void deps.writeLogLevel(next).then((ok) => {
      setMessage(ok ? null : 'ログレベルを保存できませんでした');
      if (!ok) setLocalLevel(null);
    });
  };

  const exportLogs = (): void => {
    deps.send({ type: 'EXPORT_LOGS' }).then(
      (raw) => {
        const parsed = ExportLogsResponseSchema.safeParse(raw);
        if (!parsed.success) {
          setMessage('ログを書き出せませんでした');
          return;
        }
        deps.saveFile('guided-tour-logs.jsonl', parsed.data.logs, 'application/x-ndjson');
        deps.saveFile('guided-tour-diagnostics.json', parsed.data.diagnostics, 'application/json');
        setMessage('ログと保守記録をファイルに保存しました');
      },
      () => {
        setMessage('ログを書き出せませんでした');
      },
    );
  };

  const clear = (): void => {
    confirmClear(() => {
      deps.send({ type: 'CLEAR_LOGS' }).then(
        () => {
          setMessage('ログと保守記録を消去しました');
          loadDiagnostics();
        },
        () => {
          setMessage('消去できませんでした');
        },
      );
    });
  };

  return (
    <div className="screen screen-settings">
      <header className="screen-header">
        <h1 tabIndex={-1} data-focus-fallback>
          設定
        </h1>
        <button type="button" data-focus-id="settings-back" onClick={onBack}>
          一覧へ戻る
        </button>
      </header>
      {message !== null && (
        <p className="flash" role="status">
          {message}
        </p>
      )}
      <section aria-labelledby="log-level-title">
        <h2 id="log-level-title">ログ</h2>
        <label className="field">
          <span>ログレベル</span>
          <select
            value={level}
            onChange={(event) => {
              const parsed = LevelSchema.safeParse(event.currentTarget.value);
              if (parsed.success) changeLevel(parsed.data);
            }}
          >
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {LEVEL_LABEL[l]}
              </option>
            ))}
          </select>
        </label>
        <p className="meta">ログは、この端末にだけ保存します。ページの内容や入力値は記録しません。</p>
      </section>
      <section aria-labelledby="miniguide-title">
        <h2 id="miniguide-title">ミニガイド</h2>
        <label className="field field-check">
          <input
            type="checkbox"
            checked={!view.ui.enabled}
            onChange={(event) => {
              ops.setMiniGuide(!event.currentTarget.checked);
            }}
          />
          <span>ミニガイドを表示しない</span>
        </label>
      </section>
      <section aria-labelledby="diag-title">
        <h2 id="diag-title">保守記録</h2>
        <p className="meta">対象要素の特定が想定どおりでなかったことの記録です（ツアー別・ステップ別）。</p>
        {diagnostics.status === 'loading' && <p className="meta">読み込み中です…</p>}
        {diagnostics.status === 'failed' && <p className="notice notice-error">保守記録を読み込めませんでした</p>}
        {diagnostics.status === 'ready' && <DiagnosticsList entries={diagnostics.entries} nameOf={nameOf} />}
      </section>
      <section aria-labelledby="export-title">
        <h2 id="export-title">書き出しと消去</h2>
        <div className="actions">
          <button type="button" data-focus-id="export" onClick={exportLogs}>
            ログと保守記録を書き出す
          </button>
          <button type="button" className="danger-text" data-focus-id="clear" onClick={clear}>
            ログと保守記録を消去
          </button>
        </div>
      </section>
    </div>
  );
}
