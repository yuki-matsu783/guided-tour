// @vitest-environment jsdom
/**
 * サイドパネルのレビュー指摘の再発防止（R-PANEL-71・73〜83・85・86）。
 * 移動の受け付けの時計、通知と取得の順、確認の列、取り込みの状態の保持、実行中・一時中断中からの一覧と設定への入口。
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.tsx';
import { createChromeDeps } from './deps.ts';
import type { ImportHooks } from './deps.ts';
import type { ImportResult, OverwriteRequest } from './import/index.ts';
import {
  buttons,
  buttonName,
  click,
  entry,
  findButton,
  flush,
  getButton,
  makeDeps,
  makeView,
  mount,
  runningView,
  textOf,
  unmountAll,
  wait,
} from './test-support.tsx';
import type { FakeDeps } from './test-support.tsx';

afterEach(async () => {
  await unmountAll();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const file = (name: string): File => new File(['x'], name);

async function pick(container: HTMLElement, files: File[]): Promise<void> {
  const input = container.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) throw new Error('ファイル選択が無い');
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
}

function overwrite(fileName: string, tourId: string, tourName: string, over: Partial<OverwriteRequest> = {}): OverwriteRequest {
  return { fileName, tourId, tourName, existingSource: 'imported', running: false, ...over };
}

const importedEntry = entry({ id: 'demo', name: 'デモツアー', source: 'imported' });
const runningWithCatalog = (over = {}): ReturnType<typeof runningView> =>
  runningView({ catalog: [importedEntry], ...over });

async function open(view: ReturnType<typeof makeView>): Promise<{ deps: FakeDeps; container: HTMLElement }> {
  const deps = makeDeps(view);
  const { container } = await mount(<App deps={deps} />);
  await flush(10);
  return { deps, container };
}

async function emitView(deps: FakeDeps, view: ReturnType<typeof makeView>): Promise<void> {
  deps.state.view = view;
  act(() => {
    deps.emit({ type: 'TOUR_STATE_CHANGED', view });
  });
  await wait(150);
}

describe('時計と取得の順', () => {
  it('R-PANEL-71: 移動の受け付けの時計は、巻き戻ることがある時刻（Date.now）ではなく performance.now', () => {
    vi.stubGlobal('chrome', {
      storage: { local: { get: () => Promise.resolve({}) }, onChanged: { addListener: () => undefined, removeListener: () => undefined } },
      runtime: { sendMessage: () => Promise.resolve(undefined) },
      permissions: {},
    });
    vi.spyOn(Date, 'now').mockReturnValue(5);
    vi.spyOn(performance, 'now').mockReturnValue(1234);
    expect(createChromeDeps().now()).toBe(1234);
  });

  it('R-PANEL-73: 通知を待っている間に取得の応答が届いても、その通知は取り消さず反映し、そのあと取り直して最新に揃える', async () => {
    vi.useFakeTimers();
    const deps = makeDeps(makeView());
    const releases: ((value: unknown) => void)[] = [];
    deps.send = (message) => {
      deps.sent.push(message);
      return new Promise((resolve) => {
        releases.push(resolve);
      });
    };
    const { container } = await mount(<App deps={deps} />);
    act(() => {
      deps.emit({ type: 'TOUR_STATE_CHANGED', view: makeView({ catalog: [entry({ name: '通知の状態' })] }) });
    });
    await act(async () => {
      releases[0]?.(makeView({ catalog: [entry({ name: '取得の状態' })] }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(textOf(container)).toContain('取得の状態');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    // 通知は取り消されず、あとで反映される
    expect(textOf(container)).toContain('通知の状態');
    // そのあとの取り直しで、最新に揃う
    expect(deps.sent.filter((m) => m.type === 'GET_STATE')).toHaveLength(2);
    await act(async () => {
      releases[1]?.(makeView({ catalog: [entry({ name: '最新の状態' })] }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(textOf(container)).toContain('最新の状態');
  });
});

describe('上書きの確認の列', () => {
  it('R-PANEL-74: 別々の取り込みの上書きの確認は列にして1つずつ出し、ファイル名・ツアーの名前・ID を示し、それぞれの取り込みに答える', async () => {
    const deps = makeDeps(makeView({ catalog: [entry({ id: 'tx' }), entry({ id: 'ty' })] }));
    const answers: Record<string, boolean> = {};
    deps.importFiles = async (files, hooks: ImportHooks) => {
      const name = files[0]?.name ?? '';
      const request = name === 'x.yaml' ? overwrite(name, 'tx', 'X 新') : overwrite(name, 'ty', 'Y 新');
      const ok = await hooks.confirmOverwrite(request);
      answers[name] = ok;
      const done: ImportResult = ok
        ? { status: 'imported', fileName: name, tourId: request.tourId, name: request.tourName, origins: [], warnings: [] }
        : { status: 'cancelled', fileName: name, tourId: request.tourId, name: request.tourName };
      return [done];
    };
    const { container } = await mount(<App deps={deps} />);
    await flush();
    await pick(container, [file('x.yaml')]);
    await pick(container, [file('y.yaml')]);

    const dialogs = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('[role="alertdialog"]')];
    expect(dialogs()).toHaveLength(1);
    for (const expected of ['x.yaml', 'X 新', 'tx']) expect(textOf(dialogs()[0] ?? container)).toContain(expected);
    expect(answers).toEqual({});

    await click(getButton(container, '上書きする'));
    expect(answers).toEqual({ 'x.yaml': true });
    expect(dialogs()).toHaveLength(1);
    for (const expected of ['y.yaml', 'Y 新', 'ty']) expect(textOf(dialogs()[0] ?? container)).toContain(expected);

    await click(getButton(container, '上書きしない'));
    expect(answers).toEqual({ 'x.yaml': true, 'y.yaml': false });
    expect(dialogs()).toHaveLength(0);
  });
});

describe('取り込みの状態の保持', () => {
  it('R-PANEL-75: 取り込みの進行と結果は画面が変わっても失われず、一覧に戻ったときに示す', async () => {
    const deps = makeDeps(makeView({ catalog: [importedEntry] }));
    let finish: (results: ImportResult[]) => void = () => undefined;
    deps.importFiles = () =>
      new Promise<ImportResult[]>((resolve) => {
        finish = resolve;
      });
    const { container } = await mount(<App deps={deps} />);
    await flush();
    await pick(container, [file('bad.zip')]);
    expect(textOf(container)).toContain('取り込み中');

    await emitView(deps, runningWithCatalog());
    expect(container.querySelector('.screen-running')).not.toBeNull();
    await act(async () => {
      finish([{ status: 'rejected', fileName: 'bad.zip', errors: [{ file: 'tour.yaml', line: null, path: '', message: '拒否の理由です' }] }]);
      await Promise.resolve();
    });
    await flush();
    await emitView(deps, makeView({ catalog: [importedEntry] }));

    expect(container.querySelector('.screen-list')).not.toBeNull();
    expect(textOf(container)).not.toContain('取り込み中');
    expect(textOf(container)).toContain('bad.zip');
    expect(textOf(container)).toContain('拒否の理由です');
  });

  it('R-PANEL-76: 取り込みが続いている間に一覧へ戻ると、取り込み中であることを示す', async () => {
    const deps = makeDeps(makeView({ catalog: [importedEntry] }));
    deps.importFiles = () => new Promise<ImportResult[]>(() => undefined);
    const { container } = await mount(<App deps={deps} />);
    await flush();
    await pick(container, [file('a.zip')]);
    await emitView(deps, runningWithCatalog());
    await emitView(deps, makeView({ catalog: [importedEntry] }));
    expect(textOf(container)).toContain('取り込み中です');
  });
});

describe('実行中・一時中断中の一覧と設定', () => {
  it('R-PANEL-77: 実行中の画面から一覧へ移ると、取り込み・削除・再読み込みはあり、開始のボタンは無く、実行中の画面へ戻れる', async () => {
    const { container } = await open(runningWithCatalog());
    await click(getButton(container, 'ツアーの一覧'));
    expect(container.querySelector('h1')?.textContent).toBe('ツアー一覧');
    expect(findButton(container, 'ファイルを選ぶ')).not.toBeNull();
    expect(findButton(container, '再読み込み')).not.toBeNull();
    expect(findButton(container, '削除')).not.toBeNull();
    expect(findButton(container, '設定')).not.toBeNull();
    expect(findButton(container, '最初から')).toBeNull();
    expect(findButton(container, '続きから')).toBeNull();
    await click(getButton(container, '実行中の画面へ戻る'));
    expect(container.querySelector('.screen-running')).not.toBeNull();
  });

  it('R-PANEL-78: 一時中断中の画面からも、一覧と設定へ移れ、戻れる', async () => {
    const { container } = await open(runningWithCatalog({ status: 'paused', pauseReason: 'user', tabStatus: null }));
    await click(getButton(container, 'ツアーの一覧'));
    expect(findButton(container, 'ファイルを選ぶ')).not.toBeNull();
    expect(findButton(container, '最初から')).toBeNull();
    await click(getButton(container, '一時中断中の画面へ戻る'));
    expect(container.querySelector('.screen-paused')).not.toBeNull();
    await click(getButton(container, '設定'));
    expect(container.querySelector('h1')?.textContent).toBe('設定');
    await click(getButton(container, '一時中断中の画面へ戻る'));
    expect(container.querySelector('.screen-paused')).not.toBeNull();
  });

  it('R-PANEL-79: 実行中の画面から設定へ移り、実行中の画面へ戻れる', async () => {
    const deps = makeDeps(runningWithCatalog());
    deps.respond = () => ({ entries: [] });
    const { container } = await mount(<App deps={deps} />);
    await flush(10);
    await click(getButton(container, '設定'));
    expect(container.querySelector('h1')?.textContent).toBe('設定');
    await click(getButton(container, '実行中の画面へ戻る'));
    expect(container.querySelector('.screen-running')).not.toBeNull();
  });

  it('R-PANEL-80: 実行中に一覧から取り込むと、実行中のツアーの ID を取り込みへ渡す', async () => {
    const deps = makeDeps(runningWithCatalog());
    const seen: (string | null)[] = [];
    deps.importFiles = (_files, hooks) => {
      return Promise.resolve(hooks.getRunningTourId()).then((id) => {
        seen.push(id);
        return [];
      });
    };
    const { container } = await mount(<App deps={deps} />);
    await flush(10);
    await click(getButton(container, 'ツアーの一覧'));
    await pick(container, [file('a.yaml')]);
    expect(seen).toEqual(['demo']);
  });

  it('R-PANEL-81: 実行中のツアーを一覧から削除する確認には、実行中であることと終了することを示す', async () => {
    const { deps, container } = await open(runningWithCatalog());
    await click(getButton(container, 'ツアーの一覧'));
    await click(getButton(container, '削除'));
    const dialog = container.querySelector('[role="alertdialog"]');
    expect(textOf(dialog ?? container)).toContain('このツアーは実行中です');
    expect(textOf(dialog ?? container)).toContain('終了');
    await click(getButton(container, '削除する'));
    expect(deps.sent.filter((m) => m.type === 'REMOVE')).toEqual([{ type: 'REMOVE', tourId: 'demo' }]);
  });

  it('R-PANEL-82: 実行中でないツアーの削除の確認には、実行中の一文を出さない', async () => {
    const { container } = await open(makeView({ catalog: [importedEntry] }));
    await click(getButton(container, '削除'));
    expect(textOf(container.querySelector('[role="alertdialog"]') ?? container)).not.toContain('実行中');
  });

  it('R-PANEL-83: 一覧を開いている間にツアーが一時中断になったら、一時中断中の画面を出す', async () => {
    const { deps, container } = await open(runningWithCatalog());
    await click(getButton(container, 'ツアーの一覧'));
    await emitView(deps, runningWithCatalog({ status: 'paused', pauseReason: 'overwritten', tabStatus: null }));
    expect(container.querySelector('.screen-paused')).not.toBeNull();
    expect(buttons(container).map(buttonName)).toContain('新版で続きから');
  });

  it('R-PANEL-85: 上書きの確認を出している間にそのツアーが実行中になったら、実行中の一文を出す', async () => {
    const deps = makeDeps(makeView({ catalog: [importedEntry] }));
    deps.importFiles = (_files, hooks) =>
      hooks.confirmOverwrite(overwrite('a.yaml', 'demo', '新しい demo')).then(() => []);
    const { container } = await mount(<App deps={deps} />);
    await flush();
    await pick(container, [file('a.yaml')]);
    const dialogText = (): string => textOf(container.querySelector('[role="alertdialog"]') ?? container);
    expect(dialogText()).not.toContain('このツアーは実行中です');
    await emitView(deps, runningWithCatalog());
    expect(dialogText()).toContain('このツアーは実行中です。上書きすると、一時中断になります');
  });

  it('R-PANEL-86: 取り込みが続いていないときに新しく取り込むと前の結果は消え、続いている間に重ねた取り込みの結果は貯まる', async () => {
    const deps = makeDeps(makeView());
    const finishers: Record<string, () => void> = {};
    deps.importFiles = (files) =>
      new Promise<ImportResult[]>((resolve) => {
        const name = files[0]?.name ?? '';
        finishers[name] = () => {
          resolve([{ status: 'rejected', fileName: name, errors: [{ file: name, line: null, path: '', message: '理由' }] }]);
        };
      });
    const { container } = await mount(<App deps={deps} />);
    await flush();
    const done = async (name: string): Promise<void> => {
      await act(async () => {
        finishers[name]?.();
        await Promise.resolve();
      });
      await flush();
    };

    await pick(container, [file('first.zip')]);
    await done('first.zip');
    expect(textOf(container)).toContain('first.zip');
    await pick(container, [file('second.zip')]);
    expect(textOf(container)).not.toContain('first.zip');
    await pick(container, [file('third.zip')]);
    await done('second.zip');
    await done('third.zip');
    expect(textOf(container)).toContain('second.zip');
    expect(textOf(container)).toContain('third.zip');
  });
});
