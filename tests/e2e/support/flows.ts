/**
 * 複数の spec で使う、状態の待ち合わせと数え上げの補助。
 *
 * - `expectPanelStep(panel, 'n/N')`: サイドパネルのステップ表示が `n/N` になるのを待つ。
 * - `expectMiniGuideStep(ui, 'n/N')`: ページ上のミニガイドの表示が `n/N`（バーのときも番号）になるのを待つ。
 * - `expectNoOwnUi(ui)`: ページ上に拡張機能の表示（ホスト要素）が無いことを確かめる（出ないことを少し待って確かめる）。
 * - `tabCount(ext)`: 開いているタブの総数（サイドパネルのタブも含む）。「タブが増えない」の確認用。
 * - `hasProgress(ext, tourId)`: そのツアーの進捗（「続きから」の元）が保存されているか。
 * - `sleep(ms)`: 固定の待ち。「自動では進まない」のように、起きないことを確かめるときだけ使う。
 */
import { expect } from '@playwright/test';
import { z } from 'zod';
import type { Extension } from './launch.ts';
import type { OwnUi } from './own-ui.ts';
import type { SidePanel } from './panel.ts';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function expectPanelStep(panel: SidePanel, step: string): Promise<void> {
  await expect(panel.stepBadge()).toHaveText(step);
}

export async function expectMiniGuideStep(ui: OwnUi, step: string): Promise<void> {
  await expect.poll(async () => (await ui.miniGuide())?.step).toBe(step);
}

export async function expectNoOwnUi(ui: OwnUi, settleMs = 1500): Promise<void> {
  await expect.poll(() => ui.hostCount()).toBe(0);
  await sleep(settleMs);
  expect(await ui.hostCount()).toBe(0);
}

export async function hasProgress(ext: Extension, tourId: string): Promise<boolean> {
  const all = z.record(z.string(), z.unknown()).safeParse(await ext.storageLocal('progress'));
  return all.success && tourId in all.data;
}

export async function tabCount(ext: Extension): Promise<number> {
  const worker = await ext.worker();
  return worker.evaluate(async () => (await chrome.tabs.query({})).length);
}
