import { readFileSync } from 'node:fs';

const LANE_SOURCES = [
  ['direction', 'src/plugin/skills/direction/SKILL.md'],
  ['global asset', 'src/plugin/skills/setup/assets/global-lane-rules.md'],
  ['repository CLAUDE.md', 'CLAUDE.md'],
];

const LANE_CONTRACTS = [
  {
    id: 'Ship判定基準',
    test: ({ lane, compact }) => hasInOrder(lane('Ship'), compact ? [
      /挙動に触れない変更/,
      /機械ゲートのみ/,
    ] : [
      /挙動に触れない(?:変更)?:/,
      /typo・docs・コメント・ログ文言・依存 patch 更新・自明な設定値変更/,
    ]),
  },
  {
    id: 'Show判定基準',
    test: ({ lane, document }) => (
      /下位2レーンの基準に触れない(?:すべて|変更)/.test(lane('Show'))
      && /direction の有無(?:は無関係|とは独立)/.test(document)
    ),
  },
  {
    id: 'Sign判定基準',
    test: ({ lane, document }) => hasInOrder(lane('Sign'), [
      /高リスク基準/,
      /検知器.*新設・変更/,
    ]) && hasInOrder(document, [
      /DB migration/,
      /並行処理/,
      /認可/,
      /セキュリティ/,
      /境界間契約/,
    ]),
  },
  {
    id: 'Seal判定基準',
    test: ({ lane }) => hasInOrder(lane('Seal'), [
      /不可逆/,
      /外部影響/,
      /重なる変更(?:のみ|だけ)/,
    ]),
  },
  {
    id: 'Show工程',
    test: ({ lane, compact }) => hasInOrder(lane('Show'), compact ? [
      /機械ゲート/,
      /プレレビュー1回/,
      /must-fix のみ即対応/,
    ] : [
      /実装/,
      /機械ゲート/,
      /プレレビュー1回/,
      /must-fix のみ即対応/,
      /cross-review/,
      /(?:使わ|なし|省略)/,
    ]),
  },
  {
    id: 'Sign工程',
    test: ({ lane, compact }) => hasInOrder(lane('Sign'), compact ? [
      /pre \+ cross/,
      /各1回/,
      /統合裁定/,
      /must-fix/,
      /1バッチ/,
      /再レビューなし/,
      /Evidence Package/,
      /ledger/,
      /収束ループなし/,
    ] : [
      /実装/,
      /機械ゲート/,
      /pre \+ cross/,
      /各1回/,
      /統合裁定/,
      /must-fix/,
      /1バッチ/,
      /再レビュー/,
      /(?:しない|なし)/,
      /Evidence Package/,
      /ledger/,
      /使わない|なし/,
    ]),
  },
];

const CLAUSE_PAIRS = [
  {
    id: '実測フッター: 受理される表記ゆれの固定形（execution両版）',
    fileA: 'src/plugin-claude/skills/execution/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /フッターの表記ゆれは次の固定形だけを許容する.*/,
  },
  {
    id: '実測フッター: 受理される表記ゆれの固定形（direction ↔ execution claude）',
    fileA: 'src/plugin/skills/direction/SKILL.md',
    fileB: 'src/plugin-claude/skills/execution/SKILL.md',
    regex: /フッターの表記ゆれは次の固定形だけを許容する.*/,
  },
  {
    id: '実測フッター: 受理される表記ゆれの固定形（direction ↔ execution codex）',
    fileA: 'src/plugin/skills/direction/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /フッターの表記ゆれは次の固定形だけを許容する.*/,
  },
  {
    id: '完了報告: リーダーへの明示配送契約（execution両版）',
    fileA: 'src/plugin-claude/skills/execution/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /完了条件: 最終報告がリーダーへ明示的に届くまで.*/,
  },
  {
    id: '共同レビュー: 実行可能な検知器の証跡照合',
    fileA: 'src/plugin-claude/skills/execution/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /実行可能な検知器（テスト基盤・検証スクリプト・パーサ・品質ゲート）の変更では、direction の検証設計.*/,
  },
  {
    id: 'Showプレレビュー: cross-reviewを省略する単独実行（execution両版）',
    fileA: 'src/plugin-claude/skills/execution/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /Show ではプレレビューだけを単独起動し.*/,
  },
  {
    id: 'Showプレレビュー: must のみ1回化（execution両版）',
    fileA: 'src/plugin-claude/skills/execution/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /Show のプレレビューは1回で終了する.*/,
  },
  {
    id: 'Showプレレビュー: diff指紋対象外展開（execution両版）',
    fileA: 'src/plugin-claude/skills/execution/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /`\{\{DIFF_FINGERPRINT\}\}` は `diff指紋: 対象外（Show）` へ置換する.*/,
  },
  {
    id: 'Showプレレビュー: diff指紋対象外条件（prompt ↔ execution claude）',
    fileA: 'src/plugin/skills/cross-review/references/review-prompt.md',
    fileB: 'src/plugin-claude/skills/execution/SKILL.md',
    regex: /「diff指紋: 対象外（Show）」が渡された場合は最終報告へそのまま返す/,
  },
  {
    id: 'Showプレレビュー: diff指紋対象外条件（prompt ↔ execution codex）',
    fileA: 'src/plugin/skills/cross-review/references/review-prompt.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /「diff指紋: 対象外（Show）」が渡された場合は最終報告へそのまま返す/,
  },
  {
    id: 'implementer: 故意ずれ検体の実行',
    fileA: 'src/plugin-claude/agents/implementer.md',
    fileB: 'src/plugin-codex/skills/execution/dev-method-implementer.toml',
    regex: /計画の検証設計に故意ずれ検体があれば.*/,
  },
  {
    id: 'implementer-critical: 故意ずれ検体の実行',
    fileA: 'src/plugin-claude/agents/implementer-critical.md',
    fileB: 'src/plugin-codex/skills/execution/dev-method-implementer-critical.toml',
    regex: /計画の検証設計に故意ずれ検体があれば.*/,
  },
  {
    id: 'reviewer: 実行可能な検知器の証跡照合',
    fileA: 'src/plugin-claude/agents/reviewer.md',
    fileB: 'src/plugin-codex/skills/execution/dev-method-reviewer.toml',
    regex: /実行可能な検知器（テスト基盤・検証スクリプト・パーサ・品質ゲート）の変更では、起動指示.*/,
  },
  {
    id: '完了報告: implementer の明示配送契約',
    fileA: 'src/plugin-claude/agents/implementer.md',
    fileB: 'src/plugin-codex/skills/execution/dev-method-implementer.toml',
    regex: /完了条件: 最終報告がリーダーへ明示的に届くまで.*/,
  },
  {
    id: '完了報告: implementer-critical の明示配送契約',
    fileA: 'src/plugin-claude/agents/implementer-critical.md',
    fileB: 'src/plugin-codex/skills/execution/dev-method-implementer-critical.toml',
    regex: /完了条件: 最終報告がリーダーへ明示的に届くまで.*/,
  },
  {
    id: '完了報告: reviewer の明示配送契約',
    fileA: 'src/plugin-claude/agents/reviewer.md',
    fileB: 'src/plugin-codex/skills/execution/dev-method-reviewer.toml',
    regex: /完了条件: 最終報告がリーダーへ明示的に届くまで.*/,
  },
  {
    id: '完了報告: implementer のrole別行頭ラベル',
    fileA: 'src/plugin-claude/agents/implementer.md',
    fileB: 'src/plugin-codex/skills/execution/dev-method-implementer.toml',
    regex: /最終報告は、各ラベルを行頭に置いた `完了報告:`（変更ファイル一覧と概要）・`検証証跡:`（コマンド、exit code、pass\/fail件数、故意ずれ結果）・`逸脱:`・`未達事項:` の4項目を含める。/,
  },
  {
    id: '完了報告: implementer-critical のrole別行頭ラベル',
    fileA: 'src/plugin-claude/agents/implementer-critical.md',
    fileB: 'src/plugin-codex/skills/execution/dev-method-implementer-critical.toml',
    regex: /最終報告は、各ラベルを行頭に置いた `完了報告:`（変更ファイル一覧と概要）・`検証証跡:`（コマンド、exit code、pass\/fail件数、故意ずれ結果）・`逸脱:`・`未達事項:` の4項目を含める。/,
  },
  {
    id: '完了報告: implementer の記述規律',
    fileA: 'src/plugin-claude/agents/implementer.md',
    fileB: 'src/plugin-codex/skills/execution/dev-method-implementer.toml',
    regex: /各項目は結論を先頭に置き、ツール結果で裏付けられる事実だけを書く。.*/,
  },
  {
    id: '完了報告: implementer-critical の記述規律',
    fileA: 'src/plugin-claude/agents/implementer-critical.md',
    fileB: 'src/plugin-codex/skills/execution/dev-method-implementer-critical.toml',
    regex: /各項目は結論を先頭に置き、ツール結果で裏付けられる事実だけを書く。.*/,
  },
  {
    id: 'implementer: 再委譲の上限',
    fileA: 'src/plugin-claude/agents/implementer.md',
    fileB: 'src/plugin-codex/skills/execution/dev-method-implementer.toml',
    regex: /- 自分で数回のツール呼出しで終わる作業の再委譲、.*/,
  },
  {
    id: 'implementer-critical: 再委譲の上限',
    fileA: 'src/plugin-claude/agents/implementer-critical.md',
    fileB: 'src/plugin-codex/skills/execution/dev-method-implementer-critical.toml',
    regex: /- 自分で数回のツール呼出しで終わる作業の再委譲、.*/,
  },
  {
    id: 'implementer: 計画外の追加検証・green後再実行の禁止',
    fileA: 'src/plugin-claude/agents/implementer.md',
    fileB: 'src/plugin-codex/skills/execution/dev-method-implementer.toml',
    regex: /- 計画・完了条件・差し戻し指摘の影響範囲のいずれにも無い追加検証を自分の判断で足すこと、.*/,
  },
  {
    id: 'implementer-critical: 計画外の追加検証・green後再実行の禁止',
    fileA: 'src/plugin-claude/agents/implementer-critical.md',
    fileB: 'src/plugin-codex/skills/execution/dev-method-implementer-critical.toml',
    regex: /- 計画・完了条件・差し戻し指摘の影響範囲のいずれにも無い追加検証を自分の判断で足すこと、.*/,
  },
  {
    id: '完了報告: reviewer のrole別行頭ラベルとShow指紋',
    fileA: 'src/plugin-claude/agents/reviewer.md',
    fileB: 'src/plugin-codex/skills/execution/dev-method-reviewer.toml',
    regex: /最終報告は、各ラベルを行頭に置いた `レビュー完了報告:`・`diff指紋:`・`指摘:`・`承認可否:` の4項目を含める。Showでは `diff指紋: 対象外（Show）` とする。/,
  },
  {
    id: 'implementer: 削除・rename の旧名残存 grep',
    fileA: 'src/plugin-claude/agents/implementer.md',
    fileB: 'src/plugin-codex/skills/execution/dev-method-implementer.toml',
    regex: /削除・rename を含む変更では、旧名.*/,
  },
  {
    id: 'implementer-critical: 削除・rename の旧名残存 grep',
    fileA: 'src/plugin-claude/agents/implementer-critical.md',
    fileB: 'src/plugin-codex/skills/execution/dev-method-implementer-critical.toml',
    regex: /削除・rename を含む変更では、旧名.*/,
  },
  {
    id: 'reviewer: 削除・rename diff の全体走査',
    fileA: 'src/plugin-claude/agents/reviewer.md',
    fileB: 'src/plugin-codex/skills/execution/dev-method-reviewer.toml',
    regex: /削除・rename を含む diff では、残存参照の走査.*/,
  },
  {
    id: '進捗報告: implementer の中間進捗条項',
    fileA: 'src/plugin-claude/agents/implementer.md',
    fileB: 'src/plugin-codex/skills/execution/dev-method-implementer.toml',
    regex: /進捗報告: 作業が15分を超える見込みなら.*/,
  },
  {
    id: '進捗報告: implementer-critical の中間進捗条項',
    fileA: 'src/plugin-claude/agents/implementer-critical.md',
    fileB: 'src/plugin-codex/skills/execution/dev-method-implementer-critical.toml',
    regex: /進捗報告: 作業が15分を超える見込みなら.*/,
  },
  {
    id: 'リーダー: 最終報告未達時の催促上限とフォールバック',
    fileA: 'src/plugin-claude/skills/execution/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /最終報告が無いまま idle 通知・ターン終了を検知したら.*/,
  },
  {
    id: '報告様式: 最終報告は要点のみ',
    fileA: 'src/plugin-claude/skills/execution/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /\*\*最終報告は要点のみ\*\*:.*/,
  },
  {
    id: '報告様式: 中間報告は差分のみ（通知の呼称差を除く同文前半）',
    fileA: 'src/plugin-claude/skills/execution/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /\*\*中間報告は差分のみ\*\*:.*?再掲をしない/,
  },
  {
    id: '報告様式: 指摘の本文の扱い',
    fileA: 'src/plugin-claude/skills/execution/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /ユーザー向け報告は.*/,
  },
  {
    id: '共同レビュー: 指摘の統合処理',
    fileA: 'src/plugin-claude/skills/execution/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /指摘の処理:.*/,
  },
  {
    id: '手順7: 共同レビューループ収束条件',
    fileA: 'src/plugin-claude/skills/execution/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /共同ラウンドの完了条件を満たすまでレビュー→修正を繰り返す/,
  },
  {
    id: '手順7: nitループ運用と収束停止条件',
    fileA: 'src/plugin-claude/skills/execution/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /nit はループの終了条件にせず.*/,
  },
  {
    id: '手順9: 実測フッターのテンプレート',
    fileA: 'src/plugin-claude/skills/execution/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /実測: レーンSeal \/ 担当.*/,
  },
  {
    id: '共同レビュー: Sign 各1回・Evidence/ledger なし（execution両版）',
    fileA: 'src/plugin-claude/skills/execution/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /Sign では pre（プレレビュー）と cross（cross-review）を同じ開始時 diff 指紋へ各1回だけ起動し.*/,
  },
  {
    id: '手順9: 実働欄の記載点注記（execution両版）',
    fileA: 'src/plugin-claude/skills/execution/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /実働欄は direction 完了時に session-metrics の実測で記載する（報告時は省略してよい）。/,
  },
  {
    id: '共同レビュー: workdir準備から並列起動までの順序（execution両版）',
    fileA: 'src/plugin-claude/skills/execution/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /共同ラウンドは、先に `cross-review` の手順1〜2だけを実行して.*/,
  },
  {
    id: '共同レビュー: 両結果待ちと指紋照合（execution両版）',
    fileA: 'src/plugin-claude/skills/execution/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /片方の結果だけで修正を始めず、両結果が揃うまで待つ.*/,
  },
  {
    id: '共同レビュー: 両レビューへの同一入力（execution両版）',
    fileA: 'src/plugin-claude/skills/execution/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /両レビューには同じ開始時 diff 指紋・計画ファイル・対象範囲.*/,
  },
  {
    id: '共同レビュー: 根本原因単位の統合差し戻し（execution両版）',
    fileA: 'src/plugin-claude/skills/execution/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /指摘の処理: 両結果を失敗シナリオ／根本原因単位へ正規化し.*/,
  },
  {
    id: '共同レビュー: 同一版二者承認（execution両版）',
    fileA: 'src/plugin-claude/skills/execution/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /共同ラウンドの完了条件は、同じ開始時 diff 指紋を返した両レビューで.*/,
  },
  {
    id: '共同レビュー: R2以降の例外なし差分限定（execution両版）',
    fileA: 'src/plugin-claude/skills/execution/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /R2 以降は例外なく、前回指摘への対応と前回指紋からの変更による新規混入だけをレビュー対象にする.*/,
  },
  {
    id: '共同レビュー: R2以降の例外なし差分限定（prompt ↔ execution claude）',
    fileA: 'src/plugin/skills/cross-review/references/review-prompt.md',
    fileB: 'src/plugin-claude/skills/execution/SKILL.md',
    regex: /R2 以降は例外なく、前回指摘への対応と前回指紋からの変更による新規混入だけをレビュー対象にする.*/,
  },
  {
    id: '共同レビュー: R2以降の例外なし差分限定（prompt ↔ execution codex）',
    fileA: 'src/plugin/skills/cross-review/references/review-prompt.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /R2 以降は例外なく、前回指摘への対応と前回指紋からの変更による新規混入だけをレビュー対象にする.*/,
  },
  {
    id: '共同レビュー: R2以降の例外なし差分限定（cross-review ↔ prompt）',
    fileA: 'src/plugin/skills/cross-review/SKILL.md',
    fileB: 'src/plugin/skills/cross-review/references/review-prompt.md',
    regex: /R2 以降は例外なく、前回指摘への対応と前回指紋からの変更による新規混入だけをレビュー対象にする.*/,
  },
  {
    id: '共同レビュー: R2以降の例外なし差分限定（cross-review ↔ execution claude）',
    fileA: 'src/plugin/skills/cross-review/SKILL.md',
    fileB: 'src/plugin-claude/skills/execution/SKILL.md',
    regex: /R2 以降は例外なく、前回指摘への対応と前回指紋からの変更による新規混入だけをレビュー対象にする.*/,
  },
  {
    id: '共同レビュー: R2以降の例外なし差分限定（cross-review ↔ execution codex）',
    fileA: 'src/plugin/skills/cross-review/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /R2 以降は例外なく、前回指摘への対応と前回指紋からの変更による新規混入だけをレビュー対象にする.*/,
  },
  {
    id: '共同レビュー: 暴走防止バックストップ（execution両版）',
    fileA: 'src/plugin-claude/skills/execution/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /通常の共同ラウンド数に品質上限は設けない。暴走防止バックストップは code ledger の exit 3 だけを正本とし.*/,
  },
  {
    id: '共同レビュー: 実測テンプレート文法（direction ↔ execution claude）',
    fileA: 'src/plugin/skills/direction/SKILL.md',
    fileB: 'src/plugin-claude/skills/execution/SKILL.md',
    regex: /レビュー計画1R・21分（R1 must0\+should0\+nit0）.*?4分類 plan-escape0\+implementation-deviation0\+evidence-gap0\+new-risk0/,
  },
  {
    id: '共同レビュー: 実測テンプレート文法（direction ↔ execution codex）',
    fileA: 'src/plugin/skills/direction/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /レビュー計画1R・21分（R1 must0\+should0\+nit0）.*?4分類 plan-escape0\+implementation-deviation0\+evidence-gap0\+new-risk0/,
  },
  {
    id: '手順9: 共同ラウンド指標必須とsmoke確定の注記',
    fileA: 'src/plugin-claude/skills/execution/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /計画\/コードのラウンド数、R1の区分別件数、pre\/cross固有・重複、plan\/code ledgerの必須2実行点・stale・eligible、plan\/code R1 outcome、Evidence Package準備時間.*/,
  },
  {
    id: 'provider: 2試行・正規化救出契約（cross-review ↔ execution claude）',
    fileA: 'src/plugin/skills/cross-review/SKILL.md',
    fileB: 'src/plugin-claude/skills/execution/SKILL.md',
    regex: /provider の起動は初回を含め最大2試行とする.*?それ未満は試行失敗として扱う。/,
  },
  {
    id: 'provider: 2試行・正規化救出契約（cross-review ↔ execution codex）',
    fileA: 'src/plugin/skills/cross-review/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
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
    fileB: 'src/plugin-codex/skills/execution/dev-method-reviewer.toml',
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
    fileB: 'src/plugin-codex/skills/execution/dev-method-reviewer.toml',
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
    fileB: 'src/plugin-codex/skills/execution/dev-method-reviewer.toml',
    regex: /テスト不足はテストの存在でなく.*/,
  },
  {
    id: 'レビューループ: nit 運用（cross-review ↔ execution claude）',
    fileA: 'src/plugin/skills/cross-review/SKILL.md',
    fileB: 'src/plugin-claude/skills/execution/SKILL.md',
    regex: /nit はループの終了条件にせず.*?nit のためだけに追加ラウンドを起動しない）/,
  },
  {
    id: 'reviewer: 静的照合縮退の証跡欠落時の扱い（review-prompt ↔ reviewer claude）',
    fileA: 'src/plugin/skills/cross-review/references/review-prompt.md',
    fileB: 'src/plugin-claude/agents/reviewer.md',
    regex: /実行証跡が無い失敗クラスは should-fix として報告し、自分の権限を広げて追加検証を実行しない/,
  },
  {
    id: 'リーダーコミット: ステージング規律（execution両版）',
    fileA: 'src/plugin-claude/skills/execution/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /ステージングは変更対象パスの明示指定で行い.*/,
  },
  {
    id: '手順8: 収束後の最終全量検証（execution両版）',
    fileA: 'src/plugin-claude/skills/execution/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /レビュー収束後、コミット前に統合先で担当 implementer へ全量の完了条件コマンドを1回通し直させ.*?review-unit-complete\.json`を確認してからリーダーがコミットする/,
  },
  {
    id: '並列境界: 独立境界の並列割り当て既定（execution両版）',
    fileA: 'src/plugin-claude/skills/execution/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /宣言済みの複数境界が互いに独立なら.*/,
  },
  {
    id: '並列境界: worktree統合後レビュー契約（execution両版）',
    fileA: 'src/plugin-claude/skills/execution/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /全境界が揃ったら統合先へ計画の依存順で各commitを.*?verify・共同レビューへ進む。/,
  },
  {
    id: '手順5: worktree統合後の共同レビュー（execution両版）',
    fileA: 'src/plugin-claude/skills/execution/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /worktree分離時は全境界の完了報告を待ち.*?重点観点に足す/,
  },
  {
    id: '高リスクrole: 局所割り当て（direction ↔ execution claude）',
    fileA: 'src/plugin/skills/direction/SKILL.md',
    fileB: 'src/plugin-claude/skills/execution/SKILL.md',
    regex: /高リスク role は、高リスク基準に触れる契約・ファイル・完了条件を最小の高リスク編集面へ分けて局所割り当てし.*?ブリーフ全体を `implementer-critical` とする。/,
  },
  {
    id: '高リスクrole: 局所割り当て（direction ↔ execution codex）',
    fileA: 'src/plugin/skills/direction/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /高リスク role は、高リスク基準に触れる契約・ファイル・完了条件を最小の高リスク編集面へ分けて局所割り当てし.*?ブリーフ全体を `implementer-critical` とする。/,
  },
  {
    id: 'Seal smoke: 安定版への最終1回ゲート（direction ↔ execution claude）',
    fileA: 'src/plugin/skills/direction/SKILL.md',
    fileB: 'src/plugin-claude/skills/execution/SKILL.md',
    regex: /Seal の smoke は、既存シナリオまたは共同レビュー開始前から同じ diff に含めた軽微な変種だけを使い、レビュー後に scenario・helper・assertion を編集しない。/,
  },
  {
    id: 'Seal smoke: 安定版への最終1回ゲート（direction ↔ execution codex）',
    fileA: 'src/plugin/skills/direction/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /Seal の smoke は、既存シナリオまたは共同レビュー開始前から同じ diff に含めた軽微な変種だけを使い、レビュー後に scenario・helper・assertion を編集しない。/,
  },
  {
    id: 'implementer: 差し戻し再検証の影響範囲スコープ',
    fileA: 'src/plugin-claude/agents/implementer.md',
    fileB: 'src/plugin-codex/skills/execution/dev-method-implementer.toml',
    regex: /指摘の修正だけを行い、再検証は指摘の影響範囲.*/,
  },
  {
    id: 'implementer-critical: 差し戻し再検証の影響範囲スコープ',
    fileA: 'src/plugin-claude/agents/implementer-critical.md',
    fileB: 'src/plugin-codex/skills/execution/dev-method-implementer-critical.toml',
    regex: /指摘の修正だけを行い、再検証は指摘の影響範囲.*/,
  },
  {
    id: 'Evidence: direction ↔ execution claude の固定作業単位・record・plan/code継続・footer契約',
    fileA: 'src/plugin/skills/direction/SKILL.md',
    fileB: 'src/plugin-claude/skills/execution/SKILL.md',
    regex: /Evidence共有契約: Sealでは canonical review-dir.*/,
  },
  {
    id: 'Evidence: direction ↔ execution codex の固定作業単位・record・plan/code継続・footer契約',
    fileA: 'src/plugin/skills/direction/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /Evidence共有契約: Sealでは canonical review-dir.*/,
  },
  {
    id: 'Evidence: execution両版のcanonical作業単位入力',
    fileA: 'src/plugin-claude/skills/execution/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /Seal の共同レビューでは、direction から引き継いだ canonical review-dir.*/,
  },
  {
    id: 'Evidence: execution両版の固定checker verifyゲート',
    fileA: 'src/plugin-claude/skills/execution/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /R1 を含む各共同ラウンドの起動直前に、`tooling-manifest.json` の絶対パスから固定 checker.*/,
  },
  {
    id: 'Evidence: execution両版の同一package伝播と免責禁止',
    fileA: 'src/plugin-claude/skills/execution/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /verify が exit 0 のときだけ、verify JSON の全境界manifest絶対パス.*/,
  },
  {
    id: 'Evidence: execution両版の旧review unit転記禁止',
    fileA: 'src/plugin-claude/skills/execution/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /R1 はプレレビュー・cross-review ともタスクごとの新規独立 session\/thread.*/,
  },
  {
    id: 'Evidence: execution両版のcode ledger三値完了判定',
    fileA: 'src/plugin-claude/skills/execution/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /両レビュー結果を受領した直後に `node <tooling-manifestのchecker絶対パス> review-ledger.*/,
  },
  {
    id: 'Evidence: execution両版のcode ledger exit語彙',
    fileA: 'src/plugin-claude/skills/execution/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /code ledger では各返却の `approve` を.*/,
  },
  {
    id: 'Evidence: execution両版のSealゲート適用範囲',
    fileA: 'src/plugin-claude/skills/execution/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /このゲートは execution が Seal の共同レビューとして呼ぶ経路だけに適用する.*/,
  },
  {
    id: 'Evidence: implementer両版のmanifest・record契約',
    fileA: 'src/plugin-claude/agents/implementer.md',
    fileB: 'src/plugin-codex/skills/execution/dev-method-implementer.toml',
    regex: /Evidence Packageを要求されたSealでworktree分離を使わない場合は.*/,
  },
  {
    id: 'Evidence: implementer-critical両版のmanifest・record契約',
    fileA: 'src/plugin-claude/agents/implementer-critical.md',
    fileB: 'src/plugin-codex/skills/execution/dev-method-implementer-critical.toml',
    regex: /Evidence Packageを要求されたSealでworktree分離を使わない場合は.*/,
  },
  {
    id: 'リーダー: 報告不達引き取り前の停止と書込オーナー移管（execution両版）',
    fileA: 'src/plugin-claude/skills/execution/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
    regex: /報告不達で工程を引き取る前に、担当へ停止指示を送り.*/,
  },
  {
    id: 'リーダー: 宛先照合と誤再稼働の回収（execution両版）',
    fileA: 'src/plugin-claude/skills/execution/SKILL.md',
    fileB: 'src/plugin-codex/skills/execution/SKILL.md',
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

function normalizeLaneMeaning(text) {
  return text
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasInOrder(text, patterns) {
  let cursor = 0;
  for (const pattern of patterns) {
    const match = text.slice(cursor).match(pattern);
    if (!match) return false;
    cursor += match.index + match[0].length;
  }
  return true;
}

function laneLine(text, laneName) {
  const escaped = laneName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const line = text.split(/\r?\n/).find((candidate) => (
    new RegExp(`^\\s*(?:\\|\\s*|-\\s+)\\*\\*${escaped}(?:\\*\\*|[（(])`).test(candidate)
  ));
  if (line) return normalizeLaneMeaning(line);

  const compactLine = text.split(/\r?\n/).find((candidate) => {
    const value = normalizeLaneMeaning(candidate);
    return value.includes('Ship は')
      && value.includes('Show（デフォルト）')
      && value.includes('Sign は')
      && value.includes('Seal は');
  });
  const normalized = normalizeLaneMeaning(compactLine || '');
  const starts = {
    Ship: normalized.indexOf('Ship は'),
    Show: normalized.indexOf('Show（デフォルト）'),
    Sign: normalized.indexOf('Sign は'),
    Seal: normalized.indexOf('Seal は'),
  };
  const start = starts[laneName];
  if (start === -1) return '';
  const later = Object.values(starts).filter((index) => index > start);
  const end = later.length > 0 ? Math.min(...later) : normalized.length;
  return normalized.slice(start, end);
}

function checkLaneContracts(reader) {
  const mismatches = [];
  for (const [sourceName, file] of LANE_SOURCES) {
    const raw = reader(file);
    const context = {
      document: normalizeLaneMeaning(raw),
      lane: (laneName) => laneLine(raw, laneName),
      compact: file === 'CLAUDE.md',
    };
    for (const contract of LANE_CONTRACTS) {
      if (!contract.test(context)) mismatches.push(`${sourceName}: ${contract.id}`);
    }
  }
  return mismatches;
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

const laneAssetOverrideIndex = process.argv.indexOf('--lane-asset');
const laneAssetOverride = laneAssetOverrideIndex === -1 ? null : process.argv[laneAssetOverrideIndex + 1];
if (laneAssetOverrideIndex !== -1 && !laneAssetOverride) {
  console.error('--lane-asset には検体ファイルを指定する');
  process.exit(2);
}
const diskReader = (file) => (
  file === 'src/plugin/skills/setup/assets/global-lane-rules.md' && laneAssetOverride
    ? readFileSync(laneAssetOverride, 'utf8')
    : readFileSync(file, 'utf8')
);
const mismatches = checkPairs(diskReader);
if (mismatches.length > 0) {
  console.error('並行条項の不一致:');
  for (const m of mismatches) console.error(`- ${m}`);
  process.exit(1);
}

const laneMismatches = checkLaneContracts(diskReader);
if (laneMismatches.length > 0) {
  console.error('実装レーン条項の不一致:');
  for (const mismatch of laneMismatches) console.error(`- ${mismatch}`);
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
