/**
 * サイドパネルのエントリ。
 * sidepanel.html の #root に React の画面を描画する（いまはタイトルだけ）。
 */
import { createRoot } from 'react-dom/client';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<h1>Guided Setup Tour</h1>);
}
