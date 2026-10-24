// @vitest-environment jsdom
/**
 * 一時中断中・設定・確認の画面のテスト（R-PANEL-40〜52）。
 */
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App.tsx';
import type { FakeDeps } from './test-support.tsx';
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
} from './test-support.tsx';

afterEach(async () => {
  await unmountAll();
});

function pausedView(reason: 'user' | 'permission' | 'overwritten', over = {}): ReturnType<typeof runningView> {
  return runningView({ status: 'paused', pauseReason: reason, tabStatus: null, ...over });
}

async function open(view: ReturnType<typeof makeView>): Promise<{ deps: FakeDeps; container: HTMLElement }> {
  const deps = makeDeps(view);
  const { container } = await mount(<App deps={deps} />);
  await flush(10);
  return { deps, container };
}

const actionNames = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('.actions button')].map((b) => buttonName(b));

describe('一時中断中', () => {
  it('R-PANEL-40: 利用者の操作による中断では、再開・最初からやり直し・終了を出し、再開は権限を要求してから RESUME を送る', async () => {
    const { deps, container } = await open(pausedView('user'));
    expect(actionNames(container)).toEqual(['再開', '最初からやり直し', '終了']);
    expect(textOf(container)).toContain('進捗を破棄');
    await click(getButton(container, '再開'));
    expect(deps.request).toHaveBeenCalledWith({ origins: ['https://example.com/*'] });
    expect(deps.sent.findLast((m) => m.type === 'RESUME')).toMatchObject({ sessionId: 'session-1' });
    await click(getButton(container, '最初からやり直し'));
    expect(deps.sent.findLast((m) => m.type === 'RESTART')).toMatchObject({ sessionId: 'session-1' });
    await click(getButton(container, '終了'));
    expect(deps.sent.findLast((m) => m.type === 'STOP')).toMatchObject({ sessionId: 'session-1' });
  });

  it('R-PANEL-41: 許可の取り消しでは「再び許可して再開」と終了を出し、許可が得られなければ送らず必要なサイトを示す', async () => {
    const { deps, container } = await open(pausedView('permission'));
    expect(actionNames(container)).toEqual(['再び許可して再開', '終了']);
    expect(textOf(container)).toContain('必要なサイト: https://example.com');
    deps.request.mockResolvedValueOnce(false);
    await click(getButton(container, '再び許可して再開'));
    expect(deps.sent.some((m) => m.type === 'RESUME')).toBe(false);
    await click(getButton(container, '再び許可して再開'));
    expect(deps.sent.some((m) => m.type === 'RESUME')).toBe(true);
  });

  it('R-PANEL-42: 上書きによる中断では「新版で続きから」「新版で最初から」終了を出し、新版の origins の権限を要求してから RESUME_NEW を送る', async () => {
    const view = pausedView('overwritten', {
      catalog: [entry({ id: 'demo', origins: ['https://example.com', 'https://added.example'] })],
    });
    const { deps, container } = await open(view);
    expect(actionNames(container)).toEqual(['新版で続きから', '新版で最初から', '終了']);
    await click(getButton(container, '新版で続きから'));
    expect(deps.request).toHaveBeenLastCalledWith({
      origins: ['https://example.com/*', 'https://added.example/*'],
    });
    expect(deps.sent.findLast((m) => m.type === 'RESUME_NEW')).toMatchObject({ mode: 'continue' });
    await click(getButton(container, '新版で最初から'));
    expect(deps.sent.findLast((m) => m.type === 'RESUME_NEW')).toMatchObject({ mode: 'restart' });
  });

  it('R-PANEL-43: 新版でステップが無く最初から始めたときは、その旨を示す', async () => {
    const { container } = await open(runningView({ notice: 'restartedFromFirst', tabStatus: null }));
    expect(textOf(container)).toContain('ツアーが更新されたため最初から開始します');
  });

  it('R-PANEL-44: 実行中のツアーが削除されて終了したときは、その旨を一覧に示す', async () => {
    const { container } = await open(makeView({ status: 'ended', notice: 'tourRemoved' }));
    expect(textOf(container)).toContain('削除されたため、終了しました');
  });
});

describe('設定', () => {
  async function openSettings(
    over: Partial<ReturnType<typeof makeView>> = {},
    respond: FakeDeps['respond'] = () => ({ entries: [] }),
  ): Promise<{ deps: FakeDeps; container: HTMLElement }> {
    const deps = makeDeps(makeView({ catalog: [entry({ id: 'demo', name: 'デモツアー' })], ...over }));
    deps.respond = respond;
    const { container } = await mount(<App deps={deps} />);
    await flush(10);
    await click(getButton(container, '設定'));
    return { deps, container };
  }

  it('R-PANEL-45: ログレベル（エラー・警告・情報・詳細）を選べ、既定は警告で、変えると設定へ書く', async () => {
    const { deps, container } = await openSettings();
    const select = container.querySelector('select');
    if (select === null) throw new Error('select が無い');
    expect([...select.options].map((o) => o.textContent)).toEqual(['エラー', '警告', '情報', '詳細']);
    expect(select.value).toBe('warn');
    const written: string[] = [];
    deps.writeLogLevel = (level) => {
      written.push(level);
      return Promise.resolve(true);
    };
    act(() => {
      select.value = 'debug';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(written).toEqual(['debug']);
    expect(container.querySelector('select')?.value).toBe('debug');
  });

  it('R-PANEL-46: 「ミニガイドを表示しない」の切り替えで SET_UI を送る', async () => {
    const { deps, container } = await openSettings();
    const box = container.querySelector('input[type="checkbox"]');
    if (!(box instanceof HTMLInputElement)) throw new Error('チェックボックスが無い');
    expect(box.checked).toBe(false);
    await click(box);
    expect(deps.sent.findLast((m) => m.type === 'SET_UI')).toEqual({ type: 'SET_UI', enabled: false });
  });

  it('R-PANEL-47: 保守記録をツアー別・ステップ別に出す', async () => {
    const { container } = await openSettings({}, (m) =>
      m.type === 'GET_DIAGNOSTICS'
        ? {
            entries: [
              {
                tourId: 'demo',
                stepId: 'token',
                reason: 'degraded',
                tier: 3,
                topTier: 1,
                counts: [],
                total: 4,
                lastAt: 1,
              },
              {
                tourId: 'demo',
                stepId: 'save',
                reason: 'missing',
                tier: null,
                topTier: 1,
                counts: [],
                total: 2,
                lastAt: 2,
              },
            ],
          }
        : { status: 'done' },
    );
    const section = container.querySelector('.diag-tour');
    const text = textOf(section ?? container);
    expect(text).toContain('デモツアー');
    expect(text).toContain('ステップ token');
    expect(text).toContain('劣化');
    expect(text).toContain('ステップ save');
    expect(text).toContain('未検出');
    expect(text).toContain('累計 6 回');
  });

  it('R-PANEL-48: ログと保守記録をファイルとして書き出す', async () => {
    const { deps, container } = await openSettings({}, (m) =>
      m.type === 'EXPORT_LOGS' ? { logs: '{"a":1}\n', diagnostics: '[]' } : { entries: [] },
    );
    await click(getButton(container, 'ログと保守記録を書き出す'));
    expect(deps.saved.map((f) => f.name)).toEqual(['guided-tour-logs.jsonl', 'guided-tour-diagnostics.json']);
    expect(deps.saved[0]?.text).toBe('{"a":1}\n');
    expect(deps.saved[1]?.text).toBe('[]');
  });

  it('R-PANEL-49: 消去は確認のあとで CLEAR_LOGS を送り、保守記録を読み直す', async () => {
    const { deps, container } = await openSettings();
    const reads = (): number => deps.sent.filter((m) => m.type === 'GET_DIAGNOSTICS').length;
    const before = reads();
    await click(getButton(container, 'ログと保守記録を消去'));
    expect(deps.sent.some((m) => m.type === 'CLEAR_LOGS')).toBe(false);
    await click(getButton(container, 'やめる'));
    expect(deps.sent.some((m) => m.type === 'CLEAR_LOGS')).toBe(false);
    await click(getButton(container, 'ログと保守記録を消去'));
    await click(getButton(container, '消去する'));
    expect(deps.sent.some((m) => m.type === 'CLEAR_LOGS')).toBe(true);
    expect(reads()).toBe(before + 1);
  });
});

describe('確認の画面とキーボード', () => {
  async function openDialog(): Promise<{ container: HTMLElement; remove: HTMLButtonElement }> {
    const { container } = await open(makeView({ catalog: [entry({ id: 'b', name: '取り込み', source: 'imported' })] }));
    const remove = getButton(container, '削除');
    remove.focus();
    await click(remove);
    return { container, remove };
  }

  const press = (key: string, shiftKey = false): void => {
    act(() => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
    });
  };

  it('R-PANEL-50: 確認の画面はフォーカスを閉じ込める（Tab・Shift+Tab で端から端へ回る）', async () => {
    const { container } = await openDialog();
    const dialog = container.querySelector('[role="alertdialog"]');
    if (dialog === null) throw new Error('確認の画面が無い');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const [cancel, confirm] = buttons(dialog);
    expect(document.activeElement).toBe(cancel);
    press('Tab', true);
    expect(document.activeElement).toBe(confirm);
    press('Tab');
    expect(document.activeElement).toBe(cancel);
    // 背後は操作できない
    expect(container.querySelector('.app-main')?.hasAttribute('inert')).toBe(true);
  });

  it('R-PANEL-51: Escape で取り消し、閉じたら開く前の部品へフォーカスを戻す', async () => {
    const { container, remove } = await openDialog();
    press('Escape');
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement).toBe(remove);
    expect(container.querySelector('.app-main')?.hasAttribute('inert')).toBe(false);
  });

  it('R-PANEL-52: 操作の部品（data-focus-id を持つもの）はすべて標準の button で、タブ順から外れていない', async () => {
    const { container } = await open(runningView({ tabStatus: null }));
    const parts = [...container.querySelectorAll('[data-focus-id]')];
    expect(parts.length).toBeGreaterThan(5);
    for (const part of parts) {
      expect(part.tagName).toBe('BUTTON');
      expect(part instanceof HTMLElement && part.tabIndex >= 0).toBe(true);
    }
    expect(findButton(container, '次へ')).not.toBeNull();
  });
});
