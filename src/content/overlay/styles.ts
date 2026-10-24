/**
 * ハイライト・吹き出しの Shadow DOM の中に入れるスタイル。外部 CSS は読まない。
 * `all: initial` でページの CSS の影響を受けにくくする。
 */
export const OVERLAY_CSS = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
.dim {
  all: initial;
  position: fixed;
  background: rgba(0, 0, 0, 0.55);
  pointer-events: none;
}
.frame {
  all: initial;
  position: fixed;
  border: 3px solid #ffb300;
  border-radius: 6px;
  box-shadow: 0 0 0 2px #ffffff, 0 0 12px 2px rgba(255, 179, 0, 0.8);
  pointer-events: none;
}
.bubble {
  all: initial;
  position: fixed;
  display: block;
  width: 280px;
  padding: 12px 14px;
  border-radius: 8px;
  background: #ffffff;
  color: #1f2328;
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  pointer-events: auto;
}
.bubble .title { display: block; font-weight: 700; padding-right: 24px; overflow-wrap: anywhere; }
.bubble .tip { display: block; margin-top: 4px; overflow-wrap: anywhere; }
.bubble .tip code { font-family: ui-monospace, Menlo, Consolas, monospace; background: #eaeef2; padding: 0 4px; border-radius: 3px; }
.bubble .hint { display: block; margin-top: 8px; font-size: 13px; color: #57606a; }
.bubble .hint[data-kind="met"] { color: #1a7f37; font-weight: 700; }
.bubble .hint[data-kind="unsupported"] { color: #9a6700; }
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
button:hover { background: #eaeef2; }
button:focus-visible { outline: 3px solid #0969da; outline-offset: 2px; }
.close { position: absolute; top: 6px; right: 6px; padding: 0 8px; font-size: 16px; line-height: 1.4; }
.restore { position: fixed; right: 12px; bottom: 12px; pointer-events: auto; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3); }
`;
