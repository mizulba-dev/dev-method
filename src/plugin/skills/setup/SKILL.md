---
name: setup
description: dev-method の実装レーン常駐トリガーを Claude Code / Codex のグローバル設定へ安全に追加・更新・削除する
argument-hint: [check|apply|remove] [claude|codex|all]
---

# setup: 実装レーンの常駐トリガー

`direction` スキルを呼ばない実装依頼でも、着手前のレーン判定を常に効かせるためのセットアップを行う。対象ファイル全体を編集してはならない。このスキルと同じディレクトリの `scripts/setup-lanes.mjs` だけを使い、版付き管理ブロックだけを操作する。

## 対象

- Claude Code: `CLAUDE_CONFIG_DIR/CLAUDE.md`。`CLAUDE_CONFIG_DIR` が無ければ `~/.claude/CLAUDE.md`
- Codex: `CODEX_HOME/AGENTS.md`。`CODEX_HOME` が無ければ `~/.codex/AGENTS.md`
- 実行中のクライアントを既定 target とする。両方へ反映するのは、ユーザーが `all` を明示した場合だけ

## 手順

1. この `SKILL.md` の絶対パスから同階層の `scripts/setup-lanes.mjs` を解決する。marketplace cache やネットワークから別のコピーを探索しない
2. `node <setup-lanes.mjs> check --target <claude|codex|all>` を実行し、状態・解決済み path・検出版を示す。`current` なら変更せず終了する
3. 追加・更新・既知手動節の移行が必要なら、`node <setup-lanes.mjs> dry-run --target <...>` を実行する。`unsafe` が1件でもあれば停止し、診断と解消方法を示す
4. dry-run の target path と操作（追加・更新・移行）を要約し、ユーザーへ明示承認を求める。承認前に `apply` を実行しない
5. 承認後だけ `node <setup-lanes.mjs> apply --target <...>` を実行し、結果を報告する

削除を求められた場合も、先に `dry-run` ではなく `check` で対象を確認し、削除する target path と「管理ブロックだけを除去する」ことへの明示承認を得てから `node <setup-lanes.mjs> remove --target <...>` を実行する。管理マーカーの無い手動節は削除しない。

## 状態と停止条件

- `current`: 現行版・現行本文。書き込み不要
- `missing`: 管理ブロックも手動節も無い。追加可能
- `stale`: 管理ブロックの版または本文が現行と異なる。更新可能
- `unmanaged-match`: 公開済み既知テンプレートと完全一致する手動節。管理ブロックへ移行可能
- `unsafe`: マーカー破損・複数ブロック・未知または編集済み手動節・非 regular file・dangling symlink・1 MiB の上限超過・所有者不一致など。変更せず停止

`check` と `dry-run` は書き込みを行わない。`apply --target all` は両 target を先に検査し、1件でも `unsafe` または検査後の競合変更があれば双方を変更しない。`--force` は存在しない。plugin 更新後はこの setup を再実行して版差を反映する。
