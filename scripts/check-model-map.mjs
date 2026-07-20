import { readFileSync } from 'node:fs';

const ROLE_MODELS = {
  implementer: { claude: 'sonnet/medium', codex: 'gpt-5.6-terra/medium' },
  'implementer-high': { claude: 'opus/high', codex: 'gpt-5.6-sol/high' },
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

const ROUTING_CHECKS = [
  {
    description: 'implementer role が agent_type へ伝播する',
    regex: /対応 runtime では通常境界に `agent_type="implementer"`/,
  },
  {
    description: 'implementer-high role が agent_type へ伝播する',
    regex: /高リスク境界に `agent_type="implementer-high"` を渡す/,
  },
  {
    description: 'reviewer role が agent_type で選択される',
    regex: /対応 runtime では `agent_type="reviewer"`・`fork_turns="none"` を指定/,
  },
  {
    description: '実装 role 指定時に fork_turns=none を使う',
    regex: /どちらの runtime でも `fork_turns="none"` を指定する/,
  },
  {
    description: 'agent_type 非対応時は実装 role 本文を同梱して起動する',
    regex: /`agent_type` field が無い事前同期済み runtime では、`agent_type` を渡さず選択 role TOML の `developer_instructions` を message 冒頭へ同梱する/,
  },
  {
    description: 'agent_type 非対応時は reviewer 本文を同梱して起動する',
    regex: /`agent_type` field が無い事前同期済み runtime では、`agent_type` を渡さず reviewer TOML の `developer_instructions` を message 冒頭へ同梱し、`fork_turns="none"` で起動する/,
  },
  {
    description: 'task_name を role 選択子にしない',
    regex: /`task_name` は `implementer_1` \/ `implementer_high_1` のような lowercase 英数字と underscore の一意な作業名に限定し、role 選択子として扱わない/,
  },
  {
    description: 'reviewer task_name を一意名にして role 選択子にしない',
    regex: /`task_name` は `pre_review_1` \/ `pre_review_2` のような一意名にし、reviewer の role 選択子として扱わない/,
  },
  {
    description: '未対応 runtime の縮退を事前同期済み定義に限定する',
    regex: /`agent_type` field が無い環境では、3 role 定義がセッション開始前から同期済みだった場合に限り、未対応 runtime として/,
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
    regex: /対応 runtime では `model` \/ `reasoning_effort` を重複指定せず、role TOML を正本にする/,
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

const codexTeamImpl = readFileSync('src/plugin-codex/skills/team-impl/SKILL.md', 'utf8');
for (const check of ROUTING_CHECKS) {
  if (!check.regex.test(codexTeamImpl)) {
    mismatches.push(
      `src/plugin-codex/skills/team-impl/SKILL.md: routing契約「${check.description}」が見つからない`,
    );
  }
}

if (mismatches.length > 0) {
  console.error('モデル割当の不一致:');
  for (const m of mismatches) console.error(`- ${m}`);
  process.exit(1);
}

console.log('check-model-map: 一致（全チェック green）');
