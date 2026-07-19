---
name: cross-review
description: 未コミット diff を実行中のクライアントとは別のモデル CLI にレビューさせるクロスモデルレビュー。実装完了時のセカンドオピニオンや team-impl のレビュー工程で使う
argument-hint: <対象リポジトリの絶対パス> [計画ファイルのパス] [重点観点]
---

# cross-review: 別モデル CLI によるクロスモデル diff レビュー

$ARGUMENTS の1つ目が対象リポジトリの絶対パス。2つ目以降は任意で、計画ファイルのパス（設計逸脱の照合に使う）と重点観点。

レビュアーは**実行中のクライアントとは別のモデル CLI** を選ぶ:

- Claude Code 上で実行中 → `codex exec --cd <対象リポジトリ> --sandbox read-only -m gpt-5.6-sol -c 'model_reasoning_effort="high"' --output-schema <スキーマファイル> -o <結果JSON> --json "<プロンプト>"`（`-m` 指定モデルが 400 model not supported になるアカウントでは `-m` を外して既定モデルで再実行する。`--json` はイベントログを stdout に出すためで、逸脱検知に使う）
- Codex 上で実行中 → `cd <対象リポジトリ> && claude -p "<プロンプト>" --model fable --effort high --allowedTools "Read,Grep,Glob,Bash(git diff:*),Bash(git status:*),Bash(git log:*)" --output-format stream-json --verbose`（スキーマ強制フラグが無いため、末尾「出力スキーマ」に適合する JSON のみを出力するようプロンプトで指示する。stdout はイベントログになり、結果 JSON は check-review-log.mjs が抽出する。`stream-json` は `--verbose` を要求する）

レビュアーはレビューだけを行い、コードは修正しない（codex は read-only sandbox で強制。claude は allowedTools がグローバル settings の許可ルールと合成されるため強制は不完全で、プロンプトの明文化と手順4のログ機械判定で担保する）。レビュアーを teammate として挟まず、リーダーが直接 CLI を起動する2層構成。

呼び出し元（team-impl 等）が cross-review 起動前に同ファミリー最上位モデルによるプレレビューを行う場合の手順は、呼び出し元のスキル（`team-impl` のプレレビュー節）を参照する。cross-review 自体は異ベンダーによる diff レビューの実行にのみ責務を持つ。

## 手順

1. 対象リポジトリで `git status --short` と `git diff --stat HEAD` を確認し、レビュー対象の diff があることを確かめる（対象が無ければここで終了）
2. 出力先を決める: 作業ディレクトリ `<対象リポジトリ>/.work/<作業名>/` を作り、本スキルの生成物はすべてこの配下に置く（`.work/` 直下への平置きはしない — 複数の作業のラウンドファイルが混ざり判別不能になる）。作業名は、計画ファイルがあればその basename から拡張子を除いたもの、なければ `YYYY-MM-DD-<テーマの slug>`。同一作業の再レビューは同じディレクトリを使い続ける（起動前に既存の `.work/` 配下へ同一作業のディレクトリが無いか確認し、あればそれを使う）。作業ディレクトリを決めた後、`.work/` 配下で**現在の作業のディレクトリを除き**、エントリ配下ファイルの最新更新時刻が30日を超えたものを削除する（保持期間による自動掃除。`.work/` は使い捨ての作業領域で、収束済みレビューのログ・検体は保持期間を過ぎたら不要になる。残したい成果物 — 未処理の起票文面等 — は `.work/` の外へ移しておく）。以下のファイルを置く: 結果 JSON `<作業ディレクトリ>/cross-review-<N>.json`・イベントログ `<作業ディレクトリ>/cross-review-<N>.log`（N は作業内の連番。イベントログは codex の `--json` / claude の `--output-format stream-json` の出力そのものであり、逸脱検知の実行ログを兼ねる）。スキーマファイル `<作業ディレクトリ>/cross-review-schema.json` を本スキルの `references/cross-review-schema.json` から、判定スクリプト `<作業ディレクトリ>/check-review-log.mjs` を本スキルの `references/check-review-log.mjs` から、それぞれ `cp` して作成する（既存でも毎回上書きし、スキル改訂後に旧バージョンが渡り続けるのを防ぐ）。パスはすべて**絶対パス**で書く（バックグラウンド実行の cwd に依存すると出力が迷子になる）。`.work/` が ignore されていなければ `<対象リポジトリ>/.git/info/exclude` に `.work/` を追記する（共有リポジトリの .gitignore は変更しない）
3. **バックグラウンド実行**で上記コマンドを起動する。read-only のレビュアーはファイルを書けないため、結果はリーダー側で受け取る: codex・claude とも stdout がイベントログになるので `<コマンド> < /dev/null > <イベントログ> 2>&1`（stderr が混ざっても check-review-log.mjs が JSON でない行をスキップするため問題ない）。結果 JSON は codex が `-o` で直接書き、claude は次段の check-review-log.mjs がイベントログから抽出する（stdin を閉じないと codex exec が「Reading additional input from stdin...」で入力待ちのままハングする）。シェルの `&` だけで起動すると、ツール呼出しの終了と同時に子プロセスごと終了して出力0バイトになる環境がある。ツール呼出し終了後もプロセスが継続する非同期実行機構（例: 実行環境のバックグラウンド実行機能）を使う。プロンプトはシェル引数へ直書きしない: バッククォート・`$`・リダイレクト記号を含むとシェルが解釈して parse error や意図しない実行になる。プロンプトを `<作業ディレクトリ>/cross-review-prompt-<N>.md` に書き、`"$(cat <プロンプトファイル>)"` で渡す

   プロンプトは本スキルの `references/review-prompt.md` の「## 観点」見出し以降をコピーし（冒頭の使用説明は含めない）、差し込み枠（`{{DIFF_RANGE}}` `{{PLAN_PATH}}` `{{FOCUS}}` `{{EVIDENCE}}` `{{PREV_FINDINGS}}`）だけを埋めて使う。観点の取捨選択・再構成をしない。条件付きブロック（高リスク観点・検知器変更時の検体照合・計画追補の照合）はテンプレのまま残し、削らずに渡す（条件成立の判定はレビュアー側が行う）。観点ブロックのみを流用する他スキル向けの規定（出力形式を含めない等）はテンプレ冒頭の使用説明を正本とする
4. 完了通知が来たら以下の順で処理する:
   - **ログ機械判定**: `node <作業ディレクトリ>/check-review-log.mjs <イベントログ> <pattern> [<結果JSON>]` を実行する。`allowedTools` はグローバル settings の許可ルールと合成されるため sandbox として機能せず（実測: 指定外でも settings 側で許可済みの閲覧系コマンドや、許可コマンドに続くパイプは実行される）、判定は claude / codex 両モード共通で**検証コマンド denylist 方式**に統一する:
     - `<pattern>` は検証・変更系コマンドの denylist、例 `'^(go\s+(test|build|vet)|npm\s+(run|test|ci|install|exec)|yarn(\s+(test|build|run|install))?|pnpm\s+(test|build|run|install)|make(\s|$)|cargo\s+(test|build|run|check)|pytest\b|tsc\b|jest\b|vitest\b|eslint\b|prettier\b|rubocop\b|mvn\b|gradle\b|dotnet\s+(test|build)|rustc\b|python3?\s+-m\s+(pytest|unittest)|bundle\s+exec|rake\b|tox\b)'`。サブコマンド（複合コマンドを分割した後の単位）の**先頭**に一致するコマンドの実行だけを違反とする（`^` アンカー。`rg 'go test' src/` のような引数・クォート内文字列への誤ヒットを防ぐ）。denylist に一致しない非 git コマンド（閲覧系。ls/cat/stat/find/wc 等）は claude・codex どちらのモードでも `otherCommands` の info 列挙に留め、逸脱にしない（グローバル許可環境で毎回発生し得る正常挙動を偽 friction 化しないため）。claude モードのみ第3引数（結果JSON出力先）を渡す。codex モードは `-o` が既に結果 JSON を書いているので渡さない
     - 複合コマンド（`git diff HEAD && go test ./...` 等）は `;` `&&` `||` `|` で分割してからサブコマンド単位で照合する（check-review-log.mjs 側で自動処理、手順側で分割する必要はない）。分割はクォート（シングル/ダブル、`\"` エスケープ考慮）の外側だけで行い、`rg -n "wait_agent|custom_tool_call" src | head -5` のような引数・正規表現内の `|` は分割対象にしない。パイプ後段（`git log | head -5` 等）は read-only フィルタ（`head`/`tail`/`wc`/`grep`/`sort`/`awk`/`cut`/`uniq`/`sed`/`nl`/`jq`/`cat`/`tr`）なら許可し、それ以外（`xargs`/`sh`/`tee` 等の書込・実行系）は無条件で違反とする
     - exit 0 = 逸脱なし。exit 2 = 違反を検出（stdout の `violations` に列挙されたコマンド文字列を、denylist で検知した実行系コマンドの逸脱として実測フッターと friction ログに記録する。**ログに無い実行の自己申告は逸脱として記録しない**、ログが正）。exit 1 = ログ解釈不能（1回だけ再実行し、それでも解釈不能ならログを自由文として目視確認する）
     - `deniedAttempts`（allowedTools に拒否された試行。claude モードのみ）は正常動作であり、逸脱として記録しない。`otherCommands`（denylist に一致しない非 git コマンドの実行）も info 列挙のみで逸脱にしない
     - claude モードでは同時に結果 JSON が `<作業ディレクトリ>/cross-review-<N>.json` へ書き出される
   - **結果の読み取り**: 結果 JSON を読み、severity で must-fix / should-fix を機械的に抽出して要約を報告する。team-impl 中なら must-fix / should-fix を implementer への差し戻しに使う。JSON が壊れている・スキーマ不適合の場合（主に claude 側。check-review-log.mjs が結果 JSON を書き出せなかった場合を含む）は1回だけ再実行し、それでも不適合なら出力を自由文として読み取り、逸脱として実測フッターと friction ログに記録する。verdict と findings の severity の整合（approve なのに must-fix / should-fix を含む場合）をリーダーが機械的に確認し、不整合はスキーマ不適合と同じ扱いで同経路に流す（1回だけ再実行し、それでも解消しなければ出力を自由文として読み取り、逸脱として実測フッターと friction ログに記録する）
   - **採否の裁定**: 指摘の採否・棄却に迷う場合、Claude Code 上でセッションに advisor が設定されていれば advisor に相談してから決める。相談してもなお偽陽性と示せない指摘は棄却せず must-fix / should-fix のまま残す（fail-closed。不確実性は棄却の根拠にしない）
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
