---
name: cross-review
description: 未コミット diff を実行中のクライアントとは別のモデル CLI にレビューさせるクロスモデルレビュー。実装完了時のセカンドオピニオンや execution のレビュー工程で使う
argument-hint: <対象リポジトリの絶対パス> [計画ファイルのパス] [重点観点]
---

# cross-review: 別モデル CLI によるクロスモデル diff レビュー

$ARGUMENTS の1つ目が対象リポジトリの絶対パス。2つ目以降は任意で、計画ファイルのパス（設計逸脱の照合に使う）と重点観点。

レビュアーは**実行中のクライアントとは別のモデル CLI** を選ぶ:

- Claude Code 上で実行中 → `codex exec --cd <対象リポジトリ> --sandbox read-only -m gpt-5.6-sol -c 'model_reasoning_effort="high"' --output-schema <スキーマファイル> -o <結果JSON> --json "<プロンプト>"`（model 指定失敗時の経路は下記 provider 契約に従う。`--json` はイベントログを stdout に出すためで、逸脱検知に使う）
- Codex 上で実行中 → `cd <対象リポジトリ> && claude -p "<プロンプト>" --model opus --effort high --allowedTools "Read,Grep,Glob,Bash(git diff:*),Bash(git status:*),Bash(git log:*)" --output-format stream-json --verbose`（スキーマ強制フラグが無いため、末尾「出力スキーマ」に適合する JSON のみを出力するようプロンプトで指示する。stdout はイベントログになり、結果 JSON は check-review-log.mjs が抽出する。`stream-json` は `--verbose` を要求する）

provider の起動は初回を含め最大2試行とする。`400 model not supported` のときだけ同じ外部 CLI でモデル指定を外す既存経路へ進み、429・5xx・quota・unavailable のときだけ起動環境が列挙できる同じ外部モデルファミリーの別の利用可能な最上位モデルへ切り替える。これらは排他的に扱い、同じ失敗条件を反復しない。救出結果から全必須fieldを持つ正規化JSONを作り、schema・verdict/findings整合・diff指紋を検証できた場合だけproviderを再実行せず、それ未満は試行失敗として扱う。2試行目も失敗した、または適格な代替がない場合は fail-closed で停止して呼び出し元へ `provider_unavailable` と試行履歴を返す。standalone起動時だけユーザー判断を求める。

レビュアーはレビューだけを行い、コードは修正しない（codex は read-only sandbox で強制。claude は allowedTools がグローバル settings の許可ルールと合成されるため強制は不完全で、プロンプトの明文化と手順4のログ機械判定で担保する）。レビュアーを teammate として挟まず、リーダーが直接 CLI を起動する2層構成。

呼び出し元（execution 等）が役割別の固定モデルによるプレレビューも行う場合は、同じ diff 指紋へ両レビューを並列起動する共同ラウンドとして扱う。cross-review 自体は異ベンダーによる diff レビュー結果を1件返すところまでを責務とし、共同ラウンド中は単独で修正・再レビューのループを進めない。両結果の待機・照合・統合・再起動は呼び出し元のスキルを正本とする。

execution から Seal の共同レビューとして呼ばれる場合だけ、呼び出し元から canonical review-dir、`tooling-manifest.json` の絶対パスと内容 SHA-256、`review_unit_id`、固定 checker の verify を通過した全境界manifestの絶対パスと内容 SHA-256、review-required 一覧、direction 本文 SHA-256、開始時 diff 指紋を受け取る。これらを Seal 作業単位入力と呼ぶ。cross-review は受け取った絶対パスを使い、tooling をコピー・再生成せず、`review_unit_id` を作り直さず、兄弟プラグインやキャッシュ位置を推測しない。Seal 作業単位入力が欠けるか呼び出し元の起動前 checker 結果と一致しない場合は CLI を起動せず fail-closed で返す。

execution から Sign の共同レビューとして呼ばれる場合は、pre + cross を各1回だけ起動する軽量経路とする。Sign 作業単位入力（canonical review-dir / tooling manifest / review_unit_id / 全境界manifest）は要求せず、対象 diff・計画・重点観点・検証証跡だけで起動する。手順4のログ機械判定（read-only 監査）は Seal と同じく維持し、収束ループ・Evidence Package・ledger 連携は行わない（1回で返す）。

単独のセカンドオピニオンとして起動された場合は standalone とする。standalone では Seal 作業単位入力を要求せず、従来どおり対象 diff・任意の計画・重点観点・検証証跡だけで起動する。Seal 専用ゲートを standalone へ類推適用しない。

## 手順

1. 対象リポジトリで `git status --short` と `git diff --stat HEAD` を確認し、レビュー対象の diff があることを確かめる（対象が無ければここで終了）
2. 出力先を決める: Seal 共同レビューでは呼び出し元から渡された canonical review-dir をそのまま作業ディレクトリとし、standalone では `<対象リポジトリ>/.work/<作業名>/` を作業ディレクトリにする。standaloneの作業名は計画ファイルがあればbasename、なければ`YYYY-MM-DD-<テーマslug>`とする。本スキルの生成物はすべてこの配下に置き、同一作業の再レビューは同じディレクトリを使い続ける。作業ディレクトリを決めた後の30日超自動掃除は、**現在の作業を除き**、配下ファイルの最新mtimeが30日を超え、`review-unit-complete.json`が存在し、その`review_unit_id`が同ディレクトリのtooling manifestと一致し、`completed_at`が妥当なSeal作業だけを対象にする。marker欠落・不整合、standalone、revoked/abandonedだけで完了markerのない作業は、mtimeが古くても自動削除しない。以下のファイルを置く: 結果 JSON `<作業ディレクトリ>/cross-review-<N>.json`・イベントログ `<作業ディレクトリ>/cross-review-<N>.log`。スキーマファイル `<作業ディレクトリ>/cross-review-schema.json`、判定スクリプト `<作業ディレクトリ>/check-review-log.mjs` を本スキルの `references/` から毎回上書きコピーする。standalone では指紋 helper も毎回コピーし、Seal ではtooling manifestに固定されたコピーだけを使う。パスはすべて絶対パスで書き、`.work/`がignoreされていなければ`.git/info/exclude`へ追記する。固定helperで開始時diff指紋を作る: `node <作業ディレクトリ>/review-diff-fingerprint.mjs <対象リポジトリの絶対パス>`（リポジトリパスは必須引数。cwd からの推測はせず、引数なしは exit 1）。Sealでは呼び出し元の値と一致しなければ起動しない
3. **バックグラウンド実行**で上記コマンドを起動する。read-only のレビュアーはファイルを書けないため、結果はリーダー側で受け取る: codex・claude とも stdout がイベントログになるので `<コマンド> < /dev/null > <イベントログ> 2>&1`（stderr が混ざっても check-review-log.mjs が JSON でない行をスキップするため問題ない）。結果 JSON は codex が `-o` で直接書き、claude は次段の check-review-log.mjs がイベントログから抽出する（stdin を閉じないと codex exec が「Reading additional input from stdin...」で入力待ちのままハングする）。シェルの `&` だけで起動すると、ツール呼出しの終了と同時に子プロセスごと終了して出力0バイトになる環境がある。ツール呼出し終了後もプロセスが継続する非同期実行機構（例: 実行環境のバックグラウンド実行機能）を使う。プロンプトはシェル引数へ直書きしない: バッククォート・`$`・リダイレクト記号を含むとシェルが解釈して parse error や意図しない実行になる。プロンプトを `<作業ディレクトリ>/cross-review-prompt-<N>.md` に書き、`"$(cat <プロンプトファイル>)"` で渡す

   プロンプトは本スキルの `references/review-prompt.md` の「## 観点」見出し以降をコピーし（冒頭の使用説明は含めない）、差し込み枠（`{{DIFF_RANGE}}` `{{DIFF_FINGERPRINT}}` `{{PLAN_PATH}}` `{{FOCUS}}` `{{EVIDENCE}}` `{{REVIEW_CONTEXT}}` `{{PREV_FINDINGS}}`）だけを埋めて使う。`{{DIFF_FINGERPRINT}}` には手順2で固定した開始時 diff 指紋を入れる。Seal の `{{REVIEW_CONTEXT}}` には Seal 作業単位入力を全項目そのまま入れ、standalone では「standalone のため Seal 作業単位入力なし」と明記する。観点の取捨選択・再構成をしない。条件付きブロック（高リスク観点・検知器変更時の検体照合・計画追補の照合）はテンプレのまま残し、削らずに渡す（条件成立の判定はレビュアー側が行う）。観点ブロックのみを流用する他スキル向けの規定（出力形式を含めない等）はテンプレ冒頭の使用説明を正本とする

   Seal 共同レビューの R1 は必ず新規 session/thread で起動する。Claude Code 上から codex を使う経路は R1 イベントログの thread ID、Codex 上から claude を使う経路は R1 に `--session-id` で指定・記録した session ID を、結果 JSON と同じラウンド番号へ対応付けて保存する。さらに `review_unit_id` と direction 本文 SHA-256 を prompt イベント・結果受領イベントへ付ける。Seal 共同レビューの R2 以降は、codex 経路では `codex exec resume <R1のthread ID>`、claude 経路では `claude -p "<プロンプト>" --resume <R1のsession ID>` を使い、R1 と同じ session/thread を再開する。model / effort、codex の read-only sandbox・output schema・JSON event log・結果ファイル、claude の allowedTools・stream-json・verbose を再開時にも再指定するか、指定不能な項目はイベントログで継承を確認する

   Seal 共同レビューで session/thread ID が取得できない、resume が非ゼロ、または read-only 制約をログで確認できない場合、その session の旧承認を失効させて同じラウンドを新規 session/thread で起動する。新規起動イベントと理由・旧新 ID を持つ逸脱記録を両方 Evidence Package に残し、別 session へ黙って切り替えない。新規 session の結果だけを当該 reviewer の現行結果として扱い、旧承認は diff 指紋が同じでも流用しない
4. 完了通知が来たら以下の順で処理する:
   - **ログ機械判定**: `node <作業ディレクトリ>/check-review-log.mjs <イベントログ> <pattern> [<結果JSON>]` を実行する。`allowedTools` はグローバル settings の許可ルールと合成されるため sandbox として機能せず（実測: 指定外でも settings 側で許可済みの閲覧系コマンドや、許可コマンドに続くパイプは実行される）、判定は claude / codex 両モード共通で**検証コマンド denylist 方式**に統一する:
     - `<pattern>` は検証・変更系コマンドの denylist、例 `'^(go\s+(test|build|vet)|npm\s+(run|test|ci|install|exec)|yarn(\s+(test|build|run|install))?|pnpm\s+(test|build|run|install)|make(\s|$)|cargo\s+(test|build|run|check)|pytest\b|tsc\b|jest\b|vitest\b|eslint\b|prettier\b|rubocop\b|mvn\b|gradle\b|dotnet\s+(test|build)|rustc\b|python3?\s+-m\s+(pytest|unittest)|bundle\s+exec|rake\b|tox\b)'`。サブコマンド（複合コマンドを分割した後の単位）の**先頭**に一致するコマンドの実行だけを違反とする（`^` アンカー。`rg 'go test' src/` のような引数・クォート内文字列への誤ヒットを防ぐ）。denylist に一致しない非 git コマンド（閲覧系。ls/cat/stat/find/wc 等）は claude・codex どちらのモードでも `otherCommands` の info 列挙に留め、逸脱にしない（グローバル許可環境で毎回発生し得る正常挙動を偽 friction 化しないため）。claude モードのみ第3引数（結果JSON出力先）を渡す。codex モードは `-o` が既に結果 JSON を書いているので渡さない。**検知器変更のレビューに限り**、review-prompt の検体照合ブロックが許す実行だけに一致する許可パターンを `--allow '<regex>'` で渡す（例: `--allow '^node --input-type=module$'`。一致したサブコマンドは `allowedCommands` の info 列挙に留まり逸脱にならない）。それ以外のレビューでは `--allow` を渡さず、violation を手動裁定で免除せずそのまま逸脱として記録する
     - 複合コマンド（`git diff HEAD && go test ./...` 等）は `;` `&&` `||` `|` で分割してからサブコマンド単位で照合する（check-review-log.mjs 側で自動処理、手順側で分割する必要はない）。分割はクォート（シングル/ダブル、`\"` エスケープ考慮）の外側だけで行い、`rg -n "wait_agent|custom_tool_call" src | head -5` のような引数・正規表現内の `|` は分割対象にしない。パイプ後段（`git log | head -5` 等）・ループ本体・ラッパー内 payload は**閲覧系の許可リストを持たず実行系 denylist で判定する**: 実行・ビルド・テスト系（`node`/`sh`/`bash`/`python`/`go`/`npm`/`npx`/`make`/`cargo` 等）・変更系 git（`apply`/`commit`/`push`/`checkout`/`reset`/`stash` 等。閲覧系 git は許可）または上記 `<pattern>` に一致する head、書込リダイレクト（`>`/`>>`/`tee`。`/dev/null` 宛と fd 複製は除く）、in-place フラグ（`sed -i` 等）、コマンド置換（`$()`・バッククォート）内の実行系のいずれかを含むものだけを違反とし、どれにも当たらないサブコマンドは許可する（`shasum -a 256 …`・`find … | sort | tail | while read f; do sed -n …; done` のような正当な閲覧系を許可リスト漏れで誤検知しないため）。`sh -c` / `xargs … sh -c` は引用された内側コマンドを同じ規則で再解析し、`xargs <コマンド>` の直接実行形も同じ判定にかける。制御構文・前置形（for/do/done・case・`{ }`・`( )`・環境変数前置・`env`/`sudo`/`timeout` 等の実行系ラッパー）は実行位置を剥がして本体コマンドで判定し（剥がして得た本体＝ループ本体等は後段と同じ実行系 denylist で判定する。`xargs` はオプションを消費して実行 head を解決し、引数の有無を決められない未知オプションは fail-closed）、クォート外のコマンド置換は本体を再帰分類する（`do go test` や `echo "$(npm test)"` の素通りと `do sed …` の誤検知の両方を防ぐ）。クォートが不均衡で分割できないコマンドと、シェルラッパー形式（`/bin/zsh -lc` 等）なのに payload を取り出せないコマンドは、何が実行されたか検証できないため `unparseableCommands` として fail-closed で違反に含める（`--allow` にも一致させない）
     - exit 0 = 逸脱なし。exit 2 = 違反を検出（stdout の `violations` に列挙されたコマンド文字列を、denylist で検知した実行系コマンドまたは解析不能（`unparseableCommands`）の逸脱として実測フッターと friction ログに記録する。**ログに無い実行の自己申告は逸脱として記録しない**、ログが正）。exit 1 = ログ解釈不能（1回だけ再実行し、それでも解釈不能ならログを自由文として目視確認する）
     - `deniedAttempts`（allowedTools に拒否された試行。claude モードのみ）は正常動作であり、逸脱として記録しない。`otherCommands`（denylist に一致しない非 git コマンドの実行）も info 列挙のみで逸脱にしない
     - claude モードでは同時に結果 JSON が `<作業ディレクトリ>/cross-review-<N>.json` へ書き出される
   - **結果の読み取り**: 結果 JSON を読み、severity で must-fix / should-fix を機械的に抽出して要約を報告する。JSON が壊れている・スキーマ不適合の場合（主に claude 側。check-review-log.mjs が結果 JSON を書き出せなかった場合を含む）は、fenced JSON またはイベントログから全必須fieldを救出して正規化JSONを作り、schema・verdict/findings整合・diff指紋を検証する。すべてgreenな場合だけproviderを再実行せず、それ未満は上記のprovider契約に従う。verdict と findings の severity の整合（approve なのに must-fix / should-fix を含む場合）をリーダーが機械的に確認し、不整合はスキーマ不適合と同じ扱いで同経路に流す
   - **diff 指紋の照合**: 結果 JSON の `diff_fingerprint` が手順2の開始時 diff 指紋と同じことを確認し、さらに結果受領時に同じ固定 helper を再実行して現行 diff 指紋が開始時と同じことを確認する。Seal では結果受領イベントの `review_unit_id`・direction 本文 SHA-256・tooling manifest と全境界manifestの絶対パス・内容 SHA-256 も起動時入力と照合する。Seal で返却値・現行値・作業単位入力のいずれかが不一致なら、その結果を承認にも指摘処理にも使わず、帳簿異常として呼び出し元へ返す。standalone の指紋不一致は従来どおり変更者・変更理由を確認し、現行差分から新しい開始時指紋を固定して再ラウンドする
   - **採否の裁定**: 指摘の採否・棄却に迷う場合、Claude Code 上でセッションに advisor が設定されていれば advisor に相談してから決める。相談してもなお偽陽性と示せない指摘は棄却せず must-fix / should-fix のまま残す（fail-closed。不確実性は棄却の根拠にしない）
   - **完了待機の方法**: 完了確認は実行環境の完了通知かブロッキング待機を必須とし、短間隔（秒単位）の手動ポーリングを繰り返さない。どちらも使えない環境でのみ手動確認とし、初回確認は diff 規模から見積もった実行時間（数分〜十数分）の経過後、以後も数分間隔を守る。60秒未満の poll を繰り返した場合は逸脱として実測フッターに記録する
5. standalone 実行では、開始時／返却値／結果受領時の3点が同じ diff 指紋であることを前提に、**must-fix / should-fix がゼロになるまでレビューを繰り返す**。execution の共同ラウンドではここで単独ループせず、指紋照合済みの結果を呼び出し元へ返して両レビューの統合を待つ。standalone の順序は以下:
   - **終了判定**: 終了判定は結果 JSON の findings に must-fix / should-fix が無いことの機械判定で行う（収束が続く限りラウンド数自体に上限は設けない。非収束時の打ち切りは下記の停止条件が正本）。verdict が needs-attention なのに must-fix / should-fix がゼロの場合は fail-closed とし、summary を確認して再ラウンドする
   - **nit の扱い**: nit はループの終了条件にせず、各ラウンドで検出された nit は修正を求めず蓄積して、ループ終了時に最終報告へ一括で列挙する（採否は完了後にユーザーが判断する。数行で直せる nit をリーダーがその場で直すことは妨げないが、nit のためだけに追加ラウンドを起動しない）
   - **差分限定再レビュー**: must-fix / should-fix を修正したら再レビューを起動する
   - R2 以降は例外なく、前回指摘への対応と前回指紋からの変更による新規混入だけをレビュー対象にする。判定に必要な呼び出し元・既存ガード等の周辺コンテキストは読めるが、変更されていない全体 diff から新規指摘を探索しない。
   - プロンプトには前回指摘の一覧（前ラウンドの findings JSON をそのまま貼ってよい）・対応方針・前回指紋から変更したファイルを明示する。Claude Code 上では `/loop` で「レビュー→修正」のサイクルを回してよい
   - **停止条件**: 5ラウンド続けて must-fix / should-fix が収束しない場合は停止し、残指摘とともにユーザーへ報告する

## 注意

- 実行時間は diff 規模により数分〜十数分。並列実行して他の作業を続けてよい（read-only なので安全）
- 長時間ログ・結果 JSON が空のままなら `ps -o time= -p <pid>` で CPU 消費を確認し、ハング時は kill してプロンプトを分割・縮小して再実行
- findings の title・body が英語になる場合があるが許容する（要約時に日本語化）

## 出力スキーマ

`references/cross-review-schema.json` を参照（codex では `--output-schema` で強制、claude ではプロンプト指示で同形式を要求する）。codex `--output-schema` はトップレベル `anyOf` に非対応のため、verdict↔findings 整合のスキーマ強制は採用せず、単一 `object`（`verdict` は2値 enum、`findings[].severity` は3値 enum）のスキーマを維持する。verdict↔findings 整合はリーダーが結果 JSON 読み取り時に機械的に確認する（手順4参照）。
