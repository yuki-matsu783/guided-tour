# guided-tour

Chrome 拡張機能「Guided Setup Tour」。Web サービスの初期設定などを、ステップごとの案内（ツアー）で示します。ページ上のハイライトと吹き出し、サイドパネルの一覧と操作で進めます。

## 前提

- Node 22（`.node-version`）
- pnpm（バージョンは `package.json` の `packageManager`）

## コマンド

| コマンド | 内容 |
|---|---|
| `pnpm install` | 依存を入れる |
| `pnpm run build` | typecheck・lint・単体テストを実行してから、`dist/` を作る |
| `pnpm test` | 単体テスト（Vitest） |
| `pnpm run test:e2e` | 拡張機能を読み込んだ Chromium での受け入れテスト（Playwright） |
| `pnpm run package` | `release/` に配布用の zip を作る（先に `pnpm run build` を通す） |

## Chrome に読み込む

1. `pnpm run build` で `dist/` を作る
2. Chrome で `chrome://extensions` を開き、「デベロッパーモード」をオンにする
3. 「パッケージ化されていない拡張機能を読み込む」で `dist/` を選ぶ

## 同梱のツアー

`public/tours/` に、使い方を学べる自己紹介ツアー（Guided Setup Tour の使い方）が入っています。拡張機能を読み込むと、サイドパネルの一覧から始められます。

## 文書

- 要件書：[docs/requirements.md](docs/requirements.md)
- 設計書：[docs/design.md](docs/design.md)
- 決定と理由（ADR）：[docs/adr/README.md](docs/adr/README.md)
