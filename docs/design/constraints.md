---
title: 前提と制約
type: design
description: 技術、実行場所ごとの制約、権限・manifest、上限値、時間
tags: [design-doc]
keywords: [TypeScript, manifest, 上限値, 時間]
---

# 前提と制約

## 技術

| 項目 | 内容 |
|---|---|
| 基盤 | Chrome 拡張機能 Manifest V3、Chrome 114 以降 |
| 言語 | TypeScript（`strict: true`、`noUncheckedIndexedAccess`）。`any` と `as` による型の握りつぶしは避け、`unknown` と型の絞り込みを使う |
| パッケージ管理 | pnpm（corepack 経由）。`package.json` の `packageManager` と `.node-version` でバージョンを固定する。npm / npx は使わない |
| ビルド | esbuild（IIFE 形式、`target: chrome114`） |
| 主なライブラリ | zod（形式とメッセージの検証）、yaml（YAML 1.2 の解析、行番号、エイリアス数の制限）、dom-accessibility-api（読み上げ名・役割の計算）、markdown-it（Markdown の解析、`html: false`）、fflate（zip の逐次展開と作成） |
| テスト | Vitest、jsdom、Playwright |

## 実行場所ごとの制約

| 実行場所 | 使えるもの | 使わないもの |
|---|---|---|
| バックグラウンド（Service Worker） | chrome.* API、IndexedDB、storage | `URL.createObjectURL`（使えない）、YAML・zip・画像の解析（状態管理の列を塞がないため） |
| サイドパネル（拡張機能のページ） | IndexedDB（バックグラウンドと同じオリジンなので共有できる）、`URL.createObjectURL`、fflate、yaml、markdown-it、権限の要求 | - |
| ページ側（コンテンツスクリプト） | DOM、chrome.runtime のメッセージ | 拡張機能の IndexedDB（ページのオリジンになるため使えない）、画像の表示 |

## 権限・manifest

| 項目 | 値 | 理由 |
|---|---|---|
| permissions | `storage`、`unlimitedStorage`、`scripting`、`tabs`、`webNavigation`、`sidePanel` | タブ URL の判定、ページへの組み込み、遷移の検知、サイドパネル |
| optional_host_permissions | `https://*/*`、`http://*/*` | ツアーの `origins` だけを実行時に要求する |
| commands | `_execute_action`（推奨キー：`Alt+Shift+G`） | ショートカットキーでサイドパネルを開く（FR-46）。`openPanelOnActionClick: true` と組み合わせる |
| key | 固定した公開鍵 | 導入場所によらず拡張機能 ID を固定する（FR-117）。秘密鍵は配布物にもリポジトリにも含めない |
| CSP (extension_pages) | `script-src 'self'; object-src 'none'; img-src 'self' data: blob:; frame-src 'none'` | 外部画像を禁止する。取り込んだ画像はサイドパネルで blob URL にして表示する |

## 上限値

| 対象 | 上限 |
|---|---|
| zip ファイル（圧縮時） | 20 MB |
| 展開後の合計（実際に展開したバイト数で数える） | 50 MB |
| パッケージ内のファイル数 | 500 |
| zip の項目の総数（ディレクトリ・名前の不正な項目を含む） | 2,000 |
| 取り込み済みツアーの合計容量 | 200 MB |
| 画像1枚 | 5 MB、4096×4096 px 以内、かつ 1,600 万画素以内 |
| `tour.yaml` | 1 MB |
| Markdown ファイル1つ | 200 KB |
| YAML のエイリアス展開数 | 100 |
| YAML の入れ子の深さ | 32 |
| ステップ数 | 200 |
| 1つのステップの手がかりの候補数 | 各20 |
| URL 条件のパス | 200文字、32区間、`**` は4個まで |
| 照合する URL の区間数 | 256（超えたら一致しないとみなす） |
| ログ | 2,000件・30日（どちらか先に達した方で削除） |
| 保守記録 | 1,000件（最終日時の古いものから削除） |
| 処理済みの操作 ID の記憶 | 直近50件 |
| ミニガイドの幅 | 240〜560 px（既定 320 px）。最小化したバーは 28 px |

## 時間

性能の要件ではなく、動きを一意に決めるための値です。

| 対象 | 値 |
|---|---|
| 初回の探索・喪失後の探し直し | 8秒 |
| ページ変化に伴う再探索・再検証の間引き | 最短250ミリ秒 |
| 追従中の定期的な再検証 | 1秒ごと |
| 8秒以降の低い頻度での探索 | 2秒ごと（変化があったときだけ） |
| 完了の目安の定期確認 | 1秒ごと（イベントがなくても確認する） |
| ミニガイドのホバーを閉じるまでの待ち | 300ミリ秒 |
| 遷移検知のデバウンス | 150ミリ秒（タブごと） |
| ログの書き込みのまとめ | 2秒ごと、または50件ごと |
