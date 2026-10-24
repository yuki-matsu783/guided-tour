/**
 * ミニガイドの Shadow DOM の中に入れるスタイル。外部 CSS は読まない。
 * `all: initial` でページの CSS の影響を受けにくくする。
 */
export const MINIGUIDE_CSS = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
.panel {
  all: initial;
  position: fixed;
  top: 12px;
  right: 0;
  display: flex;
  max-height: calc(100vh - 24px);
  background: #ffffff;
  color: #1f2328;
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif;
  border: 1px solid #d0d7de;
  border-right: none;
  border-radius: 8px 0 0 8px;
  box-shadow: -2px 2px 12px rgba(0, 0, 0, 0.25);
  pointer-events: auto;
  overflow: hidden;
}
.handle {
  all: initial;
  flex: none;
  width: 8px;
  cursor: ew-resize;
  background: #d0d7de;
  touch-action: none;
}
.handle:hover, .handle:focus-visible { background: #0969da; }
.handle:focus-visible { outline: 3px solid #0969da; outline-offset: -3px; }
.body { flex: 1; min-width: 0; padding: 10px 12px; overflow-y: auto; }
.head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.step { font-weight: 700; color: #57606a; }
.modes { display: flex; gap: 4px; }
.title { display: block; margin-top: 4px; font-weight: 700; overflow-wrap: anywhere; }
.tip { display: block; margin-top: 4px; overflow-wrap: anywhere; }
.tip code { font-family: ui-monospace, Menlo, Consolas, monospace; background: #eaeef2; padding: 0 4px; border-radius: 3px; }
.hint { display: block; margin-top: 8px; font-size: 13px; color: #57606a; }
.hint[data-kind="met"] { color: #1a7f37; font-weight: 700; }
.hint[data-kind="unsupported"] { color: #9a6700; }
.fallback { display: block; margin-top: 8px; padding: 6px 8px; background: #fff8c5; border-radius: 6px; overflow-wrap: anywhere; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.shortcut { display: block; margin-top: 10px; font-size: 12px; color: #57606a; overflow-wrap: anywhere; }
button {
  all: initial;
  display: inline-block;
  cursor: pointer;
  font: 13px/1.4 system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif;
  color: #1f2328;
  background: #f6f8fa;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  padding: 4px 10px;
}
button:hover:not(:disabled) { background: #eaeef2; }
button:disabled { cursor: not-allowed; color: #8c959f; }
button[aria-pressed="true"] { background: #ddf4ff; border-color: #0969da; }
button:focus-visible { outline: 3px solid #0969da; outline-offset: 2px; }
.bar {
  all: initial;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 72px;
  padding: 8px 0;
  cursor: pointer;
  font: 12px/1.2 system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif;
  color: #1f2328;
  background: #ffffff;
}
.bar:focus-visible { outline: 3px solid #0969da; outline-offset: -3px; }
.bar .mark[data-kind="met"] { color: #1a7f37; font-weight: 700; }
.bar .mark[data-kind="unsupported"] { color: #9a6700; }
`;
