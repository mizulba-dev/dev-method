# dev-method

個人開発手法プラグイン。PaPut ワークスペースで確立した direction 計画駆動の開発手法を、参画プロジェクトを含む全プロジェクトで、共有リポジトリを汚さずに使えるようにする。Claude Code / Codex 両対応（plugin 本体1つ + dual manifest 方式。paput-mcp の配布構造を踏襲）。

## 収録内容

| 種別 | 名前 | 対応クライアント |
| --- | --- | --- |
| skill | `direction` | 両対応。計画は `~/dev-notes/<プロジェクト名>/direction/` に置く（CLAUDE.local.md の `direction 置き場:` で上書き可） |
| skill | `cross-review` | 両対応。実行中のクライアントと別のモデル CLI（codex exec / claude -p）にレビューさせる |
| skill | `team-impl` | Claude Code 専用（implementer teammate 前提。Codex では縮退運用を案内） |
| agent | `implementer` | Claude Code 専用 |

plugin 経由のスキル呼び出しは namespace 付き: `/dev-method:direction` など。

## プロジェクト側の宣言（任意）

ゼロ設定で動く。例外プロジェクトのみルート CLAUDE.md / CLAUDE.local.md（untracked）に宣言する:

```
direction 置き場: <パス>          # 例: paput は repo 内 docs/direction を維持
並列境界: <単位の説明>            # 例: モノレポで crm-api / crm-web をディレクトリ単位＋worktree 分離
```

## インストール

```bash
# Claude Code
claude plugin marketplace add mizulba-dev/dev-method
claude plugin install dev-method@dev-method

# Codex
codex plugin marketplace add <repo URL またはパス>
codex plugin add dev-method@dev-method
```

## リリース手順

1. 変更をコミット（日本語メッセージ）
2. `npm version patch` — version スクリプトが両 plugin.json を自動同期して同一コミット + tag を作る
3. `git push origin main --follow-tags`（`git ls-remote --tags origin` で tag 到達を確認）
4. Claude Code: `claude plugin marketplace update dev-method` → `claude plugin update dev-method@dev-method`（適用は再起動後）
5. Codex: `codex plugin marketplace upgrade dev-method` → `codex plugin add dev-method@dev-method`（適用は完全再起動後）

## 未検証ポイント

- Codex 上からの `claude -p --allowedTools ...` によるレビュー実行（cross-review の Codex 側分岐）

## 検証済み

- Codex の plugin ローダーは `agents/` ディレクトリを無視する（2026-07 実測。公式 plugin はすべて skills/ + assets/ のみで、agents 概念なし。キャッシュに展開されるだけで無害なため、Claude 専用の implementer.md は分離せず同居させる）
