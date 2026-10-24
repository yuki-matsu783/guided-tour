/**
 * 状態管理：受け付けと破棄（T-SES-01〜18）、opId の重複排除（T-SES-19〜25）、確定と保存の順序（T-SES-26〜34）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PageSeqSchema } from '../../shared/ids/index.ts';
import type { PageToBg, PanelToBg } from '../../shared/messages/index.ts';
import {
  Crash,
  ROLE_TAB,
  SENDER_DOC,
  cur,
  createEnv,
  freshOp,
  gen as mkGen,
  gotoMsg,
  makeTour,
  opId,
  sender,
  sid,
  startBound,
  startTour,
  type Env,
} from './testkit.ts';

async function running(): Promise<Env> {
  const env = createEnv();
  await startBound(env);
  return env;
}

function report(env: Env, over: { gen?: number; pageSeq?: number; sessionId?: string } = {}): PageToBg {
  const st = env.state();
  if (st === null) throw new Error('状態がない');
  return {
    type: 'HINT_STATE',
    sessionId: over.sessionId === undefined ? st.sessionId : sid(over.sessionId),
    gen: over.gen === undefined ? st.gen : mkGen(over.gen),
    pageSeq: PageSeqSchema.parse(over.pageSeq ?? st.pageSeq),
    met: true,
    unsupported: false,
  };
}

const SUMMARY = { found: true, tier: 1 as const, topTier: 1 as const, reasons: [], counts: [] };

describe('受け付けと破棄', () => {
  it('T-SES-01: STOP・PAUSE・RESUME・RESTART・RESUME_NEW・SET_OVERLAY は sessionId が一致するときだけ受け付けられる', async () => {
    const cases: ((env: Env) => PanelToBg)[] = [
      (env) => ({ type: 'PAUSE', sessionId: cur(env).sessionId, opId: freshOp() }),
      (env) => ({ type: 'RESUME', sessionId: cur(env).sessionId, opId: freshOp() }),
      (env) => ({ type: 'RESTART', sessionId: cur(env).sessionId, opId: freshOp() }),
      (env) => ({ type: 'RESUME_NEW', mode: 'restart', sessionId: cur(env).sessionId, opId: freshOp() }),
      (env) => ({ type: 'SET_OVERLAY', hidden: true, sessionId: cur(env).sessionId, opId: freshOp() }),
      (env) => ({ type: 'STOP', sessionId: cur(env).sessionId, opId: freshOp() }),
    ];
    for (const make of cases) {
      const env = await running();
      const res = await env.session.handlePanel(make(env));
      expect(res.status).not.toBe('discarded');
    }
    const env = await running();
    const res = await env.session.handlePanel({ type: 'SET_OVERLAY', hidden: true, sessionId: cur(env).sessionId, opId: freshOp() });
    expect(res).toEqual({ status: 'done' });
  });

  it('T-SES-02: sessionId が違う操作は、状態を変えず、debug に理由コードだけを記録する', async () => {
    const env = await running();
    const before = JSON.stringify(env.state());
    env.logs.length = 0;
    const res = await env.session.handlePanel({ type: 'STOP', sessionId: sid('other'), opId: freshOp() });
    expect(res).toEqual({ status: 'discarded', reason: 'staleSession' });
    expect(JSON.stringify(env.state())).toBe(before);
    expect(env.logs).toEqual([{ level: 'debug', event: 'session.discard', fields: { reason: 'staleSession' } }]);
  });

  it('T-SES-03: ツアー A の STOP が、ツアー B の開始後に届いても、ツアー B に作用しない', async () => {
    const env = createEnv();
    env.catalog.set(makeTour({ id: 't2' }), 'h2');
    await startTour(env, false, 't1');
    const staleStop: PanelToBg = { type: 'STOP', sessionId: cur(env).sessionId, opId: freshOp() };
    await env.session.handlePanel({ type: 'STOP', sessionId: cur(env).sessionId, opId: freshOp() });
    await startTour(env, false, 't2');
    const res = await env.session.handlePanel(staleStop);
    expect(res.status).toBe('discarded');
    expect(env.state()?.status).toBe('running');
    expect(env.state()?.tourId).toBe('t2');
  });

  it('T-SES-04: GOTO・BIND_TAB・OPEN_IN・FOCUS_ROLE・RECHECK・SCROLL_TO_TARGET は sessionId と gen の両方が一致するとき受け付けられる', async () => {
    const make = (env: Env): PanelToBg[] => {
      const { sessionId, gen } = cur(env);
      return [
        { type: 'GOTO', to: 1, sessionId, gen, opId: freshOp() },
        { type: 'BIND_TAB', tabId: 11, force: false, sessionId, gen, opId: freshOp() },
        { type: 'OPEN_IN', mode: 'new', sessionId, gen, opId: freshOp() },
        { type: 'FOCUS_ROLE', sessionId, gen, opId: freshOp() },
        { type: 'RECHECK', sessionId, gen, opId: freshOp() },
        { type: 'SCROLL_TO_TARGET', sessionId, gen, opId: freshOp() },
      ];
    };
    for (let i = 0; i < 6; i++) {
      const env = await running();
      const msg = make(env)[i];
      if (msg === undefined) throw new Error('範囲外');
      const res = await env.session.handlePanel(msg);
      expect(res.status).not.toBe('discarded');
    }
  });

  it('T-SES-05: gen だけが違う操作は捨てられる', async () => {
    const env = await running();
    const { sessionId } = cur(env);
    const stale = (type: 'RECHECK' | 'FOCUS_ROLE' | 'SCROLL_TO_TARGET' | 'OPEN_IN' | 'BIND_TAB' | 'GOTO'): PanelToBg => {
      const g = cur(env).gen - 1;
      const base = { sessionId, gen: mkGen(g), opId: freshOp() };
      switch (type) {
        case 'GOTO':
          return { type, to: 1, ...base };
        case 'BIND_TAB':
          return { type, tabId: 12, force: false, ...base };
        case 'OPEN_IN':
          return { type, mode: 'new', ...base };
        default:
          return { type, ...base };
      }
    };
    for (const t of ['RECHECK', 'FOCUS_ROLE', 'SCROLL_TO_TARGET', 'OPEN_IN', 'BIND_TAB', 'GOTO'] as const) {
      const res = await env.session.handlePanel(stale(t));
      expect(res).toEqual({ status: 'discarded', reason: 'staleGen' });
    }
    expect(env.state()?.gen).toBe(1);
  });

  it('T-SES-06: ツアー A の OPEN_IN が、ツアー B の開始後に届いても、ツアー B に作用しない', async () => {
    const env = createEnv();
    env.catalog.set(makeTour({ id: 't2' }), 'h2');
    await startTour(env, false, 't1');
    const { sessionId, gen } = cur(env);
    const staleOpen: PanelToBg = { type: 'OPEN_IN', mode: 'new', sessionId, gen, opId: freshOp() };
    await env.session.handlePanel({ type: 'STOP', sessionId, opId: freshOp() });
    await startTour(env, false, 't2');
    const res = await env.session.handlePanel(staleOpen);
    expect(res.status).toBe('discarded');
    expect(env.tabs.opened).toEqual([]);
    expect(env.state()?.tabs).toEqual({});
  });

  it('T-SES-07: ページ側からの操作は、役割のタブ・frameId 0・記録済みの documentId のときだけ受け付けられる', async () => {
    const env = await running();
    const { sessionId, gen } = cur(env);
    const msgs: PageToBg[] = [
      { type: 'SET_UI', mode: 'minimized' },
      { type: 'SET_OVERLAY', hidden: true, sessionId, opId: freshOp() },
      { type: 'SCROLL_TO_TARGET', sessionId, gen, opId: freshOp() },
      { type: 'GOTO', to: 1, sessionId, gen, opId: freshOp() },
    ];
    for (const m of msgs) {
      const res = await env.session.handlePage(m, sender());
      expect(res).toEqual({ status: 'done' });
    }
    expect(env.state()?.stepIndex).toBe(1);
  });

  it('T-SES-08: ページ側からの操作で、sender.tab.id が役割のタブでないとき、捨てられる', async () => {
    const env = await running();
    const res = await env.session.handlePage(
      { type: 'GOTO', to: 1, sessionId: cur(env).sessionId, gen: cur(env).gen, opId: freshOp() },
      sender(77),
    );
    expect(res).toEqual({ status: 'discarded', reason: 'senderMismatch' });
    expect(env.state()?.stepIndex).toBe(0);
  });

  it('T-SES-09: ページ側からの操作で、frameId が0でないとき（iframe）、捨てられる', async () => {
    const env = await running();
    const res = await env.session.handlePage(
      { type: 'SET_OVERLAY', hidden: true, sessionId: cur(env).sessionId, opId: freshOp() },
      sender(ROLE_TAB, SENDER_DOC, 3),
    );
    expect(res).toEqual({ status: 'discarded', reason: 'senderMismatch' });
    expect(env.state()?.overlayHidden).toBe(false);
  });

  it('T-SES-10: ページ側からの操作で、documentId が記録済みのものと違うとき、捨てられる', async () => {
    const env = await running();
    const res = await env.session.handlePage(
      { type: 'SET_UI', mode: 'minimized' },
      sender(ROLE_TAB, 'another-document'),
    );
    expect(res).toEqual({ status: 'discarded', reason: 'senderMismatch' });
    const noDoc = await env.session.handlePage({ type: 'SET_UI', mode: 'minimized' }, { tabId: ROLE_TAB, frameId: 0, documentId: undefined });
    expect(noDoc.status).toBe('discarded');
  });

  it('T-SES-11: ページ側からの報告は、sessionId・gen・pageSeq がすべて一致するときだけ受け付けられる', async () => {
    const env = await running();
    const { sessionId, gen } = cur(env);
    const pageSeq = PageSeqSchema.parse(env.state()?.pageSeq ?? 0);
    expect(await env.session.handlePage(report(env), sender())).toEqual({ status: 'done' });
    const loc = await env.session.handlePage({ type: 'LOCATE_RESULT', sessionId, gen, pageSeq, result: SUMMARY }, sender());
    expect(loc).toEqual({ status: 'done' });
    expect(env.records).toHaveLength(1);
    expect(env.records[0]).toMatchObject({ tourId: 't1', stepId: 's1', sessionId, gen });
    const badSender = await env.session.handlePage(report(env), sender(55));
    expect(badSender.status).toBe('discarded');
  });

  it('T-SES-12: 報告の pageSeq が現在と違うとき、捨てられる', async () => {
    const env = await running();
    const res = await env.session.handlePage(report(env, { pageSeq: 9 }), sender());
    expect(res).toEqual({ status: 'discarded', reason: 'staleReport' });
    expect(env.state()?.hint.met).toBe(false);
  });

  it('T-SES-13: 報告の gen が現在と違うとき、捨てられる', async () => {
    const env = await running();
    const res = await env.session.handlePage(report(env, { gen: 7 }), sender());
    expect(res).toEqual({ status: 'discarded', reason: 'staleReport' });
    expect(env.records).toEqual([]);
  });

  it('T-SES-14: 報告の sessionId が違うとき、捨てられる', async () => {
    const env = await running();
    const res = await env.session.handlePage(report(env, { sessionId: 'old-session' }), sender());
    expect(res).toEqual({ status: 'discarded', reason: 'staleSession' });
  });

  async function threeFourThree(env: Env): Promise<PageToBg> {
    // gen 3（ステップ 1）の報告を作ってから、4 へ移り 3 へ戻る（gen 5）
    await env.session.handlePanel(gotoMsg(env, 1));
    await env.session.handlePanel(gotoMsg(env, 0));
    expect(env.state()?.gen).toBe(3);
    const pending = report(env);
    await env.session.handlePanel(gotoMsg(env, 1));
    await env.session.handlePanel(gotoMsg(env, 0));
    expect(env.state()?.gen).toBe(5);
    return pending;
  }

  it('T-SES-15: gen 3 の報告が保留中に 4 へ移り 3 へ戻ったとき（gen は5）、gen 3 の古い報告が捨てられる', async () => {
    const env = await running();
    const pending = await threeFourThree(env);
    const res = await env.session.handlePage(pending, sender());
    expect(res).toEqual({ status: 'discarded', reason: 'staleReport' });
    expect(env.state()?.hint.met).toBe(false);
  });

  it('T-SES-16: 3→4→3 の後でも、gen 5 の新しい報告は受け付けられる', async () => {
    const env = await running();
    await threeFourThree(env);
    const res = await env.session.handlePage(report(env), sender());
    expect(res).toEqual({ status: 'done' });
    expect(env.state()?.hint).toEqual({ gen: 5, met: true, unsupported: false });
  });

  it('T-SES-17: 本文の自己申告（tabId など）ではなく sender で送信元が確かめられる', async () => {
    const env = await running();
    const base: PageToBg = { type: 'GOTO', to: 1, sessionId: cur(env).sessionId, gen: cur(env).gen, opId: freshOp() };
    const lying: PageToBg = Object.assign({}, base, { tabId: ROLE_TAB, frameId: 0, documentId: SENDER_DOC });
    expect((await env.session.handlePage(lying, sender(77))).status).toBe('discarded');
    const honest: PageToBg = Object.assign({}, base, { opId: freshOp(), tabId: 999 });
    expect(await env.session.handlePage(honest, sender())).toEqual({ status: 'done' });
  });

  it('T-SES-18: 実行中の状態がないとき、sessionId を伴う操作が捨てられる', async () => {
    const env = createEnv();
    const res = await env.session.handlePanel({ type: 'STOP', sessionId: sid('whatever'), opId: freshOp() });
    expect(res).toEqual({ status: 'discarded', reason: 'staleSession' });
    const goto = await env.session.handlePanel({
      type: 'GOTO',
      to: 1,
      sessionId: sid('whatever'),
      gen: mkGen(1),
      opId: freshOp(),
    });
    expect(goto.status).toBe('discarded');
  });
});

describe('opId の重複排除', () => {
  it('T-SES-19: 同じ opId の GOTO が2回届いたとき、1回だけ処理され、gen は1しか増えない', async () => {
    const env = await running();
    const msg = gotoMsg(env, 1, opId('dup-1'));
    const first = await env.session.handlePanel(msg);
    const second = await env.session.handlePanel(msg);
    expect(second).toEqual(first);
    expect(env.state()?.gen).toBe(2);
    expect(env.logs.filter((l) => l.event === 'session.goto')).toHaveLength(1);
  });

  it('T-SES-20: パネルとミニガイドから同じ gen の GOTO がほぼ同時に届いたとき、先の1回だけ処理され、後は捨てられる', async () => {
    const env = await running();
    const { sessionId, gen } = cur(env);
    const [a, b] = await Promise.all([
      env.session.handlePanel({ type: 'GOTO', to: 1, sessionId, gen, opId: opId('p1') }),
      env.session.handlePage({ type: 'GOTO', to: 1, sessionId, gen, opId: opId('p2') }, sender()),
    ]);
    expect(a).toEqual({ status: 'done' });
    expect(b).toEqual({ status: 'discarded', reason: 'staleGen' });
    expect(env.state()?.gen).toBe(2);
    expect(env.state()?.stepIndex).toBe(1);
  });

  it('T-SES-21: 処理した opId が recentOpIds に加えられ、storage.session に保存される', async () => {
    const env = await running();
    await env.session.handlePanel(gotoMsg(env, 1, opId('saved-1')));
    expect(env.state()?.recentOpIds).toContain(opId('saved-1'));
  });

  async function overlayOps(env: Env, count: number): Promise<void> {
    for (let i = 1; i <= count; i++) {
      await env.session.handlePanel({
        type: 'SET_OVERLAY',
        hidden: i % 2 === 1,
        sessionId: cur(env).sessionId,
        opId: opId(`ov-${String(i)}`),
      });
    }
  }

  it('T-SES-22: recentOpIds が51件目で、最も古いものから押し出され、直近50件だけが残る', async () => {
    const env = await running();
    await overlayOps(env, 51);
    const ids = env.state()?.recentOpIds ?? [];
    expect(ids).toHaveLength(50);
    expect(ids).not.toContain(opId('ov-1'));
    expect(ids).toContain(opId('ov-2'));
    expect(ids).toContain(opId('ov-51'));
  });

  it('T-SES-23: 直近50件の opId は重複として捨てられ、51件前の opId は新規として扱われる', async () => {
    const env = await running();
    await overlayOps(env, 51);
    expect(env.state()?.overlayHidden).toBe(true);
    const sessionId = cur(env).sessionId;
    await env.session.handlePanel({ type: 'SET_OVERLAY', hidden: false, sessionId, opId: opId('ov-51') });
    expect(env.state()?.overlayHidden).toBe(true);
    await env.session.handlePanel({ type: 'SET_OVERLAY', hidden: false, sessionId, opId: opId('ov-1') });
    expect(env.state()?.overlayHidden).toBe(false);
  });

  it('T-SES-24: Service Worker の再起動後も、recentOpIds から重複が判定される', async () => {
    const env = await running();
    const sessionId = cur(env).sessionId;
    await env.session.handlePanel({ type: 'SET_OVERLAY', hidden: true, sessionId, opId: opId('before-restart') });
    const next = env.restart();
    await next.recover();
    const res = await next.handlePanel({ type: 'SET_OVERLAY', hidden: false, sessionId, opId: opId('before-restart') });
    expect(res.status).toBe('done');
    expect(env.state()?.overlayHidden).toBe(true);
    expect(env.logs.some((l) => l.event === 'session.discard' && JSON.stringify(l.fields) === '{"reason":"duplicateOp"}')).toBe(true);
  });

  it('T-SES-25: 捨てられた操作（識別子の不一致）の opId は、recentOpIds に加えられない', async () => {
    const env = await running();
    await env.session.handlePanel({ type: 'STOP', sessionId: sid('stale'), opId: opId('stale-op') });
    await env.session.handlePanel({
      type: 'GOTO',
      to: 1,
      sessionId: cur(env).sessionId,
      gen: mkGen(9),
      opId: opId('stale-gen-op'),
    });
    const ids = env.state()?.recentOpIds ?? [];
    expect(ids).not.toContain(opId('stale-op'));
    expect(ids).not.toContain(opId('stale-gen-op'));
  });
});

describe('確定と保存の順序', () => {
  async function recorded(): Promise<{ env: Env; crash: Crash }> {
    const env = await running();
    const crash = new Crash();
    env.withCrash(crash);
    await env.session.recover();
    crash.events.length = 0;
    return { env, crash };
  }
  const interesting = (events: string[]): string[] =>
    events.filter((e) => ['session.set', 'local.set', 'tabs.send', 'tabs.broadcast', 'panel'].includes(e));

  it('T-SES-26: storage.session への書き込みが、storage.local への進捗の書き込みより先に行われる', async () => {
    const { env, crash } = await recorded();
    await env.session.handlePanel(gotoMsg(env, 1));
    const events = interesting(crash.events);
    expect(events.indexOf('session.set')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('session.set')).toBeLessThan(events.indexOf('local.set'));
  });

  it('T-SES-27: 外への作用（RENDER・CLEAR・サイドパネルへの通知）が、storage.session への書き込みの後にだけ行われる', async () => {
    const { env, crash } = await recorded();
    await env.session.handlePanel(gotoMsg(env, 1));
    const events = interesting(crash.events);
    const firstSet = events.indexOf('session.set');
    for (const e of ['tabs.send', 'panel']) {
      expect(events.indexOf(e)).toBeGreaterThan(firstSet);
    }
    const crash2 = new Crash();
    env.withCrash(crash2);
    await env.session.handlePanel({ type: 'PAUSE', sessionId: cur(env).sessionId, opId: freshOp() });
    const ev2 = interesting(crash2.events);
    expect(ev2.indexOf('tabs.broadcast')).toBeGreaterThan(ev2.indexOf('session.set'));
  });

  it('T-SES-28: 応答が、外への作用の後に返される', async () => {
    const { env, crash } = await recorded();
    await env.session.handlePanel(gotoMsg(env, 1));
    crash.events.push('response');
    const events = interesting(crash.events.concat());
    expect(events.at(-1)).toBe('panel');
    expect(crash.events.at(-1)).toBe('response');
  });

  it('T-SES-29: 進捗が { sessionId, gen, stepId, stepIndex, savedAt } の形で storage.local に書かれる', async () => {
    const env = await running();
    await env.session.handlePanel(gotoMsg(env, 1));
    const { sessionId } = cur(env);
    const saved = env.progress().t1;
    expect(saved).toMatchObject({ sessionId, gen: 2, stepId: 's2', stepIndex: 1 });
    expect(Object.keys(saved ?? {}).sort()).toEqual(['gen', 'savedAt', 'sessionId', 'stepId', 'stepIndex']);
  });

  it('T-SES-30: 同じ sessionId で、より大きい gen の進捗がすでにあるとき、進捗が書かれない', async () => {
    const env = await running();
    const { sessionId } = cur(env);
    const existing = { sessionId, gen: 99, stepId: 's4', stepIndex: 3, savedAt: 1 };
    env.localArea.data.set('progress', { t1: existing });
    await env.session.handlePanel(gotoMsg(env, 1));
    expect(env.progress().t1).toEqual(existing);
  });

  it('T-SES-31: 別の sessionId の進捗があるとき、それは上書きされる', async () => {
    const env = await running();
    env.localArea.data.set('progress', {
      t1: { sessionId: 'older', gen: 99, stepId: 's4', stepIndex: 3, savedAt: 1 },
    });
    await env.session.handlePanel(gotoMsg(env, 1));
    expect(env.progress().t1).toMatchObject({ sessionId: cur(env).sessionId, gen: 2, stepId: 's2' });
  });

  it('T-SES-32: 完了のとき、状態が ended（sessionId を残す）として確定されてから、進捗が削除される', async () => {
    const { env, crash } = await recorded();
    const { sessionId } = cur(env);
    await env.session.handlePanel(gotoMsg(env, 4));
    const events = crash.events.filter((e) => e === 'session.set' || e === 'local.set');
    expect(events).toEqual(['session.set', 'local.set']);
    expect(env.state()).toMatchObject({ status: 'ended', sessionId });
    expect(env.progress().t1).toBeUndefined();
  });

  it('T-SES-33: 操作が直列化キューで順に処理され、2つの操作が並行して状態を書き換えない', async () => {
    const env = await running();
    env.sessionArea.delay = true;
    env.localArea.delay = true;
    const { sessionId, gen } = cur(env);
    const results = await Promise.all([
      env.session.handlePanel({ type: 'GOTO', to: 1, sessionId, gen, opId: freshOp() }),
      env.session.handlePanel({ type: 'GOTO', to: 2, sessionId, gen, opId: freshOp() }),
      env.session.handlePanel({ type: 'SET_OVERLAY', hidden: true, sessionId, opId: freshOp() }),
      env.session.handlePanel({ type: 'SET_OVERLAY', hidden: false, sessionId, opId: freshOp() }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['done', 'discarded', 'done', 'done']);
    expect(env.sessionArea.maxConcurrent).toBe(1);
    expect(env.localArea.maxConcurrent).toBe(1);
    expect(env.state()).toMatchObject({ stepIndex: 1, gen: 2, overlayHidden: false });
  });

  it('T-SES-34: キューの中で、YAML・zip・画像の解析のような重い処理が行われない', () => {
    const dir = new URL('.', import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'testkit.ts');
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync(new URL(f, dir), 'utf8');
      const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] ?? '');
      for (const spec of imports) {
        expect(spec).not.toMatch(/yaml|fflate|markdown|core\/package|core\/markdown/);
      }
    }
  });
});

