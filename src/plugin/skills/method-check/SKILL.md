---
name: method-check
description: セッションの時間内訳と運用摩擦を固定スクリプトで実測する開発運用チェック。direction を書いた作業の完了記載時は必須実行し（レーン非依存）、それ以外は「時間がかかった」と感じたときの主観トリガーで呼び、問題があれば friction ログへ記録する
argument-hint: [セッションID]
---

# method-check: セッション実測による開発運用チェック

トリガーは2系統ある:

- **direction を書いた作業の完了記載時は必須実行**（レーン非依存。Show / Sign / Seal のどれでも direction があれば対象）。direction 完了記載の工程としてリーダーセッションを実測し、実働欄を確定する（direction スキル完了節の手順が本チェックを呼ぶ）。
- **それ以外は主観トリガー**（時間がかかった・回り方が悪かった）。direction の無い作業で体感の悪かったセッションをその場で精査する。自動・定期では回さない。

体感で原因を決めつけず、`references/session-metrics.mjs` の実測 JSON から時間内訳を出してから問題を特定する。

必須実測の記載先はレーンのフッター型に従う（採用条件は共通＝`skippedLines`・`unknownEvents`・`orphanToolUses` が各1%未満、かつ検算値が非 null なら乖離 ≦10%）: **Show** は簡易フッターの実働欄 `実働<N>分（手法運用<N>分）`、**Sign / Seal** は Ask 型文法フッターの実働欄。採用条件を満たさなければどのレーンでも省略（欠測）。

## 対象セッションの解決

必須実測（direction を書いた作業の完了記載時）の対象は **direction 完了記載を実行中のリーダーセッション**とする。起草・実装が別セッションに分かれ、そのログパスが判明していれば `--session` で追加してよい。不明分は対象外と報告に明記する。teammate / subagent transcript は自動探索しない（委譲先の内訳が要るなら follow-up）。

1. $ARGUMENTS にセッション ID があれば、Claude は `~/.claude/projects/*/<ID>.jsonl`、Codex は `~/.codex/sessions/**/rollout-*<ID>.jsonl` から探す。ファイル名で見つからない Codex ログは `session_meta.payload.id` / `session_id` も照合する
2. 引数が無ければ**実行中のこのセッション**を選ぶ:
   - Codex: `CODEX_THREAD_ID` があればその ID を使い、`~/.codex/sessions/**/*.jsonl` から選ぶ
   - Claude Code: `~/.claude/projects/<スラッグ>/`（スラッグは cwd 絶対パスの `/` を `-` に置換）で最終更新が最新の `*.jsonl`
3. 実行中クライアントを判別できない場合だけ、両保存先から cwd が一致するログを抽出し、最終更新順の候補を示して対象を絞る。Codex の cwd は先頭付近の `session_meta.payload.cwd` を使い、片方のログ形式のキーを他方へ仮定しない

## 分析手順

scratchpad へ集計スクリプトを書き起こさず、同梱の固定スクリプトを実行して JSON を解釈する。Claude / Codex 形式は自動判別される。

```
node <このスキルの references/session-metrics.mjs 絶対パス> --session <対象jsonl絶対パス> [--session <path>...] [--method-path <substring>...]
```

- 出力は `{ sessions: [...], totals: {...} }` の JSON。各 session は `wallClockMs`（壁時計）・`userWaitMs`（ユーザー応答待ち）・`activeMs`（実働）・`breakdown`（`llmGenerationMs` / `methodOpsMs` / `toolExecutionMs` / `delegationWaitMs` / `unattributedMs` の排他パーティション）・`turnDurationCheckMs`（Claude）または `durationCheckMs` / `mcpDurationMs`（Codex）・`tokens`・`loops`・`quality` を持つ。分は呼び出し側で四捨五入する
- **手法運用（`methodOpsMs`）は現行規定を2点改訂した機械判定のヒューリスティック値**（決定2）:
  - (i) 定義を「LLM 生成のうち手法運用区間」から「手法運用対象ツールの実行区間＋その直前の LLM 生成区間」へ拡張した。帳簿づけの実コストがツール実行にも乗るため、手法運用コスト総和を1指標で追う。過去の手動 method-check 報告との数値連続性は求めない
  - (ii) MCP の `duration` 実測値は排他パーティションと両立しないため breakdown へ算入せず、補助フィールド `mcpDurationMs` として別掲する
  - 判定はツール呼び出しの**入力側パスのみ**を**キー限定列挙方式**で行う（値の形状でなくキーの意味で判定）: パスキー列挙（`file_path` / `filePath` / `path` / `notebook_path` / `target_file` / `cwd` / `file` / `directory` / `dir` 等の実ログで観測されるパス運搬キー）の値は形状フィルタなしで候補化（裸ファイル名 `friction.md` も matcher へ渡す）、シェルキー（`command` / `cmd` / `script`。文字列・配列両対応）は空白分割した絶対パストークンを抽出、本文キー（`content` / `old_string` / `new_string` / `message` / `prompt` / `description` / `patch` 等）と列挙外の未知キーは値形状によらず候補化しない。ツール出力・本文は見ない。一致条件は `/dev-notes/` 配下の `/direction/`、`friction.md`（セグメント末尾一致）、`.work/` 配下の `review-ledger` / `plan-review` / `evidence` 名、および `--method-path` 追加 substring。matcher 列挙外の手法運用（報告文生成等）は含まれず、混在呼び出しでは非手法時間を含み得る（両方向のずれを持つため「下限値」ではない）
- `delegationWaitMs` は委譲・バックグラウンド待機系ツール（`Agent` / `Task` / Codex の `wait_agent`）が pending の区間へ帰属する。Codex は turn 外区間（最初の `task_started` 前・終端から次 `task_started`・最終終端後）を pending や未知イベントに関わらず `userWaitMs` へ一意帰属し、turn 終端で残留 pending を orphan として計上する
- **品質（`quality`）が fail-closed の入口**。壊れ JSON 行・timestamp 欠落・突合不能 tool_use・未知イベントは集計を止めず `skippedLines` / `timestampMissing` / `orphanToolUses` / `unknownEvents` へ計上される。どちらの形式とも判別不能・ファイル不在・引数なしは exit 1。ログ世代交代で `unknownEvents` が増えたら既知集合の追補（direction 追補）で回復する

## 報告

- **壁時計と実働を分けて**示し、ユーザー待ちを除いた実働（`activeMs`）の内訳（`breakdown`）を大きい順に報告する。検算値（`turnDurationCheckMs` / `durationCheckMs`）との乖離も添える
- Codex は取得できた場合、累積トークン量（`tokens` の入力・キャッシュ入力・出力・reasoning・合計）を併記する。これは各ターンの合算ではなく、最後の `total_token_usage` の値を使う。モデル単価から料金を自動換算しない
- ロス候補の抽出観点: 手戻り（実装→revert→再実装）／委譲空振り（タスク不達・再委譲）／レビューの巡回数と指摘件数の推移（非単調収束）／エラー→リトライ／出力先・パス等のやり直し／同一ツール・同一ファイルへの短時間反復（session-metrics の `loops`＝同一操作3回以上のループ候補を機械抽出済み）／完了報告・レビュー対応中の合理化表現（「とりあえずテストは省略」「既存のバグなので」等。誤検知があるため警告として報告するだけでブロック・差し戻しの根拠にしない）。並列レビュー待ちは pre と cross の待ち時間を足さず、最初の共同ラウンド開始から同一版二者承認までの壁時計として評価し、各レビュアーの実行時間は内訳に留める
- レビューが走ったセッションでは、R1 の must / should 指摘を失敗シナリオ／根本原因単位で重複・pre 固有・cross 固有・相反へ分類し、採用した指摘を計画のどのセクション（検証設計・変更マップ・完了条件・契約・横断関心の振り分け）の穴かへ帰責する。相反は裁定後に採用した側の固有へ数え、棄却と nit は固有／重複へ含めない。件数の推移だけで済ませない — 帰責先が計画品質の改善対象を特定する
- ロスが無ければ「問題なし」と明言する

## friction 記録

- ロスのうち**スキル手順の穴・手順と実態のずれ・過去エントリと同型の再発**に該当するものだけを `~/dev-notes/dev-method/friction.md` へ1行追記する（形式・状態マークはファイルヘッダーに従う。無ければヘッダー付きで作る）。正味の作業時間や単発の環境事故は報告のみで記録しない
- R1 指摘の帰責で同一セクションに複数件が集まった場合も、pre/cross 固有・重複の別とセクション名を添えて1行記録する（共同ラウンド指標を計画品質の改善に使う運用と対にする）
- 追記後、未対応エントリの件数と同型をその場で判定し、トリガー（ヘッダー記載）に到達していたら dev-method の改訂バッチを回すようユーザーに案内する（このスキル自身はスキル改訂に踏み込まない）
- dev-notes が git 管理されていればコミットする
