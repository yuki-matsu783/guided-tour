/**
 * テスト用の Web サーバー（Node の http）と、テスト用ページの登録の仕組み。
 *
 * 使い方:
 * - `startServer()`: 空いているポートで起動する。`localhost` と `127.0.0.1` は同じサーバーに届くが、別のサイトとして扱われる。
 * - `server.url('/static')` / `server.url('/static', '127.0.0.1')`: ページの URL。`server.origin` / `server.altOrigin` はオリジン。
 * - `server.requests`: 受けたリクエストの記録（パスと URL）。外部への通信が無いことの確認などに使う。
 * - ページは `pages/*.ts` が `export const pages: PageDef[]` で登録する。起動時にこのディレクトリの全ファイルを読む。
 *   ページを足すときは `pages/` に新しいファイルを作るだけでよい（ほかのファイルは触らない）。`page-kit.ts` に共通の部品がある。
 * - 実在しないパスは 404。ページの中身は `html`（文字列）か、リクエストを受けて作る関数で書く。
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

export type TestHost = 'localhost' | '127.0.0.1';

export interface PageRequest {
  url: URL;
  host: TestHost;
}

export interface PageResponse {
  body: string;
  status?: number;
  contentType?: string;
  headers?: Record<string, string>;
}

export interface PageDef {
  /** パス名の一致。文字列は完全一致、正規表現は `pathname` に対して試す。 */
  path: string | RegExp;
  /** 本文。HTML 文字列か、リクエストから作る関数。 */
  html: string | ((request: PageRequest) => string | PageResponse);
}

export interface RequestLog {
  path: string;
  url: string;
  host: string;
}

export interface TestServer {
  readonly port: number;
  /** `http://localhost:<port>` */
  readonly origin: string;
  /** `http://127.0.0.1:<port>`（origin とは別のサイト） */
  readonly altOrigin: string;
  url(path: string, host?: TestHost): string;
  readonly requests: readonly RequestLog[];
  close(): Promise<void>;
}

const pagesDir = join(fileURLToPath(new URL('.', import.meta.url)), 'pages');

function isPageDef(value: unknown): value is PageDef {
  if (typeof value !== 'object' || value === null) return false;
  const path: unknown = Reflect.get(value, 'path');
  const html: unknown = Reflect.get(value, 'html');
  return (typeof path === 'string' || path instanceof RegExp) && (typeof html === 'string' || typeof html === 'function');
}

async function loadPages(): Promise<PageDef[]> {
  const files = (await readdir(pagesDir)).filter((f) => f.endsWith('.ts')).sort();
  const defs: PageDef[] = [];
  for (const file of files) {
    const loaded: unknown = await import(pathToFileURL(join(pagesDir, file)).href);
    const list: unknown = typeof loaded === 'object' && loaded !== null ? Reflect.get(loaded, 'pages') : undefined;
    if (!Array.isArray(list)) continue;
    const items: unknown[] = list;
    for (const item of items) {
      if (isPageDef(item)) defs.push(item);
    }
  }
  return defs;
}

function hostOf(req: IncomingMessage): TestHost {
  return (req.headers.host ?? '').startsWith('127.0.0.1') ? '127.0.0.1' : 'localhost';
}

export async function startServer(): Promise<TestServer> {
  const defs = await loadPages();
  const requests: RequestLog[] = [];

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const host = hostOf(req);
    const url = new URL(req.url ?? '/', `http://${host}`);
    requests.push({ path: url.pathname, url: url.href, host });
    const def = defs.find((d) => (typeof d.path === 'string' ? d.path === url.pathname : d.path.test(url.pathname)));
    if (def === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    const made = typeof def.html === 'function' ? def.html({ url, host }) : def.html;
    const response: PageResponse = typeof made === 'string' ? { body: made } : made;
    res
      .writeHead(response.status ?? 200, {
        'content-type': response.contentType ?? 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        ...response.headers,
      })
      .end(response.body);
  };

  const server: Server = createServer(handle);
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') reject(new Error('ポートを取得できなかった'));
      else resolve(address.port);
    });
  });

  return {
    port,
    origin: `http://localhost:${String(port)}`,
    altOrigin: `http://127.0.0.1:${String(port)}`,
    url: (path, host = 'localhost') => `http://${host}:${String(port)}${path}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
