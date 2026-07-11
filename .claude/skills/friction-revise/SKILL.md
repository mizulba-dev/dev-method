---
name: friction-revise
description: friction ログを精査して dev-method スキルへの改訂を1バッチで落とし込む。未対応5件または同型2回のトリガー到達時、またはユーザーが明示的に求めたときに使う（このリポジトリ専用）
---

# friction-revise: 摩擦ログの精査と dev-method 改訂バッチ

## 入力

- `~/dev-notes/dev-method/friction.md` の**未対応エントリ**（`（改訂済み …）` `（見送り …）` マークが無い行）
- 補助: `~/dev-notes/*/direction/` の完了 direction の実測フッター（レビューR数・差し戻し数の恒常傾向は friction に上がらないためここで拾う）。バッチのたびに R1 指摘件数と R 数の時系列推移を集計し、direction 改訂（検証設計・横断関心）の効果が出ているかを確認する

## 手順

1. 未対応エントリを同型でグルーピングする
2. 各グループを該当スキルの該当セクションへ対応付ける（direction / team-impl / cross-review / その他）。スキルの問題でないもの（手順既記載の実行漏れ・単発の環境事故）は見送り候補にする
3. 改訂案を1バッチで提示し、ユーザーと合意してから適用する
4. 適用時のルール: team-impl は `src/plugin-claude` と `src/plugin-codex` の**両方を必ず揃える**。スキル本文にこのリポジトリ固有の事情を書かない（CLAUDE.md 参照）
5. friction.md の対応エントリ末尾に `（改訂済み YYYY-MM-DD）`、見送りは `（見送り YYYY-MM-DD 理由）` を付け、dev-notes をコミットする
6. このリポジトリの変更を日本語メッセージでコミットし、手元 CLI へ配布するなら `plugin-release` スキルを提案する
7. 確定した設計判断は `paput_add_project_document`（design_doc。却下・見送り判断も含める）へ保存する
