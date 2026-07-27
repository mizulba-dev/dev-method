#!/usr/bin/env node

import {
  closeSync,
  existsSync,
  fchmodSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MAX_FILE_BYTES = 1024 * 1024;
const START_PREFIX = '<!-- dev-method:implementation-lanes:start';
const END_MARKER = '<!-- dev-method:implementation-lanes:end -->';
const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(HERE, '..');
const PLUGIN_ROOT = resolve(SKILL_ROOT, '../..');
const ASSET_PATH = join(SKILL_ROOT, 'assets/global-lane-rules.md');
const KNOWN_MANUAL_DIR = join(SKILL_ROOT, 'references/known-manual-blocks');
const MANUAL_HEADING = /^## 実装レーン[ \t]*$/gm;
const decoder = new TextDecoder('utf-8', { fatal: true });

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function hasUtf8Bom(buffer) {
  return buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
}

function encodeText(text, bom) {
  const body = Buffer.from(text, 'utf8');
  return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
}

function trimFinalEols(text) {
  return text.replace(/(?:\r?\n)+$/, '');
}

function loadInputs() {
  const claudeManifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin/plugin.json'), 'utf8'));
  const codexManifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.codex-plugin/plugin.json'), 'utf8'));
  if (claudeManifest.version !== codexManifest.version) {
    throw new Error('plugin_manifest_version_mismatch');
  }
  const asset = trimFinalEols(readFileSync(ASSET_PATH, 'utf8'));
  if (asset.includes(START_PREFIX) || asset.includes(END_MARKER)) {
    throw new Error('asset_marker_forbidden');
  }
  const knownManualBlocks = readdirSync(KNOWN_MANUAL_DIR)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => ({
      name,
      text: trimFinalEols(readFileSync(join(KNOWN_MANUAL_DIR, name), 'utf8')),
    }))
    .concat({ name: 'current-asset', text: asset });
  return { version: claudeManifest.version, asset, knownManualBlocks };
}

export function resolveTargetPath(target, {
  env = process.env,
  homeDir = homedir(),
  platform = process.platform,
  overrides = {},
} = {}) {
  if (overrides[target]) return resolve(overrides[target]);
  const pathApi = platform === 'win32' ? win32 : { join };
  if (target === 'claude') {
    return pathApi.join(env.CLAUDE_CONFIG_DIR || pathApi.join(homeDir, '.claude'), 'CLAUDE.md');
  }
  if (target === 'codex') {
    return pathApi.join(env.CODEX_HOME || pathApi.join(homeDir, '.codex'), 'AGENTS.md');
  }
  throw new Error(`unknown_target:${target}`);
}

function eolOf(text) {
  const first = text.match(/\r\n|\n/);
  return first?.[0] || '\n';
}

function withEol(text, eol) {
  return text.replace(/\r\n|\n/g, eol);
}

function managedBlock(version, asset, eol) {
  return [
    `<!-- dev-method:implementation-lanes:start v${version} -->`,
    withEol(asset, eol),
    END_MARKER,
  ].join(eol);
}

function ownerIsCurrent(stat) {
  return typeof process.getuid !== 'function' || stat.uid === process.getuid();
}

function nearestExistingAncestor(path) {
  let cursor = dirname(path);
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return cursor;
}

function unsafe(target, path, reason, extra = {}) {
  return {
    target,
    path,
    resolvedPath: extra.resolvedPath || path,
    state: 'unsafe',
    detectedVersion: extra.detectedVersion || null,
    reason,
    action: 'none',
    ...extra,
  };
}

function diagnosticMessage(reason) {
  if (!reason) return null;
  const messages = {
    dangling_symlink: 'symlink のリンク先が存在しないため停止しました',
    non_regular_file: '対象が regular file ではないため停止しました',
    owner_mismatch: '対象または設定 root の所有者が現在のユーザーではないため停止しました',
    size_limit_exceeded: `対象がサイズ上限 ${MAX_FILE_BYTES} bytes を超えるため停止しました`,
    parent_not_directory: '対象の親 path が directory ではないため停止しました',
    invalid_utf8: '対象を UTF-8 テキストとして安全に読めないため停止しました',
    managed_marker_shape: '管理マーカーの片側欠落・重複・形式不正を検出したため停止しました',
    managed_marker_order: '管理マーカーの順序が不正なため停止しました',
    unmanaged_manual_block_unknown: '既知テンプレートと完全一致しない実装レーン節を検出したため停止しました',
    duplicate_resolved_target: '複数 target が同じ実体ファイルを指すため停止しました',
    concurrent_change: '事前検査後の競合変更を検出したため書き込みを開始しませんでした',
    concurrent_change_commit: 'commit直前の競合変更を検出し、全targetを復旧して停止しました',
    concurrent_create_commit: 'commit直前にtargetが作成されたため、上書きせず全targetを復旧して停止しました',
  };
  if (messages[reason]) return messages[reason];
  if (reason.startsWith('stat_failed:')) return '対象の状態を安全に取得できないため停止しました';
  if (reason.startsWith('parent_stat_failed:')) return '設定 root の状態を安全に取得できないため停止しました';
  if (reason.startsWith('read_failed:')) return '対象を安全に読み取れないため停止しました';
  if (reason.startsWith('write_failed:')) return '原子的な書き込みに失敗し、変更を復旧して停止しました';
  return '安全条件を満たさないため停止しました';
}

function countLiteral(text, value) {
  let count = 0;
  let from = 0;
  while ((from = text.indexOf(value, from)) !== -1) {
    count += 1;
    from += value.length;
  }
  return count;
}

function inspectTarget(target, path, inputs) {
  let pathStat = null;
  let resolvedPath = path;
  let realStat = null;
  let symlinkTarget = null;
  try {
    pathStat = lstatSync(path);
    if (!ownerIsCurrent(pathStat)) {
      return unsafe(target, path, 'owner_mismatch');
    }
    if (pathStat.isSymbolicLink()) {
      symlinkTarget = readlinkSync(path);
      try {
        resolvedPath = realpathSync(path);
        realStat = statSync(resolvedPath);
      } catch {
        return unsafe(target, path, 'dangling_symlink', { symlinkTarget });
      }
    } else {
      realStat = pathStat;
    }
    if (!realStat.isFile()) {
      return unsafe(target, path, 'non_regular_file', { resolvedPath, symlinkTarget });
    }
    if (!ownerIsCurrent(realStat)) {
      return unsafe(target, path, 'owner_mismatch', { resolvedPath, symlinkTarget });
    }
    if (realStat.size > MAX_FILE_BYTES) {
      return unsafe(target, path, 'size_limit_exceeded', { resolvedPath, symlinkTarget });
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return unsafe(target, path, `stat_failed:${error?.code || error?.message}`);
    }
    const ancestor = nearestExistingAncestor(path);
    try {
      const ancestorStat = statSync(ancestor);
      if (!ancestorStat.isDirectory()) return unsafe(target, path, 'parent_not_directory');
      if (!ownerIsCurrent(ancestorStat)) return unsafe(target, path, 'owner_mismatch');
      resolvedPath = join(realpathSync(ancestor), relative(ancestor, path));
    } catch (ancestorError) {
      return unsafe(target, path, `parent_stat_failed:${ancestorError?.code || ancestorError?.message}`);
    }
  }

  let buffer = Buffer.alloc(0);
  let text = '';
  let bom = false;
  if (realStat) {
    try {
      buffer = readFileSync(resolvedPath);
      if (buffer.length > MAX_FILE_BYTES) {
        return unsafe(target, path, 'size_limit_exceeded', { resolvedPath, symlinkTarget });
      }
      bom = hasUtf8Bom(buffer);
      text = decoder.decode(bom ? buffer.subarray(3) : buffer);
    } catch (error) {
      return unsafe(target, path, error instanceof TypeError ? 'invalid_utf8' : `read_failed:${error?.code || error?.message}`, {
        resolvedPath,
        symlinkTarget,
      });
    }
  }

  const startCandidates = countLiteral(text, START_PREFIX);
  const endCount = countLiteral(text, END_MARKER);
  const validStarts = [...text.matchAll(/<!-- dev-method:implementation-lanes:start v([^\s>]+) -->/g)];
  if (startCandidates !== 0 || endCount !== 0) {
    if (startCandidates !== 1 || endCount !== 1 || validStarts.length !== 1) {
      return unsafe(target, path, 'managed_marker_shape', { resolvedPath, symlinkTarget });
    }
    const start = validStarts[0].index;
    const endStart = text.indexOf(END_MARKER);
    if (endStart < start) {
      return unsafe(target, path, 'managed_marker_order', { resolvedPath, symlinkTarget });
    }
    const end = endStart + END_MARKER.length;
    const eol = eolOf(text);
    const expected = managedBlock(inputs.version, inputs.asset, eol);
    const actual = text.slice(start, end);
    const state = actual === expected ? 'current' : 'stale';
    return finishInspection({
      target,
      path,
      resolvedPath,
      state,
      detectedVersion: validStarts[0][1],
      action: state === 'current' ? 'none' : 'update',
      before: actual,
      after: expected,
      outputText: state === 'current' ? text : `${text.slice(0, start)}${expected}${text.slice(end)}`,
      buffer,
      text,
      pathStat,
      realStat,
      symlinkTarget,
      managedRange: [start, end],
      eol,
      bom,
    });
  }

  const headings = [...text.matchAll(MANUAL_HEADING)];
  const headingCount = headings.length;
  let manualMatch = null;
  if (headingCount === 1) {
    const start = headings[0].index;
    const afterHeading = start + headings[0][0].length;
    const followingHeading = text.slice(afterHeading).match(/\r?\n#{1,2}[ \t]+/);
    const sectionEnd = followingHeading
      ? afterHeading + followingHeading.index
      : text.length;
    const rawSection = text.slice(start, sectionEnd);
    const section = rawSection.replace(/(?:\r?\n)+$/, '');
    const known = inputs.knownManualBlocks.find((candidate) => (
      withEol(candidate.text, eolOf(text)) === section
    ));
    if (known) manualMatch = { ...known, text: section, start, end: start + section.length };
  }
  if (headingCount > 0) {
    if (headingCount !== 1 || !manualMatch) {
      return unsafe(target, path, 'unmanaged_manual_block_unknown', { resolvedPath, symlinkTarget });
    }
    const match = manualMatch;
    const eol = eolOf(text);
    const expected = managedBlock(inputs.version, inputs.asset, eol);
    return finishInspection({
      target,
      path,
      resolvedPath,
      state: 'unmanaged-match',
      detectedVersion: null,
      action: 'migrate',
      before: match.text,
      after: expected,
      outputText: `${text.slice(0, match.start)}${expected}${text.slice(match.end)}`,
      buffer,
      text,
      pathStat,
      realStat,
      symlinkTarget,
      eol,
      bom,
    });
  }

  const eol = eolOf(text);
  const expected = managedBlock(inputs.version, inputs.asset, eol);
  const hadFinalEol = text.endsWith('\n');
  let outputText;
  if (text.length === 0) {
    outputText = expected;
  } else if (hadFinalEol) {
    outputText = `${text}${expected}${eol}`;
  } else {
    outputText = `${text}${eol}${expected}`;
  }
  return finishInspection({
    target,
    path,
    resolvedPath,
    state: 'missing',
    detectedVersion: null,
    action: 'add',
    before: '',
    after: expected,
    outputText,
    buffer,
    text,
    pathStat,
    realStat,
    symlinkTarget,
    eol,
    bom,
  });
}

function finishInspection(value) {
  const mode = value.realStat ? value.realStat.mode & 0o7777 : 0o600;
  return {
    ...value,
    exists: Boolean(value.realStat),
    mode,
    fingerprint: {
      exists: Boolean(value.realStat),
      content: sha256(value.buffer),
      size: value.buffer.length,
      mode,
      resolvedPath: value.resolvedPath,
      pathIno: value.pathStat?.ino || null,
      realIno: value.realStat?.ino || null,
      realDev: value.realStat?.dev || null,
      mtimeMs: value.realStat?.mtimeMs || null,
      ctimeMs: value.realStat?.ctimeMs || null,
      symlinkTarget: value.symlinkTarget,
    },
  };
}

function publicResult(item, includeDiff = false) {
  const result = {
    target: item.target,
    path: item.path,
    resolvedPath: item.resolvedPath,
    state: item.state,
    detectedVersion: item.detectedVersion || null,
    reason: item.reason || null,
    message: diagnosticMessage(item.reason),
    action: item.action,
  };
  if (includeDiff && item.state !== 'unsafe') {
    result.diff = { before: item.before || '', after: item.after || '' };
  }
  return result;
}

function sameFingerprint(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function backupMatchesInitial(path, item) {
  const stat = statSync(path);
  const body = readFileSync(path);
  return sha256(body) === item.fingerprint.content
    && body.length === item.fingerprint.size
    && (stat.mode & 0o7777) === item.fingerprint.mode
    && stat.dev === item.fingerprint.realDev
    && stat.ino === item.fingerprint.realIno
    && stat.mtimeMs === item.fingerprint.mtimeMs;
}

function removeManagedBlock(item) {
  if (!item.managedRange) return item.text;
  const [start, end] = item.managedRange;
  let prefix = item.text.slice(0, start);
  let suffix = item.text.slice(end);
  const originalHadFinalEol = item.text.endsWith('\n');

  if (prefix.length === 0) {
    suffix = suffix.replace(/^(?:\r\n|\n)/, '');
  } else if (suffix.length === 0) {
    prefix = prefix.replace(/(?:\r\n|\n)$/, '');
  } else if (prefix.endsWith('\n') && /^(?:\r\n|\n)/.test(suffix)) {
    suffix = suffix.replace(/^(?:\r\n|\n)/, '');
  }
  let output = `${prefix}${suffix}`;
  if (originalHadFinalEol && output.length > 0 && !output.endsWith('\n')) output += item.eol;
  if (!originalHadFinalEol && output.endsWith('\n')) output = output.replace(/(?:\r\n|\n)$/, '');
  return output;
}

function uniqueTempPath(path, label) {
  return join(dirname(path), `.${basename(path)}.dev-method-${label}-${process.pid}-${Math.random().toString(16).slice(2)}`);
}

function ensureDirectory(path) {
  const missing = [];
  let cursor = path;
  while (!existsSync(cursor)) {
    missing.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  mkdirSync(path, { recursive: true });
  return missing;
}

function cleanupCreatedDirectories(paths) {
  for (const path of paths) {
    try {
      rmdirSync(path);
    } catch {
      // A non-empty directory may contain a concurrent user file; never remove it.
    }
  }
}

function stageWrites(items) {
  const staged = [];
  const createdDirectories = [];
  try {
    for (const item of items) {
      const parent = dirname(item.resolvedPath);
      createdDirectories.push(...ensureDirectory(parent));
      const stagePath = uniqueTempPath(item.resolvedPath, 'stage');
      const fd = openSync(stagePath, 'wx', 0o600);
      const entry = { item, stagePath, backupPath: null, committed: false };
      staged.push(entry);
      const stagedBody = encodeText(item.nextText, item.bom);
      try {
        writeFileSync(fd, stagedBody);
        fchmodSync(fd, item.mode);
      } finally {
        closeSync(fd);
      }
      const stageStat = statSync(stagePath);
      entry.installedFingerprint = {
        dev: stageStat.dev,
        ino: stageStat.ino,
        mode: stageStat.mode & 0o7777,
        size: stagedBody.length,
        content: sha256(stagedBody),
      };
    }
    return { staged, createdDirectories };
  } catch (error) {
    for (const entry of staged) rmSync(entry.stagePath, { force: true });
    cleanupCreatedDirectories(createdDirectories);
    throw error;
  }
}

function commitError(code, message) {
  const error = new Error(message);
  error.commitCode = code;
  return error;
}

function installedTargetIsOurs(entry) {
  try {
    const stat = lstatSync(entry.item.resolvedPath);
    const body = readFileSync(entry.item.resolvedPath);
    return stat.isFile()
      && stat.dev === entry.installedFingerprint.dev
      && stat.ino === entry.installedFingerprint.ino
      && (stat.mode & 0o7777) === entry.installedFingerprint.mode
      && body.length === entry.installedFingerprint.size
      && sha256(body) === entry.installedFingerprint.content;
  } catch {
    return false;
  }
}

function restoreEntry(entry, index, beforeRestoreEntry) {
  beforeRestoreEntry?.(index, entry.item, entry.backupPath);
  if (entry.committed) {
    if (!installedTargetIsOurs(entry)) {
      throw new Error('installed_target_changed');
    }
    unlinkSync(entry.item.resolvedPath);
    entry.committed = false;
  } else if (existsSync(entry.item.resolvedPath)) {
    throw new Error('restore_target_occupied');
  }
  if (entry.backupPath) {
    renameSync(entry.backupPath, entry.item.resolvedPath);
    entry.backupPath = null;
  }
}

function rollbackEntries(staged, beforeRestoreEntry) {
  const failures = [];
  for (let index = staged.length - 1; index >= 0; index -= 1) {
    const entry = staged[index];
    if (!entry.committed && !entry.backupPath) continue;
    try {
      restoreEntry(entry, index, beforeRestoreEntry);
    } catch (error) {
      failures.push({
        target: entry.item.target,
        path: entry.item.resolvedPath,
        backupPath: entry.backupPath,
        reason: error?.message || String(error),
      });
    }
  }
  return failures;
}

function installWithoutOverwrite(entry) {
  try {
    linkSync(entry.stagePath, entry.item.resolvedPath);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw commitError('concurrent_create_commit', `commit窓でtargetが作成されました: ${entry.item.target}`);
    }
    throw error;
  }
  unlinkSync(entry.stagePath);
  entry.committed = true;
}

function commitWrites(
  { staged, createdDirectories },
  beforeCommitEntry,
  afterCommitEntry,
  beforeRestoreEntry,
) {
  let succeeded = false;
  try {
    for (let index = 0; index < staged.length; index += 1) {
      const entry = staged[index];
      beforeCommitEntry?.(index, entry.item);
      const { item, stagePath } = entry;
      if (item.exists) {
        entry.backupPath = uniqueTempPath(item.resolvedPath, 'backup');
        renameSync(item.resolvedPath, entry.backupPath);
        if (!backupMatchesInitial(entry.backupPath, item)) {
          throw commitError('concurrent_change_commit', `commit窓でtargetが変更されました: ${item.target}`);
        }
      }
      installWithoutOverwrite(entry);
      afterCommitEntry?.(index, entry.item);
    }
    succeeded = true;
  } catch (error) {
    error.recoveryFailures = rollbackEntries(staged, beforeRestoreEntry);
    throw error;
  } finally {
    for (const entry of staged) {
      rmSync(entry.stagePath, { force: true });
      if (succeeded && entry.backupPath) {
        rmSync(entry.backupPath, { force: true });
        entry.backupPath = null;
      }
    }
    if (!succeeded) cleanupCreatedDirectories(createdDirectories);
  }
}

export function executeSetup({
  command,
  targets,
  env = process.env,
  homeDir = homedir(),
  platform = process.platform,
  overrides = {},
  beforeRecheck,
  beforeCommitEntry,
  afterCommitEntry,
  beforeRestoreEntry,
} = {}) {
  const inputs = loadInputs();
  const paths = targets.map((target) => resolveTargetPath(target, { env, homeDir, platform, overrides }));
  const initial = targets.map((target, index) => inspectTarget(target, paths[index], inputs));
  const resolvedIdentities = initial
    .filter((item) => item.state !== 'unsafe')
    .map((item) => item.exists
      ? `${item.fingerprint.realDev}:${item.fingerprint.realIno}`
      : `path:${item.resolvedPath}`);
  if (new Set(resolvedIdentities).size !== resolvedIdentities.length) {
    return {
      exitCode: 2,
      output: {
        command,
        version: inputs.version,
        results: initial.map((item) => publicResult(item)).concat([{
          state: 'unsafe',
          reason: 'duplicate_resolved_target',
          message: diagnosticMessage('duplicate_resolved_target'),
        }]),
      },
    };
  }
  if (initial.some((item) => item.state === 'unsafe')) {
    return {
      exitCode: 2,
      output: { command, version: inputs.version, results: initial.map((item) => publicResult(item, command === 'dry-run')) },
    };
  }

  if (command === 'check') {
    return {
      exitCode: initial.every((item) => item.state === 'current') ? 0 : 1,
      output: { command, version: inputs.version, results: initial.map((item) => publicResult(item)) },
    };
  }
  if (command === 'dry-run') {
    return {
      exitCode: initial.every((item) => item.state === 'current') ? 0 : 1,
      output: { command, version: inputs.version, results: initial.map((item) => publicResult(item, true)) },
    };
  }
  if (!['apply', 'remove'].includes(command)) {
    return { exitCode: 2, output: { command, error: 'unknown_command' } };
  }

  const writeItems = initial
    .filter((item) => command === 'apply'
      ? item.state !== 'current'
      : Boolean(item.managedRange))
    .map((item) => ({
      ...item,
      nextText: command === 'apply' ? item.outputText : removeManagedBlock(item),
    }));
  if (writeItems.length === 0) {
    return {
      exitCode: 0,
      output: { command, version: inputs.version, results: initial.map((item) => ({ ...publicResult(item), action: 'none' })) },
    };
  }

  beforeRecheck?.();
  const rechecked = targets.map((target, index) => inspectTarget(target, paths[index], inputs));
  const conflict = rechecked.some((item, index) => (
    item.state === 'unsafe'
    || !sameFingerprint(item.fingerprint, initial[index].fingerprint)
  ));
  if (conflict) {
    return {
      exitCode: 2,
      output: {
        command,
        version: inputs.version,
        error: 'concurrent_change',
        message: diagnosticMessage('concurrent_change'),
        results: rechecked.map((item) => publicResult(item)),
      },
    };
  }

  try {
    commitWrites(
      stageWrites(writeItems),
      beforeCommitEntry,
      afterCommitEntry,
      beforeRestoreEntry,
    );
  } catch (error) {
    const reason = error?.commitCode || `write_failed:${error?.code || error?.message}`;
    const recoveryFailures = error?.recoveryFailures || [];
    return {
      exitCode: 2,
      output: {
        command,
        version: inputs.version,
        error: reason,
        message: diagnosticMessage(reason),
        recoveryFailures,
        recoveryBackups: recoveryFailures
          .map((failure) => failure.backupPath)
          .filter(Boolean),
        results: initial.map((item) => publicResult(item)),
      },
    };
  }
  return {
    exitCode: 0,
    output: {
      command,
      version: inputs.version,
      results: initial.map((item) => ({
        ...publicResult(item),
        action: writeItems.some((writeItem) => writeItem.target === item.target)
          ? (command === 'remove' ? 'remove' : item.action)
          : 'none',
      })),
    },
  };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const parsed = { command, target: null, overrides: {} };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--target') parsed.target = rest[++index];
    else if (arg === '--claude-file') parsed.overrides.claude = rest[++index];
    else if (arg === '--codex-file') parsed.overrides.codex = rest[++index];
    else throw new Error(`unknown_option:${arg}`);
  }
  if (!['check', 'dry-run', 'apply', 'remove'].includes(command)) throw new Error('usage');
  if (!['claude', 'codex', 'all'].includes(parsed.target)) throw new Error('target_required');
  return parsed;
}

function cli(argv) {
  try {
    const parsed = parseArgs(argv);
    const targets = parsed.target === 'all' ? ['claude', 'codex'] : [parsed.target];
    const result = executeSetup({
      command: parsed.command,
      targets,
      overrides: parsed.overrides,
    });
    const stream = result.exitCode === 2 ? process.stderr : process.stdout;
    stream.write(`${JSON.stringify(result.output, null, 2)}\n`);
    return result.exitCode;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      error: error?.message || String(error),
      message: '引数または setup 入力が不正なため停止しました',
    })}\n`);
    return 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = cli(process.argv.slice(2));
}
