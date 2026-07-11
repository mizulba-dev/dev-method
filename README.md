# dev-method

個人開発手法プラグイン。PaPut ワークスペースで確立した direction 計画駆動の開発手法を、参画プロジェクトを含む全プロジェクトで、共有リポジトリを汚さずに使えるようにする。1リポジトリから3プラグインを配布し、クライアント別に最適化した実装フローを提供する。

## プラグイン構成

| プラグイン | 中身 | インストール先 |
| --- | --- | --- |
| `dev-method` | 共通スキル: `direction` / `cross-review` / `method-check` / `playwright-cli` / `sns` / `scenario-kit` | Claude Code / Codex 両方 |
| `dev-method-claude` | `team-impl`（通常 Sonnet/medium・高リスク Opus/high）+ implementer agents | Claude Code のみ |
| `dev-method-codex` | `team-impl`（通常 GPT-5.6 Terra/medium・高リスク Sol/high）+ implementer 定義 | Codex のみ |

- `direction` — 実装計画のライフサイクル管理。計画は `~/dev-notes/<プロジェクト名>/direction/` に置く（git toplevel 名から自動導出。CLAUDE.local.md の `direction 置き場:` で上書き可）
- `cross-review` — 実行中のクライアントと別のモデル CLI（codex exec / claude -p）に diff をレビューさせる。起動前に同モデルの低コストプレレビューで明白な指摘を潰し、R1 を軽くしてから回す
- `team-impl` — 計画ファイル駆動のチーム実装。Claude 版は teammate + SendMessage、Codex 版はサブエージェント（初回・定義更新時に `~/.codex/agents/implementer*.toml` を自動セットアップ）。通常境界は balanced/medium、高リスク境界は flagship/high に振り分ける
- `method-check` — 開発を回したセッションの時間内訳・運用摩擦の実測チェック。「時間がかかった」と感じたときにその場で呼び、スキル手順の穴に該当するロスだけ `~/dev-notes/dev-method/friction.md` へ記録する（改訂への落とし込みは dev-method リポジトリの `friction-revise` ローカルスキル）
- `playwright-cli` — ブラウザ自動化 CLI の使い方（公式 @playwright/cli 配布スキルの取り込み。upstream 更新時は再コピーで追従）
- `sns` — build in public の素材採取（material）と投稿ドラフト作成（draft）。素材は `~/dev-notes/sns/materials.md` に出来事直後の解像度で1行採取し、作文は1素材=1投稿。公開は人間が行う
- `scenario-kit` — Playwright 録画と Remotion 合成によるプロダクトデモ動画の作成・更新。`npx scenario-kit` でシナリオを録画・レンダリングする

plugin 経由のスキル呼び出しは namespace 付き（例: `/dev-method:direction`）。team-impl は各クライアントに自分用の1つだけが入るため名前衝突しない。

## プロジェクト側の宣言（任意）

ゼロ設定で動く。例外プロジェクトのみルート CLAUDE.md / CLAUDE.local.md（untracked）、または PaPut のプロジェクト指示（`paput_get_project_context` の instructions。ローカルファイルを増やさずに済む）に宣言する:

```
direction 置き場: <パス>          # 例: paput は repo 内 docs/direction を維持
並列境界: <単位の説明>            # 例: モノレポで crm-api / crm-web をディレクトリ単位＋worktree 分離
```

## インストール

```bash
# Claude Code
claude plugin marketplace add mizulba-dev/dev-method
claude plugin install dev-method@mizulba-dev
claude plugin install dev-method-claude@mizulba-dev

# Codex
codex plugin marketplace add git@github.com:mizulba-dev/dev-method.git
codex plugin add dev-method@mizulba-dev
codex plugin add dev-method-codex@mizulba-dev
```

## リリース手順

1. 変更をコミット（日本語メッセージ）
2. `npm version patch` — version スクリプトが全6 plugin.json を自動同期して同一コミット + tag を作る
3. `git push origin main --follow-tags`（`git ls-remote --tags origin` で tag 到達を確認）
4. Claude Code: `claude plugin marketplace update mizulba-dev` → `claude plugin update dev-method@mizulba-dev` と `claude plugin update dev-method-claude@mizulba-dev`（適用は再起動後）
5. Codex: `codex plugin marketplace upgrade mizulba-dev` → `codex plugin add dev-method@mizulba-dev` と `codex plugin add dev-method-codex@mizulba-dev`（add が更新を兼ねる。適用は完全再起動後）

## 未検証ポイント

- Codex 版 team-impl のスレッド差し戻し・並列スポーンの安定性・agents 定義の反映タイミング

## 検証済み

- Codex の plugin ローダーは `agents/` ディレクトリを無視する（2026-07 実測。公式 plugin はすべて skills/ + assets/ のみ）。Codex のエージェント定義は plugin では配布できず `~/.codex/agents/*.toml` 固定のため、Codex 版 team-impl はスキル初回実行時と定義更新時のコピーでセットアップする
- Codex 上からの `claude -p --allowedTools ...` によるレビュー実行（cross-review の Codex 側分岐。2026-07-09 初回運用で実測、オプション形式の調整後に動作）
- Codex 版 team-impl の spawn_agent / wait_agent による単一 implementer 運用（2026-07-09 初回運用で実測）
