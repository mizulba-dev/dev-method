import { readFileSync } from 'node:fs';

const CLAUSE_PAIRS = [
  {
    id: '完了報告: リーダーへの明示配送契約（team-impl両版）',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /完了条件: 最終報告がリーダーへ明示的に届くまで.*/,
  },
  {
    id: 'プレレビュー: 実行可能な検知器の証跡照合',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /実行可能な検知器（テスト基盤・検証スクリプト・パーサ・品質ゲート）の変更では、direction の検証設計.*/,
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
    id: 'プレレビュー: 指摘の処理ループ',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /指摘の処理:.*/,
  },
  {
    id: '手順7: レビューループ収束条件',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /must-fix \/ should-fix がゼロになるまでレビュー→修正を繰り返す/,
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
    id: '手順9: R1必須とQA未実施の注記',
    fileA: 'src/plugin-claude/skills/team-impl/SKILL.md',
    fileB: 'src/plugin-codex/skills/team-impl/SKILL.md',
    regex: /R1 指摘件数は計画品質の直接指標として必ず含める.*/,
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
