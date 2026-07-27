#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const FORMAT_VERSION = 2;
const SOURCE_CHECKER = fileURLToPath(import.meta.url);
const SOURCE_DIR = dirname(SOURCE_CHECKER);
const SOURCE_SCHEMA = join(SOURCE_DIR, 'evidence-package-schema.json');
const SOURCE_LEDGER_SCHEMA = join(SOURCE_DIR, 'review-ledger-schema.json');
const SOURCE_FINGERPRINT = resolve(SOURCE_DIR, '../../cross-review/references/review-diff-fingerprint.mjs');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_RE = /^[0-9a-f]{64}$/;
const CONTRACT_RE = /^EC-[A-Z0-9]+-[0-9]+$/;

class DiagnosticError extends Error {
  constructor(diagnostic, message, exitCode = 1, details = undefined) {
    super(message);
    this.diagnostic = diagnostic;
    this.exitCode = exitCode;
    this.details = details;
  }
}

function fail(diagnostic, message, details) {
  throw new DiagnosticError(diagnostic, message, 1, details);
}

function sha256Buffer(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(path) {
  return sha256Buffer(readFileSync(path));
}

function readJson(path, diagnostic = 'json_invalid') {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(diagnostic, `${path}: JSONを解釈できません: ${error.message}`);
  }
}

function atomicWriteJson(path, value, exclusive = false) {
  mkdirSync(dirname(path), { recursive: true });
  if (exclusive && existsSync(path)) fail('marker_conflict', `既存マーカーを上書きできません: ${path}`);
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: exclusive ? 'wx' : 'w' });
  renameSync(temp, path);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  return result;
}

function gitRoot(start = process.cwd()) {
  const result = run('git', ['rev-parse', '--show-toplevel'], { cwd: start });
  if (result.status !== 0) fail('not_git_repository', result.stderr.trim() || 'gitリポジトリではありません');
  return realpathSync(result.stdout.trim());
}

function requireAbsolute(value, name) {
  if (!value || !isAbsolute(value)) fail('absolute_path_required', `${name}には絶対パスが必要です`);
  return resolve(value);
}

function parseCli(argv) {
  const [mode, ...tokens] = argv;
  if (!mode) fail('usage', 'モードが必要です');
  const options = new Map();
  const command = [];
  let afterSeparator = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (afterSeparator) {
      command.push(token);
      continue;
    }
    if (token === '--') {
      afterSeparator = true;
      continue;
    }
    if (!token.startsWith('--')) fail('usage', `未知の位置引数です: ${token}`);
    const value = tokens[i + 1];
    if (value === undefined || value === '--' || value.startsWith('--')) fail('usage', `${token}の値が必要です`);
    i += 1;
    const key = token.slice(2);
    const current = options.get(key);
    options.set(key, current === undefined ? value : Array.isArray(current) ? [...current, value] : [current, value]);
  }
  return { mode, options, command };
}

function option(options, key, required = false) {
  const value = options.get(key);
  if (required && value === undefined) fail('usage', `--${key}が必要です`);
  if (Array.isArray(value)) fail('usage', `--${key}は1回だけ指定してください`);
  return value;
}

function optionsList(options, key) {
  const value = options.get(key);
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function assertKnownOptions(options, allowed) {
  for (const key of options.keys()) {
    if (!allowed.includes(key)) fail('usage', `未知のオプションです: --${key}`);
  }
}

function reviewPaths(reviewDir) {
  const parent = dirname(reviewDir);
  const toolingDir = join(reviewDir, 'evidence', 'tooling');
  return {
    parent,
    toolingDir,
    manifest: join(toolingDir, 'tooling-manifest.json'),
    checker: join(toolingDir, 'check-evidence-package.mjs'),
    schema: join(toolingDir, 'evidence-package-schema.json'),
    ledger_schema: join(toolingDir, 'review-ledger-schema.json'),
    fingerprint: join(toolingDir, 'review-diff-fingerprint.mjs'),
    complete: join(reviewDir, 'review-unit-complete.json'),
    revoked: join(reviewDir, 'revoked.json'),
    forcedRegistry: join(parent, '.review-revocations'),
    abandonmentRegistry: join(parent, '.review-abandonments'),
  };
}

function readHeader(manifestPath) {
  if (!existsSync(manifestPath)) return null;
  try {
    const value = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const formatVersion = value?.format_version;
    const reviewUnitId = value?.review_unit_id;
    if (!Number.isInteger(formatVersion) || typeof reviewUnitId !== 'string') return null;
    return { format_version: formatVersion, review_unit_id: reviewUnitId };
  } catch {
    return null;
  }
}

function filesRecursively(root) {
  if (!existsSync(root)) return [];
  const output = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile()) output.push(path);
    }
  }
  return output;
}

function idsInFiles(paths) {
  const ids = new Set();
  for (const path of paths) {
    const text = readFileSync(path, 'utf8');
    for (const match of text.matchAll(/"review_unit_id"\s*:\s*"([0-9a-f-]{36})"/gi)) {
      if (UUID_RE.test(match[1])) ids.add(match[1]);
    }
  }
  return [...ids];
}

function recoverReviewUnitId(reviewDir) {
  const paths = reviewPaths(reviewDir);
  const header = readHeader(paths.manifest);
  if (header && UUID_RE.test(header.review_unit_id)) return header.review_unit_id;
  const evidenceFiles = filesRecursively(join(reviewDir, 'evidence'))
    .filter((path) => path !== paths.manifest && !path.startsWith(`${paths.toolingDir}${sep}`));
  const categories = [
    evidenceFiles.filter((path) => basename(path).includes('bootstrap')),
    evidenceFiles.filter((path) => /(?:prompt|result|ledger)/.test(basename(path))),
    evidenceFiles.filter((path) => /manifest.*\.json$|\.jsonl$/.test(basename(path))),
  ];
  for (const category of categories) {
    const ids = idsInFiles(category);
    if (ids.length > 1) fail('revoke_review_unit_ambiguous', '証跡から複数のreview_unit_idが見つかりました');
    if (ids.length === 1) return ids[0];
  }
  return null;
}

function validateRevokedMarker(marker) {
  return marker && marker.format_version === 1 && UUID_RE.test(marker.review_unit_id)
    && typeof marker.superseded_by === 'string' && marker.superseded_by.length > 0
    && ['fixed-checker', 'source-fallback'].includes(marker.created_by);
}

function validateForcedMarker(marker) {
  return marker && marker.format_version === 1 && marker.kind === 'forced_revoke'
    && marker.created_by === 'forced-revoke-cli'
    && UUID_RE.test(marker.review_unit_id) && isAbsolute(marker.canonical_review_dir)
    && typeof marker.superseded_by === 'string' && marker.superseded_by.length > 0
    && typeof marker.reason === 'string' && marker.reason.length > 0
    && typeof marker.approved_by === 'string' && marker.approved_by.length > 0
    && !Number.isNaN(Date.parse(marker.approved_at));
}

function validateAbandonmentMarker(marker) {
  if (!marker || marker.format_version !== 1 || !['unidentified', 'forced_revoke_unwritable'].includes(marker.kind)
    || typeof marker.canonical_review_dir !== 'string' || !isAbsolute(marker.canonical_review_dir) || typeof marker.superseded_by !== 'string'
    || typeof marker.reason !== 'string' || typeof marker.approved_by !== 'string'
    || Number.isNaN(Date.parse(marker.approved_at))) return false;
  if (marker.kind === 'forced_revoke_unwritable') {
    return UUID_RE.test(marker.review_unit_id) && typeof marker.forced_revoke_diagnostic === 'string'
      && marker.forced_revoke_diagnostic.length > 0;
  }
  return marker.review_unit_id === undefined;
}

function checkRevocation(reviewDir) {
  const paths = reviewPaths(reviewDir);
  const header = readHeader(paths.manifest);
  if (existsSync(paths.revoked)) {
    const marker = readJson(paths.revoked, 'revoked_marker_invalid');
    if (!validateRevokedMarker(marker)) fail('revoked_marker_invalid', 'revoked.jsonが固定最小schemaに適合しません');
    if (header && marker.review_unit_id !== header.review_unit_id) {
      fail('revoked_review_unit_mismatch', 'revoked.jsonのreview_unit_idが固定ヘッダーと一致しません');
    }
    fail('revoked_review_unit', `失効済みreview unitです: ${marker.superseded_by}`);
  }

  const forcedCandidates = [];
  if (header) {
    const direct = join(paths.forcedRegistry, `${header.review_unit_id}.json`);
    if (existsSync(direct)) forcedCandidates.push(direct);
  } else if (existsSync(paths.forcedRegistry)) {
    for (const name of readdirSync(paths.forcedRegistry)) {
      if (!name.endsWith('.json')) continue;
      const path = join(paths.forcedRegistry, name);
      let marker;
      try { marker = JSON.parse(readFileSync(path, 'utf8')); } catch { fail('forced_revoke_invalid', `${path}がJSONではありません`); }
      if (marker?.canonical_review_dir === reviewDir) forcedCandidates.push(path);
    }
    if (forcedCandidates.length > 1) fail('forced_revoke_ambiguous', 'canonical review-dirに一致するforced markerが複数あります');
  }
  if (forcedCandidates.length === 1) {
    const marker = readJson(forcedCandidates[0], 'forced_revoke_invalid');
    if (!validateForcedMarker(marker)) fail('forced_revoke_invalid', 'forced revoke markerが固定最小schemaに適合しません');
    if (marker.canonical_review_dir !== reviewDir) fail('forced_revoke_invalid', 'forced revoke markerのcanonical pathが一致しません');
    if (header && marker.review_unit_id !== header.review_unit_id) {
      fail('forced_revoke_review_unit_mismatch', 'forced markerのreview_unit_idが固定ヘッダーと一致しません');
    }
    fail('forced_revoke', `forced revoke済みreview unitです: ${marker.superseded_by}`);
  }

  const abandonmentPath = join(paths.abandonmentRegistry, `${sha256Buffer(reviewDir)}.json`);
  if (existsSync(abandonmentPath)) {
    const marker = readJson(abandonmentPath, 'abandonment_marker_invalid');
    if (!validateAbandonmentMarker(marker) || marker.canonical_review_dir !== reviewDir) {
      fail('abandonment_marker_invalid', 'abandonment markerが固定最小schemaに適合しません');
    }
    fail('abandoned_review_unit', `放棄済みreview unitです: ${marker.superseded_by}`);
  }
}

function pluginVersion() {
  const candidates = [
    resolve(SOURCE_DIR, '../../../.claude-plugin/plugin.json'),
    resolve(SOURCE_DIR, '../../../.codex-plugin/plugin.json'),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return readJson(path).version;
  }
  return 'unknown';
}

function toolingFile(path) {
  return { path, sha256: sha256File(path) };
}

function validateTooling(reviewDir, { requireCurrentChecker = false } = {}) {
  checkRevocation(reviewDir);
  const paths = reviewPaths(reviewDir);
  if (!existsSync(paths.manifest)) fail('tooling_manifest_missing', `tooling manifestがありません: ${paths.manifest}`);
  const manifest = readJson(paths.manifest, 'tooling_manifest_invalid');
  if (manifest.format_version !== FORMAT_VERSION) fail('unsupported_format_version', `未対応format_versionです: ${manifest.format_version}`);
  if (!UUID_RE.test(manifest.review_unit_id)) fail('review_unit_id_invalid', 'review_unit_idがUUIDではありません');
  const bootstrapEventPath = join(reviewDir, 'evidence', 'bootstrap-event.json');
  if (existsSync(bootstrapEventPath)) {
    const bootstrapEvent = readJson(bootstrapEventPath, 'bootstrap_event_invalid');
    if (bootstrapEvent.event !== 'tooling_bootstrap' || bootstrapEvent.format_version !== manifest.format_version
      || bootstrapEvent.review_unit_id !== manifest.review_unit_id || bootstrapEvent.tooling_manifest !== paths.manifest) {
      fail('review_unit_id_mismatch', 'bootstrapイベントとtooling manifestの固定ヘッダーが一致しません');
    }
  }
  for (const key of ['checker', 'schema', 'ledger_schema', 'fingerprint']) {
    const entry = manifest.files?.[key];
    const expectedPath = paths[key];
    if (!entry || entry.path !== expectedPath || !SHA_RE.test(entry.sha256)) {
      fail('tooling_manifest_invalid', `${key}の絶対パス/hashが不正です`);
    }
    if (!existsSync(entry.path)) fail('tooling_copy_missing', `${key}の固定コピーがありません`);
    if (sha256File(entry.path) !== entry.sha256) fail('tooling_hash_mismatch', `${key}の固定コピーhashが一致しません`);
  }
  if (requireCurrentChecker) {
    const current = realpathSync(SOURCE_CHECKER);
    if (current !== realpathSync(manifest.files.checker.path)
      || sha256File(current) !== manifest.files.checker.sha256) {
      fail('untrusted_record_entry', 'このモードはtooling-manifestが固定したcheckerからだけ実行できます');
    }
  }
  return manifest;
}

function bootstrap(reviewDir, options) {
  const abandoned = option(options, 'abandoned-review-dir');
  const abandonmentRecordPath = option(options, 'abandonment-record');
  if ((abandoned && !abandonmentRecordPath) || (!abandoned && abandonmentRecordPath)) {
    fail('abandonment_arguments_incomplete', 'abandonment復旧引数は2つとも必要です');
  }
  if (abandoned) {
    const oldDir = requireAbsolute(abandoned, '--abandoned-review-dir');
    const recordPath = requireAbsolute(abandonmentRecordPath, '--abandonment-record');
    const record = readJson(recordPath, 'abandonment_record_invalid');
    const expectedNew = basename(reviewDir);
    if (!validateAbandonmentMarker(record) || record.canonical_review_dir !== oldDir
      || record.superseded_by !== expectedNew || record.old_basename !== basename(oldDir)
      || record.new_basename !== expectedNew) {
      fail('abandonment_record_invalid', 'abandonment承認記録が引数または固定schemaと一致しません');
    }
    const oldPaths = reviewPaths(oldDir);
    mkdirSync(oldPaths.abandonmentRegistry, { recursive: true });
    const markerPath = join(oldPaths.abandonmentRegistry, `${sha256Buffer(oldDir)}.json`);
    if (existsSync(markerPath)) {
      const existing = readJson(markerPath, 'abandonment_marker_invalid');
      const identity = ['kind', 'canonical_review_dir', 'superseded_by', 'review_unit_id'];
      if (!validateAbandonmentMarker(existing) || identity.some((key) => existing[key] !== record[key])) {
        fail('abandonment_marker_conflict', '既存abandonment markerの同一性項目が一致しません');
      }
    } else {
      atomicWriteJson(markerPath, {
        format_version: 1,
        kind: record.kind,
        canonical_review_dir: oldDir,
        ...(record.review_unit_id ? { review_unit_id: record.review_unit_id } : {}),
        superseded_by: expectedNew,
        reason: record.reason,
        approved_by: record.approved_by,
        approved_at: record.approved_at,
        ...(record.forced_revoke_diagnostic ? { forced_revoke_diagnostic: record.forced_revoke_diagnostic } : {}),
      }, true);
    }
  }

  checkRevocation(reviewDir);
  const paths = reviewPaths(reviewDir);
  if (existsSync(paths.manifest)) {
    const manifest = validateTooling(reviewDir);
    const eventPath = join(reviewDir, 'evidence', 'bootstrap-event.json');
    if (!existsSync(eventPath)) {
      atomicWriteJson(eventPath, { event: 'tooling_bootstrap', format_version: manifest.format_version, review_unit_id: manifest.review_unit_id, tooling_manifest: paths.manifest });
    }
    process.stdout.write(`${JSON.stringify({ ok: true, unchanged: true, review_unit_id: manifest.review_unit_id, tooling_manifest: paths.manifest })}\n`);
    return;
  }
  if (existsSync(paths.toolingDir) && readdirSync(paths.toolingDir).length > 0) {
    fail('existing_tooling_inconsistent', 'manifestのない既存toolingを上書きしません');
  }
  for (const source of [SOURCE_CHECKER, SOURCE_SCHEMA, SOURCE_LEDGER_SCHEMA, SOURCE_FINGERPRINT]) {
    if (!existsSync(source)) fail('bootstrap_source_missing', `同梱sourceがありません: ${source}`);
  }
  mkdirSync(paths.toolingDir, { recursive: true });
  copyFileSync(SOURCE_CHECKER, paths.checker);
  copyFileSync(SOURCE_SCHEMA, paths.schema);
  copyFileSync(SOURCE_LEDGER_SCHEMA, paths.ledger_schema);
  copyFileSync(SOURCE_FINGERPRINT, paths.fingerprint);
  chmodSync(paths.checker, 0o755);
  chmodSync(paths.fingerprint, 0o755);
  const manifest = {
    format_version: FORMAT_VERSION,
    review_unit_id: randomUUID(),
    source_plugin_version: pluginVersion(),
    files: {
      checker: toolingFile(paths.checker),
      schema: toolingFile(paths.schema),
      ledger_schema: toolingFile(paths.ledger_schema),
      fingerprint: toolingFile(paths.fingerprint),
    },
  };
  atomicWriteJson(paths.manifest, manifest, true);
  atomicWriteJson(join(reviewDir, 'evidence', 'bootstrap-event.json'), {
    event: 'tooling_bootstrap', format_version: manifest.format_version,
    review_unit_id: manifest.review_unit_id, tooling_manifest: paths.manifest,
  }, true);
  process.stdout.write(`${JSON.stringify({ ok: true, unchanged: false, review_unit_id: manifest.review_unit_id, tooling_manifest: paths.manifest })}\n`);
}

function canonicalDirectionBody(body) {
  const lines = body.split('\n');
  const lifecycle = lines.filter((line) => /^(?:状態|実測):/.test(line));
  const stateCount = lifecycle.filter((line) => line.startsWith('状態:')).length;
  const measurementCount = lifecycle.filter((line) => line.startsWith('実測:')).length;
  if (stateCount > 1 || measurementCount > 1) {
    fail('direction_lifecycle_metadata_duplicate', '状態または実測メタデータが重複しています');
  }
  return lines.filter((line) => !/^(?:状態|実測):/.test(line)).join('\n');
}

function parseDirection(path) {
  const body = readFileSync(path, 'utf8');
  const heading = /^#####\s+(EC-[A-Z0-9]+-[0-9]+):[^\n]*$/gm;
  const matches = [...body.matchAll(heading)];
  const contracts = [];
  const seen = new Set();
  for (let i = 0; i < matches.length; i += 1) {
    const id = matches[i][1];
    if (seen.has(id)) fail('duplicate_contract_id', `Evidence Contract IDが重複しています: ${id}`);
    seen.add(id);
    const start = matches[i].index + matches[i][0].length;
    const next = matches[i + 1]?.index ?? body.length;
    const section = body.slice(start, next).split(/^####\s/m)[0];
    const fields = {};
    for (const label of ['振る舞い', '変更面', 'oracle', '反証', '証拠種別', '証拠']) {
      const match = section.match(new RegExp(`^- ${label}:\\s*(.+)$`, 'm'));
      if (!match || !match[1].trim()) fail('contract_required_field_missing', `${id}: ${label}がありません`);
      fields[label] = match[1].trim();
    }
    const typeText = fields['証拠種別'];
    const typeDeclaration = typeText.split('（', 1)[0];
    const hasAutomated = /\bautomated\b/.test(typeDeclaration);
    const hasReview = /\breview-required\b/.test(typeDeclaration);
    if (hasAutomated && hasReview) fail('mixed_evidence_type', `${id}: 証拠種別を混在できません`);
    if (!hasAutomated && !hasReview) fail('invalid_evidence_type', `${id}: 証拠種別はautomatedまたはreview-requiredです`);
    const evidenceType = hasAutomated ? 'automated' : 'review-required';
    if (evidenceType === 'review-required'
      && (!/理由\s*[:：]\s*[^。）]+/.test(typeText) || !/残余リスク\s*[:：]\s*[^）]+/.test(typeText))) {
      fail('review_required_rationale_missing', `${id}: review-requiredには理由と残余リスクが必要です`);
    }
    const changedPaths = [...fields['変更面'].matchAll(/`([^`]+)`/g)]
      .map((match) => match[1]).filter((value) => value.includes('/') || value.includes('.'));
    contracts.push({ id, evidence_type: evidenceType, fields, changed_paths: changedPaths, source_index: matches[i].index });
  }
  if (contracts.length === 0) fail('evidence_contract_missing', 'Evidence Contractがありません');
  const mapSections = [...body.matchAll(/^#### 変更マップ\s*$([\s\S]*?)(?=^####\s|$(?![\s\S]))/gm)];
  if (mapSections.length === 0) fail('change_map_missing', '変更マップがありません');
  const mapPaths = new Set(mapSections.flatMap((section) => [...section[1].matchAll(/`([^`]+)`/g)].map((match) => match[1])));
  for (const contract of contracts) {
    for (const pathValue of contract.changed_paths) {
      if (![...mapPaths].some((mapped) => mapped === pathValue || mapped.endsWith(`/${pathValue}`) || pathValue.endsWith(`/${mapped}`))) {
        fail('change_map_unmapped', `${contract.id}: 変更面が変更マップにありません: ${pathValue}`);
      }
    }
  }
  return {
    body,
    contracts: contracts.map(({ source_index, ...contract }) => contract),
    sha256: sha256Buffer(canonicalDirectionBody(body)),
  };
}

function directionMode(reviewDir, directionPath) {
  const tooling = validateTooling(reviewDir, { requireCurrentChecker: true });
  if (basename(reviewDir) !== basename(directionPath).replace(/\.md$/, '')) {
    fail('review_dir_direction_mismatch', 'review-dir basenameとdirection basenameが一致しません');
  }
  const parsed = parseDirection(directionPath);
  process.stdout.write(`${JSON.stringify({ ok: true, review_unit_id: tooling.review_unit_id, direction_sha256: parsed.sha256, contracts: parsed.contracts.map(({ id, evidence_type }) => ({ id, evidence_type })) })}\n`);
}

function relativeRepoPath(root, path) {
  const value = relative(root, path).split(sep).join('/');
  if (value.startsWith('../') || value === '..') fail('path_outside_repository', `リポジトリ外のパスです: ${path}`);
  return value;
}

function exclusionPatterns(root, reviewDir) {
  const paths = reviewPaths(reviewDir);
  return [reviewDir, paths.forcedRegistry, paths.abandonmentRegistry].map((path) => `/${relativeRepoPath(root, path)}/`);
}

function fingerprint(root, reviewDir, tooling) {
  const tempDir = mkdtempSync(join(tmpdir(), 'dev-method-evidence-'));
  const excludePath = join(tempDir, 'exclude');
  try {
    writeFileSync(excludePath, `${exclusionPatterns(root, reviewDir).join('\n')}\n`);
    const env = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.excludesFile', GIT_CONFIG_VALUE_0: excludePath };
    const result = run(process.execPath, [tooling.files.fingerprint.path, root], { cwd: root, env });
    if (result.status !== 0 || !SHA_RE.test(result.stdout.trim())) {
      fail('diff_fingerprint_failed', result.stderr.trim() || 'diff指紋を計算できません');
    }
    return result.stdout.trim();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function gitOutput(root, args, encoding = 'utf8') {
  const result = run('git', args, { cwd: root, encoding });
  if (result.status !== 0) fail('git_failed', result.stderr?.toString().trim() || `git ${args.join(' ')} failed`);
  return result.stdout;
}

function actualChanges(root, reviewDir) {
  const exclude = exclusionPatterns(root, reviewDir).map((value) => value.replace(/^\//, '').replace(/\/$/, ''));
  const excluded = (path) => exclude.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  const changes = [];
  const raw = gitOutput(root, ['diff', '--name-status', '--find-renames', '-z', 'HEAD', '--'], null);
  const fields = raw.toString('utf8').split('\0').filter(Boolean);
  for (let i = 0; i < fields.length;) {
    const statusValue = fields[i++];
    const code = statusValue[0];
    const first = fields[i++];
    if (code === 'R' || code === 'C') {
      const second = fields[i++];
      if (!excluded(second)) changes.push({ path: second, previous_path: first, status: 'renamed' });
    } else if (!excluded(first)) {
      changes.push({ path: first, status: code === 'D' ? 'deleted' : code === 'A' ? 'added' : 'modified' });
    }
  }
  const untrackedRaw = gitOutput(root, ['ls-files', '--others', '--exclude-standard', '-z'], null);
  for (const path of untrackedRaw.toString('utf8').split('\0').filter(Boolean)) {
    if (!excluded(path)) changes.push({ path, status: 'untracked' });
  }
  return changes.map((entry) => ({
    ...entry,
    sha256: entry.status === 'deleted' ? null : sha256File(join(root, entry.path)),
  })).sort((a, b) => a.path.localeCompare(b.path));
}

function resolveExecutable(command, cwd) {
  if (command.includes('/')) return resolve(cwd, command);
  const result = run('sh', ['-c', 'command -v "$1"', 'sh', command], { cwd });
  return result.status === 0 ? result.stdout.trim() : command;
}

function versionOf(executable) {
  if (!existsSync(executable)) return null;
  const result = run(executable, ['--version']);
  if (result.status !== 0) return null;
  return (result.stdout || result.stderr).trim().split('\n')[0] || null;
}

function executableSnapshot(command, cwd) {
  const path = resolveExecutable(command, cwd);
  return {
    path,
    sha256: existsSync(path) && statSync(path).isFile() ? sha256File(path) : null,
    version: versionOf(path),
  };
}

function runtimeSnapshot(root, command) {
  const lockfiles = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock']
    .filter((name) => existsSync(join(root, name)))
    .map((name) => ({ path: name, sha256: sha256File(join(root, name)) }));
  return {
    executable: executableSnapshot(command[0], root),
    node: executableSnapshot(process.execPath, root),
    npm: basename(command[0]) === 'npm' ? executableSnapshot('npm', root) : null,
    platform: process.platform,
    arch: process.arch,
    lockfiles,
  };
}

function resolveLocalFile(base, specifier) {
  const candidate = resolve(base, specifier);
  for (const path of [candidate, `${candidate}.js`, `${candidate}.mjs`, `${candidate}.cjs`, `${candidate}.json`, join(candidate, 'index.js')]) {
    if (existsSync(path) && lstatSync(path).isFile()) return path;
  }
  return null;
}

const REGISTERED_REPOSITORY_RESOLVERS = new Map([
  ['scripts/check-method-fixtures.mjs', '03eea3157fada15720c6883efc21c3a1a9863fa3c759b87de2d0ced8f8a730c8'],
  ['scripts/check-model-map.mjs', '70dd476fe2be1b86a8e86adad725f435b8384b19736e6361fbcb8b4364518772'],
  ['scripts/check-setup-lanes-fixtures.mjs', 'ba164e4f0ce684b6e11a5f3fa67105798bf3ea46d760fd768992ff8cd0d0527b'],
  ['scripts/check-shared-clauses.mjs', 'bde162b509aca1249b48efe98e61043b6e63acbc48885276341780c5f9b4e875'],
]);

function resolveOracleInputs(root, command) {
  const unresolved = [];
  let scope = 'explicit';
  const inputs = new Set();
  const queue = [];
  const executable = basename(command[0]);
  if (executable === 'npm') {
    const packagePath = join(root, 'package.json');
    if (command[1] !== 'run' || !command[2] || !existsSync(packagePath)) {
      return { scope: 'repository', inputs: [], unresolved: [] };
    }
    let script;
    try { script = JSON.parse(readFileSync(packagePath, 'utf8')).scripts?.[command[2]]; } catch { script = null; }
    if (typeof script !== 'string') return { scope: 'repository', inputs: [], unresolved: [] };
    const combinedInputs = new Map([['package.json', { path: 'package.json', sha256: sha256File(packagePath) }]]);
    const unresolvedParts = [];
    for (const part of script.split(/\s*&&\s*/)) {
      const match = /^node\s+([^\s]+)(?:\s.*)?$/.exec(part.trim());
      if (!match) continue;
      const resolved = resolveOracleInputs(root, [process.execPath, match[1]]);
      resolved.inputs.forEach((input) => combinedInputs.set(input.path, input));
      unresolvedParts.push(...resolved.unresolved);
    }
    return { scope: 'repository', inputs: [...combinedInputs.values()].sort((a, b) => a.path.localeCompare(b.path)), unresolved: [...new Set(unresolvedParts)] };
  }
  if (!['node', basename(process.execPath)].includes(executable) || !command[1] || command[1].startsWith('-')) {
    return { scope: 'repository', inputs: [], unresolved: [] };
  }
  const entry = resolveLocalFile(root, command[1]);
  if (!entry) return { scope: 'repository', inputs: [], unresolved: ['entry fileを解決できない'] };
  queue.push(entry);
  while (queue.length > 0) {
    const path = queue.shift();
    const repoPath = relativeRepoPath(root, path);
    if (inputs.has(repoPath)) continue;
    inputs.add(repoPath);
    const source = readFileSync(path, 'utf8');
    const registeredHash = REGISTERED_REPOSITORY_RESOLVERS.get(repoPath);
    if (registeredHash) {
      scope = 'repository';
      if (sha256File(path) !== registeredHash) unresolved.push(`登録済みresolver内容不一致: ${repoPath}`);
      continue;
    }
    const repositoryScopePatterns = [
      [/import\s*\(/, '動的import'],
      [/require\s*\((?!\s*['"])/, '動的require'],
      [/\b(?:glob|fastGlob|fg)\s*\(/, 'glob'],
      [/\b(?:spawn|spawnSync|exec|execFile|fork)\s*\(/, '子プロセス'],
      [/\b(?:Worker|worker_threads)\b/, 'worker'],
      [/\.node['"]/, 'native addon'],
      [/\b(?:cosmiconfig|findUp|findConfig|lilconfig)\s*\(/, '暗黙の設定自動探索'],
    ];
    const unhashablePatterns = [
      [/\bprocess\.env\b/, '未固定の環境変数'],
      [/\b(?:fetch|https?\.|WebSocket)\b|https?:\/\//, 'ネットワーク/外部サービス'],
      [/\b(?:spawn|spawnSync|exec|execFile)\s*\(\s*['"](?:curl|wget|ssh|scp|nc)['"]/, 'ネットワーク/外部サービス'],
      [/\b(?:Date\.now|new Date|Math\.random|randomUUID)\b/, '未固定の時刻/乱数'],
    ];
    for (const [pattern] of repositoryScopePatterns) {
      if (pattern.test(source)) scope = 'repository';
    }
    for (const [pattern, reason] of unhashablePatterns) {
      if (!pattern.test(source)) continue;
      scope = 'repository';
      unresolved.push(reason);
    }
    const imports = [
      ...source.matchAll(/(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g),
      ...source.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
      ...source.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    ];
    for (const match of imports) {
      const specifier = match[1];
      if (specifier.startsWith('.') || specifier.startsWith('/')) {
        const resolved = resolveLocalFile(dirname(path), specifier);
        if (!resolved) { scope = 'repository'; unresolved.push(`ローカルimport未解決: ${specifier}`); }
        else queue.push(resolved);
      } else if (!specifier.startsWith('node:')) {
        scope = 'repository';
        unresolved.push(`外部package: ${specifier}`);
      }
    }
    for (const match of source.matchAll(/(?:readFile|readFileSync|createReadStream)\s*\(\s*['"]([^'"]+)['"]/g)) {
      const resolved = resolveLocalFile(dirname(path), match[1]);
      if (!resolved) { scope = 'repository'; unresolved.push(`リテラル読込未解決: ${match[1]}`); }
      else queue.push(resolved);
    }
    if (/(?:readFile|readFileSync|createReadStream)\s*\((?!\s*['"])/.test(source)) {
      scope = 'repository';
    }
  }
  return {
    scope,
    inputs: [...inputs].sort().map((path) => ({ path, sha256: sha256File(join(root, path)) })),
    unresolved: [...new Set(unresolved)],
  };
}

function defaultManifestPath(reviewDir, contract) {
  return join(reviewDir, 'evidence', 'manifests', `${contract}.json`);
}

function prepareMode(reviewDir, directionPath, options) {
  const tooling = validateTooling(reviewDir, { requireCurrentChecker: true });
  const contractId = option(options, 'contract', true);
  if (!CONTRACT_RE.test(contractId)) fail('contract_id_invalid', `不正なEvidence Contract IDです: ${contractId}`);
  const manifestPath = requireAbsolute(option(options, 'manifest') ?? defaultManifestPath(reviewDir, contractId), '--manifest');
  const parsed = parseDirection(directionPath);
  const contract = parsed.contracts.find(({ id }) => id === contractId);
  if (!contract) fail('contract_not_found', `${contractId}がdirectionにありません`);
  const root = gitRoot();
  const changes = actualChanges(root, reviewDir);
  const planned = new Set([...contract.changed_paths, ...optionsList(options, 'changed-file')]);
  for (const path of optionsList(options, 'changed-file')) {
    if (!changes.some((entry) => entry.path === path)) fail('changed_file_not_in_diff', `--changed-fileが実diffにありません: ${path}`);
  }
  const changedFiles = changes.filter(({ path }) => planned.has(path));
  const value = {
    format_version: FORMAT_VERSION,
    review_unit_id: tooling.review_unit_id,
    direction: { path: directionPath, sha256: parsed.sha256 },
    boundary: option(options, 'boundary') ?? contractId,
    contracts: [{
      id: contractId,
      evidence_type: contract.evidence_type,
      changed_files: changedFiles,
      oracle_inputs: [],
      input_scope: 'repository',
      repository_state: { head: gitOutput(root, ['rev-parse', 'HEAD']).trim(), diff_fingerprint: fingerprint(root, reviewDir, tooling) },
      expected_result: option(options, 'expected-result') ?? contract.fields.oracle,
      unverified: optionsList(options, 'unverified'),
      records: [],
    }],
  };
  atomicWriteJson(manifestPath, value);
  process.stdout.write(`${JSON.stringify({ ok: true, manifest: manifestPath, review_unit_id: tooling.review_unit_id, changed_files: changedFiles.map(({ path }) => path) })}\n`);
}

function countResults(stdout, stderr, actual, expected) {
  const text = `${stdout}\n${stderr}`;
  const pass = text.match(/(\d+)\s+(?:pass(?:ed)?|成功)/i) ?? text.match(/(?:pass(?:ed)?|成功)\D{0,8}(\d+)/i);
  const failMatch = text.match(/(\d+)\s+(?:fail(?:ed)?|失敗)/i) ?? text.match(/(?:fail(?:ed)?|失敗)\D{0,8}(\d+)/i);
  return {
    pass_count: pass ? Number(pass[1]) : actual === expected ? 1 : 0,
    fail_count: failMatch ? Number(failMatch[1]) : actual === expected ? 0 : 1,
  };
}

function recordMode(reviewDir, options, command) {
  const tooling = validateTooling(reviewDir, { requireCurrentChecker: true });
  const contractId = option(options, 'contract', true);
  const manifestPath = requireAbsolute(option(options, 'manifest') ?? defaultManifestPath(reviewDir, contractId), '--manifest');
  if (!command.length) fail('usage', 'recordには`-- <command>`が必要です');
  if (!existsSync(manifestPath)) fail('evidence_manifest_missing', `prepare済みmanifestがありません: ${manifestPath}`);
  const manifest = readJson(manifestPath, 'evidence_manifest_invalid');
  validateManifestShape(manifest, tooling.files.schema.path);
  if (manifest.review_unit_id !== tooling.review_unit_id) fail('review_unit_id_mismatch', 'manifestのreview_unit_idが一致しません');
  const contract = manifest.contracts?.find(({ id }) => id === contractId);
  if (!contract) fail('contract_not_found', `${contractId}がmanifestにありません`);
  const root = gitRoot();
  const before = fingerprint(root, reviewDir, tooling);
  const snapshot = runtimeSnapshot(root, command);
  const initialEvidenceRefs = optionsList(options, 'initial-evidence-ref').map((path) => {
    const absolutePath = requireAbsolute(path, '--initial-evidence-ref');
    if (!existsSync(absolutePath)) fail('initial_evidence_missing', `初期証跡がありません: ${absolutePath}`);
    return { path: absolutePath, sha256: sha256File(absolutePath) };
  });
  if (!existsSync(snapshot.executable.path)) fail('record_executable_missing', `実行体を解決できません: ${command[0]}`);
  const result = run(command[0], command.slice(1), { cwd: root });
  const after = fingerprint(root, reviewDir, tooling);
  const expectedExitCode = Number(option(options, 'expect-exit') ?? 0);
  if (!Number.isInteger(expectedExitCode)) fail('usage', '--expect-exitは整数です');
  const logDir = join(reviewDir, 'evidence', 'logs');
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${contractId}-${Date.now()}-${process.pid}.log`);
  const declaredUnverified = [...(contract.unverified ?? [])];
  const resolved = resolveOracleInputs(root, command);
  const counts = countResults(result.stdout, result.stderr, result.status, expectedExitCode);
  const log = {
    format_version: 1,
    metadata: {
      command,
      expected_exit_code: expectedExitCode,
      exit_code: result.status,
      ...counts,
      before_diff_fingerprint: before,
      after_diff_fingerprint: after,
      declared_unverified: declaredUnverified,
    },
    stdout: result.stdout,
    stderr: result.stderr,
  };
  writeFileSync(logPath, `${JSON.stringify(log)}\n`);
  contract.records.push({
    command,
    expected_exit_code: expectedExitCode,
    exit_code: result.status,
    ...counts,
    log_path: logPath,
    log_sha256: sha256File(logPath),
    before_diff_fingerprint: before,
    after_diff_fingerprint: after,
    runtime_snapshot: snapshot,
    recorded_by: { checker_path: tooling.files.checker.path, checker_sha256: tooling.files.checker.sha256 },
    declared_unverified: declaredUnverified,
    ...(option(options, 'mutation') ? { mutation: option(options, 'mutation') } : {}),
    ...(initialEvidenceRefs.length ? { initial_evidence_refs: initialEvidenceRefs } : {}),
  });
  const derived = deriveRecordInputs(root, contract.records);
  contract.oracle_inputs = derived.inputs;
  contract.input_scope = derived.scope;
  contract.unverified = derived.unresolved;
  contract.repository_state = { head: gitOutput(root, ['rev-parse', 'HEAD']).trim(), diff_fingerprint: after };
  atomicWriteJson(manifestPath, manifest);
  if (before !== after) fail('record_diff_changed', 'コマンド実行中にdiff指紋が変わりました', { before, after, manifest: manifestPath });
  if (result.status !== expectedExitCode) fail('record_unexpected_exit', `期待exit ${expectedExitCode}に対して${result.status}でした`, { manifest: manifestPath, log: logPath });
  process.stdout.write(`${JSON.stringify({ ok: true, contract: contractId, manifest: manifestPath, log: logPath, exit_code: result.status, ...counts, diff_fingerprint: after })}\n`);
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function parseRecordLog(logPath) {
  const raw = readFileSync(logPath, 'utf8');
  let envelope;
  try { envelope = JSON.parse(raw); } catch { fail('record_metadata_tampered', 'recordログがcanonical JSONではありません'); }
  if (raw !== `${JSON.stringify(envelope)}\n`) fail('record_metadata_tampered', 'recordログがcanonical JSON表現ではありません');
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
    || !sameJson(Object.keys(envelope), ['format_version', 'metadata', 'stdout', 'stderr'])
    || envelope.format_version !== 1 || typeof envelope.stdout !== 'string' || typeof envelope.stderr !== 'string') {
    fail('record_metadata_tampered', 'recordログenvelopeの構造が不正です');
  }
  const metadata = envelope.metadata;
  const expectedKeys = ['command', 'expected_exit_code', 'exit_code', 'pass_count', 'fail_count', 'before_diff_fingerprint', 'after_diff_fingerprint', 'declared_unverified'];
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || !sameJson(Object.keys(metadata), expectedKeys)
    || !Array.isArray(metadata.command) || !metadata.command.every((value) => typeof value === 'string')
    || !Number.isInteger(metadata.expected_exit_code) || !Number.isInteger(metadata.exit_code)
    || !Number.isInteger(metadata.pass_count) || metadata.pass_count < 0
    || !Number.isInteger(metadata.fail_count) || metadata.fail_count < 0
    || !SHA_RE.test(metadata.before_diff_fingerprint) || !SHA_RE.test(metadata.after_diff_fingerprint)
    || !Array.isArray(metadata.declared_unverified) || !metadata.declared_unverified.every((value) => typeof value === 'string' && value.length > 0)) {
    fail('record_metadata_tampered', 'recordログmetadataの構造または値が不正です');
  }
  const derivedCounts = countResults(envelope.stdout, envelope.stderr, metadata.exit_code, metadata.expected_exit_code);
  if (derivedCounts.pass_count !== metadata.pass_count || derivedCounts.fail_count !== metadata.fail_count) {
    fail('record_metadata_tampered', 'recordログのpass/fail件数をraw outputから再導出できません');
  }
  return envelope;
}

function deriveRecordInputs(root, records) {
  const inputs = new Map();
  const unresolved = new Set();
  let scope = 'explicit';
  for (const record of records) {
    const resolved = resolveOracleInputs(root, record.command);
    if (resolved.scope === 'repository') scope = 'repository';
    for (const input of resolved.inputs) inputs.set(input.path, input);
    for (const value of [...(record.declared_unverified ?? []), ...resolved.unresolved]) unresolved.add(value);
  }
  return { scope, inputs: [...inputs.values()].sort((a, b) => a.path.localeCompare(b.path)), unresolved: [...unresolved].sort() };
}

function schemaRef(rootSchema, ref) {
  if (!ref.startsWith('#/')) fail('evidence_schema_invalid', `外部$refは許可されません: ${ref}`);
  return ref.slice(2).split('/').reduce((value, key) => value?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], rootSchema);
}

function schemaMatches(value, schema, rootSchema, path = '$') {
  if (schema.$ref) return schemaMatches(value, schemaRef(rootSchema, schema.$ref), rootSchema, path);
  if (schema.anyOf) return schema.anyOf.some((entry) => schemaMatches(value, entry, rootSchema, path).length === 0) ? [] : [`${path}: anyOf不一致`];
  const errors = [];
  if (Object.hasOwn(schema, 'const') && value !== schema.const) errors.push(`${path}: const不一致`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: enum不一致`);
  if (schema.type) {
    const valid = schema.type === 'null' ? value === null
      : schema.type === 'array' ? Array.isArray(value)
        : schema.type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
          : schema.type === 'integer' ? Number.isInteger(value) : typeof value === schema.type;
    if (!valid) return [`${path}: type ${schema.type}不一致`];
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: minLength違反`);
    if (schema.pattern && !(new RegExp(schema.pattern)).test(value)) errors.push(`${path}: pattern違反`);
    if (schema.format === 'uuid' && !UUID_RE.test(value)) errors.push(`${path}: uuid違反`);
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: minimum違反`);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: minItems違反`);
    if (schema.items) value.forEach((item, index) => errors.push(...schemaMatches(item, schema.items, rootSchema, `${path}[${index}]`)));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const required of schema.required ?? []) if (!Object.hasOwn(value, required)) errors.push(`${path}.${required}: 必須欄欠落`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) errors.push(...schemaMatches(item, schema.properties[key], rootSchema, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: 追加欄禁止`);
    }
  }
  return errors;
}

function validateManifestShape(manifest, schemaPath) {
  const schema = readJson(schemaPath, 'evidence_schema_invalid');
  const errors = schemaMatches(manifest, schema, schema);
  if (errors.length) fail('evidence_manifest_schema_invalid', 'Evidence manifestが固定schemaに適合しません', errors);
}

function verifyMode(reviewDir, directionPath, manifestPaths) {
  if (manifestPaths.length === 0) fail('usage', 'verifyには--manifestを1件以上指定してください');
  const tooling = validateTooling(reviewDir, { requireCurrentChecker: true });
  const parsed = parseDirection(directionPath);
  const root = gitRoot();
  const currentFingerprint = fingerprint(root, reviewDir, tooling);
  const actual = actualChanges(root, reviewDir);
  const covered = new Set();
  const contractIds = [];
  const manifestOutput = [];
  for (const rawPath of manifestPaths) {
    const path = requireAbsolute(rawPath, '--manifest');
    if (!existsSync(path)) fail('evidence_manifest_missing', `Evidence manifestがありません: ${path}`);
    const manifest = readJson(path, 'evidence_manifest_invalid');
    validateManifestShape(manifest, tooling.files.schema.path);
    if (manifest.review_unit_id !== tooling.review_unit_id) fail('review_unit_id_mismatch', `${path}: review_unit_id不一致`);
    if (manifest.direction.path !== directionPath || manifest.direction.sha256 !== parsed.sha256) {
      fail('direction_hash_mismatch', `${path}: direction path/hash不一致`);
    }
    for (const contract of manifest.contracts) {
      contractIds.push(contract.id);
      const declared = parsed.contracts.find(({ id }) => id === contract.id);
      if (!declared) fail('unknown_contract_id', `${path}: 存在しない契約ID ${contract.id}`);
      if (contract.evidence_type !== declared.evidence_type) fail('evidence_type_mismatch', `${contract.id}: 証拠種別不一致`);
      for (const file of contract.changed_files ?? []) {
        covered.add(file.path);
        const actualEntry = actual.find(({ path: actualPath }) => actualPath === file.path);
        if (!actualEntry || actualEntry.status !== file.status || actualEntry.sha256 !== file.sha256
          || actualEntry.previous_path !== file.previous_path) {
          fail('changed_file_stale', `${contract.id}: 実変更ファイルがstaleです: ${file.path}`);
        }
      }
      for (const input of contract.oracle_inputs ?? []) {
        const fullPath = join(root, input.path);
        if (!existsSync(fullPath) || sha256File(fullPath) !== input.sha256) fail('oracle_input_stale', `${contract.id}: oracle入力がstaleです: ${input.path}`);
      }
      if (contract.input_scope === 'repository') {
        const state = contract.repository_state;
        const head = gitOutput(root, ['rev-parse', 'HEAD']).trim();
        if (!state || state.head !== head || state.diff_fingerprint !== currentFingerprint) {
          fail('repository_scope_stale', `${contract.id}: repository scopeがstaleです`);
        }
      }
      if (contract.evidence_type === 'automated' && (contract.unverified?.length ?? 0) > 0) {
        fail('automated_unverified_blocked', `${contract.id}: automated契約に未解決入力があります`, contract.unverified);
      }
      if (contract.evidence_type === 'automated' && (contract.records?.length ?? 0) === 0) {
        fail('automated_evidence_missing', `${contract.id}: record証拠がありません`);
      }
      if (contract.evidence_type === 'automated') {
        const baseline = contract.records.some((record) => !record.mutation && record.expected_exit_code === 0);
        const mutation = contract.records.some((record) => typeof record.mutation === 'string'
          && record.mutation.length > 0 && record.expected_exit_code !== 0);
        if (!baseline) fail('automated_baseline_missing', `${contract.id}: exit 0のbaseline recordがありません`);
        if (!mutation) fail('automated_mutation_missing', `${contract.id}: 非ゼロ終了を期待する故意ずれrecordがありません`);
      }
      for (const record of contract.records ?? []) {
        if (!existsSync(record.log_path) || sha256File(record.log_path) !== record.log_sha256) {
          fail('record_log_tampered', `${contract.id}: recordログが改変されています`);
        }
        const logMetadata = parseRecordLog(record.log_path).metadata;
        if (!sameJson(logMetadata.command, record.command)
          || logMetadata.expected_exit_code !== record.expected_exit_code || logMetadata.exit_code !== record.exit_code
          || logMetadata.pass_count !== record.pass_count || logMetadata.fail_count !== record.fail_count
          || logMetadata.before_diff_fingerprint !== record.before_diff_fingerprint
          || logMetadata.after_diff_fingerprint !== record.after_diff_fingerprint
          || !sameJson(logMetadata.declared_unverified, record.declared_unverified)) {
          fail('record_metadata_tampered', `${contract.id}: hash済みrecordログとmanifest metadataが一致しません`);
        }
        if (record.recorded_by?.checker_path !== tooling.files.checker.path
          || record.recorded_by?.checker_sha256 !== tooling.files.checker.sha256) {
          fail('untrusted_record_entry', `${contract.id}: source checker等の信頼されないrecordです`);
        }
        if (record.before_diff_fingerprint !== record.after_diff_fingerprint) fail('record_diff_changed', `${contract.id}: record中にdiffが変化しています`);
        if (record.exit_code !== record.expected_exit_code || record.fail_count !== 0) fail('record_failed', `${contract.id}: record結果がgreenではありません`);
        if (!sameJson(runtimeSnapshot(root, record.command), record.runtime_snapshot)) fail('runtime_snapshot_stale', `${contract.id}: runtime snapshotがstaleです`);
        for (const initial of record.initial_evidence_refs ?? []) {
          if (!isAbsolute(initial.path) || !existsSync(initial.path) || sha256File(initial.path) !== initial.sha256) {
            fail('initial_evidence_stale', `${contract.id}: 初期証跡参照がstaleです: ${initial.path}`);
          }
        }
      }
      if ((contract.records?.length ?? 0) > 0) {
        const derived = deriveRecordInputs(root, contract.records);
        if (contract.input_scope !== derived.scope || !sameJson(contract.oracle_inputs, derived.inputs)
          || !sameJson([...contract.unverified].sort(), derived.unresolved)) {
          fail('record_inputs_tampered', `${contract.id}: record.commandから再導出した入力閉包とmanifestが一致しません`);
        }
      }
    }
    manifestOutput.push({ path, sha256: sha256File(path) });
  }
  const duplicates = contractIds.filter((id, index) => contractIds.indexOf(id) !== index);
  if (duplicates.length) fail('evidence_contract_duplicate', 'manifest間でEvidence Contract IDが重複しています', [...new Set(duplicates)]);
  const declaredIds = parsed.contracts.map(({ id }) => id).sort();
  const manifestIds = [...contractIds].sort();
  if (!sameJson(declaredIds, manifestIds)) {
    fail('evidence_contract_set_mismatch', 'directionと全manifestのEvidence Contract集合が一致しません', {
      missing: declaredIds.filter((id) => !manifestIds.includes(id)), extra: manifestIds.filter((id) => !declaredIds.includes(id)),
    });
  }
  const uncovered = actual.filter(({ path }) => !covered.has(path)).map(({ path }) => path);
  if (uncovered.length > 0) fail('actual_diff_unmapped', '実diffに契約未対応ファイルがあります', uncovered);
  process.stdout.write(`${JSON.stringify({ ok: true, review_unit_id: tooling.review_unit_id, direction_hash: parsed.sha256, diff_fingerprint: currentFingerprint, manifests: manifestOutput })}\n`);
}

function validateLedgerEvent(event, tooling, phase) {
  if (event.review_unit_id !== tooling.review_unit_id) fail('ledger_review_unit_mismatch', '旧または別review unitのイベントがあります');
  if (!SHA_RE.test(event.direction_hash)) fail('ledger_direction_hash_mismatch', 'イベントのdirection hashが不正です');
  if (event.phase !== phase) fail('ledger_phase_mismatch', '別phaseのイベントが混在しています');
  if (event.diff_fingerprint && !SHA_RE.test(event.diff_fingerprint)) fail('ledger_diff_fingerprint_invalid', 'diff指紋が不正です');
  if (event.event === 'review_prompt' || event.event === 'review_result') {
    const schema = readJson(tooling.files.ledger_schema.path, 'ledger_schema_invalid');
    const definition = event.event === 'review_prompt' ? schema.$defs.promptEvent : schema.$defs.resultEvent;
    const errors = schemaMatches(event, definition, schema);
    if (errors.length) fail(event.event === 'review_prompt' ? 'ledger_prompt_invalid' : 'ledger_result_invalid', 'reviewイベントが固定schemaに適合しません', errors);
  }
  if (event.event === 'review_ledger_check' && (!Number.isInteger(event.round) || event.round < 1)) {
    fail('ledger_checkpoint_round_invalid', 'review-ledger実行イベントにroundがありません');
  }
}

function appendJsonLineAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const prior = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temp, `${prior}${JSON.stringify(value)}\n`);
  renameSync(temp, path);
}

function readLedgerEvents(eventsPath) {
  if (!existsSync(eventsPath)) return [];
  return readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch { fail('ledger_json_invalid', `イベント${index + 1}がJSONではありません`); }
  });
}

function positiveRound(options) {
  const round = Number(option(options, 'round', true));
  if (!Number.isInteger(round) || round < 1) fail('usage', '--roundは1以上の整数です');
  return round;
}

function ledgerPromptMode(reviewDir, directionPath, options) {
  const tooling = validateTooling(reviewDir, { requireCurrentChecker: true });
  const phase = option(options, 'phase', true);
  if (!['plan', 'code'].includes(phase)) fail('usage', '--phaseはplanまたはcodeです');
  const eventsPath = requireAbsolute(option(options, 'events', true), '--events');
  const promptPath = requireAbsolute(option(options, 'prompt', true), '--prompt');
  if (!existsSync(promptPath)) fail('ledger_prompt_invalid', `promptファイルがありません: ${promptPath}`);
  const reviewer = option(options, 'reviewer', true);
  const round = positiveRound(options);
  const sessionId = option(options, 'session-id', true);
  const events = readLedgerEvents(eventsPath);
  if (events.some((event) => event.event === 'review_prompt' && event.phase === phase
    && event.reviewer === reviewer && event.round === round)) {
    fail('ledger_prompt_duplicate', `${phase}/${reviewer}/R${round}のpromptイベントは作成済みです`);
  }
  const parsed = parseDirection(directionPath);
  const root = gitRoot();
  const event = {
    event: 'review_prompt', phase, review_unit_id: tooling.review_unit_id,
    direction_hash: parsed.sha256, diff_fingerprint: fingerprint(root, reviewDir, tooling),
    reviewer, round, session_id: sessionId, prompt_path: promptPath, prompt_hash: sha256File(promptPath),
  };
  const schema = readJson(tooling.files.ledger_schema.path, 'ledger_schema_invalid');
  const errors = schemaMatches(event, schema.$defs.promptEvent, schema);
  if (errors.length) fail('ledger_prompt_invalid', 'promptイベントが固定schemaに適合しません', errors);
  appendJsonLineAtomic(eventsPath, event);
  process.stdout.write(`${JSON.stringify({ ok: true, ...event })}\n`);
}

function ledgerResultMode(reviewDir, directionPath, options) {
  const tooling = validateTooling(reviewDir, { requireCurrentChecker: true });
  const phase = option(options, 'phase', true);
  if (!['plan', 'code'].includes(phase)) fail('usage', '--phaseはplanまたはcodeです');
  const eventsPath = requireAbsolute(option(options, 'events', true), '--events');
  const resultPath = requireAbsolute(option(options, 'result', true), '--result');
  if (!existsSync(resultPath)) fail('ledger_result_invalid', `resultファイルがありません: ${resultPath}`);
  const reviewer = option(options, 'reviewer', true);
  const round = positiveRound(options);
  const sessionId = option(options, 'session-id', true);
  const events = readLedgerEvents(eventsPath);
  const prompts = events.filter((event) => event.event === 'review_prompt' && event.phase === phase
    && event.reviewer === reviewer && event.round === round && event.session_id === sessionId);
  if (prompts.length !== 1) fail('ledger_prompt_invalid', `${phase}/${reviewer}/R${round}の対応promptが一意ではありません`);
  if (events.some((event) => event.event === 'review_result' && event.phase === phase
    && event.reviewer === reviewer && event.round === round)) {
    fail('ledger_result_duplicate', `${phase}/${reviewer}/R${round}のresultイベントは作成済みです`);
  }
  const result = readJson(resultPath, 'ledger_result_invalid');
  const schema = readJson(tooling.files.ledger_schema.path, 'ledger_schema_invalid');
  const resultErrors = schemaMatches(result, schema.$defs.resultDocument, schema);
  if (resultErrors.length) fail('ledger_result_invalid', 'result本文が固定schemaに適合しません', resultErrors);
  const issueKeys = phase === 'plan' ? ['must_fix', 'should_fix', 'nit'] : ['must_fix', 'should_fix'];
  const issueCount = issueKeys.reduce((sum, key) => sum + result[key].length, 0);
  if ((result.verdict === 'approve' && issueCount !== 0)
    || (result.verdict === 'needs-attention' && issueCount === 0)) {
    fail('ledger_verdict_inconsistent', 'result本文のverdictと指摘件数が不整合です');
  }
  const prompt = prompts[0];
  const event = {
    event: 'review_result', phase, review_unit_id: tooling.review_unit_id,
    direction_hash: prompt.direction_hash, diff_fingerprint: prompt.diff_fingerprint,
    reviewer, round, session_id: sessionId, prompt_hash: prompt.prompt_hash,
    result_path: resultPath, result_hash: sha256File(resultPath),
    verdict: result.verdict, must_fix: result.must_fix, should_fix: result.should_fix,
    nit: result.nit, readonly_violations: result.readonly_violations,
  };
  const eventErrors = schemaMatches(event, schema.$defs.resultEvent, schema);
  if (eventErrors.length) fail('ledger_result_invalid', 'resultイベントが固定schemaに適合しません', eventErrors);
  appendJsonLineAtomic(eventsPath, event);
  process.stdout.write(`${JSON.stringify({ ok: true, ...event })}\n`);
}

function reviewLedger(reviewDir, directionPath, options) {
  const tooling = validateTooling(reviewDir, { requireCurrentChecker: true });
  const phase = option(options, 'phase', true);
  if (!['plan', 'code'].includes(phase)) fail('usage', '--phaseはplanまたはcodeです');
  const point = option(options, 'execution-point', true);
  const allowedPoints = phase === 'plan' ? ['results-received', 'before-agreement'] : ['results-received', 'before-completion'];
  if (!allowedPoints.includes(point)) fail('usage', `${phase} phaseでは--execution-point ${point}を使えません`);
  const eventsPath = requireAbsolute(option(options, 'events', true), '--events');
  const checkpointRound = positiveRound(options);
  if (basename(reviewDir) !== basename(directionPath).replace(/\.md$/, '')) fail('review_dir_direction_mismatch', 'review-dirとdirection basenameが一致しません');
  const directionHash = parseDirection(directionPath).sha256;
  const root = gitRoot();
  const currentFingerprint = fingerprint(root, reviewDir, tooling);
  const invocationId = randomUUID();
  const priorEvents = readLedgerEvents(eventsPath);
  const priorResultRounds = priorEvents.filter((event) => event.event === 'review_result' && event.phase === phase)
    .map(({ round }) => round);
  if (priorResultRounds.length === 0 || Math.max(...priorResultRounds) !== checkpointRound) {
    fail('ledger_checkpoint_round_mismatch', 'checkpoint roundが最新result roundと一致しません');
  }
  appendJsonLineAtomic(eventsPath, {
    event: 'review_ledger_check', phase, execution_point: point,
    invocation_id: invocationId, round: checkpointRound,
    review_unit_id: tooling.review_unit_id, direction_hash: directionHash,
    diff_fingerprint: currentFingerprint, checked_at: new Date().toISOString(),
  });
  try {
  const events = readLedgerEvents(eventsPath);
  for (const event of events) validateLedgerEvent(event, tooling, phase);
  const checks = events.filter(({ event }) => event === 'review_ledger_check');
  const passedCheckIds = new Set(events.filter(({ event }) => event === 'review_ledger_check_passed')
    .map(({ invocation_id }) => invocation_id));
  if (checks.some((event) => !UUID_RE.test(event.invocation_id))
    || new Set(checks.map(({ invocation_id }) => invocation_id)).size !== checks.length) {
    fail('ledger_invocation_invalid', 'review-ledger自己イベントのinvocation_idが欠落または重複しています');
  }
  if (point !== 'results-received' && !events.some((event) => event.event === 'review_ledger_check'
    && event.execution_point === 'results-received' && event.round === checkpointRound
    && passedCheckIds.has(event.invocation_id))) {
    fail('ledger_checkpoint_missing', 'results-receivedのreview-ledger実行イベントがありません');
  }
  const prompts = events.filter(({ event }) => event === 'review_prompt');
  const results = events.filter(({ event }) => event === 'review_result');
  if (prompts.length === 0 || results.length === 0) fail('ledger_result_missing', 'review promptまたはresultイベントがありません');
  for (const prompt of prompts) {
    if (!prompt.reviewer || !Number.isInteger(prompt.round) || !prompt.session_id || !isAbsolute(prompt.prompt_path)
      || !existsSync(prompt.prompt_path) || sha256File(prompt.prompt_path) !== prompt.prompt_hash) {
      fail('ledger_prompt_invalid', 'promptイベントの必須欄/hashが不正です');
    }
  }
  for (const result of results) {
    if (!result.reviewer || !Number.isInteger(result.round) || !result.session_id || !isAbsolute(result.result_path)
      || !existsSync(result.result_path) || sha256File(result.result_path) !== result.result_hash) {
      fail('ledger_result_invalid', 'resultイベントの必須欄/hashが不正です');
    }
    const resultDocument = readJson(result.result_path, 'ledger_result_invalid');
    const schema = readJson(tooling.files.ledger_schema.path, 'ledger_schema_invalid');
    const resultErrors = schemaMatches(resultDocument, schema.$defs.resultDocument, schema);
    if (resultErrors.length || resultDocument.verdict !== result.verdict
      || !sameJson(resultDocument.must_fix, result.must_fix)
      || !sameJson(resultDocument.should_fix, result.should_fix)
      || !sameJson(resultDocument.nit, result.nit)
      || !sameJson(resultDocument.readonly_violations, result.readonly_violations)) {
      fail('ledger_result_content_mismatch', 'result本文とresultイベントの意味内容が一致しません', resultErrors);
    }
    const categories = ['must_fix', 'should_fix', 'nit'];
    if (!categories.every((key) => Array.isArray(result[key])) || !Array.isArray(result.readonly_violations)) fail('ledger_result_invalid', '3区分とread-only監査の配列が必要です');
    const issueCount = (phase === 'plan' ? categories : ['must_fix', 'should_fix'])
      .reduce((sum, key) => sum + result[key].length, 0);
    if (!['approve', 'needs-attention'].includes(result.verdict)
      || (result.verdict === 'approve' && issueCount !== 0)
      || (result.verdict === 'needs-attention' && issueCount === 0)) {
      fail('ledger_verdict_inconsistent', 'verdictとmust-fix/should-fix/nitが不整合です');
    }
    const prompt = prompts.find((entry) => entry.reviewer === result.reviewer && entry.round === result.round);
    if (!prompt || prompt.session_id !== result.session_id || prompt.prompt_hash !== result.prompt_hash
      || prompt.diff_fingerprint !== result.diff_fingerprint || prompt.direction_hash !== result.direction_hash) {
      fail('ledger_round_mismatch', '同一ラウンド内のprompt/resultが不整合です');
    }
    if ((result.readonly_violations?.length ?? 0) > 0) fail('ledger_readonly_violation', 'read-only違反があります');
  }
  const reviewers = [...new Set(results.map(({ reviewer }) => reviewer))];
  const minimumReviewers = phase === 'code' ? 2 : 1;
  if (reviewers.length < minimumReviewers) fail('ledger_reviewer_missing', `${phase} phaseに必要なreviewer結果が不足しています`);
  for (const reviewer of reviewers) {
    const ordered = prompts.filter((event) => event.reviewer === reviewer).sort((a, b) => a.round - b.round);
    for (let i = 1; i < ordered.length; i += 1) {
      if (ordered[i].session_id !== ordered[i - 1].session_id) {
        const matches = (event) => event.reviewer === reviewer && event.round === ordered[i].round;
        if (!events.some((event) => event.event === 'new_session_started' && matches(event))
          || !events.some((event) => event.event === 'resume_deviation' && matches(event))) {
          fail('ledger_session_discontinuity', 'session変更には新規起動イベントと逸脱記録の両方が必要です');
        }
      }
    }
  }
  const latestRound = Math.max(...results.map(({ round }) => round));
  if (checkpointRound !== latestRound) fail('ledger_checkpoint_round_mismatch', 'checkpoint roundが最新roundではありません');
  const latest = results.filter(({ round }) => round === latestRound);
  if (new Set(latest.map(({ reviewer }) => reviewer)).size !== reviewers.length) fail('ledger_result_missing', '最新ラウンドのreviewer結果が欠落しています');
  const latestFingerprints = new Set(latest.map(({ diff_fingerprint }) => diff_fingerprint));
  if (latestFingerprints.size !== 1) fail('ledger_round_mismatch', '最新ラウンドの承認対象指紋が不一致です');
  const rounds = [...new Set(results.map(({ round }) => round))];
  const reworkCount = rounds.filter((round) => results.filter((result) => result.round === round)
    .some((result) => result.must_fix.length + result.should_fix.length > 0)).length;
  const latestUnresolved = latest.some(({ verdict }) => verdict === 'needs-attention')
    || (phase === 'plan' && latest.some(({ direction_hash }) => direction_hash !== directionHash))
    || (phase === 'code' && [...latestFingerprints][0] !== currentFingerprint);
  const latestStaleDiagnostic = phase === 'plan' && latest.some(({ direction_hash }) => direction_hash !== directionHash)
    ? 'stale_approved_plan'
    : phase === 'code' && [...latestFingerprints][0] !== currentFingerprint ? 'stale_approved_diff' : null;
  const backstopReason = reworkCount >= 4 ? 'rework' : rounds.length >= 5 && latestUnresolved ? 'round' : null;
  const reworkState = {
    rework_count: reworkCount,
    next_rework: reworkCount + 1,
    backstop_reached: backstopReason !== null,
    backstop_reason: backstopReason,
  };
  if (backstopReason !== null) {
    if (latestStaleDiagnostic) {
      appendJsonLineAtomic(eventsPath, {
        event: 'review_ledger_stale', phase, diagnostic: latestStaleDiagnostic, invocation_id: invocationId,
        review_unit_id: tooling.review_unit_id, direction_hash: directionHash, diff_fingerprint: currentFingerprint,
        detected_at: new Date().toISOString(),
      });
    }
    throw new DiagnosticError('review_backstop_reached', '差し戻しバックストップに到達したため、未解決指摘を添えて停止してください', 3, reworkState);
  }
  if (latest.some(({ verdict }) => verdict === 'needs-attention')) {
    throw new DiagnosticError('review_attention_required', '指摘を反映して次ラウンドへ進んでください', 2, reworkState);
  }
  if (phase === 'plan' && latest.some(({ direction_hash }) => direction_hash !== directionHash)) {
    appendJsonLineAtomic(eventsPath, {
      event: 'review_ledger_stale', phase, diagnostic: 'stale_approved_plan', invocation_id: invocationId,
      review_unit_id: tooling.review_unit_id, direction_hash: directionHash, diff_fingerprint: currentFingerprint,
      detected_at: new Date().toISOString(),
    });
    throw new DiagnosticError('stale_approved_plan', '承認後にdirection本文が変わりました', 2);
  }
  if (phase === 'code' && latest.some(({ direction_hash }) => direction_hash !== directionHash)) {
    fail('ledger_direction_hash_mismatch', 'code reviewのdirection hashが現行値と一致しません');
  }
  if (phase === 'code' && [...latestFingerprints][0] !== currentFingerprint) {
    appendJsonLineAtomic(eventsPath, {
      event: 'review_ledger_stale', phase, diagnostic: 'stale_approved_diff', invocation_id: invocationId,
      review_unit_id: tooling.review_unit_id, direction_hash: directionHash, diff_fingerprint: currentFingerprint,
      detected_at: new Date().toISOString(),
    });
    throw new DiagnosticError('stale_approved_diff', '最終承認後にdiffが変わりました', 2);
  }
  const finalPoint = phase === 'plan' ? 'before-agreement' : 'before-completion';
  let eligibilityToken;
  if (point === finalPoint) {
    const staleCount = events.filter((event) => event.event === 'review_ledger_stale').length;
    const roundCount = new Set(results.map(({ round }) => round)).size;
    const successfulChecks = checks.filter(({ invocation_id }) => passedCheckIds.has(invocation_id)
      || invocation_id === invocationId);
    const resultChecks = successfulChecks.filter(({ execution_point }) => execution_point === 'results-received');
    const observedResults = resultChecks.length;
    const observedFinal = successfulChecks.filter(({ execution_point }) => execution_point === finalPoint).length;
    const expectedResults = roundCount;
    const expectedFinal = staleCount + 1;
    const resultRounds = [...new Set(results.map(({ round }) => round))].sort((a, b) => a - b);
    const checkpointRounds = resultChecks.map(({ round }) => round).sort((a, b) => a - b);
    if (observedResults !== expectedResults || observedFinal !== expectedFinal
      || !sameJson(checkpointRounds, resultRounds)) {
      fail('ledger_checkpoint_count_mismatch', 'review-ledger実行点の観測数と期待数が一致しません', {
        observed_results: observedResults, expected_results: expectedResults, observed_final: observedFinal, expected_final: expectedFinal, stale: staleCount,
      });
    }
    const label = phase === 'plan' ? 'ledger plan' : 'ledger code';
    const resultLabel = phase === 'plan' ? '結果受領' : '両結果受領';
    const finalLabel = phase === 'plan' ? '合意直前' : '完了直前';
    eligibilityToken = `${label} ${resultLabel}${observedResults}/${expectedResults}・${finalLabel}${observedFinal}/${expectedFinal}・stale${staleCount}・eligible=true`;
    if (phase === 'code') {
      atomicWriteJson(reviewPaths(reviewDir).complete, {
        format_version: FORMAT_VERSION,
        review_unit_id: tooling.review_unit_id,
        direction_hash: directionHash,
        diff_fingerprint: currentFingerprint,
        invocation_id: invocationId,
        completed_at: new Date().toISOString(),
      }, true);
    }
  }
  appendJsonLineAtomic(eventsPath, {
    event: 'review_ledger_check_passed', phase, execution_point: point,
    invocation_id: invocationId, round: checkpointRound,
    review_unit_id: tooling.review_unit_id, direction_hash: directionHash,
    diff_fingerprint: currentFingerprint, checked_at: new Date().toISOString(),
  });
  process.stdout.write(`${JSON.stringify({ ok: true, phase, execution_point: point, invocation_id: invocationId, review_unit_id: tooling.review_unit_id, direction_hash: directionHash, diff_fingerprint: currentFingerprint, round: latestRound, ...reworkState, ...(eligibilityToken ? { eligibility_token: eligibilityToken } : {}) })}\n`);
  } catch (error) {
    appendJsonLineAtomic(eventsPath, {
      event: error instanceof DiagnosticError && error.exitCode !== 1
        ? 'review_ledger_check_passed' : 'review_ledger_check_failed',
      phase, execution_point: point,
      invocation_id: invocationId, round: checkpointRound,
      review_unit_id: tooling.review_unit_id, direction_hash: directionHash,
      diff_fingerprint: currentFingerprint, checked_at: new Date().toISOString(),
      diagnostic: error instanceof DiagnosticError ? error.diagnostic : 'unexpected_error',
    });
    throw error;
  }
}

function revoke(reviewDir, supersededBy) {
  const paths = reviewPaths(reviewDir);
  const reviewUnitId = recoverReviewUnitId(reviewDir);
  if (!reviewUnitId) fail('revoke_review_unit_unknown', '固定ヘッダーと作業単位証跡からreview_unit_idを取得できません');
  if (existsSync(paths.revoked)) {
    const existing = readJson(paths.revoked, 'revoked_marker_invalid');
    if (!validateRevokedMarker(existing)) fail('revoked_marker_invalid', '既存revoked.jsonが不正です');
    if (existing.review_unit_id === reviewUnitId && existing.superseded_by === supersededBy) {
      process.stdout.write(`${JSON.stringify({ ok: true, unchanged: true, marker: paths.revoked })}\n`);
      return;
    }
    fail('revoke_conflict', '既存revoke markerの後継またはreview_unit_idが異なります');
  }
  let fixed = false;
  try {
    const manifest = readJson(paths.manifest, 'tooling_manifest_invalid');
    fixed = realpathSync(SOURCE_CHECKER) === realpathSync(manifest.files.checker.path)
      && sha256File(SOURCE_CHECKER) === manifest.files.checker.sha256;
  } catch { fixed = false; }
  const marker = { format_version: 1, review_unit_id: reviewUnitId, superseded_by: supersededBy, created_by: fixed ? 'fixed-checker' : 'source-fallback' };
  atomicWriteJson(paths.revoked, marker, true);
  if (!fixed) {
    const newReviewDir = join(paths.parent, supersededBy);
    const deviation = { kind: 'revoke_fallback', old_review_dir: reviewDir, new_review_dir: newReviewDir, review_unit_id: reviewUnitId, recorded_at: new Date().toISOString() };
    atomicWriteJson(join(reviewDir, 'evidence', 'revoke-fallback.json'), deviation);
    atomicWriteJson(join(newReviewDir, 'evidence', 'revoke-fallback.json'), deviation);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, unchanged: false, marker: paths.revoked, created_by: marker.created_by })}\n`);
}

function forcedRevoke(reviewDir, options) {
  const reviewUnitId = option(options, 'review-unit-id', true);
  const supersededBy = option(options, 'superseded-by', true);
  const approvalPath = requireAbsolute(option(options, 'approval-record', true), '--approval-record');
  const approval = readJson(approvalPath, 'forced_revoke_approval_invalid');
  if (!UUID_RE.test(reviewUnitId) || !approval || approval.review_unit_id !== reviewUnitId
    || approval.superseded_by !== supersededBy || typeof approval.approved_by !== 'string' || !approval.approved_by
    || Number.isNaN(Date.parse(approval.approved_at)) || typeof approval.reason !== 'string' || !approval.reason) {
    fail('forced_revoke_approval_invalid', '承認記録の必須欄・文法・引数との一致を満たしません');
  }
  const paths = reviewPaths(reviewDir);
  const header = readHeader(paths.manifest);
  if (header && header.review_unit_id !== reviewUnitId) {
    fail('forced_revoke_review_unit_mismatch', '引数のreview_unit_idが固定最小ヘッダーと一致しません');
  }
  mkdirSync(paths.forcedRegistry, { recursive: true });
  const markerPath = join(paths.forcedRegistry, `${reviewUnitId}.json`);
  const marker = {
    format_version: 1, kind: 'forced_revoke', review_unit_id: reviewUnitId,
    created_by: 'forced-revoke-cli',
    canonical_review_dir: reviewDir, superseded_by: supersededBy,
    reason: approval.reason, approved_by: approval.approved_by, approved_at: approval.approved_at,
  };
  if (existsSync(markerPath)) {
    const existing = readJson(markerPath, 'forced_revoke_invalid');
    if (!validateForcedMarker(existing) || existing.review_unit_id !== reviewUnitId
      || existing.canonical_review_dir !== reviewDir || existing.superseded_by !== supersededBy) {
      fail('forced_revoke_conflict', '既存forced markerの同一性項目が一致しません');
    }
    process.stdout.write(`${JSON.stringify({ ok: true, unchanged: true, marker: markerPath })}\n`);
    return;
  }
  atomicWriteJson(markerPath, marker, true);
  process.stdout.write(`${JSON.stringify({ ok: true, unchanged: false, marker: markerPath })}\n`);
}

function main() {
  const { mode, options, command } = parseCli(process.argv.slice(2));
  const reviewDir = requireAbsolute(option(options, 'review-dir', true), '--review-dir');
  if (mode === 'bootstrap') {
    assertKnownOptions(options, ['review-dir', 'abandoned-review-dir', 'abandonment-record']);
    bootstrap(reviewDir, options);
  } else if (mode === 'revoke') {
    assertKnownOptions(options, ['review-dir', 'superseded-by']);
    revoke(reviewDir, option(options, 'superseded-by', true));
  } else if (mode === 'forced-revoke') {
    assertKnownOptions(options, ['review-dir', 'review-unit-id', 'superseded-by', 'approval-record']);
    forcedRevoke(reviewDir, options);
  } else if (mode === 'direction') {
    assertKnownOptions(options, ['review-dir', 'direction']);
    directionMode(reviewDir, requireAbsolute(option(options, 'direction', true), '--direction'));
  } else if (mode === 'prepare') {
    assertKnownOptions(options, ['review-dir', 'direction', 'contract', 'manifest', 'boundary', 'expected-result', 'unverified', 'changed-file']);
    prepareMode(reviewDir, requireAbsolute(option(options, 'direction', true), '--direction'), options);
  } else if (mode === 'record') {
    assertKnownOptions(options, ['review-dir', 'contract', 'manifest', 'expect-exit', 'mutation', 'initial-evidence-ref']);
    recordMode(reviewDir, options, command);
  } else if (mode === 'verify') {
    assertKnownOptions(options, ['review-dir', 'direction', 'manifest']);
    verifyMode(reviewDir, requireAbsolute(option(options, 'direction', true), '--direction'), optionsList(options, 'manifest'));
  } else if (mode === 'ledger-prompt') {
    assertKnownOptions(options, ['review-dir', 'direction', 'phase', 'events', 'reviewer', 'round', 'session-id', 'prompt']);
    ledgerPromptMode(reviewDir, requireAbsolute(option(options, 'direction', true), '--direction'), options);
  } else if (mode === 'ledger-result') {
    assertKnownOptions(options, ['review-dir', 'direction', 'phase', 'events', 'reviewer', 'round', 'session-id', 'result']);
    ledgerResultMode(reviewDir, requireAbsolute(option(options, 'direction', true), '--direction'), options);
  } else if (mode === 'review-ledger') {
    assertKnownOptions(options, ['review-dir', 'direction', 'phase', 'events', 'execution-point', 'round']);
    reviewLedger(reviewDir, requireAbsolute(option(options, 'direction', true), '--direction'), options);
  } else {
    fail('usage', `未知のモードです: ${mode}`);
  }
}

try {
  main();
} catch (error) {
  const diagnostic = error instanceof DiagnosticError ? error.diagnostic : 'unexpected_error';
  const exitCode = error instanceof DiagnosticError ? error.exitCode : 1;
  const output = { ok: false, diagnostic, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) };
  process.stderr.write(`${JSON.stringify(output)}\n`);
  process.exitCode = exitCode;
}
