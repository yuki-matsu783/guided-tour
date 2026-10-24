/**
 * ツアーの取り込みエリア。ドラッグ＆ドロップとファイル選択（複数）で `importFiles` を呼び、結果を並べる。
 * 取り込み中も、ほかの操作（終了・一時中断など）は止めない。
 * 結果は、成功（ツアー名・対象サイト・警告）、取り消し、失敗（ファイル名・行番号・場所・理由）の順に出す。
 */
import { useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import type { CatalogEntry } from '../../shared/messages/index.ts';
import type { PanelDeps } from '../deps.ts';
import type { ImportResult, Issue, OverwriteRequest } from '../import/index.ts';

interface ImportAreaProps {
  deps: PanelDeps;
  catalog: readonly CatalogEntry[];
  confirmOverwrite: (request: OverwriteRequest) => Promise<boolean>;
  getRunningTourId: () => string | null;
  /** 取り込みが終わった（一覧を取り直す）。 */
  onImported: () => void;
}

const UNEXPECTED: ImportResult = {
  status: 'rejected',
  fileName: '',
  errors: [{ file: '', line: null, path: '', message: '取り込み中に予期しないエラーが起きました' }],
};

function IssueItem({ issue, label }: { issue: Issue; label: string }): ReactNode {
  return (
    <li className="issue">
      <span className="issue-label">{label}</span>
      {issue.file !== '' && <span className="issue-file">{issue.file}</span>}
      {issue.line !== null && <span className="issue-line">{`${String(issue.line)} 行目`}</span>}
      {issue.path !== '' && <span className="issue-path">{`場所: ${issue.path}`}</span>}
      <span className="issue-message">{issue.message}</span>
    </li>
  );
}

function ResultItem({ result }: { result: ImportResult }): ReactNode {
  if (result.status === 'imported') {
    return (
      <li className="result result-ok">
        <p>
          <strong>{`「${result.name}」`}</strong>を取り込みました（{result.fileName}）
        </p>
        <p className="meta">{`対象サイト: ${result.origins.join('、')}`}</p>
        {result.warnings.length > 0 && (
          <ul className="issues">
            {result.warnings.map((w, i) => (
              <IssueItem key={i} issue={w} label="警告" />
            ))}
          </ul>
        )}
      </li>
    );
  }
  if (result.status === 'cancelled') {
    return (
      <li className="result result-cancelled">
        <p>
          {`「${result.name}」（${result.fileName}）は、上書きしなかったため取り込みませんでした`}
        </p>
      </li>
    );
  }
  return (
    <li className="result result-error">
      <p>
        <strong>{result.fileName === '' ? 'ファイル' : result.fileName}</strong>を取り込めませんでした
      </p>
      <ul className="issues">
        {result.errors.map((e, i) => (
          <IssueItem key={i} issue={e} label="エラー" />
        ))}
      </ul>
    </li>
  );
}

/** ログに残す結果の種類。 */
function summarize(results: readonly ImportResult[]): 'imported' | 'cancelled' | 'rejected' {
  if (results.some((r) => r.status === 'imported')) return 'imported';
  if (results.some((r) => r.status === 'cancelled')) return 'cancelled';
  return 'rejected';
}

export function ImportArea(props: ImportAreaProps): ReactNode {
  const { deps, catalog, confirmOverwrite, getRunningTourId, onImported } = props;
  const [results, setResults] = useState<readonly ImportResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const run = (files: File[]): void => {
    if (files.length === 0) return;
    setBusy(true);
    const bytes = files.reduce((sum, f) => sum + f.size, 0);
    const bundledFromCatalog = catalog.filter((e) => e.source === 'bundled').map((e) => e.id);
    void deps
      .importFiles(files, {
        confirmOverwrite,
        getRunningTourId,
        getBundledTourIds: async () => [...new Set([...(await deps.bundledTourIds()), ...bundledFromCatalog])],
        notifyCatalogChanged: async (change) => {
          await deps.send({ type: 'CATALOG_CHANGED', tourId: change.tourId, hash: change.hash });
        },
      })
      .then(
        (done) => {
          deps.logger.info('import.result', { result: summarize(done), files: files.length, bytes });
          setResults(done);
        },
        () => {
          deps.logger.info('import.result', { result: 'failed', files: files.length, bytes });
          setResults([UNEXPECTED]);
        },
      )
      .finally(() => {
        setBusy(false);
        onImported();
      });
  };

  const onDrop = (event: DragEvent): void => {
    event.preventDefault();
    setDragging(false);
    run([...event.dataTransfer.files]);
  };

  return (
    <section className="import" aria-labelledby="import-title">
      <h2 id="import-title">ツアーを取り込む</h2>
      <div
        className={dragging ? 'dropzone dragging' : 'dropzone'}
        data-testid="dropzone"
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => {
          setDragging(false);
        }}
        onDrop={onDrop}
      >
        <p>.yaml・.yml・.zip のファイルをここへドロップするか、ファイルを選んでください（複数可）</p>
        <button
          type="button"
          data-focus-id="import-pick"
          onClick={() => {
            inputRef.current?.click();
          }}
        >
          ファイルを選ぶ
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".yaml,.yml,.zip"
          hidden
          aria-label="取り込むファイル"
          onChange={(event) => {
            const picked = [...(event.currentTarget.files ?? [])];
            event.currentTarget.value = '';
            run(picked);
          }}
        />
      </div>
      {busy && (
        <p role="status" className="meta">
          取り込み中です…
        </p>
      )}
      {results !== null && (
        <div className="results" role="status" aria-label="取り込みの結果">
          <ul>
            {results.map((r, i) => (
              <ResultItem key={i} result={r} />
            ))}
          </ul>
          <button
            type="button"
            onClick={() => {
              setResults(null);
            }}
          >
            結果を閉じる
          </button>
        </div>
      )}
    </section>
  );
}
