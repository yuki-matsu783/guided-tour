---
title: 部品：ページ側
type: design
description: ステップ実行器、完了の目安の監視、ハイライト・吹き出し、ミニガイド（ページ側）
tags: [design-doc]
keywords: [content script, overlay, miniguide]
---

# 部品：ページ側

## ステップ実行器（content/runtime）

- 役割：描画指示を受け、1つのステップの探索・追従・再検証・目安の監視・表示を、ライフサイクルに沿って管理する。
- 使い方：バックグラウンドからの描画指示（RENDER）を受け取る。メッセージの形は `src/shared/messages/`。コードは `src/content/runtime/`。`rev` が受け取った最大値より小さければ捨てる。`(sessionId, gen, pageSeq)` が今と同じなら、表示の状態（overlay・ui・selected・attended）だけを更新する。違えば、今の処理をすべて止めてから始め直す。
- 実行の許可：`selected` が偽のときは、探索・監視・追従をすべて止める（`document.visibilityState` には頼らない）。真に戻ったら、すぐに1回探索する。
- 処理のトークン：非同期の処理（探索・判定）は、開始時の `(sessionId, gen, pageSeq, rev)` を持ち、完了時に現在の値と一致しなければ結果を捨てる。
- ライフサイクル：

  | 段階 | 動き |
  |---|---|
  | 探索の開始 | 開始・再開・`RECHECK`・`selected` が真に戻ったときは、すぐに1回 `locate` を実行する |
  | 初回の探索 | 以降は、ページが変化したときだけ、最短250ミリ秒ごとに `locate` を実行する。8秒で見つからなければ `missing` を報告し、文章だけの案内にする |
  | 低頻度の探索 | 8秒以降は、2秒ごと（変化があったときだけ）に `locate` を実行する。見つかったら追従に移る |
  | 追従と再検証 | requestAnimationFrame で位置だけを測る。加えて、ページが変化したとき（最短250ミリ秒）と1秒ごとに `locate` をやり直し、結果を今の要素と比べる。FR-81 の条件に当たれば、枠と吹き出しをすぐ消して「喪失後の探し直し」（8秒）に移る。`nameMismatch` だけの変化なら、枠を残して報告する |
  | スクロール | ステップに入ってから8秒以内に初めて特定し、`attended` が真で、要素が画面外のときに1回だけ行う。`SCROLL_TO_TARGET` を受けたときも行う |
  | 完了ページ | `donePage` が真なら、探索とハイライトを行わず、ミニガイドだけを表示する |
  | 停止 | `CLEAR` を受けたとき、新しい世代の描画指示を受けたときは、すべての監視・タイマー・Observer・保留中の処理を破棄する |

- ページの変化の検知：MutationObserver（`childList`・`subtree`・`characterData`、`attributes` は id・class・style・hidden・role・type・disabled・data-testid・data-tour-id・aria-label・aria-labelledby・aria-hidden・aria-checked・aria-expanded・aria-selected・aria-pressed に限る）。自分の表示のホスト要素とその中の変化は無視する。変化があったことを記録するだけで、その場では探索しない。
- 報告：`LOCATE_RESULT` と `HINT_STATE` に `sessionId`・`gen`・`pageSeq` を付け、結果が変わったときだけ送る。
- 頼るもの：要素特定エンジン、完了の目安の監視、ハイライト・吹き出し、ミニガイド

## 完了の目安の監視（content/watch）

- 役割：要素の出現・状態の `done` を判定する。ステップ実行器の実行の許可に従う。完了ページ（`done.type: page`）はバックグラウンドが判定する。
- 判定の契機：ページの変化、`input`・`change` イベント、1秒ごとの定期確認。
- 判定：

  | 状態 | 判定の方法 |
  |---|---|
  | `filled` | 対象が `type="password"` なら判定せず、`unsupported` を返す。それ以外は値の文字数だけをその場で求める（値を変数に残さない） |
  | `checked` | `checked` プロパティか `aria-checked` |
  | `selected`・`expanded`・`pressed` | 対応する ARIA 属性 |
  | `element` | 要素特定エンジンで見つかるかどうか |

- 頼るもの：要素特定エンジン

## ハイライト・吹き出し（content/overlay）

- 役割：ハイライト（枠と4枚の減衰板）、吹き出し、表示を戻すボタン（ミニガイドを使わない設定のときだけ）を、閉じた Shadow DOM の中に描く。
- 使い方：ハイライトの対象・ステップ・表示の設定・完了の目安の状態・ミニガイドの領域を渡すと、枠・吹き出し・減衰板を描く。消す操作もある。コードは `src/content/overlay/`。
- 動き：
  - 減衰板と枠は `pointer-events: none` にする。減衰板は、ミニガイドの領域を覆わない
  - 吹き出しには、`title`・`tip`（強調・コードのみ）・目安の状態を textContent で描く。配置は、表示領域からミニガイドの領域（展開時は幅、最小化時はバーの幅）を除いた範囲で、対象の下、上、左の順に収まる位置を選ぶ
  - × を押したら `SET_OVERLAY{hidden: true}` を送る。ミニガイドは消えず、ハイライトと吹き出しだけが消える
  - すべてのボタンは `<button>` で作り、キーボードで操作でき、フォーカスが見えるようにする。操作のイベントは `isTrusted` が真のものだけを受け付ける
- 頼るもの：なし

## ミニガイド（content/miniguide）

- 役割：ページの右端に、小さな案内領域を、閉じた Shadow DOM の中に描く。
- 使い方：ステップ番号・総数・見出し・`tip`・目安の状態・文章だけの案内の文・最終ステップかどうか・ページ上の表示が消えているか、と、ミニガイドの設定（表示するか・表示状態・幅）を渡すと、描く。コードは `src/content/miniguide/`。
- 表示する条件：`ui.enabled` が真で、描画指示が届いていること（描画指示は、現在のステップの役割のタブが URL 条件に合うときか、完了ページのときにだけ送られる）。
- 表示状態：

  | 状態 | 動き |
  |---|---|
  | 展開 | 右端に固定し、`width` の幅で表示する。左の境界のつまみをドラッグすると幅が変わる。つまみはキーボードの左右キーでも16 px ずつ変えられる |
  | 最小化 | 幅28 px のバーを表示する。バーにはステップ番号と目安の状態を出す。クリックか Enter で展開する |
  | ホバー | バーを表示し、`pointerenter`・`focusin` で展開する。`pointerleave`・`focusout` から300ミリ秒後にバーに戻る |

- 操作：「戻る」「次へ（完了）」は `GOTO{to, sessionId, gen, opId}`、「対象を表示」は `SCROLL_TO_TARGET`、「表示を戻す」は `SET_OVERLAY{hidden: false}`、表示状態と幅の変更は `SET_UI{mode, width}` を送る（幅はドラッグを離したときに1回だけ送る）。すべて `isTrusted` が真のイベントに限る。
- 移動の操作の受け付け：移動を送ったら、新しいステップの表示が届くまで次の移動を送らない。表示が届いてから一定時間（値は時間の表）も移動を受け付けない。
- サイドパネルを開く方法として、ショートカットキーの案内を表示する（キーは `chrome.commands.getAll` で取得した実際の割り当てをバックグラウンドから受け取る）。
- 頼るもの：なし
