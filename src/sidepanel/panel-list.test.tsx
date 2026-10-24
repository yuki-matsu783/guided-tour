// @vitest-environment jsdom
/**
 * 一覧の画面と、写しの取得・反映、開始、取り込みの画面のテスト（R-PANEL-01〜13）。
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.tsx';
import type { ImportResult } from './import/index.ts';
import {
  buttons,
  click,
  entry,
  findButton,
  flush,
  getButton,
  makeDeps,
  makeView,
  mount,
  textOf,
  unmountAll,
  wait,
} from './test-support.tsx';

afterEach(async () => {
  await unmountAll();
  vi.useRealTimers();
});

describe('写しの取得と反映', () => {
  it('R-PANEL-01: 応答が無い間は応答待ちを出し、応答が来たら一覧を出す', async () => {
    vi.useFakeTimers();
    const deps = makeDeps(null);
    const { container } = await mount(<App deps={deps} />);
    expect(textOf(container)).toContain('応答を待っています');
    expect(textOf(container)).not.toContain('ツアー一覧');

    deps.state.view = makeView({ catalog: [entry()] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(textOf(container)).toContain('ツアー一覧');
    expect(textOf(container)).toContain('デモツアー');
  });

  it('R-PANEL-02: TOUR_STATE_CHANGED は 120 ミリ秒に間引き、最後の状態だけを描く', async () => {
    vi.useFakeTimers();
    const deps = makeDeps(makeView());
    const { container } = await mount(<App deps={deps} />);
    await flush();
    const changed = (name: string): unknown => ({
      type: 'TOUR_STATE_CHANGED',
      view: makeView({ catalog: [entry({ name })] }),
    });
    act(() => {
      deps.emit(changed('途中の状態'));
      deps.emit(changed('最後の状態'));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(119);
    });
    expect(textOf(container)).not.toContain('最後の状態');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(textOf(container)).toContain('最後の状態');
    expect(textOf(container)).not.toContain('途中の状態');
  });
});

describe('一覧の表示', () => {
  it('R-PANEL-03: ツアーの出所・許可・要確認・ステップ数・対象サイトを表示する', async () => {
    const deps = makeDeps(
      makeView({
        catalog: [
          entry({ id: 'a', name: '同梱の例', source: 'bundled', hasPermission: true }),
          entry({
            id: 'b',
            name: '取り込みの例',
            source: 'imported',
            hasPermission: false,
            needsReview: true,
            stepCount: 7,
            origins: ['https://one.example', 'https://two.example'],
          }),
        ],
      }),
    );
    const { container } = await mount(<App deps={deps} />);
    await flush();
    const cards = [...container.querySelectorAll('.tour-card')];
    expect(cards).toHaveLength(2);
    const [a, b] = cards.map((c) => textOf(c));
    expect(a).toContain('同梱');
    expect(a).toContain('サイトの許可あり');
    expect(a).not.toContain('要確認');
    expect(b).toContain('取り込み');
    expect(b).toContain('サイトの許可なし');
    expect(b).toContain('要確認');
    expect(b).toContain('7');
    expect(b).toContain('https://one.example');
    expect(b).toContain('https://two.example');
  });

  it('R-PANEL-04: 進捗があれば「続きから」（到達ステップと保存日時）と「最初から」、無ければ「最初から」だけを出す', async () => {
    const savedAt = new Date(2026, 9, 24, 13, 5).getTime();
    const deps = makeDeps(
      makeView({
        catalog: [
          entry({ id: 'a', name: '進捗あり', stepCount: 5, progress: { stepIndex: 2, stepId: 's3', savedAt } }),
          entry({ id: 'b', name: '進捗なし' }),
        ],
      }),
    );
    const { container } = await mount(<App deps={deps} />);
    await flush();
    const [a, b] = [...container.querySelectorAll('.tour-card')];
    if (a === undefined || b === undefined) throw new Error('カードが無い');
    expect(findButton(a, '続きから')).not.toBeNull();
    expect(findButton(a, '最初から')).not.toBeNull();
    expect(textOf(a)).toContain('3/5');
    expect(textOf(a)).toContain('2026');
    expect(textOf(a)).toContain('13:05');
    expect(findButton(b, '続きから')).toBeNull();
    expect(findButton(b, '最初から')).not.toBeNull();
  });

  it('R-PANEL-05: 削除は取り込みのツアーだけに出し、確認のあとで REMOVE を送る', async () => {
    const deps = makeDeps(
      makeView({
        catalog: [entry({ id: 'a', source: 'bundled' }), entry({ id: 'b', name: '取り込み', source: 'imported' })],
      }),
    );
    const { container } = await mount(<App deps={deps} />);
    await flush();
    expect(buttons(container).filter((x) => x.textContent === '削除')).toHaveLength(1);
    await click(getButton(container, '削除'));
    expect(deps.sent.some((m) => m.type === 'REMOVE')).toBe(false);
    await click(getButton(container, '削除する'));
    expect(deps.sent.filter((m) => m.type === 'REMOVE')).toEqual([{ type: 'REMOVE', tourId: 'b' }]);
  });

  it('R-PANEL-06: 一覧から設定へ移れ、一覧へ戻れる', async () => {
    const deps = makeDeps(makeView());
    deps.respond = () => ({ entries: [] });
    const { container } = await mount(<App deps={deps} />);
    await flush();
    await click(getButton(container, '設定'));
    expect(container.querySelector('h1')?.textContent).toBe('設定');
    await click(getButton(container, '一覧へ戻る'));
    expect(container.querySelector('h1')?.textContent).toBe('ツアー一覧');
  });
});

describe('開始', () => {
  it('R-PANEL-07: クリックの中で await を挟まずに権限を要求し、許可後に START（resume・opId つき）を送る', async () => {
    const deps = makeDeps(makeView({ catalog: [entry({ id: 'a', origins: ['https://example.com:8443'] })] }));
    const { container } = await mount(<App deps={deps} />);
    await flush();
    const button = getButton(container, '最初から');
    act(() => {
      button.click();
      // 同じクリックの処理の中で、すでに要求している（START はまだ）
      expect(deps.request).toHaveBeenCalledTimes(1);
      expect(deps.request).toHaveBeenCalledWith({ origins: ['https://example.com/*'] });
      expect(deps.sent.some((m) => m.type === 'START')).toBe(false);
    });
    await flush();
    const start = deps.sent.find((m) => m.type === 'START');
    expect(start).toMatchObject({ type: 'START', tourId: 'a', resume: false });
    expect(start && 'opId' in start ? start.opId : '').toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it('R-PANEL-08: 「続きから」は resume: true で START を送る。許可が得られなければ送らず、必要なサイトを示す', async () => {
    const deps = makeDeps(
      makeView({
        catalog: [
          entry({ id: 'a', origins: ['https://example.com'], progress: { stepIndex: 1, stepId: 's2', savedAt: 1 } }),
        ],
      }),
    );
    const { container } = await mount(<App deps={deps} />);
    await flush();
    await click(getButton(container, '続きから'));
    expect(deps.sent.find((m) => m.type === 'START')).toMatchObject({ resume: true });

    deps.sent.length = 0;
    deps.request.mockResolvedValueOnce(false);
    await click(getButton(container, '続きから'));
    expect(deps.sent.some((m) => m.type === 'START')).toBe(false);
    expect(textOf(container)).toContain('https://example.com');
    expect(textOf(container)).toContain('許可されていません');
  });

  it('R-PANEL-09: バージョンが足りない拒否では、現在と必要なバージョンを示す', async () => {
    const deps = makeDeps(makeView({ catalog: [entry()] }));
    deps.respond = () => ({ status: 'rejected', reason: 'versionTooLow', current: '0.1.0', required: '2.3.0' });
    const { container } = await mount(<App deps={deps} />);
    await flush();
    await click(getButton(container, '最初から'));
    const text = textOf(container);
    expect(text).toContain('0.1.0');
    expect(text).toContain('2.3.0');
  });
});

describe('取り込み', () => {
  const file = (name: string): File => new File(['x'], name);

  async function pick(container: HTMLElement, files: File[]): Promise<void> {
    const input = container.querySelector('input[type="file"]');
    if (!(input instanceof HTMLInputElement)) throw new Error('ファイル選択が無い');
    expect(input.multiple).toBe(true);
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    act(() => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
  }

  const results: ImportResult[] = [
    {
      status: 'imported',
      fileName: 'a.yaml',
      tourId: 'a',
      name: '取り込めた例',
      origins: ['https://example.com'],
      warnings: [{ file: 'a.yaml', line: 12, path: 'steps[0].target', message: '必須の照合がありません' }],
    },
    {
      status: 'rejected',
      fileName: 'b.zip',
      errors: [{ file: 'tour.yaml', line: 7, path: 'steps[1].url', message: 'origins の外のサイトです' }],
    },
  ];

  it('R-PANEL-10: ファイル選択（複数）で取り込み、成功（ツアー名・対象サイト・警告）と失敗（ファイル名・行番号・場所・理由）を示す', async () => {
    const deps = makeDeps(makeView());
    const importFiles = vi.fn<PanelDepsImport>(() => Promise.resolve(results));
    deps.importFiles = importFiles;
    const { container } = await mount(<App deps={deps} />);
    await flush();
    await pick(container, [file('a.yaml'), file('b.zip')]);

    expect(importFiles).toHaveBeenCalledTimes(1);
    expect(importFiles.mock.calls[0]?.[0].map((f) => f.name)).toEqual(['a.yaml', 'b.zip']);
    const text = textOf(container);
    for (const expected of [
      '取り込めた例',
      'https://example.com',
      '警告',
      '12 行目',
      'steps[0].target',
      '必須の照合がありません',
      'b.zip',
      'tour.yaml',
      '7 行目',
      'steps[1].url',
      'origins の外のサイトです',
    ]) {
      expect(text).toContain(expected);
    }
  });

  it('R-PANEL-11: ドラッグ＆ドロップでも取り込める', async () => {
    const deps = makeDeps(makeView());
    const importFiles = vi.fn<PanelDepsImport>(() => Promise.resolve([]));
    deps.importFiles = importFiles;
    const { container } = await mount(<App deps={deps} />);
    await flush();
    const zone = container.querySelector('[data-testid="dropzone"]');
    if (zone === null) throw new Error('ドロップ領域が無い');
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [file('a.yaml')] } });
    act(() => {
      zone.dispatchEvent(drop);
    });
    await flush();
    expect(importFiles).toHaveBeenCalledTimes(1);
    expect(importFiles.mock.calls[0]?.[0].map((f) => f.name)).toEqual(['a.yaml']);
  });

  it('R-PANEL-12: 上書きの確認に、同梱版の置き換えと実行中の一時中断を示し、答えを取り込みへ返す', async () => {
    const deps = makeDeps(makeView({ catalog: [entry({ id: 'a', source: 'bundled' })] }));
    const answers: boolean[] = [];
    deps.importFiles = async (_files, hooks) => {
      answers.push(await hooks.confirmOverwrite({ fileName: 'a.yaml', tourName: '新しい a', tourId: 'a', existingSource: 'bundled', running: true }));
      return [];
    };
    const { container } = await mount(<App deps={deps} />);
    await flush();

    await pick(container, [file('a.yaml')]);
    const dialog = container.querySelector('[role="alertdialog"]');
    expect(textOf(dialog ?? container)).toContain('同梱');
    expect(textOf(dialog ?? container)).toContain('一時中断');
    await click(getButton(container, '上書きしない'));
    await pick(container, [file('a.yaml')]);
    await click(getButton(container, '上書きする'));
    expect(answers).toEqual([false, true]);
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('R-PANEL-13: 取り込み中も、画面の操作は止まらない', async () => {
    const deps = makeDeps(makeView({ catalog: [entry()] }));
    deps.importFiles = () => new Promise<ImportResult[]>(() => undefined);
    const { container } = await mount(<App deps={deps} />);
    await flush();
    await pick(container, [file('a.yaml')]);
    expect(textOf(container)).toContain('取り込み中');
    expect(getButton(container, '最初から').disabled).toBe(false);
    await wait(0);
    expect(getButton(container, '設定').disabled).toBe(false);
  });
});

type PanelDepsImport = (
  files: File[],
  hooks: Parameters<ReturnType<typeof makeDeps>['importFiles']>[1],
) => Promise<ImportResult[]>;
