# dev-method 開発ガイド

個人開発手法プラグインのリポジトリ。このファイルは CLAUDE.md が正本で、AGENTS.md は symlink（Claude Code / Codex 共通の指示）。構成・インストール・リリース手順の全体は README.md を参照。

## 構成の要点

- 1リポジトリ・3プラグイン: `src/plugin`（共通: direction / cross-review / playwright-cli）、`src/plugin-claude`（team-impl + 通常/高リスク implementer agents）、`src/plugin-codex`（team-impl + implementer*.toml + SubagentStop 終了通知 hook）。
- 各プラグインは `.claude-plugin/plugin.json` と `.codex-plugin/plugin.json` の dual manifest。version は `npm version patch` で全6マニフェストに自動同期される（`scripts/sync-plugin-version.mjs`）。
- Codex のエージェント定義（implementer*.toml）はプラグインで配布できないため、Codex 版 team-impl スキルが初回実行時と定義更新時に `~/.codex/agents/` へコピーする方式。

## release プロファイル（plugin-release スキル用）

- バンプ判断: 手法スキル・マニフェストの改訂は原則 patch
- バージョン同期: `npm version patch` で全6マニフェスト（3プラグイン × claude/codex）が自動同期される（`scripts/sync-plugin-version.mjs`）
- remote: SSH（git@github.com:mizulba-dev/dev-method.git）。https は認証に失敗する
- push 前ゲート: なし（機械ゲートはコミット前に済ませる）
- 配布チャネル: plugin-marketplace（marketplace: `mizulba-dev`）
  - Claude Code: `dev-method@mizulba-dev`・`dev-method-claude@mizulba-dev`
  - Codex: `dev-method@mizulba-dev`・`dev-method-codex@mizulba-dev`
  - dev-method-claude は Codex に、dev-method-codex は Claude Code にインストールしない
- 後続フック: なし

## ルール

- 応答・コミットメッセージともに常に日本語。
- スキル変更を手元の CLI に反映するときは `plugin-release` スキルを使う（リリース〜両 CLI 更新まで一気通貫）。
- スキル本文は配布物。このリポジトリ固有の事情（パス・リモート等）はスキルに書かず、CLAUDE.md / README に書く。
- Claude 版と Codex 版の team-impl は運用ルールを揃える。片方だけ直すと手法が分岐するので、変更時は両方を確認する。
- `scenario-kit` スキル本文の正本は scenario-kit リポジトリ `src/templates/SKILL.md`。更新時は全文コピー→末尾の dev-method 固有節（使い分けと転用）を再適用する。

## 実装レーン

- Ship は挙動に触れない変更を直接実装し、機械ゲートのみを通す。Show は数ファイル・±100行未満で高リスク基準と検知器変更に触れない変更をプレレビュー付きで実装する。それ以外、または迷う場合は Ask として direction 合意後に実装する。
- Show のUI変更は、リポジトリroot・worktree root・モノレポ配下のscenario-kit設定とscenarioを探索し、既存の有無にかかわらず最小scenarioを準備して smoke を実走する。scenario差分も規模見積もりに含め、基準超過時はAskへ昇格する。Showのsmokeは `PASS`・`FAIL n件`・`評価不能` のいずれか（UI非変更は `対象外`）で、`未整備` は使わない。
