/**
 * ツアーの取り込みエリア。ドラッグ＆ドロップとファイル選択（複数）で取り込みを始め、進行と結果を並べる。
 * 取り込み中も、ほかの操作（終了・一時中断など）は止めない。
 * 結果は、成功（ツアー名・対象サイト・警告）、取り消し、失敗（ファイル名・行番号・場所・理由）の順に出す。
 */
import { useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import type { ImportResult, Issue } from '../import/index.ts';
import type { Importer } from '../use-importer.ts';

interface ImportAreaProps {
  /** 取り込みの進行・結果。アプリの状態として持つので、この部品が消えても失われない。 */
  importer: Importer;
}

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

export function ImportArea({ importer }: ImportAreaProps): ReactNode {
  const { busy, results, run, dismissResults } = importer;
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

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
            onClick={dismissResults}
          >
            結果を閉じる
          </button>
        </div>
      )}
    </section>
  );
}
