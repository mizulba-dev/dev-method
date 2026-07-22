# dev-method

個人開発手法プラグイン。PaPut ワークスペースで確立した direction 計画駆動の開発手法を、参画プロジェクトを含む全プロジェクトで、共有リポジトリを汚さずに使えるようにする。1リポジトリから3プラグインを配布し、クライアント別に最適化した実装フローを提供する。

## プラグイン構成

| プラグイン | 中身 | インストール先 |
| --- | --- | --- |
| `dev-method` | 共通スキル: `direction` / `cross-review` / `method-check` / `playwright-cli` / `scenario-kit` | Claude Code / Codex 両方 |
| `dev-method-claude` | `team-impl`（通常 Sonnet/medium・高リスク Opus/high）+ implementer/reviewer agents + `SubagentStop` 報告ゲート hook | Claude Code のみ |
| `dev-method-codex` | `team-impl`（通常 GPT-5.6 Terra/medium・高リスク GPT-5.6 Sol/high）+ implementer/reviewer 定義 + `SubagentStop` 終了通知 hook | Codex のみ |

- `direction` — 実装計画のライフサイクル管理と、実装レーン（Ship / Show / Sign / Seal）の判定正本。計画は `~/dev-notes/<プロジェクト名>/direction/` に置く（git toplevel 名から自動導出。CLAUDE.local.md の `direction 置き場:` で上書き可）。**レーンは爆発半径だけで判定・宣言し、direction の有無とは独立**（direction は設計合意の道具）: Ship（挙動非変更）はレビューなしで機械ゲートのみ、Show（デフォルト）はプレレビュー**1回・must のみ**で `cross-review` 省略、Sign（高リスク・検知器の新設/変更）は pre+cross 各1回・統合裁定・must 1バッチ修正・再レビューなし、Seal（**不可逆×外部影響**が重なる変更のみ）は direction フルパイプ。direction を起動しないタスクにも効かせる常駐トリガーは下記セットアップ参照
- `cross-review` — 実行中のクライアントと別のモデル CLI（codex exec / claude -p）に diff をレビューさせる、異ベンダーレビュー専用スキル。追跡済み差分と非 ignore 未追跡を含む SHA-256 指紋を返し、standalone では開始時・返却値・結果受領時の同一性を確認して収束までループする
- `team-impl` — 計画ファイル駆動のチーム実装。Claude 版は teammate + SendMessage、Codex 版はサブエージェント（初回・定義更新時に `~/.codex/agents/implementer*.toml` / `reviewer.toml` を自動セットアップ）。Codex は現在の `spawn_agent` schema が対応していれば `agent_type` と `fork_turns="none"` で custom role を明示選択し、model / effort は role TOML を正本にする。schema に `agent_type` が無い未対応 runtime では、セッション開始前から定義が同期済みの場合に限り役割本文を同梱して縮退し、モデル配分不成立（親モデル継承）を記録する。通常境界は balanced/medium、高リスク境界は flagship/high に振り分ける。Seal では共同ラウンド開始時の同じ diff 指紋へ、同ファミリー最上位モデル（Claude 上は Fable、Codex 上は GPT-5.6 Sol）の専用 reviewer と異ベンダー `cross-review` を並列起動する。両結果を待って根本原因単位に統合し、修正後は両承認を失効させ、同一版への二者承認まで反復する。Sign は pre + cross を各1回だけ起動し、統合裁定して must-fix を1バッチ修正して出荷する（再レビューなし・Evidence/ledger なし）。Show のプレレビュー1回・must のみという契約は変えない。検証実行は implementer の1回を正とし、リーダー・レビュアーは検証証跡（実行コマンド・exit code・pass/fail 件数）で確認して再実行しない（例外は検知器変更時の異ベンダー独立実行検証のみ）。Seal の最終 smoke だけは、共同レビュー収束後の安定版へリーダーが1回実行する

### Evidence Package

Seal の Evidence Package は、direction で明示した既知契約と、その検証実行・ログ・対象差分を結び付ける**証拠索引**である。レビュー担当はこれを起点に確認を効率化できるが、形式証明でも完全性の保証でもない。二者の独立レビューは引き続き diff 全体と関連コードを読み、Package にモデル化されていないリスクや、証拠自体の妥当性も判断する。

したがって、Package にないコードを確認不要とは扱わず、Package が green であってもレビューの読解責務を免除しない。

- Codex の `SubagentStop` hook — サブエージェント終了時に、親AIの生成を使わず Codex UI / イベントストリームへ role と実行 model を含む終了通知を出す（model 欠損入力では role のみ）。実行中は既存の Active 表示で確認する
- Claude Code の `SubagentStop` 報告ゲート hook — サブエージェント自身の transcript（`agent_transcript_path`）で、最新の非meta user実作業指示、または `origin.kind` が `coordinator` のmeta user指示より後だけを判定する。それ以外のmeta reminderとtool_resultは指示境界にしない。`agent_type` が完全一致で `dev-method-claude:reviewer` のときは `レビュー完了報告:`・`diff指紋:`・`指摘:`・`承認可否:`、それ以外は `完了報告:`・`検証証跡:`・`逸脱:`・`未達事項:` を各行頭に持つ `SendMessage` が必要。本文は `input.message`、無ければ文字列の `input.content` だけを読み、`summary` / `to` は判定に使わない。Show reviewer は `diff指紋: 対象外（Show）` とする。再入時（`stop_hook_active`）はブロックせず、入力パース不能・transcript 不在・認識可能行ゼロは fail-open（判定不能として続行）
- `method-check` — Claude Code / Codex のセッションログから開発時間内訳・運用摩擦を実測するチェック。固定スクリプト `references/session-metrics.mjs` で時間内訳を決定論的に集計する。direction を書いた作業の完了記載時は必須実行し（レーン非依存。実働欄を実測確定）、それ以外は「時間がかかった」と感じたときの主観トリガーで呼ぶ。スキル手順の穴に該当するロスだけ `~/dev-notes/dev-method/friction.md` へ記録する（改訂への落とし込みは dev-method リポジトリの `friction-revise` ローカルスキル）
- `playwright-cli` — ブラウザ自動化 CLI の使い方（公式 @playwright/cli 配布スキルの取り込み。upstream 更新時は再コピーで追従）
- `scenario-kit` — Playwright 録画を軸にした3用途ツール: ブランド付きデモ動画（`run`）、リリースノート・ドキュメント用スクリーンショット（`shots`）、実装後の軽量検証（`smoke`。ランタイム異常検知＋証跡を残す）。1つのシナリオを3用途へ使い回すのが基本形で、接続先が異なる場合だけ `<name>-local.json` 等の変種に分ける

plugin 経由のスキル呼び出しは namespace 付き（例: `/dev-method:direction`）。team-impl は各クライアントに自分用の1つだけが入るため名前衝突しない。

## モデル割当表

役割ごとに Claude 版・Codex 版で使うモデルを固定する。改廃時はこの表を更新し、`scripts/check-model-map.mjs` の対応する定数も合わせて修正する。

| 役割 | Claude 版 | Codex 版 |
| --- | --- | --- |
| implementer（通常境界） | Sonnet/medium | GPT-5.6 Terra/medium |
| implementer-high（高リスク境界） | Opus/high | GPT-5.6 Sol/high |
| プレレビュー reviewer | Fable/high | GPT-5.6 Sol/high |

`cross-review` は実行中のクライアントとは別モデルの CLI を呼ぶ: Codex 上で実行中なら Claude Fable/high を、Claude Code 上で実行中なら Codex の GPT-5.6 Sol/high を呼ぶ。

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

## セットアップ: 実装レーンの常駐トリガー

スキルはロードされて初めて効くため、`direction` を起動しないタスク（Ship / Show / Sign。レーンは direction の有無と独立）にレーン判定を効かせるには、常時ロードされるグローバル設定への追記が必要（初回のみ・配布物に乗らない）。`~/.claude/CLAUDE.md`（Claude Code）と `~/.codex/AGENTS.md`（Codex）へ以下を追記する:

```markdown
## 実装レーン

実装・修正の依頼を受けたら、着手前にレーンを1行宣言してから作業する（判定の正本は dev-method の `direction` スキル）。**レーンは爆発半径だけで決め、direction の有無とは独立**（direction は設計合意の道具であり、書いても実装工程は重くならない）。**Show は原義（マージ後の事後レビュー）でなく「出荷前の1回レビュー」を指す**:

- **Ship**（挙動に触れない: typo・docs・コメント・ログ文言・依存 patch 更新・自明な設定値変更）: 直接実装し、機械ゲート（lint・build・該当テスト）のみ。レビューなし
- **Show（デフォルト）**（下位2レーンの基準に触れないすべて）: 直接実装 → 機械ゲート → プレレビュー**1回**（**must-fix のみ即対応**、should-fix / nit は蓄積して follow-up 1バッチ）。Codex は現在の `spawn_agent` schema に `agent_type` があり `reviewer` が利用可能 role に見えれば `agent_type="reviewer"`・`fork_turns="none"` で起動し、model / effort は reviewer TOML を正本にする。`agent_type` が無い環境では3 role 定義がセッション開始前から同期済みの場合に限り reviewer TOML の役割本文を同梱し、モデル配分不成立（親モデル継承）を記録する。role が見えない・role 適用エラー・現セッションでの定義新規作成または rename は縮退せず、完全再起動または定義修正を求めて停止する。cross-review なし。UI に見える変更ではリポジトリroot・worktree root・モノレポ配下を探索し、既存シナリオの有無にかかわらず既存・軽微な変種または最小scenarioを準備して `scenario-kit smoke` を実走する。実測は `smoke <PASS|FAIL n件|評価不能|対象外>` とし、UI変更では `未整備` を使わない（UI非変更は `対象外`）
- **Sign**（高リスク基準*に触れる、または検知器の新設・変更）: 実装 → 機械ゲート（検知器タスクは実データ・実ログ×不変式のハーネスをここに）→ pre + cross を各1回 → 統合裁定 → must-fix を1バッチ修正 → 機械ゲート green で出荷（**修正後の再レビューなし**）。cross のログ機械判定と故意ずれ検体の実行検証は維持。Evidence Package・ledger・収束ループは使わない
- **Seal**（**不可逆**＝復旧不能なデータ変更・削除・公開後取り消し不能 ×**外部影響**＝公開 API・課金・第三者データ が**重なる**変更のみ）: `direction` を起草しフルパイプ（合意前計画レビュー・二者承認までの収束・Evidence Package・ledger）
- *高リスク基準 = DB migration・並行処理・認可・セキュリティ・境界間契約
- 迷ったら重い側のレーンに倒す。ユーザーがレーンを明示指定したら判定を省略する
```

Show のプレレビューは、Claude Code では `dev-method-claude:reviewer` agent の spawn、Codex では現在の tool schema が対応していれば `agent_type="reviewer"`・`fork_turns="none"` の spawn_agent で行う。schema に `agent_type` が無い場合の事前同期済み定義に限る縮退、role 不可視・適用失敗時の fail-closed は team-impl の前提セットアップと同じ契約に従う。

## リリース手順

1. 変更をコミット（日本語メッセージ）
2. `npm version patch` — version スクリプトが全6 plugin.json を自動同期して同一コミット + tag を作る
3. `git push origin main --follow-tags`（`git ls-remote --tags origin` で tag 到達を確認）
4. Claude Code: `claude plugin marketplace update mizulba-dev` → `claude plugin update dev-method@mizulba-dev` と `claude plugin update dev-method-claude@mizulba-dev`（適用は再起動後）
5. Codex: `codex plugin marketplace upgrade mizulba-dev` → `codex plugin add dev-method@mizulba-dev` と `codex plugin add dev-method-codex@mizulba-dev`（add が更新を兼ねる。適用は完全再起動後）

## 未検証ポイント

- Codex 版 team-impl の interrupt_agent 運用、並列スポーンの安定性、agents 定義の反映タイミング
- Codex 版 reviewer プロファイルの read-only 強制（spawn_agent に sandbox 相当の指定がなく、プロンプト指示のみに依存。2026-07-16 追加）
- `dev-method-claude` の `hooks/hooks.json` における `$PLUGIN_ROOT` 展開の実機確認（plugin-codex の前例と同形式で実装したが、2026-07-19 時点でローカルにインストール済みのプラグインキャッシュが hooks.json 未搭載の旧バージョンのため未確認。次回リリース・再インストール後に確認する）

## 検証済み

- Codex の plugin ローダーは `agents/` ディレクトリを無視する（2026-07 実測。公式 plugin はすべて skills/ + assets/ のみ）。Codex のエージェント定義は plugin では配布できず `~/.codex/agents/*.toml` 固定のため、Codex 版 team-impl はスキル初回実行時と定義更新時のコピーでセットアップする
- Codex 上からの `claude -p --allowedTools ...` によるレビュー実行（cross-review の Codex 側分岐。2026-07-09 初回運用で実測、オプション形式の調整後に動作）
- Codex 版 team-impl の spawn_agent / wait_agent による単一 implementer 運用（2026-07-09 初回運用で実測）
- Codex 版 team-impl の `fork_turns="none"` / send_message / followup_task / list_agents 運用（2026-07-11 実測）
- Codex CLI `0.145.0-alpha.24` の custom role routing（2026-07-20実測）: `agent_type` + `fork_turns="none"` で implementer = GPT-5.6 Terra/medium、implementer-high = GPT-5.6 Sol/high、reviewer = GPT-5.6 Sol/high を選択し、implementer の follow-up でも同じ role / model / effort を維持。これは CLI alpha の確認であり、Codex Desktop / IDE の現セッションへの反映は現在の tool schema で別途判定する
- Codex セッション JSONL の cwd・正常/中断ターン境界・ツール call/output・MCP 所要時間・累積トークン量の抽出（2026-07-11 実在ログで確認）
- Claude Code の `SubagentStop` hook 入力 JSON のフィールド実名（2026-07-19 probe hook で実測）: `transcript_path` は**親セッション側**の transcript で、サブエージェント自身の transcript は別フィールド `agent_transcript_path`。再入フラグの実名は `stop_hook_active`。他に `agent_id` / `agent_type` / `session_id` / `cwd` / `hook_event_name` / `last_assistant_message` / `background_tasks` / `session_crons` を確認。実機確認として、SendMessage を使わず終了しようとする subagent が報告ゲート hook にブロックされ、Stop hook feedback を受けて SendMessage 送信後に終了するフローを実測
- `claude -p --output-format stream-json` は `--verbose` を伴わないとエラーで即終了する（2026-07-19 実測）。tool_use は `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":...}}]}}` の形、最終結果は末尾の `{"type":"result","result":"<テキスト>",...}` イベントに入る
- `codex exec --json` の command_execution イベント形式（`{"type":"item.completed","item":{"type":"command_execution","command":"/bin/zsh -lc '<コマンド>'",...}}`）を実測し、`check-review-log.mjs` の逸脱判定はこのシェルラッパーを剥がしてから許可パターンと照合する設計にした（2026-07-19）
- canary 実測（2026-07-19）: cross-review と同一の `--allowedTools "Read,Grep,Glob,Bash(git diff:*),Bash(git status:*),Bash(git log:*)"` 下で `go test` 実行を明示要求するプロンプトを `claude -p --output-format stream-json --verbose` で1回流したところ、許可外の Bash 呼び出し（`go test ./...` を含む複数バリエーション・複合コマンド・許可外 MCP ツール）は計7件すべて `result.permission_denials` として個別拒否された。ただし**単発の拒否で run 全体が abort するわけではない**: モデルはターンを継続し、最終的に `terminal_reason: "completed"` で正常終了して「テストは実行できていない」と正直に報告した（事前調査時点の「run が abort する」という記述は不正確だったと訂正。1回目の試行が見かけ上 abort したのは、こちら側の Bash ツール2分タイムアウトによる強制中断が原因で、allowedTools 機構自体によるものではなかった）。したがって cross-review 手順3のプロンプト側検証禁止条項は canary の結果によらず維持する（allowedTools 単体では「モデルが拒否のたびに別の抜け道を試し続ける」ことを防げないため、明文化との併用が必要）
