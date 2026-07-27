---
name: direction
description: 大きな変更の実装計画を direction ドキュメントに起こし、合意→実装→完了記載までのライフサイクルを回す。新機能・機能改修の着手前、および実装完了時の状態更新に使う
argument-hint: <計画のテーマ・概要、または完了記載する direction ファイル>
---

# direction: 実装計画ドキュメントの作成・完了管理

## 置き場の解決

direction ファイルの置き場を次の優先順で決める:

1. プロジェクトのルート CLAUDE.md / CLAUDE.local.md に `direction 置き場:` の宣言があればそのパス
2. なければ `~/dev-notes/<プロジェクト名>/direction/`。プロジェクト名の導出:
   - `git rev-parse --show-toplevel` の basename
   - worktree の場合は `git worktree list` の先頭（main checkout）の basename に正規化する
   - git リポジトリでない場合はカレントディレクトリの basename
3. ディレクトリが無ければ作成する

対象プロジェクトのリポジトリには direction ファイルをコミットしない（参画プロジェクトを個人ドキュメントで汚さないため）。

## 実装レーン（適用判断）

実装・修正の依頼を受けたら、着手前にレーンを判定して1行宣言してから作業する。**この表がレーン判定の正本**（direction を起動しないタスクにも毎ターン効かせる常駐トリガーは、グローバル CLAUDE.md / AGENTS.md に要約を置く。README のセットアップ参照）。ユーザーがレーンを明示指定したら判定を省略する。迷ったら重い側のレーンに倒す。

**レーンは爆発半径だけで決める。direction の有無とは独立**（direction は設計合意の道具であり、書いても実装工程は重くならない。→「作成」節の起草基準）。**Show は原義（マージ後の事後レビュー）と異なり、ここでは「出荷前の1回レビュー」を指す**。

| レーン | 判定基準（爆発半径） | 工程 |
| --- | --- | --- |
| **Ship** | 挙動に触れない変更: typo・docs・コメント・ログ文言・依存 patch 更新・自明な設定値変更 | レビューなし。機械ゲート（lint / build / 該当テスト）のみで完了し、報告に `レーンShip` を明記する |
| **Show**（デフォルト） | 下位2レーンの基準に触れないすべて。direction の有無は無関係 | 実装 → 機械ゲート → プレレビュー**1回**（`execution` のプレレビュー節に従い、**must-fix のみ即対応**。should-fix / nit は蓄積して follow-up 1バッチ）→ 出荷。`cross-review` は使わず、省略した旨を報告に明記する。UI に見える挙動変更では、リポジトリroot・worktree root・モノレポ配下の scenario-kit 設定とシナリオを探索し、既存シナリオの有無にかかわらず既存または軽微な変種、なければ最小シナリオを準備して `scenario-kit smoke` を機械ゲートとして実走する。UI に見える変更を含まなければ smoke は `対象外` |
| **Sign** | 高リスク基準（DB migration・並行処理・認可・セキュリティ・境界間契約）に触れる変更、および実行可能な検知器（テスト基盤・検証スクリプト・パーサ・品質ゲート）の新設・変更 | 実装 → 機械ゲート（検知器タスクは実データ・実ログコーパス×不変式・品質指標のハーネスをここに置く）→ `execution` で pre + cross を同じ diff 指紋へ**各1回**起動 → 統合裁定 → **must-fix を1バッチ修正** → 機械ゲート green で出荷（**修正後の再レビューはしない**。受け皿は機械ゲートと friction ループ）。cross のログ機械判定（read-only 監査）と故意ずれ検体の実行検証は維持。**Evidence Package・ledger・収束ループは使わない** |
| **Seal** | **不可逆**（復旧不能なデータ変更・削除・公開後取り消し不能）**×外部影響**（公開 API・課金・第三者データ）が**重なる**変更のみ | 現行フルパイプ: `execution`（同じ diff 指紋へのプレレビュー + `cross-review` 共同ラウンドを二者承認まで反復）＋合意前計画レビュー・Evidence Package・ledger。個人開発では年数回が正常頻度 |

- 機械ゲートは1回 green で完結とする。green 後に同一検証を念のため再実行したり、レーン工程・計画に無い追加検証を足したりしない（モデル自身の自己検証と重なり、時間とトークンを浪費する）。
- 検知器の新設・変更は規模によらず Sign 以上。検知器自身の false green は静的レビューだけでは見抜きにくいため、機械的敵対者（実データ×不変式）を実装直後の機械ゲートに置き、異ベンダー側（cross）の独立した実行検証も Sign で省略しない。
- Show の完了報告には簡易実測フッターを1行付ける: `実測: レーンShow / レビュー1R（R1 must<N>+should<N>） / 実働<N>分（手法運用<N>分） / smoke <PASS|FAIL n件|評価不能|対象外> / 逸脱: <無ければ「なし」>`（各欄の意味と評価不能の定義は「完了」節の実測フッター規定に準じる）。UI変更では `未整備` を使わず、環境起因は `評価不能`、アプリ退行は `FAIL n件` と記録する。
- **実働欄（実働・手法運用）は direction を書いた Show 作業の完了記載で記載する**（必須実測＝決定5、レーン非依存）。session-metrics の実測が採用条件（`skippedLines`・`unknownEvents`・`orphanToolUses` が各1%未満、かつ検算値が非 null なら乖離 ≦10%。検算は Claude / Codex とも turn 窓限定の `turnWindowActiveMs` 対 `turnWindowCheckMs`（Claude は内部プロンプトを含む窓と計上済み窓に重なる窓を除いた clean 窓、Codex は `duration_ms` を持って閉じた turn 窓。対象窓が無いログは検算不能））を満たすときのみ記載し、不成立の Show と direction を書かなかった Show では省略する（欠測）。実働欄はレーン不問で `method-stats` が集計する（Show / Sign / Seal 共通）。
- 実装中に爆発半径が上位レーンの基準（高リスク・検知器・不可逆×外部影響）に触れると判明したら、その時点で上位レーンへ昇格する。付随ファイル（テスト・翻訳・Storybook 等）も差分見積もりに含める。
- Ship / Show で出した変更に後日バグが発覚したら `~/dev-notes/dev-method/friction.md` へ1行記録し、レーン基準の調整材料にする（発生位置タグは `method-check` の friction 記録規定に従う）。

## 作成

0. PaPut MCP が利用可能でプロジェクトが登録済みなら、起草前に `paput_search_project_documents` で関連する過去の決定・却下案を検索し、整合を確認する（矛盾する・supersede する場合は本文でその文書番号に言及する）。必要な本文だけ `paput_get_project_document` で取得する。未登録・未接続ならスキップ。
1. 起草前に変更対象のコードを探索する（触る場所・模倣する既存パターン・波及範囲）。探索範囲が広い場合（複数サブシステム・波及 grep が多い）は、自分で読み進めず read-only の探索サブエージェント（Claude Code なら組み込み Explore。model は sonnet 指定で足りる）へ委譲してよい。委譲時は、変更マップ候補（触るファイルのパス一覧）・模倣する既存パターンの `ファイル:行`・削除/変更シンボルの呼び出し元 grep 結果の3点を、実装ブリーフへ転記できる形で返させる。探索サブエージェントの要約から契約・変更マップへ転記する値（正本ファイルのパス・モジュール形式・API 名・設定値等）は、転記前に実コードを開いて裏取りする — 要約の値をそのまま契約に書かない。起草中に浮上した未決事項は、実在する曖昧性（Material Ambiguity）かどうかで振り分ける: **スコープ・アーキテクチャや契約・検証方法・ロールアウト・データ処理・権限・ユーザーに見える挙動**のいずれかに影響する論点だけを会話で確定させる（探索を踏まえた選択肢＋推奨の形で提示する）。決定間に依存があるものは依存順に1問ずつ確定させ、相互に独立な決定だけを1回の提示にまとめる。確定値を「決定」に、非採用案を「却下した代替案」に記録する。それ以外は、既存コード・テスト・リポジトリの指示から答えが出る実装詳細を含め、質問せず即決する。**合意を求める時点で未決事項ゼロ**が起草の完成条件。
2. 命名: `<置き場>/YYYY-MM-DD-<slug>.md`。同日に複数作る場合は `YYYY-MM-DD-N-<slug>` の連番で時系列を明示する（同日の既存が無番なら連番付きへリネームして揃える）。
3. 冒頭: タイトル →`作成日:` → `状態:`（太字で現フェーズ。例 **方向性合意待ち** / **詳細設計確定（日付）**）→ 引用ブロックで親方針・先行 direction への相対リンクと本計画の位置づけ。
4. 本文構成: 背景・診断 → 決定（番号付き・要点太字）→ 却下した代替案（理由付き）→ 実装計画。本文はタスクに必要な実質だけで構成し、定型節・冗長な再掲サマリ・ボイラープレートで水増ししない（長さは網羅の証拠にならない）。
5. 実装計画は**並列境界別の実装ブリーフ**まで落とす。変更マップがモノレポ内の複数サブシステム（BE / FE / インフラ等）にまたがる場合は、`並列境界:` 宣言が無くても境界候補（ディレクトリ単位＋worktree 分離）を計画に明記してユーザーと合意する — 黙って1ブリーフに畳まない。implementer がこのブリーフ＋名指しファイル＋対象リポジトリの CLAUDE.md / AGENTS.md だけで着手できる状態が完成条件:
   - **Evidence Contract**: Seal の利用者または境界に見える契約は `##### EC-<境界略称>-<連番>: <契約名>` の安定IDを付け、`振る舞い`・`変更面`・`oracle`・`反証`・`証拠種別`・`証拠` の6つの固定ラベルを持たせる。証拠種別は契約ID単位で `automated` または `review-required` のどちらか一方だけを選ぶ。機械検証できる側面と人の判断が必要な側面は別IDへ分ける。`review-required` は括弧内へ `理由:` と `残余リスク:` を必ず書く。補助ファイルや内部実装詳細ごとにはIDを増やさず、既存の契約・oracle記述をIDで対応付ける
   - Evidence共有契約: Sealでは canonical review-dir の絶対パス、tooling manifestの`format_version`・`review_unit_id`・固定diff指紋実装、全境界Evidence Packageを全worktree・全ラウンドで共有する。direction承認hashは固定checkerが`状態:`・`実測:`の各1行だけを除外して作る規範本文hashとし、この2行へ規範情報を書かない。完了条件のexit 0 baselineと、`--mutation`名・期待非ゼロexitを持つ故意ずれは固定checkerのrecordだけから各1件以上記録する。合意前計画レビューは更新後全文を全指摘ゼロまで再読、コード共同レビューR2以降は同じsession/threadを継続する。旧review unitの証跡・承認は転記せず、実測footerはplan/code/E2E/ledger/Evidence準備/4分類の固定文法を使う
   - 高リスク role は、高リスク基準に触れる契約・ファイル・完了条件を最小の高リスク編集面へ分けて局所割り当てし、基準に触れない編集面は `implementer` へ割り当てる。その理由だけで同じリポジトリ境界の通常変更へ伝播させない。通常ブリーフと編集面が独立なら worktree で並列にし、同一ファイルまたは同一不変条件へ不可分に混在するときだけブリーフ全体を `implementer-critical` とする。
   - **契約**: API スキーマ・エラー挙動・上限値など、境界間にまたがる決定は確定値で書く。設定値・資源識別子を変更または設定化する場合は、許容範囲と正規化・項目間制約・複数の設定源が競合したときの優先順位を確定する。状態を書き換える機能では、直接 API に加えて同じ状態へ書き込む全経路（編成する workflow tool・間接書込）と部分成功（途中失敗時の残留状態）まで列挙する — cache 無効化・整合性確認の対象はこの列挙から導く
   - **横断関心の振り分け**: 権限（IAM 等）・環境差（preview/prod の配線に加え、ローカルエミュレータ・モックと実サービスの挙動差。例: SQS エミュレータが実 AWS と違うパラメータ制約を持つ）・ライフサイクル（作成物の削除・掃除）・負荷特性（ストリーミング・上限）・文言とアクセシブル名の i18n（UI 文言・aria-label・既定文言のロケール追従）の5つを各境界で確認し、契約／完了条件／やらないことのどれかに必ず振り分ける。実装後にリーダーが思いつく検証は、計画時に振り分け損ねた横断関心であることが多い
   - **変更マップ**: 触るファイルのパス一覧と、模倣する既存パターンの名指し。設計探索で見た場所を書き出す。設定値・資源識別子の変更では、旧い固定値と、値を読む wrapper / helper を含む全 consumer を検索して列挙する。削除・シグネチャ変更するシンボルは呼び出し元を grep で全列挙し、波及修正を変更マップに含める（列挙漏れは計画外の波及修正と意味論バグの出どころになる）。**人手列挙は着手点であり網羅の根拠にしない**: 撤去・削除・シグネチャ変更で参照が複数ディレクトリ・おおむね20箇所を超えて広がる場合は**閉包方式**へ切り替える — 削除対象シンボル一覧＋(パス,行)単位の許容リスト＋残存参照を数える判定スクリプトを用意し、「残存参照0を機械判定できる」ことを変更マップの完成条件とする。API・機能の撤去では、テスト支援コード（モックサーバーのハンドラ・シードデータ、expect ヘルパー、テストダブル）を定型の確認先に含め、文字列ベース参照（`.On("...")` 等、型チェックに掛からない形）も grep 対象にする
   - **検証設計**: 挙動が変わる箇所ごとに「この退行をどのテストが検知するか」を列挙する。テスト対象ファイルの列挙や「テスト green」だけの完了条件は検知力を担保しない（implementer は列挙されたテストへのケース追加は忠実に行うが、列挙にないテストは自発的に設計しない）
     - 契約項目ごとに該当する軸だけを選び、**状態遷移の前後と不変状態**、**意味が等価な別表現**、**欠落・null・空値・未知値・既定値**、**locale・schema・client 等の mirror**、**観測するテスト層・fixture・assertion**を対応付けた検証 oracle を書く。実行時入力を扱う契約は、本番・実transcript・実レスポンス等から採取した形状、または出自を保持した匿名fixtureを少なくとも1つ使う。手組みfixtureだけなら採用理由と未代表面を明記する。各oracleには対象故障だけでなく、隣接する別fail-openを残す対照実装では合格しない識別反証を置く。全軸の機械的な表埋めは求めない。主要な契約違反を故意に入れたとき、どの検知器が落ちるか説明できることをブリーフの完成条件とする
     - 定型観点として毎回確認する:
       - **境界間のパラメータ伝播**: 入口で受けた値が末端まで実際に通ることを検知する（空通し・既定値への黙殺を含む）。設定値・資源識別子では、正規化・項目間制約・設定源の優先順位を別々の失敗クラスで確認する
       - **新設分岐の網羅**: タイブレーク・フォールバック等、追加した分岐ごとの退行を検知する
       - **並び順・選抜の oracle**: ソート・ランキング・タイブレーク・選抜を検証する fixture は、入力順と期待順を逆転させた配置で書く（入力順のまま期待順が成立する fixture は、並べ替え処理を削除する退行でも合格する）。識別反証は散文でなく fixture の具体配置（どの入力で落ちるか）で指定する
       - **証拠コマンドの実行範囲**: 証拠・完了条件に書くテストコマンドは、対象テストを実際に実行することを Makefile・テスト設定（除外パターン・ビルドタグ・ターゲット分割）まで遡って確認してから確定する
       - **UI に見える変更の smoke 要否**: Seal の smoke は、共同レビュー収束後に implementer の全量完了条件が green になった安定版へ、リーダーが `scenario-kit smoke` を1回だけ実行する最終証跡の機械ゲートとする。Seal の smoke は、既存シナリオまたは共同レビュー開始前から同じ diff に含めた軽微な変種だけを使い、レビュー後に scenario・helper・assertion を編集しない。新規実装が必要と判明したら `未整備` として別 follow-up へ分ける（scenario-kit 自体が中心成果のタスクを除く）。実走後に固定checkerのverifyとcode ledger `before-completion`を再実行し、smoke中の追跡済み・非ignore未追跡差分発生をfail-closedにする。UI に見える変更を含まないなら「対象外」と明記する。実走した場合は exit code・`report.json`・video パスを実測フッターへ引き継ぐ
     - 変更の本丸が既存テストの無い場所（UI コンポーネント等）に落ちる場合は、テスト手法の当たり（無理なら実機確認へ割り当てる旨）まで計画で決める
     - 実行可能な検知器（テスト基盤・検証スクリプト・パーサ・品質ゲート）を新設・変更する場合は、正常系に加えて検知器が担保する契約の制約ごとに少なくとも1つの失敗クラスと故意ずれ検体を対応付け、期待する非ゼロ終了または診断を確認する。1種類の文字列変更だけで済ませず、適用対象に応じて未登録・件数差・正規化差・文法外値など、実装を別々に壊す入力を選ぶ。AST・lint・grep 等の静的検知器では、対象言語で意味が等価な参照・alias・bind・分割代入・computed 形式等の迂回面を列挙し、receiver を識別できない場合の意図的な過検知範囲と代替手段を契約へ固定する。代表的な迂回と正当コードの誤検知を別クラスで確認する
     - 検体のライフサイクルは implementer 定義の規定と同じ: 対象リポジトリの `.work/<作業名>/`（cross-review の作業ディレクトリと同じ）配下にファイル一式として残しレビュー完了（cross-review 収束）まで削除せず、適用時は元ファイルを cp でバックアップして復元はバックアップからのコピーで行う（未コミット変更がある作業ツリーで `git checkout` / `git restore` による復元をしない）
   - **完了条件とやらないこと**: スコープ外を明示し、implementer の善意の拡張を防ぐ
   - diff レベル（コードの書き方の逐一指示）は書かない。散文での二重実装になり、追補時の手戻り面積も大きい
6. Seal のレビュー設計には、共同ラウンド開始時に追跡済み差分と非 ignore 未追跡を含む diff 指紋を固定し、プレレビューと cross-review へ同じ指紋・計画・対象範囲・検証証跡・重点観点を渡すことを明記する。片方の結果だけで修正せず、両返却指紋と結果受領時の現行指紋を照合し、根本原因単位で統合した一つの修正バッチ後に両承認を失効させる。同じ根本原因・契約・状態機械・帳簿・schema/fixture同期面から2ラウンド連続で新規must/shouldが出たとき、またはR3終了時点で未収束なら、局所修正を止める。根本原因、入力次元、状態遷移、全copy/consumer、oracle、識別反証を閉包表へ列挙して一括補正し、同じsession/threadで全文レビューを再開する。同一指紋への二者承認を完了条件とする
7. `<置き場>/README.md` の索引に1行追記する（相対リンク＋要約）。無ければ作る。
8. 置き場が git 管理されていれば日本語メッセージでコミットする。

## 合意前計画レビュー

合意前計画レビュー（外部モデル）は **Seal のみ必須**。Sign は任意、Show は不要（設計合意は会話または direction 本文で行う）。Seal の direction は、ユーザーへ合意を求める前に、実行中クライアントとは異なるモデルで1回以上レビューする。未コミットコード diff を入口にする `cross-review` スキルは使わず、次の read-only CLI をリーダーが直接起動する:

外部モデル起動前に、同じ `dev-method` プラグインへ同梱された `references/check-evidence-package.mjs` の絶対パスを解決する。canonical review-dir は計画対象リポジトリrootの絶対パス配下にある `.work/<direction basename>/` の絶対パスそのものとし、計画レビューのprompt・結果・帳簿置き場と同一にする。この一意な絶対パスを実装開始時にexecutionへそのまま継承し、別配布物のexecution、プラグインキャッシュ、兄弟review-dirからtoolingを推測してはならない。

1. source checkerを `node <source checker絶対パス> bootstrap --review-dir <canonical review-dir絶対パス>` で1回だけ起動する。作成済みなら固定済みtoolingと`review_unit_id`を変更しない。未対応`format_version`、固定コピー欠落・hash不一致、失効済みreview unitでは停止する
2. `tooling-manifest.json` の絶対パスから固定checkerを解決し、`node <固定checker> direction --review-dir <同じ絶対パス> --direction <direction絶対パス>` を実行する。readinessがgreenになるまで外部モデルを起動しない
3. 固定toolingに進行不能な不具合がある場合だけ、旧固定checkerの `revoke --review-dir <旧絶対パス> --superseded-by <新basename>` を先に実行し、失効を確認してからsupersede関係を記した新directionを新規bootstrapする。固定checkerでmarkerを作れない場合はsource checkerによる同じrevokeと両directionの`revoke_fallback`記録、さらに失敗した場合はユーザー明示承認記録を伴う`forced-revoke`、旧IDも回収不能または固定レジストリも書込不能なら明示承認済みabandonment記録を伴う新規bootstrapの順だけを許す。旧証跡・承認は新review unitへ転記しない

- Codex 上で実行中のR1 → 新規UUIDを発行し、`claude -p "$(cat <プロンプトファイル>)" --session-id <R1 UUID> --model fable --effort high --permission-mode plan --allowedTools "Read,Grep,Glob" --output-format json < /dev/null > <結果イベントファイル> 2>&1`。JSONの`session_id`が指定UUIDと一致し、`permission_denials`と実diffからread-onlyを監査してから結果本文を保存する。R2以降は同じ制約を再指定した `claude -p "$(cat <プロンプトファイル>)" --resume <R1 session ID> --model fable --effort high --permission-mode plan --allowedTools "Read,Grep,Glob" --output-format json` を使い、返却ID一致を確認する
- Claude Code 上で実行中のR1 → `codex exec --cd <対象リポジトリ> --sandbox read-only -m gpt-5.6-sol -c 'model_reasoning_effort="high"' -o <結果ファイル> --json "$(cat <プロンプトファイル>)" < /dev/null > <イベントログ> 2>&1`。`thread.started.thread_id`を保存し、R2以降は `codex exec --cd <対象リポジトリ> --sandbox read-only resume <R1 thread ID> "$(cat <プロンプトファイル>)" --json` としてread-onlyを再指定し、同じthread IDの開始イベントと実diff不変を確認する

外部レビューの実行中は、起動機構に対応する完了通知またはブロッキング待機（Codexの統合exec sessionなら `write_stdin` による長待機）を使い、関係のないagent mailbox待機や短timeoutのpollを繰り返さない。providerの試行は初回を含め最大2回とする。`400 model not supported` では同じ外部CLIでモデル指定を外して2回目を実行し、429・5xx・quota・unavailableでは起動環境が列挙できる同じ外部モデルファミリーの別の利用可能な最上位モデルへ2回目を切り替える。同じ失敗条件を反復せず、表層JSONが壊れていても必須fieldをすべて回収して正規化JSONへ変換し、schemaとverdict/findings整合を検証できるなら再実行しない。2回目も失敗したら合意へ進まず、利用可能な計画レビュー経路の復旧をユーザーへ求める。

対象リポジトリの `.work/<direction basename>/` を作業ディレクトリとし、各ラウンドのプロンプトを `plan-review-prompt-<N>.md`、結果を固定`review-ledger-schema.json`の`resultDocument`に適合する `plan-review-<N>.json`、Codex のイベントログを `plan-review-<N>.log`、帳簿を `review-ledger.jsonl` に置く。promptイベントは固定checkerの`ledger-prompt`、resultイベントは固定checkerの`ledger-result`だけで生成し、JSONLを手書きしない。両コマンドへphase・reviewer・round・session IDとファイル絶対パスを渡し、checkerが`review_unit_id`、規範本文hash、diff指紋、内容hashを導出する。プロンプトには direction 全文、対象リポジトリ、関連する親方針・先行 direction・PaPut の過去決定など判断に必要な文脈を含める。観点は未決事項・契約矛盾・検証 oracle の漏れ・スコープ・高リスク編集面の境界だけに限定し、実装方法やコードスタイルへ広げない。出力は must-fix / should-fix / nit と承認可否を区別させ、ファイル変更・検証コマンド・別レビューを禁止する。

レビューの must-fix / should-fix / nit は direction へ反映し、全区分がゼロになった版だけを合意へ出す。R2以降は上記の`claude --resume` / `codex exec ... resume`でR1と同じsession/threadをread-only制約付きで再開し、更新後direction全文をR1と同じ全観点から再読させる。各resultイベントには空配列を含むread-only監査結果を必須記録する。前回指摘と対応内容も含めるが、その範囲だけに限定しない。ID取得不能、resume失敗、ID不一致、read-only再指定・監査の欠落時は旧承認を失効し、新規session起動イベントと逸脱記録が揃うまでfail-closedで停止する。レビューによって契約が変わっても合意前なので追補に数えない。異モデルのレビューを実行できない場合は合意へ進まず、利用可能なレビュー経路の復旧をユーザーへ依頼する。

各ラウンド結果受領後に `node <固定checker> review-ledger --phase plan --round <N> --review-dir <絶対パス> --direction <direction絶対パス> --events <review-ledger.jsonl絶対パス> --execution-point results-received`、ユーザーへの合意依頼直前に同じroundを指定してexecution pointだけを`before-agreement`として実行する。checkerは検査前にround付き試行イベントを原子的に先書きし、帳簿検証を完了したexit 0/2/3だけにpassedイベント、構造異常のexit 1にはfailedイベントを対応付ける。最終判定はpassedの結果受領checkpointだけを全result roundと1対1照合する。exit 0は同一review unit・規範本文hash・session/thread・全指摘ゼロの帳簿整合、exit 2は指摘残存または`stale_approved_plan`による次ラウンド、exit 3は4回目の差し戻しまたは5ラウンド未収束のbackstop、exit 1は帳簿異常である。exit 1/2では合意へ進まず、exit 3では未解決指摘とledger detailsを添えてユーザー判断へ戻す。

## 合意と実装

- 契約別の検証 oracle が揃い、合意前計画レビューの must-fix / should-fix がゼロになった版について、実装に入る前にユーザーの合意を得る。ブリーフが揃っていれば implementer は並列境界単位で最初から並列 spawn できる。
- 実装中に方向が変わったら direction に追補として記録しコミットする。**契約バグ以外の追補は implementer に即時反映せず**、フォローアップとして実装完了後に1バッチで回す。

## 完了

1. `状態:` 行を **完了（日付）** に更新し、実装・同一 diff 指紋へのプレレビュー／`cross-review` 二者承認・リリースの到達点と、残っているスコープ外事項を1〜2文で書く。この行と次の`実測:`行は固定checkerの規範本文hash対象外であり、契約・スコープ・検証条件など承認対象の情報は書かない。
2. 状態行の下に実測フッターを1行追記する（execution の完了報告があればそれを転記。数値は概算でよい）:

   `実測: レーンSeal / レビュー計画1R・21分（R1 must0+should0+nit0） / レビューコード1R・23分（R1 pre must0+should0；cross must0+should0；固有 pre0+cross0；重複0） / ledger plan 結果受領1/1・合意直前1/1・stale0・eligible=true / ledger code 両結果受領1/1・完了直前1/1・stale0・eligible=true / R1 plan approved / R1 code approved / E2E 44分 / 実働30分（手法運用8分） / Evidence Package 準備2分（開始10:00・終了10:02；テスト5分） / 4分類 plan-escape0+implementation-deviation0+evidence-gap0+new-risk0 / 差し戻し0 / リーダー直修正0 / 追補0（契約0） / smoke 対象外 / 逸脱: なし`

   これは Seal 型フッター（現行 Ask 型文法をレーン名だけ Seal に）。**Sign** はこの文法を流用し、レーン名を `Sign`、`ledger plan`／`ledger code`／`Evidence Package` の各欄を `対象外` と記載する（Sign は ledger・Evidence Package を使わないため。`ledger plan 対象外` / `ledger code 対象外` / `Evidence Package 対象外`）。過去フッターの `レーンAsk` は書き換えず、集計上は Seal 系譜として読む。

   **実働欄（実働・手法運用）は session-metrics の実測で確定する**（必須。他欄はレビュー経過・帳簿由来の現行規定を維持し、session-metrics では確定しない）。フッター記載の前に、`method-check` スキル同梱の `references/session-metrics.mjs` でリーダーセッションを実測する（対象セッションの規定は決定4＝リーダーセッション必須、起草・実装が別セッションでパス判明なら `--session` 追加、不明分は対象外と明記、teammate/subagent は自動探索しない）。実働＝`activeMs`、手法運用＝`breakdown.methodOpsMs` を四捨五入で分へ。**測定 cutoff**: session-metrics 起動時点のログ最終イベントをスナップショット終端とし、実測コマンド自身・フッター記載・完了記載・最終報告は測定に含まれない。**実測値の採用条件**: `skippedLines`・`unknownEvents`・`orphanToolUses` が各セッションの全イベント行数の1%未満、かつ検算値が非 null のとき乖離 ≦10%（Claude / Codex とも `|turnWindowActiveMs − turnWindowCheckMs| / turnWindowCheckMs`＝turn 窓限定の検算。Claude は clean 窓、Codex は閉じた turn 窓で、対象窓が無いログは検算不能＝非 null 条件を満たさないため品質指標のみで判定する。Codex は進行中の最終 turn が検算から除外されるため、turn 実行中の完了記載でも検算が成立する）。満たさなければ実働欄を記載せず（欠測）、実測不能の旨と品質指標を `method-check` の friction 記録規定で判定する。実測で見つかったロス候補も method-check の friction 記録規定で判定する（フッター逸脱欄は工程逸脱の自己記録のままで二重記録しない）。

   フッターの表記ゆれは次の固定形だけを許容する（method-stats が受理する範囲。これ以外の即興表記は文法外警告で集計から落ちる）: 実施しなかったレビュー工程は理由必須の `0R（理由）`（分値は省略または `0分`）と記載し、対応する outcome は省略または `対象外` とする。計画レビューのラウンド別内訳は R2 から宣言ラウンドまでの連番で併記できる。複数境界のコードレビューは `N境界×各MR・X分（<境界名> R1 … ／ …）` の境界別内訳で記載する。分値の `約` 接頭と ledger・outcome への括弧注記を許容し、outcome の中黒注記は `needs-attention` に限る。

   計画レビューとコード共同レビューは各ラウンドの開始から結果集約までの工程別壁時計を別々に記録し、`E2E`にはその合計（総レビュー壁時計）を記録する。実装・指摘修正・ユーザー待ちは含めない。計画/コードのラウンド数、R1の区分別件数、pre/cross固有・重複、plan/code ledgerの必須2実行点・stale・eligible、plan/code R1 outcome、Evidence Package準備時間（開始・終了・内数のテスト時間）、レビュー指摘の4分類を固定順で持つ。固有／重複は must-fix / should-fix だけを根本原因単位で数え、nit は含めない。相反は裁定後に採用した側の固有へ数え、棄却した指摘は数えない。過去の Ask/Seal と Show のフッターは書き換えない。smoke は完了記載の時点で `PASS|FAIL n件|評価不能|対象外|未整備` のいずれかに確定させる（検証設計の定型観点で要否を決めているため、完了時点で値が定まらない状態は残らない）。評価不能 = scenario-kit smoke の exit 3（環境起因で評価が成立しなかった場合。アプリ退行の FAIL と区別する）。
3. 実測フッターの逸脱欄に記載があれば、その内容だけを `~/dev-notes/dev-method/friction.md` へ1行転記する（形式・状態マークと発生位置タグはファイルヘッダーと `method-check` の friction 記録規定に従う。無ければヘッダー付きで作る）。**記憶を遡った自己申告はしない** — 時間ロス・手戻り・レビュー収束の精査は `method-check` スキルで行う。転記後に未対応エントリを数え、5件たまるか同型が2回続いていたら dev-method の改訂バッチを回すようユーザーに提案する。同型判定は発生位置タグの一致を先に見て、同じタグの中で内容を比べる（`grep '\[edge:impl->leader\]' friction.md` のようにタグで絞り込める）。無タグの過去エントリは本文内容で照合する。
4. README 索引の要約が実態とずれていれば直す。
5. 置き場が git 管理されていればコミットする。確定した設計判断は `paput_add_project_document`（design_doc）への保存も忘れない（完了チェックリスト Check 1）。
