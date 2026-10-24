---
title: ccnavi の開発ルール（他プロジェクトから持ち込んだもの）
type: guide
description: docs/claude/ccnavi/ の文書の位置づけと、guided-tour に当てはまるかの区別
tags: [ccnavi]
keywords: [ccnavi, 他プロジェクト, 持ち込み, 適用範囲]
---

# ccnavi の開発ルール

このディレクトリの文書は、別プロジェクト ccnavi の開発ルールをそのまま持ち込んだもの。
guided-tour（Chrome 拡張、pnpm、React）には**そのままでは当てはまらない**。ccnavi の実行ファイル、sh、Python、`.ccnavi/`、`tests/`、`projects/test-repo` を前提に書かれているため。

## 扱い

- guided-tour の決まりとして読まない。ここに書かれたパス・コマンド・ツールは、このリポジトリに無い
- 当てはまる決まりが見つかったら、guided-tour 向けに書き直して `docs/claude/` の直下へ移し、`CLAUDE.md` の表に1行足す
- 移した後、この表の「状態」を更新する。すべて移すか不要と分かったら、ファイルを消す

## 文書ごとの状態

| 文書 | 内容 | guided-tour での扱い |
|---|---|---|
| [acceptance-scenarios.md](acceptance-scenarios.md) | `claude -p` で受入シナリオを回す | 対象外（ccnavi のエージェント検証用） |
| [exe-boundary.md](exe-boundary.md) | ccnavi 実行ファイルとshの責務の境界 | 対象外 |
| [logging.md](logging.md) | sh・Python・TypeScript の診断ログ | 対象外。ログの方針は `docs/design.md` のロガーの項に書く |
| [script-output.md](script-output.md) | スクリプト出力の「次:」行 | 対象外 |
| [testing.md](testing.md) | ccnavi の Python テストの回し方 | 対象外。テストは `docs/design.md` のテスト方針に書く |
| [environment.md](environment.md) | ccnavi の実行環境と落とし穴 | 大文字小文字の扱いなど、一部は書き直して移せる可能性がある |
| [frontmatter.md](frontmatter.md) | ccnavi の frontmatter の type と tags | 対象外。guided-tour の type は `docs-writing.md` の frontmatter の節 |

ADR の扱いなど、プロジェクトによらない決まりは `docs-writing.md` に移してある。
