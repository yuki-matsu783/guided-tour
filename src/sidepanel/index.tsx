/**
 * サイドパネルのエントリ。sidepanel.html の #root に、実物の依存で `App` を描画する。
 * CSS は esbuild が JS から取り込み、sidepanel.css として出す（index.html から読み込む）。
 */
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { createChromeDeps } from './deps.ts';
import './styles.css';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<App deps={createChromeDeps()} />);
}
