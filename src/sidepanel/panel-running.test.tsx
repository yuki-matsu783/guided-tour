// @vitest-environment jsdom
/**
 * 実行中の画面のテスト（R-PANEL-20〜34）。説明文・補足画像・完了の目安・タブの操作・移動・中断・フォーカス。
 * 同梱ツアーの内容は偽の `fetchText` が返す YAML、取り込みの内容は偽の保存領域が返す。
 */
import { act } from 'react';
import { stringify } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.tsx';
import type { FakeDeps } from './test-support.tsx';
import {
  click,
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

afterEach(async () => {
  await unmountAll();
});

const BUNDLED_YAML = stringify({
  schemaVersion: 3,
  id: 'demo',
  name: 'デモツアー',
  origins: ['https://example.com'],
  tabs: { main: { label: 'メイン', open: 'https://example.com/start' } },
  steps: [
    {
      id: 's1',
      title: '最初のステップ',
      url: { origin: 'https://example.com' },
      body: '## 小見出し\n\n本文 **強調** <b>タグ</b>',
      target: { role: 'button', name: ['保存'] },
      done: {
        type: 'element',
        target: { role: 'alert', name: ['完了'] },
        hint: '保存を押してください',
        doneHint: '保存できました',
      },
    },
    { id: 's2', title: '次のステップ', kind: 'guide', body: '外で行います' },
    { id: 's3', title: '最後のステップ', url: { origin: 'https://example.com' } },
  ],
});

function withBundled(deps: FakeDeps): FakeDeps {
  deps.texts.set('chrome-extension://test/tours/demo/tour.yaml', BUNDLED_YAML);
  return deps;
}

async function openRunning(view = runningView()): Promise<{ deps: FakeDeps; container: HTMLElement }> {
  const deps = withBundled(makeDeps(view));
  const { container } = await mount(<App deps={deps} />);
  await flush(10);
  return { deps, container };
}

function lastOp(deps: FakeDeps, type: string): Record<string, unknown> | undefined {
  const found = deps.sent.findLast((m) => m.type === type);
  return found === undefined ? undefined : { ...found };
}

describe('表示', () => {
  it('R-PANEL-20: n/N・ツアー名・出所・見出しを出し、全ステップを前・現在・後で区別する', async () => {
    const { container } = await openRunning(runningView({ stepIndex: 1 }));
    expect(container.querySelector('h1')?.textContent).toBe('デモツアー');
    expect(textOf(container)).toContain('2/3');
    expect(textOf(container)).toContain('同梱');
    expect(container.querySelector('.step-body h2')?.textContent).toBe('次のステップ');
    const marks = [...container.querySelectorAll('.step-list li')].map((li) => li.querySelector('.step-mark')?.textContent);
    expect(marks).toEqual(['前', '現在', '後']);
    const current = container.querySelector('[aria-current="step"]');
    expect(current?.textContent).toContain('次のステップ');
    // 各行がボタン
    expect(container.querySelectorAll('.step-list li > button')).toHaveLength(3);
  });

  it('R-PANEL-21: 案内だけの手順では「ブラウザの外などで行う手順です」を示し、ページの操作とタブの操作を出さない', async () => {
    const { container } = await openRunning(runningView({ stepIndex: 1, tabStatus: null }));
    expect(textOf(container)).toContain('ブラウザの外などで行う手順です');
    expect(textOf(container)).toContain('外で行います');
    expect(findButton(container, '対象を表示')).toBeNull();
    expect(findButton(container, '再確認')).toBeNull();
    expect(findButton(container, '表示を消す')).toBeNull();
    expect(container.querySelector('.tab-controls')).toBeNull();
    expect(findButton(container, '次へ')).not.toBeNull();
  });

  it('R-PANEL-22: 説明文を Markdown で描き、HTML はタグも含めて文字列のまま出す', async () => {
    const { container } = await openRunning();
    const md = container.querySelector('.markdown');
    expect(md?.querySelector('h3')?.textContent).toBe('小見出し');
    expect(md?.querySelector('strong')?.textContent).toBe('強調');
    expect(md?.querySelector('b')).toBeNull();
    expect(textOf(md ?? container)).toContain('<b>タグ</b>');
  });

  it('R-PANEL-23: 完了の目安を、まだ・満たした・確認を停止中・確認できない、で出し分ける', async () => {
    const hints = [
      [{ met: false, unsupported: false, stopped: false }, '保存を押してください'],
      [{ met: true, unsupported: false, stopped: false }, '次へ進めます'],
      [{ met: false, unsupported: false, stopped: true }, '確認を停止中'],
      [{ met: false, unsupported: true, stopped: false }, 'この項目は確認できません'],
    ] as const;
    for (const [hint, expected] of hints) {
      const { container } = await openRunning(runningView({ hint }));
      expect(container.querySelector('.hint')?.textContent).toContain(expected);
      await unmountAll();
    }
    const { container } = await openRunning(runningView({ hint: { met: true, unsupported: false, stopped: false } }));
    expect(container.querySelector('.hint')?.textContent).toContain('保存できました');
  });

  it('R-PANEL-24: 保存の失敗を、操作を続けられる形で出し続ける', async () => {
    const { container } = await openRunning(runningView({ saveError: true }));
    expect(textOf(container)).toContain('保存されていません。再起動すると前の位置に戻る可能性があります');
    expect(getButton(container, '次へ').disabled).toBe(false);
  });

  it('R-PANEL-25: 一時中断と終了の違いを、画面上で説明する', async () => {
    const { container } = await openRunning();
    const text = container.querySelector('.explain')?.textContent ?? '';
    expect(text).toContain('一時中断');
    expect(text).toContain('進捗は残る');
    expect(text).toContain('終了');
    expect(text).toContain('進捗を破棄');
  });

  it('R-PANEL-26: 取り込みのツアーの説明文と補足画像を、保存した Blob から表示し、画像が無ければ代替文を出す', async () => {
    const deps = makeDeps(
      runningView({
        tour: { id: 'imp', name: '取り込み', hash: 'h9', origins: ['https://example.com'], source: 'imported' },
        steps: [{ id: 'a', title: '手順', kind: 'page' }],
      }),
    );
    deps.readTourRecord = () =>
      Promise.resolve({
        id: 'imp',
        hash: 'h9',
        compiled: {
          schemaVersion: 3,
          id: 'imp',
          name: '取り込み',
          origins: ['https://example.com'],
          steps: [
            {
              id: 'a',
              title: '手順',
              kind: 'page',
              tab: 'main',
              bodyFile: 'steps/a.md',
              media: { src: 'img/pic.png', alt: '補足の図' },
            },
          ],
        },
        yamlText: '',
        fileName: 'x.zip',
        importedAt: 0,
        totalBytes: 0,
      });
    deps.files.set('imp/h9/steps/a.md', new Blob(['![本文の図](../img/pic.png)\n\n![無い図](../img/none.png)']));
    deps.files.set('imp/h9/img/pic.png', new Blob(['png']));
    let n = 0;
    deps.createObjectUrl = () => `blob:fake-${String(++n)}`;
    const { container } = await mount(<App deps={deps} />);
    await flush(15);

    const srcs = [...container.querySelectorAll('img')].map((i) => [i.alt, i.getAttribute('src')]);
    expect(srcs).toContainEqual(['本文の図', 'blob:fake-1']);
    // 補足画像は同じ画像なので、同じ URL を使い回す
    expect(srcs).toContainEqual(['補足の図', 'blob:fake-1']);
    expect(n).toBe(1);
    expect(container.querySelector('.markdown')?.textContent).toContain('無い図');
  });
});

describe('移動と操作', () => {
  it('R-PANEL-27: 「次へ」「戻る」「全ステップの一覧」は、sessionId・gen・新しい opId つきの GOTO を送り、最初では「戻る」が無効', async () => {
    const { deps, container } = await openRunning();
    expect(getButton(container, '戻る').disabled).toBe(true);
    await click(getButton(container, '次へ'));
    const next = lastOp(deps, 'GOTO');
    expect(next).toMatchObject({ to: 1, sessionId: 'session-1', gen: 3 });
    await click(getButton(container, '3. 最後のステップ'));
    const jump = lastOp(deps, 'GOTO');
    expect(jump).toMatchObject({ to: 2 });
    expect(jump?.opId).not.toBe(next?.opId);
  });

  it('R-PANEL-28: 最終ステップでは「次へ」の代わりに「完了」を出し、完了すると「完了しました」を出す', async () => {
    const { deps, container } = await openRunning(runningView({ stepIndex: 2 }));
    expect(findButton(container, '次へ')).toBeNull();
    await click(getButton(container, '完了'));
    expect(lastOp(deps, 'GOTO')).toMatchObject({ to: 3 });
    deps.state.view = makeView({ status: 'ended' });
    act(() => {
      deps.emit({ type: 'TOUR_STATE_CHANGED', view: makeView({ status: 'ended' }) });
    });
    await wait(150);
    expect(container.querySelector('.flash strong')?.textContent).toBe('完了しました');
  });

  it('R-PANEL-29: 一時中断・終了・再確認・表示を消す／戻す・対象を表示・タブへ移動 を、識別子つきで送る', async () => {
    const { deps, container } = await openRunning(
      runningView({ tabStatus: { role: 'main', status: 'ok', candidates: [], attended: false, selected: false } }),
    );
    await click(getButton(container, '一時中断'));
    expect(lastOp(deps, 'PAUSE')).toMatchObject({ sessionId: 'session-1' });
    await click(getButton(container, '再確認'));
    expect(lastOp(deps, 'RECHECK')).toMatchObject({ sessionId: 'session-1', gen: 3 });
    await click(getButton(container, '対象を表示'));
    expect(lastOp(deps, 'SCROLL_TO_TARGET')).toMatchObject({ gen: 3 });
    await click(getButton(container, '表示を消す'));
    expect(lastOp(deps, 'SET_OVERLAY')).toMatchObject({ hidden: true, sessionId: 'session-1' });
    await click(getButton(container, '「メイン」のタブへ移動'));
    expect(lastOp(deps, 'FOCUS_ROLE')).toMatchObject({ gen: 3 });
    await click(getButton(container, '終了'));
    expect(lastOp(deps, 'STOP')).toMatchObject({ sessionId: 'session-1' });
  });

  it('R-PANEL-30: 表示を消している間は「表示を戻す」を出し、押すと hidden: false を送る', async () => {
    const { deps, container } = await openRunning(runningView({ overlayHidden: true }));
    expect(findButton(container, '表示を消す')).toBeNull();
    await click(getButton(container, '表示を戻す'));
    expect(lastOp(deps, 'SET_OVERLAY')).toMatchObject({ hidden: false });
  });

  it('R-PANEL-31: ページに表示できないときは「このページでは表示できません」を示し、「再確認」を押せる', async () => {
    const { deps, container } = await openRunning(
      runningView({ tabStatus: { role: 'main', status: 'unsupported', candidates: [], attended: true, selected: true } }),
    );
    expect(textOf(container)).toContain('このページでは表示できません');
    await click(getButton(container, '再確認'));
    expect(lastOp(deps, 'RECHECK')).toBeDefined();
  });

  it('R-PANEL-32: 役割のタブが無いときは、既存タブの選択・「今のタブで開く」・「新しいタブで開く」を出し、付け替えは確認してから強制で送る', async () => {
    const view = runningView({
      tabStatus: {
        role: 'main',
        status: 'missing',
        candidates: [
          { tabId: 5, title: '別のタブ', windowId: 1, boundRole: 'other' },
          { tabId: 11, title: '見ているタブ', windowId: 1, boundRole: null },
        ],
        attended: false,
        selected: false,
      },
    });
    const deps = withBundled(makeDeps(view));
    deps.getActiveTabId = () => Promise.resolve(11);
    const { container } = await mount(<App deps={deps} />);
    await flush(10);

    const labels = [...container.querySelectorAll('.candidates button')].map((b) => b.textContent);
    expect(labels).toEqual(['このタブを「メイン」として使う', '「別のタブ」を「メイン」として使う']);
    await click(getButton(container, '今のタブで開く'));
    expect(lastOp(deps, 'OPEN_IN')).toMatchObject({ mode: 'current', gen: 3 });
    await click(getButton(container, '新しいタブで開く'));
    expect(lastOp(deps, 'OPEN_IN')).toMatchObject({ mode: 'new' });

    await click(getButton(container, 'このタブを「メイン」として使う'));
    expect(lastOp(deps, 'BIND_TAB')).toMatchObject({ tabId: 11, force: false });

    deps.respond = (m) => (m.type === 'BIND_TAB' && !m.force ? { status: 'confirmBind', boundRole: 'other' } : { status: 'done' });
    await click(getButton(container, '「別のタブ」を「メイン」として使う'));
    expect(textOf(container.querySelector('[role="alertdialog"]') ?? container)).toContain('「other」');
    await click(getButton(container, '付け替える'));
    expect(lastOp(deps, 'BIND_TAB')).toMatchObject({ tabId: 5, force: true });
  });

  it('R-PANEL-33: 古い表示からの操作が取り消されたら、そう伝えて写しを取り直す', async () => {
    const { deps, container } = await openRunning();
    deps.respond = () => ({ status: 'discarded', reason: 'staleGen' });
    const before = deps.sent.filter((m) => m.type === 'GET_STATE').length;
    await click(getButton(container, '次へ'));
    expect(textOf(container)).toContain('古い表示からの操作');
    expect(deps.sent.filter((m) => m.type === 'GET_STATE').length).toBe(before + 1);
  });
});

describe('フォーカス', () => {
  it('R-PANEL-34: 描き直しでフォーカスが失われたら、直前に操作した部品へ戻し、その部品が無ければ画面の見出しへ移す', async () => {
    const { deps, container } = await openRunning();
    const next = getButton(container, '次へ');
    next.focus();
    await click(next);
    // フォーカスが外れた状態で描き直されても、直前の部品に戻る
    next.blur();
    expect(document.activeElement).toBe(document.body);
    act(() => {
      deps.emit({ type: 'TOUR_STATE_CHANGED', view: runningView({ stepIndex: 1, tabStatus: null }) });
    });
    await wait(150);
    expect(document.activeElement?.getAttribute('data-focus-id')).toBe('next');

    // 画面が替わり、操作した部品が無いときは見出しへ
    act(() => {
      deps.emit({ type: 'TOUR_STATE_CHANGED', view: makeView() });
    });
    await wait(150);
    // 一覧には「次へ」が無いので、見出しへ移る
    expect(document.activeElement).toBe(container.querySelector('h1'));
  });
});

describe('古い操作', () => {
  it('R-PANEL-35: 表示中の sessionId・gen が変わったら、新しい値を付けて送る', async () => {
    const { deps, container } = await openRunning();
    const next = runningView({ stepIndex: 1, tabStatus: null });
    deps.state.view = next;
    act(() => {
      deps.emit({ type: 'TOUR_STATE_CHANGED', view: { ...next, gen: 7 } });
    });
    await wait(150);
    await click(getButton(container, '次へ'));
    expect(lastOp(deps, 'GOTO')).toMatchObject({ gen: 7, to: 2 });
    vi.clearAllMocks();
  });
});
