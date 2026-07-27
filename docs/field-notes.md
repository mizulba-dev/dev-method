# 実測ノート

手法の設計判断の裏付けとして、実機で確認した挙動と、まだ確認できていない箇所を記録する。個人環境での実測であり、一般的な保証ではない。日付は確認時点。

## 未検証

- Codex 版 execution の interrupt_agent 運用、並列スポーンの安定性、agents 定義の反映タイミング
- Codex 版 reviewer プロファイルの read-only 強制（spawn_agent に sandbox 相当の指定がなく、プロンプト指示のみに依存。2026-07-16 追加）
- `dev-method-` 接頭辞付きの現行 role 名での Codex spawn（2026-07-28 の改名以降。routing 機構自体は同じだが、新 role 名の可視化には `~/.codex/agents/` の同期と Codex の完全再起動が要る）

## プラグイン配布・エージェント定義

- Codex の plugin ローダーは `agents/` ディレクトリを無視する（2026-07 実測。公式 plugin はすべて skills/ + assets/ のみ）。Codex のエージェント定義は plugin では配布できず `~/.codex/agents/*.toml` 固定のため、Codex 版 execution はスキル初回実行時と定義更新時のコピーでセットアップする
- `agent_type` 前提化（2026-07-23）: ユーザー環境の Codex で `spawn_agent` schema に `agent_type` が常在することを確認し、未対応 runtime 向けの役割本文同梱縮退（モデル配分不成立の記録つき）をスキル・README から撤去した。`agent_type` field 自体が無い場合は縮退せず停止する fail-closed へ変更
- Codex CLI `0.145.0-alpha.24` の custom role routing（2026-07-20 実測）: `agent_type` + `fork_turns="none"` で implementer = GPT-5.6 Terra/medium、implementer-high = GPT-5.6 Sol/high、reviewer = GPT-5.6 Sol/high を選択し、implementer の follow-up でも同じ role / model / effort を維持。この実測は接頭辞なしの旧 role 名で行ったもの。CLI alpha の確認であり、Codex Desktop / IDE の現セッションへの反映は別途判定する
- Codex 版 execution の spawn_agent / wait_agent による単一 implementer 運用（2026-07-09 実測）
- Codex 版 execution の `fork_turns="none"` / send_message / followup_task / list_agents 運用（2026-07-11 実測）

## hook

- Claude 版 SubagentStop 報告ゲート hook の撤去（2026-07-23）: プラグイン経由の発火が実測で不発（報告なし終了の reviewer が素通り・transcript に hook 痕跡ゼロ。settings.json 直書き probe では発火実績あり）のため、hook 本体・fixture ハーネスごと削除した。teammate の報告不達対策は agents 定義の明示配送条項と催促上限の運用を正本に戻す
- Claude Code の `SubagentStop` hook 入力 JSON のフィールド実名（2026-07-19 probe hook で実測）: `transcript_path` は**親セッション側**の transcript で、サブエージェント自身の transcript は別フィールド `agent_transcript_path`。再入フラグの実名は `stop_hook_active`。他に `agent_id` / `agent_type` / `session_id` / `cwd` / `hook_event_name` / `last_assistant_message` / `background_tasks` / `session_crons` を確認

## CLI の出力形式

- Codex 上からの `claude -p --allowedTools ...` によるレビュー実行（cross-review の Codex 側分岐。2026-07-09 初回運用で実測、オプション形式の調整後に動作）
- `claude -p --output-format stream-json` は `--verbose` を伴わないとエラーで即終了する（2026-07-19 実測）。tool_use は `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":...}}]}}` の形、最終結果は末尾の `{"type":"result","result":"<テキスト>",...}` イベントに入る
- `codex exec --json` の command_execution イベント形式（`{"type":"item.completed","item":{"type":"command_execution","command":"/bin/zsh -lc '<コマンド>'",...}}`）を実測し、`check-review-log.mjs` の逸脱判定はこのシェルラッパーを剥がしてから許可パターンと照合する設計にした（2026-07-19）
- Codex セッション JSONL の cwd・正常/中断ターン境界・ツール call/output・MCP 所要時間・累積トークン量の抽出（2026-07-11 実在ログで確認）

## レビュアーの read-only 強制

- canary 実測（2026-07-19）: cross-review と同一の `--allowedTools "Read,Grep,Glob,Bash(git diff:*),Bash(git status:*),Bash(git log:*)"` 下で `go test` 実行を明示要求するプロンプトを `claude -p --output-format stream-json --verbose` で1回流したところ、許可外の Bash 呼び出し（`go test ./...` を含む複数バリエーション・複合コマンド・許可外 MCP ツール）は計7件すべて `result.permission_denials` として個別拒否された。ただし**単発の拒否で run 全体が abort するわけではない**: モデルはターンを継続し、最終的に `terminal_reason: "completed"` で正常終了して「テストは実行できていない」と正直に報告した。したがって cross-review 手順3のプロンプト側検証禁止条項は canary の結果によらず維持する（allowedTools 単体では「モデルが拒否のたびに別の抜け道を試し続ける」ことを防げないため、明文化との併用が必要）
