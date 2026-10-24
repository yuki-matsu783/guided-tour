/**
 * ロガーのテスト（T-LOG-01〜32 のうち、検査・例外・レベル・コンソール・送信）。
 * まとめ書き・削除・書き出しは background/logstore のテストで確かめる。
 */
import { describe, expect, it } from 'vitest';
import { createLevelSource, type LevelChangeEvent } from './level.ts';
import { createLogger, createRawLogger, type ConsoleLike } from './logger.ts';
import { createMessageSink, type LogMessage } from './message.ts';
import { errorFields } from './events.ts';
import type { Ctx, Level } from './primitives.ts';
import type { LogEntry } from './validate.ts';

interface ConsoleCall {
  level: Level;
  args: unknown[];
}

function setup(initial: Level = 'debug', ctx: Ctx = 'background') {
  const entries: LogEntry[] = [];
  const calls: ConsoleCall[] = [];
  const spy = (level: Level) => (...args: unknown[]) => {
    calls.push({ level, args });
  };
  const fakeConsole: ConsoleLike = {
    error: spy('error'),
    warn: spy('warn'),
    info: spy('info'),
    debug: spy('debug'),
  };
  const state = { level: initial };
  const deps = { now: () => 1234, console: fakeConsole };
  const sink = (entry: LogEntry) => {
    entries.push(entry);
  };
  const logger = createLogger(ctx, sink, () => state.level, deps);
  const raw = createRawLogger(ctx, sink, () => state.level, deps);
  return { entries, calls, state, logger, raw, sink };
}

const quiet: ConsoleLike = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
};

const everything = (s: { entries: LogEntry[]; calls: ConsoleCall[] }) =>
  JSON.stringify([s.entries, s.calls]);

describe('出来事のスキーマと検査', () => {
  it('T-LOG-01: locator.result がそのまま受理され記録される', () => {
    const s = setup();
    const fields = {
      tier: 2,
      topTier: 1,
      reasons: ['degraded'],
      counts: [{ tier: 1, collected: 0, required: 0, visible: 0 }],
    } as const;
    s.logger.info('locator.result', {
      tier: 2,
      topTier: 1,
      reasons: ['degraded'],
      counts: [{ tier: 1, collected: 0, required: 0, visible: 0 }],
    });
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]?.event).toBe('locator.result');
    expect(s.entries[0]?.fields).toEqual(fields);
  });

  it('T-LOG-02: tabs.status がそのまま受理され記録される', () => {
    const s = setup();
    s.logger.info('tabs.status', { role: 'main', status: 'ok' });
    expect(s.entries[0]?.fields).toEqual({ role: 'main', status: 'ok' });
  });

  it('T-LOG-03: session.goto がそのまま受理され記録される', () => {
    const s = setup();
    s.logger.info('session.goto', { from: 1, to: 2, accepted: true });
    expect(s.entries[0]?.fields).toEqual({ from: 1, to: 2, accepted: true });
  });

  it('T-LOG-04: スキーマにない出来事名は内容を捨て、logger.invalid が名前だけで記録される', () => {
    const s = setup();
    s.raw.log('info', 'no.such.event', { a: 1 });
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]?.event).toBe('logger.invalid');
    expect(s.entries[0]?.fields).toEqual({ event: 'unknown' });
  });

  it('T-LOG-05: スキーマにない項目（url など）があると内容を捨て、logger.invalid が記録される', () => {
    const s = setup();
    s.raw.log('info', 'tabs.status', { role: 'main', status: 'ok', url: 'https://example.com/x' });
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]?.event).toBe('logger.invalid');
    expect(s.entries[0]?.fields).toEqual({ event: 'tabs.status' });
  });

  it('T-LOG-06: 項目の型が違うと内容を捨て、logger.invalid が記録される', () => {
    const s = setup();
    s.raw.log('info', 'session.goto', { from: 'one', to: 2, accepted: true });
    expect(s.entries.map((e) => e.event)).toEqual(['logger.invalid']);
  });

  it('T-LOG-07: 列挙値の項目に列挙にない文字列を渡すと、内容を捨て、logger.invalid が記録される', () => {
    const s = setup();
    s.raw.log('info', 'tabs.status', { role: 'main', status: 'Delete account' });
    expect(s.entries.map((e) => e.event)).toEqual(['logger.invalid']);
    expect(everything(s)).not.toContain('Delete account');
  });

  it('T-LOG-08: logger.invalid の記録には出来事の名前だけがあり、渡された値は含まれない', () => {
    const s = setup();
    s.raw.log('info', 'tabs.status', { role: 'secret-role-value', status: 'bad-status-value' });
    expect(s.entries[0]?.fields).toEqual({ event: 'tabs.status' });
    expect(everything(s)).not.toContain('secret-role-value');
    expect(everything(s)).not.toContain('bad-status-value');
  });

  it('T-LOG-09: ページの文字列に見える長い出来事名は記録されず、固定の unknown になる', () => {
    const s = setup();
    const long = '「アカウントを削除」'.repeat(50);
    s.raw.log('info', long, {});
    expect(s.entries[0]?.fields).toEqual({ event: 'unknown' });
    expect(everything(s)).not.toContain('アカウント');
  });

  it('T-LOG-10: 必須の項目が足りないと捨てられ、logger.invalid が記録される', () => {
    const s = setup();
    s.raw.log('info', 'session.goto', { from: 1, to: 2 });
    expect(s.entries.map((e) => e.event)).toEqual(['logger.invalid']);
  });

  it('T-LOG-11: 入力値・ページの文字列・URL を値に持つ項目は、記録にもコンソールにも含まれない', () => {
    const s = setup();
    s.raw.log('info', 'tabs.status', { role: 'main', status: 'https://example.com/a?token=abc' });
    s.raw.log('info', 'import.result', { result: 'imported', files: 1, bytes: 1, name: 'パスワード123' });
    const text = everything(s);
    expect(text).not.toContain('example.com');
    expect(text).not.toContain('token=abc');
    expect(text).not.toContain('パスワード123');
  });

  it('T-LOG-12: 記録された各行に ts・level・ctx・event・fields がある', () => {
    const s = setup('debug', 'content');
    s.logger.warn('session.stop', {});
    expect(s.entries[0]).toEqual({
      ts: 1234,
      level: 'warn',
      ctx: 'content',
      event: 'session.stop',
      fields: {},
    });
  });
});

describe('例外', () => {
  it('T-LOG-13: 例外は error.name と理由コードだけが記録される', () => {
    const s = setup();
    s.logger.error('error', errorFields(new TypeError('boom'), 'storage'));
    expect(s.entries[0]?.event).toBe('error');
    expect(s.entries[0]?.fields).toEqual({ name: 'TypeError', reason: 'storage' });
  });

  it('T-LOG-14: 例外のメッセージの URL やページの文字列は、記録にもコンソールにも含まれない', () => {
    const s = setup();
    const e = new Error('failed at https://example.com/path for 「注文を確定」');
    s.logger.error('error', errorFields(e, 'unknown'));
    const text = everything(s);
    expect(text).not.toContain('example.com');
    expect(text).not.toContain('注文を確定');
  });

  it('T-LOG-15: 例外のスタックトレースは記録されない', () => {
    const s = setup();
    const e = new Error('x');
    s.logger.error('error', errorFields(e));
    expect(Object.keys(s.entries[0]?.fields ?? {}).sort()).toEqual(['name', 'reason']);
    expect(everything(s)).not.toContain('logger.test');
  });

  it('T-LOG-16: 理由コードが一覧にないと記録されず、logger.invalid が記録される', () => {
    const s = setup();
    s.raw.log('error', 'error', { name: 'Error', reason: 'page says hello' });
    expect(s.entries.map((e) => e.event)).toEqual(['logger.invalid']);
    expect(s.entries[0]?.fields).toEqual({ event: 'error' });
  });

  it('T-LOG-17: Error でない値は、名前と理由コード以外は記録されない', () => {
    const s = setup();
    s.logger.error('error', errorFields('https://example.com secret'));
    s.logger.error('error', errorFields({ name: 'Custom', message: 'm', url: 'https://a.example' }));
    s.logger.error('error', errorFields(Object.assign(new Error('m'), { name: '「購入」' })));
    expect(s.entries.map((e) => e.fields)).toEqual([
      { name: 'Unknown', reason: 'unknown' },
      { name: 'Unknown', reason: 'unknown' },
      { name: 'Unknown', reason: 'unknown' },
    ]);
    expect(everything(s)).not.toContain('example.com');
  });
});

describe('レベルによる出力', () => {
  const emitAll = (s: ReturnType<typeof setup>) => {
    s.logger.error('session.stop', {});
    s.logger.warn('session.stop', {});
    s.logger.info('session.stop', {});
    s.logger.debug('session.stop', {});
  };

  it('T-LOG-18: レベルが error のとき、error だけが出力される', () => {
    const s = setup('error');
    emitAll(s);
    expect(s.entries.map((e) => e.level)).toEqual(['error']);
  });

  it('T-LOG-19: レベルが warn のとき、error と warn が出力される', () => {
    const s = setup('warn');
    emitAll(s);
    expect(s.entries.map((e) => e.level)).toEqual(['error', 'warn']);
  });

  it('T-LOG-20: レベルが info のとき、error・warn・info が出力される', () => {
    const s = setup('info');
    emitAll(s);
    expect(s.entries.map((e) => e.level)).toEqual(['error', 'warn', 'info']);
  });

  it('T-LOG-21: レベルが debug のとき、4つとも出力される', () => {
    const s = setup('debug');
    emitAll(s);
    expect(s.entries.map((e) => e.level)).toEqual(['error', 'warn', 'info', 'debug']);
  });

  it('T-LOG-25: レベルで出力されない正しい出来事は、記録されず logger.invalid も出ない', () => {
    const s = setup('error');
    s.logger.info('tabs.status', { role: 'main', status: 'ok' });
    s.logger.debug('session.goto', { from: 0, to: 1, accepted: false });
    expect(s.entries).toHaveLength(0);
    expect(s.calls).toHaveLength(0);
  });

  it('T-LOG-25: 出力されないレベルの出来事でも、スキーマに合わなければ logger.invalid が記録される（検査が先）', () => {
    const s = setup('warn');
    s.raw.log('debug', 'session.goto', { from: 'one', to: 2, accepted: true });
    s.raw.log('info', 'tabs.status', { role: 'main', status: 'bad-status-value' });
    s.raw.log('debug', 'not.an.event', {});
    expect(s.entries.map((e) => [e.level, e.event, e.fields])).toEqual([
      ['warn', 'logger.invalid', { event: 'session.goto' }],
      ['warn', 'logger.invalid', { event: 'tabs.status' }],
      ['warn', 'logger.invalid', { event: 'unknown' }],
    ]);
    expect(everything(s)).not.toContain('bad-status-value');
  });
});

function fakeStorage(initial: unknown) {
  const listeners: Parameters<LevelChangeEvent['addListener']>[0][] = [];
  const onChanged: LevelChangeEvent = {
    addListener: (l) => {
      listeners.push(l);
    },
    removeListener: (l) => {
      listeners.splice(listeners.indexOf(l), 1);
    },
  };
  const storage = {
    get: (key: string) => Promise.resolve(initial === undefined ? {} : { [key]: initial }),
  };
  return { storage, onChanged, listeners };
}

describe('ログレベルの設定', () => {
  it('T-LOG-22: settings.logLevel が未設定のとき、既定の warn として動く', async () => {
    const f = fakeStorage(undefined);
    const source = createLevelSource(f);
    expect(source.get()).toBe('warn');
    await source.ready;
    expect(source.get()).toBe('warn');
    const f2 = fakeStorage({ miniGuide: {} });
    const s2 = createLevelSource(f2);
    await s2.ready;
    expect(s2.get()).toBe('warn');
  });

  it('T-LOG-23: 保存された値がありえない値のとき、既定の warn として動く', async () => {
    for (const bad of ['verbose', 3, null, { logLevel: 'trace' }]) {
      const source = createLevelSource(fakeStorage({ logLevel: bad }));
      await source.ready;
      expect(source.get()).toBe('warn');
    }
    const broken = createLevelSource(fakeStorage('not an object'));
    await broken.ready;
    expect(broken.get()).toBe('warn');
  });

  it('T-LOG-24: storage.onChanged で logLevel が変わると、次の出力から新しいレベルが使われる', async () => {
    const f = fakeStorage({ logLevel: 'error' });
    const source = createLevelSource(f);
    await source.ready;
    const s = setup();
    const logger = createLogger('background', (e) => s.entries.push(e), () => source.get(), {
      console: quiet,
    });
    logger.info('session.stop', {});
    expect(s.entries).toHaveLength(0);
    for (const l of f.listeners) l({ settings: { newValue: { logLevel: 'info' } } }, 'local');
    logger.info('session.stop', {});
    expect(s.entries).toHaveLength(1);
    // 他の領域の変更は無視する
    for (const l of f.listeners) l({ settings: { newValue: { logLevel: 'error' } } }, 'session');
    expect(source.get()).toBe('info');
  });
});

describe('コンソール出力', () => {
  it('T-LOG-26: コンソールには検査を通った出来事の項目だけが出る', () => {
    const s = setup();
    s.logger.info('tabs.status', { role: 'main', status: 'ok' });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.level).toBe('info');
    expect(JSON.stringify(s.calls[0]?.args)).toContain('tabs.status');
    expect(s.calls[0]?.args[1]).toEqual({ role: 'main', status: 'ok' });
  });

  it('T-LOG-27: 検査に通らなかった出来事は、内容が出ず logger.invalid だけが出る', () => {
    const s = setup();
    s.raw.log('info', 'tabs.status', { role: 'main', status: 'ok', note: 'ページの文字列' });
    expect(s.calls).toHaveLength(1);
    expect(JSON.stringify(s.calls[0]?.args)).toContain('logger.invalid');
    expect(JSON.stringify(s.calls)).not.toContain('ページの文字列');
  });

  it('T-LOG-28: 例外を記録するとき、コンソールにもメッセージは出ない', () => {
    const s = setup();
    s.logger.error('error', errorFields(new Error('secret message 注文'), 'unknown'));
    expect(JSON.stringify(s.calls)).not.toContain('secret message');
    expect(JSON.stringify(s.calls)).not.toContain('注文');
  });

  it('T-LOG-29: レベルが debug のとき、コンソールのすべての引数に URL の形の文字列がない', () => {
    const s = setup('debug');
    s.logger.debug('tabs.status', { role: 'main', status: 'ok' });
    s.logger.info('session.goto', { from: 1, to: 2, accepted: true });
    s.logger.error('error', errorFields(new Error('https://example.com/a'), 'message'));
    s.raw.log('debug', 'tabs.status', { role: 'main', status: 'https://example.com' });
    expect(s.calls.length).toBeGreaterThanOrEqual(4);
    for (const call of s.calls) {
      for (const arg of call.args) {
        expect(JSON.stringify(arg)).not.toMatch(/[a-z][a-z0-9+.-]*:\/\//i);
      }
    }
  });

  it('T-LOG-30: レベルで出力されない出来事は、コンソールにも出力されない', () => {
    const s = setup('warn');
    s.logger.info('session.stop', {});
    s.logger.debug('session.stop', {});
    expect(s.calls).toHaveLength(0);
    s.logger.warn('session.stop', {});
    expect(s.calls.map((c) => c.level)).toEqual(['warn']);
  });
});

describe('ページ側とサイドパネルからの送信', () => {
  for (const [id, ctx] of [
    ['T-LOG-31', 'content'],
    ['T-LOG-32', 'sidepanel'],
  ] as const) {
    it(`${id}: ${ctx} のロガーは、ログを LOG{entries[]} としてバックグラウンドへ送る`, () => {
      const sent: LogMessage[] = [];
      const logger = createLogger(
        ctx,
        createMessageSink((m) => {
          sent.push(m);
        }),
        () => 'debug',
        { now: () => 7, console: quiet },
      );
      logger.info('session.goto', { from: 0, to: 1, accepted: true });
      expect(sent).toEqual([
        {
          type: 'LOG',
          entries: [
            {
              ts: 7,
              level: 'info',
              ctx,
              event: 'session.goto',
              fields: { from: 0, to: 1, accepted: true },
            },
          ],
        },
      ]);
    });
  }

  it('送信が失敗（例外・拒否）しても呼び出し元に伝わらない', async () => {
    const throwing = createLogger(
      'content',
      createMessageSink(() => {
        throw new Error('no receiver');
      }),
      () => 'debug',
      { console: quiet },
    );
    const rejecting = createLogger(
      'content',
      createMessageSink(() => Promise.reject(new Error('no receiver'))),
      () => 'debug',
      { console: quiet },
    );
    expect(() => {
      throwing.info('session.stop', {});
      rejecting.info('session.stop', {});
    }).not.toThrow();
    await Promise.resolve();
  });
});

describe('第1段のレビュー指摘の修正（ロガー）', () => {
  it('R-LOG-3: errorFields は、name の getter が投げても Unknown を返す', () => {
    const e = new Error('x');
    Object.defineProperty(e, 'name', {
      get() {
        throw new Error('getter が投げた');
      },
    });
    expect(errorFields(e, 'storage')).toEqual({ name: 'Unknown', reason: 'storage' });
  });

  it('R-LOG-4: tabs.status の role は、ツアーの役割名（空でない文字列）を受け付ける', () => {
    const s = setup();
    for (const role of ['main', '管理画面', 'role with space', 'a'.repeat(64)]) {
      s.raw.log('info', 'tabs.status', { role, status: 'ok' });
    }
    expect(s.entries.map((e) => e.event)).toEqual(Array.from({ length: 4 }, () => 'tabs.status'));
  });

  it('R-LOG-4: 空・65文字以上・制御文字を含む役割名は受け付けず、logger.invalid になる', () => {
    const s = setup();
    for (const role of ['', 'a'.repeat(65), 'a\nb', 'a\u0000b', 'a\u007fb', 5]) {
      s.raw.log('info', 'tabs.status', { role, status: 'ok' });
    }
    expect(s.entries.map((e) => e.event)).toEqual(Array.from({ length: 6 }, () => 'logger.invalid'));
  });
});
