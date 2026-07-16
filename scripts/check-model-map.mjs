import { readFileSync } from 'node:fs';

const ROLE_MODELS = {
  implementer: { claude: 'sonnet/medium', codex: 'gpt-5.6-terra/medium' },
  'implementer-high': { claude: 'opus/high', codex: 'gpt-5.6-sol/high' },
  reviewer: { claude: 'opus/high', codex: 'gpt-5.6-sol/high' },
  'cross-review': { fromCodex: 'opus/high', fromClaude: 'gpt-5.6-sol/high' },
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
    file: 'src/plugin-claude/agents/implementer-high.md',
    role: 'implementer-high',
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
    file: 'src/plugin-codex/skills/team-impl/implementer.toml',
    role: 'implementer',
    variant: 'codex',
    modelRegex: /^model\s*=\s*"([^"]+)"/,
    effortRegex: /^model_reasoning_effort\s*=\s*"([^"]+)"/,
  },
  {
    file: 'src/plugin-codex/skills/team-impl/implementer-high.toml',
    role: 'implementer-high',
    variant: 'codex',
    modelRegex: /^model\s*=\s*"([^"]+)"/,
    effortRegex: /^model_reasoning_effort\s*=\s*"([^"]+)"/,
  },
  {
    file: 'src/plugin-codex/skills/team-impl/reviewer.toml',
    role: 'reviewer',
    variant: 'codex',
    modelRegex: /^model\s*=\s*"([^"]+)"/,
    effortRegex: /^model_reasoning_effort\s*=\s*"([^"]+)"/,
  },
];

const PROSE_CHECKS = [
  {
    file: 'src/plugin-claude/skills/team-impl/SKILL.md',
    role: 'implementer',
    variant: 'claude',
    regex: /`implementer`(?!-high)（([^）]+)）/,
  },
  {
    file: 'src/plugin-claude/skills/team-impl/SKILL.md',
    role: 'implementer-high',
    variant: 'claude',
    regex: /`implementer-high`（([^）]+)）/,
  },
  {
    file: 'src/plugin-claude/skills/team-impl/SKILL.md',
    role: 'reviewer',
    variant: 'claude',
    regex: /model\s+(\w+)\s*\/\s*effort\s+(\w+)/,
    twoGroups: true,
  },
  {
    file: 'src/plugin-claude/skills/team-impl/SKILL.md',
    role: 'cross-review',
    variant: 'fromClaude',
    regex: /レビューは `cross-review` スキル（([^・]+)・/,
  },
  {
    file: 'src/plugin-codex/skills/team-impl/SKILL.md',
    role: 'implementer',
    variant: 'codex',
    regex: /`implementer`(?!-high)（([^）]+)）/,
  },
  {
    file: 'src/plugin-codex/skills/team-impl/SKILL.md',
    role: 'implementer-high',
    variant: 'codex',
    regex: /`implementer-high`（([^）]+)）/,
  },
  {
    file: 'src/plugin-codex/skills/team-impl/SKILL.md',
    role: 'reviewer',
    variant: 'codex',
    regex: /`reviewer` プロファイル（([^）]+)）/,
  },
  {
    file: 'src/plugin-codex/skills/team-impl/SKILL.md',
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
    role: 'implementer-high',
    variant: 'claude',
    regex: /\|\s*implementer-high（高リスク境界）\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/,
    groupIndex: 1,
  },
  {
    file: 'README.md',
    role: 'implementer-high',
    variant: 'codex',
    regex: /\|\s*implementer-high（高リスク境界）\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/,
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
    regex: /team-impl`（通常\s+([^・]+?)・高リスク\s+([^）]+?)）\+ implementer\/reviewer agents/,
    groupIndex: 1,
  },
  {
    file: 'README.md',
    role: 'implementer-high',
    variant: 'claude',
    regex: /team-impl`（通常\s+([^・]+?)・高リスク\s+([^）]+?)）\+ implementer\/reviewer agents/,
    groupIndex: 2,
  },
  {
    file: 'README.md',
    role: 'implementer',
    variant: 'codex',
    regex: /team-impl`（通常\s+([^・]+?)・高リスク\s+([^）]+?)）\+ implementer\/reviewer 定義/,
    groupIndex: 1,
  },
  {
    file: 'README.md',
    role: 'implementer-high',
    variant: 'codex',
    regex: /team-impl`（通常\s+([^・]+?)・高リスク\s+([^）]+?)）\+ implementer\/reviewer 定義/,
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

function normalizeSlashPair(raw) {
  const m = raw.match(/^(.+?)\s*\/\s*(\S+)$/);
  if (!m) return null;
  return normalize(m[1], m[2]);
}

function normalizeModelOnly(raw) {
  return raw.trim().toLowerCase().replace(/\s+/g, '-');
}

const mismatches = [];

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

if (mismatches.length > 0) {
  console.error('モデル割当の不一致:');
  for (const m of mismatches) console.error(`- ${m}`);
  process.exit(1);
}

console.log('check-model-map: 一致（全チェック green）');
