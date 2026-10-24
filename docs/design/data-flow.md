---
title: データの流れ
type: design
description: メッセージ、代表的な流れ、保存するデータ
tags: [design-doc]
keywords: [メッセージ, 保存]
---

# データの流れ

## メッセージ

すべての受信メッセージを、受け取った側が zod で検証します。形が合わないものは捨てます。

| 方向 | メッセージ |
|---|---|
| サイドパネル → バックグラウンド | `GET_STATE`、`START{tourId, resume, opId}`、`GOTO{to, sessionId, gen, opId}`、`PAUSE`・`RESUME`・`STOP`・`RESTART{sessionId, opId}`、`RESUME_NEW{sessionId, mode, opId}`、`BIND_TAB{tabId, force, sessionId, gen, opId}`、`OPEN_IN{mode, sessionId, gen, opId}`、`FOCUS_ROLE{sessionId, gen, opId}`、`RECHECK`・`SCROLL_TO_TARGET{sessionId, gen, opId}`、`SET_OVERLAY{hidden, sessionId, opId}`、`SET_UI{enabled?, mode?, width?}`、`CATALOG_CHANGED{tourId, hash}`、`REMOVE{tourId}`、`RELOAD`、`GET_DIAGNOSTICS`、`EXPORT_LOGS`、`CLEAR_LOGS`、`LOG{entries[]}` |
| ページ側 → バックグラウンド | `HELLO`、`LOCATE_RESULT{sessionId, gen, pageSeq, result}`、`HINT_STATE{sessionId, gen, pageSeq, met, unsupported}`、`GOTO`・`SCROLL_TO_TARGET`・`SET_OVERLAY`・`SET_UI`（ミニガイド・吹き出しからの利用者の操作）、`LOG{entries[]}` |
| バックグラウンド → ページ側 | `PING`、`SYNC{sessionId, gen, rev}`、`RENDER{…, rev}`、`RECHECK{rev}`、`SCROLL_TO_TARGET{rev}`、`CLEAR{rev}` |
| バックグラウンド → サイドパネル | `TOUR_STATE_CHANGED` |

サイドパネルからのメッセージは、`sender.url` が拡張機能のサイドパネルのページであることを確かめます。ページ側からのメッセージは、「識別子と、古いものを捨てる規則」の条件で確かめます。

## ① ツアーを開始し、既存のタブを使う

1. サイドパネルで「開始」を押す → 権限の `request(tour)` を呼ぶ（拒否されたら終了）
2. `START` → 状態管理がバージョンを確認し、ツアーの `hash` を固定し、`sessionId` を作り、`gen = 1` で状態を確定する
3. タブ管理の `evaluate` → `missing`。`candidates` に、ログイン済みの既存タブ（別ウィンドウ）が入る → サイドパネルに一覧が出る
4. 受講者がそのタブを選ぶ → `BIND_TAB` → 確定 → `origins` を確認してページ側を組み込む → `HELLO` で `documentId` を記録する → `RENDER{selected: true, attended: false}`
5. ページ側は探索を始め、特定したらハイライト・吹き出し・ミニガイドを出す。`attended` が偽なのでスクロールはしない。サイドパネルに「○○のタブへ移動」が出る

## ② ミニガイドから次へ進み、完了ページへ移る

1. ミニガイドの「次へ」をクリック（`isTrusted`）→ `GOTO{to, sessionId, gen, opId}`
2. バックグラウンドは、`sender`（タブ・フレーム・文書）、`sessionId`・`gen` を確認して受け付け、`gen` を増やして確定し、進捗を保存し、`RENDER` を送る。同じ表示からサイドパネルでも「次へ」が押されていたら、`gen` が合わないので捨てる
3. 新しいステップで作成ボタンを押すと、`/tokens/created` へ遷移する → onCommitted → `pageSeq` を進める → `evaluate` → `donePage` → ミニガイドだけを描画し、`HINT_STATE` 相当の状態を「次へ進めます」にする

## ③ 実行中のツアーが上書きされる

1. サイドパネルで同じ ID のツアーを取り込む → 上書きの確認（実行中なら一時中断になる旨を表示）→ 承認
2. 取り込みが IndexedDB のトランザクションで新版に切り替え、旧版のファイルを消す → `CATALOG_CHANGED{tourId, hash}`
3. 状態管理は `hash` の違いを検知し、一時中断（理由：上書き）を確定し、全タブに `CLEAR` を送る
4. 受講者が「新版で続きから」を押す → `origins` が増えていれば権限を要求する → `RESUME_NEW{mode: continue}` → 新しい `sessionId`、新しい `hash` で、同じ stepId のステップ（無ければ最初）から再開する

## 保存するデータ

| データ | 保存先 | 項目 |
|---|---|---|
| 実行中の状態 | storage.session `tour` | status（running・paused・ended）、pauseReason、sessionId、gen、pageSeq、rev、tourId、hash、stepIndex、stepId、windowId、tabs{役割: {tabId, documentId}}、overlayHidden、hint{gen, met, unsupported}、tabStatus、saveError、notice、recentOpIds[] |
| 進捗 | storage.local `progress` | tourId → {sessionId, gen, stepId, stepIndex, savedAt} |
| 削除待ち | storage.local `pendingDeletes` | [{tourId, sessionId}] |
| 設定 | storage.local `settings` | logLevel、miniGuide{enabled, mode, width} |
| 取り込んだツアー | IndexedDB `tours` | id、hash、compiled、yamlText、fileName、importedAt、totalBytes |
| パッケージのファイル | IndexedDB `files` | [tourId, hash, path] を鍵に、blob、mime、size、width?、height? |
| 容量の集計 | IndexedDB `meta` | totalBytes |
| ログ | IndexedDB `logs` | ts、level、ctx、event、fields（ts に索引） |
| 保守記録 | IndexedDB `diagnostics` | [tourId, stepId, reason] を鍵に、tier、topTier、counts、total、lastAt、lastKey（sessionId:gen） |
