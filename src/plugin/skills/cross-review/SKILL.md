---
name: cross-review
description: 未コミット diff を実行中のクライアントとは別のモデル CLI にレビューさせるクロスモデルレビュー。実装完了時のセカンドオピニオンや team-impl のレビュー工程で使う
argument-hint: <対象リポジトリの絶対パス> [計画ファイルのパス] [重点観点]
---

# cross-review: 別モデル CLI によるクロスモデル diff レビュー

$ARGUMENTS の1つ目が対象リポジトリの絶対パス。2つ目以降は任意で、計画ファイルのパス（設計逸脱の照合に使う）と重点観点。

レビュアーは**実行中のクライアントとは別のモデル CLI** を選ぶ:

- Claude Code 上で実行中 → `codex exec --cd <対象リポジトリ> --sandbox read-only -m gpt-5.6-sol -c 'model_reasoning_effort="high"' --output-schema <スキーマファイル> -o <結果JSON> "<プロンプト>"`（`-m` 指定モデルが 400 model not supported になるアカウントでは `-m` を外して既定モデルで再実行する）
- Codex 上で実行中 → `cd <対象リポジトリ> && claude -p "<プロンプト>" --model fable --effort high --allowedTools "Read,Grep,Glob,Bash(git diff:*),Bash(git status:*),Bash(git log:*)"`（スキーマ強制フラグが無いため、末尾「出力スキーマ」に適合する JSON のみを出力するようプロンプトで指示し、stdout を結果 JSON として保存する）

レビュアーはレビューだけを行い、コードは修正しない（read-only sandbox / allowedTools 制限で強制）。レビュアーを teammate として挟まず、リーダーが直接 CLI を起動する2層構成。

呼び出し元（team-impl 等）が cross-review 起動前に同ファミリー最上位モデルによるプレレビューを行う場合の手順は、呼び出し元のスキル（`team-impl` のプレレビュー節）を参照する。cross-review 自体は異ベンダーによる diff レビューの実行にのみ責務を持つ。

## 手順

1. 対象リポジトリで `git status --short` と `git diff --stat HEAD` を確認し、レビュー対象の diff があることを確かめる（対象が無ければここで終了）
2. 出力先を決める: 結果 JSON `<対象リポジトリ>/.work/cross-review-<N>.json` と実行ログ `<対象リポジトリ>/.work/cross-review-<N>.log`（N は連番。`.work/` が無ければ作成）。スキーマファイル `<対象リポジトリ>/.work/cross-review-schema.json` を本スキルの `references/cross-review-schema.json` から `cp` して作成する（既存でも毎回上書きし、スキル改訂後に旧スキーマが渡り続けるのを防ぐ）。パスはすべて**絶対パス**で書く（バックグラウンド実行の cwd に依存すると出力が迷子になる）。`.work/` が ignore されていなければ `<対象リポジトリ>/.git/info/exclude` に `.work/` を追記する（共有リポジトリの .gitignore は変更しない）
3. **バックグラウンド実行**で上記コマンドを起動する。read-only のレビュアーはファイルを書けないため、結果はリーダー側で受け取る: codex は `-o` が結果 JSON を書くので `<コマンド> < /dev/null > <ログ> 2>&1`、claude は stdout が結果なので `<コマンド> < /dev/null > <結果JSON> 2> <ログ>`（stdin を閉じないと codex exec が「Reading additional input from stdin...」で入力待ちのままハングする）。シェルの `&` だけで起動すると、ツール呼出しの終了と同時に子プロセスごと終了して出力0バイトになる環境がある。ツール呼出し終了後もプロセスが継続する非同期実行機構（例: 実行環境のバックグラウンド実行機能）を使う。プロンプトはシェル引数へ直書きしない: バッククォート・`$`・リダイレクト記号を含むとシェルが解釈して parse error や意図しない実行になる。プロンプトを `<対象リポジトリ>/.work/cross-review-prompt-<N>.md` に書き、`"$(cat <プロンプトファイル>)"` で渡す

   プロンプトは本スキルの `references/review-prompt.md` をコピーし、差し込み枠（`{{DIFF_RANGE}}` `{{PLAN_PATH}}` `{{FOCUS}}` `{{EVIDENCE}}` `{{PREV_FINDINGS}}`）だけを埋めて使う。観点の取捨選択・再構成をしない。条件付きブロック（高リスク観点・検知器変更時の検体照合・計画追補の照合）はテンプレのまま残し、削らずに渡す（条件成立の判定はレビュアー側が行う）。他スキルが「`references/review-prompt.md` の観点ブロック」を流用する場合（team-impl のプレレビュー等、ファイル出力しない報告契約の実行）は「## 観点」節のみを使い、「## 出力形式」節は含めない（報告形式は流用先スキルの契約に従う）
4. 完了通知が来たら以下の順で処理する:
   - **結果の読み取り**: 結果 JSON を読み、severity で must-fix / should-fix を機械的に抽出して要約を報告する。team-impl 中なら must-fix / should-fix を implementer への差し戻しに使う。JSON が壊れている・スキーマ不適合の場合（主に claude 側）は1回だけ再実行し、それでも不適合なら出力を自由文として読み取り、逸脱として実測フッターと friction ログに記録する。verdict と findings の severity の整合（approve なのに must-fix / should-fix を含む場合）をリーダーが機械的に確認し、不整合ならスキーマ不適合と同様に1回だけ再実行する
   - **採否の裁定**: 指摘の採否・棄却に迷う場合、Claude Code 上でセッションに advisor が設定されていれば advisor に相談してから決める。相談してもなお偽陽性と示せない指摘は棄却せず must-fix / should-fix のまま残す（fail-closed。不確実性は棄却の根拠にしない）
   - **逸脱の検知と記録**: 出力に追加検証（テスト・ビルド・format 等）の実行報告が含まれていたら、allowedTools / sandbox で強制しきれなかった逸脱として実測フッターと friction ログに記録し、実行結果由来の指摘は静的根拠を確認してから採用する
   - **完了待機の方法**: 完了確認は実行環境の完了通知かブロッキング待機を必須とし、短間隔（秒単位）の手動ポーリングを繰り返さない。どちらも使えない環境でのみ手動確認とし、初回確認は diff 規模から見積もった実行時間（数分〜十数分）の経過後、以後も数分間隔を守る。60秒未満の poll を繰り返した場合は逸脱として実測フッターに記録する
5. **must-fix / should-fix がゼロになるまでレビューを繰り返す**。以下の順で運用する:
   - **終了判定**: 終了判定は結果 JSON の findings に must-fix / should-fix が無いことの機械判定で行う（品質優先のためラウンド数の上限は設けない）。verdict が needs-attention なのに must-fix / should-fix がゼロの場合は fail-closed とし、summary を確認して再ラウンドする
   - **nit の扱い**: nit はループの終了条件にせず、各ラウンドで検出された nit は修正を求めず蓄積して、ループ終了時に最終報告へ一括で列挙する（採否は完了後にユーザーが判断する。数行で直せる nit をリーダーがその場で直すことは妨げないが、nit のためだけに追加ラウンドを起動しない）
   - **差分限定再レビュー**: must-fix / should-fix を修正したら再レビューを起動する。再レビュー（2ラウンド目以降）は全量の観点を再適用しない: プロンプトに前回指摘の一覧（前ラウンドの findings JSON をそのまま貼ってよい）・対応方針・修正したファイルを明示し、前回指摘への対応の妥当性と修正による新規混入の確認に限定する。修正が契約・境界へ波及した場合のみ全量を再レビューする。Claude Code 上では `/loop` で「レビュー→修正」のサイクルを回してよい
   - **停止条件**: 5ラウンド続けて must-fix / should-fix が収束しない場合は停止し、残指摘とともにユーザーへ報告する

## 注意

- 実行時間は diff 規模により数分〜十数分。並列実行して他の作業を続けてよい（read-only なので安全）
- 長時間ログ・結果 JSON が空のままなら `ps -o time= -p <pid>` で CPU 消費を確認し、ハング時は kill してプロンプトを分割・縮小して再実行
- findings の title・body が英語になる場合があるが許容する（要約時に日本語化）

## 出力スキーマ

`references/cross-review-schema.json` を参照（codex では `--output-schema` で強制、claude ではプロンプト指示で同形式を要求する）。codex `--output-schema` はトップレベル `anyOf` に非対応のため、verdict↔findings 整合のスキーマ強制は採用せず、単一 `object`（`verdict` は2値 enum、`findings[].severity` は3値 enum）のスキーマを維持する。verdict↔findings 整合はリーダーが結果 JSON 読み取り時に機械的に確認する（手順4参照）。
