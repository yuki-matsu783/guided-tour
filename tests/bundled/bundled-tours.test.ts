/**
 * 同梱ツアー（public/tours）の検証テスト。
 * index.json に載った各ツアーが、parseTour でエラー 0・警告 0 で通ることと、
 * ディレクトリ名・bodyFile・画像なし・ステップ数・page ステップの URL 条件を確かめる。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { matchUrl, parseTour } from '../../src/core/tour/index.ts';
import type { Tour } from '../../src/core/tour/index.ts';

const TOURS_DIR = join(import.meta.dirname, '../../public/tours');
const IndexSchema = z.object({ tours: z.array(z.string()) });
/** 案で決めた、自己紹介ツアーのステップ数。 */
const INTRO_STEP_COUNT = 12;

const index = IndexSchema.parse(JSON.parse(readFileSync(join(TOURS_DIR, 'index.json'), 'utf8')));

function load(id: string): { tour: Tour; warnings: number } {
  const result = parseTour(readFileSync(join(TOURS_DIR, id, 'tour.yaml'), 'utf8'), 'tour.yaml');
  if (!result.ok) throw new Error(`${id} の解析に失敗しました（エラー ${String(result.errors.length)} 件）`);
  return { tour: result.tour, warnings: result.warnings.length };
}

describe('同梱ツアー', () => {
  it('R-BUNDLED-01: index.json に1件以上のツアーがある', () => {
    expect(index.tours.length).toBeGreaterThan(0);
  });

  it.each(index.tours)('R-BUNDLED-02: %s がエラー0・警告0で通る', (id) => {
    const result = parseTour(readFileSync(join(TOURS_DIR, id, 'tour.yaml'), 'utf8'), 'tour.yaml');
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
    if (!result.ok) expect(result.errors).toEqual([]);
  });

  it.each(index.tours)('R-BUNDLED-03: %s はディレクトリ名と id が一致する', (id) => {
    expect(load(id).tour.id).toBe(id);
  });

  it.each(index.tours)('R-BUNDLED-04: %s の bodyFile がすべて存在する', (id) => {
    for (const step of load(id).tour.steps) {
      if (step.bodyFile === undefined) continue;
      expect(existsSync(join(TOURS_DIR, id, step.bodyFile)), step.id).toBe(true);
    }
  });

  it.each(index.tours)('R-BUNDLED-05: %s の Markdown に画像がない', (id) => {
    for (const step of load(id).tour.steps) {
      if (step.bodyFile === undefined) continue;
      const text = readFileSync(join(TOURS_DIR, id, step.bodyFile), 'utf8');
      expect(text, step.id).not.toMatch(/!\[[^\]]*\]\(/);
      expect(text, step.id).not.toMatch(/<img\b/i);
      expect(text, step.id).not.toMatch(/data:image/i);
    }
  });

  it('R-BUNDLED-06: 自己紹介ツアーのステップ数が案と一致する', () => {
    expect(load('guided-setup-tour-intro').tour.steps).toHaveLength(INTRO_STEP_COUNT);
  });

  it.each(index.tours)('R-BUNDLED-07: %s の page ステップの URL 条件が origins に含まれる', (id) => {
    const { tour } = load(id);
    for (const step of tour.steps) {
      if (step.kind !== 'page') continue;
      const cond = step.url ?? tour.tabs?.[step.tab]?.url;
      expect(cond, step.id).toBeDefined();
      if (cond === undefined) continue;
      expect(tour.origins, step.id).toContain(cond.origin);
      expect(matchUrl(cond, `${cond.origin}/`), step.id).toBe(true);
    }
  });
});
