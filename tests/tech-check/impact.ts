/** 結果の文書に差し込む、観測を踏まえた考察（実行結果を見て書く）。 */
export const IMPACT: { perItem: Record<number, string>; impact: string; unverified: string } = {
  perItem: {
    2: `読み取り: 展開済みバイト数は \`ondata\` で受け取った分を足して数えた。\`UnzipFile.originalSize\`（宣言サイズ）は偽れる（観測値では 1024 と出た）ので、判定に使えない。同期の \`UnzipInflate\` では 1 回の \`push\` の展開結果が 1 回の \`ondata\` にまとまって渡る（最大 ondata が圧縮側チャンクの約 1000 倍）。このため、打ち切りの精度は圧縮側のチャンクの大きさで決まる。圧縮側を 4 KB ずつ push すると超過は約 2 MB、64 KB ずつだと 1 回で約 64 MB、全体を 1 回で push すると 100 MB 全部を展開してから数える（打ち切れない）。`,
    3: `Chrome 114 での推定（実測ではない。MDN と Chrome の資料の記憶による）: \`MessageSender.documentId\` と \`documentLifecycle\` は Chrome 106 で追加されたとされ、114 でも取れる見込み。実機は Chromium 153 で、別の文書への遷移・再読み込みで値が変わり、pushState では変わらないことは実測した。114 の実機での確認は未了。なお、この環境からは資料の URL に接続できず、推定の根拠は再確認できていない。`,
    4: `Chrome 114 での推定（実測ではない）: \`checkVisibility\` は Chrome 105 から使え、114 では旧名（\`checkOpacity\`・\`checkVisibilityCSS\`）だけが辞書のメンバーとして認識され、新名（\`opacityProperty\`・\`visibilityProperty\`）は未知のメンバーとして無視される見込み。WebIDL の辞書は未知のメンバーを無視する仕様で、実機でも未知のキーの getter は読まれなかったので、両方の名前を渡しても例外にならない。153 の実機では、旧名・新名の両方が認識され、結果は同じ。`,
  },
  impact: `- **項目 2（設計書に書かれていない制約）**: 「実際に展開したバイト数で数える」は成立するが、同期の \`UnzipInflate\` は 1 回の push の展開結果をまとめて返すため、上限の超過量は圧縮側のチャンクサイズに比例する。設計書の「上限で打ち切る」に、「圧縮側を小さなチャンク（観測では 4 KB 程度なら超過は約 2 MB）に区切って push し、チャンクごとに合計を確かめる」という条件が要る。区切らずに全体を 1 回で push すると打ち切れない。また、宣言サイズ（\`originalSize\`）は偽れるので判定に使わない、と書き足す余地がある。
- **項目 1・2 の実行場所**: サイドパネルを直接開く手段がなかったため、拡張機能のページをタブで開いて確かめた。同じ拡張機能のオリジンなので IndexedDB の共有の結論は変わらない見込みだが、サイドパネルのビューそのものでは未確認。
- **項目 3（設計書の「sender」の表）**: documentId は文書ごとに変わり、同じ文書内の URL 変更では変わらない。一方 \`sender.url\` は、pushState の後も遷移前の URL（観測では \`/b.html\`、文書の \`location.href\` は \`/pushed\`）のままだった。SPA の URL 変更は \`sender.url\` ではなく webNavigation の \`onHistoryStateUpdated\` と \`pageSeq\` で見る、という設計書の方針に合っているが、「sender.url を現在の URL として使わない」点を設計書に書いておくと安全。
- **項目 4（設計書の「表示されているか」）**: 新旧の名前を両方渡す指定は問題ない。観測した結果は次のとおり: \`opacity:0\` の祖先（子が \`opacity:1\` でも）は偽、\`opacity:0.01\` は真、\`visibility:hidden\` の祖先は偽（子が \`visibility:visible\` なら真）、\`display:none\` は祖先・自身とも偽、\`display:contents\` の祖先の子は真（\`getClientRects\` も空でない）、\`display:contents\` を持つ要素自身は偽（\`getClientRects\` も空）、\`content-visibility:hidden\` の祖先は指定なしでも偽。設計書の手順（\`getClientRects\` が空でない、かつ \`checkVisibility\` が真）と矛盾しない。\`getClientRects\` が空でなくても偽になるケース（opacity・visibility・content-visibility）があり、\`checkVisibility\` の併用が有効。
- **項目 5**: 設計書は「ショートカットでサイドパネルが開くこと」を求める。Xvfb 上の Chromium 153（headed）で X11 の実キー入力により開いた。headless の \`page.keyboard.press\` では開かず、自動検査（Playwright の E2E）にはできない。設計書の検査の位置づけ（手動確認）に反映する。
- **項目 6**: 食い違いなし。ページのスクリプトは閉じた root もボタンも触れず（\`attachShadow\` の差し替えでも横取りできない。コンテンツスクリプトは別の世界で動くため）、host への偽のイベントは \`isTrusted\` が偽で、ボタンのハンドラには届かない。実クリックは真。`,
  unverified: `- Chrome 114 の実機での、項目 3（documentId）・4（新名の無視）・5（ショートカット）。項目 3・4 の 114 での可否は資料の記憶による推定で、この環境からは資料に接続できず再確認していない
- 実際のサイドパネルのビューでの項目 1・2（タブで代用した）
- 項目 5 は Xvfb 上（ウィンドウマネージャなし）の XTEST による入力。実際のデスクトップ（OS のショートカットとの競合、キー割り当ての状態）では未確認。手動確認の手順は項目 5 の節に書いた
- 項目 2 は同期の \`UnzipInflate\` のみ。\`AsyncUnzipInflate\`（Worker）、複数ファイルの zip、圧縮率が低い zip での所要時間は未確認
- 項目 6 は同じオリジンの通常のページのみ。iframe・別の world からの攻撃、ページが拡張機能より先に動く場合の他の手段は未確認`,
};
