---
name: team-impl
description: 計画ファイルを入力に Claude implementer teammate + クロスモデルレビューで実装を回す。設計済みタスクの実装フェーズで使う（Claude Code 専用）
argument-hint: <計画ファイルのパス> [タスクディレクトリ]
---

# team-impl: Claude 実装 + クロスモデルレビューのチーム実装

**Claude Code 専用**（dev-method-claude プラグインで配布。Codex には同名スキルの Codex 最適化版が dev-method-codex にある）。

$ARGUMENTS の1つ目が計画ファイル（通常 direction 置き場の `*.md`）、2つ目が任意のタスクディレクトリ（省略時はカレント checkout で作業。worktree でも可）。

実装は通常境界を `implementer`（Sonnet / medium）、高リスク境界を `implementer-high`（Opus / high）が teammate として直接行い、レビューは `cross-review` スキル（GPT-5.6 Sol / high・リーダー直叩き）で行う。実装・レビューとも中間ラッパー層を挟まない。

## 並列境界の解決

並列 spawn の単位を次の優先順で決める:

1. ルート CLAUDE.md / CLAUDE.local.md、または PaPut のプロジェクト指示（`paput_get_project_context` の instructions）に `並列境界:` の宣言があればその単位（モノレポでディレクトリ単位を宣言する場合は worktree 分離が前提）
2. なければ **git リポジトリ境界**単位

同一境界内のタスクは 1 implementer に直列で流す（同一 checkout での並列編集は衝突するため）。宣言が無く、計画の変更マップが同一リポジトリ内の複数サブシステム（BE / FE / インフラ等）にまたがる場合は、黙って直列化せず、境界候補（ディレクトリ単位＋worktree 分離）をユーザーに提案してから進める。宣言済みの複数境界が互いに独立なら、同一リポジトリ内でも worktree 分離で最初から並列に割り当てるのを既定とする（同一 checkout を理由に単一 implementer への直列割り当てへ畳まない）。直列で流す場合は境界間の依存を根拠として計画に明記する。

worktree 分離を使う場合、implementer を spawn する前に対象 worktree でパッケージマネージャの依存インストール手順を実行する。既存 checkout の `node_modules` を手動 symlink するだけでは、テストランナー等が worktree 外の設定ファイルを動的解決できず失敗することがある。

worktree並列では起動前に統合先checkoutと共通base commitを固定する。各implementerの完了後、リーダーが担当worktreeで担当pathだけを明示stageして境界checkpoint commitを作り、worktreeがcleanであることを確認する。全境界が揃ったら統合先へ計画の依存順で各commitを`git cherry-pick --no-commit`し、競合・欠落・担当外path混入があればレビューへ進まず担当へ戻す。統合先で各境界commitの変更pathと内容hashがすべて存在することを照合し、兄弟worktreeの差分を直接レビュー対象にしない。Evidence Packageは統合前のworktree記録を承認根拠に流用せず、統合先の全diffに対して全境界manifestをprepareし直し、exit 0 baselineと期待非ゼロexitの故意ずれをrecordし直してからverify・共同レビューへ進む。

## リーダー（あなた）の役割

タスク分割・割り当て・検証・レビュー起動・コミット・最終判断に徹し、実装は teammate に任せる。例外として、レビュー指摘のうち軽微なもの（数行の修正・文言・設定値）は差し戻しの往復より安いためリーダーが直接修正してよい。

完了条件: 最終報告がリーダーへ明示的に届くまで完了扱いにしない。状態通知・idle 通知・ターン終了は最終報告の代替にしない。

最終報告が無いまま idle 通知・ターン終了を検知したら、催促は1回だけ行う。それでも届かなければ diff と検証証跡を直接確認して工程を進め、逸脱として実測フッターに記録する。報告不達で工程を引き取る前に、担当へ停止指示を送り、fixtures・テストを含む対象パスの書込オーナーをリーダー単独へ移してから着手する（並行編集の衝突と生成物の相互削除を防ぐ）。

担当へのメッセージ送信・再開指示の前に、宛先を現行工程の稼働中担当一覧と照合する。完了・解散済み担当への送信・再開は再稼働として扱い、前工程の担当を意図せず再稼働させたことを検知したら直ちに停止指示を送り、対象パスの書込オーナーをリーダー単独へ移してから状態を回収する（誤配送された報告への返信も同じ照合を通す）。

## プレレビュー（Show）

Show ではプレレビューだけを単独起動し、cross-review と diff 指紋の共同ラウンドは行わない。

`reviewer` teammate は Agent tool で `subagent_type: "dev-method-claude:reviewer"`（model fable / effort high、`tools` で read-only 制限済み）を指定する。spawn prompt には `cross-review` の `references/review-prompt.md` の観点ブロック・変更範囲・検証証跡を渡し、`{{DIFF_FINGERPRINT}}` は `diff指紋: 対象外（Show）` へ置換する。「diff指紋: 対象外（Show）」が渡された場合は最終報告へそのまま返す。確信度の高い指摘だけを重大度順で求める。

Show のプレレビューは1回で終了する（反復しない）。**must-fix だけ**を即対応し（軽微なら直接修正、それ以外は実装担当へ差し戻す）、should-fix / nit は蓄積して follow-up 1バッチへ回す。

## 共同レビュー（プレレビュー + cross-review）

implementer の完了報告を受けたら共同レビューへ進む。

### Sign（pre + cross 各1回・Evidence/ledger なし）

Sign では pre（プレレビュー）と cross（cross-review）を同じ開始時 diff 指紋へ各1回だけ起動し、統合裁定のうえ **must-fix を1バッチで修正**して機械ゲート green で出荷する（**修正後の再レビューはしない**。受け皿は機械ゲートと friction ループ）。Evidence Package・review-ledger・収束ループ・作業単位入力（canonical review-dir / tooling manifest / review_unit_id）は使わない。cross のログ機械判定（read-only 監査＝`references/check-review-log.mjs` による denylist 照合）と、検知器変更時の故意ずれ検体の実行検証は維持する。両結果は下記「共同レビュー」節の統合・裁定に従い、should-fix / nit は蓄積して follow-up 1バッチへ回す。

### Seal の作業単位と起動前ゲート

Evidence共有契約: Sealでは canonical review-dir の絶対パス、tooling manifestの`format_version`・`review_unit_id`・固定diff指紋実装、全境界Evidence Packageを全worktree・全ラウンドで共有する。direction承認hashは固定checkerが`状態:`・`実測:`の各1行だけを除外して作る規範本文hashとし、この2行へ規範情報を書かない。完了条件のexit 0 baselineと、`--mutation`名・期待非ゼロexitを持つ故意ずれは固定checkerのrecordだけから各1件以上記録する。合意前計画レビューは更新後全文を全指摘ゼロまで再読、コード共同レビューR2以降は同じsession/threadを継続する。旧review unitの証跡・承認は転記せず、実測footerはplan/code/E2E/ledger/Evidence準備/4分類の固定文法を使う

Seal の共同レビューでは、direction から引き継いだ canonical review-dir の絶対パス、その配下の `tooling-manifest.json` の絶対パスと内容 SHA-256、固定 `review_unit_id` を作業単位入力とする。リーダーはこの組を全 worktree・全ラウンドへそのまま渡し、worker ごとに tooling をコピー・再生成したり `review_unit_id` を作り直したりしない。複数の `.work/` から最新・先頭を選ばず、`dev-method-claude` / `dev-method-codex` の兄弟プラグインやキャッシュ位置も推測しない。

R1 を含む各共同ラウンドの起動直前に、`tooling-manifest.json` の絶対パスから固定 checker・schema・diff 指紋実装を解決し、manifest 記録値とのパス・内容 SHA-256 と `review_unit_id` を再照合する。続けて `node <tooling-manifestのchecker絶対パス> verify --review-dir <canonical review-dir絶対パス> --direction <現行direction絶対パス> --manifest <境界manifest絶対パス> [--manifest ...]` を、全境界manifestを列挙して実行する。tooling manifest 欠落・固定コピーの欠落または hash 不一致・package manifest 欠落・stale 契約・実 diff の未対応・未復元の故意ずれ・未解決の automated 契約、または verify JSON の diff 指紋と固定 diff 指紋実装で計算した現行指紋の不一致は、reviewer の spawn と cross-review CLI の起動より前に fail-closed で停止する。source checker や worktree 個別コピーで代替せず、修復または stale 契約の再検証を担当 implementer へ戻す。

verify が exit 0 のときだけ、verify JSON の全境界manifest絶対パスと内容 SHA-256、`review_unit_id`、direction 本文 SHA-256、現行 diff 指紋、およびmanifestから抽出したreview-required一覧をそのラウンドの固定入力にする。tooling manifest の絶対パス・内容 SHA-256も含め、プレレビューと cross-review の両方へ同じ値を渡す。Evidence Package は探索索引であって免責範囲ではないため、両者に diff 全体と必要な周辺コードを読み、契約漏れ・証拠の識別力・観測点の迂回・未モデル化リスクを確認させる。package 記載外を確認不要とは指示しない。

このゲートは team-impl が Seal の共同レビューとして呼ぶ経路だけに適用する。Show のプレレビューと、セカンドオピニオンとして単独起動する cross-review に Seal 専用の tooling manifest / Evidence Package を要求しない。

provider の起動は初回を含め最大2試行とする。`400 model not supported` のときだけ同じ外部 CLI でモデル指定を外す既存経路へ進み、429・5xx・quota・unavailable のときだけ起動環境が列挙できる同じ外部モデルファミリーの別の利用可能な最上位モデルへ切り替える。これらは排他的に扱い、同じ失敗条件を反復しない。救出結果から全必須fieldを持つ正規化JSONを作り、schema・verdict/findings整合・diff指紋を検証できた場合だけproviderを再実行せず、それ未満は試行失敗として扱う。2試行目も失敗した、または適格な代替がない場合は fail-closed で停止する。ユーザーが単独レビューの継続を明示許可した場合だけ標準 code ledger を実行せず、承認発言・省略対象・理由を逸脱記録と非canonical footerへ残してパーサ警告を維持する。この縮退は作業継続を妨げないが、同一版二者承認・ledger eligible・dogfood適格を満たしたとは記録しない。

### ラウンド帳簿とセッション継続

R1 はプレレビュー・cross-review ともタスクごとの新規独立 session/thread で起動する。各promptは固定checkerの`ledger-prompt`、固定`review-ledger-schema.json`へ正規化した各resultは`ledger-result`で記録し、prompt/resultイベントJSONLを手書きしない。checkerへphase・reviewer・round・session ID・ファイル絶対パスを渡し、`review_unit_id`、規範本文hash、diff指紋、内容hash、結果本文の指摘配列とverdictを導出させる。旧 review unit の prompt・結果・イベント・review-required 判断を、同じ diff 指紋であっても新しい review-dir へ転記しない。

R2 以降のプレレビューは R1 と同じ reviewer teammate への追加指示、cross-review は R1 と同じ provider session/thread の resume を使う。再開 prompt には新しい diff 指紋、前回 findings、対応内容、変更ファイル、更新された Evidence Package と上記の作業単位入力をすべて渡し、read-only の tools 制約を再指定するか、継承された制約をログから確認する。session/thread ID を取得できない、resume に失敗する、または read-only 制約を確認できない場合は、その reviewer の旧承認を失効させて新規 session/thread を起動し、新規起動イベントと理由を含む逸脱記録の両方を残す。別 session へ黙って切り替えず、片方の旧承認も流用しない。

両レビュー結果を受領した直後に `node <tooling-manifestのchecker絶対パス> review-ledger --phase code --round <N> --review-dir <canonical review-dir絶対パス> --direction <現行direction絶対パス> --events <canonical review-dir/evidence/review-events.jsonl絶対パス> --execution-point results-received`を実行する。`before-completion`は共同レビュー収束時には実行せず、統合後全量検証と最終smokeの後、コミット直前に同じ最新roundを指定して1回だけ実行する。各実行はcheckerが検査前に試行イベントを先書きし、帳簿検証を完了したexit 0/2/3へpassed、構造異常のexit 1へfailedイベントを対応付け、passedの結果受領checkpointだけを全result roundと1対1照合する。exit 1 は帳簿異常なので指摘反映・次ラウンド判断・完了判定のすべてを拒否する。exit 2 は帳簿が整合した反復継続であり、全指摘を1バッチで反映する。exit 3 は backstop 到達であり、ledger detailsを正本として停止する。両者が現行指紋へ `approve`、must-fix / should-fix がゼロ、read-only 逸脱ゼロのexit 0だけが完了判定を許し、codeの最終exit 0は`review-unit-complete.json`を作る。

code ledger では各返却の `approve` を must-fix / should-fix ゼロ、`needs-attention` を1件以上の場合だけ許す。片方の `needs-attention`、または最終承認後だけ現行 diff が変わった `stale_approved_diff` は exit 2 とする。actionable findings を持つラウンドだけを `rework_count` に数え、3回到達時は `next_rework=4` で継続可、4回目の差し戻しまたは5ラウンド未収束は exit 3 とする。approve と指摘の併存、needs-attention と指摘ゼロ、verdict の欠落・文法外値、同一ラウンド内の指紋不整合、reviewer 結果イベント自体の欠落、作業単位・direction hash・session/thread・新規起動イベント・逸脱記録・read-only 監査の不整合は exit 1 とし、既知の exit 2 以外を次ラウンドへ流さない。

共同ラウンドは、先に `cross-review` の手順1〜2だけを実行して作業ディレクトリ・helper・開始時 diff 指紋を準備し、次に reviewer を spawn し、その起動後に完了を待たず `cross-review` の手順3以降を開始する。契約追補がある場合は、その配布と担当の反映完了確認を開始時 diff 指紋の固定より前に終え、指紋固定からレビュー起動までの間に diff を変える指示を出さない（追補反映で指紋が失効するとラウンド1回分の起動を浪費する）。

同じ開始時指紋に対して、`reviewer` teammate（Agent tool で `subagent_type: "dev-method-claude:reviewer"`。model fable / effort high、`tools` で read-only 制限済み）をバックグラウンド spawn し、その完了を待つ前に `cross-review` をバックグラウンド起動する。reviewer は implementer / implementer-high とは別の read-only 専用 teammate で、レビュー結果は SendMessage で明示配送させる。

両レビューには同じ開始時 diff 指紋・計画ファイル・対象範囲・implementer の検証証跡（実行コマンド・exit code・pass/fail 件数）・重点観点を渡す。Seal ではさらに、起動前ゲートで固定した tooling manifest と全境界manifestの絶対パス・内容 SHA-256、`review_unit_id`、review-required 一覧、direction 本文 SHA-256 も同一値で渡す。spawn prompt の基本観点は `cross-review` の `references/review-prompt.md` の観点ブロックと揃え、確信度の高い指摘のみを重大度順で求める。reviewer はテストを実行しない静的レビュー専任で、テスト不足・空通しの観点は証跡とテストコードの照合で判定させる。reviewer の最終報告には開始時 diff 指紋を64桁小文字16進でそのまま返させる。

実行可能な検知器（テスト基盤・検証スクリプト・パーサ・品質ゲート）の変更では、direction の検証設計に列挙された故意ずれ検体と implementer の実行証跡を両レビューの起動指示へ含め、各失敗クラスが false green にならないか照合する。実行証跡が無い失敗クラスは should-fix とし、reviewer の権限を広げず implementer へ実行を差し戻す。共同ラウンド開始前に検体ファイル一式が作業ツリーに残っていることを確認し、欠けている検体は implementer へ再生成を差し戻す（異ベンダーの独立実行検証は残存する検体で再現できることが前提）。

片方の結果だけで修正を始めず、両結果が揃うまで待つ。結果受領後、プレレビューの返却指紋、cross-review JSON の `diff_fingerprint`、固定 helper を再実行した現行 diff 指紋を開始時指紋と照合する。Seal では両結果受領イベントの `review_unit_id`・direction 本文 SHA-256・tooling manifest と全境界manifestの絶対パス・内容 SHA-256 も起動時入力と照合する。Seal でいずれかが不一致なら結果を承認・指摘処理に使わず、code ledger の exit 1 として次ラウンド判断も停止し、変更者・変更理由と帳簿を確認する。standalone では従来どおり現行差分からラウンドをやり直す。

指摘の処理: 両結果を失敗シナリオ／根本原因単位へ正規化し、重複・プレ固有・cross固有・相反に分類してから採否を裁定する。相反や棄却判断に迷う場合は既存の advisor／fail-closed の経路を使う。両結果が揃う前に diff を変更せず、採用した must-fix / should-fix は一つの修正バッチにまとめ、軽微はリーダー直修正、それ以外は implementer へ差し戻す。修正後は以前の両承認を失効させ、更新後の同じ diff 指紋へ両レビューを再起動する。

共同ラウンドの完了条件は、同じ開始時 diff 指紋を返した両レビューで must-fix / should-fix がゼロであり、結果受領時の現行 diff 指紋も一致すること。品質優先のためラウンド数の上限は設けない。

R2 以降は例外なく、前回指摘への対応と前回指紋からの変更による新規混入だけをレビュー対象にする。判定に必要な呼び出し元・既存ガード等の周辺コンテキストは読めるが、変更されていない全体 diff から新規指摘を探索しない。

nit はループの終了条件にせず、各ラウンドで検出された nit は修正を求めず蓄積して、ループ終了時に最終報告へ一括で列挙する（採否は完了後にユーザーが判断する。数行で直せる nit をリーダーがその場で直すことは妨げないが、nit のためだけに追加ラウンドを起動しない）。

通常の共同ラウンド数に品質上限は設けない。暴走防止バックストップは code ledger の exit 3 だけを正本とし、4回目の差し戻しまたは5ラウンド未収束で停止する。round 数を差し戻し数と混同せず、未解決指摘と ledger details を添えてユーザーへ報告する。

## 報告様式

リーダーの報告・帳簿づけはチーム実装の生成コストの主要部分（実測で実働の3〜4割）。判断に使われない詳細は報告に書かず、direction・コミット・差し戻しメッセージに残す:

- **中間報告は差分のみ**: 直前の報告から変わった事実だけを数行で書き、既報や全体状況の再掲をしない。状態が変わらない通知（implementer の待機通知・レビュー進行の生存確認）への応答は1行でよい
- **指摘の本文は差し戻しメッセージにだけ書く**: ユーザー向け報告は件数・重大度・処理先（差し戻し/直修正/棄却）のみ。同じ指摘を報告と差し戻しの両方に書かない
- **最終報告は要点のみ**: 変更一覧はコミット1件につき1行、検証結果は green/red と件数、レビューは収束経過1行（例: R1 must4+should2 → R2 must2 → R3 ゼロ）、実測フッター1行。ループ中に蓄積した nit は一覧で1回だけ列挙し（採否はここでユーザーが判断）、各ラウンドの報告で繰り返さない。全体でおおむね15行以内に収め、詳細は direction の完了記載に転記する

## 手順

1. 計画ファイルを読み、**並列境界別実装ブリーフ**（契約=確定値／変更マップ=触るファイルと模倣パターンの名指し／完了条件とやらないこと）が揃っているか確認する。欠けている境界があれば `direction` スキルの基準で計画側を補完してから着手する
2. 実装タスクに分割して共有タスクリスト（TaskCreate）に登録し、担当プロファイルを決める。DB migration・並行処理・認可・セキュリティ・境界間契約を高リスク基準とする。高リスク role は、高リスク基準に触れる契約・ファイル・完了条件を最小の高リスク編集面へ分けて局所割り当てし、基準に触れない編集面は `implementer` へ割り当てる。その理由だけで同じリポジトリ境界の通常変更へ伝播させない。通常ブリーフと編集面が独立なら worktree で並列にし、同一ファイルまたは同一不変条件へ不可分に混在するときだけブリーフ全体を `implementer-high` とする。単に変更量が多いだけでは high に上げない
3. 決定した agent type の teammate を spawn する。ブリーフが揃っていれば**並列境界単位で最初から並列 spawn** する。spawn prompt には計画ファイルの絶対パス・対象リポジトリ（境界）・担当タスク一覧・完了条件を必ず含める（teammate はこの会話の履歴を引き継がない）。終了前に最終報告を SendMessage でリーダーへ明示送信することも指示する。大きなフェーズは「追加系→削除系」のように**中間状態でもテストが通る単位**に分けて順に渡す
4. 実装中に仕様追補が出たら、**境界間の契約を壊すもの（契約バグ）だけ即時に implementer へ反映**する。それ以外は direction に追補として記録し、実装完了後にフォローアップ1バッチでまとめて回す（実装中の都度反映は手戻りが最も高くつく）
5. worktree分離時は全境界の完了報告を待ち、境界checkpointを統合先へ取り込んでEvidenceを正式生成・verifyした後、統合先の全diffへ**共同レビュー**を1回起動する。独立git repository境界だけは、他境界の実装と並行して境界単位にレビューしてよい。direction に追補があれば追補箇所を**重点観点として必ず渡す**。ブリーフに無い検証観点を思いついたときも、リーダーが自分で検証せず重点観点に足す
6. レビュー実行中に並行して、リーダーが検証する: 完了報告の検証証跡（実行コマンド・exit code・pass/fail 件数）と diff の目視確認のみ行い、**完了条件コマンドの再実行はしない**。再実行は証跡が欠落している、または証跡と diff が矛盾する場合の抜き取り1回に限る。リーダー自身による追加の検証・補正の直列作業はしない（軽微の範囲を超える修正は implementer へ差し戻す）
7. 両結果を揃えて指紋を照合し、**共同レビュー**節に従って根本原因単位で統合・裁定する。採用した must-fix / should-fix を一つの修正バッチで処理し、修正後は同じ更新版へ両レビューを再起動する。共同ラウンドの完了条件を満たすまでレビュー→修正を繰り返す
8. レビュー収束後、コミット前に統合先で担当 implementer へ全量の完了条件コマンドを1回通し直させ、Evidenceのbaseline・故意ずれをrecordし直してverifyする。Seal の smoke は、既存シナリオまたは共同レビュー開始前から同じ diff に含めた軽微な変種だけを使い、レビュー後に scenario・helper・assertion を編集しない。リーダーが1回実行し、新規実装が必要なら`未整備`として別follow-upへ分ける。smoke後に`git status`、固定checker verify、code ledger `before-completion`をこの順で実行し、diff変化・stale Evidence・帳簿不整合をfail-closedにする。失敗対応で追跡済みまたは非ignore未追跡diffが変われば共同レビューへ戻る。最終exit 0と`review-unit-complete.json`を確認してからリーダーがコミットする。ステージングは変更対象パスの明示指定で行い、`git add -A` / `git add .` を使わない
9. 全タスク完了後、変更一覧・検証結果・レビュー指摘の処理結果を**報告様式**に従って要点のみで報告する。報告に実測フッターを1行含める（数値は概算でよい。direction がある場合はその完了記載にも転記する）:

   `実測: レーンSeal / 担当<model/effort> / レビュー計画1R・21分（R1 must0+should0+nit0） / レビューコード1R・23分（R1 pre must0+should0；cross must0+should0；固有 pre0+cross0；重複0） / ledger plan 結果受領1/1・合意直前1/1・stale0・eligible=true / ledger code 両結果受領1/1・完了直前1/1・stale0・eligible=true / R1 plan approved / R1 code approved / E2E 44分 / 実働30分（手法運用8分） / Evidence Package 準備2分（開始10:00・終了10:02；テスト5分） / 4分類 plan-escape0+implementation-deviation0+evidence-gap0+new-risk0 / 差し戻し0 / リーダー直修正0 / 追補0（契約0） / smoke 対象外 / 逸脱: なし`

   フッターの表記ゆれは次の固定形だけを許容する（method-stats が受理する範囲。これ以外の即興表記は文法外警告で集計から落ちる）: 実施しなかったレビュー工程は理由必須の `0R（理由）`（分値は省略または `0分`）と記載し、対応する outcome は省略または `対象外` とする。計画レビューのラウンド別内訳は R2 から宣言ラウンドまでの連番で併記できる。複数境界のコードレビューは `N境界×各MR・X分（<境界名> R1 … ／ …）` の境界別内訳で記載する。分値の `約` 接頭と ledger・outcome への括弧注記を許容し、outcome の中黒注記は `needs-attention` に限る。

   計画レビューとコード共同レビューは各ラウンドの開始から結果集約までの工程別壁時計を別々に記録し、`E2E`にはその合計を記録する。計画/コードのラウンド数、R1の区分別件数、pre/cross固有・重複、plan/code ledgerの必須2実行点・stale・eligible、plan/code R1 outcome、Evidence Package準備時間（開始・終了・内数のテスト時間）、レビュー指摘の4分類を固定順で持つ。固有／重複は must-fix / should-fix だけを根本原因単位で数え、nit は含めない。smoke は direction 検証設計の定型観点で要否を決めているため、完了報告の時点でテンプレートのいずれかの値に確定させる（評価不能の定義は direction の実測フッター規定に準じる）。実働欄は direction 完了時に session-metrics の実測で記載する（報告時は省略してよい）。

## 完了条件

対象リポジトリの CLAUDE.md / AGENTS.md に記載された検証コマンド（「実装完了条件」等。計画ファイルに完了条件があればそれを優先）を implementer が通し、検証証跡（実行コマンド・exit code・pass/fail 件数）を完了報告に含め、リーダーが証跡を確認していること。**検証実行は implementer の1回を正とし、リーダー・レビュアーは再実行しない**（差し戻し修正後の再検証も implementer が行う。例外は検知器変更時の異ベンダー独立実行検証のみ）。通っていない完了報告・証跡の無い完了報告は差し戻す。計画・リポジトリのどちらにも検証コマンドが無ければ、リーダーが変更内容に応じた検証コマンド（テスト・ビルド・lint 等）を決めて spawn prompt の完了条件に含める。
