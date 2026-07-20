---
name: method-check
description: 開発を回したセッションの時間内訳と運用摩擦を実測する開発運用チェック。実装完了後に「時間がかかった」と感じたときその場で呼び、問題があれば friction ログへ記録する
argument-hint: [セッションID]
---

# method-check: セッション実測による開発運用チェック

呼び出しはユーザーの主観（時間がかかった・回り方が悪かった）がトリガー。自動・定期では回さない。体感で原因を決めつけず、セッションログのタイムスタンプから時間内訳を実測してから問題を特定する。

## 対象セッションの解決

1. $ARGUMENTS にセッション ID があれば、Claude は `~/.claude/projects/*/<ID>.jsonl`、Codex は `~/.codex/sessions/**/rollout-*<ID>.jsonl` から探す。ファイル名で見つからない Codex ログは `session_meta.payload.id` / `session_id` も照合する
2. 引数が無ければ**実行中のこのセッション**を選ぶ:
   - Codex: `CODEX_THREAD_ID` があればその ID を使い、`~/.codex/sessions/**/*.jsonl` から選ぶ
   - Claude Code: `~/.claude/projects/<スラッグ>/`（スラッグは cwd 絶対パスの `/` を `-` に置換）で最終更新が最新の `*.jsonl`
3. 実行中クライアントを判別できない場合だけ、両保存先から cwd が一致するログを抽出し、最終更新順の候補を示して対象を絞る。Codex の cwd は先頭付近の `session_meta.payload.cwd` を使い、片方のログ形式のキーを他方へ仮定しない

## 分析手順

jsonl は数百 KB〜数 MB あるため目視で読まず、scratchpad に集計スクリプトを書く。まず Claude / Codex を判別し、クライアント固有のイベントを下記の共通分類へ正規化してから集計する。

### Claude Code

1. 全イベントの timestamp（UTC 記録。報告はローカル時刻へ変換）と type を読む
2. ツール実行時間は tool_use と tool_result を id で突合して算出する
3. それ以外の連続イベント間ギャップを「直前のイベント種別＝何を待っていたか」で分類する: ユーザー応答待ち／LLM 生成／委譲エージェント・バックグラウンドタスク待ち
4. LLM 生成のうち**手法運用**（direction 起草・実測フッター/friction 記録・README 索引・ユーザー向け報告の生成）に当たる区間は分けて集計する。判定はその区間のツール対象ファイル（direction 置き場・friction.md 等）と出力内容で行う
5. system イベントの `turn_duration` を実働時間の検算に使う。`away_summary` などハーネスの周期処理はギャップ算入前に中身を確認し、待ち時間と混同しない
6. queue-operation の enqueue 内容で「ユーザーの入力」と「task-notification / teammate-message」を区別する（後者はユーザー待ちではない）

### Codex

1. `session_meta.payload.cwd` を対象 cwd の確認に使い、`event_msg.payload.type` の `task_started` から正常終端の `task_complete` または中断終端の `turn_aborted` までを1ターンの実働境界とする。両終端の `payload.duration_ms` は壁時計からユーザー待ちを除いた時間の検算に使い、中断ターンも欠落させない
2. ツール実行時間は `response_item` の次の組を `payload.call_id` で突合する:
   - `custom_tool_call` / `custom_tool_call_output`
   - `function_call` / `function_call_output`
3. MCP 呼び出しは `event_msg.payload.type == "mcp_tool_call_end"` の `payload.call_id` と `payload.duration.secs` / `nanos` を使う。対応する call/output のタイムスタンプ差よりこの実測値を優先し、二重計上しない
4. `task_complete` または `turn_aborted` から次の `task_started` までをユーザー応答待ちとする。ターン内は、ツール call/output、`event_msg`、`response_item` の連続イベント間ギャップを直前イベントに従って LLM 生成／ツール実行／サブエージェント・バックグラウンドタスク待ちへ分類する。`wait_agent` 等の待機ツールは通常ツールと分ける
5. LLM 生成のうち手法運用に当たる区間は Claude Code と同じ基準で分ける。ハーネス由来のイベントは内容を確認し、ユーザー待ちや生成時間へ機械的に含めない
6. 最後の `event_msg.payload.type == "token_count"` にある `payload.info.total_token_usage` をセッション累積値として読む。取得不能なら推定せず「取得不能」とし、モデル単価から料金を自動換算しない

## 報告

- **壁時計と実働を分けて**示し、ユーザー待ちを除いた実働の内訳を大きい順に報告する
- Codex は取得できた場合、累積トークン量（入力・キャッシュ入力・出力・reasoning・合計）を併記する。これは各ターンの合算ではなく、最後の `total_token_usage` の値を使う
- ロス候補の抽出観点: 手戻り（実装→revert→再実装）／委譲空振り（タスク不達・再委譲）／レビューの巡回数と指摘件数の推移（非単調収束）／エラー→リトライ／出力先・パス等のやり直し／同一ツール・同一ファイルへの短時間反復（同一操作3回以上を集計スクリプトでループ候補として機械抽出する）／完了報告・レビュー対応中の合理化表現（「とりあえずテストは省略」「既存のバグなので」等。誤検知があるため警告として報告するだけでブロック・差し戻しの根拠にしない）。並列レビュー待ちは pre と cross の待ち時間を足さず、最初の共同ラウンド開始から同一版二者承認までの壁時計として評価し、各レビュアーの実行時間は内訳に留める
- レビューが走ったセッションでは、R1 の must / should 指摘を失敗シナリオ／根本原因単位で重複・pre 固有・cross 固有・相反へ分類し、採用した指摘を計画のどのセクション（検証設計・変更マップ・完了条件・契約・横断関心の振り分け）の穴かへ帰責する。相反は裁定後に採用した側の固有へ数え、棄却と nit は固有／重複へ含めない。件数の推移だけで済ませない — 帰責先が計画品質の改善対象を特定する
- ロスが無ければ「問題なし」と明言する

## friction 記録

- ロスのうち**スキル手順の穴・手順と実態のずれ・過去エントリと同型の再発**に該当するものだけを `~/dev-notes/dev-method/friction.md` へ1行追記する（形式・状態マークはファイルヘッダーに従う。無ければヘッダー付きで作る）。正味の作業時間や単発の環境事故は報告のみで記録しない
- R1 指摘の帰責で同一セクションに複数件が集まった場合も、pre/cross 固有・重複の別とセクション名を添えて1行記録する（共同ラウンド指標を計画品質の改善に使う運用と対にする）
- 追記後、未対応エントリの件数と同型をその場で判定し、トリガー（ヘッダー記載）に到達していたら dev-method の改訂バッチを回すようユーザーに案内する（このスキル自身はスキル改訂に踏み込まない）
- dev-notes が git 管理されていればコミットする
