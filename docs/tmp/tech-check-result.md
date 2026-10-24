---
title: 技術検証の結果
type: report
description: 設計書「実装の最初に行う技術検証」6項目を、Playwright で読み込んだ Chromium 実機で確かめた結果。各項目の成立・不成立と観測値、設計書への影響
tags: [design-doc, tech-check]
keywords: [IndexedDB, fflate, documentId, checkVisibility, _execute_action, Shadow DOM, isTrusted, Playwright]
---

# 技術検証の結果

`tests/tech-check/run.ts` が出力した。検証用の拡張機能は `tests/tech-check/` の下に作り、本番の `src/` は使っていない。

## 環境

- Chromium: Google Chrome for Testing 153.0.8010.12（Playwright 1.63.0、channel `chromium`）
- ユーザーエージェント: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36`
- 実行方法: 項目 1〜4・6 は headless（新 headless）、項目 5 は headless と Xvfb 上の headed
- Chrome 114 そのものは手元にない。114 での可否は「Chrome 114 での推定」に分けて書く
- zip-bomb(100MB zeros): 102456 バイト（圧縮率 1023:1）
- zip-lie(宣言 1024): 102456 バイト

## 結果の一覧

| 項目 | 結果 | 要点 |
|---|---|---|
| 1. IndexedDB の Blob をサイドパネルとバックグラウンドで共有 | 成立 | 両方向で読み書きできた。ただしパネルはタブで代用 |
| 2. fflate の逐次展開（Unzip + UnzipInflate）を上限で打ち切る | 成立 | 合計が上限を超えた時点で以降の push をやめて打ち切れる。宣言サイズは偽れるので使えない。1 回の push の展開量は圧縮側のチャンクサイズに比例して膨らむ（観測値の表を参照） |
| 3. sender.documentId の取得と、遷移での変化 | 成立 | 実機（Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36）で documentId を取得でき、別の文書への遷移・再読み込みで変わり、pushState では変わらない。Chrome 114 での可否は未実測（推定を別に記す） |
| 4. checkVisibility の指定の名前（新旧）と各ケースの結果 | 成立 | 新旧の名前の両方を渡しても受理され、結果は同じ。各ケースの結果は観測値の表を参照 |
| 5. _execute_action のショートカットでサイドパネルが開くか | 成立 | Xvfb 上の headed Chromium に XTEST の実キー入力（Alt+Shift+G）を送ると開いた（陽性・陰性対照あり）。headless の page.keyboard.press では開かない（ブラウザのショートカットに届かない）。Chrome 114・実機のデスクトップでは未確認なので手動確認も行う |
| 6. 閉じた Shadow DOM のボタンに、ページから操作を届けられないこと・isTrusted | 成立 | ページからは閉じた root もボタンも触れず、偽のイベントは host にしか届かず isTrusted が偽。実クリックは isTrusted が真でボタンに届く |

## 項目1: IndexedDB の Blob をサイドパネルとバックグラウンドで共有

結果: **成立**。両方向で読み書きできた。ただしパネルはタブで代用

- サイドパネルを直接開く手段が Playwright にないため、`chrome-extension://<id>/panel.html` をタブで開いて代用した（同じ拡張機能のページ・同じオリジン）。実際のサイドパネルのビューでは確かめていない。

| 確認したこと | 結果 | 観測した値 |
|---|---|---|
| パネルが 5 MB の Blob を IndexedDB に書く | 参考 | `{"key":"k-panel","size":5242880,"type":"application/x-tech-check","head":[0,1,2,3,4,5,6,7],"checksum":655359028,"context":"extension-page"}` |
| Service Worker が同じ Blob を読めて、サイズ・型・内容（先頭と合計）が一致する | 成立 | `{"key":"k-panel","size":5242880,"type":"application/x-tech-check","head":[0,1,2,3,4,5,6,7],"checksum":655359028,"context":"service-worker"}` |
| パネル自身も読める | 成立 | `{"key":"k-panel","size":5242880,"type":"application/x-tech-check","head":[0,1,2,3,4,5,6,7],"checksum":655359028,"context":"extension-page"}` |
| 逆向き: Service Worker が書いた Blob をパネルが読める | 成立 | `{"writtenBySw":{"key":"k-sw","size":1048576,"type":"application/x-tech-check","head":[0,1,2,3,4,5,6,7],"checksum":131064401,"context":"service-worker"},"readByPanel":{"key":"k-sw","size":1048576,"type":"application/x-tech-check","head":[0,1,2,3,4,5,6,7],"checksum":131064401,"context":"extension-page"}}` |
| 制約表の前提: Service Worker に URL.createObjectURL は無く、パネルでは使える | 成立 | `{"swTypeofCreateObjectURL":"undefined","panelUrl":"blob:chrome-extension://heabbdahjgoclfcphhaebblelmelppfg/5931d7b8-3ecc-4eef-b64d-5ec8e4921296"}` |

## 項目2: fflate の逐次展開（Unzip + UnzipInflate）を上限で打ち切る

結果: **成立**。合計が上限を超えた時点で以降の push をやめて打ち切れる。宣言サイズは偽れるので使えない。1 回の push の展開量は圧縮側のチャンクサイズに比例して膨らむ（観測値の表を参照）

- 実行場所は拡張機能のページ（タブで代用。項目 1 と同じ）。UnzipFile.terminate は同期の UnzipInflate では実質何もしないため、「以降の push をやめる」ことで打ち切る。

| 確認したこと | 結果 | 観測した値 |
|---|---|---|
| 対照: 正直な 3 MB の zip は打ち切られず、合計 3 MB を数える | 成立 | `{"limit":52428800,"chunkSize":16384,"aborted":false,"counted":3145728,"maxOndata":1048576,"ondataCalls":3,"pushes":1,"pushedCompressed":13432,"declared":[{"name":"f0.bin","size":4382,"originalSize":1048576},{"name":"f1.bin","size":4382,"originalSize":1048576},{"name":"f2.bin","size":4382,"originalSize":1048576}],"errors":[],"ms":38}` |
| 高圧縮（宣言どおり 100 MB） / 圧縮側を 1024 バイトずつ push、上限 50 MB | 成立 | `{"aborted":true,"数えた展開バイト":53470759,"上限超過分":1041959,"最大ondata":1056768,"push回数":51,"push済み圧縮バイト":52224,"宣言":[{"name":"zeros.bin","size":102340,"originalSize":104857600}],"errors":[],"ms":426}` |
| 高圧縮（宣言どおり 100 MB） / 圧縮側を 4096 バイトずつ push、上限 50 MB | 成立 | `{"aborted":true,"数えた展開バイト":54514885,"上限超過分":2086085,"最大ondata":4201530,"push回数":13,"push済み圧縮バイト":53248,"宣言":[{"name":"zeros.bin","size":102340,"originalSize":104857600}],"errors":[],"ms":393}` |
| 高圧縮（宣言どおり 100 MB） / 圧縮側を 16384 バイトずつ push、上限 50 MB | 成立 | `{"aborted":true,"数えた展開バイト":67106575,"上限超過分":14677775,"最大ondata":16793478,"push回数":4,"push済み圧縮バイト":65536,"宣言":[{"name":"zeros.bin","size":102340,"originalSize":104857600}],"errors":[],"ms":443}` |
| 高圧縮（宣言どおり 100 MB） / 圧縮側を 65536 バイトずつ push、上限 50 MB | 成立 | `{"aborted":true,"数えた展開バイト":67106575,"上限超過分":14677775,"最大ondata":67106575,"push回数":1,"push済み圧縮バイト":65536,"宣言":[{"name":"zeros.bin","size":102340,"originalSize":104857600}],"errors":[],"ms":386}` |
| 高圧縮（宣言どおり 100 MB） / 圧縮側を 1048576 バイトずつ push、上限 50 MB | 成立 | `{"aborted":true,"数えた展開バイト":104857600,"上限超過分":52428800,"最大ondata":104857600,"push回数":1,"push済み圧縮バイト":102456,"宣言":[{"name":"zeros.bin","size":102340,"originalSize":104857600}],"errors":[],"ms":610}` |
| 宣言サイズを 1024 と偽った 100 MB / 圧縮側を 1024 バイトずつ push、上限 50 MB | 成立 | `{"aborted":true,"数えた展開バイト":53470759,"上限超過分":1041959,"最大ondata":1056768,"push回数":51,"push済み圧縮バイト":52224,"宣言":[{"name":"zeros.bin","size":102340,"originalSize":1024}],"errors":[],"ms":293}` |
| 宣言サイズを 1024 と偽った 100 MB / 圧縮側を 4096 バイトずつ push、上限 50 MB | 成立 | `{"aborted":true,"数えた展開バイト":54514885,"上限超過分":2086085,"最大ondata":4201530,"push回数":13,"push済み圧縮バイト":53248,"宣言":[{"name":"zeros.bin","size":102340,"originalSize":1024}],"errors":[],"ms":268}` |
| 宣言サイズを 1024 と偽った 100 MB / 圧縮側を 16384 バイトずつ push、上限 50 MB | 成立 | `{"aborted":true,"数えた展開バイト":67106575,"上限超過分":14677775,"最大ondata":16793478,"push回数":4,"push済み圧縮バイト":65536,"宣言":[{"name":"zeros.bin","size":102340,"originalSize":1024}],"errors":[],"ms":357}` |
| 宣言サイズを 1024 と偽った 100 MB / 圧縮側を 65536 バイトずつ push、上限 50 MB | 成立 | `{"aborted":true,"数えた展開バイト":67106575,"上限超過分":14677775,"最大ondata":67106575,"push回数":1,"push済み圧縮バイト":65536,"宣言":[{"name":"zeros.bin","size":102340,"originalSize":1024}],"errors":[],"ms":361}` |
| 宣言サイズを 1024 と偽った 100 MB / 圧縮側を 1048576 バイトずつ push、上限 50 MB | 成立 | `{"aborted":true,"数えた展開バイト":104857600,"上限超過分":52428800,"最大ondata":104857600,"push回数":1,"push済み圧縮バイト":102456,"宣言":[{"name":"zeros.bin","size":102340,"originalSize":1024}],"errors":[],"ms":601}` |

読み取り: 展開済みバイト数は `ondata` で受け取った分を足して数えた。`UnzipFile.originalSize`（宣言サイズ）は偽れる（観測値では 1024 と出た）ので、判定に使えない。同期の `UnzipInflate` では 1 回の `push` の展開結果が 1 回の `ondata` にまとまって渡る（最大 ondata が圧縮側チャンクの約 1000 倍）。このため、打ち切りの精度は圧縮側のチャンクの大きさで決まる。圧縮側を 4 KB ずつ push すると超過は約 2 MB、64 KB ずつだと 1 回で約 64 MB、全体を 1 回で push すると 100 MB 全部を展開してから数える（打ち切れない）。

## 項目3: sender.documentId の取得と、遷移での変化

結果: **成立**。実機（Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36）で documentId を取得でき、別の文書への遷移・再読み込みで変わり、pushState では変わらない。Chrome 114 での可否は未実測（推定を別に記す）

| 確認したこと | 結果 | 観測した値 |
|---|---|---|
| /a.html にコンテンツスクリプトを executeScript で組み込み、onMessage の sender を読む | 成立 | `{"documentId":"34A964EE8BAE7763195AF1FAE62E065F","frameId":0,"tabId":1682615947,"url":"http://localhost:46847/a.html","documentLifecycle":"active"}` |
| 同じタブで /b.html へ遷移して再度組み込む | 成立 | `{"a":"34A964EE8BAE7763195AF1FAE62E065F","b":"84856DA8C4131A3824B76E69E2F14BA6","同じtabId":true}` |
| 同じ URL の再読み込みでも documentId が変わる | 成立 | `{"before":"84856DA8C4131A3824B76E69E2F14BA6","after":"21832B70C8D0D0EA686C7E02BD058FC0"}` |
| 同じ文書内の URL 変更（pushState）では documentId が変わらない | 成立 | `{"before":"21832B70C8D0D0EA686C7E02BD058FC0","after":"21832B70C8D0D0EA686C7E02BD058FC0"}` |
| 参考: pushState 直後の sender.url と、文書自身が報告した location.href（sender.url が遅れるか） | 参考 | `{"senderUrl":"http://localhost:46847/b.html","href":"http://localhost:46847/pushed"}` |
| 参考: 500ms 待ってもう一度組み込んだときの sender.url と documentId | 参考 | `{"senderUrl":"http://localhost:46847/b.html","documentId":"21832B70C8D0D0EA686C7E02BD058FC0"}` |
| iframe 付きの文書に allFrames で組み込むと、フレームごとに別の documentId になる | 成立 | `[{"documentId":"6A72A4CDDEFFB419FD9112F4F781C012","frameId":0,"tabId":1682615947,"url":"http://localhost:46847/frames.html","documentLifecycle":"active"},{"documentId":"3F1EDA56B0D09BA563238E12234B9719","frameId":8,"tabId":1682615947,"url":"http://localhost:46847/c.html","documentLifecycle":"active"}]` |
| documentLifecycle の値 | 参考 | `["active","active","active","active","active","active","active"]` |

Chrome 114 での推定（実測ではない。MDN と Chrome の資料の記憶による）: `MessageSender.documentId` と `documentLifecycle` は Chrome 106 で追加されたとされ、114 でも取れる見込み。実機は Chromium 153 で、別の文書への遷移・再読み込みで値が変わり、pushState では変わらないことは実測した。114 の実機での確認は未了。なお、この環境からは資料の URL に接続できず、推定の根拠は再確認できていない。

## 項目4: checkVisibility の指定の名前（新旧）と各ケースの結果

結果: **成立**。新旧の名前の両方を渡しても受理され、結果は同じ。各ケースの結果は観測値の表を参照

| 確認したこと | 結果 | 観測した値 |
|---|---|---|
| Element.prototype.checkVisibility がある | 成立 | `function` |
| 辞書として読みに行くメンバー（getter で観測） | 参考 | `["checkOpacity","checkVisibilityCSS","contentVisibilityAuto","opacityProperty","visibilityProperty"]` |
| 旧名・新名の両方が辞書のメンバーとして認識される | 成立 | `{"旧名":true,"新名":true}` |
| 要素 #opacity0-ancestor | 参考 | `{"getClientRects>0":true,"指定なし":true,"旧名のみ":false,"新名のみ":false,"新旧の両方":false,"opacity系のみ（新）":false,"visibility系のみ（新）":true,"opacity系のみ（旧）":false,"visibility系のみ（旧）":true}` |
| 要素 #opacity0-ancestor-child-opacity1 | 参考 | `{"getClientRects>0":true,"指定なし":true,"旧名のみ":false,"新名のみ":false,"新旧の両方":false,"opacity系のみ（新）":false,"visibility系のみ（新）":true,"opacity系のみ（旧）":false,"visibility系のみ（旧）":true}` |
| 要素 #opacity0-self | 参考 | `{"getClientRects>0":true,"指定なし":true,"旧名のみ":false,"新名のみ":false,"新旧の両方":false,"opacity系のみ（新）":false,"visibility系のみ（新）":true,"opacity系のみ（旧）":false,"visibility系のみ（旧）":true}` |
| 要素 #opacity-0.01-ancestor | 参考 | `{"getClientRects>0":true,"指定なし":true,"旧名のみ":true,"新名のみ":true,"新旧の両方":true,"opacity系のみ（新）":true,"visibility系のみ（新）":true,"opacity系のみ（旧）":true,"visibility系のみ（旧）":true}` |
| 要素 #visibility-hidden-ancestor | 参考 | `{"getClientRects>0":true,"指定なし":true,"旧名のみ":false,"新名のみ":false,"新旧の両方":false,"opacity系のみ（新）":true,"visibility系のみ（新）":false,"opacity系のみ（旧）":true,"visibility系のみ（旧）":false}` |
| 要素 #visibility-hidden-ancestor-child-visible | 参考 | `{"getClientRects>0":true,"指定なし":true,"旧名のみ":true,"新名のみ":true,"新旧の両方":true,"opacity系のみ（新）":true,"visibility系のみ（新）":true,"opacity系のみ（旧）":true,"visibility系のみ（旧）":true}` |
| 要素 #visibility-hidden-self | 参考 | `{"getClientRects>0":true,"指定なし":true,"旧名のみ":false,"新名のみ":false,"新旧の両方":false,"opacity系のみ（新）":true,"visibility系のみ（新）":false,"opacity系のみ（旧）":true,"visibility系のみ（旧）":false}` |
| 要素 #display-none-ancestor | 参考 | `{"getClientRects>0":false,"指定なし":false,"旧名のみ":false,"新名のみ":false,"新旧の両方":false,"opacity系のみ（新）":false,"visibility系のみ（新）":false,"opacity系のみ（旧）":false,"visibility系のみ（旧）":false}` |
| 要素 #display-none-self | 参考 | `{"getClientRects>0":false,"指定なし":false,"旧名のみ":false,"新名のみ":false,"新旧の両方":false,"opacity系のみ（新）":false,"visibility系のみ（新）":false,"opacity系のみ（旧）":false,"visibility系のみ（旧）":false}` |
| 要素 #display-contents-ancestor | 参考 | `{"getClientRects>0":true,"指定なし":true,"旧名のみ":true,"新名のみ":true,"新旧の両方":true,"opacity系のみ（新）":true,"visibility系のみ（新）":true,"opacity系のみ（旧）":true,"visibility系のみ（旧）":true}` |
| 要素 #display-contents-self | 参考 | `{"getClientRects>0":false,"指定なし":false,"旧名のみ":false,"新名のみ":false,"新旧の両方":false,"opacity系のみ（新）":false,"visibility系のみ（新）":false,"opacity系のみ（旧）":false,"visibility系のみ（旧）":false}` |
| 要素 #content-visibility-hidden-ancestor | 参考 | `{"getClientRects>0":true,"指定なし":false,"旧名のみ":false,"新名のみ":false,"新旧の両方":false,"opacity系のみ（新）":false,"visibility系のみ（新）":false,"opacity系のみ（旧）":false,"visibility系のみ（旧）":false}` |
| 要素 #plain | 参考 | `{"getClientRects>0":true,"指定なし":true,"旧名のみ":true,"新名のみ":true,"新旧の両方":true,"opacity系のみ（新）":true,"visibility系のみ（新）":true,"opacity系のみ（旧）":true,"visibility系のみ（旧）":true}` |
| 新旧どちらの名前でも、全要素で結果が同じ | 成立 | `true` |

Chrome 114 での推定（実測ではない）: `checkVisibility` は Chrome 105 から使え、114 では旧名（`checkOpacity`・`checkVisibilityCSS`）だけが辞書のメンバーとして認識され、新名（`opacityProperty`・`visibilityProperty`）は未知のメンバーとして無視される見込み。WebIDL の辞書は未知のメンバーを無視する仕様で、実機でも未知のキーの getter は読まれなかったので、両方の名前を渡しても例外にならない。153 の実機では、旧名・新名の両方が認識され、結果は同じ。

## 項目5: _execute_action のショートカットでサイドパネルが開くか

結果: **成立**。Xvfb 上の headed Chromium に XTEST の実キー入力（Alt+Shift+G）を送ると開いた（陽性・陰性対照あり）。headless の page.keyboard.press では開かない（ブラウザのショートカットに届かない）。Chrome 114・実機のデスクトップでは未確認なので手動確認も行う

- 手動確認の手順: (1) `pnpm run build` で dist/ を作り、chrome://extensions で「パッケージ化されていない拡張機能を読み込む」で dist/ を選ぶ。(2) 任意の http(s) ページのタブを前面にして Alt+Shift+G を押す。(3) 右側にサイドパネル（一覧画面）が開けば成立。(4) もう一度押して閉じる／開くの挙動も見る。(5) 開かなければ chrome://extensions/shortcuts で「Activate the extension」にキーが割り当てられているか（競合で空になっていないか）を確かめる。(6) 同じ操作を、ツールバーのアクションをクリックした場合と比べる（openPanelOnActionClick: true で開くはず）。Chrome 114 での確認は 114 を入手できる環境が必要。

| 確認したこと | 結果 | 観測した値 |
|---|---|---|
| headless: 登録されたコマンドと、開始時点のサイドパネルのコンテキスト数 | 参考 | `{"sidePanelContexts":0,"urls":[],"commands":[{"name":"_execute_action","shortcut":"Alt+Shift+G"}]}` |
| headless: page.keyboard.press("Alt+Shift+G") の後のサイドパネルのコンテキスト数 | 参考 | `{"sidePanelContexts":0,"urls":[],"commands":[{"name":"_execute_action","shortcut":"Alt+Shift+G"}]}` |
| headless: action.onClicked / commands.onCommand の発火 | 参考 | `[]` |
| 陽性対照: XTEST で送った "x" が入力欄に届く | 成立 | `{"value":"x"}` |
| headed(Xvfb): キーを送る前のサイドパネルのコンテキスト | 参考 | `{"sidePanelContexts":0,"urls":[],"commands":[{"name":"_execute_action","shortcut":"Alt+Shift+G"}]}` |
| 陰性対照: Shift+G（Alt なし）を送ってもサイドパネルは開かない | 成立 | `{"sidePanelContexts":0,"urls":[],"commands":[{"name":"_execute_action","shortcut":"Alt+Shift+G"}]}` |
| headed(Xvfb): XTEST で Alt+Shift+G を送った後のサイドパネルのコンテキスト数・発火 | 参考 | `{"state":{"sidePanelContexts":1,"urls":["chrome-extension://heabbdahjgoclfcphhaebblelmelppfg/panel.html"],"commands":[{"name":"_execute_action","shortcut":"Alt+Shift+G"}]},"logs":[],"xkeyStatus":0,"xkeyErr":""}` |
| headed(Xvfb): ショートカットでサイドパネルが開いた | 成立 | `{"opened":true}` |

## 項目6: 閉じた Shadow DOM のボタンに、ページから操作を届けられないこと・isTrusted

結果: **成立**。ページからは閉じた root もボタンも触れず、偽のイベントは host にしか届かず isTrusted が偽。実クリックは isTrusted が真でボタンに届く

| 確認したこと | 結果 | 観測した値 |
|---|---|---|
| ページのスクリプトからは、閉じた root もボタンも見えない（shadowRoot・querySelector・elementFromPoint・attachShadow の差し替え） | 成立 | `{"shadowRootProp":"null","pageQuerySelectorButtons":0,"hostQueryButton":"null","elementFromPointIsHost":true,"hitHasShadowRoot":null,"attachShadowHookCaught":0}` |
| ページが host.click() と dispatchEvent（click・pointerdown）を送ると、ボタンのハンドラは呼ばれない | 成立 | `{"ボタンに届いた回数":0}` |
| ホスト要素にだけ届いたイベントの isTrusted は偽 | 成立 | `[{"kind":"shadow-host-click","isTrusted":false,"targetIsHost":true,"type":"shadow-host-click"},{"kind":"shadow-host-click","isTrusted":false,"targetIsHost":true,"type":"shadow-host-click"},{"kind":"shadow-host-pointerdown","isTrusted":false,"targetIsHost":true,"type":"shadow-host-pointerdown"}]` |
| Playwright の実クリック（page.mouse.click）がボタンに届き、isTrusted は真 | 成立 | `[{"isTrusted":true,"targetIsButton":true,"type":"shadow-button-click"}]` |
| 同じクリックがホストにも伝わり、target はホストに付け替わる（isTrusted は真） | 成立 | `[{"isTrusted":true,"targetIsHost":true,"type":"shadow-host-click"}]` |
| 参考: ページの capture リスナーが見た実クリック（composedPath にボタンは含まれるか） | 参考 | `{"isTrusted":true,"targetTag":"DIV","pathHasButton":false}` |

## 設計書への影響

- **項目 2（設計書に書かれていない制約）**: 「実際に展開したバイト数で数える」は成立するが、同期の `UnzipInflate` は 1 回の push の展開結果をまとめて返すため、上限の超過量は圧縮側のチャンクサイズに比例する。設計書の「上限で打ち切る」に、「圧縮側を小さなチャンク（観測では 4 KB 程度なら超過は約 2 MB）に区切って push し、チャンクごとに合計を確かめる」という条件が要る。区切らずに全体を 1 回で push すると打ち切れない。また、宣言サイズ（`originalSize`）は偽れるので判定に使わない、と書き足す余地がある。
- **項目 1・2 の実行場所**: サイドパネルを直接開く手段がなかったため、拡張機能のページをタブで開いて確かめた。同じ拡張機能のオリジンなので IndexedDB の共有の結論は変わらない見込みだが、サイドパネルのビューそのものでは未確認。
- **項目 3（設計書の「sender」の表）**: documentId は文書ごとに変わり、同じ文書内の URL 変更では変わらない。一方 `sender.url` は、pushState の後も遷移前の URL（観測では `/b.html`、文書の `location.href` は `/pushed`）のままだった。SPA の URL 変更は `sender.url` ではなく webNavigation の `onHistoryStateUpdated` と `pageSeq` で見る、という設計書の方針に合っているが、「sender.url を現在の URL として使わない」点を設計書に書いておくと安全。
- **項目 4（設計書の「表示されているか」）**: 新旧の名前を両方渡す指定は問題ない。観測した結果は次のとおり: `opacity:0` の祖先（子が `opacity:1` でも）は偽、`opacity:0.01` は真、`visibility:hidden` の祖先は偽（子が `visibility:visible` なら真）、`display:none` は祖先・自身とも偽、`display:contents` の祖先の子は真（`getClientRects` も空でない）、`display:contents` を持つ要素自身は偽（`getClientRects` も空）、`content-visibility:hidden` の祖先は指定なしでも偽。設計書の手順（`getClientRects` が空でない、かつ `checkVisibility` が真）と矛盾しない。`getClientRects` が空でなくても偽になるケース（opacity・visibility・content-visibility）があり、`checkVisibility` の併用が有効。
- **項目 5**: 設計書は「ショートカットでサイドパネルが開くこと」を求める。Xvfb 上の Chromium 153（headed）で X11 の実キー入力により開いた。headless の `page.keyboard.press` では開かず、自動検査（Playwright の E2E）にはできない。設計書の検査の位置づけ（手動確認）に反映する。
- **項目 6**: 食い違いなし。ページのスクリプトは閉じた root もボタンも触れず（`attachShadow` の差し替えでも横取りできない。コンテンツスクリプトは別の世界で動くため）、host への偽のイベントは `isTrusted` が偽で、ボタンのハンドラには届かない。実クリックは真。

## 未確認のこと

- Chrome 114 の実機での、項目 3（documentId）・4（新名の無視）・5（ショートカット）。項目 3・4 の 114 での可否は資料の記憶による推定で、この環境からは資料に接続できず再確認していない
- 実際のサイドパネルのビューでの項目 1・2（タブで代用した）
- 項目 5 は Xvfb 上（ウィンドウマネージャなし）の XTEST による入力。実際のデスクトップ（OS のショートカットとの競合、キー割り当ての状態）では未確認。手動確認の手順は項目 5 の節に書いた
- 項目 2 は同期の `UnzipInflate` のみ。`AsyncUnzipInflate`（Worker）、複数ファイルの zip、圧縮率が低い zip での所要時間は未確認
- 項目 6 は同じオリジンの通常のページのみ。iframe・別の world からの攻撃、ページが拡張機能より先に動く場合の他の手段は未確認
