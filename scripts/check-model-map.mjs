import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const ROLE_MODELS = {
  implementer: { claude: 'sonnet/medium', codex: 'gpt-5.6-terra/medium' },
  'implementer-critical': { claude: 'opus/high', codex: 'gpt-5.6-sol/high' },
  reviewer: { claude: 'fable/high', codex: 'gpt-5.6-sol/high' },
  'cross-review': { fromCodex: 'fable/high', fromClaude: 'gpt-5.6-sol/high' },
};

function normalize(model, effort) {
  return `${model.trim().toLowerCase().replace(/\s+/g, '-')}/${effort.trim().toLowerCase()}`;
}

function findMatch(lines, regex) {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(regex);
    if (m) return { match: m, line: i + 1 };
  }
  return null;
}

function loadLines(file) {
  return readFileSync(file, 'utf8').split('\n');
}

const CHECKS = [
  {
    file: 'src/plugin-claude/agents/implementer.md',
    role: 'implementer',
    variant: 'claude',
    modelRegex: /^model:\s*(\S+)/,
    effortRegex: /^effort:\s*(\S+)/,
  },
  {
    file: 'src/plugin-claude/agents/implementer-critical.md',
    role: 'implementer-critical',
    variant: 'claude',
    modelRegex: /^model:\s*(\S+)/,
    effortRegex: /^effort:\s*(\S+)/,
  },
  {
    file: 'src/plugin-claude/agents/reviewer.md',
    role: 'reviewer',
    variant: 'claude',
    modelRegex: /^model:\s*(\S+)/,
    effortRegex: /^effort:\s*(\S+)/,
  },
  {
    file: 'src/plugin-codex/skills/execution/dev-method-implementer.toml',
    role: 'implementer',
    variant: 'codex',
    modelRegex: /^model\s*=\s*"([^"]+)"/,
    effortRegex: /^model_reasoning_effort\s*=\s*"([^"]+)"/,
  },
  {
    file: 'src/plugin-codex/skills/execution/dev-method-implementer-critical.toml',
    role: 'implementer-critical',
    variant: 'codex',
    modelRegex: /^model\s*=\s*"([^"]+)"/,
    effortRegex: /^model_reasoning_effort\s*=\s*"([^"]+)"/,
  },
  {
    file: 'src/plugin-codex/skills/execution/dev-method-reviewer.toml',
    role: 'reviewer',
    variant: 'codex',
    modelRegex: /^model\s*=\s*"([^"]+)"/,
    effortRegex: /^model_reasoning_effort\s*=\s*"([^"]+)"/,
  },
];

const PROSE_CHECKS = [
  {
    file: 'src/plugin-claude/skills/execution/SKILL.md',
    role: 'implementer',
    variant: 'claude',
    regex: /`implementer`(?!-critical)（([^）]+)）/,
  },
  {
    file: 'src/plugin-claude/skills/execution/SKILL.md',
    role: 'implementer-critical',
    variant: 'claude',
    regex: /`implementer-critical`（([^）]+)）/,
  },
  {
    file: 'src/plugin-claude/skills/execution/SKILL.md',
    role: 'reviewer',
    variant: 'claude',
    regex: /model\s+(\w+)\s*\/\s*effort\s+(\w+)/,
    twoGroups: true,
  },
  {
    file: 'src/plugin-claude/skills/execution/SKILL.md',
    role: 'cross-review',
    variant: 'fromClaude',
    regex: /レビューは `cross-review` スキル（([^・]+)・/,
  },
  {
    file: 'src/plugin-codex/skills/execution/SKILL.md',
    role: 'implementer',
    variant: 'codex',
    regex: /`dev-method-implementer`(?!-critical)（([^）]+)）/,
  },
  {
    file: 'src/plugin-codex/skills/execution/SKILL.md',
    role: 'implementer-critical',
    variant: 'codex',
    regex: /`dev-method-implementer-critical`（([^）]+)）/,
  },
  {
    file: 'src/plugin-codex/skills/execution/SKILL.md',
    role: 'reviewer',
    variant: 'codex',
    regex: /`reviewer` プロファイル（([^）]+)）/,
  },
  {
    file: 'src/plugin-codex/skills/execution/SKILL.md',
    role: 'cross-review',
    variant: 'fromCodex',
    regex: /別モデル = Claude\s+([^の]+?)\s*の headless/,
  },
  {
    file: 'src/plugin/skills/cross-review/SKILL.md',
    role: 'cross-review',
    variant: 'fromClaude',
    regex: /-m\s+(\S+)\s+-c\s+'model_reasoning_effort="(\w+)"'/,
    twoGroups: true,
  },
  {
    file: 'src/plugin/skills/cross-review/SKILL.md',
    role: 'cross-review',
    variant: 'fromCodex',
    regex: /--model\s+(\S+)\s+--effort\s+(\S+)/,
    twoGroups: true,
  },
  {
    file: 'README.md',
    role: 'implementer',
    variant: 'claude',
    regex: /\|\s*implementer（通常境界）\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/,
    groupIndex: 1,
  },
  {
    file: 'README.md',
    role: 'implementer',
    variant: 'codex',
    regex: /\|\s*implementer（通常境界）\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/,
    groupIndex: 2,
  },
  {
    file: 'README.md',
    role: 'implementer-critical',
    variant: 'claude',
    regex: /\|\s*implementer-critical（高リスク境界）\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/,
    groupIndex: 1,
  },
  {
    file: 'README.md',
    role: 'implementer-critical',
    variant: 'codex',
    regex: /\|\s*implementer-critical（高リスク境界）\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/,
    groupIndex: 2,
  },
  {
    file: 'README.md',
    role: 'reviewer',
    variant: 'claude',
    regex: /\|\s*プレレビュー reviewer\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/,
    groupIndex: 1,
  },
  {
    file: 'README.md',
    role: 'reviewer',
    variant: 'codex',
    regex: /\|\s*プレレビュー reviewer\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/,
    groupIndex: 2,
  },
  {
    file: 'README.md',
    role: 'cross-review',
    variant: 'fromCodex',
    regex: /Codex 上で実行中なら Claude\s+(.+?)\s+を、/,
  },
  {
    file: 'README.md',
    role: 'cross-review',
    variant: 'fromClaude',
    regex: /Claude Code 上で実行中なら Codex の\s+(.+?)\s+を呼ぶ/,
  },
  {
    file: 'README.md',
    role: 'implementer',
    variant: 'claude',
    regex: /execution`（通常\s+([^・]+?)・高リスク\s+([^）]+?)）\+ implementer\/reviewer agents/,
    groupIndex: 1,
  },
  {
    file: 'README.md',
    role: 'implementer-critical',
    variant: 'claude',
    regex: /execution`（通常\s+([^・]+?)・高リスク\s+([^）]+?)）\+ implementer\/reviewer agents/,
    groupIndex: 2,
  },
  {
    file: 'README.md',
    role: 'implementer',
    variant: 'codex',
    regex: /execution`（通常\s+([^・]+?)・高リスク\s+([^）]+?)）\+ implementer\/reviewer 定義/,
    groupIndex: 1,
  },
  {
    file: 'README.md',
    role: 'implementer-critical',
    variant: 'codex',
    regex: /execution`（通常\s+([^・]+?)・高リスク\s+([^）]+?)）\+ implementer\/reviewer 定義/,
    groupIndex: 2,
  },
  {
    file: 'README.md',
    role: 'reviewer',
    variant: 'claude',
    regex: /Claude 上は\s+([^、]+)、/,
    modelOnly: true,
  },
  {
    file: 'README.md',
    role: 'reviewer',
    variant: 'codex',
    regex: /Codex 上は\s+([^）]+)）/,
    modelOnly: true,
  },
];

const ROUTING_CHECKS = [
  {
    description: 'implementer role が agent_type へ伝播する',
    regex: /通常境界に `agent_type="dev-method-implementer"`/,
  },
  {
    description: 'implementer-critical role が agent_type へ伝播する',
    regex: /高リスク境界に `agent_type="dev-method-implementer-critical"` を渡/,
  },
  {
    description: 'reviewer role が agent_type で選択される',
    regex: /`agent_type="dev-method-reviewer"`・`fork_turns="none"` を指定/,
  },
  {
    description: '実装 role 指定時に fork_turns=none を使う',
    regex: /高リスク境界に `agent_type="dev-method-implementer-critical"` を渡し、`fork_turns="none"` を指定する/,
  },
  {
    description: 'task_name を role 選択子にしない',
    regex: /`task_name` は `implementer_1` \/ `implementer_critical_1` のような lowercase 英数字と underscore の一意な作業名に限定し、role 選択子として扱わない/,
  },
  {
    description: 'reviewer task_name を一意名にして role 選択子にしない',
    regex: /`task_name` は `pre_review_1` \/ `pre_review_2` のような一意名にし、reviewer の role 選択子として扱わない/,
  },
  {
    description: 'agent_type field 欠落時は縮退せず停止する',
    regex: /field 自体が無い場合は役割本文の同梱等で縮退せず停止し、Codex の更新・完全再起動を求める/,
  },
  {
    description: 'multi_agent 無効時は自動縮退せず停止する',
    regex: /multi_agent 機能が無効でサブエージェントをスポーンできない場合は、実装を始めず停止してユーザーに有効化を依頼し/,
  },
  {
    description: 'agent_type 有・role 不可視なら spawn 前に停止する',
    regex: /`agent_type` field はあるが選択 role が利用可能 role に見えない場合も spawn 前に停止し、完全再起動または定義修正を案内する/,
  },
  {
    description: 'unknown role・role 適用エラー時に縮退再試行しない',
    regex: /unknown role または role 適用エラーになった場合は、担当本文の同梱へ縮退再試行せず停止/,
  },
  {
    description: 'role TOML を model / effort の正本にする',
    regex: /`model` \/ `reasoning_effort` を重複指定せず、role TOML を正本にする/,
  },
];

function normalizeSlashPair(raw) {
  const m = raw.match(/^(.+?)\s*\/\s*(\S+)$/);
  if (!m) return null;
  return normalize(m[1], m[2]);
}

function normalizeModelOnly(raw) {
  return raw.trim().toLowerCase().replace(/\s+/g, '-');
}

const mismatches = [];

// Codex の role 名は `~/.codex/agents/` というグローバル名前空間へ置かれ、`agent_type` の値そのものになる。
// name とファイル stem が食い違うと、spawn は unknown role で止まらず残存する同名の旧定義へ解決されうるため、
// 三者（期待 role 名・TOML の name・ファイル stem）の一致を機械的に固定する。
const CODEX_AGENT_NAMES = [
  ['src/plugin-codex/skills/execution/dev-method-implementer.toml', 'dev-method-implementer'],
  ['src/plugin-codex/skills/execution/dev-method-implementer-critical.toml', 'dev-method-implementer-critical'],
  ['src/plugin-codex/skills/execution/dev-method-reviewer.toml', 'dev-method-reviewer'],
];

for (const [file, expectedName] of CODEX_AGENT_NAMES) {
  const hit = findMatch(loadLines(file), /^name\s*=\s*"([^"]+)"/);
  if (!hit) {
    mismatches.push(`${file}: role 名（name = "..."）が見つからない`);
    continue;
  }
  const actualName = hit.match[1];
  if (actualName !== expectedName) {
    mismatches.push(`${file}:${hit.line} role 名が "${actualName}" だが期待は "${expectedName}"`);
  }
  const stem = basename(file, '.toml');
  if (actualName !== stem) {
    mismatches.push(`${file}:${hit.line} role 名 "${actualName}" がファイル stem "${stem}" と一致しない`);
  }
  if (!actualName.startsWith('dev-method-')) {
    mismatches.push(`${file}:${hit.line} role 名 "${actualName}" に dev-method- 接頭辞が無い（グローバル名前空間の衝突源）`);
  }
}

for (const check of CHECKS) {
  const lines = loadLines(check.file);
  const modelHit = findMatch(lines, check.modelRegex);
  const effortHit = findMatch(lines, check.effortRegex);
  const expected = ROLE_MODELS[check.role][check.variant];
  if (!modelHit || !effortHit) {
    mismatches.push(`${check.file}: ${check.role}/${check.variant} のモデル・effort行が見つからない`);
    continue;
  }
  const actual = normalize(modelHit.match[1], effortHit.match[1]);
  if (actual !== expected) {
    mismatches.push(
      `${check.file}:${modelHit.line} ${check.role}/${check.variant} は "${actual}" だが割当表は "${expected}"`,
    );
  }
}

for (const check of PROSE_CHECKS) {
  const lines = loadLines(check.file);
  const hit = findMatch(lines, check.regex);
  const expectedFull = ROLE_MODELS[check.role][check.variant];
  const expected = check.modelOnly ? expectedFull.split('/')[0] : expectedFull;
  if (!hit) {
    mismatches.push(`${check.file}: ${check.role}/${check.variant} の記載が見つからない`);
    continue;
  }
  let actual;
  if (check.modelOnly) {
    actual = normalizeModelOnly(hit.match[1]);
  } else if (check.groupIndex) {
    actual = normalizeSlashPair(hit.match[check.groupIndex]);
  } else if (check.twoGroups) {
    actual = normalize(hit.match[1], hit.match[2]);
  } else {
    actual = normalizeSlashPair(hit.match[1]);
  }
  if (actual !== expected) {
    mismatches.push(
      `${check.file}:${hit.line} ${check.role}/${check.variant} は "${actual}" だが割当表は "${expected}"`,
    );
  }
}

const codexExecution = readFileSync('src/plugin-codex/skills/execution/SKILL.md', 'utf8');
for (const check of ROUTING_CHECKS) {
  if (!check.regex.test(codexExecution)) {
    mismatches.push(
      `src/plugin-codex/skills/execution/SKILL.md: routing契約「${check.description}」が見つからない`,
    );
  }
}

if (mismatches.length > 0) {
  console.error('モデル割当の不一致:');
  for (const m of mismatches) console.error(`- ${m}`);
  process.exit(1);
}

console.log('check-model-map: 一致（全チェック green）');
