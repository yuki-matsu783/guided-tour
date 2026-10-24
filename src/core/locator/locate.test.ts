// @vitest-environment jsdom
import { computeAccessibleName } from 'dom-accessibility-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultEnv } from './env';
import { locate } from './locate';
import type { LocateOptions, LocateResult, LocatorEnv, LocatorTarget } from './types';

/** jsdom 向けの env。要素自身か祖先に data-hidden があれば非表示。viewport は 1000x800。 */
function makeEnv(over: Partial<LocatorEnv> = {}): LocatorEnv {
  return {
    ...defaultEnv(window),
    // jsdom は疑似要素の getComputedStyle を実装していない
    computeName: (el) => computeAccessibleName(el, { computedStyleSupportsPseudoElements: false }),
    isVisible: (el) => el.closest('[data-hidden]') === null,
    viewport: () => ({ width: 1000, height: 800 }),
    ...over,
  };
}

function run(
  target: LocatorTarget,
  html: string,
  over: Partial<LocatorEnv> = {},
  options: LocateOptions = {},
): LocateResult {
  document.body.innerHTML = html;
  return locate(target, document, makeEnv(over), options);
}

function idOf(el: Element | null): string | null {
  return el?.id ?? null;
}

function byId(id: string): Element {
  const el = document.getElementById(id);
  if (!el) throw new Error('テストの準備に失敗した');
  return el;
}

function setRect(el: Element, r: { left: number; top: number; right: number; bottom: number }): void {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ ...r, width: r.right - r.left, height: r.bottom - r.top }),
  });
}

beforeEach(() => {
  document.body.className = '';
  document.documentElement.className = '';
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('段階ごとの探し方', () => {
  it('T-LOC-01: tourId が data-tour-id に一致する1件を採用し、tier が 1 になる', () => {
    const r = run({ tourId: 'a' }, '<div id="x" data-tour-id="a"></div><div data-tour-id="b"></div>');
    expect(idOf(r.target)).toBe('x');
    expect(r.tier).toBe(1);
    expect(r.found).toBe(true);
  });

  it('T-LOC-02: testId が data-testid に一致する1件を採用する', () => {
    const r = run({ testId: 't' }, '<div id="x" data-testid="t"></div>');
    expect(idOf(r.target)).toBe('x');
  });

  it('T-LOC-03: role と name が一致する1件を採用する（段階2）', () => {
    const r = run(
      { role: 'button', name: ['保存'] },
      '<button id="a">保存</button><button id="b">削除</button>',
    );
    expect(idOf(r.target)).toBe('a');
    expect(r.tier).toBe(2);
  });

  it('T-LOC-04: button 要素は暗黙の役割 button の候補になる', () => {
    const r = run({ role: 'button', name: ['保存'] }, '<button id="a">保存</button>');
    expect(idOf(r.target)).toBe('a');
  });

  it('T-LOC-05: name の候補のうち1つだけが一致するとき、その要素を採用する', () => {
    const r = run(
      { role: 'button', name: ['Delete', '削除'] },
      '<button id="a">削除</button><button id="b">保存</button>',
    );
    expect(idOf(r.target)).toBe('a');
  });

  it('T-LOC-06: 役割は一致しても名前がどの候補にも一致しなければ失敗する', () => {
    const r = run({ role: 'button', name: ['削除'] }, '<button>保存</button>');
    expect(r.found).toBe(false);
  });

  it('T-LOC-07: label に一致するフォーム部品を採用する（段階3）', () => {
    const r = run({ label: ['メール'] }, '<label for="m">メール</label><input id="m"><input id="n" aria-label="名前">');
    expect(idOf(r.target)).toBe('m');
    expect(r.tier).toBe(3);
  });

  it('T-LOC-08: フォーム部品でない div は、読み上げ名がラベルに一致しても候補にならない', () => {
    const r = run({ label: ['メール'] }, '<div id="d" aria-label="メール"></div>');
    expect(r.found).toBe(false);
  });

  it('T-LOC-09: textTag を省くと、button・a・label・[role] の文字列が照合される', () => {
    for (const html of [
      '<button id="x">進む</button>',
      '<a id="x" href="#">進む</a>',
      '<label id="x">進む</label>',
      '<div id="x" role="tab">進む</div>',
    ]) {
      expect(idOf(run({ text: ['進む'] }, html).target)).toBe('x');
    }
    expect(run({ text: ['進む'] }, '<div id="x">進む</div>').found).toBe(false);
  });

  it('T-LOC-10: textTag を指定すると、指定したタグだけが対象になる', () => {
    const html = '<button id="b">進む</button><span id="s">進む</span>';
    const r = run({ text: ['進む'], textTag: ['span'] }, html);
    expect(idOf(r.target)).toBe('s');
  });

  it('T-LOC-11: 入れ子の外側と内側がどちらも一致するとき、最も内側だけを残す', () => {
    const r = run({ text: ['保存'], textTag: ['div'] }, '<div id="o"><div id="i">保存</div></div>');
    expect(idOf(r.target)).toBe('i');
    expect(r.counts[0]?.collected).toBe(1);
  });

  it('T-LOC-12: match が exact なら完全一致だけ、contains なら部分一致も一致とみなす', () => {
    const html = '<button id="a">アカウントを削除する</button>';
    expect(run({ text: ['削除'] }, html).found).toBe(false);
    expect(run({ text: ['削除'], match: 'exact' }, html).found).toBe(false);
    expect(idOf(run({ text: ['削除'], match: 'contains' }, html).target)).toBe('a');
  });

  it('T-LOC-13: css は先頭から順に試し、1件に決まった最初の結果を採用する', () => {
    const r = run({ css: ['#a', '#b'] }, '<div id="a"></div><div id="b"></div>');
    expect(idOf(r.target)).toBe('a');
  });

  it('T-LOC-14: 先頭の css が2件に一致するとき、次の css の1件を採用する', () => {
    const r = run({ css: ['.dup', '#only'] }, '<i class="dup"></i><i class="dup"></i><i id="only"></i>');
    expect(idOf(r.target)).toBe('only');
  });
});

describe('段階の順序と一意性', () => {
  it('T-LOC-15: 段階1と段階2がどちらも決まるとき、段階1を採用する', () => {
    const r = run(
      { testId: 't', role: 'button', name: ['保存'] },
      '<div id="a" data-testid="t"></div><button id="b">保存</button>',
    );
    expect(idOf(r.target)).toBe('a');
    expect(r.tier).toBe(1);
  });

  it('T-LOC-16: 段階1が0件なら段階2へ進み、段階2で決まれば採用する', () => {
    const r = run({ testId: 'none', role: 'button', name: ['保存'] }, '<button id="b">保存</button>');
    expect(r.tier).toBe(2);
    expect(idOf(r.target)).toBe('b');
  });

  it('T-LOC-17: 手がかりが段階2・4だけなら、書かれていない段階は試されず topTier が 2 になる', () => {
    const r = run({ role: 'button', name: ['なし'], text: ['保存'] }, '<button id="b">保存</button>');
    expect(r.topTier).toBe(2);
    expect(r.counts.map((c) => c.tier)).toEqual([2, 4]);
  });

  it('T-LOC-18: 最終候補が2件の段階は採用せず、次の段階へ進む', () => {
    const r = run(
      { role: 'button', name: ['保存'], css: ['#only'] },
      '<button>保存</button><button>保存</button><i id="only"></i>',
    );
    expect(r.tier).toBe(5);
    expect(idOf(r.target)).toBe('only');
  });

  it('T-LOC-19: すべての段階で2件以上なら missing になる', () => {
    const r = run(
      { role: 'button', name: ['保存'], css: ['button'] },
      '<button>保存</button><button>保存</button>',
    );
    expect(r.found).toBe(false);
    expect(r.reasons).toContain('missing');
  });

  it('T-LOC-20: 2件が同じ祖先に読み替えられるとき、採用しない', () => {
    const r = run(
      { role: 'button', name: ['削除'], highlight: { closest: '.card' } },
      '<div class="card" id="c"><button>削除</button><button>削除</button></div>',
    );
    expect(r.found).toBe(false);
  });

  it('T-LOC-21: 一意性の確認は読み替えの前に行い、読み替え後に1件になっても採用しない', () => {
    // 2件目は読み替え先が無いので、読み替え後なら1件に見える。読み替えの前は2件なので採用しない
    const r = run(
      { role: 'button', name: ['削除'], highlight: { closest: '.card' } },
      '<div class="card"><button>削除</button></div><button>削除</button>',
    );
    expect(r.found).toBe(false);
  });

  it('T-LOC-22: 表示されている候補が1件なら、非表示の候補が他にあっても採用する', () => {
    const r = run(
      { role: 'button', name: ['保存'] },
      '<button id="a">保存</button><button id="b" data-hidden>保存</button>',
    );
    expect(idOf(r.target)).toBe('a');
  });

  it('T-LOC-23: 表示の確認で0件になった段階は失敗し、次の段階へ進む', () => {
    const r = run(
      { role: 'button', name: ['保存'], css: ['#only'] },
      '<button data-hidden>保存</button><i id="only"></i>',
    );
    expect(r.tier).toBe(5);
  });

  it('T-LOC-24: 候補が上限の20件ちょうどでも、いずれかに一致すれば一致とみなす', () => {
    const names = Array.from({ length: 20 }, (_, i) => `名前${String(i)}`);
    const r = run({ role: 'button', name: names }, '<button id="a">名前19</button>');
    expect(idOf(r.target)).toBe('a');
  });
});

describe('探す範囲（within）', () => {
  it('T-LOC-25: within が役割＋名前で1つに決まるとき、その内側だけから集める', () => {
    const r = run(
      { role: 'button', name: ['保存'], within: { role: 'dialog', name: ['設定'] } },
      '<section role="dialog" aria-label="設定"><button id="in">保存</button></section><button id="out">保存</button>',
    );
    expect(idOf(r.target)).toBe('in');
  });

  it('T-LOC-26: within がラベルで1つに決まるとき、その内側だけから集める', () => {
    const r = run(
      { role: 'button', name: ['保存'], within: { label: ['範囲'] } },
      '<div role="listbox" aria-label="範囲"><button id="in">保存</button></div><button id="out">保存</button>',
    );
    expect(idOf(r.target)).toBe('in');
  });

  it('T-LOC-27: within が CSS で1つに決まるとき、その内側だけから集める', () => {
    const r = run(
      { role: 'button', name: ['保存'], within: { css: '#box' } },
      '<div id="box"><button id="in">保存</button></div><button id="out">保存</button>',
    );
    expect(idOf(r.target)).toBe('in');
  });

  it('T-LOC-28: within が2件以上に一致するとき、ページ全体には広げず失敗する', () => {
    const r = run(
      { role: 'button', name: ['保存'], within: { css: '.box' } },
      '<div class="box"></div><div class="box"></div><button id="out">保存</button>',
    );
    expect(r.found).toBe(false);
  });

  it('T-LOC-29: within が0件のとき、ページ全体には広げず失敗する', () => {
    const r = run({ role: 'button', name: ['保存'], within: { css: '.none' } }, '<button>保存</button>');
    expect(r.found).toBe(false);
    expect(r.counts[0]).toEqual({ tier: 2, collected: 0, required: 0, visible: 0 });
  });

  it('T-LOC-30: 段階2の within が解決できず段階2が失敗しても、within: page を明示した段階4の手がかりは試され採用される', () => {
    const r = run(
      { role: 'button', name: ['保存'], text: { values: ['保存'], within: 'page' }, within: { css: '.none' } },
      '<button id="a">保存</button>',
    );
    expect(r.tier).toBe(4);
    expect(idOf(r.target)).toBe('a');
  });

  it('T-LOC-30a: target.within があり上書きがないとき、段階1・4も範囲の内側だけを探し、外の要素を採用しない', () => {
    const html =
      '<div id="box"><button id="in" data-testid="t">保存</button></div>' +
      '<button id="out" data-testid="t2">保存</button>';
    expect(idOf(run({ testId: 't', within: { css: '#box' } }, html).target)).toBe('in');
    expect(run({ testId: 't2', within: { css: '#box' } }, html).found).toBe(false);
    expect(idOf(run({ text: ['保存'], within: { css: '#box' } }, html).target)).toBe('in');
    const outer = '<div id="box"></div><button id="out">保存</button>';
    expect(run({ text: ['保存'], within: { css: '#box' } }, outer).found).toBe(false);
  });

  it('T-LOC-30b: 段階4の手がかりに別の within を書くと、段階4だけがその範囲で探し、他の段階は target.within で探す', () => {
    const html =
      '<div id="a"><button id="a1" data-testid="x">保存</button></div>' +
      '<div id="b"><button id="b1">保存</button></div>';
    const base: LocatorTarget = { testId: 'x', text: { values: ['保存'], within: { css: '#b' } }, within: { css: '#a' } };
    expect(idOf(run(base, html).target)).toBe('a1');
    // 段階1が失敗すると、段階4は上書きした範囲 #b で探す
    const r = run({ ...base, testId: 'none' }, html);
    expect(r.tier).toBe(4);
    expect(idOf(r.target)).toBe('b1');
    // 段階4を target.within の #a で探していたら a1 が決まるので、#b の結果と区別できる
    expect(idOf(run({ text: ['保存'], within: { css: '#a' } }, html).target)).toBe('a1');
  });

  it('T-LOC-30c: target.within が0件か2件以上のとき、上書きのない段階は失敗し、within: page の段階だけが試される', () => {
    const html = '<div class="box"></div><div class="box"></div><button id="a" data-testid="t">保存</button>';
    for (const css of ['.box', '.none']) {
      const within = { css };
      expect(run({ testId: 't', within }, html).found).toBe(false);
      expect(run({ role: 'button', name: ['保存'], within }, html).found).toBe(false);
      expect(run({ text: ['保存'], within }, html).found).toBe(false);
      expect(run({ css: ['#a'], within }, html).found).toBe(false);
      const r = run({ testId: 't', css: { values: ['#a'], within: 'page' }, within }, html);
      expect(r.tier).toBe(5);
      expect(idOf(r.target)).toBe('a');
    }
  });

  it('R-LOC-30d: name・label・css の手がかりも { values, within } で書け、それぞれの範囲で探す', () => {
    const html =
      '<div id="a"><button id="a1">保存</button><input id="a2" aria-label="名前"><i id="a3" class="x"></i></div>' +
      '<div id="b"><button id="b1">保存</button><input id="b2" aria-label="名前"><i id="b3" class="x"></i></div>';
    const within = { css: '#b' };
    expect(idOf(run({ role: 'button', name: { values: ['保存'], within }, within: { css: '#a' } }, html).target)).toBe('b1');
    expect(idOf(run({ label: { values: ['名前'], within }, within: { css: '#a' } }, html).target)).toBe('b2');
    expect(idOf(run({ css: { values: ['.x'], within }, within: { css: '#a' } }, html).target)).toBe('b3');
    expect(idOf(run({ role: 'button', name: { values: ['保存'] }, within: { css: '#a' } }, html).target)).toBe('a1');
  });

  it('T-LOC-31: 範囲の外に同じ条件の要素があっても、内側の1件だけが対象になる', () => {
    const r = run(
      { css: ['button'], within: { css: '#box' } },
      '<div id="box"><button id="in">a</button></div><button id="o1">b</button><button id="o2">c</button>',
    );
    expect(idOf(r.target)).toBe('in');
  });
});

describe('必須の照合（require）', () => {
  it('T-LOC-32: require.role と計算した役割が違えば、ID が一致しても採用しない', () => {
    const r = run({ testId: 't', require: { role: 'button' } }, '<a href="#" data-testid="t">x</a>');
    expect(r.found).toBe(false);
  });

  it('T-LOC-33: require.role には暗黙の役割（a[href] の link）の計算結果を使う', () => {
    const r = run({ testId: 't', require: { role: 'link' } }, '<a id="a" href="#" data-testid="t">x</a>');
    expect(idOf(r.target)).toBe('a');
  });

  it('T-LOC-34: require.inputType と type が違う input は採用しない', () => {
    const r = run({ testId: 't', require: { inputType: 'password' } }, '<input data-testid="t" type="text">');
    expect(r.found).toBe(false);
  });

  it('T-LOC-35: require.inputType が一致する input は採用する', () => {
    const r = run({ testId: 't', require: { inputType: 'password' } }, '<input id="i" data-testid="t" type="password">');
    expect(idOf(r.target)).toBe('i');
  });

  it('T-LOC-36: require.region の外にある要素は採用しない', () => {
    const r = run({ testId: 't', require: { region: 'main' } }, '<nav><button data-testid="t">x</button></nav>');
    expect(r.found).toBe(false);
  });

  it('T-LOC-37: require.region の中にある要素は採用する', () => {
    const r = run({ testId: 't', require: { region: 'main' } }, '<main><button id="b" data-testid="t">x</button></main>');
    expect(idOf(r.target)).toBe('b');
  });

  it('T-LOC-38: require.name がどの候補にも一致しなければ、ID が一致しても採用しない', () => {
    const r = run({ testId: 't', require: { name: ['削除'] } }, '<button data-testid="t">保存</button>');
    expect(r.found).toBe(false);
  });

  it('T-LOC-39: require.name の候補のいずれかに一致すれば採用する', () => {
    const r = run({ testId: 't', require: { name: ['Delete', '削除'] } }, '<button id="b" data-testid="t">削除</button>');
    expect(idOf(r.target)).toBe('b');
  });

  it('T-LOC-40: require に複数の項目があるとき、すべてを満たす要素だけを採用する', () => {
    const html = '<main><button id="b" data-testid="t">削除</button></main>';
    expect(run({ testId: 't', require: { role: 'button', region: 'main', name: ['削除'] } }, html).found).toBe(true);
    expect(run({ testId: 't', require: { role: 'button', region: 'navigation', name: ['削除'] } }, html).found).toBe(false);
    expect(run({ testId: 't', require: { role: 'link', region: 'main', name: ['削除'] } }, html).found).toBe(false);
  });

  it('T-LOC-41: 段階5で見つかった候補も、必須の照合を満たさなければ採用しない', () => {
    const r = run({ css: ['#a'], require: { role: 'link' } }, '<button id="a">x</button>');
    expect(r.found).toBe(false);
  });

  it('T-LOC-42: 必須の照合で2件から1件に絞られたら、残った1件を採用する', () => {
    const r = run(
      { testId: 't', require: { role: 'button' } },
      '<button id="b" data-testid="t">x</button><a href="#" data-testid="t">y</a>',
    );
    expect(idOf(r.target)).toBe('b');
  });

  it('T-LOC-43: require がなく段階1の候補が1件なら、そのまま採用する', () => {
    const r = run({ testId: 't' }, '<div id="d" data-testid="t"></div>');
    expect(idOf(r.target)).toBe('d');
  });
});

describe('conflict（矛盾）の条件', () => {
  const wrong = '<a href="#" data-testid="t">x</a>';

  it('T-LOC-44: 絞る前がちょうど1件で、それが捨てられたら conflict が入る', () => {
    expect(run({ testId: 't', require: { role: 'button' } }, wrong).reasons).toContain('conflict');
  });

  it('T-LOC-45: 絞る前が2件で2件とも捨てられても、conflict は入らない', () => {
    const r = run({ testId: 't', require: { role: 'button' } }, wrong + wrong);
    expect(r.reasons).not.toContain('conflict');
  });

  it('T-LOC-46: 絞る前が2件で1件に絞られて採用されたら、conflict は入らない', () => {
    const r = run({ testId: 't', require: { role: 'button' } }, wrong + '<button data-testid="t">y</button>');
    expect(r.found).toBe(true);
    expect(r.reasons).not.toContain('conflict');
  });

  it('T-LOC-47: 絞る前が1件で必須の照合を通ったら、conflict は入らない', () => {
    const r = run({ testId: 't', require: { role: 'button' } }, '<button data-testid="t">y</button>');
    expect(r.reasons).toEqual([]);
  });

  it('T-LOC-48: 段階1が conflict になり段階2で成功したら、conflict と degraded の両方が入る', () => {
    const r = run(
      { testId: 't', role: 'button', name: ['保存'], require: { region: 'main' } },
      '<div data-testid="t"></div><main><button id="b">保存</button></main>',
    );
    expect(r.tier).toBe(2);
    expect(r.reasons).toEqual(['degraded', 'conflict']);
  });

  it('T-LOC-49: 表示の確認で0件になっただけなら、conflict は入らない', () => {
    const r = run({ testId: 't' }, '<div data-testid="t" data-hidden></div>');
    expect(r.reasons).toEqual(['missing']);
  });

  it('T-LOC-50: require.name の不一致で1件が捨てられたら conflict が入る', () => {
    const r = run({ testId: 't', require: { name: ['削除'] } }, '<button data-testid="t">保存</button>');
    expect(r.reasons).toContain('conflict');
  });
});

describe('表示の判定（locate への組み込み）', () => {
  it('T-LOC-54: display: contents の祖先を持ち、自身が矩形を持つ要素は特定される', () => {
    document.body.innerHTML = '<div style="display: contents"><button id="b">保存</button></div>';
    const button = byId('b');
    Object.defineProperty(button, 'getClientRects', { value: () => [{ width: 50, height: 20 }] });
    const env = { ...defaultEnv(window), viewport: () => ({ width: 1000, height: 800 }) };
    const r = locate({ role: 'button', name: ['保存'] }, document, env);
    expect(r.target).toBe(button);
  });

  it('T-LOC-58: allowHidden を指定すると、表示されていない候補も採用の対象になる', () => {
    const r = run({ testId: 't' }, '<div id="d" data-testid="t" data-hidden></div>', {}, { allowHidden: true });
    expect(idOf(r.target)).toBe('d');
  });

  it('T-LOC-59: allowHidden がなければ、表示されていない候補は除かれる', () => {
    const r = run({ testId: 't' }, '<div data-testid="t" data-hidden></div>');
    expect(r.found).toBe(false);
  });
});

describe('読み替えと不適格', () => {
  it('T-LOC-60: highlight.closest で、最も近い一致する祖先が highlightEl になり target は操作対象のまま', () => {
    const r = run(
      { testId: 't', highlight: { closest: '.card' } },
      '<div class="card" id="outer"><div class="card" id="inner"><button id="b" data-testid="t">x</button></div></div>',
    );
    expect(idOf(r.target)).toBe('b');
    expect(idOf(r.highlightEl)).toBe('inner');
  });

  it('T-LOC-61: highlight.closest がなければ、highlightEl は操作対象と同じ', () => {
    const r = run({ testId: 't' }, '<button id="b" data-testid="t">x</button>');
    expect(r.highlightEl).toBe(r.target);
  });

  it('T-LOC-62: 読み替え先が body なら不適格で、次の段階へ進む', () => {
    document.body.className = 'wrap';
    const r = run(
      { testId: 't', css: ['#low'], highlight: { closest: '.wrap' } },
      '<i data-testid="t"></i><div class="wrap" id="w2"><i id="low"></i></div>',
    );
    expect(r.tier).toBe(5);
    expect(idOf(r.highlightEl)).toBe('w2');
  });

  it('T-LOC-63: 読み替え先が html なら不適格として失敗する', () => {
    document.documentElement.className = 'wrap';
    const r = run({ testId: 't', highlight: { closest: '.wrap' } }, '<i data-testid="t"></i>');
    expect(r.found).toBe(false);
  });

  it('T-LOC-64: 読み替え先が表示領域全体を覆う要素なら不適格として失敗する', () => {
    document.body.innerHTML = '<div id="cover"><i data-testid="t"></i></div>';
    setRect(byId('cover'), { left: 0, top: 0, right: 1000, bottom: 800 });
    const r = locate({ testId: 't', highlight: { closest: '#cover' } }, document, makeEnv());
    expect(r.found).toBe(false);
  });

  it('T-LOC-65: 表示領域より縦に長くても、全体を覆わないフォームは採用する', () => {
    document.body.innerHTML = '<form id="f"><i data-testid="t"></i></form>';
    const form = byId('f');
    setRect(form, { left: 40, top: 20, right: 960, bottom: 3000 });
    const r = locate({ testId: 't', highlight: { closest: 'form' } }, document, makeEnv());
    expect(r.highlightEl).toBe(form);
  });

  it('T-LOC-66: 読み替え先が表示されていなければ、その段階は失敗して次へ進む', () => {
    const r = run(
      { testId: 't', css: ['#low'], highlight: { closest: '.wrap' } },
      '<div class="wrap" data-self-hidden><i data-testid="t"></i></div><div class="wrap"><i id="low"></i></div>',
      { isVisible: (el) => !el.hasAttribute('data-self-hidden') },
    );
    expect(r.tier).toBe(5);
  });

  it('T-LOC-67: 読み替え先が不適格でも、下位の段階で適格な1件が決まればそれを採用する', () => {
    document.body.className = 'wrap';
    const r = run(
      { testId: 't', role: 'button', name: ['保存'], highlight: { closest: '.wrap' } },
      '<i data-testid="t"></i><div class="wrap"><button id="b">保存</button></div>',
    );
    expect(r.tier).toBe(2);
    expect(idOf(r.target)).toBe('b');
  });

  it('T-LOC-68: 操作対象自身が body のときも、読み替えがなくても不適格とされる', () => {
    const r = run({ css: ['body'] }, '<i></i>');
    expect(r.found).toBe(false);
    expect(r.reasons).toEqual(['missing']);
  });
});

describe('補助の照合と nameMismatch', () => {
  const button = '<button data-testid="t">本当の名前</button>';

  it('T-LOC-69: 段階1で名前が一致しなくても採用し、nameMismatch が入る', () => {
    const r = run({ testId: 't', name: ['別の名前'] }, button);
    expect(r.found).toBe(true);
    expect(r.reasons).toEqual(['nameMismatch']);
  });

  it('T-LOC-70: 段階5で名前が一致しなくても採用し、nameMismatch が入る', () => {
    const r = run({ css: ['button'], name: ['別の名前'] }, button);
    expect(r.found).toBe(true);
    expect(r.reasons).toEqual(['nameMismatch']);
  });

  it('T-LOC-71: 段階1で名前の候補のいずれかに一致すれば、nameMismatch は入らない', () => {
    const r = run({ testId: 't', name: ['別の名前', '本当の名前'] }, button);
    expect(r.reasons).toEqual([]);
  });

  it('T-LOC-72: 名前の候補が書かれていなければ、補助の照合は行わない', () => {
    expect(run({ testId: 't' }, button).reasons).toEqual([]);
  });

  it('T-LOC-73: require.name があるとき補助の照合は行わず、不一致は必須の照合で不採用になる', () => {
    const ok = run({ testId: 't', name: ['別の名前'], require: { name: ['本当の名前'] } }, button);
    expect(ok.found).toBe(true);
    expect(ok.reasons).toEqual([]);
    const ng = run({ testId: 't', name: ['本当の名前'], require: { name: ['別の名前'] } }, button);
    expect(ng.found).toBe(false);
  });

  it('T-LOC-74: 補助の照合の候補は name・label・text のどれでも対象になる', () => {
    for (const extra of [{ name: ['x'] }, { label: ['x'] }, { text: ['x'] }]) {
      expect(run({ testId: 't', ...extra }, button).reasons).toEqual(['nameMismatch']);
    }
  });

  it('T-LOC-75: 段階2〜4で採用したときは、nameMismatch は入らない', () => {
    expect(run({ role: 'button', name: ['本当の名前'] }, button).reasons).toEqual([]);
    expect(run({ label: ['入力'] }, '<input id="i" aria-label="入力">').reasons).toEqual([]);
    expect(run({ text: ['本当の名前'] }, button).reasons).toEqual([]);
  });

  it('T-LOC-76: 段階1が nameMismatch で採用されたとき、degraded は入らず tier と topTier が同じ', () => {
    const r = run({ testId: 't', name: ['別の名前'] }, button);
    expect(r.reasons).not.toContain('degraded');
    expect(r.tier).toBe(r.topTier);
  });
});

describe('degraded と missing、tier / topTier / counts', () => {
  it('T-LOC-77: 最上位の段階で成功し補助の照合も一致すれば、reasons は空', () => {
    const r = run({ testId: 't', name: ['保存'] }, '<button data-testid="t">保存</button>');
    expect(r.reasons).toEqual([]);
  });

  it('T-LOC-78: 上位が失敗し下位で成功したら、degraded が入り tier は下位・topTier は上位', () => {
    const r = run({ testId: 'none', css: ['#a'] }, '<i id="a"></i>');
    expect(r.reasons).toEqual(['degraded']);
    expect(r.tier).toBe(5);
    expect(r.topTier).toBe(1);
  });

  it('T-LOC-79: すべての段階で失敗したら missing で、操作対象とハイライトする要素は返らない', () => {
    const r = run({ testId: 'none', css: ['#none'] }, '<i></i>');
    expect(r.reasons).toEqual(['missing']);
    expect(r.target).toBeNull();
    expect(r.highlightEl).toBeNull();
    expect(r.tier).toBeNull();
  });

  it('T-LOC-80: tier が topTier と等しいとき、degraded は入らない', () => {
    const r = run({ css: ['#a'] }, '<i id="a"></i>');
    expect(r.tier).toBe(r.topTier);
    expect(r.reasons).not.toContain('degraded');
  });

  it('T-LOC-81: counts に、段階ごとの候補数（集めた数・必須の照合後・表示の確認後）が入る', () => {
    const r = run({ testId: 't' }, '<i data-testid="t"></i><i data-testid="t" data-hidden></i>');
    expect(r.counts).toEqual([{ tier: 1, collected: 2, required: 2, visible: 1 }]);
  });

  it('T-LOC-82: 必須の照合で3件から1件に絞られたとき、counts が (3, 1, 1) になる', () => {
    const r = run(
      { testId: 't', require: { role: 'button' } },
      '<button data-testid="t">a</button><a href="#" data-testid="t">b</a><a href="#" data-testid="t">c</a>',
    );
    expect(r.counts).toEqual([{ tier: 1, collected: 3, required: 1, visible: 1 }]);
  });

  it('T-LOC-83: 手がかりが何も書かれていない target は missing になる', () => {
    const r = run({}, '<button>a</button>');
    expect(r.reasons).toEqual(['missing']);
    expect(r.topTier).toBeNull();
    expect(r.counts).toEqual([]);
  });
});

describe('自前の表示ホストの除外', () => {
  const host = (inner: string): string => `<div data-guided-tour-host>${inner}</div>`;

  it('T-LOC-91: ホスト要素の中にだけある同じ条件の要素は、候補に入らない', () => {
    const r = run({ role: 'button', name: ['保存'] }, host('<button>保存</button>'));
    expect(r.found).toBe(false);
    expect(r.counts[0]?.collected).toBe(0);
  });

  it('T-LOC-92: ホストの外に1件、中に1件あるとき、外の1件だけが数えられ一意に決まる', () => {
    const r = run(
      { role: 'button', name: ['保存'] },
      host('<button id="in">保存</button>') + '<button id="out">保存</button>',
    );
    expect(idOf(r.target)).toBe('out');
  });

  it('T-LOC-93: ホスト要素そのものも候補から除かれる', () => {
    const r = run({ css: ['[data-guided-tour-host]'] }, host(''));
    expect(r.found).toBe(false);
  });

  it('T-LOC-94: 段階1〜5のどの段階でも、ホスト要素とその中身は除外される', () => {
    const html = host(
      '<button id="x" data-tour-id="a" data-testid="a" aria-label="入力">文字</button>' +
        '<input id="y" aria-label="入力">',
    );
    const targets: LocatorTarget[] = [
      { tourId: 'a' },
      { testId: 'a' },
      { role: 'button', name: ['入力'] },
      { label: ['入力'] },
      { text: ['文字'] },
      { css: ['#x'] },
    ];
    for (const t of targets) {
      expect(run(t, html).found).toBe(false);
    }
  });

  it('T-LOC-95: ホストの内側を within に指定すると範囲は0件となり、その手がかりは失敗する', () => {
    const r = run(
      { role: 'button', name: ['保存'], within: { css: '.inner' } },
      host('<div class="inner"><button>保存</button></div>') + '<button>保存</button>',
    );
    expect(r.found).toBe(false);
  });
});

describe('名前の文字列を返さないこと', () => {
  it('T-LOC-96: 戻り値を JSON にしても、読み上げ名・表示文字列は含まれない', () => {
    const r = run(
      { role: 'button', name: ['ひみつの名前'], text: ['ひみつの文字'] },
      '<button>ひみつの名前</button>',
    );
    const json = JSON.stringify(r);
    expect(json).not.toContain('ひみつの名前');
    expect(json).not.toContain('ひみつの文字');
  });

  it('T-LOC-97: nameMismatch でも、戻り値には名前の文字列が含まれない', () => {
    const r = run({ testId: 't', name: ['期待した名前'] }, '<button data-testid="t">実際の名前</button>');
    expect(r.reasons).toContain('nameMismatch');
    const json = JSON.stringify(r);
    expect(json).not.toContain('期待した名前');
    expect(json).not.toContain('実際の名前');
  });

  it('T-LOC-98: reasons は列挙値だけ、counts は数値だけで構成される', () => {
    const r = run({ testId: 'none', css: ['#a'], name: ['x'] }, '<i id="a"></i>');
    const allowed = ['degraded', 'conflict', 'missing', 'nameMismatch'];
    expect(r.reasons.every((x) => allowed.includes(x))).toBe(true);
    for (const c of r.counts) {
      expect(Object.values(c).every((v) => typeof v === 'number')).toBe(true);
    }
  });

  it('T-LOC-99: 読み上げ名の計算は env で差し替えられ、返した名前で照合される', () => {
    const r = run(
      { role: 'button', name: ['差し替え'] },
      '<button id="a">本来の名前</button>',
      { computeName: () => '差し替え' },
    );
    expect(idOf(r.target)).toBe('a');
  });

  it('T-LOC-100: 表示の判定は env で差し替えられ、偽を返した要素は表示されていないとみなす', () => {
    const r = run({ testId: 't' }, '<i data-testid="t"></i>', { isVisible: () => false });
    expect(r.found).toBe(false);
  });
});

describe('第1段のレビュー指摘の修正', () => {
  it('R-LOC-1: 段階4の照合は env.visibleText の結果で行う（textContent では一致しても、見えていなければ一致しない）', () => {
    const html = '<button id="b">保存<span data-gone>（非表示）</span></button>';
    const visibleText = (el: Element): string => el.textContent.replace('（非表示）', '');
    expect(run({ text: ['保存（非表示）'] }, html, { visibleText }).found).toBe(false);
    expect(idOf(run({ text: ['保存'] }, html, { visibleText }).target)).toBe('b');
  });

  it('R-LOC-2: require を満たす外側が残り、内側が必須の照合で落ちても conflict は付かない', () => {
    const r = run(
      { text: ['保存'], require: { role: 'button' } },
      '<button id="b"><span role="presentation">保存</span></button>',
    );
    expect(idOf(r.target)).toBe('b');
    expect(r.reasons).toEqual([]);
  });

  it('R-LOC-2: 内側が表示されていなくても、表示されている外側が残る', () => {
    const r = run(
      { text: ['保存'], textTag: ['div'] },
      '<div id="o"><div id="i" data-self-hidden>保存</div></div>',
      { isVisible: (el) => !el.hasAttribute('data-self-hidden') },
    );
    expect(idOf(r.target)).toBe('o');
  });

  it('R-LOC-3: 表示領域より大きいフォームは、スクロール位置によらず採用する', () => {
    document.body.innerHTML = '<form id="f"><i data-testid="t"></i></form>';
    const form = byId('f');
    for (const top of [0, -500, -2000]) {
      setRect(form, { left: 0, top, right: 1000, bottom: top + 3000 });
      const r = locate({ testId: 't', highlight: { closest: 'form' } }, document, makeEnv());
      // 高さが表示領域を超える場合は採用する（上端が 0 のときも）
      expect(r.highlightEl).toBe(form);
    }
  });

  it('R-LOC-3: 表示領域と同じ大きさ（許容1px）の要素は不適格のまま', () => {
    document.body.innerHTML = '<div id="c"><i data-testid="t"></i></div>';
    setRect(byId('c'), { left: -1, top: 0, right: 1000, bottom: 801 });
    const r = locate({ testId: 't', highlight: { closest: '#c' } }, document, makeEnv());
    expect(r.found).toBe(false);
  });

  it('R-LOC-3: viewport が 0x0 のときは、覆う判定をしない', () => {
    document.body.innerHTML = '<div id="c"><i data-testid="t"></i></div>';
    setRect(byId('c'), { left: 0, top: 0, right: 1000, bottom: 800 });
    const r = locate(
      { testId: 't', highlight: { closest: '#c' } },
      document,
      makeEnv({ viewport: () => ({ width: 0, height: 0 }) }),
    );
    expect(idOf(r.highlightEl)).toBe('c');
  });

  it('R-LOC-4: require.inputType はブラウザが正規化した type で比べる（大文字・未知の値）', () => {
    expect(run({ testId: 't', require: { inputType: 'password' } }, '<input data-testid="t" type="PASSWORD">').found).toBe(true);
    expect(run({ testId: 't', require: { inputType: 'text' } }, '<input data-testid="t" type="foo">').found).toBe(true);
    expect(run({ testId: 't', require: { inputType: 'text' } }, '<input data-testid="t">').found).toBe(true);
    expect(run({ testId: 't', require: { inputType: 'foo' } }, '<input data-testid="t" type="foo">').found).toBe(false);
    expect(run({ testId: 't', require: { inputType: 'text' } }, '<button data-testid="t"></button>').found).toBe(false);
  });

  it('R-LOC-5: article・aside・main・nav・section の中の header・footer は banner・contentinfo にならない', () => {
    for (const wrap of ['article', 'aside', 'main', 'nav', 'section']) {
      const html = `<${wrap}><header><button data-testid="t">x</button></header></${wrap}>`;
      expect(run({ testId: 't', require: { region: 'banner' } }, html).found).toBe(false);
      const footer = `<${wrap}><footer><button data-testid="t">x</button></footer></${wrap}>`;
      expect(run({ testId: 't', require: { region: 'contentinfo' } }, footer).found).toBe(false);
    }
  });

  it('R-LOC-5: 直下の header・footer は banner・contentinfo になる', () => {
    expect(run({ testId: 't', require: { region: 'banner' } }, '<header><button data-testid="t">x</button></header>').found).toBe(true);
    expect(run({ testId: 't', require: { region: 'contentinfo' } }, '<footer><button data-testid="t">x</button></footer>').found).toBe(true);
  });

  it('R-LOC-5: section・form は名前があるときだけ region・form になる', () => {
    const button = '<button data-testid="t">x</button>';
    expect(run({ testId: 't', require: { region: 'region' } }, `<section>${button}</section>`).found).toBe(false);
    expect(run({ testId: 't', require: { region: 'region' } }, `<section aria-label="a">${button}</section>`).found).toBe(true);
    expect(run({ testId: 't', require: { region: 'region' } }, `<h2 id="h">見出し</h2><section aria-labelledby="h">${button}</section>`).found).toBe(true);
    expect(run({ testId: 't', require: { region: 'form' } }, `<form>${button}</form>`).found).toBe(false);
    expect(run({ testId: 't', require: { region: 'form' } }, `<form aria-label="a">${button}</form>`).found).toBe(true);
  });

  it('R-LOC-6: highlight.closest は操作対象自身を含めず、親から探す', () => {
    const r = run(
      { testId: 't', highlight: { closest: '.card' } },
      '<div class="card" id="p"><div class="card" id="self" data-testid="t"></div></div>',
    );
    expect(idOf(r.target)).toBe('self');
    expect(idOf(r.highlightEl)).toBe('p');
    const none = run({ testId: 't', highlight: { closest: '.card' } }, '<div class="card" data-testid="t"></div>');
    expect(none.found).toBe(false);
  });

  it('R-LOC-7: 段階4で入れ子の候補が1000件あっても、最も内側を残す手間は候補数に比例する', () => {
    let html = '';
    for (let i = 0; i < 500; i += 1) html += '<div class="o"><div class="i">保存</div></div>';
    document.body.innerHTML = `<div>${html}</div>`;
    const env = makeEnv({ visibleText: (el) => el.textContent });
    // 時間ではなく、祖先を辿る処理が集合を引く回数で確かめる（2乗なら 1000×1000 のおよそ 100 万回になる）
    const has = vi.spyOn(Set.prototype, 'has');
    const r = locate({ text: ['保存'], textTag: ['div'], match: 'contains' }, document, env);
    const calls = has.mock.calls.length;
    has.mockRestore();
    expect(calls).toBeLessThan(1000 * 20);
    expect(r.counts[0]?.collected).toBe(500);
  });

  it('R-LOC-8: 空白だけの名前の候補は、名前のない要素に一致しない', () => {
    const r = run({ role: 'button', name: ['  '] }, '<button id="a"></button>');
    expect(r.found).toBe(false);
  });
});
