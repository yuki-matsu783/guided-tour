/**
 * P-X（example.com 模擬）。`context.route` で `https://example.com/` に、実物と同じ構造のページを返す。
 * 自己紹介ツアー（同梱）は example.com を使うので、実際の通信なしに確かめられる。テスト用の manifest が
 * `https://example.com/*` のホスト権限を足してあるので、許可は付与済みになる（support/build.ts）。
 *
 * 使い方: ページを開く前に `await routeExampleCom(ext.context, variant)`。`variant` は次のどれか。
 * - `'current'`（既定）: 見出し「Example Domain」と、リンク「Learn more」。
 * - `'legacy'`: リンクの名前が旧表記「More information...」。
 * - `'abort'`: 通信を失敗させる（ページが開けない）。
 */
import type { BrowserContext } from '@playwright/test';

export type ExampleVariant = 'current' | 'legacy' | 'abort';

function exampleHtml(linkName: string): string {
  return `<!doctype html>
<html>
<head>
<title>Example Domain</title>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>body{background:#eee;width:60vw;margin:15vh auto;font-family:system-ui,sans-serif}div{opacity:0.8}a:link,a:visited{color:#348}</style>
</head>
<body>
<div>
<h1>Example Domain</h1>
<p>This domain is for use in documentation examples without needing permission. Avoid use in operations.</p>
<p><a href="https://iana.org/domains/example">${linkName}</a></p>
</div>
</body>
</html>`;
}

export async function routeExampleCom(context: BrowserContext, variant: ExampleVariant = 'current'): Promise<void> {
  await context.route('https://example.com/**', async (route) => {
    if (variant === 'abort') {
      await route.abort('connectionrefused');
      return;
    }
    const url = new URL(route.request().url());
    if (url.pathname !== '/') {
      await route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: exampleHtml(variant === 'legacy' ? 'More information...' : 'Learn more'),
    });
  });
}
