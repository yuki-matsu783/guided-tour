# CLAUDE.md

このファイルには、開発で常に守ることだけを書く。詳細は `docs/claude/` に記載。

## 応答ルール

1. 簡潔で明確な日本語を使う
2. 「です・ます」調は使うが、冗長な敬語表現は避ける
3. 「いたします」→「します」、「ございます」→「あります」に置き換える
4. 「恐れ入りますが」などのクッション言葉は省く

## 常に守ること

- chrome拡張で動くように
- pnpm と reactを使う
- CLAUDE.md には、常に守る決まりだけを短く書く。理由・手順・例は「詳細」の表が指す文書に書く。新しい決まりは、まずその文書に書き、表に 1 行足す（段階的詳細化）

## 詳細

| 文書 | 内容 |
|---|---|
| [docs/requirements.md](docs/requirements.md) | 要件書の入口。詳細は `docs/requirements/` |
| [docs/design.md](docs/design.md) | 設計書の入口。詳細は `docs/design/` |
| [docs/adr/README.md](docs/adr/README.md) | ADR（決定と理由）の書き方と一覧 |
| [docs/claude/docs-writing.md](docs/claude/docs-writing.md) | 要件書・設計書・ADR の書き分け、ADR の扱い、frontmatter |
