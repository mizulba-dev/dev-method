---
name: method-check
description: セッションの時間内訳と運用摩擦を固定スクリプトで実測する開発運用チェック。direction を書いた作業の完了記載時は必須実行し（レーン非依存）、それ以外は完了報告前のセルフチェック（壁時計45分超または迂回・手戻り・環境復旧に約10分以上）に該当したら実行して報告し、問題があれば friction ログへ記録する
argument-hint: [セッションID]
---

# method-check: セッション実測による開発運用チェック

トリガーは2系統ある:

- **direction を書いた作業の完了記載時は必須実行**（レーン非依存。Show / Sign / Seal のどれでも direction があれば対象）。direction 完了記載の工程としてリーダーセッションを実測し、実働欄を確定する（direction スキル完了節の手順が本チェックを呼ぶ）。
- **それ以外は完了報告前のセルフチェック**。direction の無い作業でも、完了報告を書く前に「セッション開始からの壁時計が45分を超えた」または「迂回・手戻り・環境復旧に合計およそ10分以上を費やした」のいずれかに該当したら、本チェックを実行してから報告する（ユーザーの指摘を待たない）。該当しなければ実行不要。体感トリガー（時間がかかった・回り方が悪かった）での随時実行も引き続きよい。自動・定期では回さない。

体感で原因を決めつけず、`references/session-metrics.mjs` の実測 JSON から時間内訳を出してから問題を特定する。

必須実測の記載先はレーンのフッター型に従う（採用条件は共通＝`skippedLines`・`unknownEvents`・`orphanToolUses` が各1%未満、かつ検算値が非 null なら乖離 ≦10%。検算は Claude / Codex とも turn 窓限定の `turnWindowActiveMs` 対 `turnWindowCheckMs`（Claude は内部プロンプトを含む窓と計上済み窓に重なる窓を除いた clean 窓、Codex は `duration_ms` を持って閉じた turn 窓。対象窓が無いログは検算不能））: **Show** は簡易フッターの実働欄 `実働<N>分（手法運用<N>分）`、**Sign / Seal** は Seal 型フッター（direction 完了節の文法。旧称 Ask 型）の実働欄。採用条件を満たさなければどのレーンでも省略（欠測）。

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

- 出力は `{ sessions: [...], totals: {...} }` の JSON。各 session は `wallClockMs`（壁時計）・`userWaitMs`（turn 外の応答待ち。人間入力・teammate/task 通知とも）・`activeMs`（実働）・`breakdown`（`llmGenerationMs` / `methodOpsMs` / `toolExecutionMs` / `delegationWaitMs` / `unattributedMs` の排他パーティション）・`turnWindowActiveMs` / `turnWindowCheckMs`（両クライアント共通の検算欄）・`turnDurationCheckMs`（Claude 参考値）または `durationCheckMs` / `mcpDurationMs`（Codex 参考値）・`tokens`・`loops`・`quality` を持つ。分は呼び出し側で四捨五入する
- **手法運用（`methodOpsMs`）は現行規定を2点改訂した機械判定のヒューリスティック値**（決定2）:
  - (i) 定義を「LLM 生成のうち手法運用区間」から「手法運用対象ツールの実行区間＋その直前の LLM 生成区間」へ拡張した。帳簿づけの実コストがツール実行にも乗るため、手法運用コスト総和を1指標で追う。過去の手動 method-check 報告との数値連続性は求めない
  - (ii) MCP の `duration` 実測値は排他パーティションと両立しないため breakdown へ算入せず、補助フィールド `mcpDurationMs` として別掲する
  - 判定はツール呼び出しの**入力側パスのみ**を**キー限定列挙方式**で行う（値の形状でなくキーの意味で判定）: パスキー列挙（`file_path` / `filePath` / `path` / `notebook_path` / `target_file` / `cwd` / `file` / `directory` / `dir` 等の実ログで観測されるパス運搬キー）の値は形状フィルタなしで候補化（裸ファイル名 `friction.md` も matcher へ渡す）、シェルキー（`command` / `cmd` / `script`。文字列・配列両対応）は空白分割した絶対パストークンを抽出、本文キー（`content` / `old_string` / `new_string` / `message` / `prompt` / `description` / `patch` 等）と列挙外の未知キーは値形状によらず候補化しない。ツール出力・本文は見ない。一致条件は `/dev-notes/` 配下の `/direction/`、`friction.md`（セグメント末尾一致）、`.work/` 配下の `review-ledger` / `plan-review` / `evidence` 名、および `--method-path` 追加 substring。matcher 列挙外の手法運用（報告文生成等）は含まれず、混在呼び出しでは非手法時間を含み得る（両方向のずれを持つため「下限値」ではない）
- `delegationWaitMs` は委譲・バックグラウンド待機系ツール（`Agent` / `Task` / Codex の `wait_agent`）が **turn 内で** pending の区間へ帰属する。turn 外・turn 開始前の応答待ちは両クライアントとも `userWaitMs` へ一意帰属する: Codex は turn 外区間（最初の `task_started` 前・終端から次 `task_started`・最終終端後。pending・未知イベントに関わらず最優先）、Claude は (i) プロンプト（人間入力・teammate-message・task-notification）で終わる区間（pending に関わらず。ただし未知イベント隣接の taint 区間は `unattributedMs` が優先）と (ii) `turn_duration` イベントから次の timeline イベント（EOF まで無ければログ終端）までの区間（pending・未知に関わらず。境界をまたぐ区間は境界で分割し、境界前は turn 内規則で分類）。Codex は turn 終端で残留 pending を orphan として計上する。規則 (i) は turn 実行中の steering・生成中に届いた通知の直前区間も userWait に落とすため、`activeMs` は過小方向のずれを持つ（dirty 窓は検算対象外のためこの偏りは窓限定検算に現れない。`methodOpsMs` と同様に両側とも厳密値ではない）
- 検算は両クライアントとも **turn 窓限定**の `turnWindowActiveMs`（窓内 active）対 `turnWindowCheckMs`（窓 duration 合計）: Claude は `turn_duration` の窓 `[ts−durationMs, ts]` のうち、窓内部にプロンプトを含む turn（teammate 往復・steering を含む長大 turn。`durationMs` が turn 内の応答待ちを含むため）と、計上済み窓に重なる窓（同一プロンプトへアンカーされた入れ子 `turn_duration`。同じ壁時計の二重計上になるため）を除いた clean 窓だけを使う。Codex は `duration_ms` を持つ `task_complete` / `turn_aborted` で閉じた turn だけを使い、進行中の最終 turn と `duration_ms` の無い終端は検算から除外する（`activeMs` には計上されたまま。turn 実行中の実測でも検算が成立する）。対象窓が無いログは検算不能（null）で、`turnDurationCheckMs`（Claude・全 `turn_duration` 合算）と `durationCheckMs`（Codex・全終端 `duration_ms` 合算）は参考値として残る
- **品質（`quality`）が fail-closed の入口**。壊れ JSON 行・timestamp 欠落・突合不能 tool_use・未知イベントは集計を止めず `skippedLines` / `timestampMissing` / `orphanToolUses` / `unknownEvents` へ計上される。どちらの形式とも判別不能・ファイル不在・引数なしは exit 1。ログ世代交代で `unknownEvents` が増えたら既知集合の追補（direction 追補）で回復する

## 報告

- **壁時計と実働を分けて**示し、ユーザー待ちを除いた実働（`activeMs`）の内訳（`breakdown`）を大きい順に報告する。検算の乖離（両クライアントとも `turnWindowActiveMs` 対 `turnWindowCheckMs`）も添える
- Codex は取得できた場合、累積トークン量（`tokens` の入力・キャッシュ入力・出力・reasoning・合計）を併記する。これは各ターンの合算ではなく、最後の `total_token_usage` の値を使う。モデル単価から料金を自動換算しない
- ロス候補の抽出観点: 手戻り（実装→revert→再実装）／委譲空振り（タスク不達・再委譲）／レビューの巡回数と指摘件数の推移（非単調収束）／エラー→リトライ／出力先・パス等のやり直し／同一ツール・同一ファイルへの短時間反復（session-metrics の `loops`＝同一操作3回以上のループ候補を機械抽出済み）／完了報告・レビュー対応中の合理化表現（「とりあえずテストは省略」「既存のバグなので」等。誤検知があるため警告として報告するだけでブロック・差し戻しの根拠にしない）。並列レビュー待ちは pre と cross の待ち時間を足さず、最初の共同ラウンド開始から同一版二者承認までの壁時計として評価し、各レビュアーの実行時間は内訳に留める
- レビューが走ったセッションでは、R1 の must / should 指摘を失敗シナリオ／根本原因単位で重複・pre 固有・cross 固有・相反へ分類し、採用した指摘を計画のどのセクション（検証設計・変更マップ・完了条件・契約・横断関心の振り分け）の穴かへ帰責する。相反は裁定後に採用した側の固有へ数え、棄却と nit は固有／重複へ含めない。件数の推移だけで済ませない — 帰責先が計画品質の改善対象を特定する
- ロスが無ければ「問題なし」と明言する

## friction 記録

- ロスのうち**スキル手順の穴・手順と実態のずれ・過去エントリと同型の再発**に該当するものだけを `~/dev-notes/dev-method/friction.md` へ1行追記する（形式・状態マークはファイルヘッダーに従う。無ければヘッダー付きで作る）。正味の作業時間や単発の環境事故は報告のみで記録しない
- 各エントリの日付直後に**発生位置タグを1つだけ**置く（`- YYYY-MM-DD [<タグ>] プロジェクト / スキル名と該当手順: 内容`）。タグは改訂バッチの同型判定の第一キーになるため、主因の1箇所を選ぶ。工程の内側で閉じる穴は node、工程間の受け渡しで起きる穴は edge を使い、どちらとも取れる場合は edge を選ぶ（受け渡しの穴はスキル本文の記述で直せる）:
  - `node:plan` 起草・レーン判定・検証設計 ／ `node:impl` 実装と検証の実行 ／ `node:review` レビューの検知力（観点漏れ・見落とし） ／ `node:leader` 分割・裁定・報告・帳簿 ／ `node:gate` 機械ゲート・固定 checker・smoke
  - `edge:plan->impl` ブリーフ・契約・検証設計の伝達漏れ ／ `edge:leader->impl` spawn 指示・実行環境のセットアップ ／ `edge:impl->leader` 完了報告・検証証跡・待機 ／ `edge:leader->review` レビュー起動（prompt・レビュー範囲の指定・モデル指定・diff 指紋・read-only 制約） ／ `edge:impl->impl` 境界統合（worktree・cherry-pick・担当外 path 混入）
  - レビュー系の切り分け: 渡した範囲は妥当だがレビュアーが見落とした穴は `node:review`、範囲・prompt・制約の指定側に原因がある穴（全量再レビューのコスト膨張・観点の指示漏れ・制約の不徹底）は `edge:leader->review` を選ぶ
  - 語彙に当てはまらない位置は最も近いタグへ寄せ、行内にその旨を書く（語彙自体の追加は改訂バッチで判断する）
- R1 指摘の帰責で同一セクションに複数件が集まった場合も、pre/cross 固有・重複の別とセクション名を添えて1行記録する（共同ラウンド指標を計画品質の改善に使う運用と対にする）
- 追記後、未対応エントリの件数と同型をその場で判定し、トリガー（ヘッダー記載）に到達していたら dev-method の改訂バッチを回すようユーザーに案内する（このスキル自身はスキル改訂に踏み込まない）
- dev-notes が git 管理されていればコミットする
