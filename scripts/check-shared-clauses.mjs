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
    id: 'Showプレレビュー: must\/should収束条件（team-impl両版）',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /Show のプレレビューは must-fix \/ should-fix がゼロに収束するまで.*/,
  },
  {
    id: 'Showプレレビュー: diff指紋対象外展開（team-impl両版）',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /`\{\{DIFF_FINGERPRINT\}\}` は `対象外（Show）` へ置換する.*/,
  },
  {
    id: 'Showプレレビュー: diff指紋対象外条件（prompt ↔ team-impl claude）',
    fileA: 'src/plugin/skills/cross-review/references/review-prompt.md',
    fileB: 'src/plugin-claude/skills/team-impl/SKILL.md',
    regex: /「対象外（Show）」が渡された場合は指紋を返さない/,
  },
  {
    id: 'Showプレレビュー: diff指紋対象外条件（prompt ↔ team-impl codex）',
    fileA: 'src/plugin/skills/cross-review/references/review-prompt.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /「対象外（Show）」が渡された場合は指紋を返さない/,
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
    regex: /実測: レーンAsk \/ 担当.*/,
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
    regex: /通常の共同ラウンド数に品質上限は設けない。ただし暴走防止バックストップとして.*/,
  },
  {
    id: '共同レビュー: 実測テンプレート文法（direction ↔ team-impl claude）',
    fileA: 'src/plugin/skills/direction/SKILL.md',
    fileB: 'src/plugin-claude/skills/team-impl/SKILL.md',
    regex: /レビュー並列<N>R・<M>分（R1 pre must<N>\+should<N>；cross must<N>\+should<N>；固有 pre<N>\+cross<N>；重複<N>）/,
  },
  {
    id: '共同レビュー: 実測テンプレート文法（direction ↔ team-impl codex）',
    fileA: 'src/plugin/skills/direction/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /レビュー並列<N>R・<M>分（R1 pre must<N>\+should<N>；cross must<N>\+should<N>；固有 pre<N>\+cross<N>；重複<N>）/,
  },
  {
    id: '手順9: 共同ラウンド指標必須とsmoke確定の注記',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /共同ラウンド数・最初の共同ラウンド開始から同一版二者承認までのレビュー壁時計分.*/,
  },
  {
    id: 'レビューループ: ラウンド上限を設けない方針（cross-review ↔ team-impl claude）',
    fileA: 'src/plugin/skills/cross-review/SKILL.md',
    fileB: 'src/plugin-claude/skills/team-impl/SKILL.md',
    regex: /品質優先のためラウンド数の上限は設けない/,
  },
  {
    id: 'レビューループ: ラウンド上限を設けない方針（cross-review ↔ team-impl codex）',
    fileA: 'src/plugin/skills/cross-review/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /品質優先のためラウンド数の上限は設けない/,
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
    regex: /レビュー収束後、コミット前に担当 implementer へ全量の完了条件コマンドを1回通し直させ.*?初回証跡のままでよい）/,
  },
  {
    id: '並列境界: 独立境界の並列割り当て既定（team-impl両版）',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /宣言済みの複数境界が互いに独立なら.*/,
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
];

function normalize(text) {
  return text.replace(/[ \t　]+/g, ' ').trim();
}

function findAllMatches(file, regex) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(regex);
    if (m) hits.push({ text: m[0], line: i + 1 });
  }
  return hits;
}

const mismatches = [];

for (const pair of CLAUSE_PAIRS) {
  const a = findAllMatches(pair.fileA, pair.regex);
  const b = findAllMatches(pair.fileB, pair.regex);
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

if (mismatches.length > 0) {
  console.error('並行条項の不一致:');
  for (const m of mismatches) console.error(`- ${m}`);
  process.exit(1);
}

console.log('check-shared-clauses: 一致（全ペア green）');
