---
title: 単体テストケース一覧（ページ側・バックグラウンド）
type: report
description: ステップ実行器、完了の目安の監視、ハイライト・吹き出し、ミニガイド、状態管理、タブ管理、ツアー管理、権限、メッセージ検証の単体テストケース（説明文のみ。承認待ち）
tags: [test-cases]
keywords: [単体テスト, Vitest, ステップ実行器, ミニガイド, 状態管理, タブ管理, 権限]
---

# 単体テストケース一覧（ページ側・バックグラウンド）

テストコードは書かない。利用者の承認を得てから実装に使う。時間の値は偽のタイマーで進める。Chrome の API は偽物に差し替える。根拠の「設計」は `docs/design/` 配下、「要件」は `docs/requirements/` 配下の文書を指す。

## ステップ実行器（content/runtime）

### RENDER の受け付け

| ID | テストケース（説明） | 根拠 |
|---|---|---|
| T-RUN-01 | 受け取った最大の `rev` より小さい `rev` の RENDER が届いたとき、捨てられ、表示も探索も変わらない | components-content ステップ実行器、AC-60 |
| T-RUN-02 | 最大の `rev` と同じ `rev` の RENDER が届いたとき、捨てられずに処理される | components-content ステップ実行器（「小さければ捨てる」） |
| T-RUN-03 | 新しい `rev` の RENDER の後に、より古い `rev` の CLEAR が届いたとき、捨てられ、最新の表示が残る | architecture 識別子、AC-60 |
| T-RUN-04 | CLEAR の後に、より古い `rev` の RENDER が届いたとき、捨てられ、何も表示されない | architecture 識別子、AC-60 |
| T-RUN-05 | 古い `rev` の RECHECK・SCROLL_TO_TARGET が届いたとき、捨てられ、探索もスクロールも起きない | architecture 識別子 |
| T-RUN-06 | `(sessionId, gen, pageSeq)` が同じ RENDER が届いたとき、overlay・ui・selected・attended だけが更新され、探索はやり直されない | components-content ステップ実行器 |
| T-RUN-07 | 同じ世代で overlay が `hidden: true` に変わったとき、ハイライトと吹き出しが消え、ミニガイドは残る | FR-93、FR-52 |
| T-RUN-08 | 同じ世代で ui の mode や width が変わったとき、ミニガイドの表示だけが変わり、探索は止まらない | components-content ステップ実行器、FR-50 |
| T-RUN-09 | `gen` が違う RENDER が届いたとき、今の処理（タイマー・Observer・保留中の処理）がすべて止まり、新しいステップで始め直される | components-content ステップ実行器 |
| T-RUN-10 | `pageSeq` だけが違う RENDER が届いたとき、始め直され、前のページの探索結果は採用されない | components-content ステップ実行器、AC-59 |
| T-RUN-11 | `sessionId` だけが違う RENDER が届いたとき、始め直され、前の実行回の表示が残らない | components-content ステップ実行器、FR-104 |
| T-RUN-12 | SYNC の `sessionId`・`gen` が現在の表示と違うとき、表示が消される | architecture 復帰の手順4 |
| T-RUN-13 | SYNC の `sessionId`・`gen` が現在の表示と同じとき、表示は消されない | architecture 復帰の手順4 |

### selected による停止と再開

| ID | テストケース（説明） | 根拠 |
|---|---|---|
| T-RUN-14 | `selected` が偽の RENDER を受けたとき、探索・監視・追従のタイマーがすべて動かない | components-content 実行の許可、FR-65 |
| T-RUN-15 | `selected` が偽でも `document.visibilityState` が visible のとき、停止したままになる | components-content 実行の許可、ADR-0048 |
| T-RUN-16 | `selected` が真でも `document.visibilityState` が hidden のとき、探索が動く | components-content 実行の許可、ADR-0048 |
| T-RUN-17 | `selected` が偽から真に変わったとき、すぐに1回 `locate` が実行される | FR-80 探索の開始、components-content 実行の許可 |
| T-RUN-18 | `selected` が偽の間にページが変化しても、`locate` が実行されない | components-content 実行の許可 |
| T-RUN-19 | `selected` が偽の間に完了の目安の監視（イベント・1秒ごとの確認）が動かない | components-content 完了の目安の監視、FR-65 |
| T-RUN-20 | 探索中に `selected` が偽になったとき、探索中の結果が届いても採用されない | components-content 処理のトークン、実行の許可 |

### ライフサイクル

| ID | テストケース（説明） | 根拠 |
|---|---|---|
| T-RUN-21 | 新しいステップの RENDER を受けたとき、すぐに1回 `locate` が実行される | FR-80 探索の開始、AC-05 |
| T-RUN-22 | RECHECK を受けたとき、すぐに1回 `locate` が実行され、初回の探索（8秒）がやり直される | FR-80 再確認、components-content ライフサイクル |
| T-RUN-23 | 初回の探索中にページが連続して変化したとき、`locate` は最短250ミリ秒の間隔でしか実行されない | components-content 初回の探索、constraints 時間 |
| T-RUN-24 | 初回の探索中にページの変化がないとき、最初の1回の後に `locate` が繰り返されない | components-content 初回の探索（変化したときだけ） |
| T-RUN-25 | 8秒たっても見つからないとき、`missing` が1回報告され、文章だけの案内に切り替わる | FR-80 初回の探索、AC-06 |
| T-RUN-26 | 7.9秒の時点で見つかったとき、`missing` は報告されず、ハイライトされる | FR-80 初回の探索、constraints 時間 |
| T-RUN-27 | 8秒以降、変化があるとき、2秒ごとに `locate` が実行される | components-content 低頻度の探索、constraints 時間 |
| T-RUN-28 | 8秒以降、変化がないとき、`locate` が実行されない | components-content 低頻度の探索 |
| T-RUN-29 | 8秒より後に要素が現れて特定できたとき、文章だけの案内からハイライトに変わり、スクロールしない | FR-41、FR-80 8秒以降、AC-06 |
| T-RUN-30 | 特定後、requestAnimationFrame で位置が測られ、要素の位置・大きさの変化に枠と吹き出しが追従する | FR-43、components-content 追従と再検証 |
| T-RUN-31 | 追従中、ページが変化したとき、最短250ミリ秒で `locate` がやり直される | components-content 追従と再検証 |
| T-RUN-32 | 追従中、ページの変化がなくても1秒ごとに `locate` がやり直される | ADR-0052、constraints 時間 |
| T-RUN-33 | 再検証で、同じ条件の候補が増えて一意でなくなったとき、枠と吹き出しがすぐ消え、探し直される | FR-81、AC-55 |
| T-RUN-34 | 再検証で、要素が入れ替わって今の要素が選ばれなくなったとき、枠がすぐ消え、新しい要素が特定されて枠が移る | FR-81、AC-53 |
| T-RUN-35 | 再検証で、役割・所属する領域が変わって必須の照合を満たさなくなったとき、枠がすぐ消える | FR-81、AC-54 |
| T-RUN-36 | 再検証で、必須の照合に指定した名前が変わって満たさなくなったとき、枠がすぐ消える | FR-81 |
| T-RUN-37 | 再検証で、対象または読み替えた要素が表示されなくなったとき（祖先が透明など）、枠がすぐ消える | FR-81、AC-56 |
| T-RUN-38 | 再検証で、読み替えた要素が不適格（body・全面を覆う要素）になったとき、枠がすぐ消える | FR-81 |
| T-RUN-39 | 現在のページが URL 条件または `origins` から外れたとき、枠がすぐ消える | FR-81 |
| T-RUN-40 | 枠が消えた後、喪失後の探し直しが8秒間続き、見つからなければ `missing` に移る | components-content 追従と再検証、errors 再検証 |
| T-RUN-41 | 再検証で補助の照合（名前）だけが一致しなくなったとき、枠と吹き出しは残り、`nameMismatch` が報告される | FR-82、AC-57、components-content 追従と再検証 |
| T-RUN-42 | ステップに入って8秒以内に初めて特定し、`attended` が真で、要素が画面外のとき、1回だけスクロールする | FR-41 |
| T-RUN-43 | 同じステップで、特定が一度消えて再び特定されたとき、2回目はスクロールしない | FR-41（1回だけ）、AC-53 |
| T-RUN-44 | 8秒を過ぎてから初めて特定したとき、`attended` が真で画面外でもスクロールしない | FR-41 |
| T-RUN-45 | `attended` が偽のとき、8秒以内に特定して画面外でもスクロールしない | FR-41、AC-15 |
| T-RUN-46 | 8秒以内に特定した要素がすでに画面内にあるとき、スクロールしない | FR-41 |
| T-RUN-47 | `SCROLL_TO_TARGET` を受けたとき、`attended` や8秒の条件に関係なく対象の位置までスクロールする | FR-42、components-content スクロール |
| T-RUN-48 | `SCROLL_TO_TARGET` を受けたとき、対象が未特定なら何も起きない | FR-42 |
| T-RUN-49 | `donePage` が真の RENDER を受けたとき、`locate` が実行されず、ハイライトも出ず、ミニガイドだけが表示される | FR-63、components-content 完了ページ |
| T-RUN-50 | ハイライト中に `donePage` が真の RENDER を受けたとき、枠と吹き出しが消え、探索も止まる | FR-63、AC-12 |
| T-RUN-51 | CLEAR を受けたとき、表示・タイマー・Observer・保留中の処理がすべて破棄される | components-content 停止、FR-59 |
| T-RUN-52 | CLEAR の後に、保留中だった探索の結果が届いても、採用されず何も表示されない | components-content 停止、処理のトークン |
| T-RUN-53 | 新しい世代の RENDER を受けたとき、前の世代のタイマーと Observer が破棄され、二重に動かない | components-content 停止 |

### 非同期処理のトークン

| ID | テストケース（説明） | 根拠 |
|---|---|---|
| T-RUN-54 | 探索中に `gen` が変わったとき、遅れて届いた古い探索結果が捨てられる | components-content 処理のトークン、FR-83 |
| T-RUN-55 | ステップ3で探索中に4へ移り、すぐ3へ戻ったとき、最初の探索結果が捨てられる | AC-58、FR-83 |
| T-RUN-56 | 探索中に `pageSeq` が変わったとき、前のページの探索結果が捨てられる | AC-59、FR-83 |
| T-RUN-57 | 探索中に `rev` が変わったとき、古い `rev` の探索結果が捨てられる | components-content 処理のトークン |
| T-RUN-58 | 判定中に `(sessionId, gen, pageSeq, rev)` が変わったとき、遅れて届いた目安の判定結果が捨てられる | components-content 処理のトークン、AC-59 |
| T-RUN-59 | トークンが現在と一致する結果は、採用されて表示と報告に反映される | components-content 処理のトークン |

### 自分の表示の変化の無視と報告

| ID | テストケース（説明） | 根拠 |
|---|---|---|
| T-RUN-60 | 自分の表示のホスト要素の中で DOM が変わったとき、変化として記録されず、`locate` が起動しない | components-content ページの変化の検知、ADR-0054 |
| T-RUN-61 | ページの `childList`・`characterData` の変化があったとき、変化として記録される | components-content ページの変化の検知 |
| T-RUN-62 | 監視対象の属性（id・class・aria-checked など）が変わったとき、変化として記録される | components-content ページの変化の検知 |
| T-RUN-63 | 監視対象外の属性（例：`title`、`data-foo`）が変わったとき、変化として記録されない | components-content ページの変化の検知 |
| T-RUN-64 | 変化があったとき、その場では `locate` が実行されず、記録だけが行われて次の間引きの機会に実行される | components-content ページの変化の検知 |
| T-RUN-65 | 同じ特定結果が続くとき、`LOCATE_RESULT` は最初の1回だけ送られる | components-content 報告 |
| T-RUN-66 | 特定結果が変わったとき（found から missing など）、`LOCATE_RESULT` が送られる | components-content 報告 |
| T-RUN-67 | 目安の状態（met・unsupported）が変わらないとき、`HINT_STATE` は繰り返し送られない | components-content 報告 |
| T-RUN-68 | 目安の状態が変わったとき、`HINT_STATE` が送られる | components-content 報告 |
| T-RUN-69 | `LOCATE_RESULT`・`HINT_STATE` には、現在の `sessionId`・`gen`・`pageSeq` が付く | components-content 報告、data-flow メッセージ |

## 完了の目安の監視（content/watch）

| ID | テストケース（説明） | 根拠 |
|---|---|---|
| T-WATCH-01 | `filled` の対象に1文字以上の値があるとき、満たしている（met）と判定される | FR-60、components-content watch |
| T-WATCH-02 | `filled` の対象の値が空のとき、満たしていないと判定される | FR-64、AC-07 |
| T-WATCH-03 | `filled` の対象が `type="password"` のとき、判定せず `unsupported` が返る | FR-66、AC-72 |
| T-WATCH-04 | `type="password"` の対象で、値が入っていても空でも、`unsupported` が返る | FR-66、NFR-06〜08 |
| T-WATCH-05 | `filled` の判定で、値そのものが結果・ログ・変数に残らず、文字数だけが使われる | components-content watch、NFR-06〜08、AC-72 |
| T-WATCH-06 | `checked` で、`checked` プロパティが真のとき、満たしている | components-content watch |
| T-WATCH-07 | `checked` で、`aria-checked="true"` のとき、満たしている | components-content watch |
| T-WATCH-08 | `checked` で、プロパティが偽（または `aria-checked="false"`）のとき、満たしていない | components-content watch、FR-64 |
| T-WATCH-09 | `selected` で `aria-selected="true"` のとき、満たしている。偽のときは満たしていない | components-content watch |
| T-WATCH-10 | `expanded` で `aria-expanded="true"` のとき、満たしている。偽のときは満たしていない | components-content watch |
| T-WATCH-11 | `pressed` で `aria-pressed="true"` のとき、満たしている。偽のときは満たしていない | components-content watch |
| T-WATCH-12 | `element` で、要素特定エンジンが要素を見つけるとき、満たしている | FR-60、components-content watch |
| T-WATCH-13 | `element` で、要素が見つからなくなったとき、満たしていない状態に戻る | FR-64 |
| T-WATCH-14 | 状態を判定する要素（目安の対象）が、ハイライトする要素と別に指定されているとき、目安は目安の対象で判定される | FR-67 |
| T-WATCH-15 | `allowHidden` が指定され、対象が非表示のとき、判定の対象になる | FR-78 |
| T-WATCH-16 | `allowHidden` の指定がなく、対象が非表示のとき、対象とみなされない | FR-78 |
| T-WATCH-17 | `input` イベントが起きたとき、すぐに判定が行われる | components-content watch、FR-64 |
| T-WATCH-18 | `change` イベントが起きたとき、すぐに判定が行われる | components-content watch |
| T-WATCH-19 | ページが変化したとき、判定が行われる | components-content watch |
| T-WATCH-20 | イベントを伴わずに値がスクリプトで変わったとき、1秒以内の定期確認で判定が更新される | FR-64、AC-08、ADR-0055 |
| T-WATCH-21 | `selected` が偽の間、イベントや定期確認があっても判定されない | components-content watch、FR-65 |
| T-WATCH-22 | 満たしていた目安が、入力を消すなどで満たさなくなったとき、満たしていない状態に戻る | FR-64、AC-07 |
| T-WATCH-23 | 完了の目安が満たされても、ステップは自動で進まない | FR-62、ADR-0025 |
| T-WATCH-24 | 完了ページ（`done.type: page`）の目安は、ページ側では判定されない | components-content watch（役割） |

## ハイライト・吹き出し（content/overlay）

| ID | テストケース（説明） | 根拠 |
|---|---|---|
| T-OVL-01 | `paint` を呼んだとき、ホスト要素の Shadow DOM が閉じた（closed）モードで作られ、ページから `shadowRoot` を取得できない | components-content overlay、技術検証6 |
| T-OVL-02 | 描画した減衰板と枠が `pointer-events: none` になっている | components-content overlay、NFR-01〜05 |
| T-OVL-03 | 減衰板が4枚で、対象の周囲を覆い、対象の矩形の上は覆わない | components-content overlay（ハイライト） |
| T-OVL-04 | ミニガイドが展開しているとき、4枚の減衰板がミニガイドの矩形と重ならない | components-content overlay、AC-32 |
| T-OVL-05 | ミニガイドが最小化（バー28 px）のとき、減衰板がバーの矩形と重ならない | components-content overlay |
| T-OVL-06 | ミニガイドがないとき（`miniGuideRect` なし）、減衰板が制限なく周囲を覆う | components-content overlay |
| T-OVL-07 | 吹き出しの下に十分な空きがあるとき、対象の下に置かれる | components-content overlay 配置、ADR-0057 |
| T-OVL-08 | 下に収まらず上に収まるとき、対象の上に置かれる | components-content overlay 配置 |
| T-OVL-09 | 下にも上にも収まらず左に収まるとき、対象の左に置かれる | components-content overlay 配置 |
| T-OVL-10 | 対象がミニガイドの近くの右端にあるとき、吹き出しがミニガイドの領域と重ならない位置に置かれる | FR-39、AC-32 |
| T-OVL-11 | 配置の範囲が、表示領域からミニガイドの領域（展開時は幅、最小化時はバーの幅）を除いたものになっている | components-content overlay 配置 |
| T-OVL-12 | 吹き出しの `title`・`tip` に `<b>` などの HTML 文字列が含まれるとき、タグを含めて文字列として描かれ、要素にならない（textContent） | components-content overlay、FR-15、NFR-06〜08 |
| T-OVL-13 | `tip` の強調・インラインコードだけが装飾され、それ以外の記法は装飾されない | components-content overlay、FR-21 |
| T-OVL-14 | 目安の状態（満たした・まだ・確認できない・確認を停止中）が吹き出しに表示される | FR-61、FR-66、FR-65 |
| T-OVL-15 | 吹き出しの × を（`isTrusted` が真で）押したとき、`SET_OVERLAY{hidden: true, sessionId, opId}` が送られる | components-content overlay、FR-93 |
| T-OVL-16 | × を押した後、ハイライトと吹き出しは消え、ミニガイドは消えない | components-content overlay、AC-18 |
| T-OVL-17 | ページのスクリプトが発生させたクリック（`isTrusted` が偽）では、× は何も送らない | NFR-16、AC-31 |
| T-OVL-18 | ミニガイドが無効（`ui.enabled` が偽）で、表示が消えているとき、表示を戻すボタンが出る | FR-95、AC-19 |
| T-OVL-19 | ミニガイドが有効なとき、表示を戻すボタンはページ上に出ない | FR-95 |
| T-OVL-20 | 表示を戻すボタンを（`isTrusted` が真で）押したとき、`SET_OVERLAY{hidden: false}` が送られる | FR-95 |
| T-OVL-21 | `isTrusted` が偽のクリックでは、表示を戻すボタンは何も送らない | NFR-16 |
| T-OVL-22 | 案内だけの手順・不一致・完了ページ（ハイライトなし）では、表示を戻すボタンを含めページ上に何も出ない | FR-45、FR-95、AC-20 |
| T-OVL-23 | `clear()` を呼んだとき、枠・減衰板・吹き出し・ボタンがすべて取り除かれる | components-content overlay |
| T-OVL-24 | すべてのボタンが `<button>` で作られ、キーボード（Enter・Space）で操作できる | components-content overlay、NFR-01〜05 |
| T-OVL-25 | キーボードのフォーカスが見える（フォーカス表示の指定がある） | components-content overlay |

## ミニガイド（content/miniguide）

| ID | テストケース（説明） | 根拠 |
|---|---|---|
| T-MG-01 | `ui.enabled` が偽のとき、ミニガイドが描かれない | FR-53、components-content miniguide |
| T-MG-02 | `ui.enabled` が偽に変わったとき、すでに描かれたミニガイドが取り除かれる | FR-53 |
| T-MG-03 | 描画指示が届いていないとき、ミニガイドが描かれない | components-content miniguide（表示する条件） |
| T-MG-04 | ミニガイドのホストが閉じた Shadow DOM になっている | components-content miniguide、技術検証6 |
| T-MG-05 | 展開のとき、右端に固定され、`width` の幅で表示される | FR-49、components-content 表示状態 |
| T-MG-06 | 展開のとき、ステップ番号（n/N）・見出し・`tip`・目安の状態が表示される | FR-48 |
| T-MG-07 | 文章だけの案内のとき、案内文が表示される | FR-48 |
| T-MG-08 | 最終ステップのとき、「次へ」の代わりに「完了」が表示される | FR-54 |
| T-MG-09 | 最初のステップのとき、「戻る」が無効になる | FR-54 |
| T-MG-10 | ページ上の表示が消えているとき、「表示を戻す」が表示される。消えていないときは表示されない | FR-48、FR-95 |
| T-MG-11 | 最小化のとき、幅28 px のバーが表示され、ステップ番号と目安の状態が出る | FR-49、AC-28 |
| T-MG-12 | 最小化のバーをクリックしたとき、展開に変わり `SET_UI{mode}` が送られる | FR-49、AC-28 |
| T-MG-13 | 最小化のバーにフォーカスして Enter を押したとき、展開に変わる | components-content 表示状態、NFR-01〜05 |
| T-MG-14 | ホバーのとき、普段はバーだけが表示される | FR-49、AC-29 |
| T-MG-15 | ホバーのとき、`pointerenter` で展開する | components-content 表示状態、AC-29 |
| T-MG-16 | ホバーのとき、`focusin` で展開する | FR-49、AC-29 |
| T-MG-17 | ホバーで展開した後、`pointerleave` から300ミリ秒たつとバーに戻る | components-content 表示状態、constraints 時間 |
| T-MG-18 | ホバーで展開した後、`focusout` から300ミリ秒たつとバーに戻る | components-content 表示状態 |
| T-MG-19 | `pointerleave` から300ミリ秒以内に `pointerenter` が起きたとき、バーに戻らず展開のまま | components-content 表示状態 |
| T-MG-20 | 300ミリ秒より前（299ミリ秒時点）では、バーに戻っていない | constraints 時間 |
| T-MG-21 | 左の境界のつまみをドラッグしたとき、幅が変わる（左へ動かすと広がり、右へ動かすと狭まる） | FR-49、components-content 表示状態 |
| T-MG-22 | ドラッグ中は `SET_UI` が送られず、離したときに1回だけ `SET_UI{mode, width}` が送られる | components-content 操作 |
| T-MG-23 | ドラッグで240 px より小さくしようとしたとき、幅が240 pxに制限される | FR-50、constraints 上限値 |
| T-MG-24 | ドラッグで560 px より大きくしようとしたとき、幅が560 pxに制限される | FR-50、constraints 上限値 |
| T-MG-25 | つまみにフォーカスして右キー・左キーを押したとき、幅が16 px ずつ変わる | components-content 表示状態、NFR-01〜05 |
| T-MG-26 | キーボードの変更でも、240〜560 px の範囲を超えない | FR-50 |
| T-MG-27 | キーボードで幅を変えたとき、`SET_UI` が送られる | components-content 操作 |
| T-MG-28 | 範囲外の `width` を受け取ったとき、範囲内に収めて表示する | FR-50 |
| T-MG-29 | 「戻る」を押したとき、`GOTO{to: 現在-1, sessionId, gen, opId}` が送られる | components-content 操作、FR-51 |
| T-MG-30 | 「次へ」を押したとき、`GOTO{to: 現在+1, sessionId, gen, opId}` が送られる | components-content 操作、FR-51 |
| T-MG-31 | 最終ステップで「完了」を押したとき、`GOTO`（最終の次）が送られる | FR-58、components-content 操作 |
| T-MG-32 | 「対象を表示」を押したとき、`SCROLL_TO_TARGET` が送られる | FR-42、components-content 操作 |
| T-MG-33 | 「表示を戻す」を押したとき、`SET_OVERLAY{hidden: false}` が送られる | components-content 操作、FR-95 |
| T-MG-34 | 展開・最小化・ホバーの切り替えで、`SET_UI{mode, width}` が送られる | components-content 操作 |
| T-MG-35 | 「次へ」の連打で送る `opId` が、押すたびに別の値になる | architecture 識別子（opId）、AC-11 |
| T-MG-36 | `isTrusted` が偽のクリックでは、どのボタン（戻る・次へ・対象を表示・表示を戻す）もメッセージを送らない | NFR-16、AC-31 |
| T-MG-37 | `isTrusted` が偽のキー操作・ポインター操作では、バーも幅のつまみも反応しない | NFR-16、components-content 操作 |
| T-MG-38 | `isTrusted` が偽の `pointerenter` では、ホバーで展開しない | NFR-16、components-content 操作 |
| T-MG-39 | ミニガイドの表示状態の切り替えが、ページ上の表示（ハイライト・吹き出し）の表示・非表示に影響しない | FR-52、AC-33 |
| T-MG-40 | サイドパネルを開くショートカットキーの案内が、受け取った実際の割り当てで表示される | FR-48、FR-46、components-content miniguide |
| T-MG-41 | ショートカットが未割り当てのとき、割り当てがない旨の案内になる | FR-46（`getAll` の割り当て） |
| T-MG-42 | ミニガイドのすべてのボタンが `<button>` で、フォーカスが見える | NFR-01〜05 |
| T-MG-43 | 見出し・`tip` に HTML 文字列が含まれるとき、文字列のまま描かれる（textContent） | FR-15、NFR-06〜08 |
| T-MG-44 | `renderMiniGuide` を同じ内容で再度呼んでも、ミニガイドが二重に作られない | FR-105（表示の二重化なし） |

## 状態管理（background/session）

操作は直列化キューで処理し、storage と Chrome の API は偽物を使う。

### 受け付けと破棄

| ID | テストケース（説明） | 根拠 |
|---|---|---|
| T-SES-01 | STOP・PAUSE・RESUME・RESTART・RESUME_NEW・SET_OVERLAY は、`sessionId` が一致するときだけ受け付けられる | architecture 操作ごとの条件 |
| T-SES-02 | 上の操作で `sessionId` が違うとき、状態が変わらず、debug に理由コードだけが記録される | architecture、errors、FR-104、AC-61 |
| T-SES-03 | ツアー A の STOP が、ツアー B の開始後に届いたとき、ツアー B に作用しない | AC-61、FR-104 |
| T-SES-04 | GOTO・BIND_TAB・OPEN_IN・FOCUS_ROLE・RECHECK・SCROLL_TO_TARGET は、`sessionId` と `gen` の両方が一致するときだけ受け付けられる | architecture 操作ごとの条件 |
| T-SES-05 | 上の操作で `gen` だけが違うとき、捨てられる | architecture、FR-57 |
| T-SES-06 | ツアー A の OPEN_IN が、ツアー B の開始後に届いたとき、ツアー B に作用しない | AC-61、FR-104 |
| T-SES-07 | ページ側からの操作（GOTO・SCROLL_TO_TARGET・SET_OVERLAY・SET_UI）は、`sender.tab.id` が役割のタブ・`sender.frameId === 0`・`sender.documentId` が記録済みのときだけ受け付けられる | architecture 操作ごとの条件 |
| T-SES-08 | ページ側からの操作で、`sender.tab.id` が役割のタブでないとき、捨てられる | architecture |
| T-SES-09 | ページ側からの操作で、`frameId` が0でないとき（iframe）、捨てられる | architecture |
| T-SES-10 | ページ側からの操作で、`documentId` が記録済みのものと違うとき、捨てられる | architecture |
| T-SES-11 | ページ側からの報告は、`sender` の条件に加えて `sessionId`・`gen`・`pageSeq` がすべて一致するときだけ受け付けられる | architecture 操作ごとの条件 |
| T-SES-12 | 報告の `pageSeq` が現在と違うとき、捨てられる | architecture、AC-59 |
| T-SES-13 | 報告の `gen` が現在と違うとき、捨てられる | architecture、FR-83 |
| T-SES-14 | 報告の `sessionId` が違うとき、捨てられる | architecture |
| T-SES-15 | ステップ3で `gen` が3の報告が保留中に、4へ移り3へ戻ったとき（`gen` は5）、`gen` 3の古い報告が捨てられる | AC-58、architecture（3→4→3） |
| T-SES-16 | 3→4→3 の後でも、`gen` 5 の新しい報告は受け付けられる | AC-58 |
| T-SES-17 | 本文の自己申告（本文の tabId など）ではなく `sender` で送信元が確かめられる | architecture 識別子（sender） |
| T-SES-18 | 実行中の状態がないとき、`sessionId` を伴う操作が捨てられる | architecture、FR-104 |

### opId の重複排除

| ID | テストケース（説明） | 根拠 |
|---|---|---|
| T-SES-19 | 同じ `opId` の GOTO が2回届いたとき、1回だけ処理され、`gen` は1しか増えない | FR-57、AC-11 |
| T-SES-20 | サイドパネルとミニガイドから同じ `gen` の GOTO がほぼ同時に届いたとき、先の1回だけ処理され、後の `gen` 違いは捨てられる | FR-57、data-flow ② |
| T-SES-21 | 処理した `opId` が `recentOpIds` に加えられ、storage.session に保存される | architecture 状態の確定と保存の順序 |
| T-SES-22 | `recentOpIds` が51件目で、最も古いものから押し出され、直近50件だけが残る | constraints 上限値 |
| T-SES-23 | 直近50件に入っている `opId` は重複として捨てられ、51件前の `opId` は新規として扱われる | constraints 上限値 |
| T-SES-24 | Service Worker の再起動後も、`recentOpIds` から重複が判定される | architecture 復帰、FR-105 |
| T-SES-25 | 捨てられた操作（識別子の不一致）の `opId` は、`recentOpIds` に加えられない | architecture 手順2（受け付けた操作の `opId` を加える） |

### 確定と保存の順序

| ID | テストケース（説明） | 根拠 |
|---|---|---|
| T-SES-26 | 操作を処理するとき、storage.session への書き込みが、storage.local への進捗の書き込みより先に行われる | architecture 手順3・4 |
| T-SES-27 | 外への作用（ページ側への RENDER・CLEAR、サイドパネルへの通知）が、storage.session への書き込みの後にだけ行われる | architecture 手順5、ADR-0047 |
| T-SES-28 | 応答が、外への作用の後に返される | architecture 手順6 |
| T-SES-29 | 進捗が `{ sessionId, gen, stepId, stepIndex, savedAt }` の形で storage.local に書かれる | architecture 手順4 |
| T-SES-30 | 同じ `sessionId` で、より大きい `gen` の進捗がすでにあるとき、進捗が書かれない | architecture 手順4、ADR-0047 |
| T-SES-31 | 別の `sessionId` の進捗があるとき、それは上書きされる | architecture 手順4（同じ `sessionId` に限る） |
| T-SES-32 | 完了・終了のとき、状態が `ended`（`sessionId` を残す）として確定されてから、進捗が削除される | architecture 状態の確定と保存の順序 |
| T-SES-33 | 操作が直列化キューで順に処理され、2つの操作が並行して状態を書き換えない | architecture 全体 |
| T-SES-34 | キューの中で、YAML・zip・画像の解析のような重い処理が行われない | architecture 全体 |

### 保存処理の各段階で中断させたときの復帰

| ID | テストケース（説明） | 根拠 |
|---|---|---|
| T-SES-35 | GOTO の処理で、storage.session への書き込みの前に打ち切って復帰したとき、状態は移動前のままで、表示が二重にならない | testing 状態管理、AC-66 |
| T-SES-36 | GOTO の処理で、storage.session への書き込み直後（進捗の書き込み前）に打ち切って復帰したとき、状態は移動後で、進捗が状態に合わせて書き直される | architecture 復帰の手順3、AC-66 |
| T-SES-37 | GOTO の処理で、進捗の書き込み後（RENDER の送信前）に打ち切って復帰したとき、`rev` が進み、SYNC で現在のステップが描画される | architecture 復帰の手順4、AC-66 |
| T-SES-38 | GOTO の処理で、RENDER の送信後（応答前）に打ち切って復帰したとき、ステップが二重に移動しない | FR-105、AC-66 |
| T-SES-39 | 完了の処理で、`ended` の確定後（進捗の削除前）に打ち切って復帰したとき、同じ `sessionId` の進捗が削除され、進捗が復活しない | architecture 復帰の手順3、AC-66 |
| T-SES-40 | 終了の処理で、`ended` の確定前に打ち切って復帰したとき、実行中として復帰する（終了は利用者が再度操作する） | architecture 状態の確定と保存の順序 |
| T-SES-41 | 終了の処理で、進捗の削除の途中で打ち切って復帰したとき、進捗が復活しない | AC-66、FR-105 |
| T-SES-42 | 復帰時、状態が実行中で、進捗の `gen` が状態より小さいとき、状態に合わせて進捗が書き直される | architecture 復帰の手順3 |
| T-SES-43 | 復帰時、状態が `ended` で、同じ `sessionId` の進捗が残っているとき、それが削除される | architecture 復帰の手順3 |
| T-SES-44 | 復帰時、状態が `ended` で、別の `sessionId` の進捗があるとき、削除されない | architecture 復帰の手順3 |
| T-SES-45 | 復帰時、実行中なら `rev` が進められ、役割のタブに `SYNC{sessionId, gen, rev}` が送られ、現在のステップが描画し直される | architecture 復帰の手順4 |
| T-SES-46 | 復帰時、状態がなければ（storage.session が空）、実行中として扱わない | architecture 復帰の手順1 |
| T-SES-47 | 復帰後の `rev` は、復帰前に送った `rev` より大きい（単調に増える） | architecture 識別子（rev） |
| T-SES-48 | 利用者に見せたステップから、復帰によって巻き戻らない | FR-105 |
| T-SES-49 | 一時中断の状態で復帰したとき、描画指示は送られず、表示は出ない | FR-99、architecture 復帰の手順4 |

### pendingDeletes と saveError

| ID | テストケース（説明） | 根拠 |
|---|---|---|
| T-SES-50 | 完了・終了で進捗の削除に失敗したとき、`pendingDeletes` に `{ tourId, sessionId }` が加えられ、完了・終了は成立する | FR-101、AC-68 |
| T-SES-51 | 起動時の復帰で、`pendingDeletes` の削除がやり直され、成功したものは一覧から外れる | architecture 復帰の手順2、AC-68 |
| T-SES-52 | `pendingDeletes` のやり直しが再び失敗したとき、一覧に残り、次回に再び試される | FR-101、architecture |
| T-SES-53 | `pendingDeletes` の削除が成功した後、その ID の「続きから」が出ない | AC-68 |
| T-SES-54 | `pendingDeletes` の `sessionId` と違う `sessionId` の進捗（新しい実行回）は、削除されない | architecture（`{ tourId, sessionId }`） |
| T-SES-55 | storage.session への書き込みが失敗したとき、メモリ上の状態で操作が続き、`saveError` が立つ | architecture 手順3、FR-98、AC-67 |
| T-SES-56 | storage.local への進捗の書き込みが失敗したとき、操作が続き、`saveError` が立つ | architecture 手順4、FR-98、AC-67 |
| T-SES-57 | `saveError` が立っているとき、次の確定で再び保存が試みられる | errors 状態・進捗の保存失敗 |
| T-SES-58 | `saveError` が立った後、次の保存がすべて成功したとき、`saveError` が下りる | components-background 状態管理（保存の失敗） |
| T-SES-59 | `saveError` が立った後、保存が再び失敗したとき、`saveError` が立ったままになる | components-background 状態管理 |

### 上書き・削除の検知と3択

| ID | テストケース（説明） | 根拠 |
|---|---|---|
| T-SES-60 | `CATALOG_CHANGED` で、実行中のツアーと ID が同じで `hash` が違うとき、`pauseReason: overwritten` で一時中断が確定する | FR-35、components-background ツアーの改訂 |
| T-SES-61 | 上書きによる一時中断で、全タブに `CLEAR` が送られる | data-flow ③、errors |
| T-SES-62 | `CATALOG_CHANGED` で、ID が同じで `hash` も同じとき、何も起きない | components-background ツアーの改訂 |
| T-SES-63 | `CATALOG_CHANGED` で、実行中でないツアーの ID のとき、何も起きない | components-background ツアーの改訂 |
| T-SES-64 | `CATALOG_CHANGED` で、実行中のツアーが削除されていたとき、終了（`ended`）が確定され、進捗が削除される | FR-36、AC-64 |
| T-SES-65 | 実行中のツアーの削除で、全タブに `CLEAR` が送られ、表示とミニガイドが消える | FR-36、AC-64 |
| T-SES-66 | 上書きによる一時中断の間、実行中のツアーは固定した `hash` のままで、勝手に新版へ切り替わらない | FR-34、AC-62 |
| T-SES-67 | `RESUME_NEW{mode: continue}` で、同じ stepId のステップから、新しい `sessionId`・新しい `hash` で再開される | FR-35、FR-63、AC-63、data-flow ③ |
| T-SES-68 | `RESUME_NEW{mode: continue}` で、同じ stepId が新版にないとき、最初のステップから再開される | FR-35、AC-63 |
| T-SES-69 | `RESUME_NEW{mode: restart}` で、最初のステップから新しい `sessionId` で再開される | FR-35、AC-63 |
| T-SES-70 | `RESUME_NEW` で、`gen` が新しい実行回で1から始まる | architecture 識別子 |
| T-SES-71 | `RESUME_NEW` が、上書きによる一時中断でないとき（利用者の操作・許可の取り消しの一時中断など）、受け付けられない | components-background resumeNew |
| T-SES-72 | 上書きによる一時中断の選択肢「終了」で、`STOP` が処理されて進捗が破棄される | FR-35、FR-100 |
| T-SES-73 | `RESUME_NEW` で、新しい `sessionId` が前の実行回と異なる | architecture 識別子 |

### start / goto / pause / resume / stop / restart

| ID | テストケース（説明） | 根拠 |
|---|---|---|
| T-SES-74 | `start` で、ツアーの `hash` が固定され、新しい `sessionId` ・`gen = 1` で状態が作られる | FR-34、data-flow ① |
| T-SES-75 | `start` で、必要な拡張機能のバージョンを満たすとき、開始される | FR-115、FR-32 |
| T-SES-76 | `start` で、必要なバージョンが現在より高いとき、開始されず、状態も作られず、現在と必要なバージョンが返る | FR-32、AC-23、errors |
| T-SES-77 | `start` で、必要なバージョンが現在と同じとき、開始される（境界） | FR-32、FR-115 |
| T-SES-78 | `start` で、ツアーが最低バージョンを宣言していないとき、バージョンの理由では拒否されない | FR-115 |
| T-SES-79 | `start` で、`origins` の権限がないとき、開始されず、状態も作られず、必要なサイトが返る | FR-26、AC-04、errors |
| T-SES-80 | `start(resume: false)` で、進捗があっても最初のステップから始まる | FR-31 |
| T-SES-81 | `start(resume: true)` で、進捗の stepId のステップから始まる | FR-31、FR-37 |
| T-SES-82 | `start(resume: true)` で、進捗の stepId がツアーに無いとき、ステップ1から始まり、その旨の通知が出る | FR-103、errors |
| T-SES-83 | `start(resume: true)` で、進捗がないとき、最初から始まる | FR-31 |
| T-SES-84 | `start` の確定後、進捗が storage.local に書かれる | FR-97 |
| T-SES-85 | `goto(to)` を受け付けたとき、`gen` が1増え、`stepIndex` と `stepId` が更新される | components-background goto、FR-97 |
| T-SES-86 | `goto` で、`to` が最終ステップの次のとき、完了となり、`ended` が確定されて進捗が削除される | components-background goto、FR-58 |
| T-SES-87 | 完了のとき、全タブに `CLEAR` が送られる | FR-59、AC-03 |
| T-SES-88 | ステップ一覧から任意のステップへ `goto` したとき、そのステップに移り、自動では先へ進まない | FR-55、AC-10 |
| T-SES-89 | 完了の目安を満たしていなくても、`goto` が受け付けられる | FR-62、AC-09 |
| T-SES-90 | 最初のステップから「戻る」の `goto(-1)` が来たとき、移動しない | FR-54 |
| T-SES-91 | `pause` で、`pauseReason: user` の一時中断が確定し、全タブに `CLEAR` が送られる | FR-99、components-background |
| T-SES-92 | `pause` の間、タブからの報告と、`gen` に依存する操作が処理されない | FR-99 |
| T-SES-93 | `resume` で、`gen` が1増え、描画指示が送られる | components-background resume |
| T-SES-94 | `resume` が、許可の取り消しによる一時中断の状態で、権限が戻っていないとき、再開されない | FR-99、errors |
| T-SES-95 | `stop` で、`ended` が確定し、進捗が削除され、全タブに `CLEAR` が送られる | FR-100、FR-59、AC-22 |
| T-SES-96 | 一時中断中でも `stop` が受け付けられる | FR-99、NFR-17 |
| T-SES-97 | `restart` で、新しい `sessionId`・ステップ1で状態が作られ、同じ `hash` が保たれる | components-background restart、FR-99 |
| T-SES-98 | `restart` の後、前の `sessionId` からの操作・報告が捨てられる | FR-104 |
| T-SES-99 | `permissions.onRemoved` による一時中断の依頼で、`pauseReason: permission` が確定し、表示が消える | FR-28、AC-24、errors |
| T-SES-100 | 自動でステップが進むことがない（目安を満たしても `goto` が起きない） | FR-56、ADR-0025 |

### ページ上の表示・設定

| ID | テストケース（説明） | 根拠 |
|---|---|---|
| T-SES-101 | `setOverlay(hidden: true)` で、`overlayHidden` が確定し、描画指示が送られる | components-background setOverlay、FR-93 |
| T-SES-102 | `overlayHidden` は、ステップの移動・ページの移動でも `false` に戻らない | FR-96、AC-18 |
| T-SES-103 | `overlayHidden` が真でも、目安の判定と案内は止まらない | FR-94 |
| T-SES-104 | `setUi(mode, width)` で、設定が storage.local の `settings.miniGuide` に保存される | components-background setUi、FR-50 |
| T-SES-105 | `setUi` の変更が、描画指示で全タブに反映される | ADR-0056、components-background |
| T-SES-106 | `setUi` で範囲外の `width` が来たとき、240〜560 px に収められて保存される | FR-50、constraints 上限値 |
| T-SES-107 | `setUi` で `enabled` だけを変えたとき、`mode` と `width` が保たれる | data-flow（`SET_UI{enabled?, mode?, width?}`） |
| T-SES-108 | `recheck()` で、`gen` が一致するとき、`RECHECK{rev}` が役割のタブに送られる | components-background recheck |
| T-SES-109 | `scrollToTarget()` で、`gen` が一致するとき、`SCROLL_TO_TARGET{rev}` が役割のタブに送られる | components-background scrollToTarget |
| T-SES-110 | ページ側からの `HINT_STATE` の結果が、状態の `hint{gen, met, unsupported}` に反映され、サイドパネルへ通知される | data-flow 保存するデータ |

## タブ管理（background/tabs）

### evaluate の判定

| ID | テストケース（説明） | 根拠 |
|---|---|---|
| T-TAB-01 | 役割のタブが `origins` 内で、URL 条件に合うとき、`ok` になる | components-background タブ管理 |
| T-TAB-02 | 役割のタブが、完了の目安の URL 条件に合うとき（ステップの URL 条件に合わなくても）、`donePage` になる | FR-63、AC-12 |
| T-TAB-03 | 役割のタブが、URL 条件にも完了ページにも合わないとき、`mismatch` になる | FR-91、AC-14 |
| T-TAB-04 | 役割にタブが対応付けられていないとき、`missing` になる | FR-85 |
| T-TAB-05 | ページ側を組み込めないタブのとき、`unsupported` になる | errors（ページ側の組み込みに失敗した） |
| T-TAB-06 | URL 条件にも完了ページにも合うとき、`donePage` が `ok` より優先される | ADR-0049、components-background |
| T-TAB-07 | `donePage` が `mismatch` より優先される | ADR-0049 |
| T-TAB-08 | `donePage` のとき、不一致の案内を出さず、正しいページへ戻す案内も出さない | FR-63、components-background |
| T-TAB-09 | `donePage` で、`donePage: true` が付いて描画が指示される | components-background |
| T-TAB-10 | `mismatch` のとき、そのタブの表示（ハイライトとミニガイド）を消す指示が送られ、そのタブで開くボタンが案内される | FR-91 |
| T-TAB-11 | `mismatch` のとき、新しいタブが作られない | FR-91、FR-87、AC-14 |
| T-TAB-12 | URL 条件に合うが `origins` の外のとき、`ok` にならない | FR-88、NFR-13 |
| T-TAB-13 | `guide` のステップのとき、判定せず、すべてのタブに `CLEAR` が送られる | components-background タブ管理、FR-45、AC-20 |
| T-TAB-14 | 現在のステップと無関係なタブには、何も表示する指示が送られない | FR-89 |
| T-TAB-15 | クエリ・フラグメントだけが違う URL でも、同じ判定になる | FR-70 |

### selected / attended

| ID | テストケース（説明） | 根拠 |
|---|---|---|
| T-TAB-16 | 役割のタブが自分のウィンドウで active のとき、`selected` が真になる | components-background 選択中・注目中 |
| T-TAB-17 | 役割のタブが active でないとき、`selected` と `attended` がともに偽になる | components-background 選択中・注目中、AC-16 |
| T-TAB-18 | active で、そのウィンドウにフォーカスがあるとき、`attended` が真になる | components-background 選択中・注目中 |
| T-TAB-19 | active だが、ウィンドウにフォーカスがないとき、`selected` が真で `attended` が偽になる | components-background、ADR-0015、AC-15 |
| T-TAB-20 | `attended` が偽のとき、「○○のタブへ移動」を出す状態が返る | FR-90、components-background |
| T-TAB-21 | `selected` が偽のとき、目安の表示が「確認を停止中」になる状態が返る | FR-65、components-background、AC-16 |
| T-TAB-22 | `tabs.onActivated` を受けたとき、判定し直され、結果が変わっていれば描画指示が送られる | components-background 選択中・注目中 |
| T-TAB-23 | `windows.onFocusChanged` を受けたとき、判定し直され、結果が変わっていれば描画指示が送られる | components-background 選択中・注目中 |
| T-TAB-24 | 判定の結果が変わらないとき、描画指示は送られない | components-background（変わったら描画指示） |
| T-TAB-25 | 役割を自動で対応付けることがない（`missing` のとき、注目中のタブが条件に合っても自動で対応付けない） | FR-87、components-background、ADR-0027 |
| T-TAB-26 | 別のウィンドウで作業中でも、タブが自動で切り替えられない | FR-87、AC-15 |

### candidates

| ID | テストケース（説明） | 根拠 |
|---|---|---|
| T-TAB-27 | `candidates` に、URL 条件に合う既存のタブが入る | FR-85、components-background |
| T-TAB-28 | 別のウィンドウのタブも `candidates` に入る | FR-85、AC-13 |
| T-TAB-29 | URL 条件に合わないタブは `candidates` に入らない | components-background |
| T-TAB-30 | `origins` の外のタブは `candidates` に入らない | FR-88、NFR-13 |
| T-TAB-31 | 別の役割に対応付け済みのタブには、その旨の印が付く | FR-86、components-background |
| T-TAB-32 | 注目中のタブが URL 条件に合うとき、「このタブを使う」が選べる状態が返る | FR-85 |
| T-TAB-33 | 注目中のタブが条件に合わないとき、「このタブを使う」は出ない | FR-85 |
| T-TAB-34 | 条件に合うタブがないとき、`candidates` が空で、「今のタブで開く」「新しいタブで開く」が選べる | FR-85、AC-13 |

### pageSeq・HELLO・介入前の確認

| ID | テストケース（説明） | 根拠 |
|---|---|---|
| T-TAB-35 | 役割のタブで `frameId === 0` の onCommitted を受けたとき、`pageSeq` が1増える | components-background ページ世代 |
| T-TAB-36 | 役割のタブで `frameId === 0` の onHistoryStateUpdated を受けたとき、`pageSeq` が増え、描画し直される | components-background ページ世代 |
| T-TAB-37 | `frameId !== 0` のナビゲーションイベントでは、`pageSeq` が変わらない | components-background（`frameId === 0`） |
| T-TAB-38 | 役割でないタブのナビゲーションイベントでは、`pageSeq` が変わらない | FR-89 |
| T-TAB-39 | onCommitted を受けたとき、ページ側が組み込み直される | components-background ページ世代 |
| T-TAB-40 | 同じタブの onCommitted が150ミリ秒以内に続いたとき、デバウンスされ、1回の処理にまとまる | constraints 時間（遷移検知のデバウンス） |
| T-TAB-41 | onCompleted を受けたとき、組み込みに失敗していたタブの組み込みが再試行される | errors（ページ側の組み込みに失敗した） |
| T-TAB-42 | `HELLO` を受けたとき、その `sender.documentId` が役割のタブの文書として記録される | components-background ページ世代、architecture |
| T-TAB-43 | 同じタブで別の文書（遷移後）から `HELLO` が届いたとき、`documentId` が新しい値に更新される | 技術検証3、architecture |
| T-TAB-44 | `HELLO` が役割のタブ以外から届いたとき、記録されない | architecture |
| T-TAB-45 | 組み込み・描画指示の前に、タブの URL が実行中のツアーの `origins` に含まれることが確認される | components-background 介入の前の確認、NFR-13 |
| T-TAB-46 | タブの URL が実行中のツアーの `origins` に含まれないとき、他のツアーで権限を得ていても、組み込みも描画指示も行われない | NFR-13、AC-25、ADR-0059 |
| T-TAB-47 | `origins` に含まれるが権限がないとき、組み込みが失敗として扱われ、`unsupported` になる | errors、components-background |

### bindTab・openInTab・focusRole・タブの消失

| ID | テストケース（説明） | 根拠 |
|---|---|---|
| T-TAB-48 | `bindTab(tabId, false)` で、未対応付けのタブが役割に対応付けられる | FR-85、components-background |
| T-TAB-49 | `bindTab` の対応付けは、利用者が選んだときだけ（BIND_TAB を受けたときだけ）行われる | FR-87、ADR-0027 |
| T-TAB-50 | 別の役割に対応付け済みのタブを `force` なしで `bindTab` したとき、対応付けは変わらず、確認が必要と返る | FR-86、components-background |
| T-TAB-51 | 別の役割に対応付け済みのタブを `force` ありで `bindTab` したとき、付け替えられる | FR-86 |
| T-TAB-52 | 付け替えたとき、元の役割の対応付けが外れ、1つのタブが1つの役割だけに対応付く | FR-86、ADR-0027 |
| T-TAB-53 | 同じ役割に同じタブをもう一度 `bindTab` したとき、確認なしで変わらない | FR-86 |
| T-TAB-54 | `bindTab` の後、`origins` を確認してからページ側が組み込まれ、`HELLO` の後に `RENDER` が送られる | data-flow ① 手順4 |
| T-TAB-55 | `openInTab("current")` で、今のタブでステップの URL が開かれ、役割に対応付けられる | FR-85、components-background |
| T-TAB-56 | `openInTab("new")` で、新しいタブが作られ、役割に対応付けられる | FR-85 |
| T-TAB-57 | 開く URL が `origins` に含まれないとき、`openInTab` は開かない | FR-24、NFR-13 |
| T-TAB-58 | `openInTab` は、OPEN_IN を受けたときだけ行われ、ステップに入っただけでは開かない | FR-87、AC-13 |
| T-TAB-59 | `focusRole()` で、役割のタブがアクティブになり、そのウィンドウが前面に出る | FR-90、components-background |
| T-TAB-60 | 役割にタブがないとき、`focusRole()` は何も起きない | FR-90 |
| T-TAB-61 | 役割のタブが閉じられたとき（`tabs.onRemoved`）、対応付けが外れ、ツアーは続く | FR-92、errors、AC-17 |
| T-TAB-62 | 役割のタブが閉じられたとき、判定が `missing` になり、候補と開くボタンが案内される | FR-92、errors |
| T-TAB-63 | 役割でないタブが閉じられたとき、状態は変わらない | components-background |
| T-TAB-64 | 閉じた後、別のタブを対応付けたとき、同じステップから続けられる | AC-17、FR-92 |
| T-TAB-65 | 役割のタブが閉じられたとき、新しいタブが自動で作られない | FR-87、FR-92 |

## ツアー管理（background/catalog）

| ID | テストケース（説明） | 根拠 |
|---|---|---|
| T-CAT-01 | `list()` で、同梱ツアーと取り込んだツアーの両方が返る | FR-04、components-background catalog |
| T-CAT-02 | 同梱ツアーと同じ ID の取り込んだツアーがあるとき、取り込んだものが優先される | FR-05、AC-39 |
| T-CAT-03 | 優先された一覧の項目の出所が「取り込み」と表示される | FR-07、AC-39 |
| T-CAT-04 | 取り込んだツアーを `remove` したとき、同じ ID の同梱版が再び使われる | FR-06 |
| T-CAT-05 | 同梱ツアーを `remove` しようとしたとき、削除されない | FR-04 |
| T-CAT-06 | `get(id)` で、存在する ID のツアーが返る。存在しない ID のとき、見つからないと返る | components-background catalog |
| T-CAT-07 | `getPinned(id, hash)` で、実行中に固定した `hash` の内容が返る | FR-34、components-background catalog |
| T-CAT-08 | ツアーが上書きされた後でも、`getPinned` に旧 `hash` を渡したとき、固定した内容が返る（実行中の状態の扱いに沿う） | FR-34 |
| T-CAT-09 | 取り込んだツアーが、IndexedDB の `compiled` から zod で検証し直されて使われ、バックグラウンドで YAML は解析されない | components-background catalog |
| T-CAT-10 | `compiled` が zod の検証に通らないとき、そのツアーは一覧から除かれ、他のツアーには影響しない | FR-09、components-background catalog |
| T-CAT-11 | 同梱ツアーが `runtime.onInstalled` のときに読み込まれ、`hash` が計算される | FR-11、components-background catalog |
| T-CAT-12 | 拡張機能の更新時の `onInstalled` で、同梱ツアーの最新版が一覧に反映される | FR-11 |
| T-CAT-13 | 同じ内容の同梱ツアーは、同じ `hash` になる | components-background catalog |
| T-CAT-14 | `remove(id)` で、そのツアーのツアー本体・ファイルが IndexedDB から消える | FR-03、components-background catalog |
| T-CAT-15 | `remove(id)` で、そのツアーの保守記録も消える | components-background catalog |
| T-CAT-16 | `remove(id)` で、合計容量（`meta.totalBytes`）がそのツアーの `totalBytes` の分だけ戻る | components-background catalog、FR-03 |
| T-CAT-17 | `remove(id)` で、他のツアーのファイル・保守記録・容量は変わらない | FR-03 |
| T-CAT-18 | 存在しない ID の `remove` で、何も変わらない | components-background catalog |
| T-CAT-19 | `remove` の後、キャッシュが破棄され、`list()` に反映される | components-background キャッシュ |
| T-CAT-20 | `reload()` でキャッシュが破棄され、保存済みのデータから一覧が組み立て直される | FR-08、components-background キャッシュ |
| T-CAT-21 | `CATALOG_CHANGED` を受けたとき、キャッシュが破棄される | components-background キャッシュ |
| T-CAT-22 | `runtime.onInstalled` のとき、キャッシュが破棄される | components-background キャッシュ |
| T-CAT-23 | キャッシュが破棄された後の `get` で、保存済みのデータだけから組み立て直される（Service Worker の再起動後と同じ結果） | components-background キャッシュ、FR-13 |
| T-CAT-24 | 同じ ID の更新で `CATALOG_CHANGED` を受けたとき、新しい `hash` の内容が `get` で返る | FR-05、components-background |

## 権限（shared/permissions）

| ID | テストケース（説明） | 根拠 |
|---|---|---|
| T-PERM-01 | `patternsOf(tour)` で、`origins` の各オリジンから、ホスト単位のマッチパターン（`https://host/*`）が作られる | components-background 権限、FR-25 |
| T-PERM-02 | `origins` にポートがあるとき（`https://example.com:8443`）、ポートが捨てられて `https://example.com/*` になる | components-background 権限 |
| T-PERM-03 | `http` と `https` の両方が `origins` にあるとき、それぞれのスキームのパターンになる | FR-25、components-background 権限 |
| T-PERM-04 | 同じホストでポートだけが違う2つの `origins` から、重複のない1つのパターンになる | components-background 権限（ポートは捨てる） |
| T-PERM-05 | `patternsOf` が `origins` だけから作られ、ステップの URL や他の項目は使われない | ADR-0059、FR-24 |
| T-PERM-06 | `patternsOf` の結果にワイルドカードのホストが含まれない | FR-23 |
| T-PERM-07 | `has(tour)` で、すべてのパターンの権限があるとき、真になる | FR-27 |
| T-PERM-08 | `has(tour)` で、1つでも権限がないパターンがあるとき、偽になる | FR-27 |
| T-PERM-09 | 他のツアーの権限があっても、このツアーの `origins` にないホストは、このツアーの `has` に影響しない | NFR-13、AC-25 |
| T-PERM-10 | `request(tour)` で、`origins` のパターンだけが `chrome.permissions.request` に渡される | FR-25、AC-04 |
| T-PERM-11 | `request` が拒否されたとき、偽が返り、状態は作られず、必要なサイトが分かる | FR-26、AC-04 |
| T-PERM-12 | `request` が許可されたとき、真が返る | FR-25 |
| T-PERM-13 | `request` が、await を挟まずに `chrome.permissions.request` を呼ぶ（利用者の操作の中で呼べる） | components-background 権限 |
| T-PERM-14 | `permissions.onRemoved` で、実行中のツアーの `origins` の権限が取り消されたとき、一時中断（`pauseReason: permission`）が依頼される | FR-28、AC-24 |
| T-PERM-15 | `permissions.onRemoved` で、実行中のツアーと無関係なオリジンの権限が取り消されたとき、一時中断が依頼されない | FR-28（実行中のツアーに限る） |
| T-PERM-16 | 実行中のツアーがないとき、`permissions.onRemoved` で何も起きない | components-background 権限 |

## メッセージの検証（shared）

| ID | テストケース（説明） | 根拠 |
|---|---|---|
| T-MSG-01 | サイドパネル → バックグラウンドの各メッセージ（GET_STATE・START・GOTO・PAUSE・RESUME・STOP・RESTART・RESUME_NEW・BIND_TAB・OPEN_IN・FOCUS_ROLE・RECHECK・SCROLL_TO_TARGET・SET_OVERLAY・SET_UI・CATALOG_CHANGED・REMOVE・RELOAD・GET_DIAGNOSTICS・EXPORT_LOGS・CLEAR_LOGS・LOG）は、定められた形のとき受理される | data-flow メッセージ |
| T-MSG-02 | 各メッセージで、必須の項目が欠けているとき、捨てられる | data-flow、errors |
| T-MSG-03 | 各メッセージで、項目の型が違うとき（`gen` が文字列、`hidden` が数値など）、捨てられる | data-flow |
| T-MSG-04 | `type` が未知のメッセージが届いたとき、捨てられる | data-flow |
| T-MSG-05 | オブジェクトでない値（`null`・文字列・配列）が届いたとき、捨てられる | data-flow |
| T-MSG-06 | `RESUME_NEW` の `mode` が `continue`・`restart` 以外のとき、捨てられる | data-flow、components-background |
| T-MSG-07 | `OPEN_IN` の `mode` が定められた値以外のとき、捨てられる | data-flow、components-background |
| T-MSG-08 | `SET_UI` の `mode` が展開・最小化・ホバー以外のとき、捨てられる | data-flow、FR-49 |
| T-MSG-09 | `SET_UI` の `enabled`・`mode`・`width` が省略可能で、一部だけでも受理される | data-flow |
| T-MSG-10 | ページ側 → バックグラウンドのメッセージ（HELLO・LOCATE_RESULT・HINT_STATE・GOTO・SCROLL_TO_TARGET・SET_OVERLAY・SET_UI・LOG）が、定められた形のとき受理される | data-flow メッセージ |
| T-MSG-11 | `LOCATE_RESULT` の `pageSeq` や `result` が欠けているとき、捨てられる | data-flow |
| T-MSG-12 | バックグラウンド → ページ側のメッセージ（PING・SYNC・RENDER・RECHECK・SCROLL_TO_TARGET・CLEAR）が、`rev` を含む定められた形のとき、ページ側で受理される | data-flow メッセージ、architecture |
| T-MSG-13 | `rev` が欠けた RENDER・CLEAR は、ページ側で捨てられる | architecture、data-flow |
| T-MSG-14 | RENDER の `step` が、形に合わないとき捨てられ、表示が変わらない | data-flow、components-content |
| T-MSG-15 | `LOG` の `entries[]` に、スキーマにない項目があるとき、内容が捨てられる | errors（スキーマにないログ） |
| T-MSG-16 | サイドパネルのメッセージ（START・GOTO・STOP など）は、`sender.url` が拡張機能のサイドパネルのページのとき、受け付けられる | data-flow、architecture |
| T-MSG-17 | サイドパネルのメッセージの形をしたものが、`sender.url` が通常のウェブページのとき、捨てられる | data-flow |
| T-MSG-18 | `sender.url` がないメッセージ（拡張機能内の別の送信元）で、サイドパネルのメッセージの形をしたとき、捨てられる | data-flow（sender.url を確かめる） |
| T-MSG-19 | ページ側（コンテンツスクリプト）から START・STOP・REMOVE・RELOAD・CATALOG_CHANGED など、サイドパネル専用のメッセージが届いたとき、捨てられる | data-flow、NFR-16 |
| T-MSG-20 | ページ側から届くメッセージで、本文に偽の `sender` に相当する自己申告の項目があっても、送信元の判定に使われない | architecture 識別子（sender） |
| T-MSG-21 | 検証で捨てられたメッセージは、内容（入力値・URL など）を記録せず、出来事の名前と理由コードだけを debug に記録する | errors、NFR-15 |
| T-MSG-22 | 検証で捨てられても、例外が外へ出ず、他のメッセージの処理を妨げない | errors |

## 仕様の疑問

- 状態管理: `saveError` を下ろす条件が「次に保存に成功したら」とあるが、storage.session だけ成功して storage.local が失敗している場合や、その逆の場合に下ろしてよいかが書かれていない。両方成功したときだけ下ろす想定で T-SES-58 を書いた。
- 状態管理: `opId` が重複した操作への応答（成功として返すか、無視として返すか）が書かれていない。応答の中身は T-SES-19 で確かめていない。また、識別子の不一致で捨てられた操作の `opId` を `recentOpIds` に入れるかどうかも書かれていない（T-SES-25 は入れない想定）。
- 状態管理: `goto(to)` の `to` が範囲外（負の値、最終ステップの次より後）のときの扱いが書かれていない。T-SES-90 は「最初のステップで『戻る』は無効」（FR-54）から導いた。
- 状態管理: 実行中のツアーがあるときの `start`（別のツアー、同じツアー）の扱いが書かれていない。このため、該当するケースは書いていない。
- 状態管理: `RESUME_NEW` を受け付ける一時中断の理由（上書きのときだけか）が明記されていない。T-SES-71 は FR-35・FR-99 から「上書きのときだけ」と解釈した。
- ステップ実行器: 8秒後の低頻度の探索の「変化があったときだけ」は、変化がなければ2秒ごとの探索そのものを行わないのか、2秒の間隔の上限を保つだけなのかが読み取れない。T-RUN-27・28 は「変化があるときだけ実行する」と解釈した。
- ステップ実行器: `selected` が偽になったとき、すでに出ているハイライト・吹き出しを消すのか残すのかが書かれていない。T-RUN-14 は探索・監視・追従のタイマーが止まることだけを確かめ、表示の扱いはケースにしていない。
- ステップ実行器: 8秒の起点が「ステップに入ったとき」なのか「`selected` が真に戻ったとき」なのかが明記されていない。RECHECK では8秒がやり直されると解釈した（FR-80「再確認：初回の探索をやり直す」）。
- ハイライト・吹き出し: 下・上・左のどれにも収まらないときの配置が書かれていない。そのため、該当するケースは書いていない。
- ミニガイド: ホバーの状態でバーをクリックしたときの扱い、および `SET_UI` を送るタイミング（ホバーの一時的な展開では送らない想定）が明記されていない。T-MG-12 は最小化のバーのクリックだけを対象にした。
- ツアー管理: `getPinned(id, hash)` が、固定した `hash` の内容がすでにストアにない場合（上書きで旧版のファイルを消した後）に何を返すかが書かれていない。T-CAT-08 は固定した内容が返る想定だが、旧版は上書き時に消える（data-flow ③）ため矛盾する可能性がある。
- 権限: `onRemoved` で一時中断を依頼する条件（実行中のツアーの `origins` のいずれかが失われたときだけか）が書かれていない。T-PERM-14・15 は FR-28 から導いた。
- タブ管理: `unsupported` の判定の契機（組み込みの失敗をどう検出するか）が書かれていない。T-TAB-47 は `origins` に含まれるが権限がない場合を `unsupported` と解釈した。
