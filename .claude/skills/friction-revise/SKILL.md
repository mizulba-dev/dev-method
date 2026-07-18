---
name: friction-revise
description: friction ログを精査して dev-method スキルへの改訂を1バッチで落とし込む。未対応5件または同型2回のトリガー到達時、またはユーザーが明示的に求めたときに使う（このリポジトリ専用）
---

# friction-revise: 摩擦ログの精査と dev-method 改訂バッチ

## 入力

- `~/dev-notes/dev-method/friction.md` の**未対応エントリ**（`（改訂済み …）` `（見送り …）` マークが無い行）
- 補助: `node scripts/method-stats.mjs` の出力（実測フッターの集計・R1内訳欠落やパース不能の警告・smoke実施率とFAIL件数・未整備率・対象外率・friction.mdの品質漏れエントリ件数）。バッチのたびにR1指摘件数とR数の時系列推移を見て、direction改訂（検証設計・横断関心）の効果が出ているかを確認する。**品質漏れ0件を実績と解釈する前に、smoke実施率・未整備率・対象外率を併記して判断する**（未整備が多い状態での0件は「検知していないだけ」＝手法の穴の可能性がある。対象外は正当にsmoke不要のケースで手法の穴ではないが、UI変更が続く期間に対象外が並ぶ場合は判定の甘さを疑う）

## 手順

1. 未対応エントリを同型でグルーピングする
2. 各グループを該当スキルの該当セクションへ対応付ける（direction / team-impl / cross-review / その他）。スキルの問題でないもの（手順既記載の実行漏れ・単発の環境事故）は見送り候補にする
3. 改訂案を1バッチで提示し、ユーザーと合意してから適用する
4. 適用時のルール: team-impl は `src/plugin-claude` と `src/plugin-codex` の**両方を必ず揃える**。スキル本文にこのリポジトリ固有の事情を書かない（CLAUDE.md 参照）。実測フッターの文法を変える場合は `scripts/method-stats.mjs`・direction・team-impl 両版を同一バッチで揃える
5. 複数スキルに並行条項（同文であるべき記載）を新設・変更する場合は、同バッチで全コピーを揃え、`scripts/check-shared-clauses.mjs` の対応表へ登録する。改訂バッチ3回ごとに、追加のみで肥大した節の統合・削除候補を棚卸しする
6. friction.md の対応エントリ末尾に `（改訂済み YYYY-MM-DD）`、見送りは `（見送り YYYY-MM-DD 理由）` を付け、dev-notes をコミットする
7. このリポジトリの変更を日本語メッセージでコミットし、手元 CLI へ配布するなら `plugin-release` スキルを提案する
8. 確定した設計判断は `paput_add_project_document`（design_doc。却下・見送り判断も含める）へ保存する
