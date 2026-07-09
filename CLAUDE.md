# dev-method 開発ガイド

個人開発手法プラグインのリポジトリ。このファイルは CLAUDE.md が正本で、AGENTS.md は symlink（Claude Code / Codex 共通の指示）。構成・インストール・リリース手順の全体は README.md を参照。

## 構成の要点

- 1リポジトリ・3プラグイン: `src/plugin`（共通: direction / cross-review / playwright-cli / sns）、`src/plugin-claude`（team-impl + implementer agent）、`src/plugin-codex`（team-impl + implementer.toml）。
- 各プラグインは `.claude-plugin/plugin.json` と `.codex-plugin/plugin.json` の dual manifest。version は `npm version patch` で全6マニフェストに自動同期される（`scripts/sync-plugin-version.mjs`）。
- Codex のエージェント定義（implementer.toml）はプラグインで配布できないため、Codex 版 team-impl スキルが初回実行時に `~/.codex/agents/` へコピーする方式。

## ルール

- 応答・コミットメッセージともに常に日本語。
- スキル変更を手元の CLI に反映するときは `plugin-release` スキルを使う（リリース〜両 CLI 更新まで一気通貫）。
- スキル本文は配布物。このリポジトリ固有の事情（パス・リモート等）はスキルに書かず、CLAUDE.md / README に書く。
- Claude 版と Codex 版の team-impl は運用ルールを揃える。片方だけ直すと手法が分岐するので、変更時は両方を確認する。
