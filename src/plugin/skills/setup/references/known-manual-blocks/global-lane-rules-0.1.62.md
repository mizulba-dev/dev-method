## 実装レーン

実装・修正の依頼を受けたら、着手前にレーンを1行宣言してから作業する（判定の正本は dev-method の `direction` スキル）。**レーンは爆発半径だけで決め、direction の有無とは独立**（direction は設計合意の道具であり、書いても実装工程は重くならない）。**Show は原義（マージ後の事後レビュー）でなく「出荷前の1回レビュー」を指す**:

- **Ship**（挙動に触れない変更: typo・docs・コメント・ログ文言・依存 patch 更新・自明な設定値変更）: 直接実装し、機械ゲート（lint・build・該当テスト）のみ。レビューなし
- **Show（デフォルト）**（下位2レーンの基準に触れないすべて。direction の有無は無関係）: 実装 → 機械ゲート → プレレビュー**1回**（**must-fix のみ即対応**、should-fix / nit は蓄積して follow-up 1バッチ）→ 出荷。Claude Code は `dev-method-claude:reviewer` agent、Codex は `spawn_agent` の `agent_type="reviewer"`・`fork_turns="none"` で起動する。`cross-review` は使わない。UI に見える変更では `scenario-kit smoke` を機械ゲートに加え、実測を `smoke <PASS|FAIL n件|評価不能|対象外>` とする（UI非変更は `対象外`）
- **Sign**（高リスク基準: DB migration・並行処理・認可・セキュリティ・境界間契約に触れる変更、および実行可能な検知器の新設・変更）: 実装 → 機械ゲート（検知器タスクは実データ・実ログ×不変式のハーネスを含む）→ pre + cross を各1回 → 統合裁定 → must-fix を1バッチ修正 → 機械ゲート green で出荷。修正後の再レビューはしない。故意ずれ検体の実行検証は維持し、Evidence Package・ledger・収束ループは使わない
- **Seal**（不可逆＝復旧不能なデータ変更・削除・公開後取り消し不能 × 外部影響＝公開 API・課金・第三者データ が重なる変更のみ）: `direction` を起草しフルパイプ（合意前計画レビュー・二者承認までの収束・Evidence Package・ledger）
- 迷ったら重い側のレーンに倒す。ユーザーがレーンを明示指定したら判定を省略する

