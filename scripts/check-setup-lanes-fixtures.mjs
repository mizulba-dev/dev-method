import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  executeSetup,
  MAX_FILE_BYTES,
  resolveTargetPath,
} from '../src/plugin/skills/setup/scripts/setup-lanes.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skillRoot = join(repoRoot, 'src/plugin/skills/setup');
const checker = join(repoRoot, 'scripts/check-shared-clauses.mjs');
const workDir = join(repoRoot, '.work/2026-07-26-global-lane-setup');
const mutationDir = join(workDir, 'shared-clause-mutations');
const root = mkdtempSync(join(tmpdir(), 'dev-method-setup-'));
const asset = readFileSync(join(skillRoot, 'assets/global-lane-rules.md'), 'utf8').replace(/(?:\r?\n)+$/, '');
const version = JSON.parse(readFileSync(join(repoRoot, 'src/plugin/.claude-plugin/plugin.json'), 'utf8')).version;
const knownManual = readFileSync(
  join(skillRoot, 'references/known-manual-blocks/readme-0.1.62.md'),
  'utf8',
).replace(/(?:\r?\n)+$/, '');

let passed = 0;
let failed = 0;
const failures = [];
let driftPassed = 0;

function assertion(name, condition, detail = '') {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(`${name}${detail ? `: ${detail}` : ''}`);
  }
}

function targetPath(name, target = 'claude') {
  return join(root, name, target === 'claude' ? 'CLAUDE.md' : 'AGENTS.md');
}

function run(command, name, {
  target = 'claude',
  claudePath = targetPath(name, 'claude'),
  codexPath = targetPath(name, 'codex'),
  beforeRecheck,
  beforeCommitEntry,
  afterCommitEntry,
  beforeRestoreEntry,
  env = {},
  homeDir = join(root, name, 'home'),
  platform = process.platform,
} = {}) {
  return executeSetup({
    command,
    targets: target === 'all' ? ['claude', 'codex'] : [target],
    overrides: {
      ...(claudePath ? { claude: claudePath } : {}),
      ...(codexPath ? { codex: codexPath } : {}),
    },
    beforeRecheck,
    beforeCommitEntry,
    afterCommitEntry,
    beforeRestoreEntry,
    env,
    homeDir,
    platform,
  });
}

function write(path, body, mode = 0o640) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, mode);
}

function snapshot(path) {
  const stat = statSync(path);
  return {
    body: readFileSync(path),
    mode: stat.mode & 0o7777,
    ino: stat.ino,
  };
}

function sameSnapshot(path, before) {
  const after = snapshot(path);
  return before.body.equals(after.body) && before.mode === after.mode && before.ino === after.ino;
}

function block(eol = '\n') {
  return [
    `<!-- dev-method:implementation-lanes:start v${version} -->`,
    asset.replace(/\r?\n/g, eol),
    '<!-- dev-method:implementation-lanes:end -->',
  ].join(eol);
}

function noTempFiles(directory) {
  try {
    const entries = [];
    const visit = (path) => {
      for (const entry of readFileNames(path)) {
        const full = join(path, entry);
        if (lstatSync(full).isDirectory()) visit(full);
        else entries.push(entry);
      }
    };
    visit(directory);
    return entries.every((name) => !name.includes('.dev-method-'));
  } catch {
    return true;
  }
}

function readFileNames(path) {
  return readdirSync(path);
}

try {
  const posixHome = join(root, 'path-home');
  assertion('path-claude-config-precedence',
    resolveTargetPath('claude', {
      env: { CLAUDE_CONFIG_DIR: join(root, 'custom-claude') },
      homeDir: posixHome,
    }) === join(root, 'custom-claude/CLAUDE.md'));
  assertion('path-codex-home-precedence',
    resolveTargetPath('codex', {
      env: { CODEX_HOME: join(root, 'custom-codex') },
      homeDir: posixHome,
    }) === join(root, 'custom-codex/AGENTS.md'));
  assertion('path-default-roots-do-not-cross',
    resolveTargetPath('claude', { env: {}, homeDir: posixHome }) === join(posixHome, '.claude/CLAUDE.md')
    && resolveTargetPath('codex', { env: {}, homeDir: posixHome }) === join(posixHome, '.codex/AGENTS.md'));
  const bothRoots = {
    CLAUDE_CONFIG_DIR: join(root, 'both-roots/claude'),
    CODEX_HOME: join(root, 'both-roots/codex'),
  };
  assertion('path-target-values-do-not-cross',
    resolveTargetPath('claude', { env: bothRoots, homeDir: posixHome }) === join(bothRoots.CLAUDE_CONFIG_DIR, 'CLAUDE.md')
    && resolveTargetPath('codex', { env: bothRoots, homeDir: posixHome }) === join(bothRoots.CODEX_HOME, 'AGENTS.md'));
  assertion('path-override-highest-precedence',
    resolveTargetPath('claude', {
      env: { CLAUDE_CONFIG_DIR: join(root, 'ignored') },
      homeDir: posixHome,
      overrides: { claude: join(root, 'override/CLAUDE.md') },
    }) === join(root, 'override/CLAUDE.md'));
  assertion('path-windows-official-roots',
    resolveTargetPath('claude', {
      env: {},
      homeDir: 'C:\\Users\\fixture',
      platform: 'win32',
    }) === 'C:\\Users\\fixture\\.claude\\CLAUDE.md'
    && resolveTargetPath('codex', {
      env: { CODEX_HOME: 'D:\\CodexConfig' },
      homeDir: 'C:\\Users\\fixture',
      platform: 'win32',
    }) === 'D:\\CodexConfig\\AGENTS.md');

  const officialHome = join(root, 'official-root', 'home');
  const officialClaude = join(root, 'official-root', 'claude-config', 'CLAUDE.md');
  const officialCodex = join(root, 'official-root', 'codex-home', 'AGENTS.md');
  const officialResult = executeSetup({
    command: 'apply',
    targets: ['claude', 'codex'],
    env: {
      CLAUDE_CONFIG_DIR: dirname(officialClaude),
      CODEX_HOME: dirname(officialCodex),
    },
    homeDir: officialHome,
  });
  assertion('official-roots-apply', officialResult.exitCode === 0
    && statSync(officialClaude).isFile() && statSync(officialCodex).isFile());

  const freshPath = targetPath('fresh');
  const dryRunPath = targetPath('dry-run');
  const dryRun = run('dry-run', 'dry-run');
  assertion('dry-run-reports-without-writing', dryRun.exitCode === 1
    && dryRun.output.results[0].state === 'missing'
    && dryRun.output.results[0].action === 'add'
    && dryRun.output.results[0].diff.after.includes('implementation-lanes:start')
    && !existsSync(dryRunPath));

  const fresh = run('apply', 'fresh');
  assertion('new-file-apply', fresh.exitCode === 0 && fresh.output.results[0].action === 'add');
  assertion('new-file-mode-0600', (statSync(freshPath).mode & 0o7777) === 0o600);
  assertion('new-file-single-managed-block',
    readFileSync(freshPath, 'utf8') === block()
    && (readFileSync(freshPath, 'utf8').match(/implementation-lanes:start/g) || []).length === 1);
  const freshCheck = run('check', 'fresh');
  assertion('new-file-current-check', freshCheck.exitCode === 0
    && freshCheck.output.results[0].state === 'current'
    && freshCheck.output.results[0].path === freshPath);

  const appendCases = [
    ['lf-final', '前の日本語\n', '\n', true],
    ['lf-no-final', '前の日本語', '\n', false],
    ['crlf-final', '前の日本語\r\n', '\r\n', true],
    ['crlf-no-final', '前の日本語\r\n中間', '\r\n', false],
  ];
  for (const [name, original, eol, finalEol] of appendCases) {
    const path = targetPath(`append-${name}`);
    write(path, original, 0o644);
    const result = run('apply', `append-${name}`);
    const output = readFileSync(path, 'utf8');
    assertion(`append-${name}-success`, result.exitCode === 0);
    assertion(`append-${name}-preserves-prefix-and-eol`,
      output.startsWith(original)
      && output.includes(block(eol))
      && output.endsWith('\n') === finalEol);
    assertion(`append-${name}-mode`, (statSync(path).mode & 0o7777) === 0o644);
  }

  const idempotentPath = targetPath('idempotent');
  write(idempotentPath, 'ユーザー記述\n');
  assertion('idempotent-first-apply', run('apply', 'idempotent').exitCode === 0);
  const firstIdempotent = statSync(idempotentPath, { bigint: true });
  const firstIdempotentBody = readFileSync(idempotentPath);
  const secondIdempotent = run('apply', 'idempotent');
  const secondIdempotentStat = statSync(idempotentPath, { bigint: true });
  assertion('idempotent-second-noop', secondIdempotent.exitCode === 0
    && secondIdempotent.output.results[0].action === 'none'
    && firstIdempotentBody.equals(readFileSync(idempotentPath))
    && firstIdempotent.mtimeNs === secondIdempotentStat.mtimeNs);

  const staleVersionPath = targetPath('stale-version');
  write(staleVersionPath, `before\n${block().replace(`v${version}`, 'v0.0.1')}\nafter`, 0o600);
  const staleVersionCheck = run('check', 'stale-version');
  assertion('stale-version-detected', staleVersionCheck.exitCode === 1
    && staleVersionCheck.output.results[0].state === 'stale'
    && staleVersionCheck.output.results[0].detectedVersion === '0.0.1');
  assertion('stale-version-updated', run('apply', 'stale-version').exitCode === 0
    && readFileSync(staleVersionPath, 'utf8') === `before\n${block()}\nafter`);

  const staleBodyPath = targetPath('stale-body');
  write(staleBodyPath, `before\n${block().replace('typo・docs', 'typo・文書')}\nafter`);
  assertion('stale-body-detected', run('check', 'stale-body').output.results[0].state === 'stale');
  assertion('stale-body-updated-with-outside-preserved', run('apply', 'stale-body').exitCode === 0
    && readFileSync(staleBodyPath, 'utf8') === `before\n${block()}\nafter`);

  for (const eol of ['\n', '\r\n']) {
    const suffix = eol === '\n' ? 'lf' : 'crlf';
    const migrationPath = targetPath(`manual-${suffix}`);
    const manual = knownManual.replace(/\r?\n/g, eol);
    write(migrationPath, `before${eol}${manual}${eol}${eol}## その他${eol}after`, 0o640);
    const check = run('check', `manual-${suffix}`);
    assertion(`manual-${suffix}-detected`, check.exitCode === 1
      && check.output.results[0].state === 'unmanaged-match');
    assertion(`manual-${suffix}-migrated`, run('apply', `manual-${suffix}`).exitCode === 0
      && readFileSync(migrationPath, 'utf8') === `before${eol}${block(eol)}${eol}${eol}## その他${eol}after`
      && (statSync(migrationPath).mode & 0o7777) === 0o640);
  }

  const currentManualPath = targetPath('manual-current-asset');
  write(currentManualPath, asset);
  assertion('current-manual-asset-detected',
    run('check', 'manual-current-asset').output.results[0].state === 'unmanaged-match');
  assertion('current-manual-asset-migrated', run('apply', 'manual-current-asset').exitCode === 0
    && readFileSync(currentManualPath, 'utf8') === block());

  const unsafeManualCases = [
    ['one-character', knownManual.replace('typo', 'typoX')],
    ['section-addition', `${knownManual}\n- 個人追記`],
    ['unknown-version', '## 実装レーン\n\n- 未知の旧テンプレート'],
  ];
  for (const [name, body] of unsafeManualCases) {
    const path = targetPath(`unsafe-manual-${name}`);
    write(path, body);
    const before = snapshot(path);
    const result = run('apply', `unsafe-manual-${name}`);
    assertion(`unsafe-manual-${name}`, result.exitCode === 2
      && result.output.results[0].state === 'unsafe'
      && sameSnapshot(path, before));
  }

  const brokenCases = [
    ['start-only', '<!-- dev-method:implementation-lanes:start v0.1.0 -->\ntext'],
    ['end-only', `text\n<!-- dev-method:implementation-lanes:end -->`],
    ['reverse', `<!-- dev-method:implementation-lanes:end -->\n<!-- dev-method:implementation-lanes:start v0.1.0 -->`],
    ['nested', `<!-- dev-method:implementation-lanes:start v0.1.0 -->\n<!-- dev-method:implementation-lanes:start v0.1.0 -->\n<!-- dev-method:implementation-lanes:end -->`],
    ['multiple', `${block()}\n${block()}`],
  ];
  for (const [name, body] of brokenCases) {
    const path = targetPath(`broken-${name}`);
    write(path, body);
    const before = snapshot(path);
    const result = run('apply', `broken-${name}`);
    assertion(`broken-${name}-unsafe-unchanged`, result.exitCode === 2 && sameSnapshot(path, before));
  }
  assertion('check-unsafe-exit-2', run('check', 'broken-start-only').exitCode === 2);

  const directoryPath = targetPath('non-regular');
  mkdirSync(directoryPath, { recursive: true });
  assertion('non-regular-unsafe', run('apply', 'non-regular').exitCode === 2 && statSync(directoryPath).isDirectory());

  const danglingPath = targetPath('dangling');
  mkdirSync(dirname(danglingPath), { recursive: true });
  symlinkSync(join(root, 'does-not-exist'), danglingPath);
  const danglingLink = readlinkSync(danglingPath);
  assertion('dangling-symlink-unsafe', run('apply', 'dangling').exitCode === 2
    && lstatSync(danglingPath).isSymbolicLink() && readlinkSync(danglingPath) === danglingLink);

  const largePath = targetPath('large');
  write(largePath, Buffer.alloc(MAX_FILE_BYTES + 1, 0x61));
  const largeBefore = snapshot(largePath);
  assertion('size-limit-unsafe', run('apply', 'large').exitCode === 2 && sameSnapshot(largePath, largeBefore));

  const symlinkPath = targetPath('symlink');
  const symlinkReal = join(root, 'symlink', 'dotfiles', 'CLAUDE.md');
  write(symlinkReal, 'symlink user text', 0o644);
  mkdirSync(dirname(symlinkPath), { recursive: true });
  symlinkSync(symlinkReal, symlinkPath);
  const symlinkIno = lstatSync(symlinkPath).ino;
  const symlinkTarget = readlinkSync(symlinkPath);
  assertion('symlink-apply', run('apply', 'symlink').exitCode === 0);
  assertion('symlink-preserved', lstatSync(symlinkPath).isSymbolicLink()
    && lstatSync(symlinkPath).ino === symlinkIno
    && readlinkSync(symlinkPath) === symlinkTarget
    && readFileSync(symlinkReal, 'utf8').includes(block())
    && (statSync(symlinkReal).mode & 0o7777) === 0o644);

  for (const unsafeTarget of ['claude', 'codex']) {
    const name = `rollback-${unsafeTarget}`;
    const claudePath = targetPath(name, 'claude');
    const codexPath = targetPath(name, 'codex');
    write(claudePath, 'claude safe');
    write(codexPath, 'codex safe');
    const unsafePath = unsafeTarget === 'claude' ? claudePath : codexPath;
    write(unsafePath, '## 実装レーン\n\n個人編集');
    const claudeBefore = snapshot(claudePath);
    const codexBefore = snapshot(codexPath);
    const result = run('apply', name, { target: 'all', claudePath, codexPath });
    assertion(`rollback-${unsafeTarget}-all-unchanged`, result.exitCode === 2
      && sameSnapshot(claudePath, claudeBefore)
      && sameSnapshot(codexPath, codexBefore));
  }

  const raceName = 'rollback-race';
  const raceClaude = targetPath(raceName, 'claude');
  const raceCodex = targetPath(raceName, 'codex');
  write(raceClaude, 'claude before');
  write(raceCodex, 'codex before');
  const raceClaudeBefore = snapshot(raceClaude);
  const race = run('apply', raceName, {
    target: 'all',
    claudePath: raceClaude,
    codexPath: raceCodex,
    beforeRecheck: () => writeFileSync(raceCodex, 'external concurrent change'),
  });
  assertion('rollback-concurrent-change-before-write', race.exitCode === 2
    && race.output.error === 'concurrent_change'
    && sameSnapshot(raceClaude, raceClaudeBefore)
    && readFileSync(raceCodex, 'utf8') === 'external concurrent change');

  const commitRacePath = targetPath('commit-window-change');
  write(commitRacePath, 'initial content');
  const commitRace = run('apply', 'commit-window-change', {
    beforeCommitEntry: () => writeFileSync(commitRacePath, 'external commit-window change'),
  });
  assertion('commit-window-change-restored-without-overwrite',
    commitRace.exitCode === 2
    && commitRace.output.error === 'concurrent_change_commit'
    && commitRace.output.recoveryFailures.length === 0
    && readFileSync(commitRacePath, 'utf8') === 'external commit-window change');

  const commitCreatePath = targetPath('commit-window-create');
  const commitCreate = run('apply', 'commit-window-create', {
    beforeCommitEntry: () => write(commitCreatePath, 'external created file'),
  });
  assertion('commit-window-create-not-overwritten',
    commitCreate.exitCode === 2
    && commitCreate.output.error === 'concurrent_create_commit'
    && commitCreate.output.recoveryFailures.length === 0
    && readFileSync(commitCreatePath, 'utf8') === 'external created file');

  const writeFailureName = 'rollback-write-failure';
  const writeFailureClaude = targetPath(writeFailureName, 'claude');
  const writeFailureCodex = targetPath(writeFailureName, 'codex');
  write(writeFailureClaude, 'claude before');
  write(writeFailureCodex, 'codex before');
  const writeFailureClaudeBefore = snapshot(writeFailureClaude);
  const writeFailureCodexBefore = snapshot(writeFailureCodex);
  const writeFailure = run('apply', writeFailureName, {
    target: 'all',
    claudePath: writeFailureClaude,
    codexPath: writeFailureCodex,
    beforeCommitEntry: (index) => {
      if (index === 1) throw new Error('fixture_second_target_failure');
    },
  });
  assertion('rollback-second-target-write-failure', writeFailure.exitCode === 2
    && sameSnapshot(writeFailureClaude, writeFailureClaudeBefore)
    && sameSnapshot(writeFailureCodex, writeFailureCodexBefore)
    && noTempFiles(dirname(writeFailureClaude)));

  const restoreFailureName = 'rollback-restore-failure';
  const restoreFailureClaude = targetPath(restoreFailureName, 'claude');
  const restoreFailureCodex = targetPath(restoreFailureName, 'codex');
  write(restoreFailureClaude, 'claude original');
  write(restoreFailureCodex, 'codex original');
  const restoreFailure = run('apply', restoreFailureName, {
    target: 'all',
    claudePath: restoreFailureClaude,
    codexPath: restoreFailureCodex,
    afterCommitEntry: (index) => {
      if (index === 1) throw new Error('fixture_after_all_commits_failure');
    },
    beforeRestoreEntry: (index) => {
      if (index === 1) throw new Error('fixture_restore_failure');
    },
  });
  const retainedBackup = restoreFailure.output.recoveryBackups[0];
  assertion('rollback-restore-failure-retains-backup-and-path',
    restoreFailure.exitCode === 2
    && restoreFailure.output.recoveryFailures.length === 1
    && restoreFailure.output.recoveryFailures[0].path === restoreFailureCodex
    && typeof retainedBackup === 'string'
    && existsSync(retainedBackup)
    && readFileSync(retainedBackup, 'utf8') === 'codex original'
    && readFileSync(restoreFailureClaude, 'utf8') === 'claude original');
  if (typeof retainedBackup === 'string' && existsSync(retainedBackup)) {
    rmSync(restoreFailureCodex, { force: true });
    renameSync(retainedBackup, restoreFailureCodex);
  }

  const removeCases = [
    ['only-block', ''],
    ['lf-final', 'before\n\n', true],
    ['lf-no-final', 'before\n\nafter', false],
    ['crlf-final', '前\r\n\r\n', true],
    ['crlf-no-final', '前\r\n\r\n後', false],
  ];
  for (const [name, original] of removeCases) {
    const path = targetPath(`remove-${name}`);
    if (original !== '') write(path, original, 0o640);
    const apply = run('apply', `remove-${name}`);
    const remove = run('remove', `remove-${name}`);
    assertion(`remove-${name}-managed-only`, apply.exitCode === 0 && remove.exitCode === 0
      && readFileSync(path, 'utf8') === original
      && (original === '' || (statSync(path).mode & 0o7777) === 0o640));
    const beforeSecond = snapshot(path);
    assertion(`remove-${name}-second-noop`, run('remove', `remove-${name}`).exitCode === 0
      && sameSnapshot(path, beforeSecond));
  }

  const unmanagedRemovePath = targetPath('remove-unmanaged');
  write(unmanagedRemovePath, 'ユーザー本文');
  const unmanagedRemoveBefore = snapshot(unmanagedRemovePath);
  assertion('remove-does-not-touch-unmanaged', run('remove', 'remove-unmanaged').exitCode === 0
    && sameSnapshot(unmanagedRemovePath, unmanagedRemoveBefore));

  const bomPath = targetPath('utf8-bom');
  const bomOriginal = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('BOM付きユーザー本文\r\n', 'utf8'),
  ]);
  write(bomPath, bomOriginal, 0o640);
  const bomApply = run('apply', 'utf8-bom');
  const bomApplied = readFileSync(bomPath);
  const bomRemove = run('remove', 'utf8-bom');
  assertion('utf8-bom-preserved-through-apply-remove',
    bomApply.exitCode === 0
    && bomApplied.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
    && bomRemove.exitCode === 0
    && readFileSync(bomPath).equals(bomOriginal));

  const duplicatePath = targetPath('duplicate-resolved');
  write(duplicatePath, 'same target');
  const duplicateBefore = snapshot(duplicatePath);
  const duplicateResult = run('apply', 'duplicate-resolved', {
    target: 'all',
    claudePath: duplicatePath,
    codexPath: duplicatePath,
  });
  assertion('duplicate-resolved-target-unsafe', duplicateResult.exitCode === 2
    && sameSnapshot(duplicatePath, duplicateBefore));

  const cliPath = targetPath('cli-boundary');
  const cli = spawnSync(process.execPath, [
    join(skillRoot, 'scripts/setup-lanes.mjs'),
    'check',
    '--target', 'claude',
    '--claude-file', cliPath,
  ], { cwd: repoRoot, encoding: 'utf8' });
  const cliOutput = JSON.parse(cli.stdout);
  assertion('cli-check-boundary', cli.status === 1
    && cliOutput.results[0].state === 'missing'
    && cliOutput.results[0].path === cliPath);

  assertion('temporary-files-cleaned', noTempFiles(root));

  mkdirSync(mutationDir, { recursive: true });
  const mutationCases = [
    ['ship-criteria', (body) => body.replace('挙動に触れない:', '小さな変更:'), 'Ship判定基準'],
    ['show-criteria', (body) => body.replace('下位2レーンの基準に触れないすべて', '通常の変更'), 'Show判定基準'],
    ['sign-criteria', (body) => body.replace('DB migration', 'DB作業'), 'Sign判定基準'],
    ['seal-criteria', (body) => body.replace('外部影響', '影響'), 'Seal判定基準'],
    ['show-process', (body) => body.replace('プレレビュー**1回**', 'プレレビュー**2回**'), 'Show工程'],
    ['sign-process', (body) => body.replace('pre + cross を各1回', 'pre + cross を各2回'), 'Sign工程'],
  ];
  for (const [name, mutate, diagnostic] of mutationCases) {
    const specimen = join(mutationDir, `${name}.md`);
    writeFileSync(specimen, `${mutate(asset)}\n`);
    const result = spawnSync(process.execPath, [checker, '--lane-asset', specimen], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const detected = result.status === 1 && result.stderr.includes(`global asset: ${diagnostic}`);
    if (detected) driftPassed += 1;
    assertion(`shared-clause-${name}-detected`, detected,
      `exit=${result.status} stderr=${result.stderr.trim()}`);
  }
  const formattingSpecimen = join(mutationDir, 'formatting-equivalent.md');
  writeFileSync(formattingSpecimen, `${asset
    .replace('挙動に触れない:', '**挙動に触れない**:')
    .replace('DB migration', 'DB   migration')}\n`);
  const formattingResult = spawnSync(process.execPath, [checker, '--lane-asset', formattingSpecimen], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assertion('shared-clause-formatting-equivalent-accepted', formattingResult.status === 0,
    `exit=${formattingResult.status} stderr=${formattingResult.stderr.trim()}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`check-setup-lanes-fixtures: ${passed} pass, ${failed} fail; deliberate drifts ${driftPassed}/6`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`check-setup-lanes-fixtures: ${passed} pass, 0 fail; deliberate drifts ${driftPassed}/6`);
