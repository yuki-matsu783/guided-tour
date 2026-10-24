---
title: 部品：サイドパネルとログ
type: design
description: 画像の URL 管理、ロガー、保守記録、Markdown 描画、サイドパネル画面
tags: [design-doc]
keywords: [sidepanel, logger, diagnostics, markdown]
---

# 部品：サイドパネルとログ

## 画像の URL 管理（sidepanel/assets）

- 役割：サイドパネルで、説明文と補足画像の参照を、表示できる URL に変える。
- 使い方：`resolve(tourId, hash, path)` → URL。同梱は `chrome.runtime.getURL`、data URL はそのまま、取り込みは IndexedDB の `files` から Blob を読んで `URL.createObjectURL` で作る。
- 管理：`(hash, path)` ごとに作った URL を保持し、同じ画面の描き直しでは使い回す。表示するツアーや `hash` が変わったとき、ツアーが削除・上書きされたとき、サイドパネルを閉じるとき（`pagehide`）に `URL.revokeObjectURL` で解放する。
- 頼るもの：IndexedDB

## ロガー（shared/logger、background/logstore）

- 役割：3つの実行場所に共通する、レベル付きのログ出力。
- 使い方：`logger.error|warn|info|debug(event, fields)`。`event` ごとに、許可する項目を zod のスキーマで定義する（例：`locator.result` → `{ tier, topTier, reasons[], counts }`、`tabs.status` → `{ role, status }`、`session.goto` → `{ from, to, accepted }`）。項目は列挙値・数値・真偽値・内部 ID だけにする。
- 検査：スキーマにない出来事や項目を渡した場合は、内容を捨て、`logger.invalid`（出来事の名前だけ）として記録する。例外は、`error.name` と、コードで決めた理由コードだけを記録する（メッセージは残さない）。コンソールへの出力も、同じ検査を通したものだけを出す。
- 保存：ページ側とサイドパネルは、ログをバックグラウンドへ送る。バックグラウンドは2秒ごと（または50件ごと）にまとめて IndexedDB の `logs` に書く。起動時と100件書くごとに、30日より古いものを消してから、新しい順に2,000件を残す。
- 設定：`storage.local` の `settings.logLevel`（既定は warn）。`storage.onChanged` で各実行場所に反映する。
- 書き出し：JSON Lines 形式のファイルとして、サイドパネルから保存する。
- 頼るもの：IndexedDB、chrome.storage、zod

## 保守記録（background/diagnostics）

- 役割：`LOCATE_RESULT` の `reasons` から、劣化・矛盾・未検出・名前不一致を、ログとは別に集計して保存する。
- 使い方：`record(tourId, stepId, gen, result)`、`list(tourId)`、`export()`、`clear()`。
- 数え方：同じ `(sessionId, gen, reason)` は1回だけ数える（同じステップの表示中の繰り返しを数えない）。必須の照合で正しく絞り込めただけのもの（`conflict` に当たらないもの）は記録しない。
- 記録の項目：tourId、stepId、reason、tier、topTier、counts、total、lastAt。ページの文字列と URL は持たない。1,000件を超えたら、`lastAt` の古いものから削除する。
- 一覧の「要確認」：劣化・矛盾・未検出・名前不一致が1件以上あるツアーに付ける。
- 頼るもの：IndexedDB

## Markdown 描画（core/markdown）

- 役割：サイドパネルで、markdown-it（`html: false`、`linkify: false`）で解析したトークンから、許可リストに沿って DOM を組み立てる。innerHTML は使わない。HTML はタグも含めて文字列のまま表示する（markdown-it の `html: false` の動きのまま）。
- 許可リスト：

  | 種類 | 許可するもの |
  |---|---|
  | 要素 | p、h1〜h4（1段下げて表示する）、strong、em、code、pre、ul、ol、li、blockquote、hr、br、table、thead、tbody、tr、th、td、a、img |
  | 属性 | a の href、img の src と alt、ol の start（開始番号）、th と td の揃え（クラスで表す） |
  | URL の方式 | リンクは http / https だけ。画像は、画像の URL 管理で解決した拡張機能内の URL・blob URL・許可された data URL だけ |

  許可リストにないものは文字列として表示する。リンクは `target="_blank" rel="noopener noreferrer"` で出し、文字の後ろにホスト名を添え、`origins` 外なら「宣言外のサイト」と示す。画像を表示できない場合は代替文を表示する。
- 使い方：`renderMarkdown(src, container, resolveAsset, origins)`。
- 頼るもの：markdown-it、画像の URL 管理

## サイドパネル画面（sidepanel）

- 役割：一覧・実行中・一時中断中・設定の4画面。
- 使い方：`GET_STATE` で状態の写しを取得して描画する。`TOUR_STATE_CHANGED` を受けたら、120ミリ秒に間引いて描き直す。操作には、表示中の `sessionId`・`gen` と新しい `opId` を付ける。
- 一時中断中の画面：理由（`user`・`permission`・`overwritten`）に応じた選択肢を出す。`overwritten` で新版の `origins` が増えている場合は、「新版で続きから／最初から」を押した操作の中で権限を要求してから、`RESUME_NEW` を送る。
- 保存の状態：`saveError` が立っている間は、実行中の画面に「保存されていません。再起動すると前の位置に戻る可能性があります」を出し続ける。
- 設定画面：ログレベル、ミニガイドを表示するか、保守記録とログの確認・書き出し・消去。
- キーボード操作：すべての操作を `<button>` などの標準の部品で作る。ステップ一覧の各行もボタンにする。確認の画面はフォーカスを閉じ込める。描き直した後も、直前に操作した部品にフォーカスを戻す。
- 頼るもの：バックグラウンド、取り込み、Markdown 描画、画像の URL 管理
