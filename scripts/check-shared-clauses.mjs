import { readFileSync } from 'node:fs';

const CLAUSE_PAIRS = [
  {
    id: '完了報告: リーダーへの明示配送契約（team-impl両版）',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /完了条件: 最終報告がリーダーへ明示的に届くまで.*/,
  },
  {
    id: '共同レビュー: 実行可能な検知器の証跡照合',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /実行可能な検知器（テスト基盤・検証スクリプト・パーサ・品質ゲート）の変更では、direction の検証設計.*/,
  },
  {
    id: 'Showプレレビュー: cross-reviewを省略する単独実行（team-impl両版）',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /Show ではプレレビューだけを単独起動し.*/,
  },
  {
    id: 'Showプレレビュー: must のみ1回化（team-impl両版）',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /Show のプレレビューは1回で終了する.*/,
  },
  {
    id: 'Showプレレビュー: diff指紋対象外展開（team-impl両版）',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /`\{\{DIFF_FINGERPRINT\}\}` は `diff指紋: 対象外（Show）` へ置換する.*/,
  },
  {
    id: 'Showプレレビュー: diff指紋対象外条件（prompt ↔ team-impl claude）',
    fileA: 'src/plugin/skills/cross-review/references/review-prompt.md',
    fileB: 'src/plugin-claude/skills/team-impl/SKILL.md',
    regex: /「diff指紋: 対象外（Show）」が渡された場合は最終報告へそのまま返す/,
  },
  {
    id: 'Showプレレビュー: diff指紋対象外条件（prompt ↔ team-impl codex）',
    fileA: 'src/plugin/skills/cross-review/references/review-prompt.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /「diff指紋: 対象外（Show）」が渡された場合は最終報告へそのまま返す/,
  },
  {
    id: 'implementer: 故意ずれ検体の実行',
    fileA: 'src/plugin-claude/agents/implementer.md',
    fileB: 'src/plugin-codex/skills/team-impl/implementer.toml',
    regex: /計画の検証設計に故意ずれ検体があれば.*/,
  },
  {
    id: 'implementer-high: 故意ずれ検体の実行',
    fileA: 'src/plugin-claude/agents/implementer-high.md',
    fileB: 'src/plugin-codex/skills/team-impl/implementer-high.toml',
    regex: /計画の検証設計に故意ずれ検体があれば.*/,
  },
  {
    id: 'reviewer: 実行可能な検知器の証跡照合',
    fileA: 'src/plugin-claude/agents/reviewer.md',
    fileB: 'src/plugin-codex/skills/team-impl/reviewer.toml',
    regex: /実行可能な検知器（テスト基盤・検証スクリプト・パーサ・品質ゲート）の変更では、起動指示.*/,
  },
  {
    id: '完了報告: implementer の明示配送契約',
    fileA: 'src/plugin-claude/agents/implementer.md',
    fileB: 'src/plugin-codex/skills/team-impl/implementer.toml',
    regex: /完了条件: 最終報告がリーダーへ明示的に届くまで.*/,
  },
  {
    id: '完了報告: implementer-high の明示配送契約',
    fileA: 'src/plugin-claude/agents/implementer-high.md',
    fileB: 'src/plugin-codex/skills/team-impl/implementer-high.toml',
    regex: /完了条件: 最終報告がリーダーへ明示的に届くまで.*/,
  },
  {
    id: '完了報告: reviewer の明示配送契約',
    fileA: 'src/plugin-claude/agents/reviewer.md',
    fileB: 'src/plugin-codex/skills/team-impl/reviewer.toml',
    regex: /完了条件: 最終報告がリーダーへ明示的に届くまで.*/,
  },
  {
    id: '完了報告: implementer のrole別行頭ラベル',
    fileA: 'src/plugin-claude/agents/implementer.md',
    fileB: 'src/plugin-codex/skills/team-impl/implementer.toml',
    regex: /最終報告は、各ラベルを行頭に置いた `完了報告:`（変更ファイル一覧と概要）・`検証証跡:`（コマンド、exit code、pass\/fail件数、故意ずれ結果）・`逸脱:`・`未達事項:` の4項目を含める。/,
  },
  {
    id: '完了報告: implementer-high のrole別行頭ラベル',
    fileA: 'src/plugin-claude/agents/implementer-high.md',
    fileB: 'src/plugin-codex/skills/team-impl/implementer-high.toml',
    regex: /最終報告は、各ラベルを行頭に置いた `完了報告:`（変更ファイル一覧と概要）・`検証証跡:`（コマンド、exit code、pass\/fail件数、故意ずれ結果）・`逸脱:`・`未達事項:` の4項目を含める。/,
  },
  {
    id: '完了報告: reviewer のrole別行頭ラベルとShow指紋',
    fileA: 'src/plugin-claude/agents/reviewer.md',
    fileB: 'src/plugin-codex/skills/team-impl/reviewer.toml',
    regex: /最終報告は、各ラベルを行頭に置いた `レビュー完了報告:`・`diff指紋:`・`指摘:`・`承認可否:` の4項目を含める。Showでは `diff指紋: 対象外（Show）` とする。/,
  },
  {
    id: 'implementer: 削除・rename の旧名残存 grep',
    fileA: 'src/plugin-claude/agents/implementer.md',
    fileB: 'src/plugin-codex/skills/team-impl/implementer.toml',
    regex: /削除・rename を含む変更では、旧名.*/,
  },
  {
    id: 'implementer-high: 削除・rename の旧名残存 grep',
    fileA: 'src/plugin-claude/agents/implementer-high.md',
    fileB: 'src/plugin-codex/skills/team-impl/implementer-high.toml',
    regex: /削除・rename を含む変更では、旧名.*/,
  },
  {
    id: 'reviewer: 削除・rename diff の全体走査',
    fileA: 'src/plugin-claude/agents/reviewer.md',
    fileB: 'src/plugin-codex/skills/team-impl/reviewer.toml',
    regex: /削除・rename を含む diff では、残存参照の走査.*/,
  },
  {
    id: '進捗報告: implementer の中間進捗条項',
    fileA: 'src/plugin-claude/agents/implementer.md',
    fileB: 'src/plugin-codex/skills/team-impl/implementer.toml',
    regex: /進捗報告: 作業が15分を超える見込みなら.*/,
  },
  {
    id: '進捗報告: implementer-high の中間進捗条項',
    fileA: 'src/plugin-claude/agents/implementer-high.md',
    fileB: 'src/plugin-codex/skills/team-impl/implementer-high.toml',
    regex: /進捗報告: 作業が15分を超える見込みなら.*/,
  },
  {
    id: 'リーダー: 最終報告未達時の催促上限とフォールバック',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /最終報告が無いまま idle 通知・ターン終了を検知したら.*/,
  },
  {
    id: '報告様式: 最終報告は要点のみ',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /\*\*最終報告は要点のみ\*\*:.*/,
  },
  {
    id: '報告様式: 中間報告は差分のみ（通知の呼称差を除く同文前半）',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /\*\*中間報告は差分のみ\*\*:.*?再掲をしない/,
  },
  {
    id: '報告様式: 指摘の本文の扱い',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /ユーザー向け報告は.*/,
  },
  {
    id: '共同レビュー: 指摘の統合処理',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /指摘の処理:.*/,
  },
  {
    id: '手順7: 共同レビューループ収束条件',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /共同ラウンドの完了条件を満たすまでレビュー→修正を繰り返す/,
  },
  {
    id: '手順7: nitループ運用と収束停止条件',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /nit はループの終了条件にせず.*/,
  },
  {
    id: '手順9: 実測フッターのテンプレート',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /実測: レーンSeal \/ 担当.*/,
  },
  {
    id: '共同レビュー: Sign 各1回・Evidence/ledger なし（team-impl両版）',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /Sign では pre（プレレビュー）と cross（cross-review）を同じ開始時 diff 指紋へ各1回だけ起動し.*/,
  },
  {
    id: '手順9: 実働欄の記載点注記（team-impl両版）',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /実働欄は direction 完了時に session-metrics の実測で記載する（報告時は省略してよい）。/,
  },
  {
    id: '共同レビュー: workdir準備から並列起動までの順序（team-impl両版）',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /共同ラウンドは、先に `cross-review` の手順1〜2だけを実行して.*/,
  },
  {
    id: '共同レビュー: 両結果待ちと指紋照合（team-impl両版）',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /片方の結果だけで修正を始めず、両結果が揃うまで待つ.*/,
  },
  {
    id: '共同レビュー: 両レビューへの同一入力（team-impl両版）',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /両レビューには同じ開始時 diff 指紋・計画ファイル・対象範囲.*/,
  },
  {
    id: '共同レビュー: 根本原因単位の統合差し戻し（team-impl両版）',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /指摘の処理: 両結果を失敗シナリオ／根本原因単位へ正規化し.*/,
  },
  {
    id: '共同レビュー: 同一版二者承認（team-impl両版）',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /共同ラウンドの完了条件は、同じ開始時 diff 指紋を返した両レビューで.*/,
  },
  {
    id: '共同レビュー: R2以降の例外なし差分限定（team-impl両版）',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /R2 以降は例外なく、前回指摘への対応と前回指紋からの変更による新規混入だけをレビュー対象にする.*/,
  },
  {
    id: '共同レビュー: R2以降の例外なし差分限定（prompt ↔ team-impl claude）',
    fileA: 'src/plugin/skills/cross-review/references/review-prompt.md',
    fileB: 'src/plugin-claude/skills/team-impl/SKILL.md',
    regex: /R2 以降は例外なく、前回指摘への対応と前回指紋からの変更による新規混入だけをレビュー対象にする.*/,
  },
  {
    id: '共同レビュー: R2以降の例外なし差分限定（prompt ↔ team-impl codex）',
    fileA: 'src/plugin/skills/cross-review/references/review-prompt.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /R2 以降は例外なく、前回指摘への対応と前回指紋からの変更による新規混入だけをレビュー対象にする.*/,
  },
  {
    id: '共同レビュー: R2以降の例外なし差分限定（cross-review ↔ prompt）',
    fileA: 'src/plugin/skills/cross-review/SKILL.md',
    fileB: 'src/plugin/skills/cross-review/references/review-prompt.md',
    regex: /R2 以降は例外なく、前回指摘への対応と前回指紋からの変更による新規混入だけをレビュー対象にする.*/,
  },
  {
    id: '共同レビュー: R2以降の例外なし差分限定（cross-review ↔ team-impl claude）',
    fileA: 'src/plugin/skills/cross-review/SKILL.md',
    fileB: 'src/plugin-claude/skills/team-impl/SKILL.md',
    regex: /R2 以降は例外なく、前回指摘への対応と前回指紋からの変更による新規混入だけをレビュー対象にする.*/,
  },
  {
    id: '共同レビュー: R2以降の例外なし差分限定（cross-review ↔ team-impl codex）',
    fileA: 'src/plugin/skills/cross-review/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /R2 以降は例外なく、前回指摘への対応と前回指紋からの変更による新規混入だけをレビュー対象にする.*/,
  },
  {
    id: '共同レビュー: 暴走防止バックストップ（team-impl両版）',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /通常の共同ラウンド数に品質上限は設けない。暴走防止バックストップは code ledger の exit 3 だけを正本とし.*/,
  },
  {
    id: '共同レビュー: 実測テンプレート文法（direction ↔ team-impl claude）',
    fileA: 'src/plugin/skills/direction/SKILL.md',
    fileB: 'src/plugin-claude/skills/team-impl/SKILL.md',
    regex: /レビュー計画1R・21分（R1 must0\+should0\+nit0）.*?4分類 plan-escape0\+implementation-deviation0\+evidence-gap0\+new-risk0/,
  },
  {
    id: '共同レビュー: 実測テンプレート文法（direction ↔ team-impl codex）',
    fileA: 'src/plugin/skills/direction/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /レビュー計画1R・21分（R1 must0\+should0\+nit0）.*?4分類 plan-escape0\+implementation-deviation0\+evidence-gap0\+new-risk0/,
  },
  {
    id: '手順9: 共同ラウンド指標必須とsmoke確定の注記',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /計画\/コードのラウンド数、R1の区分別件数、pre\/cross固有・重複、plan\/code ledgerの必須2実行点・stale・eligible、plan\/code R1 outcome、Evidence Package準備時間.*/,
  },
  {
    id: 'provider: 2試行・正規化救出契約（cross-review ↔ team-impl claude）',
    fileA: 'src/plugin/skills/cross-review/SKILL.md',
    fileB: 'src/plugin-claude/skills/team-impl/SKILL.md',
    regex: /provider の起動は初回を含め最大2試行とする.*?それ未満は試行失敗として扱う。/,
  },
  {
    id: 'provider: 2試行・正規化救出契約（cross-review ↔ team-impl codex）',
    fileA: 'src/plugin/skills/cross-review/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /provider の起動は初回を含め最大2試行とする.*?それ未満は試行失敗として扱う。/,
  },
  {
    id: 'reviewer: Pre-Report Gate（cross-review ↔ reviewer claude）',
    fileA: 'src/plugin/skills/cross-review/references/review-prompt.md',
    fileB: 'src/plugin-claude/agents/reviewer.md',
    regex: /報告前に各指摘へ4問を課す.*/,
  },
  {
    id: 'reviewer: Pre-Report Gate（claude ↔ codex）',
    fileA: 'src/plugin-claude/agents/reviewer.md',
    fileB: 'src/plugin-codex/skills/team-impl/reviewer.toml',
    regex: /報告前に各指摘へ4問を課す.*/,
  },
  {
    id: 'reviewer: 偽陽性カタログ（cross-review ↔ reviewer claude）',
    fileA: 'src/plugin/skills/cross-review/references/review-prompt.md',
    fileB: 'src/plugin-claude/agents/reviewer.md',
    regex: /確信度の高い実際の問題のみ報告する.*?偽陽性の常連として原則書かない/,
  },
  {
    id: 'reviewer: 偽陽性カタログ（claude ↔ codex）',
    fileA: 'src/plugin-claude/agents/reviewer.md',
    fileB: 'src/plugin-codex/skills/team-impl/reviewer.toml',
    regex: /確信度の高い実際の問題のみ報告する.*/,
  },
  {
    id: 'reviewer: テスト検知力の判定基準（cross-review ↔ reviewer claude）',
    fileA: 'src/plugin/skills/cross-review/references/review-prompt.md',
    fileB: 'src/plugin-claude/agents/reviewer.md',
    regex: /テスト不足はテストの存在でなく.*/,
  },
  {
    id: 'reviewer: テスト検知力の判定基準（claude ↔ codex）',
    fileA: 'src/plugin-claude/agents/reviewer.md',
    fileB: 'src/plugin-codex/skills/team-impl/reviewer.toml',
    regex: /テスト不足はテストの存在でなく.*/,
  },
  {
    id: 'レビューループ: nit 運用（cross-review ↔ team-impl claude）',
    fileA: 'src/plugin/skills/cross-review/SKILL.md',
    fileB: 'src/plugin-claude/skills/team-impl/SKILL.md',
    regex: /nit はループの終了条件にせず.*?nit のためだけに追加ラウンドを起動しない）/,
  },
  {
    id: 'reviewer: 静的照合縮退の証跡欠落時の扱い（review-prompt ↔ reviewer claude）',
    fileA: 'src/plugin/skills/cross-review/references/review-prompt.md',
    fileB: 'src/plugin-claude/agents/reviewer.md',
    regex: /実行証跡が無い失敗クラスは should-fix として報告し、自分の権限を広げて追加検証を実行しない/,
  },
  {
    id: 'リーダーコミット: ステージング規律（team-impl両版）',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /ステージングは変更対象パスの明示指定で行い.*/,
  },
  {
    id: '手順8: 収束後の最終全量検証（team-impl両版）',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /レビュー収束後、コミット前に統合先で担当 implementer へ全量の完了条件コマンドを1回通し直させ.*?review-unit-complete\.json`を確認してからリーダーがコミットする/,
  },
  {
    id: '並列境界: 独立境界の並列割り当て既定（team-impl両版）',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /宣言済みの複数境界が互いに独立なら.*/,
  },
  {
    id: '並列境界: worktree統合後レビュー契約（team-impl両版）',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /全境界が揃ったら統合先へ計画の依存順で各commitを.*?verify・共同レビューへ進む。/,
  },
  {
    id: '手順5: worktree統合後の共同レビュー（team-impl両版）',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /worktree分離時は全境界の完了報告を待ち.*?重点観点に足す/,
  },
  {
    id: '高リスクrole: 局所割り当て（direction ↔ team-impl claude）',
    fileA: 'src/plugin/skills/direction/SKILL.md',
    fileB: 'src/plugin-claude/skills/team-impl/SKILL.md',
    regex: /高リスク role は、高リスク基準に触れる契約・ファイル・完了条件を最小の高リスク編集面へ分けて局所割り当てし.*?ブリーフ全体を `implementer-high` とする。/,
  },
  {
    id: '高リスクrole: 局所割り当て（direction ↔ team-impl codex）',
    fileA: 'src/plugin/skills/direction/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /高リスク role は、高リスク基準に触れる契約・ファイル・完了条件を最小の高リスク編集面へ分けて局所割り当てし.*?ブリーフ全体を `implementer-high` とする。/,
  },
  {
    id: 'Seal smoke: 安定版への最終1回ゲート（direction ↔ team-impl claude）',
    fileA: 'src/plugin/skills/direction/SKILL.md',
    fileB: 'src/plugin-claude/skills/team-impl/SKILL.md',
    regex: /Seal の smoke は、既存シナリオまたは共同レビュー開始前から同じ diff に含めた軽微な変種だけを使い、レビュー後に scenario・helper・assertion を編集しない。/,
  },
  {
    id: 'Seal smoke: 安定版への最終1回ゲート（direction ↔ team-impl codex）',
    fileA: 'src/plugin/skills/direction/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /Seal の smoke は、既存シナリオまたは共同レビュー開始前から同じ diff に含めた軽微な変種だけを使い、レビュー後に scenario・helper・assertion を編集しない。/,
  },
  {
    id: 'implementer: 差し戻し再検証の影響範囲スコープ',
    fileA: 'src/plugin-claude/agents/implementer.md',
    fileB: 'src/plugin-codex/skills/team-impl/implementer.toml',
    regex: /指摘の修正だけを行い、再検証は指摘の影響範囲.*/,
  },
  {
    id: 'implementer-high: 差し戻し再検証の影響範囲スコープ',
    fileA: 'src/plugin-claude/agents/implementer-high.md',
    fileB: 'src/plugin-codex/skills/team-impl/implementer-high.toml',
    regex: /指摘の修正だけを行い、再検証は指摘の影響範囲.*/,
  },
  {
    id: 'Evidence: direction ↔ team-impl claude の固定作業単位・record・plan/code継続・footer契約',
    fileA: 'src/plugin/skills/direction/SKILL.md',
    fileB: 'src/plugin-claude/skills/team-impl/SKILL.md',
    regex: /Evidence共有契約: Sealでは canonical review-dir.*/,
  },
  {
    id: 'Evidence: direction ↔ team-impl codex の固定作業単位・record・plan/code継続・footer契約',
    fileA: 'src/plugin/skills/direction/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /Evidence共有契約: Sealでは canonical review-dir.*/,
  },
  {
    id: 'Evidence: team-impl両版のcanonical作業単位入力',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /Seal の共同レビューでは、direction から引き継いだ canonical review-dir.*/,
  },
  {
    id: 'Evidence: team-impl両版の固定checker verifyゲート',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /R1 を含む各共同ラウンドの起動直前に、`tooling-manifest.json` の絶対パスから固定 checker.*/,
  },
  {
    id: 'Evidence: team-impl両版の同一package伝播と免責禁止',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /verify が exit 0 のときだけ、verify JSON の全境界manifest絶対パス.*/,
  },
  {
    id: 'Evidence: team-impl両版の旧review unit転記禁止',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /R1 はプレレビュー・cross-review ともタスクごとの新規独立 session\/thread.*/,
  },
  {
    id: 'Evidence: team-impl両版のcode ledger三値完了判定',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /両レビュー結果を受領した直後に `node <tooling-manifestのchecker絶対パス> review-ledger.*/,
  },
  {
    id: 'Evidence: team-impl両版のcode ledger exit語彙',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /code ledger では各返却の `approve` を.*/,
  },
  {
    id: 'Evidence: team-impl両版のSealゲート適用範囲',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /このゲートは team-impl が Seal の共同レビューとして呼ぶ経路だけに適用する.*/,
  },
  {
    id: 'Evidence: implementer両版のmanifest・record契約',
    fileA: 'src/plugin-claude/agents/implementer.md',
    fileB: 'src/plugin-codex/skills/team-impl/implementer.toml',
    regex: /Evidence Packageを要求されたSealでworktree分離を使わない場合は.*/,
  },
  {
    id: 'Evidence: implementer-high両版のmanifest・record契約',
    fileA: 'src/plugin-claude/agents/implementer-high.md',
    fileB: 'src/plugin-codex/skills/team-impl/implementer-high.toml',
    regex: /Evidence Packageを要求されたSealでworktree分離を使わない場合は.*/,
  },
  {
    id: 'リーダー: 報告不達引き取り前の停止と書込オーナー移管（team-impl両版）',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /報告不達で工程を引き取る前に、担当へ停止指示を送り.*/,
  },
  {
    id: 'リーダー: 宛先照合と誤再稼働の回収（team-impl両版）',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /担当へのメッセージ送信・再開指示の前に、宛先を現行工程の稼働中担当一覧と照合する.*/,
  },
  {
    id: '必須実測: turn窓限定検算の定義（method-check ↔ direction）',
    fileA: 'src/plugin/skills/method-check/SKILL.md',
    fileB: 'src/plugin/skills/direction/SKILL.md',
    regex: /検算は Claude \/ Codex とも turn 窓限定の `turnWindowActiveMs` 対 `turnWindowCheckMs`（Claude は内部プロンプトを含む窓と計上済み窓に重なる窓を除いた clean 窓、Codex は `duration_ms` を持って閉じた turn 窓。対象窓が無いログは検算不能）/,
  },
];

function normalize(text) {
  return text.replace(/[ \t　]+/g, ' ').trim();
}

function findAllMatches(file, regex, reader) {
  const lines = reader(file).split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(regex);
    if (m) hits.push({ text: m[0], line: i + 1 });
  }
  return hits;
}

function checkPairs(reader) {
  const mismatches = [];
  for (const pair of CLAUSE_PAIRS) {
    const a = findAllMatches(pair.fileA, pair.regex, reader);
    const b = findAllMatches(pair.fileB, pair.regex, reader);
  if (a.length === 0 || b.length === 0) {
    mismatches.push(`${pair.id}: 対応箇所が見つからない（${a.length === 0 ? pair.fileA : pair.fileB}）`);
      continue;
    }
    if (a.length !== b.length) {
    mismatches.push(
      `${pair.id}: 一致数が異なる（${pair.fileA} ${a.length}件 vs ${pair.fileB} ${b.length}件）`,
    );
      continue;
    }
    for (let i = 0; i < a.length; i++) {
      if (normalize(a[i].text) !== normalize(b[i].text)) {
      mismatches.push(
        `${pair.id}: ${pair.fileA}:${a[i].line} と ${pair.fileB}:${b[i].line} がずれている`,
      );
      }
    }
  }
  return mismatches;
}

const diskReader = (file) => readFileSync(file, 'utf8');
const mismatches = checkPairs(diskReader);
if (mismatches.length > 0) {
  console.error('並行条項の不一致:');
  for (const m of mismatches) console.error(`- ${m}`);
  process.exit(1);
}

if (process.argv.includes('--self-test')) {
  let passed = 0;
  for (const pair of CLAUSE_PAIRS) {
    const original = diskReader(pair.fileA);
    const hit = findAllMatches(pair.fileA, pair.regex, diskReader)[0];
    if (!hit) continue;
    const changed = original.replace(hit.text, 'deliberate-drift');
    const inMemoryReader = (file) => file === pair.fileA ? changed : diskReader(file);
    if (checkPairs(inMemoryReader).some((message) => message.startsWith(`${pair.id}:`))) passed += 1;
  }
  if (passed !== CLAUSE_PAIRS.length) {
    console.error(`check-shared-clauses self-test: ${passed}/${CLAUSE_PAIRS.length}`);
    process.exit(1);
  }
  console.log(`check-shared-clauses self-test: ${passed}/${CLAUSE_PAIRS.length} deliberate drifts detected`);
}

console.log('check-shared-clauses: 一致（全ペア green）');
