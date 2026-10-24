/**
 * ページ上の拡張機能の表示（ミニガイド・ハイライト・吹き出し・表示を戻すボタン）の検査と操作。
 *
 * 表示は閉じた Shadow DOM（`closed`）の中にあり、ページのスクリプトからも Playwright の locator からも触れない。
 * そこで CDP の `DOM.getDocument({ pierce: true })` で閉じた Shadow DOM の中の要素を取り、
 * 値の読み取りは `Runtime.callFunctionOn`、操作は `page.mouse`（実際の座標）で行う。
 * 利用者の実際の操作（`isTrusted`）として届くので、ミニガイドの「次へ」などが本当に動く。
 *
 * 使い方（`const ui = ownUi(page)`）:
 * - `ui.hostCount()`: ホスト要素（`[data-guided-tour-host]`）の数。0 なら、ページ上に何も出ていない。
 * - `ui.nodes(selector)` / `ui.node(selector)`: Shadow DOM の中の要素（`text`・`visible`・`disabled`・`rect`・`attrs`）。
 * - `ui.miniGuide()`: ミニガイドの状態（無ければ null）。`state`（expanded / bar）・`mode`・`width`・`step`（n/N）・`title`・`hint`・`buttons`。
 * - `ui.overlay()`: ハイライトと吹き出し（無ければ null）。`frame`（枠の矩形）・`bubble`（文言・矩形）・`restoreVisible`。
 * - `ui.click(selector)` / `ui.clickButton('次へ')`: 要素の中心を実際のマウスでクリックする。
 * - `rapidClick(page, x, y, count)`（単独の関数）: 同じ座標を `count` 回、実際のマウスで間を置かずに押す。CDP の入力イベントを
 *   待たずに続けて送る（`mouse.click` を並べるより速く、負荷が高くても間隔が開かない）。「連打」の確認用。
 * - `ui.hover(selector)` / `ui.moveAway()`: ポインターを要素の上へ・ページの左上へ動かす。
 * - `ui.focus(selector)`: 要素へフォーカスを移す（キーボード操作の確認用）。
 * - `ui.focused()`: Shadow DOM の中でフォーカスのある要素（無ければ null）。`label`（ボタンの文字か aria-label）・`focusVisible`・`outlineWidth`。
 * - `ui.tabTo(label)`: Tab キーを押して、`label`（文字列は完全一致、正規表現も可）の要素にフォーカスが来るまで進む（実際のキー入力。上限 40 回）。
 */
import type { CDPSession, Page } from '@playwright/test';
import { z } from 'zod';

const HOST_ATTRIBUTE = 'data-guided-tour-host';

export interface UiRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface UiNode {
  tag: string;
  text: string;
  hidden: boolean;
  disabled: boolean;
  /** 大きさがあり、display・visibility で隠れていない。 */
  visible: boolean;
  rect: UiRect;
  attrs: Record<string, string>;
}

export interface MiniGuideInfo {
  state: string;
  mode: string;
  width: number;
  /** 展開中は「n/N」、バーのときはバーの番号。 */
  step: string;
  title: string;
  tip: string;
  hint: string;
  fallback: string;
  /** 見えているボタンの名前（展開中だけ）。 */
  buttons: string[];
  rect: UiRect;
}

export interface FocusedInfo {
  tag: string;
  /** aria-label があればそれ、無ければ文字。 */
  label: string;
  focusVisible: boolean;
  outlineWidth: number;
}

export interface OverlayInfo {
  frame: UiRect | null;
  bubble: { text: string; rect: UiRect; placement: string } | null;
  restoreVisible: boolean;
}

const RectSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
const DescribedSchema = z.object({
  tag: z.string(),
  text: z.string(),
  hidden: z.boolean(),
  disabled: z.boolean(),
  display: z.string(),
  visibility: z.string(),
  rect: RectSchema,
  attrs: z.record(z.string(), z.string()),
});

const NodeSchema = z.object({
  nodeId: z.number(),
  nodeName: z.string().optional(),
  attributes: z.array(z.string()).optional(),
  shadowRoots: z.array(z.lazy((): z.ZodType<DomNode> => NodeSchema)).optional(),
  children: z.array(z.lazy((): z.ZodType<DomNode> => NodeSchema)).optional(),
  contentDocument: z.lazy((): z.ZodType<DomNode> => NodeSchema).optional(),
});
interface DomNode {
  nodeId: number;
  nodeName?: string | undefined;
  attributes?: string[] | undefined;
  shadowRoots?: DomNode[] | undefined;
  children?: DomNode[] | undefined;
  contentDocument?: DomNode | undefined;
}

const FocusedSchema = z.object({
  tag: z.string(),
  label: z.string(),
  focusVisible: z.boolean(),
  outlineWidth: z.number(),
});

const ACTIVE = `function () {
  const a = this.activeElement;
  if (!a) return null;
  return {
    tag: a.tagName.toLowerCase(),
    label: a.getAttribute('aria-label') ?? (a.textContent ?? '').trim(),
    focusVisible: a.matches(':focus-visible'),
    outlineWidth: parseFloat(getComputedStyle(a).outlineWidth) || 0,
  };
}`;

const DESCRIBE = `function () {
  const r = this.getBoundingClientRect();
  const cs = getComputedStyle(this);
  const attrs = {};
  for (const a of this.attributes) attrs[a.name] = a.value;
  return {
    tag: this.tagName.toLowerCase(),
    text: this.textContent ?? '',
    hidden: this.hidden === true,
    disabled: this.disabled === true,
    display: cs.display,
    visibility: cs.visibility,
    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    attrs,
  };
}`;

function hasAttribute(node: DomNode, name: string): boolean {
  const list = node.attributes ?? [];
  for (let i = 0; i < list.length; i += 2) if (list[i] === name) return true;
  return false;
}

function findHosts(node: DomNode, found: DomNode[]): void {
  if (hasAttribute(node, HOST_ATTRIBUTE)) found.push(node);
  for (const child of node.children ?? []) findHosts(child, found);
  if (node.contentDocument !== undefined) findHosts(node.contentDocument, found);
}

/** 同じ座標を `count` 回、間を置かずに押す（押して離すを続けて送り、応答を待たない）。 */
export async function rapidClick(page: Page, x: number, y: number, count: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const sends: Promise<unknown>[] = [cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })];
    for (let i = 1; i <= count; i++) {
      sends.push(
        cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: i }),
        cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: i }),
      );
    }
    await Promise.all(sends);
  } finally {
    await cdp.detach();
  }
}

export interface OwnUi {
  hostCount(): Promise<number>;
  nodes(selector: string): Promise<UiNode[]>;
  node(selector: string): Promise<UiNode | null>;
  miniGuide(): Promise<MiniGuideInfo | null>;
  overlay(): Promise<OverlayInfo | null>;
  click(selector: string): Promise<void>;
  clickButton(label: string): Promise<void>;
  hover(selector: string): Promise<void>;
  moveAway(): Promise<void>;
  focus(selector: string): Promise<void>;
  focused(): Promise<FocusedInfo | null>;
  tabTo(label: string | RegExp): Promise<FocusedInfo>;
  /** 見えているボタンの名前の一覧（ミニガイドと吹き出しの両方）。 */
  buttonLabels(): Promise<string[]>;
}

function centerOf(rect: UiRect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

export function ownUi(page: Page): OwnUi {
  let cdp: CDPSession | null = null;

  async function session(): Promise<CDPSession> {
    cdp ??= await page.context().newCDPSession(page);
    return cdp;
  }

  interface Found {
    nodeId: number;
    node: UiNode;
  }

  /** Shadow DOM の中で selector に合う要素を、ホストごとに集める。 */
  async function query(selector: string): Promise<Found[]> {
    // 調べている間にページの表示が入れ替わると、要素の ID が無効になる。その場合は取り直す
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await queryOnce(selector);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('ページ上の表示を調べられなかった');
  }

  async function queryOnce(selector: string): Promise<Found[]> {
    const s = await session();
    const doc = z.object({ root: NodeSchema }).parse(await s.send('DOM.getDocument', { depth: -1, pierce: true }));
    const hosts: DomNode[] = [];
    findHosts(doc.root, hosts);
    const result: Found[] = [];
    for (const host of hosts) {
      for (const root of host.shadowRoots ?? []) {
        const { nodeIds } = z
          .object({ nodeIds: z.array(z.number()) })
          .parse(await s.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector }));
        for (const nodeId of nodeIds) {
          const resolved = z.object({ object: z.object({ objectId: z.string() }) }).parse(await s.send('DOM.resolveNode', { nodeId }));
          const called = z
            .object({ result: z.object({ value: DescribedSchema }) })
            .parse(
              await s.send('Runtime.callFunctionOn', {
                objectId: resolved.object.objectId,
                functionDeclaration: DESCRIBE,
                returnByValue: true,
              }),
            );
          const d = called.result.value;
          result.push({
            nodeId,
            node: {
              tag: d.tag,
              text: d.text,
              hidden: d.hidden,
              disabled: d.disabled,
              visible: d.display !== 'none' && d.visibility !== 'hidden' && d.rect.width > 0 && d.rect.height > 0,
              rect: d.rect,
              attrs: d.attrs,
            },
          });
        }
      }
    }
    return result;
  }

  async function nodes(selector: string): Promise<UiNode[]> {
    return (await query(selector)).map((f) => f.node);
  }

  async function node(selector: string): Promise<UiNode | null> {
    return (await nodes(selector))[0] ?? null;
  }

  async function visibleNode(selector: string): Promise<UiNode> {
    const found = (await nodes(selector)).find((n) => n.visible);
    if (found === undefined) throw new Error(`ページ上の表示に、見えている要素が無い: ${selector}`);
    return found;
  }

  const textOf = async (selector: string): Promise<string> => {
    const n = (await nodes(selector)).find((x) => x.visible);
    return n === undefined ? '' : n.text.trim();
  };

  async function buttonLabels(): Promise<string[]> {
    return (await nodes('button')).filter((b) => b.visible).map((b) => b.text.trim());
  }

  const focusedInfo = (): Promise<FocusedInfo | null> => api.focused();

  const api: OwnUi = {
    async hostCount() {
      return page.locator(`[${HOST_ATTRIBUTE}]`).count();
    },
    nodes,
    node,

    async miniGuide() {
      const panel = await node('.panel');
      if (panel === null) return null;
      const expanded = panel.attrs['data-state'] === 'expanded';
      const buttons = expanded
        ? (await nodes('.panel .actions button')).filter((b) => b.visible).map((b) => b.text.trim())
        : [];
      return {
        state: panel.attrs['data-state'] ?? '',
        mode: panel.attrs['data-mode'] ?? '',
        width: Number(panel.attrs['data-width'] ?? '0'),
        step: await textOf(expanded ? '.panel .step' : '.panel .bar .n'),
        title: await textOf('.panel .title'),
        tip: await textOf('.panel .tip'),
        hint: await textOf('.panel .hint'),
        fallback: await textOf('.panel .fallback'),
        buttons,
        rect: panel.rect,
      };
    },

    async overlay() {
      const frame = (await nodes('.frame'))[0] ?? null;
      const bubble = (await nodes('.bubble'))[0] ?? null;
      const restore = (await nodes('.restore')).find((n) => n.visible);
      if (frame === null && bubble === null && restore === undefined) return null;
      return {
        frame: frame?.rect ?? null,
        bubble:
          bubble === null
            ? null
            : { text: bubble.text.trim(), rect: bubble.rect, placement: bubble.attrs['data-placement'] ?? '' },
        restoreVisible: restore !== undefined,
      };
    },

    async click(selector) {
      const target = centerOf((await visibleNode(selector)).rect);
      await page.mouse.click(target.x, target.y);
    },

    async clickButton(label) {
      const found = (await nodes('button')).find((b) => b.visible && !b.disabled && b.text.trim() === label);
      if (found === undefined) throw new Error(`ページ上の表示に、押せるボタンが無い: ${label}`);
      const target = centerOf(found.rect);
      await page.mouse.click(target.x, target.y);
    },

    async hover(selector) {
      const target = centerOf((await visibleNode(selector)).rect);
      await page.mouse.move(target.x, target.y);
    },

    async moveAway() {
      await page.mouse.move(2, 2);
    },

    async focus(selector) {
      const found = (await query(selector))[0];
      if (found === undefined) throw new Error(`ページ上の表示に、要素が無い: ${selector}`);
      const s = await session();
      await s.send('DOM.focus', { nodeId: found.nodeId });
    },

    async focused() {
      const s = await session();
      const doc = z.object({ root: NodeSchema }).parse(await s.send('DOM.getDocument', { depth: -1, pierce: true }));
      const hosts: DomNode[] = [];
      findHosts(doc.root, hosts);
      for (const host of hosts) {
        for (const root of host.shadowRoots ?? []) {
          const resolved = z.object({ object: z.object({ objectId: z.string() }) }).parse(await s.send('DOM.resolveNode', { nodeId: root.nodeId }));
          const called = z
            .object({ result: z.object({ value: FocusedSchema.nullable().optional() }) })
            .parse(await s.send('Runtime.callFunctionOn', { objectId: resolved.object.objectId, functionDeclaration: ACTIVE, returnByValue: true }));
          if (called.result.value) return called.result.value;
        }
      }
      return null;
    },

    async tabTo(label) {
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press('Tab');
        const now = await focusedInfo();
        if (now !== null && (typeof label === 'string' ? now.label === label : label.test(now.label))) return now;
      }
      throw new Error(`Tab キーで ${String(label)} にフォーカスが届かなかった`);
    },

    buttonLabels,
  };
  return api;
}
