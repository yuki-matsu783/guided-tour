---
title: 部品：バックグラウンド
type: design
description: 状態管理、タブ管理、ツアー管理、権限（バックグラウンド）
tags: [design-doc]
keywords: [Service Worker, session, tabs, catalog, permissions]
---

# 部品：バックグラウンド

## 状態管理（background/session）

- 役割：実行中の状態を持ち、操作を直列化キューで、「状態の確定と保存の順序」に従って処理する。
- 使い方：

  | 操作 | 内容 |
  |---|---|
  | `start(tourId, resume)` | バージョン・権限を確認し、ツアーの `hash` を固定して、新しい `sessionId` で状態を作る |
  | `goto(to)` | 受け付けたら、`gen` を1増やす。最終ステップの次は完了とする |
  | `pause()` / `resume()` / `stop()` / `restart()` | 一時中断・再開（`gen` を増やす）・終了・最初からやり直し（新しい `sessionId`） |
  | `resumeNew(mode)` | 上書きによる一時中断から、新版で再開する（`continue`：同じ stepId から、無ければ最初から／`restart`：最初から）。新しい `sessionId` を作る |
  | `bindTab(tabId, force)` | 既存のタブを役割に対応付ける。別の役割に対応付けられていて `force` がなければ、確認が必要と返す |
  | `openInTab(mode)` | 今のタブ／新しいタブで開き、役割に対応付ける |
  | `focusRole()` | 役割のタブとそのウィンドウを前面に出す |
  | `setOverlay(hidden)` / `setUi(mode, width)` | ページ上の表示の切り替え、ミニガイドの設定の保存と全タブへの反映 |
  | `recheck()` / `scrollToTarget()` | 再確認・対象を表示 |

- ツアーの改訂：`CATALOG_CHANGED{tourId, hash}` を受け、実行中のツアーの ID が同じで `hash` が違えば、一時中断（理由：上書き）にする。削除されていたら、同じ ID の同梱版が残っていても終了する。
- 保存の失敗：`saveError` を立てて操作を続ける。次に保存に成功したら下ろす。
- 頼るもの：タブ管理、ツアー管理、権限、storage

## タブ管理（background/tabs）

- 役割：役割とタブの対応付けを管理し、ステップごとのタブの状態を判定する。依頼されたときだけ、開く・対応付ける・前面に出す。
- 使い方：`evaluate(state, step)` → `{ status, selected, attended, candidates[] }`。`candidates` は、URL 条件に合う既存のタブ（全ウィンドウ。別の役割に対応付け済みのものには印を付ける）。
- 選択中・注目中：`selected` はタブが自分のウィンドウで選択されていること（`tab.active`）。`attended` は、それに加えてそのウィンドウにフォーカスがあること。`tabs.onActivated`・`windows.onFocusChanged`・`tabs.onRemoved`・`webNavigation`（`frameId === 0` の onCommitted・onHistoryStateUpdated・onCompleted）を契機に判定し直し、変わったら描画指示を送る。
- ページ世代：役割のタブで onCommitted を受けたら `pageSeq` を進め、ページ側を組み込み直す（ページ側は起動時に `HELLO` を送り、その `sender.documentId` を記録する）。onHistoryStateUpdated を受けたら `pageSeq` を進めて描画し直す。
- 判定：

  | 状態 | 条件 | 動き |
  |---|---|---|
  | `ok` | 役割のタブが `origins` 内で、URL 条件に合う | 描画を指示する（`selected`・`attended` を付ける） |
  | `donePage` | 役割のタブが、完了の目安の URL 条件に合う | `donePage: true` で描画を指示する（ミニガイドのみ）。不一致の案内は出さない |
  | `mismatch` | 役割のタブが、URL 条件にも完了ページにも合わない | 表示を消し、そのタブで開くボタンを出す |
  | `missing` | 役割にタブが対応付けられていない | 「このタブを使う」（注目中のタブが条件に合う場合）、候補の一覧、今のタブ／新しいタブで開く、を出す |
  | `unsupported` | ページ側を組み込めない | 再確認ボタンを出す |

  `attended` が偽なら、サイドパネルに「○○のタブへ移動」を出す。`selected` が偽なら、目安の表示を「確認を停止中」にする。役割を自動で対応付けることはしない。`guide` のステップでは判定せず、すべてのタブに `CLEAR` を送る。
- 介入の前の確認：ページ側を組み込む前と描画指示を送る前に、タブの URL が実行中のツアーの `origins` に含まれることを確認する（他のツアーで得た権限は理由にしない）。
- 頼るもの：chrome.tabs、chrome.windows、chrome.webNavigation、chrome.scripting

## ツアー管理（background/catalog）

- 役割：同梱ツアーと取り込んだツアーの一覧を持つ。実行中のツアーは、固定した `hash` の内容を返す。
- 使い方：`list()`、`get(id)`、`getPinned(id, hash)`、`remove(id)`（そのツアーのファイル・保守記録も消し、合計容量を戻す）、`reload()`。
- 取り込んだツアー：取り込み時に検証済みの内容（`compiled`。説明文の本体は含めず、ファイルのパスを持つ）を IndexedDB の `tours` に保存しておき、バックグラウンドはそれを zod で軽く検証し直して使う。バックグラウンドで YAML は解析しない。
- 同梱ツアー：`runtime.onInstalled`（更新時を含む）のときに読み込んで解析し、`hash` を計算する（同梱は信頼できるデータで、量も小さいため）。
- キャッシュ：メモリに持つ。`runtime.onInstalled`、`reload()`、`CATALOG_CHANGED` で捨てる。保存済みのデータだけから組み立て直せる。
- 頼るもの：IndexedDB

## 権限（shared/permissions）

- 役割：ツアーの `origins` から、ホストのマッチパターンを作り、確認・要求する。
- 使い方：`patternsOf(tour)`（`origins` だけから作る。ポートは捨ててホスト単位にする）、`has(tour)`、`request(tour)`（サイドパネルの操作の中で、await を挟まずに呼ぶ）。`permissions.onRemoved` を受けたら、状態管理に一時中断（理由：許可の取り消し）を依頼する。
- 頼るもの：chrome.permissions
