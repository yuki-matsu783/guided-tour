import { describe, expect, it, vi } from 'vitest';
import {
  BgToPageSchema,
  OP_REQUIREMENTS,
  PanelToBgSchema,
  PanelViewSchema,
  parseBgToPage,
  parseBgToPanel,
  parsePageToBg,
  parsePanelToBg,
  toPageStep,
  type DropLogger,
} from './index.ts';

const EXT = 'abcdefghijklmnopabcdefghijklmnop';
const PANEL = { url: `chrome-extension://${EXT}/sidepanel.html` };
const base = { sessionId: 's1', gen: 1, opId: 'o1' };
const logLine = { ts: 1, level: 'info', ctx: 'content', event: 'session.stop', fields: {} };

const panelMessages = {
  GET_STATE: { type: 'GET_STATE' },
  START: { type: 'START', tourId: 't', resume: false, opId: 'o1' },
  GOTO: { type: 'GOTO', to: 2, ...base },
  PAUSE: { type: 'PAUSE', sessionId: 's1', opId: 'o1' },
  RESUME: { type: 'RESUME', sessionId: 's1', opId: 'o1' },
  STOP: { type: 'STOP', sessionId: 's1', opId: 'o1' },
  RESTART: { type: 'RESTART', sessionId: 's1', opId: 'o1' },
  RESUME_NEW: { type: 'RESUME_NEW', mode: 'continue', sessionId: 's1', opId: 'o1' },
  BIND_TAB: { type: 'BIND_TAB', tabId: 5, force: false, ...base },
  OPEN_IN: { type: 'OPEN_IN', mode: 'new', ...base },
  FOCUS_ROLE: { type: 'FOCUS_ROLE', ...base },
  RECHECK: { type: 'RECHECK', ...base },
  SCROLL_TO_TARGET: { type: 'SCROLL_TO_TARGET', ...base },
  SET_OVERLAY: { type: 'SET_OVERLAY', hidden: true, sessionId: 's1', opId: 'o1' },
  SET_UI: { type: 'SET_UI', enabled: true, mode: 'hover', width: 320 },
  CATALOG_CHANGED: { type: 'CATALOG_CHANGED', tourId: 't', hash: 'h' },
  REMOVE: { type: 'REMOVE', tourId: 't' },
  RELOAD: { type: 'RELOAD' },
  GET_DIAGNOSTICS: { type: 'GET_DIAGNOSTICS' },
  EXPORT_LOGS: { type: 'EXPORT_LOGS' },
  CLEAR_LOGS: { type: 'CLEAR_LOGS' },
  LOG: { type: 'LOG', entries: [logLine] },
};

const summary = { found: true, tier: 1, topTier: 1, reasons: [], counts: [] };
const pageMessages = {
  HELLO: { type: 'HELLO' },
  LOCATE_RESULT: { type: 'LOCATE_RESULT', sessionId: 's1', gen: 1, pageSeq: 2, result: summary },
  HINT_STATE: { type: 'HINT_STATE', sessionId: 's1', gen: 1, pageSeq: 2, met: true, unsupported: false },
  GOTO: panelMessages.GOTO,
  SCROLL_TO_TARGET: panelMessages.SCROLL_TO_TARGET,
  SET_OVERLAY: panelMessages.SET_OVERLAY,
  SET_UI: { type: 'SET_UI', mode: 'hover', width: 320 },
  LOG: panelMessages.LOG,
};

const step = { id: 'a', title: 'A', tip: 't', target: { role: 'button', name: ['x'] } };
const render = {
  type: 'RENDER',
  sessionId: 's1',
  gen: 1,
  pageSeq: 0,
  rev: 3,
  step,
  index: 0,
  total: 2,
  overlay: { hidden: false },
  ui: { enabled: true, mode: 'expanded', width: 320 },
  selected: true,
  attended: true,
  donePage: false,
  hint: { met: false, unsupported: false, stopped: false },
  shortcut: null,
  fallbackText: null,
  isLast: false,
};
const bgToPage = {
  PING: { type: 'PING' },
  SYNC: { type: 'SYNC', sessionId: 's1', gen: 1, rev: 3 },
  RENDER: render,
  RECHECK: { type: 'RECHECK', rev: 4 },
  SCROLL_TO_TARGET: { type: 'SCROLL_TO_TARGET', rev: 5 },
  CLEAR: { type: 'CLEAR', rev: 6 },
};

function logger(): DropLogger & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    debug: vi.fn((...args: unknown[]) => {
      calls.push(args);
    }),
  };
}

describe('サイドパネル → バックグラウンド', () => {
  it('T-MSG-01: 各メッセージが定められた形で受理される', () => {
    for (const [type, msg] of Object.entries(panelMessages)) {
      const parsed = parsePanelToBg(msg, PANEL, EXT);
      expect(parsed?.type, type).toBe(type);
    }
  });

  it('T-MSG-02: 必須の項目が欠けると捨てられる', () => {
    for (const [type, msg] of Object.entries(panelMessages)) {
      const required = Object.keys(msg).filter((k) => k !== 'type' && type !== 'SET_UI');
      for (const key of required) {
        const copy = Object.fromEntries(Object.entries(msg).filter(([k]) => k !== key));
        expect(PanelToBgSchema.safeParse(copy).success, `${type}.${key}`).toBe(false);
      }
    }
  });

  it('T-MSG-03: 項目の型が違うと捨てられる', () => {
    const bad = [
      { ...panelMessages.GOTO, gen: '1' },
      { ...panelMessages.SET_OVERLAY, hidden: 1 },
      { ...panelMessages.START, resume: 'no' },
      { ...panelMessages.BIND_TAB, tabId: '5' },
      { ...panelMessages.GOTO, gen: -1 },
      { ...panelMessages.GOTO, sessionId: 5 },
      { type: 'LOG', entries: 'x' },
    ];
    for (const msg of bad) expect(parsePanelToBg(msg, PANEL, EXT)).toBeNull();
  });

  it('T-MSG-04: type が未知なら捨てられる', () => {
    expect(parsePanelToBg({ type: 'NOPE' }, PANEL, EXT)).toBeNull();
    expect(parsePanelToBg({}, PANEL, EXT)).toBeNull();
  });

  it('T-MSG-05: オブジェクトでない値は捨てられる', () => {
    for (const raw of [null, 'GET_STATE', ['GET_STATE'], 1, undefined]) {
      expect(parsePanelToBg(raw, PANEL, EXT)).toBeNull();
    }
  });

  it('T-MSG-06: RESUME_NEW の mode が continue・restart 以外なら捨てられる', () => {
    const m = panelMessages.RESUME_NEW;
    expect(parsePanelToBg({ ...m, mode: 'restart' }, PANEL, EXT)).not.toBeNull();
    expect(parsePanelToBg({ ...m, mode: 'other' }, PANEL, EXT)).toBeNull();
  });

  it('T-MSG-07: OPEN_IN の mode が定められた値以外なら捨てられる', () => {
    const m = panelMessages.OPEN_IN;
    expect(parsePanelToBg({ ...m, mode: 'current' }, PANEL, EXT)).not.toBeNull();
    expect(parsePanelToBg({ ...m, mode: 'tab' }, PANEL, EXT)).toBeNull();
  });

  it('T-MSG-08: SET_UI の mode が展開・最小化・ホバー以外なら捨てられる', () => {
    for (const mode of ['expanded', 'minimized', 'hover']) {
      expect(parsePanelToBg({ type: 'SET_UI', mode }, PANEL, EXT)).not.toBeNull();
    }
    expect(parsePanelToBg({ type: 'SET_UI', mode: 'big' }, PANEL, EXT)).toBeNull();
  });

  it('T-MSG-09: SET_UI の項目は省略でき、一部だけでも受理される', () => {
    expect(parsePanelToBg({ type: 'SET_UI' }, PANEL, EXT)).not.toBeNull();
    expect(parsePanelToBg({ type: 'SET_UI', enabled: false }, PANEL, EXT)).not.toBeNull();
    expect(parsePanelToBg({ type: 'SET_UI', width: 400 }, PANEL, EXT)).not.toBeNull();
    expect(parsePanelToBg({ type: 'SET_UI', width: 100 }, PANEL, EXT)).toBeNull();
  });

  it('T-MSG-15: LOG の entries にスキーマにない項目があると、その行の内容が捨てられる', () => {
    const parsed = parsePanelToBg(
      { type: 'LOG', entries: [logLine, { ...logLine, fields: { url: 'https://secret.example' } }] },
      PANEL,
      EXT,
    );
    if (parsed?.type !== 'LOG') throw new Error('LOG が受理されない');
    expect(parsed.entries[0]?.ok).toBe(true);
    expect(parsed.entries[1]).toEqual({ ok: false, event: 'session.stop' });
    expect(JSON.stringify(parsed.entries[1])).not.toContain('secret');
  });

  it('T-MSG-16: sender.url がサイドパネルのページなら受け付けられる', () => {
    const withQuery = { url: `chrome-extension://${EXT}/sidepanel.html?x=1#y` };
    expect(parsePanelToBg(panelMessages.STOP, withQuery, EXT)).not.toBeNull();
    expect(parsePanelToBg(panelMessages.START, PANEL, EXT)).not.toBeNull();
  });

  it('T-MSG-17: sender.url が通常のウェブページなら捨てられる', () => {
    for (const url of [
      'https://example.com/sidepanel.html',
      `chrome-extension://other/sidepanel.html`,
      `chrome-extension://${EXT}/other.html`,
      'not a url',
    ]) {
      expect(parsePanelToBg(panelMessages.STOP, { url }, EXT), url).toBeNull();
    }
  });

  it('T-MSG-18: sender.url がなければ捨てられる', () => {
    expect(parsePanelToBg(panelMessages.STOP, {}, EXT)).toBeNull();
    expect(parsePanelToBg(panelMessages.STOP, { url: undefined }, EXT)).toBeNull();
  });
});

describe('ページ側 → バックグラウンド', () => {
  it('T-MSG-10: 各メッセージが定められた形で受理される', () => {
    for (const [type, msg] of Object.entries(pageMessages)) {
      expect(parsePageToBg(msg)?.type, type).toBe(type);
    }
  });

  it('T-MSG-11: LOCATE_RESULT の pageSeq や result が欠けると捨てられる', () => {
    const m = pageMessages.LOCATE_RESULT;
    for (const key of ['pageSeq', 'result', 'gen', 'sessionId']) {
      const copy = Object.fromEntries(Object.entries(m).filter(([k]) => k !== key));
      expect(parsePageToBg(copy), key).toBeNull();
    }
    expect(parsePageToBg({ ...m, result: { found: true } })).toBeNull();
  });

  it('T-MSG-19: サイドパネル専用のメッセージは捨てられる', () => {
    const { START, STOP, REMOVE, RELOAD, CATALOG_CHANGED, PAUSE, GET_STATE } = panelMessages;
    for (const msg of [START, STOP, REMOVE, RELOAD, CATALOG_CHANGED, PAUSE, GET_STATE]) {
      expect(parsePageToBg(msg), msg.type).toBeNull();
    }
  });

  it('S-2: ページ側の SET_UI は mode と width だけで、enabled を含むものは捨てられる', () => {
    expect(parsePageToBg({ type: 'SET_UI' })).not.toBeNull();
    expect(parsePageToBg({ type: 'SET_UI', mode: 'minimized' })).not.toBeNull();
    expect(parsePageToBg({ type: 'SET_UI', width: 400 })).not.toBeNull();
    expect(parsePageToBg({ type: 'SET_UI', enabled: false })).toBeNull();
    expect(parsePageToBg({ type: 'SET_UI', enabled: true, mode: 'hover', width: 320 })).toBeNull();
    expect(parsePageToBg({ type: 'SET_UI', width: 100 })).toBeNull();
  });

  it('T-MSG-20: 本文の自己申告の sender は結果に残らない', () => {
    const parsed = parsePageToBg({
      ...(pageMessages.HINT_STATE),
      sender: { tab: { id: 1 }, frameId: 0 },
      tabId: 1,
    });
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty('sender');
    expect(parsed).not.toHaveProperty('tabId');
  });
});

describe('バックグラウンド → ページ側', () => {
  it('T-MSG-12: rev を含む定められた形で受理される', () => {
    for (const [type, msg] of Object.entries(bgToPage)) {
      expect(parseBgToPage(msg)?.type, type).toBe(type);
    }
  });

  it('T-MSG-13: rev が欠けた RENDER・CLEAR は捨てられる', () => {
    const noRev = Object.fromEntries(Object.entries(render).filter(([k]) => k !== 'rev'));
    expect(parseBgToPage(noRev)).toBeNull();
    expect(parseBgToPage({ type: 'CLEAR' })).toBeNull();
    expect(parseBgToPage({ type: 'RECHECK' })).toBeNull();
    expect(parseBgToPage({ type: 'SYNC', sessionId: 's1', gen: 1 })).toBeNull();
  });

  it('S-3: RENDER の ui.width が範囲外でも捨てられず、範囲内に丸めて受け付ける', () => {
    const wide = BgToPageSchema.safeParse({ ...render, ui: { enabled: true, mode: 'expanded', width: 9999 } });
    expect(wide.success).toBe(true);
    const narrow = BgToPageSchema.safeParse({ ...render, ui: { enabled: true, mode: 'expanded', width: 10 } });
    expect(narrow.success).toBe(true);
    if (wide.success && wide.data.type === 'RENDER') expect(wide.data.ui.width).toBe(560);
    if (narrow.success && narrow.data.type === 'RENDER') expect(narrow.data.ui.width).toBe(240);
    expect(parseBgToPage({ ...render, ui: { enabled: true, mode: 'expanded', width: 'x' } })).toBeNull();
  });

  it('S-3: サイドパネルからの SET_UI の幅は、範囲外なら今まで通り捨てられる', () => {
    expect(parsePanelToBg({ type: 'SET_UI', width: 9999 }, PANEL, EXT)).toBeNull();
  });

  it('T-MSG-14: RENDER の step が形に合わないと捨てられる', () => {
    const bad = [
      { ...step, id: 1 },
      { ...step, title: '' },
      { ...step, target: { role: 5 } },
      { ...step, done: { type: 'page' } },
      { ...step, done: { type: 'state', target: step.target } },
      'x',
      null,
    ];
    for (const s of bad) {
      expect(BgToPageSchema.safeParse({ ...render, step: s }).success).toBe(false);
    }
  });

  it('RENDER の step は説明文や画像を持たない（落ちる）', () => {
    const parsed = parseBgToPage({
      ...render,
      step: { ...step, body: '説明', media: { src: 'a.png', alt: 'x' }, url: { origin: 'https://a' } },
    });
    if (parsed?.type !== 'RENDER') throw new Error('RENDER が受理されない');
    expect(parsed.step).not.toHaveProperty('body');
    expect(parsed.step).not.toHaveProperty('media');
    expect(parsed.step).not.toHaveProperty('url');
  });

  it('toPageStep は page の done を含めず、element・state の done を残す', () => {
    const base = { kind: 'page' as const, tab: 'main', id: 'a', title: 'A', body: '説明' };
    expect(toPageStep({ ...base, done: { type: 'page', url: { origin: 'https://a' } } }).done).toBeUndefined();
    const target = { role: 'button' };
    expect(toPageStep({ ...base, done: { type: 'element', target } }).done).toEqual(
      expect.objectContaining({ type: 'element', target }),
    );
    expect(toPageStep({ ...base, done: { type: 'state', target, state: 'filled' } }).done).toEqual(
      expect.objectContaining({ type: 'state', state: 'filled' }),
    );
    expect(toPageStep({ ...base })).not.toHaveProperty('body');
  });
});

describe('バックグラウンド → サイドパネル', () => {
  const view = {
    status: 'running',
    pauseReason: null,
    sessionId: 's1',
    gen: 1,
    tour: { id: 't', name: 'ツアー', hash: 'h', origins: ['https://a.example'], source: 'imported' },
    steps: [{ id: 'a', title: 'A', kind: 'page' }],
    stepIndex: 0,
    tabStatus: {
      role: 'main',
      status: 'missing',
      candidates: [{ tabId: 1, title: 'タブ', windowId: 2, boundRole: null }],
      attended: false,
      selected: false,
    },
    overlayHidden: false,
    hint: { met: false, unsupported: false, stopped: false },
    saveError: false,
    notice: 'restartedFromFirst',
    catalog: [
      {
        id: 't',
        name: 'ツアー',
        description: null,
        stepCount: 1,
        origins: ['https://a.example'],
        source: 'bundled',
        hasPermission: true,
        needsReview: false,
        progress: { stepIndex: 0, stepId: 'a', savedAt: 1 },
      },
    ],
    ui: { enabled: true, mode: 'expanded', width: 320 },
    logLevel: 'warn',
  };

  it('PanelView と TOUR_STATE_CHANGED が検証できる', () => {
    expect(PanelViewSchema.safeParse(view).success).toBe(true);
    expect(parseBgToPanel({ type: 'TOUR_STATE_CHANGED', view })?.type).toBe('TOUR_STATE_CHANGED');
    expect(parseBgToPanel({ type: 'TOUR_STATE_CHANGED', view: { ...view, status: 'x' } })).toBeNull();
  });
});

describe('受け付け条件の表', () => {
  it('sessionId を持つ操作ごとに、必要な一致が決まっている', () => {
    expect(OP_REQUIREMENTS.STOP).toBe('session');
    expect(OP_REQUIREMENTS.SET_OVERLAY).toBe('session');
    expect(OP_REQUIREMENTS.GOTO).toBe('sessionGen');
    expect(Object.keys(OP_REQUIREMENTS)).toHaveLength(12);
  });
});

describe('捨てたときの扱い', () => {
  it('T-MSG-21: 内容を記録せず、出来事の名前と理由コードだけを debug に残す', () => {
    const log = logger();
    parsePanelToBg({ type: 'GOTO', to: 'https://secret.example', secret: 'x' }, PANEL, EXT, log);
    parsePanelToBg(panelMessages.STOP, { url: 'https://evil.example/?q=secret' }, EXT, log);
    parsePageToBg('secret-text', log);
    expect(log.calls).toEqual([
      ['error', { name: 'ZodError', reason: 'message' }],
      ['error', { name: 'ZodError', reason: 'permission' }],
      ['error', { name: 'ZodError', reason: 'message' }],
    ]);
    expect(JSON.stringify(log.calls)).not.toContain('secret');
  });

  it('T-MSG-22: 捨てても例外が出ず、続くメッセージの処理を妨げない', () => {
    const throwing: DropLogger = {
      debug: () => {
        throw new Error('log failed');
      },
    };
    expect(() => parsePanelToBg(null, PANEL, EXT, throwing)).not.toThrow();
    expect(parsePanelToBg(null, PANEL, EXT, throwing)).toBeNull();
    const hostile = {
      get type(): string {
        throw new Error('getter');
      },
    };
    expect(parsePageToBg(hostile, throwing)).toBeNull();
    expect(parsePageToBg(pageMessages.HELLO, throwing)).not.toBeNull();
  });
});
