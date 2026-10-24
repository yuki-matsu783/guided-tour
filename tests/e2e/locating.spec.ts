/**
 * 誤った案内の防止（AC-46〜57）の E2E。操作対象がちょうど1つに決まらないとき、必須の照合に合わないとき、
 * 読み替え先が不適格なときはハイライトを出さず、ハイライト中にページが変わったときは枠をすぐに消す。
 * ページは support/pages/locating-pages.ts。
 */
import type { Page } from '@playwright/test';
import { z } from 'zod';
import { test, expect, ownUi, importTour, beginTour } from './support/fixtures.ts';
import type { Fixtures } from './support/fixtures.ts';
import { expectMiniGuideStep, sleep } from './support/flows.ts';
import type { OwnUi, UiRect } from './support/own-ui.ts';
import type { SidePanel } from './support/panel.ts';
import type { TestServer } from './support/server.ts';
import { tourOn } from './support/tour.ts';
import type { StepSpec } from './support/tour.ts';

/** ページの `window` にあるテスト用の関数を呼ぶ。 */
async function callPageFn(tab: Page, name: string, ...args: number[]): Promise<void> {
  await tab.evaluate(
    ({ name, args }) => {
      const fn: unknown = Reflect.get(window, name);
      if (typeof fn === 'function') Reflect.apply(fn, window, args);
    },
    { name, args },
  );
}

/** 移動の操作は、新しい表示が届いてから 500 ミリ秒の間は受け付けられない（製品の仕様）。その分を待つ。 */
const MOVE_WAIT_MS = 600;

const FALLBACK = '文章だけの案内です';

interface Env {
  server: TestServer;
  openTab: Fixtures['openTab'];
  openPanel: Fixtures['openPanel'];
}

interface Running {
  tab: Page;
  panel: SidePanel;
  ui: OwnUi;
}

function step(target: Record<string, unknown>, id = 'only'): StepSpec {
  return { id, title: '対象を確認する', body: '対象の説明です。', target: { ...target, fallbackText: FALLBACK } };
}

/** `path` のページで、`steps` のツアーを開始し、ミニガイドが出るまで待つ。 */
async function startOn(env: Env, path: string, steps: StepSpec[]): Promise<Running> {
  const tab = await env.openTab(env.server.url(path));
  const panel = await env.openPanel();
  const tour = tourOn(env.server.origin, { exact: path }, steps);
  await importTour(panel, tour);
  await beginTour(panel, tour.name, tab);
  const ui = ownUi(tab);
  await expectMiniGuideStep(ui, `1/${String(steps.length)}`);
  return { tab, panel, ui };
}

async function frameOf(ui: OwnUi): Promise<UiRect | null> {
  return (await ui.overlay())?.frame ?? null;
}

/** 対象が決まらず、文章だけの案内になり、ハイライトが出ていない。 */
async function expectTextOnly(ui: OwnUi): Promise<void> {
  await expect.poll(async () => (await ui.miniGuide())?.fallback ?? '', { timeout: 20_000 }).toContain(FALLBACK);
  expect(await frameOf(ui)).toBeNull();
}

async function expectHighlight(ui: OwnUi, tab: Page, selector: string): Promise<void> {
  await expect.poll(() => frameOf(ui), { timeout: 15_000 }).not.toBeNull();
  const frame = await frameOf(ui);
  const box = await tab.locator(selector).boundingBox();
  if (frame === null || box === null) throw new Error('枠か要素の位置を取れなかった');
  // 枠は要素より少し外へ広がる
  expect(frame.x).toBeLessThanOrEqual(box.x + 1);
  expect(frame.y).toBeLessThanOrEqual(box.y + 1);
  expect(frame.x + frame.width).toBeGreaterThanOrEqual(box.x + box.width - 1);
  expect(frame.y + frame.height).toBeGreaterThanOrEqual(box.y + box.height - 1);
  expect(frame.width).toBeLessThanOrEqual(box.width + 24);
  expect(frame.height).toBeLessThanOrEqual(box.height + 24);
}

async function expectFrameGone(ui: OwnUi): Promise<void> {
  await expect.poll(() => frameOf(ui), { timeout: 5000 }).toBeNull();
}

const DiagnosticsSchema = z.object({ entries: z.array(z.object({ stepId: z.string(), reason: z.string() })) });

/** 保守記録の理由の一覧（ステップ ID つき）。サイドパネルから `GET_DIAGNOSTICS` を送って読む。 */
async function diagnosticReasons(panel: SidePanel): Promise<string[]> {
  const raw: unknown = await panel.page.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_DIAGNOSTICS' }));
  return DiagnosticsSchema.parse(raw).entries.map((e) => `${e.stepId}:${e.reason}`);
}

/** 終了して設定の画面を開き、保守記録に `label` の理由が出ていることを確かめる。 */
async function expectSettingsDiagnostic(panel: SidePanel, label: string): Promise<void> {
  await panel.stop();
  await panel.openSettings();
  await expect(panel.page.locator('.diagnostics')).toContainText(label);
}

test('E-46: 最終候補が2件の手がかりは採用されず、他の段階でも決まらなければ文章だけの案内になる（別の段階が1件なら、そちらで特定する）', async ({ server, openTab, openPanel }) => {
  const { ui, panel, tab } = await startOn({ server, openTab, openPanel }, '/loc/ambiguous', [
    step({ role: 'button', name: ['削除'], text: ['削除'] }, 'a'),
    step({ role: 'button', name: ['削除'], css: ['[data-final=yes]'] }, 'b'),
  ]);
  // 段階2（役割と名前）は2件で不採用。段階4（表示文字列）も2件。ハイライトは出ない
  await expectTextOnly(ui);
  expect((await ui.miniGuide())?.fallback).toContain(FALLBACK);

  // 段階2が決まらなくても、段階5が1件に決まればそちらで特定する
  await sleep(MOVE_WAIT_MS);
  await panel.next();
  await expectMiniGuideStep(ui, '2/2');
  await expectHighlight(ui, tab, '#only-link');
});

test('E-47: 同じ名前のボタン2つが同じ祖先に読み替えられても、操作対象が1つに決まらないので採用しない', async ({ server, openTab, openPanel }) => {
  const { ui } = await startOn({ server, openTab, openPanel }, '/loc/same-ancestor', [
    step({ role: 'button', name: ['編集'], highlight: { closest: '.row' } }),
  ]);
  await expectTextOnly(ui);
});

test('E-48: ID は一致しても、役割が必須の照合と違う要素はハイライトせず、保守記録に「矛盾」が残る', async ({ server, openTab, openPanel }) => {
  const { ui, panel } = await startOn({ server, openTab, openPanel }, '/loc/guard-role', [
    step({ tourId: 'g-target', require: { role: 'button' } }),
  ]);
  await expectTextOnly(ui);
  await expect.poll(() => diagnosticReasons(panel)).toContain('only:conflict');
  await expectSettingsDiagnostic(panel, '矛盾');
});

test('E-48: ID は一致しても、所属する領域が必須の照合と違う要素はハイライトせず、保守記録に「矛盾」が残る', async ({ server, openTab, openPanel }) => {
  const { ui, panel } = await startOn({ server, openTab, openPanel }, '/loc/guard-region', [
    step({ tourId: 'g-target', require: { region: 'main' } }),
  ]);
  await expectTextOnly(ui);
  await expect.poll(() => diagnosticReasons(panel)).toContain('only:conflict');
  await expectSettingsDiagnostic(panel, '矛盾');
});

test('E-49: 必須の照合に名前を指定したとき、ID は一致しても名前が違う要素はハイライトしない', async ({ server, openTab, openPanel }) => {
  const { ui } = await startOn({ server, openTab, openPanel }, '/loc/guard-name', [
    step({ tourId: 'g-target', require: { name: ['保存'] } }),
  ]);
  await expectTextOnly(ui);
});

test('E-50: 探す範囲（within）が複数の要素に一致するとき、範囲をページ全体に広げず、範囲外の要素をハイライトしない', async ({ server, openTab, openPanel }) => {
  const { ui } = await startOn({ server, openTab, openPanel }, '/loc/within', [
    step({ role: 'button', name: ['保存'], within: { role: 'region', name: ['設定'] } }),
  ]);
  // ページ全体では「保存」は1つだけある。範囲を広げていれば、それがハイライトされる
  await expectTextOnly(ui);
});

test('E-51: 読み替え先が body になる指定は採用しない', async ({ server, openTab, openPanel }) => {
  const { ui } = await startOn({ server, openTab, openPanel }, '/loc/body-closest', [
    step({ tourId: 'b-target', highlight: { closest: 'body' } }),
  ]);
  await expectTextOnly(ui);
});

test('E-51: 表示領域より長いフォームへの読み替えは採用する', async ({ server, openTab, openPanel }) => {
  const { ui } = await startOn({ server, openTab, openPanel }, '/loc/long-form', [
    step({ tourId: 'b-target', highlight: { closest: 'form' } }),
  ]);
  await expect.poll(() => frameOf(ui), { timeout: 15_000 }).not.toBeNull();
  expect((await ui.miniGuide())?.fallback ?? '').toBe('');
});

test('E-52: display: contents の祖先を持つ要素は、表示されている要素として特定されハイライトされる', async ({ server, openTab, openPanel }) => {
  const { ui, tab } = await startOn({ server, openTab, openPanel }, '/loc/contents', [step({ tourId: 'h-target' })]);
  await expectHighlight(ui, tab, '[data-tour-id=h-target]');
});

test('E-53: ハイライト中にページの再描画で対象要素が入れ替わると、古い枠がすぐに消え、新しい要素に枠が付き、スクロールしない', async ({ server, openTab, openPanel }) => {
  const { ui, tab } = await startOn({ server, openTab, openPanel }, '/loc/swap', [step({ tourId: 'e-target' })]);
  await expectHighlight(ui, tab, '[data-tour-id=e-target]');
  const scrollBefore = await tab.evaluate(() => window.scrollY);

  // 古い要素が消えて、しばらく対象が無い間は、枠が残らない
  await callPageFn(tab, 'removeNow');
  await expectFrameGone(ui);

  // 入れ替えた新しい要素（位置が違う）に枠が付く
  await callPageFn(tab, 'swapNow', 120);
  await expectHighlight(ui, tab, '[data-tour-id=e-target]');
  const frame = await frameOf(ui);
  expect(frame?.y ?? 0).toBeGreaterThan(100);

  // 続けて同じ瞬間に入れ替えても、新しい要素に追従する
  await callPageFn(tab, 'swapNow', 260);
  await expect
    .poll(async () => (await frameOf(ui))?.y ?? 0, { timeout: 5000 })
    .toBeGreaterThan(240);
  expect(await tab.evaluate(() => window.scrollY)).toBe(scrollBefore);
});

const MUTABLE_TARGET = { tourId: 'f-target', require: { role: 'button', region: 'main' } };

test('E-54: ハイライト中に対象の役割を変えて必須の照合を満たさなくすると、古い枠がすぐに消える', async ({ server, openTab, openPanel }) => {
  const { ui, tab } = await startOn({ server, openTab, openPanel }, '/loc/mutable', [step(MUTABLE_TARGET)]);
  await expectHighlight(ui, tab, '[data-tour-id=f-target]');
  await tab.evaluate(() => {
    document.querySelector('[data-tour-id=f-target]')?.setAttribute('role', 'link');
  });
  await expectFrameGone(ui);
});

test('E-54: ハイライト中に対象の所属する領域を変えて必須の照合を満たさなくすると、古い枠がすぐに消える', async ({ server, openTab, openPanel }) => {
  const { ui, tab } = await startOn({ server, openTab, openPanel }, '/loc/mutable', [step(MUTABLE_TARGET)]);
  await expectHighlight(ui, tab, '[data-tour-id=f-target]');
  await tab.evaluate(() => {
    const el = document.querySelector('[data-tour-id=f-target]');
    if (el !== null) document.getElementById('side')?.appendChild(el);
  });
  await expectFrameGone(ui);
});

test('E-55: ハイライト中に同じ条件に合う候補をもう1つ追加すると、一意でなくなり枠が消える', async ({ server, openTab, openPanel }) => {
  const { ui, tab } = await startOn({ server, openTab, openPanel }, '/loc/mutable', [step({ tourId: 'f-target' })]);
  await expectHighlight(ui, tab, '[data-tour-id=f-target]');
  await tab.evaluate(() => {
    const extra = document.createElement('button');
    extra.type = 'button';
    extra.setAttribute('data-tour-id', 'f-target');
    extra.textContent = '追加した候補';
    document.getElementById('m')?.appendChild(extra);
  });
  await expectFrameGone(ui);
});

test('E-56: ハイライト中に対象の祖先を透明にすると（opacity: 0）、枠が消える', async ({ server, openTab, openPanel }) => {
  const { ui, tab } = await startOn({ server, openTab, openPanel }, '/loc/mutable', [step({ tourId: 'f-target' })]);
  await expectHighlight(ui, tab, '[data-tour-id=f-target]');
  await tab.evaluate(() => {
    document.getElementById('m')?.style.setProperty('opacity', '0');
  });
  await expectFrameGone(ui);
});

test('E-56: ハイライト中に対象の祖先を非表示にすると（visibility: hidden）、枠が消える', async ({ server, openTab, openPanel }) => {
  const { ui, tab } = await startOn({ server, openTab, openPanel }, '/loc/mutable', [step({ tourId: 'f-target' })]);
  await expectHighlight(ui, tab, '[data-tour-id=f-target]');
  await tab.evaluate(() => {
    document.getElementById('m')?.style.setProperty('visibility', 'hidden');
  });
  await expectFrameGone(ui);
});

test('E-57: ID で特定してハイライト中に名前だけが変わっても（必須の照合に名前なし）、枠は残り、保守記録に「名前不一致」が残る', async ({ server, openTab, openPanel }) => {
  const { ui, tab, panel } = await startOn({ server, openTab, openPanel }, '/loc/mutable', [step({ tourId: 'f-target', name: ['対象ボタン'] })]);
  await expectHighlight(ui, tab, '[data-tour-id=f-target]');
  await tab.evaluate(() => {
    const el = document.querySelector('[data-tour-id=f-target]');
    if (el !== null) el.textContent = '名前を変えたボタン';
  });
  await expect.poll(() => diagnosticReasons(panel), { timeout: 15_000 }).toContain('only:nameMismatch');
  // 保守記録が残るまでの間も、そのあとも、枠は残っている
  await expectHighlight(ui, tab, '[data-tour-id=f-target]');
  await expectSettingsDiagnostic(panel, '名前不一致');
});
