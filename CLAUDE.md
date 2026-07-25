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
- `DEV_FLOW.md` は手法全体の俯瞰ドキュメント（正本はスキル本文）。レーン・工程・モデル割当を変えるスキル改訂では、同じコミットで DEV_FLOW.md も追従させる。

## 実装レーン

- レーンは**爆発半径だけ**で決め、direction の有無とは独立（direction は設計合意の道具）。Ship は挙動に触れない変更を機械ゲートのみで通す。**Show（デフォルト）**は下位2レーンの基準に触れない変更を、機械ゲート → プレレビュー**1回**（**must-fix のみ即対応**、should-fix / nit は follow-up 1バッチ）で実装する。**Sign** は高リスク基準（DB migration・並行処理・認可・セキュリティ・境界間契約）または検知器の新設・変更を、pre + cross 各1回・統合裁定・must-fix 1バッチ修正・再レビューなし（Evidence Package・ledger・収束ループなし）で通す。**Seal** は不可逆×外部影響が重なる変更だけを direction フルパイプ（合意前計画レビュー・二者収束・Evidence・ledger）で回す。**Show は原義と異なり出荷前の1回レビューを指す**。機械ゲートは1回 green で完結とし、green 後の同一検証の再実行やレーン工程外の追加検証を足さない。
- Show のUI変更は、リポジトリroot・worktree root・モノレポ配下のscenario-kit設定とscenarioを探索し、既存の有無にかかわらず最小scenarioを準備して smoke を実走する。scenario差分も規模見積もりに含め、基準超過時は上位レーンへ昇格する。Showのsmokeは `PASS`・`FAIL n件`・`評価不能` のいずれか（UI非変更は `対象外`）で、`未整備` は使わない。
