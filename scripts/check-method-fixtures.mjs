#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const selfPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(selfPath), '..');
const workBase = join(repoRoot, '.work');
mkdirSync(workBase, { recursive: true });
const workRoot = mkdtempSync(join(workBase, 'method-fixtures-'));
const runsRoot = join(workRoot, 'runs');
const logsRoot = join(workRoot, 'logs');
const sourceChecker = join(repoRoot, 'src/plugin/skills/direction/references/check-evidence-package.mjs');
const reviewLogChecker = join(repoRoot, 'src/plugin/skills/cross-review/references/check-review-log.mjs');
const methodStats = join(repoRoot, 'scripts/method-stats.mjs');
const sessionMetrics = join(repoRoot, 'src/plugin/skills/method-check/references/session-metrics.mjs');
const waitUsage = join(repoRoot, 'scripts/check-wait-usage.mjs');
const BREAKDOWN_KEYS_FX = ['llmGenerationMs', 'methodOpsMs', 'toolExecutionMs', 'delegationWaitMs', 'unattributedMs'];
const results = [];

if (process.argv[2] === '--root-probe') {
  const started = Date.now();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  process.stdout.write(`${JSON.stringify({ root: workRoot, started, ended: Date.now() })}\n`);
  process.exit(0);
}

function sha(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function run(command, args, cwd, env = process.env) {
  return spawnSync(command, args, { cwd, env, encoding: 'utf8' });
}

function expect(name, command, args, cwd, expectedExit, diagnostic = null, outputIncludes = []) {
  const result = run(command, args, cwd);
  const combined = `${result.stdout}\n${result.stderr}`;
  const diagnostics = combined.split('\n').flatMap((line) => {
    try { const value = JSON.parse(line); return typeof value?.diagnostic === 'string' ? [value.diagnostic] : []; } catch { return []; }
  });
  const passed = result.status === expectedExit
    && (!diagnostic || diagnostics.includes(diagnostic))
    && outputIncludes.every((value) => combined.includes(value));
  const log = join(logsRoot, `${name}.log`);
  writeFileSync(log, [
    `command=${JSON.stringify([command, ...args])}`, `cwd=${cwd}`,
    `expected_exit=${expectedExit}`, `actual_exit=${result.status}`, `expected_diagnostic=${diagnostic ?? ''}`,
    '--- stdout ---', result.stdout, '--- stderr ---', result.stderr,
  ].join('\n'));
  results.push({ name, passed, expected_exit: expectedExit, actual_exit: result.status, diagnostic, log });
  if (!passed) throw new Error(`${name}: exit=${result.status}\n${combined}`);
  return result;
}

function assertion(name, passed, details = {}) {
  results.push({ name, passed, ...details });
  if (!passed) throw new Error(`${name}: ${JSON.stringify(details)}`);
}

function git(cwd, args) {
  const result = run('git', args, cwd);
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function directionText(paths, id = 'EC-FX-01', type = 'automated。') {
  return `# Fixture\n\n##### ${id}: fixture\n\n- 振る舞い: fixture behavior\n- 変更面: ${paths.map((path) => `\`${path}\``).join('、')}\n- oracle: command observes the contract\n- 反証: an intentional drift must fail\n- 証拠種別: ${type}\n- 証拠: fixture log and hashes\n\n#### 変更マップ\n\n${paths.map((path) => `- \`${path}\``).join('\n')}\n`;
}

function initRepo(name, direction = directionText(['target.txt']), files = { 'target.txt': 'before\n' }) {
  const root = join(runsRoot, name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'user.name', 'Method Fixture']);
  const directionPath = join(root, `${name}.md`);
  writeFileSync(directionPath, direction);
  const fixtureFiles = {
    '.fixture-baseline.mjs': 'console.log("1 pass, 0 fail");\n',
    '.fixture-mutation.mjs': 'process.exit(1);\n',
    ...files,
  };
  for (const [relativePath, body] of Object.entries(fixtureFiles)) {
    const path = join(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'fixture baseline']);
  const reviewDir = join(root, '.work', name);
  expect(`${name}-bootstrap`, process.execPath, [sourceChecker, 'bootstrap', '--review-dir', reviewDir], root, 0);
  const toolingPath = join(reviewDir, 'evidence/tooling/tooling-manifest.json');
  const tooling = JSON.parse(readFileSync(toolingPath));
  return { root, directionPath, reviewDir, fixed: tooling.files.checker.path, tooling, toolingPath };
}

function recordEvidencePair(name, fx, manifest, contract = 'EC-FX-01') {
  expect(`${name}-baseline`, process.execPath, [fx.fixed, 'record', '--review-dir', fx.reviewDir, '--contract', contract,
    '--manifest', manifest, '--', process.execPath, '.fixture-baseline.mjs'], fx.root, 0);
  expect(`${name}-mutation`, process.execPath, [fx.fixed, 'record', '--review-dir', fx.reviewDir, '--contract', contract,
    '--manifest', manifest, '--expect-exit', '1', '--mutation', 'intentional-drift', '--', process.execPath, '.fixture-mutation.mjs'], fx.root, 0);
}

function recordMutation(name, fx, manifest, contract = 'EC-FX-01') {
  expect(`${name}-mutation`, process.execPath, [fx.fixed, 'record', '--review-dir', fx.reviewDir, '--contract', contract,
    '--manifest', manifest, '--expect-exit', '1', '--mutation', 'intentional-drift', '--', process.execPath, '.fixture-mutation.mjs'], fx.root, 0);
}

function evidencePairRequirementFixtures() {
  const baselineOnly = initRepo('ev02-baseline-only');
  const baselineManifest = join(baselineOnly.reviewDir, 'evidence/manifests/EC-FX-01.json');
  expect('ev02-baseline-only-prepare', process.execPath, [baselineOnly.fixed, 'prepare', '--review-dir', baselineOnly.reviewDir, '--direction', baselineOnly.directionPath, '--contract', 'EC-FX-01', '--manifest', baselineManifest], baselineOnly.root, 0);
  expect('ev02-baseline-only-record', process.execPath, [baselineOnly.fixed, 'record', '--review-dir', baselineOnly.reviewDir, '--contract', 'EC-FX-01', '--manifest', baselineManifest, '--', process.execPath, '.fixture-baseline.mjs'], baselineOnly.root, 0);
  expect('ev02-mutation-missing', process.execPath, [baselineOnly.fixed, 'verify', '--review-dir', baselineOnly.reviewDir, '--direction', baselineOnly.directionPath, '--manifest', baselineManifest], baselineOnly.root, 1, 'automated_mutation_missing');

  const mutationOnly = initRepo('ev02-mutation-only');
  const mutationManifest = join(mutationOnly.reviewDir, 'evidence/manifests/EC-FX-01.json');
  expect('ev02-mutation-only-prepare', process.execPath, [mutationOnly.fixed, 'prepare', '--review-dir', mutationOnly.reviewDir, '--direction', mutationOnly.directionPath, '--contract', 'EC-FX-01', '--manifest', mutationManifest], mutationOnly.root, 0);
  recordMutation('ev02-mutation-only', mutationOnly, mutationManifest);
  expect('ev02-baseline-missing', process.execPath, [mutationOnly.fixed, 'verify', '--review-dir', mutationOnly.reviewDir, '--direction', mutationOnly.directionPath, '--manifest', mutationManifest], mutationOnly.root, 1, 'automated_baseline_missing');
}

function withBackup(path, mutate, specimen, callback) {
  const backup = `${path}.backup`;
  copyFileSync(path, backup);
  try {
    mutate();
    mkdirSync(dirname(specimen), { recursive: true });
    copyFileSync(path, specimen);
    callback();
  } finally {
    copyFileSync(backup, path);
  }
}

function evidenceReadinessFixtures() {
  const base = directionText(['target.txt']);
  const mutations = [
    ['required-missing', (body) => body.replace('- oracle: command observes the contract\n', ''), 'contract_required_field_missing'],
    ['duplicate', (body) => `${body}\n${body.match(/##### EC-FX-01:[\s\S]*?(?=#### 変更マップ)/)[0]}`, 'duplicate_contract_id'],
    ['type-invalid', (body) => body.replace('証拠種別: automated。', '証拠種別: manual。'), 'invalid_evidence_type'],
    ['type-mixed', (body) => body.replace('証拠種別: automated。', '証拠種別: automated / review-required（理由: x。残余リスク: y）'), 'mixed_evidence_type'],
    ['rationale-missing', (body) => body.replace('証拠種別: automated。', '証拠種別: review-required。'), 'review_required_rationale_missing'],
    ['map-unmapped', (body) => body.replace('- `target.txt`\n', '- `other.txt`\n'), 'change_map_unmapped'],
  ];
  const normal = initRepo('ev01-normal', base);
  expect('ev01-normal-direction', process.execPath, [normal.fixed, 'direction', '--review-dir', normal.reviewDir, '--direction', normal.directionPath], normal.root, 0);
  for (const [suffix, mutate, diagnostic] of mutations) {
    const fx = initRepo(`ev01-${suffix}`, base);
    withBackup(fx.directionPath, () => writeFileSync(fx.directionPath, mutate(readFileSync(fx.directionPath, 'utf8'))),
      join(fx.reviewDir, `evidence/specimens/${suffix}.md`), () => {
        expect(`ev01-${suffix}`, process.execPath, [fx.fixed, 'direction', '--review-dir', fx.reviewDir, '--direction', fx.directionPath], fx.root, 1, diagnostic);
      });
  }
}

function packageFixtures() {
  const paths = ['modified.txt', 'deleted.txt', 'renamed.txt', 'untracked.txt'];
  const fx = initRepo('ev02-package', directionText(paths), {
    'modified.txt': 'before\n', 'deleted.txt': 'delete\n', 'old.txt': 'rename\n',
    'entry.mjs': 'console.log("1 pass, 0 fail");\n',
    'initial-evidence.json': '{"initial":true}\n',
  });
  writeFileSync(join(fx.root, 'modified.txt'), 'after\n');
  rmSync(join(fx.root, 'deleted.txt'));
  git(fx.root, ['mv', 'old.txt', 'renamed.txt']);
  writeFileSync(join(fx.root, 'untracked.txt'), 'new\n');
  const manifest = join(fx.reviewDir, 'evidence/manifests/EC-FX-01.json');
  expect('ev02-prepare', process.execPath, [fx.fixed, 'prepare', '--review-dir', fx.reviewDir, '--direction', fx.directionPath, '--contract', 'EC-FX-01', '--manifest', manifest], fx.root, 0);
  const initialEvidence = join(fx.root, 'initial-evidence.json');
  expect('ev02-record', process.execPath, [fx.fixed, 'record', '--review-dir', fx.reviewDir, '--contract', 'EC-FX-01', '--manifest', manifest, '--mutation', 'bootstrap_reexecution', '--initial-evidence-ref', initialEvidence, '--', process.execPath, 'entry.mjs'], fx.root, 0);
  const bootstrapRecord = JSON.parse(readFileSync(manifest)).contracts[0].records[0];
  assertion('ev02-bootstrap-reexecution-recorded', bootstrapRecord.mutation === 'bootstrap_reexecution'
    && bootstrapRecord.initial_evidence_refs?.[0]?.path === initialEvidence
    && bootstrapRecord.initial_evidence_refs?.[0]?.sha256 === sha(initialEvidence));
  expect('ev02-initial-evidence-missing', process.execPath, [fx.fixed, 'record', '--review-dir', fx.reviewDir, '--contract', 'EC-FX-01', '--manifest', manifest, '--initial-evidence-ref', join(fx.root, 'missing-evidence.json'), '--', process.execPath, 'entry.mjs'], fx.root, 1, 'initial_evidence_missing');
  recordEvidencePair('ev02-pair', fx, manifest);
  expect('ev02-verify', process.execPath, [fx.fixed, 'verify', '--review-dir', fx.reviewDir, '--direction', fx.directionPath, '--manifest', manifest], fx.root, 0);
  withBackup(initialEvidence, () => writeFileSync(initialEvidence, '{"initial":false}\n'), join(fx.reviewDir, 'evidence/specimens/initial-evidence-stale.json'), () => {
    expect('ev02-initial-evidence-stale', process.execPath, [fx.fixed, 'verify', '--review-dir', fx.reviewDir, '--direction', fx.directionPath, '--manifest', manifest], fx.root, 1, 'initial_evidence_stale');
  });
  expect('ev03-source-record', process.execPath, [sourceChecker, 'record', '--review-dir', fx.reviewDir, '--contract', 'EC-FX-01', '--manifest', manifest, '--', process.execPath, 'entry.mjs'], fx.root, 1, 'untrusted_record_entry');

  withBackup(join(fx.root, 'modified.txt'), () => writeFileSync(join(fx.root, 'modified.txt'), 'drift\n'), join(fx.reviewDir, 'evidence/specimens/changed-file.txt'), () => {
    expect('ev02-changed-file-stale', process.execPath, [fx.fixed, 'verify', '--review-dir', fx.reviewDir, '--direction', fx.directionPath, '--manifest', manifest], fx.root, 1, 'changed_file_stale');
  });
  const recordLog = JSON.parse(readFileSync(manifest)).contracts[0].records[0].log_path;
  withBackup(recordLog, () => writeFileSync(recordLog, `${readFileSync(recordLog, 'utf8')}x`), join(fx.reviewDir, 'evidence/specimens/log-tampered.log'), () => {
    expect('ev03-record-log-tampered', process.execPath, [fx.fixed, 'verify', '--review-dir', fx.reviewDir, '--direction', fx.directionPath, '--manifest', manifest], fx.root, 1, 'record_log_tampered');
  });
  withBackup(manifest, () => {
    const value = JSON.parse(readFileSync(manifest));
    value.contracts[0].records[0].runtime_snapshot.platform = 'wrong-platform';
    writeFileSync(manifest, `${JSON.stringify(value, null, 2)}\n`);
  }, join(fx.reviewDir, 'evidence/specimens/runtime-stale.json'), () => {
    expect('ev03-runtime-stale', process.execPath, [fx.fixed, 'verify', '--review-dir', fx.reviewDir, '--direction', fx.directionPath, '--manifest', manifest], fx.root, 1, 'runtime_snapshot_stale');
  });
  const adjacent = join(fx.root, '.work/adjacent.txt');
  writeFileSync(adjacent, 'unmapped\n');
  expect('ev02-adjacent-work-not-excluded', process.execPath, [fx.fixed, 'verify', '--review-dir', fx.reviewDir, '--direction', fx.directionPath, '--manifest', manifest], fx.root, 1, 'actual_diff_unmapped');
  rmSync(adjacent);
}

function twoContractDirection() {
  return `# Fixture\n\n##### EC-FX-01: first\n\n- 振る舞い: first\n- 変更面: \`target.txt\`\n- oracle: first command\n- 反証: first drift\n- 証拠種別: automated。\n- 証拠: first log\n\n##### EC-FX-02: second\n\n- 振る舞い: second\n- 変更面: \`other.txt\`\n- oracle: second command\n- 反証: second drift\n- 証拠種別: automated。\n- 証拠: second log\n\n#### 変更マップ\n\n- \`target.txt\`\n- \`other.txt\`\n`;
}

function manifestIntegrityFixtures() {
  const setFx = initRepo('ev02-contract-set', twoContractDirection(), {
    'target.txt': 'before\n', 'other.txt': 'before\n', 'entry.mjs': 'console.log("1 pass, 0 fail");\n',
  });
  writeFileSync(join(setFx.root, 'target.txt'), 'after\n'); writeFileSync(join(setFx.root, 'other.txt'), 'after\n');
  const manifests = ['EC-FX-01', 'EC-FX-02'].map((id) => join(setFx.reviewDir, `evidence/manifests/${id}.json`));
  for (let index = 0; index < manifests.length; index += 1) {
    const id = `EC-FX-0${index + 1}`;
    expect(`ev02-contract-set-${id}-prepare`, process.execPath, [setFx.fixed, 'prepare', '--review-dir', setFx.reviewDir, '--direction', setFx.directionPath, '--contract', id, '--manifest', manifests[index]], setFx.root, 0);
    expect(`ev02-contract-set-${id}-record`, process.execPath, [setFx.fixed, 'record', '--review-dir', setFx.reviewDir, '--contract', id, '--manifest', manifests[index], '--', process.execPath, 'entry.mjs'], setFx.root, 0);
    recordMutation(`ev02-contract-set-${id}`, setFx, manifests[index], id);
  }
  expect('ev02-contract-set-missing', process.execPath, [setFx.fixed, 'verify', '--review-dir', setFx.reviewDir, '--direction', setFx.directionPath, '--manifest', manifests[0]], setFx.root, 1, 'evidence_contract_set_mismatch');
  expect('ev02-contract-set-duplicate', process.execPath, [setFx.fixed, 'verify', '--review-dir', setFx.reviewDir, '--direction', setFx.directionPath, '--manifest', manifests[0], '--manifest', manifests[0], '--manifest', manifests[1]], setFx.root, 1, 'evidence_contract_duplicate');
  expect('ev02-contract-set-complete', process.execPath, [setFx.fixed, 'verify', '--review-dir', setFx.reviewDir, '--direction', setFx.directionPath, '--manifest', manifests[0], '--manifest', manifests[1]], setFx.root, 0);
  expect('ev02-manifest-file-missing', process.execPath, [setFx.fixed, 'verify', '--review-dir', setFx.reviewDir, '--direction', setFx.directionPath, '--manifest', join(setFx.root, 'missing-manifest.json')], setFx.root, 1, 'evidence_manifest_missing');

  const schemaFx = initRepo('ev02-schema-strict', directionText(['target.txt']), {
    'target.txt': 'before\n',
    'entry.mjs': 'console.log("1 pass, 0 fail");\n',
    'alternate.mjs': 'console.log("1 pass, 0 fail");\n',
  });
  writeFileSync(join(schemaFx.root, 'target.txt'), 'after\n'); const manifest = join(schemaFx.reviewDir, 'evidence/manifests/EC-FX-01.json');
  expect('ev02-schema-prepare', process.execPath, [schemaFx.fixed, 'prepare', '--review-dir', schemaFx.reviewDir, '--direction', schemaFx.directionPath, '--contract', 'EC-FX-01', '--manifest', manifest], schemaFx.root, 0);
  expect('ev02-schema-record', process.execPath, [schemaFx.fixed, 'record', '--review-dir', schemaFx.reviewDir, '--contract', 'EC-FX-01', '--manifest', manifest, '--', process.execPath, 'entry.mjs'], schemaFx.root, 0);
  recordMutation('ev02-schema', schemaFx, manifest);
  for (const [name, mutate] of [
    ['top-additional', (value) => { value.extra = true; }],
    ['required-missing', (value) => { delete value.boundary; }],
    ['unknown-scope', (value) => { value.contracts[0].input_scope = 'unknown'; }],
    ['record-additional', (value) => { value.contracts[0].records[0].extra = true; }],
    ['record-command-missing', (value) => { delete value.contracts[0].records[0].command; }],
  ]) withBackup(manifest, () => { const value = JSON.parse(readFileSync(manifest)); mutate(value); writeFileSync(manifest, JSON.stringify(value)); }, join(schemaFx.reviewDir, `evidence/specimens/schema-${name}.json`), () => {
    expect(`ev02-schema-${name}`, process.execPath, [schemaFx.fixed, 'verify', '--review-dir', schemaFx.reviewDir, '--direction', schemaFx.directionPath, '--manifest', manifest], schemaFx.root, 1, 'evidence_manifest_schema_invalid');
  });
  withBackup(manifest, () => { const value = JSON.parse(readFileSync(manifest)); value.contracts[0].oracle_inputs = []; writeFileSync(manifest, JSON.stringify(value)); }, join(schemaFx.reviewDir, 'evidence/specimens/oracle-inputs-tampered.json'), () => {
    expect('ev03-oracle-inputs-tampered', process.execPath, [schemaFx.fixed, 'verify', '--review-dir', schemaFx.reviewDir, '--direction', schemaFx.directionPath, '--manifest', manifest], schemaFx.root, 1, 'record_inputs_tampered');
  });
  withBackup(manifest, () => {
    const value = JSON.parse(readFileSync(manifest));
    value.contracts[0].records[0].command = [process.execPath, 'alternate.mjs'];
    value.contracts[0].oracle_inputs = [{ path: 'alternate.mjs', sha256: sha(join(schemaFx.root, 'alternate.mjs')) }];
    value.contracts[0].input_scope = 'explicit';
    value.contracts[0].unverified = [];
    writeFileSync(manifest, `${JSON.stringify(value, null, 2)}\n`);
  }, join(schemaFx.reviewDir, 'evidence/specimens/record-command-metadata-tampered.json'), () => {
    expect('ev03-record-command-metadata-tampered', process.execPath, [schemaFx.fixed, 'verify', '--review-dir', schemaFx.reviewDir, '--direction', schemaFx.directionPath, '--manifest', manifest], schemaFx.root, 1, 'record_metadata_tampered');
  });
  for (const [name, mutate] of [
    ['pass-count', (record) => { record.pass_count += 1; }],
    ['declared-unverified', (record) => { record.declared_unverified = ['tampered declaration']; }],
  ]) withBackup(manifest, () => {
    const value = JSON.parse(readFileSync(manifest)); mutate(value.contracts[0].records[0]); writeFileSync(manifest, `${JSON.stringify(value, null, 2)}\n`);
  }, join(schemaFx.reviewDir, `evidence/specimens/record-${name}-tampered.json`), () => {
    expect(`ev03-record-${name}-tampered`, process.execPath, [schemaFx.fixed, 'verify', '--review-dir', schemaFx.reviewDir, '--direction', schemaFx.directionPath, '--manifest', manifest], schemaFx.root, 1, 'record_metadata_tampered');
  });
  const recordLog = JSON.parse(readFileSync(manifest)).contracts[0].records[0].log_path;
  for (const [name, mutate] of [
    ['missing', (body) => { const value = JSON.parse(body); delete value.metadata.expected_exit_code; return `${JSON.stringify(value)}\n`; }],
    ['duplicate', (body) => body.replace('"expected_exit_code":0', '"expected_exit_code":0,"expected_exit_code":0')],
    ['ambiguous', () => '{"format_version":1'],
  ]) {
    withBackup(recordLog, () => writeFileSync(recordLog, mutate(readFileSync(recordLog, 'utf8'))), join(schemaFx.reviewDir, `evidence/specimens/record-metadata-${name}.log`), () => {
      withBackup(manifest, () => {
        const value = JSON.parse(readFileSync(manifest));
        value.contracts[0].records[0].log_sha256 = sha(recordLog);
        writeFileSync(manifest, `${JSON.stringify(value, null, 2)}\n`);
      }, join(schemaFx.reviewDir, `evidence/specimens/record-metadata-${name}.json`), () => {
        expect(`ev03-record-metadata-${name}`, process.execPath, [schemaFx.fixed, 'verify', '--review-dir', schemaFx.reviewDir, '--direction', schemaFx.directionPath, '--manifest', manifest], schemaFx.root, 1, 'record_metadata_tampered');
      });
    });
  }

  const falseGreen = initRepo('ev03-fail-count-false-green', directionText(['target.txt']), {
    'target.txt': 'before\n', 'entry.mjs': 'console.log("0 pass, 1 fail");\n',
  });
  writeFileSync(join(falseGreen.root, 'target.txt'), 'after\n');
  const falseGreenManifest = join(falseGreen.reviewDir, 'evidence/manifests/EC-FX-01.json');
  expect('ev03-fail-count-prepare', process.execPath, [falseGreen.fixed, 'prepare', '--review-dir', falseGreen.reviewDir, '--direction', falseGreen.directionPath, '--contract', 'EC-FX-01', '--manifest', falseGreenManifest], falseGreen.root, 0);
  expect('ev03-fail-count-record', process.execPath, [falseGreen.fixed, 'record', '--review-dir', falseGreen.reviewDir, '--contract', 'EC-FX-01', '--manifest', falseGreenManifest, '--', process.execPath, 'entry.mjs'], falseGreen.root, 0);
  recordMutation('ev03-fail-count', falseGreen, falseGreenManifest);
  expect('ev03-fail-count-baseline-red', process.execPath, [falseGreen.fixed, 'verify', '--review-dir', falseGreen.reviewDir, '--direction', falseGreen.directionPath, '--manifest', falseGreenManifest], falseGreen.root, 1, 'record_failed');
  withBackup(falseGreenManifest, () => {
    const value = JSON.parse(readFileSync(falseGreenManifest)); value.contracts[0].records[0].fail_count = 0; writeFileSync(falseGreenManifest, `${JSON.stringify(value, null, 2)}\n`);
  }, join(falseGreen.reviewDir, 'evidence/specimens/record-fail-count-false-green.json'), () => {
    expect('ev03-record-fail-count-tampered', process.execPath, [falseGreen.fixed, 'verify', '--review-dir', falseGreen.reviewDir, '--direction', falseGreen.directionPath, '--manifest', falseGreenManifest], falseGreen.root, 1, 'record_metadata_tampered');
  });

  const bypass = initRepo('ev03-unverified-tamper', directionText(['target.txt']), { 'target.txt': 'before\n', 'entry.mjs': 'import "missing-fixture-package";\n' });
  writeFileSync(join(bypass.root, 'target.txt'), 'after\n'); const bypassManifest = join(bypass.reviewDir, 'evidence/manifests/EC-FX-01.json');
  expect('ev03-unverified-tamper-prepare', process.execPath, [bypass.fixed, 'prepare', '--review-dir', bypass.reviewDir, '--direction', bypass.directionPath, '--contract', 'EC-FX-01', '--manifest', bypassManifest], bypass.root, 0);
  expect('ev03-unverified-tamper-record', process.execPath, [bypass.fixed, 'record', '--review-dir', bypass.reviewDir, '--contract', 'EC-FX-01', '--manifest', bypassManifest, '--expect-exit', '1', '--', process.execPath, 'entry.mjs'], bypass.root, 0);
  recordEvidencePair('ev03-unverified-tamper-pair', bypass, bypassManifest);
  withBackup(bypassManifest, () => { const value = JSON.parse(readFileSync(bypassManifest)); value.contracts[0].input_scope = 'explicit'; value.contracts[0].oracle_inputs = []; value.contracts[0].unverified = []; writeFileSync(bypassManifest, JSON.stringify(value)); }, join(bypass.reviewDir, 'evidence/specimens/unverified-cleared.json'), () => {
    expect('ev03-unverified-tamper-rejected', process.execPath, [bypass.fixed, 'verify', '--review-dir', bypass.reviewDir, '--direction', bypass.directionPath, '--manifest', bypassManifest], bypass.root, 1, 'record_inputs_tampered');
  });

  const multiple = initRepo('ev03-multiple-record-inputs', directionText(['target.txt']), {
    'target.txt': 'before\n', 'one.mjs': 'import "./one-leaf.mjs"; console.log("1 pass, 0 fail");\n', 'one-leaf.mjs': 'export const one=1;\n',
    'two.mjs': 'import "./two-leaf.mjs"; console.log("1 pass, 0 fail");\n', 'two-leaf.mjs': 'export const two=2;\n',
  });
  writeFileSync(join(multiple.root, 'target.txt'), 'after\n'); const multipleManifest = join(multiple.reviewDir, 'evidence/manifests/EC-FX-01.json');
  expect('ev03-multiple-prepare', process.execPath, [multiple.fixed, 'prepare', '--review-dir', multiple.reviewDir, '--direction', multiple.directionPath, '--contract', 'EC-FX-01', '--manifest', multipleManifest], multiple.root, 0);
  for (const entry of ['one.mjs', 'two.mjs']) expect(`ev03-multiple-record-${entry}`, process.execPath, [multiple.fixed, 'record', '--review-dir', multiple.reviewDir, '--contract', 'EC-FX-01', '--manifest', multipleManifest, '--', process.execPath, entry], multiple.root, 0);
  recordMutation('ev03-multiple', multiple, multipleManifest);
  expect('ev03-multiple-verify', process.execPath, [multiple.fixed, 'verify', '--review-dir', multiple.reviewDir, '--direction', multiple.directionPath, '--manifest', multipleManifest], multiple.root, 0);
  assertion('ev03-multiple-union', ['one.mjs', 'one-leaf.mjs', 'two.mjs', 'two-leaf.mjs'].every((path) => JSON.parse(readFileSync(multipleManifest)).contracts[0].oracle_inputs.some((input) => input.path === path)));

  const invalidSchema = initRepo('ev02-schema-syntax'); const invalidSchemaPath = invalidSchema.tooling.files.schema.path;
  writeFileSync(invalidSchemaPath, '{'); const tooling = JSON.parse(readFileSync(invalidSchema.toolingPath)); tooling.files.schema.sha256 = sha(invalidSchemaPath); writeFileSync(invalidSchema.toolingPath, JSON.stringify(tooling));
  const invalidManifest = join(invalidSchema.reviewDir, 'evidence/manifests/EC-FX-01.json');
  expect('ev02-schema-syntax-prepare', process.execPath, [invalidSchema.fixed, 'prepare', '--review-dir', invalidSchema.reviewDir, '--direction', invalidSchema.directionPath, '--contract', 'EC-FX-01', '--manifest', invalidManifest], invalidSchema.root, 0);
  expect('ev02-schema-syntax-invalid', process.execPath, [invalidSchema.fixed, 'record', '--review-dir', invalidSchema.reviewDir, '--contract', 'EC-FX-01', '--manifest', invalidManifest, '--', process.execPath, 'missing.mjs'], invalidSchema.root, 1, 'evidence_schema_invalid');
}

function resolverFixture(name, source, expectedVerify = 0, diagnostic = null, expectedCommandExit = 0) {
  const fx = initRepo(name, directionText(['target.txt']), {
    'target.txt': 'before\n',
    'entry.mjs': source,
    'helper.mjs': 'import { value } from "./leaf.mjs"; import { readFileSync } from "node:fs"; export const helper = value + readFileSync("./data.txt", "utf8").length;\n',
    'leaf.mjs': 'export const value = 1;\n',
    'data.txt': 'data\n',
  });
  writeFileSync(join(fx.root, 'target.txt'), 'after\n');
  const manifest = join(fx.reviewDir, 'evidence/manifests/EC-FX-01.json');
  expect(`${name}-prepare`, process.execPath, [fx.fixed, 'prepare', '--review-dir', fx.reviewDir, '--direction', fx.directionPath, '--contract', 'EC-FX-01', '--manifest', manifest], fx.root, 0);
  expect(`${name}-record`, process.execPath, [fx.fixed, 'record', '--review-dir', fx.reviewDir, '--contract', 'EC-FX-01', '--manifest', manifest, '--expect-exit', String(expectedCommandExit), '--', process.execPath, 'entry.mjs'], fx.root, 0);
  recordEvidencePair(`${name}-pair`, fx, manifest);
  expect(`${name}-verify`, process.execPath, [fx.fixed, 'verify', '--review-dir', fx.reviewDir, '--direction', fx.directionPath, '--manifest', manifest], fx.root, expectedVerify, diagnostic);
  return JSON.parse(readFileSync(manifest)).contracts[0];
}

function resolverFixtures() {
  const explicit = resolverFixture('ev03-explicit', 'import { helper } from "./helper.mjs"; console.log(helper, "1 pass, 0 fail");\n');
  for (const path of ['entry.mjs', 'helper.mjs', 'leaf.mjs', 'data.txt']) {
    assertion(`ev03-explicit-${path}-recorded`, explicit.oracle_inputs.some((input) => input.path === path));
  }
  assertion('ev03-node-runtime-does-not-require-npm', explicit.records[0].runtime_snapshot.npm === null);
  const delimiterOutput = resolverFixture('ev03-log-delimiter-output', 'console.log("--- stdout ---\\n--- stderr ---\\n1 pass, 0 fail");\n');
  assertion('ev03-log-delimiter-counts-rederived', delimiterOutput.records[0].pass_count === 1 && delimiterOutput.records[0].fail_count === 0,
    { pass_count: delimiterOutput.records[0].pass_count, fail_count: delimiterOutput.records[0].fail_count });
  for (const [name, source] of [
    ['dynamic', 'if (false) await import("./leaf.mjs"); console.log("1 pass, 0 fail");\n'],
    ['variable', 'import { readFileSync } from "node:fs"; const p="./data.txt"; readFileSync(p); console.log("1 pass, 0 fail");\n'],
    ['glob', 'function glob(){} if(false) glob("**/*"); console.log("1 pass, 0 fail");\n'],
    ['child', 'import { spawn } from "node:child_process"; if(false) spawn("true"); console.log("1 pass, 0 fail");\n'],
    ['worker', 'if(false) new Worker("./worker.mjs"); console.log("1 pass, 0 fail");\n'],
    ['native', 'const p="./addon.node"; console.log(p, "1 pass, 0 fail");\n'],
    ['config', 'function findUp(){} if(false) findUp("config"); console.log("1 pass, 0 fail");\n'],
  ]) {
    const contract = resolverFixture(`ev03-${name}`, source);
    assertion(`ev03-${name}-repository-scope`, contract.input_scope === 'repository', { scope: contract.input_scope });
    assertion(`ev03-${name}-no-unverified`, contract.unverified.length === 0, { unverified: contract.unverified });
  }
  for (const [name, source, commandExit] of [
    ['external', 'import "not-installed-fixture-package";\n', 1],
    ['environment', 'if(false) console.log(process.env.X); console.log("1 pass, 0 fail");\n', 0],
    ['network', 'if(false) fetch("https://example.invalid"); console.log("1 pass, 0 fail");\n', 0],
    ['external-child-network', 'import { spawn } from "node:child_process"; if(false) spawn("curl", ["https://example.invalid"]); console.log("1 pass, 0 fail");\n', 0],
    ['time', 'if(false) console.log(Date.now(), Math.random()); console.log("1 pass, 0 fail");\n', 0],
  ]) resolverFixture(`ev03-${name}`, source, 1, 'automated_unverified_blocked', commandExit);

  const runner = initRepo('ev03-unsupported-runner'); writeFileSync(join(runner.root, 'target.txt'), 'after\n');
  const runnerManifest = join(runner.reviewDir, 'evidence/manifests/EC-FX-01.json');
  expect('ev03-runner-prepare', process.execPath, [runner.fixed, 'prepare', '--review-dir', runner.reviewDir, '--direction', runner.directionPath, '--contract', 'EC-FX-01', '--manifest', runnerManifest], runner.root, 0);
  expect('ev03-runner-record', process.execPath, [runner.fixed, 'record', '--review-dir', runner.reviewDir, '--contract', 'EC-FX-01', '--manifest', runnerManifest, '--', '/usr/bin/true'], runner.root, 0);
  recordMutation('ev03-runner', runner, runnerManifest);
  expect('ev03-runner-repository', process.execPath, [runner.fixed, 'verify', '--review-dir', runner.reviewDir, '--direction', runner.directionPath, '--manifest', runnerManifest], runner.root, 0);
  const runnerContract = JSON.parse(readFileSync(runnerManifest)).contracts[0];
  assertion('ev03-runner-repository-scope', runnerContract.input_scope === 'repository', { scope: runnerContract.input_scope });
  assertion('ev03-runner-no-unverified', runnerContract.unverified.length === 0, { unverified: runnerContract.unverified });

  const npm = initRepo('ev03-npm-preversion', directionText(['target.txt']), {
    'target.txt': 'before\n',
    'package.json': '{"scripts":{"preversion":"node scripts/check-method-fixtures.mjs"}}\n',
    'scripts/check-method-fixtures.mjs': 'import { spawnSync } from "node:child_process"; if(false) { spawnSync("curl", ["https://example.invalid"]); console.log(process.env.X, new Date()); } console.log("1 pass, 0 fail");\n',
  });
  writeFileSync(join(npm.root, 'target.txt'), 'after\n');
  const npmManifest = join(npm.reviewDir, 'evidence/manifests/EC-FX-01.json');
  expect('ev03-npm-preversion-prepare', process.execPath, [npm.fixed, 'prepare', '--review-dir', npm.reviewDir, '--direction', npm.directionPath, '--contract', 'EC-FX-01', '--manifest', npmManifest], npm.root, 0);
  expect('ev03-npm-preversion-record', process.execPath, [npm.fixed, 'record', '--review-dir', npm.reviewDir, '--contract', 'EC-FX-01', '--manifest', npmManifest, '--', 'npm', 'run', 'preversion', '--if-present'], npm.root, 0);
  expect('ev03-npm-preversion-unsafe-content-blocked', process.execPath, [npm.fixed, 'verify', '--review-dir', npm.reviewDir, '--direction', npm.directionPath, '--manifest', npmManifest], npm.root, 1, 'automated_unverified_blocked');
  const npmContract = JSON.parse(readFileSync(npmManifest)).contracts[0];
  assertion('ev03-npm-preversion-repository-scope', npmContract.input_scope === 'repository', { scope: npmContract.input_scope });
  assertion('ev03-npm-preversion-unsafe-content-unverified', npmContract.unverified.some((value) => value.includes('登録済みresolver内容不一致')), { unverified: npmContract.unverified });
  const missing = initRepo('ev03-missing-executable'); writeFileSync(join(missing.root, 'target.txt'), 'after\n'); const missingManifest = join(missing.reviewDir, 'evidence/manifests/EC-FX-01.json');
  expect('ev03-missing-executable-prepare', process.execPath, [missing.fixed, 'prepare', '--review-dir', missing.reviewDir, '--direction', missing.directionPath, '--contract', 'EC-FX-01', '--manifest', missingManifest], missing.root, 0);
  expect('ev03-missing-executable-record', process.execPath, [missing.fixed, 'record', '--review-dir', missing.reviewDir, '--contract', 'EC-FX-01', '--manifest', missingManifest, '--', 'definitely-missing-executable'], missing.root, 1, 'record_executable_missing');
}

function toolingFixtures() {
  const fx = initRepo('ev04-tooling');
  const original = JSON.parse(readFileSync(fx.toolingPath));
  const mtime = statSync(fx.toolingPath).mtimeMs;
  expect('ev04-bootstrap-idempotent', process.execPath, [sourceChecker, 'bootstrap', '--review-dir', fx.reviewDir], fx.root, 0);
  assertion('ev04-tooling-unchanged', JSON.parse(readFileSync(fx.toolingPath)).review_unit_id === original.review_unit_id && statSync(fx.toolingPath).mtimeMs === mtime);
  withBackup(fx.toolingPath, () => {
    const value = JSON.parse(readFileSync(fx.toolingPath)); value.format_version = 99; writeFileSync(fx.toolingPath, JSON.stringify(value));
  }, join(fx.reviewDir, 'evidence/specimens/unsupported-format.json'), () => {
    expect('ev04-format-version', process.execPath, [sourceChecker, 'bootstrap', '--review-dir', fx.reviewDir], fx.root, 1, 'unsupported_format_version');
  });
  withBackup(fx.toolingPath, () => {
    const value = JSON.parse(readFileSync(fx.toolingPath)); value.review_unit_id = '00000000-0000-4000-8000-000000000000'; writeFileSync(fx.toolingPath, JSON.stringify(value));
  }, join(fx.reviewDir, 'evidence/specimens/review-unit-id.json'), () => {
    expect('ev04-review-unit-id-mismatch', process.execPath, [sourceChecker, 'bootstrap', '--review-dir', fx.reviewDir], fx.root, 1, 'review_unit_id_mismatch');
  });
  const schema = fx.tooling.files.schema.path;
  withBackup(schema, () => writeFileSync(schema, `${readFileSync(schema, 'utf8')} `), join(fx.reviewDir, 'evidence/specimens/tooling-hash.json'), () => {
    expect('ev04-tooling-hash', process.execPath, [sourceChecker, 'bootstrap', '--review-dir', fx.reviewDir], fx.root, 1, 'tooling_hash_mismatch');
  });
  expect('ev04-revoke', process.execPath, [fx.fixed, 'revoke', '--review-dir', fx.reviewDir, '--superseded-by', 'successor'], fx.root, 0);
  expect('ev04-revoke-idempotent', process.execPath, [fx.fixed, 'revoke', '--review-dir', fx.reviewDir, '--superseded-by', 'successor'], fx.root, 0);
  expect('ev04-revoked-block', process.execPath, [fx.fixed, 'direction', '--review-dir', fx.reviewDir, '--direction', fx.directionPath], fx.root, 1, 'revoked_review_unit');

  const forced = initRepo('ev04-forced');
  const approval = join(forced.reviewDir, 'evidence/approval.json');
  writeFileSync(approval, JSON.stringify({ review_unit_id: forced.tooling.review_unit_id, superseded_by: 'forced-next', approved_by: 'fixture-user', approved_at: '2026-07-21T00:00:00Z', reason: 'fixture' }));
  expect('ev04-forced', process.execPath, [sourceChecker, 'forced-revoke', '--review-dir', forced.reviewDir, '--review-unit-id', forced.tooling.review_unit_id, '--superseded-by', 'forced-next', '--approval-record', approval], forced.root, 0);
  expect('ev04-forced-idempotent', process.execPath, [sourceChecker, 'forced-revoke', '--review-dir', forced.reviewDir, '--review-unit-id', forced.tooling.review_unit_id, '--superseded-by', 'forced-next', '--approval-record', approval], forced.root, 0);
  expect('ev04-forced-block', process.execPath, [forced.fixed, 'direction', '--review-dir', forced.reviewDir, '--direction', forced.directionPath], forced.root, 1, 'forced_revoke');
  const badApproval = join(forced.reviewDir, 'evidence/bad-approval.json');
  writeFileSync(badApproval, '{}');
  expect('ev04-forced-approval-required', process.execPath, [sourceChecker, 'forced-revoke', '--review-dir', forced.reviewDir, '--review-unit-id', forced.tooling.review_unit_id, '--superseded-by', 'other', '--approval-record', badApproval], forced.root, 1, 'forced_revoke_approval_invalid');

  const abandoned = join(runsRoot, 'ev04-abandonment');
  rmSync(abandoned, { recursive: true, force: true }); mkdirSync(abandoned, { recursive: true });
  git(abandoned, ['init', '-q']); git(abandoned, ['config', 'user.email', 'fixture@example.invalid']); git(abandoned, ['config', 'user.name', 'Fixture']);
  writeFileSync(join(abandoned, 'baseline'), 'x'); git(abandoned, ['add', '.']); git(abandoned, ['commit', '-qm', 'baseline']);
  const oldDir = join(abandoned, '.work/old'); const newDir = join(abandoned, '.work/new'); const recordPath = join(abandoned, 'approval.json');
  writeFileSync(recordPath, JSON.stringify({ format_version: 1, kind: 'unidentified', canonical_review_dir: oldDir, old_basename: 'old', new_basename: 'new', superseded_by: 'new', reason: 'lost id', approved_by: 'fixture-user', approved_at: '2026-07-21T00:00:00Z' }));
  expect('ev04-abandonment', process.execPath, [sourceChecker, 'bootstrap', '--review-dir', newDir, '--abandoned-review-dir', oldDir, '--abandonment-record', recordPath], abandoned, 0);
  expect('ev04-abandoned-block', process.execPath, [sourceChecker, 'bootstrap', '--review-dir', oldDir], abandoned, 1, 'abandoned_review_unit');
}

function toolingFixturePaths(fx) {
  const parent = dirname(fx.reviewDir);
  return {
    parent,
    revoked: join(fx.reviewDir, 'revoked.json'),
    forced: join(parent, '.review-revocations'),
    abandonment: join(parent, '.review-abandonments'),
    manifest: fx.toolingPath,
  };
}

function approvalRecord(fx, supersededBy = 'successor') {
  return {
    review_unit_id: fx.tooling.review_unit_id,
    superseded_by: supersededBy,
    approved_by: 'fixture-user',
    approved_at: '2026-07-21T00:00:00Z',
    reason: 'fixture recovery',
  };
}

function abandonmentRecord(oldDir, newDir, kind, reviewUnitId = undefined) {
  return {
    format_version: 1,
    kind,
    canonical_review_dir: oldDir,
    old_basename: oldDir.split('/').at(-1),
    new_basename: newDir.split('/').at(-1),
    superseded_by: newDir.split('/').at(-1),
    reason: 'fixture recovery',
    approved_by: 'fixture-user',
    approved_at: '2026-07-21T00:00:00Z',
    ...(reviewUnitId ? { review_unit_id: reviewUnitId, forced_revoke_diagnostic: 'marker_write_failed' } : {}),
  };
}

function detailedToolingFixtures() {
  const distribution = initRepo('ev04-isolated-distribution');
  const distributionRoot = join(distribution.root, 'distribution');
  const distributionDirection = join(distributionRoot, 'direction/references');
  const distributionCross = join(distributionRoot, 'cross-review/references');
  mkdirSync(distributionDirection, { recursive: true }); mkdirSync(distributionCross, { recursive: true });
  copyFileSync(sourceChecker, join(distributionDirection, 'check-evidence-package.mjs'));
  copyFileSync(join(repoRoot, 'src/plugin/skills/direction/references/evidence-package-schema.json'), join(distributionDirection, 'evidence-package-schema.json'));
  copyFileSync(join(repoRoot, 'src/plugin/skills/direction/references/review-ledger-schema.json'), join(distributionDirection, 'review-ledger-schema.json'));
  copyFileSync(join(repoRoot, 'src/plugin/skills/cross-review/references/review-diff-fingerprint.mjs'), join(distributionCross, 'review-diff-fingerprint.mjs'));
  const isolatedReview = join(distribution.root, '.work/isolated-unit');
  expect('ev04-isolated-distribution-bootstrap', process.execPath, [join(distributionDirection, 'check-evidence-package.mjs'), 'bootstrap', '--review-dir', isolatedReview], distribution.root, 0);
  const isolatedTooling = JSON.parse(readFileSync(join(isolatedReview, 'evidence/tooling/tooling-manifest.json')));
  assertion('ev04-fixed-minimal-header', isolatedTooling.format_version === 2 && /^[0-9a-f-]{36}$/i.test(isolatedTooling.review_unit_id));
  assertion('ev04-realpath-fixed-fingerprint', isolatedTooling.files.fingerprint.path === join(isolatedReview, 'evidence/tooling/review-diff-fingerprint.mjs'));
  rmSync(distributionRoot, { recursive: true });
  expect('ev04-isolated-fixed-tooling-survives-source-removal', process.execPath, [isolatedTooling.files.checker.path, 'direction', '--review-dir', isolatedReview, '--direction', distribution.directionPath], distribution.root, 1, 'review_dir_direction_mismatch');
  assertion('ev04-normal-bootstrap-separate-from-recovery', !existsSync(join(dirname(distribution.reviewDir), '.review-revocations')) && !existsSync(join(dirname(distribution.reviewDir), '.review-abandonments')) && !existsSync(join(distribution.reviewDir, 'revoked.json')));

  for (const mode of ['missing', 'tampered']) {
    const fx = initRepo(`ev04-fallback-${mode}`); const paths = toolingFixturePaths(fx);
    if (mode === 'missing') rmSync(fx.fixed);
    else writeFileSync(fx.fixed, 'this is not valid JavaScript\n');
    expect(`ev04-fallback-${mode}`, process.execPath, [sourceChecker, 'revoke', '--review-dir', fx.reviewDir, '--superseded-by', 'successor'], fx.root, 0, null, ['source-fallback']);
    const marker = JSON.parse(readFileSync(paths.revoked));
    assertion(`ev04-fallback-${mode}-marker`, marker.created_by === 'source-fallback');
    assertion(`ev04-fallback-${mode}-deviation-both-dirs`, existsSync(join(fx.reviewDir, 'evidence/revoke-fallback.json')) && existsSync(join(paths.parent, 'successor/evidence/revoke-fallback.json')));
  }

  const unwritable = initRepo('ev04-old-dir-unwritable'); const unwritablePaths = toolingFixturePaths(unwritable);
  chmodSync(unwritable.reviewDir, 0o555);
  try {
    expect('ev04-old-dir-unwritable-revoke', process.execPath, [sourceChecker, 'revoke', '--review-dir', unwritable.reviewDir, '--superseded-by', 'forced-next'], unwritable.root, 1, 'unexpected_error');
  } finally { chmodSync(unwritable.reviewDir, 0o755); }
  const unwritableApproval = join(unwritable.root, 'forced-approval.json'); writeFileSync(unwritableApproval, JSON.stringify(approvalRecord(unwritable, 'forced-next')));
  expect('ev04-old-dir-unwritable-forced-revoke', process.execPath, [sourceChecker, 'forced-revoke', '--review-dir', unwritable.reviewDir, '--review-unit-id', unwritable.tooling.review_unit_id, '--superseded-by', 'forced-next', '--approval-record', unwritableApproval], unwritable.root, 0);
  assertion('ev04-parent-fixed-registry', existsSync(join(unwritablePaths.forced, `${unwritable.tooling.review_unit_id}.json`)));

  for (const [name, ids, diagnostic] of [
    ['zero', [], 'revoke_review_unit_unknown'],
    ['one', ['11111111-1111-4111-8111-111111111111'], null],
    ['multiple', ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'], 'revoke_review_unit_ambiguous'],
  ]) {
    const fx = initRepo(`ev04-id-scan-${name}`); rmSync(join(fx.reviewDir, 'evidence'), { recursive: true, force: true }); mkdirSync(join(fx.reviewDir, 'evidence'), { recursive: true });
    if (ids.length) writeFileSync(join(fx.reviewDir, 'evidence/bootstrap-reference.json'), JSON.stringify(ids.map((review_unit_id) => ({ review_unit_id }))));
    expect(`ev04-id-scan-${name}`, process.execPath, [sourceChecker, 'revoke', '--review-dir', fx.reviewDir, '--superseded-by', 'next'], fx.root, diagnostic ? 1 : 0, diagnostic);
    if (name === 'one') assertion('ev04-id-scan-one-marker-id', JSON.parse(readFileSync(join(fx.reviewDir, 'revoked.json'))).review_unit_id === ids[0]);
  }

  const orderRevoked = initRepo('ev04-order-revoked'); const orderRevokedPaths = toolingFixturePaths(orderRevoked);
  expect('ev04-order-create-revoked', process.execPath, [orderRevoked.fixed, 'revoke', '--review-dir', orderRevoked.reviewDir, '--superseded-by', 'next'], orderRevoked.root, 0);
  mkdirSync(orderRevokedPaths.forced, { recursive: true }); writeFileSync(join(orderRevokedPaths.forced, `${orderRevoked.tooling.review_unit_id}.json`), '{}');
  mkdirSync(orderRevokedPaths.abandonment, { recursive: true }); writeFileSync(join(orderRevokedPaths.abandonment, `${createHash('sha256').update(orderRevoked.reviewDir).digest('hex')}.json`), '{}');
  expect('ev04-three-state-order-revoked-first', process.execPath, [sourceChecker, 'bootstrap', '--review-dir', orderRevoked.reviewDir], orderRevoked.root, 1, 'revoked_review_unit');

  const orderForced = initRepo('ev04-order-forced'); const orderForcedPaths = toolingFixturePaths(orderForced);
  const orderApproval = join(orderForced.root, 'approval.json'); writeFileSync(orderApproval, JSON.stringify(approvalRecord(orderForced, 'next')));
  expect('ev04-order-create-forced', process.execPath, [sourceChecker, 'forced-revoke', '--review-dir', orderForced.reviewDir, '--review-unit-id', orderForced.tooling.review_unit_id, '--superseded-by', 'next', '--approval-record', orderApproval], orderForced.root, 0);
  mkdirSync(orderForcedPaths.abandonment, { recursive: true }); writeFileSync(join(orderForcedPaths.abandonment, `${createHash('sha256').update(orderForced.reviewDir).digest('hex')}.json`), '{}');
  expect('ev04-three-state-order-forced-second', process.execPath, [sourceChecker, 'bootstrap', '--review-dir', orderForced.reviewDir], orderForced.root, 1, 'forced_revoke');

  for (const [kind, setup, diagnostic] of [
    ['revoked', (fx, paths) => writeFileSync(paths.revoked, '{}'), 'revoked_marker_invalid'],
    ['forced', (fx, paths) => { mkdirSync(paths.forced, { recursive: true }); writeFileSync(join(paths.forced, `${fx.tooling.review_unit_id}.json`), '{}'); }, 'forced_revoke_invalid'],
    ['abandonment', (fx, paths) => { mkdirSync(paths.abandonment, { recursive: true }); writeFileSync(join(paths.abandonment, `${createHash('sha256').update(fx.reviewDir).digest('hex')}.json`), '{}'); }, 'abandonment_marker_invalid'],
  ]) {
    const fx = initRepo(`ev04-corrupt-${kind}`); setup(fx, toolingFixturePaths(fx));
    expect(`ev04-corrupt-${kind}`, process.execPath, [sourceChecker, 'bootstrap', '--review-dir', fx.reviewDir], fx.root, 1, diagnostic);
  }

  const revokedMismatch = initRepo('ev04-revoked-id-mismatch');
  writeFileSync(join(revokedMismatch.reviewDir, 'revoked.json'), JSON.stringify({ format_version: 1, review_unit_id: '11111111-1111-4111-8111-111111111111', superseded_by: 'next', created_by: 'source-fallback' }));
  expect('ev04-revoked-id-mismatch', process.execPath, [sourceChecker, 'bootstrap', '--review-dir', revokedMismatch.reviewDir], revokedMismatch.root, 1, 'revoked_review_unit_mismatch');
  const forcedMismatch = initRepo('ev04-forced-id-mismatch'); const forcedMismatchPaths = toolingFixturePaths(forcedMismatch);
  mkdirSync(forcedMismatchPaths.forced, { recursive: true });
  writeFileSync(join(forcedMismatchPaths.forced, `${forcedMismatch.tooling.review_unit_id}.json`), JSON.stringify({ format_version: 1, kind: 'forced_revoke', created_by: 'forced-revoke-cli', review_unit_id: '11111111-1111-4111-8111-111111111111', canonical_review_dir: forcedMismatch.reviewDir, superseded_by: 'next', reason: 'fixture', approved_by: 'fixture', approved_at: '2026-07-21T00:00:00Z' }));
  expect('ev04-forced-id-mismatch', process.execPath, [sourceChecker, 'bootstrap', '--review-dir', forcedMismatch.reviewDir], forcedMismatch.root, 1, 'forced_revoke_review_unit_mismatch');

  for (const kind of ['revoked', 'forced', 'abandonment']) {
    const fx = initRepo(`ev04-unreadable-header-${kind}`); const paths = toolingFixturePaths(fx);
    if (kind === 'revoked') writeFileSync(paths.revoked, JSON.stringify({ format_version: 1, review_unit_id: fx.tooling.review_unit_id, superseded_by: 'next', created_by: 'source-fallback' }));
    if (kind === 'forced') {
      const approval = join(fx.root, 'approval.json'); writeFileSync(approval, JSON.stringify(approvalRecord(fx, 'next')));
      expect('ev04-unreadable-header-forced-create', process.execPath, [sourceChecker, 'forced-revoke', '--review-dir', fx.reviewDir, '--review-unit-id', fx.tooling.review_unit_id, '--superseded-by', 'next', '--approval-record', approval], fx.root, 0);
    }
    if (kind === 'abandonment') {
      const successor = join(paths.parent, `${fx.reviewDir.split('/').at(-1)}-next`); const record = join(fx.root, 'abandonment.json');
      writeFileSync(record, JSON.stringify(abandonmentRecord(fx.reviewDir, successor, 'unidentified')));
      expect('ev04-unreadable-header-abandonment-create', process.execPath, [sourceChecker, 'bootstrap', '--review-dir', successor, '--abandoned-review-dir', fx.reviewDir, '--abandonment-record', record], fx.root, 0);
    }
    writeFileSync(paths.manifest, '{');
    expect(`ev04-unreadable-header-${kind}`, process.execPath, [sourceChecker, 'bootstrap', '--review-dir', fx.reviewDir], fx.root, 1, kind === 'revoked' ? 'revoked_review_unit' : kind === 'forced' ? 'forced_revoke' : 'abandoned_review_unit');
  }

  for (const kind of ['unidentified', 'forced_revoke_unwritable']) {
    const fx = initRepo(`ev04-abandonment-${kind}`); const paths = toolingFixturePaths(fx); const successor = join(paths.parent, `${fx.reviewDir.split('/').at(-1)}-next`); const recordPath = join(fx.root, `${kind}.json`);
    const record = abandonmentRecord(fx.reviewDir, successor, kind, kind === 'forced_revoke_unwritable' ? fx.tooling.review_unit_id : undefined);
    writeFileSync(recordPath, JSON.stringify(record));
    expect(`ev04-abandonment-${kind}`, process.execPath, [sourceChecker, 'bootstrap', '--review-dir', successor, '--abandoned-review-dir', fx.reviewDir, '--abandonment-record', recordPath], fx.root, 0);
    expect(`ev04-abandonment-${kind}-retry`, process.execPath, [sourceChecker, 'bootstrap', '--review-dir', successor, '--abandoned-review-dir', fx.reviewDir, '--abandonment-record', recordPath], fx.root, 0);
    const markerPath = join(paths.abandonment, `${createHash('sha256').update(fx.reviewDir).digest('hex')}.json`);
    assertion(`ev04-abandonment-${kind}-path-key`, existsSync(markerPath));
    expect(`ev04-abandonment-${kind}-old-blocked`, process.execPath, [sourceChecker, 'bootstrap', '--review-dir', fx.reviewDir], fx.root, 1, 'abandoned_review_unit');
  }

  const approvalRequired = initRepo('ev04-approval-required-fields');
  for (const field of ['review_unit_id', 'superseded_by', 'approved_by', 'approved_at', 'reason']) {
    const value = approvalRecord(approvalRequired, 'next'); delete value[field]; const path = join(approvalRequired.root, `missing-${field}.json`); writeFileSync(path, JSON.stringify(value));
    expect(`ev04-approval-missing-${field}`, process.execPath, [sourceChecker, 'forced-revoke', '--review-dir', approvalRequired.reviewDir, '--review-unit-id', approvalRequired.tooling.review_unit_id, '--superseded-by', 'next', '--approval-record', path], approvalRequired.root, 1, 'forced_revoke_approval_invalid');
  }
  for (const field of ['format_version', 'kind', 'canonical_review_dir', 'old_basename', 'new_basename', 'superseded_by', 'reason', 'approved_by', 'approved_at']) {
    const fx = initRepo(`ev04-abandonment-missing-${field}`); const successor = join(dirname(fx.reviewDir), `${fx.reviewDir.split('/').at(-1)}-next`); const value = abandonmentRecord(fx.reviewDir, successor, 'unidentified'); delete value[field]; const record = join(fx.root, `missing-${field}.json`); writeFileSync(record, JSON.stringify(value));
    expect(`ev04-abandonment-missing-${field}`, process.execPath, [sourceChecker, 'bootstrap', '--review-dir', successor, '--abandoned-review-dir', fx.reviewDir, '--abandonment-record', record], fx.root, 1, 'abandonment_record_invalid');
  }

  const forcedWrite = initRepo('ev04-forced-marker-write-failure'); const forcedWritePaths = toolingFixturePaths(forcedWrite); writeFileSync(forcedWritePaths.forced, 'not-a-directory');
  const forcedWriteApproval = join(forcedWrite.root, 'approval.json'); writeFileSync(forcedWriteApproval, JSON.stringify(approvalRecord(forcedWrite, 'next')));
  expect('ev04-forced-marker-write-failure', process.execPath, [sourceChecker, 'forced-revoke', '--review-dir', forcedWrite.reviewDir, '--review-unit-id', forcedWrite.tooling.review_unit_id, '--superseded-by', 'next', '--approval-record', forcedWriteApproval], forcedWrite.root, 1, 'unexpected_error');
  const abandonmentWrite = initRepo('ev04-abandonment-marker-write-failure'); const abandonmentWritePaths = toolingFixturePaths(abandonmentWrite); writeFileSync(abandonmentWritePaths.abandonment, 'not-a-directory');
  const abandonmentSuccessor = join(abandonmentWritePaths.parent, 'abandonment-marker-write-failure-next'); const abandonmentWriteRecord = join(abandonmentWrite.root, 'record.json'); writeFileSync(abandonmentWriteRecord, JSON.stringify(abandonmentRecord(abandonmentWrite.reviewDir, abandonmentSuccessor, 'unidentified')));
  expect('ev04-abandonment-marker-write-failure', process.execPath, [sourceChecker, 'bootstrap', '--review-dir', abandonmentSuccessor, '--abandoned-review-dir', abandonmentWrite.reviewDir, '--abandonment-record', abandonmentWriteRecord], abandonmentWrite.root, 1, 'unexpected_error');

  const manualForced = initRepo('ev04-manual-forced-marker'); const manualPaths = toolingFixturePaths(manualForced); mkdirSync(manualPaths.forced, { recursive: true });
  writeFileSync(join(manualPaths.forced, `${manualForced.tooling.review_unit_id}.json`), JSON.stringify({ format_version: 1, kind: 'forced_revoke', review_unit_id: manualForced.tooling.review_unit_id, canonical_review_dir: manualForced.reviewDir, superseded_by: 'next', reason: 'manual', approved_by: 'fixture', approved_at: '2026-07-21T00:00:00Z' }));
  expect('ev04-manual-forced-marker-rejected', process.execPath, [sourceChecker, 'bootstrap', '--review-dir', manualForced.reviewDir], manualForced.root, 1, 'forced_revoke_invalid');

  const registryFingerprint = initRepo('ev04-registry-fingerprint', directionText(['target.txt'])); writeFileSync(join(registryFingerprint.root, 'target.txt'), 'after\n');
  const registryManifest = join(registryFingerprint.reviewDir, 'evidence/manifests/EC-FX-01.json');
  expect('ev04-registry-fingerprint-before', process.execPath, [registryFingerprint.fixed, 'prepare', '--review-dir', registryFingerprint.reviewDir, '--direction', registryFingerprint.directionPath, '--contract', 'EC-FX-01', '--manifest', registryManifest], registryFingerprint.root, 0);
  const fingerprintBefore = JSON.parse(readFileSync(registryManifest)).contracts[0].repository_state.diff_fingerprint; const registryPaths = toolingFixturePaths(registryFingerprint);
  mkdirSync(registryPaths.forced, { recursive: true }); mkdirSync(registryPaths.abandonment, { recursive: true }); writeFileSync(join(registryPaths.forced, 'ignored'), 'x'); writeFileSync(join(registryPaths.abandonment, 'ignored'), 'x');
  expect('ev04-registry-fingerprint-after', process.execPath, [registryFingerprint.fixed, 'prepare', '--review-dir', registryFingerprint.reviewDir, '--direction', registryFingerprint.directionPath, '--contract', 'EC-FX-01', '--manifest', registryManifest], registryFingerprint.root, 0);
  assertion('ev04-fixed-registry-only-excluded', JSON.parse(readFileSync(registryManifest)).contracts[0].repository_state.diff_fingerprint === fingerprintBefore);

  const revokedModes = initRepo('ev04-revoked-all-modes'); const revokedManifest = join(revokedModes.reviewDir, 'evidence/manifests/EC-FX-01.json');
  expect('ev04-revoked-all-create', process.execPath, [revokedModes.fixed, 'revoke', '--review-dir', revokedModes.reviewDir, '--superseded-by', 'next'], revokedModes.root, 0);
  const commands = [
    ['bootstrap', [sourceChecker, 'bootstrap', '--review-dir', revokedModes.reviewDir]],
    ['direction', [revokedModes.fixed, 'direction', '--review-dir', revokedModes.reviewDir, '--direction', revokedModes.directionPath]],
    ['prepare', [revokedModes.fixed, 'prepare', '--review-dir', revokedModes.reviewDir, '--direction', revokedModes.directionPath, '--contract', 'EC-FX-01', '--manifest', revokedManifest]],
    ['record', [revokedModes.fixed, 'record', '--review-dir', revokedModes.reviewDir, '--contract', 'EC-FX-01', '--manifest', revokedManifest, '--', process.execPath, 'missing.mjs']],
    ['verify', [revokedModes.fixed, 'verify', '--review-dir', revokedModes.reviewDir, '--direction', revokedModes.directionPath, '--manifest', revokedManifest]],
    ['review-ledger', [revokedModes.fixed, 'review-ledger', '--review-dir', revokedModes.reviewDir, '--direction', revokedModes.directionPath, '--phase', 'plan', '--round', '1', '--events', join(revokedModes.reviewDir, 'events.jsonl'), '--execution-point', 'results-received']],
  ];
  for (const [mode, command] of commands) expect(`ev04-revoked-block-${mode}`, process.execPath, command, revokedModes.root, 1, 'revoked_review_unit');
}

function rawFingerprint(fx) {
  writeFileSync(join(fx.root, '.git/info/exclude'), `/.work/${fx.reviewDir.split('/').at(-1)}/\n`);
  const result = run(process.execPath, [fx.tooling.files.fingerprint.path, fx.root], fx.root);
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function waitUsageFixtures() {
  // 2026-07 の実セッション分布から時刻間隔・arguments形状だけを匿名化したfixture。
  // 合成した呼び出し数以外は個人識別子を含まない。mailbox通知理由とtimeout以外の引数は未代表。
  const fixtureDir = join(workRoot, 'evidence/wait-fixtures'); mkdirSync(fixtureDir, { recursive: true });
  const writeSession = (name, timeouts) => {
    const path = join(fixtureDir, `${name}.jsonl`);
    const rows = timeouts.map((timeout, index) => ({
      timestamp: new Date(Date.UTC(2026, 6, 1, 0, 0, index * 73)).toISOString(), type: 'response_item',
      payload: { type: 'function_call', name: 'wait_agent', ...(timeout === null ? {} : { arguments: JSON.stringify({ timeout_ms: timeout }) }) },
    }));
    writeFileSync(path, `${rows.map(JSON.stringify).join('\n')}\n`); return path;
  };
  const short = run(process.execPath, [waitUsage, writeSession('short-timeout', Array(10).fill(20000))], repoRoot);
  assertion('wb01-short-timeout-confirmed-warning', short.status === 0 && short.stdout.includes('確定警告') && short.stdout.includes('短timeout反復・確定警告'));
  const max = run(process.execPath, [waitUsage, writeSession('max-timeout-early-return', Array(10).fill(3600000))], repoRoot);
  assertion('wb01-max-timeout-early-return-no-warning', max.status === 0 && max.stdout.includes('確定警告') && !max.stdout.includes('短timeout反復・確定警告'));
  const mixed = run(process.execPath, [waitUsage, writeSession('mixed-timeouts', [...Array(10).fill(3600000), ...Array(10).fill(20000)])], repoRoot);
  assertion('wb01-mixed-counts-short-only', mixed.status === 0 && mixed.stdout.includes('短timeout 10回') && mixed.stdout.includes('短timeout反復・確定警告'));
  const legacy = run(process.execPath, [waitUsage, writeSession('arguments-missing', Array(10).fill(null))], repoRoot);
  assertion('wb01-arguments-missing-reference-warning', legacy.status === 0 && legacy.stdout.includes('旧ログ・参考警告') && !legacy.stdout.includes('短timeout反復・確定警告'));
  const mixedMissing = run(process.execPath, [waitUsage, writeSession('short-and-arguments-missing', [...Array(9).fill(20000), null])], repoRoot);
  assertion('wb01-short-and-missing-reference-warning', mixedMissing.status === 0 && mixedMissing.stdout.includes('旧ログ・参考警告') && !mixedMissing.stdout.includes('短timeout反復・確定警告'));
}

function ledgerMaterial(fx, phase, options = {}) {
  const material = join(fx.reviewDir, 'evidence/ledger'); mkdirSync(material, { recursive: true });
  const eventsPath = join(material, 'events.jsonl');
  const reviewers = phase === 'code' ? ['pre', 'cross'] : ['plan'];
  for (const reviewer of reviewers) {
    const prompt = join(material, `${reviewer}-prompt.md`); const resultPath = join(material, `${reviewer}-result.json`);
    writeFileSync(prompt, `prompt ${reviewer}`);
    expect(`ledger-${basename(fx.root)}-${reviewer}-prompt`, process.execPath,
      [fx.fixed, 'ledger-prompt', '--review-dir', fx.reviewDir, '--direction', fx.directionPath, '--phase', phase,
        '--events', eventsPath, '--reviewer', reviewer, '--round', '1', '--session-id', `${reviewer}-session`, '--prompt', prompt], fx.root, 0);
    if (!(options.missingResult && reviewer === 'cross')) {
      const findings = options.findings && reviewer === reviewers[0];
      const nits = options.nits && reviewer === reviewers[0];
      const actionable = findings || (phase === 'plan' && nits);
      writeFileSync(resultPath, `${JSON.stringify({ verdict: actionable ? 'needs-attention' : 'approve', must_fix: findings ? ['fix'] : [], should_fix: [], nit: nits ? ['nit'] : [], readonly_violations: [] })}\n`);
      expect(`ledger-${basename(fx.root)}-${reviewer}-result`, process.execPath,
        [fx.fixed, 'ledger-result', '--review-dir', fx.reviewDir, '--direction', fx.directionPath, '--phase', phase,
          '--events', eventsPath, '--reviewer', reviewer, '--round', '1', '--session-id', `${reviewer}-session`, '--result', resultPath], fx.root, 0);
    }
  }
  if (options.oldUnit || options.badFingerprint || options.missingReadonly || options.missingVerdict || options.invalidVerdict || options.contentMismatch) {
    const events = readFileSync(eventsPath, 'utf8').trim().split('\n').map(JSON.parse);
    for (const event of events) {
      if (options.oldUnit) event.review_unit_id = '00000000-0000-4000-8000-000000000000';
      if (options.badFingerprint && event.reviewer === 'cross') event.diff_fingerprint = '1'.repeat(64);
      if (event.event !== 'review_result' || event.reviewer !== reviewers[0]) continue;
      const body = JSON.parse(readFileSync(event.result_path, 'utf8'));
      if (options.missingReadonly) { delete body.readonly_violations; delete event.readonly_violations; }
      if (options.missingVerdict) { delete body.verdict; delete event.verdict; }
      if (options.invalidVerdict) { body.verdict = 'maybe'; event.verdict = 'maybe'; }
      if (options.contentMismatch) { body.verdict = 'needs-attention'; body.must_fix = ['body-only finding']; }
      writeFileSync(event.result_path, `${JSON.stringify(body)}\n`);
      event.result_hash = sha(event.result_path);
    }
    writeFileSync(eventsPath, `${events.map(JSON.stringify).join('\n')}\n`);
  }
  return eventsPath;
}

function ledgerCase(name, phase, options, expectedExit, diagnostic) {
  const fx = initRepo(name);
  const events = ledgerMaterial(fx, phase, options);
  if (options.staleDiff) writeFileSync(join(fx.root, 'target.txt'), 'changed after approval\n');
  expect(name, process.execPath, [fx.fixed, 'review-ledger', '--phase', phase, '--round', '1', '--review-dir', fx.reviewDir, '--direction', fx.directionPath, '--events', events, '--execution-point', 'results-received'], fx.root, expectedExit, diagnostic);
  if (expectedExit === 0) {
    const finalPoint = phase === 'plan' ? 'before-agreement' : 'before-completion';
    expect(`${name}-final`, process.execPath, [fx.fixed, 'review-ledger', '--phase', phase, '--round', '1', '--review-dir', fx.reviewDir, '--direction', fx.directionPath, '--events', events, '--execution-point', finalPoint], fx.root, 0, null, ['"eligibility_token"']);
  }
}

function appendLedgerRound(fx, eventsPath, phase, round, options = {}) {
  const reviewers = phase === 'code' ? ['pre', 'cross'] : ['plan'];
  for (const reviewer of reviewers) {
    const prompt = join(fx.reviewDir, `evidence/ledger/${reviewer}-prompt-${round}.md`); const resultPath = join(fx.reviewDir, `evidence/ledger/${reviewer}-result-${round}.json`);
    writeFileSync(prompt, `prompt ${reviewer} ${round}`);
    expect(`ledger-${basename(fx.root)}-${reviewer}-r${round}-prompt`, process.execPath,
      [fx.fixed, 'ledger-prompt', '--review-dir', fx.reviewDir, '--direction', fx.directionPath, '--phase', phase,
        '--events', eventsPath, '--reviewer', reviewer, '--round', String(round), '--session-id', `${reviewer}-session`, '--prompt', prompt], fx.root, 0);
    const findings = options.findings && reviewer === reviewers[0];
    const nits = options.nits && reviewer === reviewers[0];
    const actionable = findings || (phase === 'plan' && nits);
    writeFileSync(resultPath, `${JSON.stringify({ verdict: actionable ? 'needs-attention' : 'approve', must_fix: findings ? ['fix'] : [], should_fix: [], nit: nits ? ['nit'] : [], readonly_violations: [] })}\n`);
    expect(`ledger-${basename(fx.root)}-${reviewer}-r${round}-result`, process.execPath,
      [fx.fixed, 'ledger-result', '--review-dir', fx.reviewDir, '--direction', fx.directionPath, '--phase', phase,
        '--events', eventsPath, '--reviewer', reviewer, '--round', String(round), '--session-id', `${reviewer}-session`, '--result', resultPath], fx.root, 0);
  }
}

function ledgerFixtures() {
  ledgerCase('pl01-normal', 'plan', {}, 0);
  ledgerCase('pl01-findings', 'plan', { findings: true }, 2, 'review_attention_required');
  ledgerCase('pl01-old-unit', 'plan', { oldUnit: true }, 1, 'ledger_review_unit_mismatch');
  const stale = initRepo('pl01-stale'); const events = ledgerMaterial(stale, 'plan');
  expect('pl01-stale-first', process.execPath, [stale.fixed, 'review-ledger', '--phase', 'plan', '--round', '1', '--review-dir', stale.reviewDir, '--direction', stale.directionPath, '--events', events, '--execution-point', 'results-received'], stale.root, 0);
  writeFileSync(stale.directionPath, `${readFileSync(stale.directionPath, 'utf8')}\nchanged\n`);
  expect('pl01-stale', process.execPath, [stale.fixed, 'review-ledger', '--phase', 'plan', '--round', '1', '--review-dir', stale.reviewDir, '--direction', stale.directionPath, '--events', events, '--execution-point', 'before-agreement'], stale.root, 2, 'stale_approved_plan');
  appendLedgerRound(stale, events, 'plan', 2);
  expect('pl01-r2-updated-direction-same-session', process.execPath, [stale.fixed, 'review-ledger', '--phase', 'plan', '--round', '2', '--review-dir', stale.reviewDir, '--direction', stale.directionPath, '--events', events, '--execution-point', 'results-received'], stale.root, 0);
  expect('pl01-r2-final-token', process.execPath, [stale.fixed, 'review-ledger', '--phase', 'plan', '--round', '2', '--review-dir', stale.reviewDir, '--direction', stale.directionPath, '--events', events, '--execution-point', 'before-agreement'], stale.root, 0, null, ['ledger plan 結果受領2/2・合意直前2/2・stale1・eligible=true']);
  ledgerCase('pl01-readonly-audit-missing', 'plan', { missingReadonly: true }, 1, 'ledger_result_invalid');
  ledgerCase('rv02-normal', 'code', {}, 0);
  ledgerCase('rv02-findings', 'code', { findings: true }, 2, 'review_attention_required');
  ledgerCase('rv02-verdict-missing', 'code', { missingVerdict: true }, 1, 'ledger_result_invalid');
  ledgerCase('rv02-verdict-missing-findings', 'code', { missingVerdict: true, findings: true }, 1, 'ledger_result_invalid');
  ledgerCase('rv02-stale-diff', 'code', { staleDiff: true }, 2, 'stale_approved_diff');
  ledgerCase('rv02-round-fingerprint', 'code', { badFingerprint: true }, 1, 'ledger_round_mismatch');
  ledgerCase('rv02-invalid-verdict', 'code', { invalidVerdict: true }, 1, 'ledger_result_invalid');
  ledgerCase('rv02-result-content-mismatch', 'code', { contentMismatch: true }, 1, 'ledger_result_content_mismatch');
  ledgerCase('rv02-result-missing', 'code', { missingResult: true }, 1, 'ledger_reviewer_missing');
  const recovery = initRepo('rv02-result-missing-recovery'); const recoveryEvents = ledgerMaterial(recovery, 'code', { missingResult: true });
  expect('rv02-result-missing-recovery-first', process.execPath, [recovery.fixed, 'review-ledger', '--phase', 'code', '--round', '1', '--review-dir', recovery.reviewDir, '--direction', recovery.directionPath, '--events', recoveryEvents, '--execution-point', 'results-received'], recovery.root, 1, 'ledger_reviewer_missing');
  const recoveredResult = join(recovery.reviewDir, 'evidence/ledger/cross-result-recovered.json');
  writeFileSync(recoveredResult, `${JSON.stringify({ verdict: 'approve', must_fix: [], should_fix: [], nit: [], readonly_violations: [] })}\n`);
  expect('rv02-result-missing-recovery-generate', process.execPath, [recovery.fixed, 'ledger-result', '--review-dir', recovery.reviewDir, '--direction', recovery.directionPath, '--phase', 'code', '--events', recoveryEvents, '--reviewer', 'cross', '--round', '1', '--session-id', 'cross-session', '--result', recoveredResult], recovery.root, 0);
  expect('rv02-result-missing-recovery-retry', process.execPath, [recovery.fixed, 'review-ledger', '--phase', 'code', '--round', '1', '--review-dir', recovery.reviewDir, '--direction', recovery.directionPath, '--events', recoveryEvents, '--execution-point', 'results-received'], recovery.root, 0);
  expect('rv02-result-missing-recovery-final', process.execPath, [recovery.fixed, 'review-ledger', '--phase', 'code', '--round', '1', '--review-dir', recovery.reviewDir, '--direction', recovery.directionPath, '--events', recoveryEvents, '--execution-point', 'before-completion'], recovery.root, 0);
  ledgerCase('rv02-old-unit', 'code', { oldUnit: true }, 1, 'ledger_review_unit_mismatch');
  const lifecycle = initRepo('pl01-lifecycle-metadata'); const lifecycleEvents = ledgerMaterial(lifecycle, 'plan');
  writeFileSync(lifecycle.directionPath, `${readFileSync(lifecycle.directionPath, 'utf8')}状態: 完了\n実測: smoke 対象外\n`);
  expect('pl01-lifecycle-metadata-hash-stable', process.execPath, [lifecycle.fixed, 'review-ledger', '--phase', 'plan', '--round', '1', '--review-dir', lifecycle.reviewDir, '--direction', lifecycle.directionPath, '--events', lifecycleEvents, '--execution-point', 'results-received'], lifecycle.root, 0);
  const normative = initRepo('pl01-normative-change'); const normativeEvents = ledgerMaterial(normative, 'plan');
  writeFileSync(normative.directionPath, `${readFileSync(normative.directionPath, 'utf8')}\n規範変更\n`);
  expect('pl01-normative-change-stale', process.execPath, [normative.fixed, 'review-ledger', '--phase', 'plan', '--round', '1', '--review-dir', normative.reviewDir, '--direction', normative.directionPath, '--events', normativeEvents, '--execution-point', 'results-received'], normative.root, 2, 'stale_approved_plan');
  const wrongCheckpoint = initRepo('rv02-checkpoint-round'); const wrongCheckpointEvents = ledgerMaterial(wrongCheckpoint, 'code');
  appendLedgerRound(wrongCheckpoint, wrongCheckpointEvents, 'code', 2);
  expect('rv02-checkpoint-round-mismatch', process.execPath, [wrongCheckpoint.fixed, 'review-ledger', '--phase', 'code', '--round', '1', '--review-dir', wrongCheckpoint.reviewDir, '--direction', wrongCheckpoint.directionPath, '--events', wrongCheckpointEvents, '--execution-point', 'results-received'], wrongCheckpoint.root, 1, 'ledger_checkpoint_round_mismatch');
  const completion = initRepo('rv02-completion-marker'); const completionEvents = ledgerMaterial(completion, 'code');
  expect('rv02-completion-results', process.execPath, [completion.fixed, 'review-ledger', '--phase', 'code', '--round', '1', '--review-dir', completion.reviewDir, '--direction', completion.directionPath, '--events', completionEvents, '--execution-point', 'results-received'], completion.root, 0);
  expect('rv02-completion-final', process.execPath, [completion.fixed, 'review-ledger', '--phase', 'code', '--round', '1', '--review-dir', completion.reviewDir, '--direction', completion.directionPath, '--events', completionEvents, '--execution-point', 'before-completion'], completion.root, 0);
  const completionMarker = JSON.parse(readFileSync(join(completion.reviewDir, 'review-unit-complete.json')));
  assertion('rv02-completion-marker-bound', completionMarker.format_version === 2
    && completionMarker.review_unit_id === completion.tooling.review_unit_id
    && /^[a-f0-9]{64}$/.test(completionMarker.direction_hash)
    && /^[a-f0-9]{64}$/.test(completionMarker.diff_fingerprint));
  const r3 = initRepo('lb02-r3-continues'); const r3Events = ledgerMaterial(r3, 'plan', { findings: true });
  appendLedgerRound(r3, r3Events, 'plan', 2, { findings: true }); appendLedgerRound(r3, r3Events, 'plan', 3, { findings: true });
  expect('lb02-r3-continues', process.execPath, [r3.fixed, 'review-ledger', '--phase', 'plan', '--round', '3', '--review-dir', r3.reviewDir, '--direction', r3.directionPath, '--events', r3Events, '--execution-point', 'results-received'], r3.root, 2, 'review_attention_required', ['"rework_count":3', '"next_rework":4', '"backstop_reached":false']);
  const r4 = initRepo('lb02-r4-backstop'); const r4Events = ledgerMaterial(r4, 'code', { findings: true });
  for (let round = 2; round <= 4; round += 1) appendLedgerRound(r4, r4Events, 'code', round, { findings: true });
  expect('lb02-r4-backstop', process.execPath, [r4.fixed, 'review-ledger', '--phase', 'code', '--round', '4', '--review-dir', r4.reviewDir, '--direction', r4.directionPath, '--events', r4Events, '--execution-point', 'results-received'], r4.root, 3, 'review_backstop_reached', ['"rework_count":4', '"backstop_reached":true', '"backstop_reason":"rework"']);
  const r5 = initRepo('lb02-r5-round-backstop'); const r5Events = ledgerMaterial(r5, 'plan', { findings: true });
  for (let round = 2; round <= 4; round += 1) appendLedgerRound(r5, r5Events, 'plan', round);
  appendLedgerRound(r5, r5Events, 'plan', 5, { findings: true });
  expect('lb02-r5-round-backstop', process.execPath, [r5.fixed, 'review-ledger', '--phase', 'plan', '--round', '5', '--review-dir', r5.reviewDir, '--direction', r5.directionPath, '--events', r5Events, '--execution-point', 'results-received'], r5.root, 3, 'review_backstop_reached', ['"rework_count":2', '"backstop_reason":"round"']);
  const r5Nit = initRepo('lb02-r5-nit-backstop'); const r5NitEvents = ledgerMaterial(r5Nit, 'plan', { nits: true });
  for (let round = 2; round <= 5; round += 1) appendLedgerRound(r5Nit, r5NitEvents, 'plan', round, { nits: true });
  expect('lb02-r5-nit-backstop', process.execPath, [r5Nit.fixed, 'review-ledger', '--phase', 'plan', '--round', '5', '--review-dir', r5Nit.reviewDir, '--direction', r5Nit.directionPath, '--events', r5NitEvents, '--execution-point', 'results-received'], r5Nit.root, 3, 'review_backstop_reached', ['"rework_count":0', '"backstop_reason":"round"']);
  const r5Stale = initRepo('lb02-r5-stale-backstop'); const r5StaleEvents = ledgerMaterial(r5Stale, 'code');
  for (let round = 2; round <= 5; round += 1) appendLedgerRound(r5Stale, r5StaleEvents, 'code', round);
  writeFileSync(join(r5Stale.root, 'stale.txt'), 'changed\n');
  expect('lb02-r5-stale-backstop', process.execPath, [r5Stale.fixed, 'review-ledger', '--phase', 'code', '--round', '5', '--review-dir', r5Stale.reviewDir, '--direction', r5Stale.directionPath, '--events', r5StaleEvents, '--execution-point', 'results-received'], r5Stale.root, 3, 'review_backstop_reached', ['"rework_count":0', '"backstop_reason":"round"']);
  assertion('lb02-r5-stale-event-recorded', readFileSync(r5StaleEvents, 'utf8').includes('"diagnostic":"stale_approved_diff"'));
  const duplicateInvocation = initRepo('rv02-duplicate-invocation'); const duplicateEvents = ledgerMaterial(duplicateInvocation, 'code');
  const duplicateHash = sha(duplicateInvocation.directionPath); const duplicateDiff = rawFingerprint(duplicateInvocation);
  const duplicateCheck = { event: 'review_ledger_check', phase: 'code', execution_point: 'results-received', round: 1, invocation_id: '11111111-1111-4111-8111-111111111111', review_unit_id: duplicateInvocation.tooling.review_unit_id, direction_hash: duplicateHash, diff_fingerprint: duplicateDiff, checked_at: '2026-07-21T00:00:00Z' };
  writeFileSync(duplicateEvents, `${JSON.stringify(duplicateCheck)}\n${JSON.stringify(duplicateCheck)}\n`, { flag: 'a' });
  expect('rv02-duplicate-invocation', process.execPath, [duplicateInvocation.fixed, 'review-ledger', '--phase', 'code', '--round', '1', '--review-dir', duplicateInvocation.reviewDir, '--direction', duplicateInvocation.directionPath, '--events', duplicateEvents, '--execution-point', 'results-received'], duplicateInvocation.root, 1, 'ledger_invocation_invalid');
}

function reviewRuntimeStaticFixtures() {
  const claude = readFileSync(join(repoRoot, 'src/plugin-claude/skills/team-impl/SKILL.md'), 'utf8');
  const codex = readFileSync(join(repoRoot, 'src/plugin-codex/skills/team-impl/SKILL.md'), 'utf8');
  const cross = readFileSync(join(repoRoot, 'src/plugin/skills/cross-review/SKILL.md'), 'utf8');
  const direction = readFileSync(join(repoRoot, 'src/plugin/skills/direction/SKILL.md'), 'utf8');
  const implementerClaude = readFileSync(join(repoRoot, 'src/plugin-claude/agents/implementer.md'), 'utf8');
  const implementerCodex = readFileSync(join(repoRoot, 'src/plugin-codex/skills/team-impl/implementer.toml'), 'utf8');
  const validator = (text) => text.includes('verify --review-dir') && text.includes('reviewer の spawn') && text.includes('source checker') && text.includes('単独起動する cross-review');
  assertion('rv01-claude-gate', validator(claude)); assertion('rv01-codex-gate', validator(codex));
  assertion('rv01-ask-gate-drift', !validator(claude.replace('verify --review-dir', 'verify-disabled')));
  assertion('rv01-standalone-backward-compatible', cross.includes('standalone') && cross.includes('Seal では') && !cross.includes('standalone では tooling manifest'));
  const integratedReview = (text) => text.includes('全境界が揃ったら統合先へ')
    && text.includes('cherry-pick --no-commit') && text.includes('統合先の全diffへ**共同レビュー**を1回起動する');
  assertion('rv01-worktree-integrated-review-claude', integratedReview(claude));
  assertion('rv01-worktree-integrated-review-codex', integratedReview(codex));
  const deferredEvidence = (text) => text.includes('worktree分離時は兄弟checkoutのcanonical review-dirへprepare/recordせず')
    && text.includes('統合先checkoutで全境界manifestのprepare');
  assertion('rv01-worktree-evidence-deferred-claude', deferredEvidence(implementerClaude));
  assertion('rv01-worktree-evidence-deferred-codex', deferredEvidence(implementerCodex));
  assertion('rv01-cleanup-completion-marker-required', cross.includes('review-unit-complete.json')
    && cross.includes('marker欠落・不整合') && cross.includes('自動削除しない'));
  assertion('rv01-ledger-generator-contract', direction.includes('ledger-prompt') && direction.includes('ledger-result')
    && direction.includes('JSONLを手書きしない'));
  assertion('rv01-smoke-reviewed-diff-only', direction.includes('レビュー後に scenario・helper・assertion を編集しない'));
  assertion('pl02-provider-resume-static-contract', direction.includes('claude -p "$(cat <プロンプトファイル>)" --resume <R1 session ID>')
    && direction.includes('codex exec --cd <対象リポジトリ> --sandbox read-only resume <R1 thread ID>')
    && direction.includes('.work/<direction basename>/` の絶対パスそのもの') && direction.includes('read-only監査結果を必須記録'));
}

function reviewParserFixtures() {
  const root = join(runsRoot, 'rv03-parser'); rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true });
  const valid = { diff_fingerprint: 'a'.repeat(64), verdict: 'approve', summary: 'ok', findings: [] };
  const finding = { severity: 'should-fix', title: 'title', body: 'body', file: 'file.js', line_start: 1, line_end: 2, recommendation: 'fix' };
  const validFinding = { ...valid, verdict: 'needs-attention', findings: [finding] };
  const cases = [
    ['exact', JSON.stringify(valid), 0], ['json-fence', `\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``, 0], ['plain-fence', `\`\`\`\n${JSON.stringify(valid)}\n\`\`\``, 0],
    ['nonempty-finding', JSON.stringify(validFinding), 0],
    ['two-objects', `${JSON.stringify(valid)}\n${JSON.stringify(valid)}`, 1], ['prose', `result: ${JSON.stringify(valid)}`, 1], ['broken', '{', 1],
    ['missing', JSON.stringify({ verdict: 'approve', summary: 'x', findings: [] }), 1],
    ['top-additional', JSON.stringify({ ...valid, extra: true }), 1],
    ['verdict', JSON.stringify({ ...valid, verdict: 'needs-attention' }), 1], ['approve-with-finding', JSON.stringify({ ...validFinding, verdict: 'approve' }), 1],
  ];
  let canonical = null;
  for (const [name, body, exit] of cases) {
    const log = join(root, `${name}.jsonl`); const out = join(root, `${name}.json`);
    writeFileSync(log, `${JSON.stringify({ type: 'result', result: body, permission_denials: [] })}\n`);
    expect(`rv03-${name}`, process.execPath, [reviewLogChecker, log, '(^|\\s)(npm test|git commit)(\\s|$)', out], root, exit);
    if (exit === 0) {
      const normalized = readFileSync(out, 'utf8'); canonical ??= normalized;
      if (!name.includes('finding')) assertion(`rv03-${name}-normalized`, normalized === canonical);
    }
  }
  let severityLog;
  for (const [field, invalid] of [
    ['severity', { ...finding, severity: 'critical' }], ['title', { ...finding, title: '' }], ['body', { ...finding, body: '' }],
    ['file', { ...finding, file: '' }], ['line_start', { ...finding, line_start: -1 }], ['line_end', { ...finding, line_end: 1.5 }],
    ['recommendation', { ...finding, recommendation: null }], ['additional', { ...finding, extra: true }],
    ['missing', Object.fromEntries(Object.entries(finding).filter(([key]) => key !== 'body'))],
  ]) {
    const log = join(root, `finding-${field}.jsonl`);
    const result = field === 'severity' ? { ...valid, findings: [invalid] } : { ...validFinding, findings: [invalid] };
    writeFileSync(log, `${JSON.stringify({ type: 'result', result: JSON.stringify(result), permission_denials: [] })}\n`);
    expect(`rv03-finding-${field}`, process.execPath, [reviewLogChecker, log, '(^|\\s)(npm test|git commit)(\\s|$)', join(root, `finding-${field}.json`)], root, 1);
    if (field === 'severity') severityLog = log;
  }
  const specimen = join(workRoot, 'specimens/rv03-severity-guard-removed.mjs');
  const mutationLog = join(workRoot, 'specimens/rv03-severity-guard-removed.log');
  const tempRoot = join(workRoot, 'tmp');
  mkdirSync(tempRoot, { recursive: true }); mkdirSync(dirname(specimen), { recursive: true });
  const tempDir = mkdtempSync(join(tempRoot, 'rv03-severity-'));
  const mutationChecker = join(tempDir, 'check-review-log.mjs');
  const sourceHash = sha(reviewLogChecker);
  try {
    const original = readFileSync(reviewLogChecker, 'utf8');
    const mutated = original.replace('["must-fix", "should-fix", "nit"].includes(value.severity) &&', 'true &&');
    assertion('rv03-severity-guard-mutation-applied', mutated !== original);
    writeFileSync(mutationChecker, mutated); copyFileSync(mutationChecker, specimen);
    const mutation = run(process.execPath, [mutationChecker, severityLog, '(^|\\s)(npm test|git commit)(\\s|$)', join(root, 'finding-severity-mutated.json')], root);
    writeFileSync(mutationLog, [`expected_fixture_exit=1`, `actual_exit=${mutation.status}`, '--- stdout ---', mutation.stdout, '--- stderr ---', mutation.stderr].join('\n'));
    assertion('rv03-severity-mutation-detected', mutation.status === 0, { expected_fixture_exit: 1, actual_exit: mutation.status, log: mutationLog });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
  assertion('rv03-severity-tracked-source-unchanged', sha(reviewLogChecker) === sourceHash, { before: sourceHash, after: sha(reviewLogChecker) });
  expect('rv03-severity-source-still-rejects', process.execPath, [reviewLogChecker, severityLog, '(^|\\s)(npm test|git commit)(\\s|$)', join(root, 'finding-severity-source.json')], root, 1);
  const violationLog = join(root, 'violation.jsonl');
  writeFileSync(violationLog, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id: 'tool-1', input: { command: 'npm test' } }] } })}\n${JSON.stringify({ type: 'result', result: JSON.stringify(valid), permission_denials: [] })}\n`);
  expect('rv03-violation-exit2', process.execPath, [reviewLogChecker, violationLog, '(^|\\s)(npm test|git commit)(\\s|$)', join(root, 'violation.json')], root, 2, null, ['"violationCount": 1']);
  const priorityLog = join(root, 'result-error-priority.jsonl');
  writeFileSync(priorityLog, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id: 'tool-2', input: { command: 'npm test' } }] } })}\n${JSON.stringify({ type: 'result', result: '{', permission_denials: [] })}\n`);
  expect('rv03-result-error-priority-exit1', process.execPath, [reviewLogChecker, priorityLog, '(^|\\s)(npm test|git commit)(\\s|$)', join(root, 'priority.json')], root, 1, null, ['"violationCount": 1']);
  const deniedLog = join(root, 'denied.jsonl');
  writeFileSync(deniedLog, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id: 'tool-3', input: { command: 'npm test' } }] } })}\n${JSON.stringify({ type: 'result', result: JSON.stringify(valid), permission_denials: [{ tool_use_id: 'tool-3' }] })}\n`);
  expect('rv03-denied-readonly-attempt', process.execPath, [reviewLogChecker, deniedLog, '(^|\\s)(npm test|git commit)(\\s|$)', join(root, 'denied.json')], root, 0, null, ['"deniedAttemptCount": 1']);
  const codexLog = join(root, 'codex.jsonl');
  writeFileSync(codexLog, `${JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: "/bin/zsh -lc 'git diff --stat'" } })}\n${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(validFinding) } })}\n`);
  expect('rv03-codex-shape-and-result', process.execPath, [reviewLogChecker, codexLog, '(^|\\s)(npm test|git commit)(\\s|$)', join(root, 'codex.json')], root, 0);
  const codexBad = join(root, 'codex-bad-verdict.jsonl'); writeFileSync(codexBad, `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ ...valid, verdict: 'needs-attention' }) } })}\n`);
  expect('rv03-codex-verdict-findings-inconsistent', process.execPath, [reviewLogChecker, codexBad, '(^|\\s)(npm test|git commit)(\\s|$)', join(root, 'codex-bad.json')], root, 1);
  // 実ログ由来（匿名化・クォート構造を保持）: zsh クォート連結の for/do 閲覧ループと rg|xargs sh -c の
  // read-only ダンプは違反にしない（2026-07-24 の fail-closed 誤検知2件の再現検体）。故意ずれは制御 keyword
  // 前置の denylist（^ アンカー素通りの false green 側も固定）・sh -c 内側の実行系/書込系/混入・未終端
  // クォート・payload 欠落が違反のまま残ることを固定する。denylist は実運用と同じ ^ アンカー形を使う。
  const anchored = '^(npm\\s+test|git\\s+commit)';
  const codexCommandCases = [
    ['real-zsh-concat-loop', "/bin/zsh -lc 'for f in a/one_test.go b/two_test.go; do echo \"FILE:$f\"; sed -n '\"'1,500p' \\\"\"'$f\"; done'", 0, null],
    ['real-xargs-shc-dump', "/bin/zsh -lc \"rg --files -g 'A.md' -g 'B.md' -g '\"'!vendor'\"' -g '\"'!node_modules'\"' | xargs -r -n1 sh -c 'echo \\\"\"'$0\"; sed -n \"1,260p\" \"$0\"'\"'\"", 0, null],
    ['drift-loop-denylist', "/bin/zsh -lc 'for f in a b; do npm test; done'", 2, '"violationCount": 1'],
    ['drift-while-denylist', "/bin/zsh -lc 'while npm test; do cat x; done'", 2, '"violationCount": 1'],
    ['drift-shc-exec', "/bin/zsh -lc \"rg --files | xargs -n1 sh -c 'npm test'\"", 2, '"violationCount": 1'],
    ['drift-shc-write', "/bin/zsh -lc \"rg --files | xargs -n1 sh -c 'rm -f x'\"", 2, '"violationCount": 1'],
    ['drift-shc-mixed', "/bin/zsh -lc \"rg --files | xargs -n1 sh -c 'cat x; npm test'\"", 2, '"violationCount": 1'],
    ['drift-unbalanced-quote', "/bin/zsh -lc 'echo \"unclosed'", 2, '"unparseableCommandCount": 1'],
    ['drift-shc-payload-missing', "/bin/zsh -lc 'rg --files | xargs sh -c'", 2, '"unparseableCommandCount": 1'],
    ['pipe-tee-still-violation', "/bin/zsh -lc 'cat a | tee b'", 2, '"violationCount": 1'],
    ['drift-case-arm', "/bin/zsh -lc 'case x in x) npm test;; esac'", 2, '"violationCount": 1'],
    ['drift-brace-group', "/bin/zsh -lc '{ npm test; }'", 2, '"violationCount": 1'],
    ['drift-subshell', "/bin/zsh -lc '(npm test)'", 2, '"violationCount": 1'],
    ['drift-env-prefix', "/bin/zsh -lc 'FOO=1 npm test'", 2, '"violationCount": 1'],
    ['drift-bang-prefix', "/bin/zsh -lc '! npm test'", 2, '"violationCount": 1'],
    ['drift-substitution', "/bin/zsh -lc 'echo \"$(npm test)\"'", 2, '"violationCount": 1'],
    ['drift-backtick', "/bin/zsh -lc 'echo `npm test`'", 2, '"violationCount": 1'],
    ['benign-substitution', "/bin/zsh -lc 'echo \"$(git rev-parse HEAD)\"'", 0, null],
    ['inert-single-quoted-substitution', "/bin/zsh -lc \"grep 'x$(npm test)' f\"", 0, null],
    ['drift-wrapper-extra-argv', "/bin/zsh -lc 'eval \"$0\"' 'npm test'", 2, '"unparseableCommandCount": 1'],
    ['drift-shc-redirect', "rg --files | xargs -n1 sh -c 'echo x > /tmp/x'", 2, '"violationCount": 1'],
    ['drift-shc-substitution', "rg --files | xargs sh -c 'echo \"$(npm test)\"'", 2, '"violationCount": 1'],
    ['drift-shc-sed-inplace', "rg --files | xargs -n1 sh -c 'sed -i s/x/y/ \"$0\"'", 2, '"violationCount": 1'],
    ['shc-stderr-dup-allowed', "rg --files | xargs -n1 sh -c 'echo ok >&2; cat \"$0\"'", 0, null],
    ['shc-separated-xargs-args', "rg --files | xargs -n 1 sh -c 'echo \"$0\"; sed -n \"1,20p\" \"$0\"'", 0, null],
    ['xargs-direct-readonly', "find src -type f | sort | xargs rg -n \"pattern\"", 0, null],
    ['drift-xargs-direct-write', "find src -type f | xargs rm -f", 2, '"violationCount": 1'],
    ['drift-xargs-direct-sed-inplace', "find src -type f | xargs sed -i s/x/y/", 2, '"violationCount": 1'],
  ];
  for (const [name, command, exitCode, outputIncl] of codexCommandCases) {
    const log = join(root, `cmd-${name}.jsonl`);
    writeFileSync(log, `${JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command } })}\n${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(valid) } })}\n`);
    expect(`rv03-cmd-${name}`, process.execPath, [reviewLogChecker, log, anchored, join(root, `cmd-${name}.json`)], root, exitCode, null, outputIncl ? [outputIncl] : []);
  }
}

function fingerprintFixtures() {
  const fpHelper = join(repoRoot, 'src/plugin/skills/cross-review/references/review-diff-fingerprint.mjs');
  // 引数なしは usage を出して fail-closed（cwd フォールバック廃止。cwd がリポジトリでも成功させない）
  expect('fp01-arg-required', process.execPath, [fpHelper], repoRoot, 1);
  const initPlain = (name, dirty) => {
    const root = join(runsRoot, name);
    rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true });
    git(root, ['init', '-q']); git(root, ['config', 'user.email', 'fixture@example.invalid']); git(root, ['config', 'user.name', 'Method Fixture']);
    writeFileSync(join(root, 'file.txt'), 'base\n');
    git(root, ['add', '.']); git(root, ['commit', '-qm', 'base']);
    if (dirty) writeFileSync(join(root, 'file.txt'), 'changed\n');
    return root;
  };
  const dirtyRoot = initPlain('fp01-dirty', true);
  const cleanRoot = initPlain('fp01-clean', false);
  // cwd を dev-method に固定したまま引数のリポジトリだけを変え、引数が指紋対象を決める（cwd 非依存）ことを固定する
  const dirtyRun = expect('fp01-dirty-fingerprint', process.execPath, [fpHelper, dirtyRoot], repoRoot, 0);
  const cleanRun = expect('fp01-clean-fingerprint', process.execPath, [fpHelper, cleanRoot], repoRoot, 0);
  const dirtyFp = dirtyRun.stdout.trim(); const cleanFp = cleanRun.stdout.trim();
  assertion('fp01-hex-and-arg-honored', /^[0-9a-f]{64}$/.test(dirtyFp) && /^[0-9a-f]{64}$/.test(cleanFp) && dirtyFp !== cleanFp, { dirtyFp, cleanFp });
}

function newFooter({ lane = 'Ask', plan = 'レビュー計画1R・21分（R1 must0+should0+nit0）', code = 'レビューコード1R・23分（R1 pre must0+should0；cross must0+should0；固有 pre0+cross0；重複0）', planLedger = 'ledger plan 結果受領1/1・合意直前1/1・stale0・eligible=true', codeLedger = 'ledger code 両結果受領1/1・完了直前1/1・stale0・eligible=true', planOutcome = 'R1 plan approved', codeOutcome = 'R1 code approved', e2e = 'E2E 44分', actual = '実働40分（手法運用10分）', prep = 'Evidence Package 準備2分（開始10:00・終了10:02；テスト5分）', classification = '4分類 plan-escape0+implementation-deviation0+evidence-gap0+new-risk0' } = {}) {
  const actualSeg = actual ? ` ${actual} /` : '';
  return `実測: レーン${lane} / 担当fixture / ${plan} / ${code} / ${planLedger} / ${codeLedger} / ${planOutcome} / ${codeOutcome} / ${e2e} /${actualSeg} ${prep} / ${classification} / 差し戻し0 / リーダー直修正0 / 追補0（契約0） / smoke 対象外 / 逸脱: なし`;
}

function methodStatsFixtures() {
  const home = join(runsRoot, 'ob01-home'); rmSync(home, { recursive: true, force: true });
  const directionDir = join(home, 'dev-notes/project/direction'); mkdirSync(directionDir, { recursive: true });
  const rows = [
    newFooter(),
    newFooter({ plan: 'レビュー計画2R・25分（R1 must0+should0+nit0）', planLedger: 'ledger plan 結果受領2/2・合意直前2/2・stale1・eligible=true', planOutcome: 'R1 plan stale_approved_plan', e2e: 'E2E 48分', actual: '実働60分（手法運用30分）' }),
    newFooter({ plan: 'レビュー計画2R・25分（R1 must1+should0+nit0）', code: 'レビューコード2R・26分（R1 pre must1+should0；cross must0+should0；固有 pre1+cross0；重複0）', planLedger: 'ledger plan 結果受領2/2・合意直前1/1・stale0・eligible=true', codeLedger: 'ledger code 両結果受領2/2・完了直前1/1・stale0・eligible=true', planOutcome: 'R1 plan findings', codeOutcome: 'R1 code findings', e2e: 'E2E 51分', classification: '4分類 plan-escape1+implementation-deviation0+evidence-gap0+new-risk0', actual: '実働20分（手法運用0分）' }),
    newFooter({ planLedger: 'ledger plan 結果受領0/1・合意直前1/1・stale0・eligible=true' }),
    newFooter({ e2e: 'E2E 99分' }),
    newFooter({ prep: 'Evidence Package 準備3分（開始10:00・終了10:02；テスト5分）' }),
    newFooter({ classification: '4分類 broken', actual: '実働abc' }),
    newFooter({ classification: '4分類 plan-escape1+implementation-deviation1+evidence-gap0+new-risk0', actual: '実働10分（手法運用20分）' }),
    '実測: レーンAsk / 担当x / レビュー並列1R・10分（R1 pre must0+should0；cross must0+should0；固有 pre0+cross0；重複0） / 差し戻し0 / リーダー直修正0 / 追補0（契約0） / smoke 対象外 / 逸脱: なし',
    '実測: レーンShip / smoke PASS',
    '実測: レーンShip / 逸脱: なし',
    '実測: レーンShip / smoke MAYBE',
  ];
  rows.forEach((row, index) => writeFileSync(join(directionDir, `2026-07-${String(index + 1).padStart(2, '0')}-fixture.md`), `${row}\n`));
  const result = run(process.execPath, [methodStats], repoRoot, { ...process.env, HOME: home });
  const combined = `${result.stdout}\n${result.stderr}`;
  const expected = ['Evidence新形式件数: 8', 'dogfood適格件数: 7', 'plan R1承認率（dogfood適格のみ）: 5/7 (71.4%)', 'code R1承認率（dogfood適格のみ）: 6/7 (85.7%)', 'plan平均レビュー分: 22.0', 'code平均レビュー分: 23.4', 'E2E平均分: 45.6', '実働記録件数（Show含む）: 6/8', '実働平均分: 40.0', '手法運用比率: 70/240 (29.2%)', 'Evidence Package準備平均分（テスト時間は含めない）: 2.0', 'R1 4分類合計（plan-escape / implementation-deviation / evidence-gap / new-risk）: 1 / 0 / 0 / 0', 'plan ledgerの観測数/期待数/stale/eligibleが内部不一致', 'E2E時間がplan+codeと不整合', '実働欄文法外', '実働欄の手法運用が実働を超過', 'Evidence Package準備時間が開始・終了との差分と不整合', '4分類文法外', '4分類合計がcode R1固有/重複合計と不整合', '並列Ask件数（旧形式）: 1', 'smoke実施率: 1/12 (8.3%)', 'smoke記録不備: 未記載1件 / 文法外1件'];
  const passed = result.status === 0 && expected.every((value) => combined.includes(value));
  writeFileSync(join(logsRoot, 'ob01-method-stats.log'), combined);
  assertion('ob01-method-stats-new-old-and-drifts', passed, { exit: result.status, missing: expected.filter((value) => !combined.includes(value)) });
  // 欠測の 0 化 fail-open の反証: 実働欄なしフッターのみの専用 home で、実働関連警告が出力に現れないことを
  // negative assertion（output-excludes）で確認し、実働記録件数が 0/N・欠測が平均へ不算入であることを確認する。
  const missHome = join(runsRoot, 'ob01-actual-missing-home'); rmSync(missHome, { recursive: true, force: true });
  const missDir = join(missHome, 'dev-notes/project/direction'); mkdirSync(missDir, { recursive: true });
  [newFooter({ actual: null }), newFooter({ actual: null, e2e: 'E2E 48分' })].forEach((row, index) => writeFileSync(join(missDir, `2026-08-${String(index + 1).padStart(2, '0')}-miss.md`), `${row}\n`));
  const miss = run(process.execPath, [methodStats], repoRoot, { ...process.env, HOME: missHome });
  const missCombined = `${miss.stdout}\n${miss.stderr}`;
  const missExcludes = ['実働欄文法外', '実働欄の手法運用が実働を超過'];
  assertion('ob01-actual-missing-no-warning', miss.status === 0 && missCombined.includes('実働記録件数（Show含む）: 0/2') && missCombined.includes('実働平均分: 該当なし') && missExcludes.every((value) => !missCombined.includes(value)), { exit: miss.status, present: missExcludes.filter((value) => missCombined.includes(value)) });
  // 4レーン混在: Sign / Seal / 旧 Ask のフッターが共存しても集計が壊れないことを固定。旧 Ask と Seal は Seal 系譜として
  // dogfood 適格、Sign は ledger 欄・Evidence 欄が「対象外」で警告なし・dogfood 非適格。
  const laneHome = join(runsRoot, 'ob01-lane-home'); rmSync(laneHome, { recursive: true, force: true });
  const laneDir = join(laneHome, 'dev-notes/project/direction'); mkdirSync(laneDir, { recursive: true });
  const signFooter = newFooter({ lane: 'Sign', planLedger: 'ledger plan 対象外', codeLedger: 'ledger code 対象外', prep: 'Evidence Package 対象外' });
  [newFooter({ lane: 'Ask' }), newFooter({ lane: 'Seal' }), signFooter].forEach((row, index) => writeFileSync(join(laneDir, `2026-09-${String(index + 1).padStart(2, '0')}-lane.md`), `${row}\n`));
  const lane = run(process.execPath, [methodStats], repoRoot, { ...process.env, HOME: laneHome });
  const laneCombined = `${lane.stdout}\n${lane.stderr}`;
  const laneExpected = ['Evidence新形式件数: 3', 'dogfood適格件数: 2'];
  const laneForbidden = ['新形式のレーン不一致', 'ledger欠落', 'Evidence Package準備時間欠落'];
  assertion('ob01-lane-mixed-sign-seal-ask', lane.status === 0 && laneExpected.every((value) => laneCombined.includes(value)) && laneForbidden.every((value) => !laneCombined.includes(value)), { exit: lane.status, missing: laneExpected.filter((value) => !laneCombined.includes(value)), present: laneForbidden.filter((value) => laneCombined.includes(value)) });
  // Show×実働: 実働欄はレーン不問で解析・集計する。Show 簡易フッターの実働欄が警告なしで集計へ算入され、実働欄なし
  // Show は欠測（不算入）になることを固定。Show 簡易フッターは旧 serial 欄（差し戻し等）の警告も出さない（警告ゼロ）。
  const showHome = join(runsRoot, 'ob01-show-actual-home'); rmSync(showHome, { recursive: true, force: true });
  const showDir = join(showHome, 'dev-notes/project/direction'); mkdirSync(showDir, { recursive: true });
  [
    '実測: レーンShow / レビュー1R（R1 must0+should0） / 実働30分（手法運用8分） / smoke 対象外 / 逸脱: なし',
    '実測: レーンShow / レビュー1R（R1 must0+should0） / smoke 対象外 / 逸脱: なし',
  ].forEach((row, index) => writeFileSync(join(showDir, `2026-10-${String(index + 1).padStart(2, '0')}-show.md`), `${row}\n`));
  const show = run(process.execPath, [methodStats], repoRoot, { ...process.env, HOME: showHome });
  const showCombined = `${show.stdout}\n${show.stderr}`;
  const showExpected = ['実働記録件数（Show含む）: 1/0', '実働平均分: 30.0', '手法運用比率: 8/30 (26.7%)'];
  assertion('ob01-show-actual-counted-no-warning', show.status === 0 && showExpected.every((value) => showCombined.includes(value)) && !showCombined.includes('警告:'), { exit: show.status, missing: showExpected.filter((value) => !showCombined.includes(value)), warnings: showCombined.includes('警告:') });
  const emptyHome = join(runsRoot, 'ob01-empty-home'); rmSync(emptyHome, { recursive: true, force: true }); mkdirSync(emptyHome, { recursive: true });
  const empty = run(process.execPath, [methodStats], repoRoot, { ...process.env, HOME: emptyHome });
  assertion('ob01-dev-notes-missing', empty.status === 0 && empty.stdout.includes('~/dev-notes 不在'));
}

function concurrentHarnessFixtures() {
  const firstOut = join(workRoot, 'probe-first.json'); const secondOut = join(workRoot, 'probe-second.json');
  const command = '"$1" "$2" --root-probe > "$3" & first=$!; "$1" "$2" --root-probe > "$4" & second=$!; wait "$first"; first_status=$?; wait "$second"; second_status=$?; test "$first_status" -eq 0 -a "$second_status" -eq 0';
  const concurrent = run('sh', ['-c', command, 'method-fixture-probe', process.execPath, selfPath, firstOut, secondOut], repoRoot);
  assertion('ob01-concurrent-harness-processes-green', concurrent.status === 0, { stderr: concurrent.stderr });
  const first = JSON.parse(readFileSync(firstOut, 'utf8')); const second = JSON.parse(readFileSync(secondOut, 'utf8'));
  assertion('ob01-concurrent-harness-roots-unique', first.root !== second.root && existsSync(first.root) && existsSync(second.root));
  assertion('ob01-concurrent-harness-overlapped', first.started < second.ended && second.started < first.ended, { first, second });
}

function sharedClauseFixtures() {
  expect('ob02-shared-normal-and-all-drifts', process.execPath, [join(repoRoot, 'scripts/check-shared-clauses.mjs'), '--self-test'], repoRoot, 0, null, ['deliberate drifts detected']);
}

// session-metrics.mjs（method-check の固定集計スクリプト）の検体。direction 検証設計表の全失敗クラス×
// EC-MC-1〜4 の oracle・反証を assertion 化する。合成 fixture は時間分類の期待値を厳密に持ち、反証
// （fail-open）対照実装が別々に落ちるよう設計する。実 transcript 由来匿名 fixture は client・保持イベント
// 種別構成のみを非識別 provenance として変数名で表現し、採取元セッション ID は残さない。
function sessionMetricsFixtures() {
  const dir = join(workRoot, 'session-metrics'); mkdirSync(dir, { recursive: true });
  const base = Date.UTC(2026, 6, 1, 0, 0, 0);
  const iso = (ms) => new Date(base + ms).toISOString();
  const writeLog = (name, events) => { const path = join(dir, `${name}.jsonl`); writeFileSync(path, `${events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n')}\n`); return path; };
  const runMetrics = (paths, methodPaths = []) => {
    const args = [sessionMetrics];
    for (const p of paths) args.push('--session', p);
    for (const m of methodPaths) args.push('--method-path', m);
    const result = run(process.execPath, args, repoRoot);
    let json = null; try { json = JSON.parse(result.stdout); } catch { /* leave null */ }
    return { status: result.status, json, stderr: result.stderr };
  };
  // Claude イベントビルダ（必要最小キー）。
  const cUser = (ms, text) => ({ type: 'user', timestamp: iso(ms), message: { role: 'user', content: text } });
  const cAssistantText = (ms, text) => ({ type: 'assistant', timestamp: iso(ms), message: { role: 'assistant', content: [{ type: 'text', text }] } });
  const cAssistantTools = (ms, tools) => ({ type: 'assistant', timestamp: iso(ms), message: { role: 'assistant', content: tools.map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: t.input })) } });
  const cToolResult = (ms, id, body = 'ok') => ({ type: 'user', timestamp: iso(ms), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: body }] } });
  const cSystemTurn = (ms, durationMs) => ({ type: 'system', subtype: 'turn_duration', timestamp: iso(ms), durationMs });
  // Codex イベントビルダ。
  const xMeta = (ms) => ({ type: 'session_meta', timestamp: iso(ms), payload: { id: 'anon', cwd: '/anon/repo', source: 'cli' } });
  const xTaskStart = (ms) => ({ type: 'event_msg', timestamp: iso(ms), payload: { type: 'task_started', started_at: iso(ms) } });
  const xTaskComplete = (ms, durationMs) => ({ type: 'event_msg', timestamp: iso(ms), payload: { type: 'task_complete', duration_ms: durationMs, completed_at: iso(ms) } });
  const xTaskAbort = (ms, durationMs) => ({ type: 'event_msg', timestamp: iso(ms), payload: { type: 'turn_aborted', duration_ms: durationMs } });
  const xReason = (ms) => ({ type: 'response_item', timestamp: iso(ms), payload: { type: 'reasoning', content: [] } });
  const xFnCall = (ms, id, name, args) => ({ type: 'response_item', timestamp: iso(ms), payload: { type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) } });
  const xFnOut = (ms, id) => ({ type: 'response_item', timestamp: iso(ms), payload: { type: 'function_call_output', call_id: id } });
  const xMcpBegin = (ms, id) => ({ type: 'event_msg', timestamp: iso(ms), payload: { type: 'mcp_tool_call_begin', call_id: id } });
  const xMcpEnd = (ms, id, secs, nanos) => ({ type: 'event_msg', timestamp: iso(ms), payload: { type: 'mcp_tool_call_end', call_id: id, duration: { secs, nanos } } });
  const xToken = (ms, total) => ({ type: 'event_msg', timestamp: iso(ms), payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total, input_tokens: total } } } });
  const devDir = '/Users/anon/dev-notes/proj/direction/plan.md';
  const bd = (s) => s.json.sessions[0].breakdown;
  const s0 = (s) => s.json.sessions[0];
  const invariantHolds = (session) => session.activeMs + session.userWaitMs === session.wallClockMs
    && BREAKDOWN_KEYS_FX.every((k) => k in session.breakdown)
    && BREAKDOWN_KEYS_FX.reduce((t, k) => t + session.breakdown[k], 0) === session.activeMs;

  // FC 分類誤り（fail-open）+ 委譲待ち: userWait / delegationWait の期待値一致（EC-MC-1）。
  const fc1 = runMetrics([writeLog('fc-classify-claude', [
    cUser(0, 'start'), cAssistantTools(1000, [{ id: 'a1', name: 'Agent', input: { description: 'delegate' } }]),
    cToolResult(5000, 'a1'), cAssistantText(6000, 'done'), cUser(20000, 'next question'),
  ])]);
  assertion('mc01-claude-userwait', fc1.status === 0 && s0(fc1).userWaitMs === 14000, { uw: fc1.json && s0(fc1).userWaitMs });
  assertion('mc01-claude-delegation-wait', bd(fc1).delegationWaitMs === 4000 && bd(fc1).llmGenerationMs === 2000, { bd: fc1.json && bd(fc1) });
  assertion('mc01-claude-invariant', invariantHolds(s0(fc1)));
  assertion('mc01-claude-turnduration-null', s0(fc1).turnDurationCheckMs === null, { tdc: fc1.json && s0(fc1).turnDurationCheckMs });

  // FC 並行 pending の二重計上: 手法・非手法ツールの重なり区間で methodOps へ1回のみ帰属（EC-MC-1）。
  const fc2 = runMetrics([writeLog('fc-concurrent-method', [
    cUser(0, 'start'), cAssistantTools(1000, [{ id: 'w1', name: 'Write', input: { file_path: devDir } }, { id: 'r1', name: 'Read', input: { file_path: '/tmp/a.txt' } }]),
    cToolResult(3000, 'r1'), cToolResult(4000, 'w1'),
  ])]);
  assertion('mc01-concurrent-methodops-once', bd(fc2).methodOpsMs === 4000 && bd(fc2).toolExecutionMs === 0 && bd(fc2).delegationWaitMs === 0, { bd: fc2.json && bd(fc2) });
  assertion('mc01-concurrent-invariant', invariantHolds(s0(fc2)));

  // FC 優先順位の逆転・欠落: 委譲系 call と通常ツールのみ重なる → delegationWait へ1回のみ（EC-MC-1・上段と独立）。
  const fc3 = runMetrics([writeLog('fc-concurrent-delegation', [
    cUser(0, 'start'), cAssistantTools(1000, [{ id: 'a1', name: 'Task', input: { description: 'x' } }, { id: 'r1', name: 'Read', input: { file_path: '/tmp/a.txt' } }]),
    cToolResult(3000, 'r1'), cToolResult(5000, 'a1'),
  ])]);
  assertion('mc01-delegation-priority', bd(fc3).delegationWaitMs === 4000 && bd(fc3).toolExecutionMs === 0 && bd(fc3).methodOpsMs === 0, { bd: fc3.json && bd(fc3) });

  // FC teammate 通知前の区間は turn 開始前の応答待ちとして userWait へ帰属する（turn_duration の有無に依存しない
  // プロンプト終端規則。queue-operation 自体は非 timeline のまま）（EC-MC-1）。
  const fcQueue = runMetrics([writeLog('fc-queue-teammate', [
    cUser(0, 'start'), cAssistantText(1000, 'done'),
    { type: 'queue-operation', operation: 'enqueue', timestamp: iso(2000), content: '## task-notification teammate' },
    cUser(3000, 'Another Claude session sent a message:\n<teammate-message team="x">hi</teammate-message>'),
    cAssistantText(4000, 'reply'),
  ])]);
  assertion('mc01-queue-teammate-userwait', fcQueue.status === 0 && s0(fcQueue).userWaitMs === 2000 && bd(fcQueue).llmGenerationMs === 2000, { uw: fcQueue.json && s0(fcQueue).userWaitMs, llm: fcQueue.json && bd(fcQueue) });

  // FC 中断ターン欠落 + 検算値無視（Codex, EC-MC-2 反証a/b）。
  const fcAbort = runMetrics([writeLog('fc-codex-abort', [
    xMeta(0), xTaskStart(1000), xReason(2000), xTaskAbort(3000, 2000), xTaskStart(10000), xTaskComplete(11000, 1000),
  ])]);
  assertion('mc02-codex-abort-userwait', s0(fcAbort).userWaitMs === 8000 && s0(fcAbort).activeMs === 3000, { uw: fcAbort.json && s0(fcAbort).userWaitMs, active: fcAbort.json && s0(fcAbort).activeMs });
  assertion('mc02-codex-durationcheck', s0(fcAbort).durationCheckMs === 3000, { dc: fcAbort.json && s0(fcAbort).durationCheckMs });
  assertion('mc02-codex-abort-invariant', invariantHolds(s0(fcAbort)));

  // FC turn 外区間の誤帰属: 最初の task_started 前・最終終端後の非 task イベントが userWait へ一意帰属（EC-MC-2）。
  const fcExternal = runMetrics([writeLog('fc-codex-external', [
    xMeta(0), { type: 'turn_context', timestamp: iso(1000), payload: { type: 'turn_context' } }, xTaskStart(2000), xTaskComplete(3000, 1000),
    { type: 'world_state', timestamp: iso(5000), payload: { type: 'world_state' } }, xToken(6000, 1234),
  ])]);
  assertion('mc02-codex-external-userwait', s0(fcExternal).userWaitMs === 5000 && bd(fcExternal).unattributedMs === 0, { uw: fcExternal.json && s0(fcExternal).userWaitMs, un: fcExternal.json && bd(fcExternal).unattributedMs });
  assertion('mc02-codex-external-invariant', invariantHolds(s0(fcExternal)));
  assertion('mc02-codex-token', s0(fcExternal).tokens && s0(fcExternal).tokens.total_tokens === 1234);

  // FC 二重計上（パーティション破り）: MCP duration がタイムスタンプ差と異なる（EC-MC-2 反証c）。
  const fcMcp = runMetrics([writeLog('fc-codex-mcp', [
    xMeta(0), xTaskStart(1000), xMcpBegin(2000, 'm1'), xMcpEnd(2500, 'm1', 5, 0), xTaskComplete(3000, 2000),
  ])]);
  assertion('mc02-codex-mcp-breakdown-timestamp', bd(fcMcp).toolExecutionMs === 500, { te: fcMcp.json && bd(fcMcp).toolExecutionMs });
  assertion('mc02-codex-mcp-duration-separate', s0(fcMcp).mcpDurationMs === 5000, { mcp: fcMcp.json && s0(fcMcp).mcpDurationMs });
  assertion('mc02-codex-mcp-invariant', invariantHolds(s0(fcMcp)));

  // FC 過検知（迂回面）: /directions/・direction.md・.work 外 review-ledger は非計上（EC-MC-3）。
  const fcBypass = runMetrics([writeLog('fc-bypass', [
    cUser(0, 'start'),
    cAssistantTools(1000, [{ id: 't1', name: 'Write', input: { file_path: '/Users/anon/dev-notes/proj/directions/plan.md' } }]), cToolResult(2000, 't1'),
    cAssistantTools(3000, [{ id: 't2', name: 'Write', input: { file_path: '/Users/anon/dev-notes/proj/direction.md' } }]), cToolResult(4000, 't2'),
    cAssistantTools(5000, [{ id: 't3', name: 'Bash', input: { command: 'cat /Users/anon/repo/review-ledger.txt' } }]), cToolResult(6000, 't3'),
  ])]);
  assertion('mc03-bypass-no-methodops', bd(fcBypass).methodOpsMs === 0, { m: fcBypass.json && bd(fcBypass).methodOpsMs });

  // FC 過検知（出力偶発出現）: direction パスがツール出力本文にのみ現れる → 非計上（EC-MC-3）。
  const fcOutput = runMetrics([writeLog('fc-output-only', [
    cUser(0, 'start'), cAssistantTools(1000, [{ id: 'r1', name: 'Read', input: { file_path: '/tmp/a.txt' } }]),
    cToolResult(2000, 'r1', `see ${devDir}`),
  ])]);
  assertion('mc03-output-only-no-methodops', bd(fcOutput).methodOpsMs === 0, { m: fcOutput.json && bd(fcOutput).methodOpsMs });

  // FC 混在規則: 手法・非手法パス混在入力の呼び出しは計上（EC-MC-3）。
  const fcMixed = runMetrics([writeLog('fc-mixed', [
    cUser(0, 'start'), cAssistantTools(1000, [{ id: 'b1', name: 'Bash', input: { command: `node /tmp/run.js && cat ${devDir}` } }]),
    cToolResult(2000, 'b1'),
  ])]);
  assertion('mc03-mixed-methodops', bd(fcMixed).methodOpsMs === 2000, { m: fcMixed.json && bd(fcMixed).methodOpsMs });

  // FC 過小検知（分岐漏れ）: matcher 6分岐の独立正例。各分岐が単独で methodOps 計上（EC-MC-3）。
  const branches = [
    ['dev-notes-direction', { file_path: '/Users/anon/dev-notes/proj/direction/plan.md' }, []],
    ['friction', { file_path: '/Users/anon/dev-notes/dev-method/friction.md' }, []],
    ['work-review-ledger', { file_path: '/Users/anon/repo/.work/unit/review-ledger.jsonl' }, []],
    ['work-plan-review', { file_path: '/Users/anon/repo/.work/unit/plan-review-1.json' }, []],
    ['work-evidence', { file_path: '/Users/anon/repo/.work/unit/evidence/manifest.json' }, []],
    ['method-path-substring', { file_path: '/tmp/custom-marker-file.txt' }, ['custom-marker']],
  ];
  for (const [name, input, methodPaths] of branches) {
    const fx = runMetrics([writeLog(`fc-branch-${name}`, [
      cUser(0, 'start'), cAssistantTools(1000, [{ id: 'b1', name: 'Write', input }]), cToolResult(2000, 'b1'),
    ])], methodPaths);
    assertion(`mc03-branch-${name}`, bd(fx).methodOpsMs === 2000, { m: fx.json && bd(fx).methodOpsMs });
  }
  // --method-path 空通し検知: substring 無指定なら custom-marker は非計上。
  const fcNoMarker = runMetrics([writeLog('fc-branch-no-marker', [
    cUser(0, 'start'), cAssistantTools(1000, [{ id: 'b1', name: 'Write', input: { file_path: '/tmp/custom-marker-file.txt' } }]), cToolResult(2000, 'b1'),
  ])]);
  assertion('mc03-method-path-empty-passthrough', bd(fcNoMarker).methodOpsMs === 0, { m: fcNoMarker.json && bd(fcNoMarker).methodOpsMs });

  // FC 未知イベントの黙殺（トップレベル未知）: unknownEvents=n の独立 assertion＋隣接区間の unattributedMs 帰属（EC-MC-4）。
  const fcUnknownTop = runMetrics([writeLog('fc-unknown-top', [
    cUser(0, 'start'), { type: 'mystery-event', timestamp: iso(1000) }, { type: 'other-unknown', timestamp: iso(1500) },
    cAssistantText(2000, 'done'), cUser(3000, 'next human prompt'),
  ])]);
  assertion('mc04-unknown-top-count', s0(fcUnknownTop).quality.unknownEvents === 2, { u: fcUnknownTop.json && s0(fcUnknownTop).quality.unknownEvents });
  assertion('mc04-unknown-top-unattributed', bd(fcUnknownTop).unattributedMs === 2000 && s0(fcUnknownTop).userWaitMs === 1000, { un: fcUnknownTop.json && bd(fcUnknownTop).unattributedMs });

  // FC nested type の黙殺（外側既知・nested 未知＝content block）（EC-MC-4）。
  const fcNestedClaude = runMetrics([writeLog('fc-nested-claude', [
    cUser(0, 'start'), { type: 'assistant', timestamp: iso(1000), message: { role: 'assistant', content: [{ type: 'weird-block', data: 'x' }] } }, cAssistantText(2000, 'done'),
  ])]);
  assertion('mc04-nested-claude-block', s0(fcNestedClaude).quality.unknownEvents >= 1, { u: fcNestedClaude.json && s0(fcNestedClaude).quality.unknownEvents });

  // FC nested type の黙殺（外側既知・nested 未知＝event_msg.payload.type）（EC-MC-4）。
  const fcNestedCodex = runMetrics([writeLog('fc-nested-codex', [
    xMeta(0), xTaskStart(1000), { type: 'event_msg', timestamp: iso(1500), payload: { type: 'weird_payload' } }, xTaskComplete(2000, 1000),
  ])]);
  assertion('mc04-nested-codex-payload', s0(fcNestedCodex).quality.unknownEvents >= 1, { u: fcNestedCodex.json && s0(fcNestedCodex).quality.unknownEvents });

  // FC 件数差: 壊れ JSON 行 n 行混入 → skippedLines=n・exit 0（EC-MC-4）。
  const brokenPath = writeLog('fc-broken', [cUser(0, 'start')]);
  writeFileSync(brokenPath, `${JSON.stringify(cUser(0, 'start'))}\n{ broken json\n${JSON.stringify(cAssistantText(1000, 'x'))}\nnot json at all\n}{\n${JSON.stringify(cUser(2000, 'human next'))}\n`);
  const fcBroken = runMetrics([brokenPath]);
  assertion('mc04-broken-skipped-exit0', fcBroken.status === 0 && s0(fcBroken).quality.skippedLines === 3, { exit: fcBroken.status, s: fcBroken.json && s0(fcBroken).quality.skippedLines });

  // FC 突合不能: tool_result 欠落 → orphanToolUses 計上・合計不変式（EC-MC-4）。
  const fcOrphan = runMetrics([writeLog('fc-orphan', [
    cUser(0, 'start'), cAssistantTools(1000, [{ id: 'x1', name: 'Read', input: { file_path: '/tmp/a.txt' } }]), cAssistantText(2000, 'next'),
  ])]);
  assertion('mc04-orphan-count', s0(fcOrphan).quality.orphanToolUses >= 1 && s0(fcOrphan).activeMs <= s0(fcOrphan).wallClockMs, { o: fcOrphan.json && s0(fcOrphan).quality.orphanToolUses });

  // FC 正規化差: Z / +09:00 混在タイムスタンプ → 同一結果（EC-MC-4）。
  const zForm = runMetrics([writeLog('fc-tz-z', [
    { type: 'user', timestamp: '2026-07-01T00:00:00.000Z', message: { role: 'user', content: 'start' } },
    { type: 'assistant', timestamp: '2026-07-01T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } },
  ])]);
  const offForm = runMetrics([writeLog('fc-tz-offset', [
    { type: 'user', timestamp: '2026-07-01T09:00:00.000+09:00', message: { role: 'user', content: 'start' } },
    { type: 'assistant', timestamp: '2026-07-01T09:00:01.000+09:00', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } },
  ])]);
  assertion('mc04-timezone-normalized', bd(zForm).llmGenerationMs === 1000 && bd(zForm).llmGenerationMs === bd(offForm).llmGenerationMs && s0(zForm).wallClockMs === s0(offForm).wallClockMs, { z: zForm.json && bd(zForm).llmGenerationMs, off: offForm.json && bd(offForm).llmGenerationMs });

  // FC 未登録形式: 両形式のキーを持たない jsonl → exit 1（EC-MC-4 fail-closed）。
  const fcUnknownFormat = runMetrics([writeLog('fc-unknown-format', [{ foo: 'bar' }, { baz: 1 }])]);
  assertion('mc04-unknown-format-exit1', fcUnknownFormat.status === 1, { exit: fcUnknownFormat.status });
  // 引数なし → exit 1。
  const noArgs = run(process.execPath, [sessionMetrics], repoRoot);
  assertion('mc04-no-args-exit1', noArgs.status === 1, { exit: noArgs.status });
  // ファイル不在 → exit 1。
  const missing = runMetrics([join(dir, 'does-not-exist.jsonl')]);
  assertion('mc04-missing-file-exit1', missing.status === 1, { exit: missing.status });

  // mirror 軸: 同一論理シナリオを Claude / Codex 両形式で表現し userWaitMs・activeMs が一致（EC-MC-2）。
  const mirrorClaude = runMetrics([writeLog('fc-mirror-claude', [
    cUser(0, 'start'), cAssistantTools(1000, [{ id: 'r1', name: 'Read', input: { file_path: '/tmp/a.txt' } }]),
    cToolResult(2000, 'r1'), cAssistantText(2500, 'done'), cUser(7500, 'next human'), cAssistantText(8500, 'hi'),
  ])]);
  const mirrorCodex = runMetrics([writeLog('fc-mirror-codex', [
    xMeta(0), xTaskStart(0), xFnCall(1000, 'c1', 'read', { path: '/tmp/a.txt' }), xFnOut(2000, 'c1'),
    xTaskComplete(2500, 2500), xTaskStart(7500), xTaskComplete(8500, 1000),
  ])]);
  assertion('mc02-mirror-userwait', s0(mirrorClaude).userWaitMs === s0(mirrorCodex).userWaitMs && s0(mirrorClaude).userWaitMs === 5000, { c: mirrorClaude.json && s0(mirrorClaude).userWaitMs, x: mirrorCodex.json && s0(mirrorCodex).userWaitMs });
  assertion('mc02-mirror-active', s0(mirrorClaude).activeMs === s0(mirrorCodex).activeMs && s0(mirrorClaude).activeMs === 3500, { c: mirrorClaude.json && s0(mirrorClaude).activeMs, x: mirrorCodex.json && s0(mirrorCodex).activeMs });

  // 境界間のパラメータ伝播: --session 複数指定が totals へ合算される（EC-MC-1）。
  const multi = runMetrics([join(dir, 'fc-mirror-claude.jsonl'), join(dir, 'fc-classify-claude.jsonl')]);
  assertion('mc01-totals-summed', multi.json && multi.json.totals.wallClockMs === s0(mirrorClaude).wallClockMs + s0(fc1).wallClockMs
    && multi.json.totals.userWaitMs === s0(mirrorClaude).userWaitMs + s0(fc1).userWaitMs, { t: multi.json && multi.json.totals });

  // turn_duration 検算（存在時は合算値）と窓限定検算（EC-MC-1）。turn1 窓 [0,1100] は区間 [0,1000]＋境界 head
  // [1000,1100] で 1100。turn2 窓は durationMs=1000 がプロンプト(5000)より 100ms 短い [5100,6100] のため
  // [5000,5100] の 100ms がクリップされ、[5000,6000] の重なり 900＋EOF 解決の head [6000,6100] 100 で 1000
  //（窓の外は加算しない性質と、末尾 head が done() で分子へ入る性質の固定）。
  const fcTurnDur = runMetrics([writeLog('fc-turnduration', [
    cUser(0, 'start'), cAssistantText(1000, 'x'), cSystemTurn(1100, 1100), cUser(5000, 'next human'), cAssistantText(6000, 'y'), cSystemTurn(6100, 1000),
  ])]);
  assertion('mc01-turnduration-sum', s0(fcTurnDur).turnDurationCheckMs === 2100, { tdc: fcTurnDur.json && s0(fcTurnDur).turnDurationCheckMs });
  assertion('mc01-turnwindow-active', s0(fcTurnDur).turnWindowActiveMs === 2100 && s0(fcTurnDur).turnWindowCheckMs === 2100, { twa: fcTurnDur.json && s0(fcTurnDur).turnWindowActiveMs, twc: fcTurnDur.json && s0(fcTurnDur).turnWindowCheckMs });

  // RC-A(1) turn 状態機械: pending 残留のまま turn_aborted → 次 task_started まで userWait・残留は orphan（EC-MC-2/4）。
  const fcAbortPending = runMetrics([writeLog('fc-codex-abort-pending', [
    xMeta(0), xTaskStart(1000), xFnCall(2000, 'c1', 'shell', { command: ['bash', '-lc', 'cat /tmp/a.txt'] }), xTaskAbort(3000, 2000),
    xTaskStart(10000), xTaskComplete(11000, 1000),
  ])]);
  assertion('mc02-abort-pending-userwait', s0(fcAbortPending).userWaitMs === 8000 && bd(fcAbortPending).toolExecutionMs === 1000 && s0(fcAbortPending).quality.orphanToolUses === 1, { uw: fcAbortPending.json && s0(fcAbortPending).userWaitMs, te: fcAbortPending.json && bd(fcAbortPending).toolExecutionMs, o: fcAbortPending.json && s0(fcAbortPending).quality.orphanToolUses });
  assertion('mc02-abort-pending-invariant', invariantHolds(s0(fcAbortPending)));

  // RC-A(2) turn 外の未知イベント（合成の将来型。compacted 等の既知化後も未知経路を固定する）を挟んでも
  // userWait へ一意帰属（EC-MC-2）。
  const fcExtUnknown = runMetrics([writeLog('fc-codex-external-unknown', [
    xMeta(0), xTaskStart(1000), xTaskComplete(2000, 1000),
    { type: 'future_unknown_kind', timestamp: iso(3000), payload: {} },
    xTaskStart(8000), xTaskComplete(9000, 1000),
  ])]);
  assertion('mc02-external-unknown-userwait', s0(fcExtUnknown).userWaitMs === 7000 && bd(fcExtUnknown).unattributedMs === 0, { uw: fcExtUnknown.json && s0(fcExtUnknown).userWaitMs, un: fcExtUnknown.json && bd(fcExtUnknown).unattributedMs });

  // RC-A(3) turn 内の未知イベント（合成の将来型）の前後両区間が unattributed（prevUnknown 伝播）（EC-MC-2/4）。
  const fcInnerUnknown = runMetrics([writeLog('fc-codex-inner-unknown', [
    xMeta(0), xTaskStart(1000), xReason(2000), { type: 'future_unknown_kind', timestamp: iso(3000), payload: {} }, xReason(4000), xTaskComplete(5000, 4000),
  ])]);
  assertion('mc02-inner-unknown-unattributed', bd(fcInnerUnknown).unattributedMs === 2000 && s0(fcInnerUnknown).quality.unknownEvents === 1, { un: fcInnerUnknown.json && bd(fcInnerUnknown).unattributedMs, u: fcInnerUnknown.json && s0(fcInnerUnknown).quality.unknownEvents });

  // RC-B(1) 入力本文フィールド（old_string 等、空白を含む本文）にのみ手法パスが現れる呼び出しは非計上（EC-MC-3）。
  const fcBodyOnly = runMetrics([writeLog('fc-body-field-method', [
    cUser(0, 'start'), cAssistantTools(1000, [{ id: 'w1', name: 'Edit', input: { file_path: '/tmp/a.txt', old_string: `see ${devDir} here`, new_string: 'x' } }]), cToolResult(2000, 'w1'),
  ])]);
  assertion('mc03-body-field-not-methodops', bd(fcBodyOnly).methodOpsMs === 0, { m: fcBodyOnly.json && bd(fcBodyOnly).methodOpsMs });

  // RC-B(2) friction 類似パス（friction.md.bak）はセグメント末尾一致でないため非計上（EC-MC-3）。
  const fcFrictionLike = runMetrics([writeLog('fc-friction-like', [
    cUser(0, 'start'), cAssistantTools(1000, [{ id: 'w1', name: 'Write', input: { file_path: '/Users/anon/repo/friction.md.bak' } }]), cToolResult(2000, 'w1'),
  ])]);
  assertion('mc03-friction-like-not-methodops', bd(fcFrictionLike).methodOpsMs === 0, { m: fcFrictionLike.json && bd(fcFrictionLike).methodOpsMs });

  // RC-B(3) Codex shell の command 配列（['bash','-lc',...]）を要素分割して手法パスを抽出・計上（EC-MC-3 の Codex 形式分岐）。
  const fcCodexShellArray = runMetrics([writeLog('fc-codex-shell-array', [
    xMeta(0), xTaskStart(1000), xFnCall(2000, 'c1', 'shell', { command: ['bash', '-lc', `cat ${devDir}`] }), xFnOut(4000, 'c1'), xTaskComplete(5000, 4000),
  ])]);
  assertion('mc03-codex-shell-array-methodops', bd(fcCodexShellArray).methodOpsMs === 3000, { m: fcCodexShellArray.json && bd(fcCodexShellArray).methodOpsMs });

  // 閉包表1: matcher のキー意味論（キー種別×値形状マトリクス）。形状ベース実装と形状フィルタ付きパスキー実装が
  // それぞれ別の検体で落ちる（EC-MC-3）。
  // パスキー×裸ファイル名（friction.md）: 形状フィルタ（/ 必須）実装は脱落するが、キー限定列挙は計上する。
  const fcPathKeyBareName = runMetrics([writeLog('fc-pathkey-bare-friction', [
    cUser(0, 'start'), cAssistantTools(1000, [{ id: 'w1', name: 'Write', input: { file_path: 'friction.md' } }]), cToolResult(2000, 'w1'),
  ])]);
  assertion('mc03-pathkey-bare-name-methodops', bd(fcPathKeyBareName).methodOpsMs === 2000, { m: fcPathKeyBareName.json && bd(fcPathKeyBareName).methodOpsMs });
  // 本文キー×単一パストークン（old_string が空白なしの手法パス丸ごと）: 形状ベース実装が過検知する失敗シナリオ。
  const fcBodyKeySingleToken = runMetrics([writeLog('fc-bodykey-single-token', [
    cUser(0, 'start'), cAssistantTools(1000, [{ id: 'w1', name: 'Edit', input: { file_path: '/tmp/a.txt', old_string: devDir } }]), cToolResult(2000, 'w1'),
  ])]);
  assertion('mc03-bodykey-single-token-not-methodops', bd(fcBodyKeySingleToken).methodOpsMs === 0, { m: fcBodyKeySingleToken.json && bd(fcBodyKeySingleToken).methodOpsMs });
  // 未知キー×パス形の値: 列挙外キーは候補化しない（過小検知方向）。
  const fcUnknownKeyPath = runMetrics([writeLog('fc-unknownkey-path', [
    cUser(0, 'start'), cAssistantTools(1000, [{ id: 'w1', name: 'Custom', input: { some_unknown_key: devDir } }]), cToolResult(2000, 'w1'),
  ])]);
  assertion('mc03-unknown-key-not-methodops', bd(fcUnknownKeyPath).methodOpsMs === 0, { m: fcUnknownKeyPath.json && bd(fcUnknownKeyPath).methodOpsMs });

  // RC-D 先頭・末尾が system / queue-operation / 未知型の Claude fixture → 端点を全 timestamped イベントへ拡張し
  // 未被覆の先頭・末尾隣接区間を unattributed へ反映（Codex と対称）（EC-MC-1）。
  const fcEndpoints = runMetrics([writeLog('fc-claude-endpoints', [
    { type: 'summary', summary: 'lead', leafUuid: 'x' },
    cSystemTurn(0, 0),
    { type: 'queue-operation', operation: 'enqueue', timestamp: iso(500), content: 'x' },
    cUser(1000, 'start'), cAssistantText(2000, 'done'),
    { type: 'ai-title', title: 'x' },
    { type: 'mystery-tail', timestamp: iso(5000) },
  ])]);
  assertion('mc01-claude-endpoints', s0(fcEndpoints).wallClockMs === 5000 && bd(fcEndpoints).unattributedMs === 4000 && s0(fcEndpoints).quality.unknownEvents === 1 && invariantHolds(s0(fcEndpoints)), { wall: fcEndpoints.json && s0(fcEndpoints).wallClockMs, un: fcEndpoints.json && bd(fcEndpoints).unattributedMs });

  // RC-E Codex の待機・委譲系ツール wait_agent と通常ツールの重なり → delegationWait へ帰属（EC-MC-1/2）。
  const fcWaitAgent = runMetrics([writeLog('fc-codex-wait-agent', [
    xMeta(0), xTaskStart(1000), xFnCall(2000, 'a1', 'wait_agent', {}), xFnCall(2500, 'r1', 'shell', { command: ['bash', '-lc', 'cat /tmp/a.txt'] }),
    xFnOut(4000, 'r1'), xFnOut(6000, 'a1'), xTaskComplete(7000, 6000),
  ])]);
  assertion('mc02-wait-agent-delegation', bd(fcWaitAgent).delegationWaitMs === 4000 && bd(fcWaitAgent).toolExecutionMs === 0, { d: fcWaitAgent.json && bd(fcWaitAgent).delegationWaitMs, te: fcWaitAgent.json && bd(fcWaitAgent).toolExecutionMs });

  // RC-F Codex 実在 top-level 型が全て既知集合に含まれ unknown にならないことを固定（compacted /
  // inter_agent_communication_metadata は 2026-07-25 の既知集合追補で既知化。未知経路の固定は RC-A(2)(3) の
  // 合成将来型が担う）（EC-MC-4）。
  const fcRealTypes = runMetrics([writeLog('fc-codex-real-types', [
    xMeta(0), { type: 'turn_context', timestamp: iso(100), payload: { type: 'turn_context' } }, { type: 'compacted', timestamp: iso(200), payload: {} },
    xTaskStart(1000), { type: 'event_msg', timestamp: iso(1100), payload: { type: 'thread_settings_applied' } }, xTaskComplete(2000, 1000),
    { type: 'inter_agent_communication_metadata', timestamp: iso(3000), payload: {} }, { type: 'world_state', timestamp: iso(3500), payload: { type: 'world_state' } },
  ])]);
  assertion('mc04-codex-real-types-unknown-count', s0(fcRealTypes).quality.unknownEvents === 0 && invariantHolds(s0(fcRealTypes)), { u: fcRealTypes.json && s0(fcRealTypes).quality.unknownEvents });

  // must: クライアント判別 fail-closed。session_meta が無く既知 top-level 型だけの Codex 風ファイルは exit 1（EC-MC-2/4）。
  const fcNoSessionMeta = runMetrics([writeLog('fc-codex-no-session-meta', [
    { type: 'event_msg', timestamp: iso(0), payload: { type: 'task_started' } },
    { type: 'response_item', timestamp: iso(1000), payload: { type: 'reasoning', content: [] } },
    { type: 'event_msg', timestamp: iso(2000), payload: { type: 'task_complete', duration_ms: 2000 } },
  ])]);
  assertion('mc04-no-session-meta-exit1', fcNoSessionMeta.status === 1, { exit: fcNoSessionMeta.status });

  // must: nested discriminator 欠落の fail-closed。payload.type が null / 欠落の event_msg / response_item は
  // unknownEvents へ計上し隣接区間を unattributedMs へ帰属する（EC-MC-4。「値があるときだけ照合」fail-open を排除）。
  const fcDiscriminator = runMetrics([writeLog('fc-codex-discriminator-missing', [
    xMeta(0), xTaskStart(1000),
    { type: 'event_msg', timestamp: iso(2000), payload: { type: null } },
    { type: 'response_item', timestamp: iso(3000), payload: {} },
    xTaskComplete(4000, 3000),
  ])]);
  assertion('mc04-discriminator-missing-unknown', s0(fcDiscriminator).quality.unknownEvents === 2 && bd(fcDiscriminator).unattributedMs === 3000 && invariantHolds(s0(fcDiscriminator)), { u: fcDiscriminator.json && s0(fcDiscriminator).quality.unknownEvents, un: fcDiscriminator.json && bd(fcDiscriminator).unattributedMs });

  // must1: 測定 cutoff のバイト固定（EC-MC-6/1/2）。(a) cutoffBytes = 起動時 stat サイズ。
  const cutoffPath = writeLog('fc-cutoff', [cUser(0, 'start'), cAssistantText(1000, 'x'), cUser(2000, 'next human')]);
  const fcCutoff = runMetrics([cutoffPath]);
  assertion('mc06-cutoff-bytes-equals-size', s0(fcCutoff).cutoffBytes === statSync(cutoffPath).size, { c: fcCutoff.json && s0(fcCutoff).cutoffBytes, size: statSync(cutoffPath).size });
  // (b) end 固定の実効性: 末尾に partial line（改行なし・不完全 JSON）を足したファイルは partial 行を skippedLines へ
  // 決定論的に計上し、cutoffBytes は stat サイズと一致する。
  const partialPath = join(dir, 'fc-cutoff-partial.jsonl');
  writeFileSync(partialPath, `${readFileSync(cutoffPath, 'utf8')}{"type":"user","timesta`);
  const fcPartial = runMetrics([partialPath]);
  assertion('mc06-cutoff-partial-line-deterministic', s0(fcPartial).cutoffBytes === statSync(partialPath).size && s0(fcPartial).quality.skippedLines === 1, { c: fcPartial.json && s0(fcPartial).cutoffBytes, s: fcPartial.json && s0(fcPartial).quality.skippedLines });
  // (c) cutoffBytes は stat サイズを追う: 追記後の再解析で cutoffBytes が新サイズになり追記行が読まれる（起動時サイズで固定）。
  const growPath = join(dir, 'fc-cutoff-grow.jsonl');
  writeFileSync(growPath, `${JSON.stringify(cUser(0, 'start'))}\n${JSON.stringify(cAssistantText(1000, 'x'))}\n`);
  const grow1 = runMetrics([growPath]); const growSize1 = statSync(growPath).size;
  writeFileSync(growPath, `${JSON.stringify(cUser(2000, 'next human'))}\n`, { flag: 'a' });
  const grow2 = runMetrics([growPath]); const growSize2 = statSync(growPath).size;
  assertion('mc06-cutoff-tracks-stat-size', s0(grow1).cutoffBytes === growSize1 && s0(grow2).cutoffBytes === growSize2 && growSize2 > growSize1 && s0(grow2).quality.parsedLines === s0(grow1).quality.parsedLines + 1, { c1: grow1.json && s0(grow1).cutoffBytes, c2: grow2.json && s0(grow2).cutoffBytes });

  // must2: Claude content block discriminator の対称 fail-closed（EC-MC-4）。非 object block（{}）と type:null block を
  // 含む assistant 行は unknownEvents 計上＋隣接区間 unattributed。「値があるときだけ照合」実装は unknownEvents=0 で落ちる。
  const fcClaudeDiscriminator = runMetrics([writeLog('fc-claude-discriminator', [
    cUser(0, 'start'),
    { type: 'assistant', timestamp: iso(1000), message: { role: 'assistant', content: [{}] } },
    { type: 'assistant', timestamp: iso(2000), message: { role: 'assistant', content: [{ type: null }] } },
    cAssistantText(3000, 'ok'),
  ])]);
  assertion('mc04-claude-discriminator-unknown', s0(fcClaudeDiscriminator).quality.unknownEvents === 2 && bd(fcClaudeDiscriminator).unattributedMs > 0 && invariantHolds(s0(fcClaudeDiscriminator)), { u: fcClaudeDiscriminator.json && s0(fcClaudeDiscriminator).quality.unknownEvents, un: fcClaudeDiscriminator.json && bd(fcClaudeDiscriminator).unattributedMs });

  // should: preDetection バッファ上限（EC-MC-4）。上限超の未知形式ファイルは EOF まで読まず exit 1（fail-closed）。
  const fcPreLimit = runMetrics([writeLog('fc-pre-detection-limit', Array.from({ length: 300 }, (unused, i) => ({ foo: 'bar', i })))]);
  assertion('mc04-pre-detection-limit-exit1', fcPreLimit.status === 1, { exit: fcPreLimit.status });

  // mc07: Claude の turn 外区間（turn_duration → 次 timeline イベント）の userWait 一意帰属（EC-MC-2 対称）。
  // (1) teammate 待ち × 委譲 pending 越境: 境界前 head は delegationWait、境界後 tail は userWait。
  // 境界無視実装は userWait=0、分割無し（全区間 userWait）実装は delegationWait=1000 で落ちる識別 assertion。
  const fcTurnExternal = runMetrics([writeLog('fc-claude-turn-external', [
    cUser(0, 'start'),
    cAssistantTools(1000, [{ id: 'a1', name: 'Agent', input: { description: 'teammate' } }]),
    cSystemTurn(2000, 2000),
    cUser(30000, 'Another Claude session sent a message:\n<teammate-message team="x">done</teammate-message>'),
    cAssistantText(31000, 'ack'),
  ])]);
  assertion('mc07-turn-external-userwait', s0(fcTurnExternal).userWaitMs === 28000, { uw: fcTurnExternal.json && s0(fcTurnExternal).userWaitMs });
  assertion('mc07-turn-external-head-delegation', bd(fcTurnExternal).delegationWaitMs === 2000 && bd(fcTurnExternal).llmGenerationMs === 1000, { bd: fcTurnExternal.json && bd(fcTurnExternal) });
  assertion('mc07-turn-external-invariant', invariantHolds(s0(fcTurnExternal)));

  // (2) task-notification 待ち（pending なし）: tail が userWait、turn 内区間は LLM 生成のまま。
  const fcTaskNotify = runMetrics([writeLog('fc-claude-task-notification', [
    cUser(0, 'start'), cAssistantText(1000, 'kicked off background review'),
    cSystemTurn(1100, 1100),
    cUser(20000, '<task-notification>background task finished</task-notification>'),
    cAssistantText(21000, 'processed'),
  ])]);
  assertion('mc07-task-notification-userwait', s0(fcTaskNotify).userWaitMs === 18900 && bd(fcTaskNotify).llmGenerationMs === 2100, { uw: fcTaskNotify.json && s0(fcTaskNotify).userWaitMs, llm: fcTaskNotify.json && bd(fcTaskNotify).llmGenerationMs });

  // (3) 非委譲 pending の越境 × 人間プロンプト: 並行 pending 優先規則が turn 外を侵食しない
  // （境界前 toolExecution・境界後 userWait。pending 優先を turn 外まで適用する実装は userWait=0 で落ちる）。
  const fcTurnPendingHuman = runMetrics([writeLog('fc-claude-turn-pending-human', [
    cUser(0, 'start'),
    cAssistantTools(1000, [{ id: 'b1', name: 'Bash', input: { command: 'sleep 999' } }]),
    cSystemTurn(1500, 1500),
    cUser(10000, 'human follow-up'),
    cAssistantText(11000, 'reply'),
  ])]);
  assertion('mc07-turn-pending-human-userwait', s0(fcTurnPendingHuman).userWaitMs === 8500 && bd(fcTurnPendingHuman).toolExecutionMs === 1500, { uw: fcTurnPendingHuman.json && s0(fcTurnPendingHuman).userWaitMs, te: fcTurnPendingHuman.json && bd(fcTurnPendingHuman).toolExecutionMs });
  assertion('mc07-turn-pending-human-invariant', invariantHolds(s0(fcTurnPendingHuman)));

  // (4) 検算整合: turn_duration のある完結ログで activeMs が turnDurationCheckMs と一致する（欠測構造の解消を固定）。
  // 最終 turn の末尾 100ms（最後の timeline イベント→turn 終端）は done() の EOF 境界解決で llmGeneration と
  // 窓分子の双方へ入り、窓限定検算もゼロ乖離になる。
  const fcTurnCheck = runMetrics([writeLog('fc-claude-turn-check', [
    cUser(0, 'start'), cAssistantText(1000, 'x'), cSystemTurn(1100, 1100),
    cUser(5000, '<task-notification>done</task-notification>'), cAssistantText(6000, 'y'), cSystemTurn(6100, 1100),
  ])]);
  assertion('mc07-turn-check-active-equals-check', s0(fcTurnCheck).activeMs === s0(fcTurnCheck).turnDurationCheckMs && s0(fcTurnCheck).turnDurationCheckMs === 2200, { a: fcTurnCheck.json && s0(fcTurnCheck).activeMs, tdc: fcTurnCheck.json && s0(fcTurnCheck).turnDurationCheckMs });
  assertion('mc07-turn-check-window-active', s0(fcTurnCheck).turnWindowActiveMs === 2200 && bd(fcTurnCheck).unattributedMs === 0, { twa: fcTurnCheck.json && s0(fcTurnCheck).turnWindowActiveMs, un: fcTurnCheck.json && bd(fcTurnCheck) });

  // (5) プロンプト終端規則の pending 優先逆転: teammate 通知で終わる区間は委譲 pending 中でも userWait
  // （turn_duration の無い turn の turn 外相当を吸収する規則。pending 優先の旧実装は userWait=0 で落ちる）。
  const fcInjectedPending = runMetrics([writeLog('fc-claude-injected-pending', [
    cUser(0, 'start'),
    cAssistantTools(1000, [{ id: 'a1', name: 'Agent', input: { description: 'teammate' } }]),
    cUser(30000, 'Another Claude session sent a message:\n<teammate-message team="x">done</teammate-message>'),
    cAssistantText(31000, 'ack'),
  ])]);
  assertion('mc07-injected-over-pending', s0(fcInjectedPending).userWaitMs === 29000 && bd(fcInjectedPending).delegationWaitMs === 1000, { uw: fcInjectedPending.json && s0(fcInjectedPending).userWaitMs, d: fcInjectedPending.json && bd(fcInjectedPending) });

  // (6) 部分カバレッジの窓限定検算: turn_duration の無い turn（10000→15000 の 5000ms 生成）は activeMs には
  // 入るが窓限定検算には入らない。全体 active（7200）と検算値（2200）を直接比較する実装は 227% 乖離で
  // 欠測を再現し、窓限定（2200 vs 2200）は turn_duration の部分出力ログでも成立する（実測 friction の再現検体。
  // 末尾 turn の head 100ms は EOF 境界解決で分子へ入る）。
  const fcPartialWindows = runMetrics([writeLog('fc-claude-partial-windows', [
    cUser(0, 'start'), cAssistantText(1000, 'x'), cSystemTurn(1100, 1100),
    cUser(10000, '<teammate-message team="x">r1</teammate-message>'), cAssistantText(15000, 'long reply, no turn_duration'),
    cUser(30000, 'human follow-up'), cAssistantText(31000, 'y'), cSystemTurn(31100, 1100),
  ])]);
  assertion('mc07-partial-windows', s0(fcPartialWindows).turnWindowActiveMs === 2200 && s0(fcPartialWindows).turnWindowCheckMs === 2200 && s0(fcPartialWindows).activeMs === 7200, { twa: fcPartialWindows.json && s0(fcPartialWindows).turnWindowActiveMs, twc: fcPartialWindows.json && s0(fcPartialWindows).turnWindowCheckMs, a: fcPartialWindows.json && s0(fcPartialWindows).activeMs });
  assertion('mc07-partial-windows-invariant', invariantHolds(s0(fcPartialWindows)));

  // (7) 窓の無いログは窓限定検算 null（検算不能を 0 と区別する fail-closed）。
  assertion('mc07-no-windows-null', s0(fc1).turnWindowActiveMs === null && s0(fc1).turnWindowCheckMs === null, { twa: fc1.json && s0(fc1).turnWindowActiveMs });

  // (8) dirty 窓の除外: 窓内部にプロンプト（steering / teammate の途中投入）を含む turn の durationMs は
  // turn 内応答待ちを含むため、窓限定検算の分子・分母双方から除外する（turnDurationCheckMs には残る）。
  // 全窓を検算へ入れる実装は twc=4200 で落ち、チーム長大 turn の再欠測（実測 friction の 89%/100% 乖離）を防ぐ。
  const fcDirtyWindow = runMetrics([writeLog('fc-claude-dirty-window', [
    cUser(0, 'start'), cAssistantText(1000, 'a'),
    cUser(2000, 'Another Claude session sent a message:\n<teammate-message team="x">mid-turn</teammate-message>'),
    cAssistantText(3000, 'b'), cSystemTurn(3100, 3100),
    cUser(10000, 'human next'), cAssistantText(11000, 'c'), cSystemTurn(11100, 1100),
    cUser(20000, 'human tail'),
  ])]);
  assertion('mc07-dirty-window-excluded', s0(fcDirtyWindow).turnWindowCheckMs === 1100 && s0(fcDirtyWindow).turnWindowActiveMs === 1100 && s0(fcDirtyWindow).turnDurationCheckMs === 4200, { twc: fcDirtyWindow.json && s0(fcDirtyWindow).turnWindowCheckMs, twa: fcDirtyWindow.json && s0(fcDirtyWindow).turnWindowActiveMs, tdc: fcDirtyWindow.json && s0(fcDirtyWindow).turnDurationCheckMs });

  // (9) EOF 境界解決（cross R1 must-fix の再現検体）: 最終 turn の turn_duration 後に timeline イベントが無い
  // まま cutoff。末尾 head [100,1000] を done() が llmGeneration と窓分子へ解決し、窓限定検算ゼロ乖離になる。
  // 未解決実装は twa=100（90% 乖離）・active が finalize 残差の unattributed 側で膨らみ、両 assertion で落ちる。
  const fcEofHead = runMetrics([writeLog('fc-claude-eof-head', [
    cUser(0, 'start'), cAssistantText(100, 'a'), cSystemTurn(1000, 1000),
  ])]);
  assertion('mc07-eof-head-resolved', s0(fcEofHead).turnWindowActiveMs === 1000 && s0(fcEofHead).turnWindowCheckMs === 1000 && s0(fcEofHead).activeMs === 1000 && s0(fcEofHead).userWaitMs === 0 && bd(fcEofHead).unattributedMs === 0, { twa: fcEofHead.json && s0(fcEofHead).turnWindowActiveMs, a: fcEofHead.json && s0(fcEofHead).activeMs, uw: fcEofHead.json && s0(fcEofHead).userWaitMs });
  assertion('mc07-eof-head-invariant', invariantHolds(s0(fcEofHead)));

  // (10) EOF 境界解決の tail 側: turn_duration 後に非 timeline イベント（メタ・queue-operation）だけが続く場合、
  // turn 外の残尾 [1100,5000] は unattributed でなく userWait へ帰属する。
  const fcEofTail = runMetrics([writeLog('fc-claude-eof-tail', [
    cUser(0, 'start'), cAssistantText(1000, 'a'), cSystemTurn(1100, 1100),
    { type: 'ai-title', title: 'x' },
    { type: 'queue-operation', operation: 'enqueue', timestamp: iso(5000), content: 'x' },
  ])]);
  assertion('mc07-eof-tail-userwait', s0(fcEofTail).userWaitMs === 3900 && s0(fcEofTail).turnWindowActiveMs === 1100 && s0(fcEofTail).turnWindowCheckMs === 1100 && bd(fcEofTail).unattributedMs === 0, { uw: fcEofTail.json && s0(fcEofTail).userWaitMs, twa: fcEofTail.json && s0(fcEofTail).turnWindowActiveMs, un: fcEofTail.json && bd(fcEofTail) });
  assertion('mc07-eof-tail-invariant', invariantHolds(s0(fcEofTail)));

  sessionMetricsRealTranscriptFixtures(dir, runMetrics, iso, invariantHolds, s0);
}

// 実 transcript 由来匿名 fixture。実ログのキー構成・timestamp 形式・イベント順序を保持し、パス・本文・ID を
// 差し替えた抜粋。非識別 provenance（client と保持したイベント種別構成）だけを変数名・assertion 名で表現し、
// 採取元セッション ID はリポジトリ・コミット履歴へ残さない。合成 fixture だけでは代表できないキー欠損パターン
// （Claude の last-prompt/ai-title 等 timestamp 無しメタ行、Codex の turn_context/world_state 混在）を担保する。
function sessionMetricsRealTranscriptFixtures(dir, runMetrics, iso, invariantHolds, s0) {
  // Claude: user(prompt/tool_result)・assistant(text/thinking/tool_use)・system(turn_duration/stop_hook)・
  // queue-operation・timestamp 無しメタ行（last-prompt/ai-title/summary）の構成を保持した匿名抜粋。
  const claudeLines = [
    { type: 'summary', summary: 'anonymized session summary', leafUuid: 'anon-0' },
    { type: 'user', timestamp: iso(0), message: { role: 'user', content: 'anonymized human request' }, cwd: '/anon/repo', gitBranch: 'main', promptSource: 'typed', sessionId: 'anon', uuid: 'anon-1', userType: 'external', version: '2.1.0', isSidechain: false, parentUuid: null },
    { type: 'assistant', timestamp: iso(3000), message: { role: 'assistant', id: 'anon', model: 'anon', content: [{ type: 'thinking', thinking: 'redacted' }, { type: 'text', text: 'anonymized reply' }] }, sessionId: 'anon', uuid: 'anon-2' },
    { type: 'assistant', timestamp: iso(6000), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'anon-tool-1', name: 'Read', input: { file_path: '/anon/repo/file.txt' } }] }, sessionId: 'anon', uuid: 'anon-3' },
    { type: 'user', timestamp: iso(8000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'anon-tool-1', content: 'anonymized output' }] }, sessionId: 'anon', uuid: 'anon-4', isSidechain: false },
    { type: 'assistant', timestamp: iso(9000), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'anon-tool-2', name: 'Write', input: { file_path: '/Users/anon/dev-notes/proj/direction/plan.md', content: 'anon' } }] }, sessionId: 'anon', uuid: 'anon-5' },
    { type: 'user', timestamp: iso(12000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'anon-tool-2', content: 'ok' }] }, sessionId: 'anon', uuid: 'anon-6' },
    { type: 'assistant', timestamp: iso(13000), message: { role: 'assistant', content: [{ type: 'text', text: 'anonymized completion' }] }, sessionId: 'anon', uuid: 'anon-7' },
    { type: 'system', subtype: 'stop_hook_summary', timestamp: iso(13100), hookCount: 1, sessionId: 'anon', uuid: 'anon-8' },
    { type: 'system', subtype: 'turn_duration', durationMs: 13100, timestamp: iso(13100), messageCount: 8, sessionId: 'anon', uuid: 'anon-9' },
    { type: 'last-prompt', lastPrompt: 'anonymized', leafUuid: 'anon-7', sessionId: 'anon' },
    { type: 'ai-title', title: 'anonymized', sessionId: 'anon' },
    { type: 'user', timestamp: iso(60000), message: { role: 'user', content: 'anonymized follow-up' }, promptSource: 'typed', sessionId: 'anon', uuid: 'anon-10', isSidechain: false },
    { type: 'assistant', timestamp: iso(63000), message: { role: 'assistant', content: [{ type: 'text', text: 'anon' }] }, sessionId: 'anon', uuid: 'anon-11' },
  ];
  const claudePath = join(dir, 'real-claude-anon.jsonl');
  writeFileSync(claudePath, `${claudeLines.map((e) => JSON.stringify(e)).join('\n')}\n`);
  const realClaude = runMetrics([claudePath]);
  assertion('mc-real-claude-exit0-invariant', realClaude.status === 0 && invariantHolds(s0(realClaude)), { exit: realClaude.status });
  assertion('mc-real-claude-clean-quality', s0(realClaude).quality.unknownEvents === 0 && s0(realClaude).quality.skippedLines === 0, { q: realClaude.json && s0(realClaude).quality });
  // turn_duration(13100) から次プロンプト(60000) までが turn 外 userWait（46900）、境界前 100ms は turn 内 LLM 生成。
  // 窓 [0,13100] 内の active は durationMs と一致（実 transcript 構成での窓限定検算のゼロ乖離）。
  assertion('mc-real-claude-userwait-and-methodops', s0(realClaude).userWaitMs === 46900 && s0(realClaude).breakdown.methodOpsMs === 4000, { uw: realClaude.json && s0(realClaude).userWaitMs, m: realClaude.json && s0(realClaude).breakdown.methodOpsMs });
  assertion('mc-real-claude-turnwindow-zero-deviation', s0(realClaude).turnWindowActiveMs === s0(realClaude).turnDurationCheckMs && s0(realClaude).turnDurationCheckMs === 13100, { twa: realClaude.json && s0(realClaude).turnWindowActiveMs, tdc: realClaude.json && s0(realClaude).turnDurationCheckMs });

  // Codex: session_meta・turn_context・response_item(reasoning/message/function_call 対)・event_msg(task 境界・
  // mcp_tool_call_end・token_count)・world_state を保持した匿名抜粋。
  const codexLines = [
    { type: 'session_meta', timestamp: iso(0), payload: { id: 'anon', cwd: '/anon/repo', source: 'cli', originator: 'cli', cli_version: 'anon' } },
    { type: 'turn_context', timestamp: iso(100), payload: { type: 'turn_context', cwd: '/anon/repo' } },
    { type: 'event_msg', timestamp: iso(500), payload: { type: 'task_started', started_at: iso(500) } },
    { type: 'response_item', timestamp: iso(1000), payload: { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'redacted' }] } },
    { type: 'response_item', timestamp: iso(2000), payload: { type: 'function_call', call_id: 'anon-c1', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'cat /anon/repo/file.txt'] }) } },
    { type: 'response_item', timestamp: iso(4000), payload: { type: 'function_call_output', call_id: 'anon-c1' } },
    { type: 'event_msg', timestamp: iso(4500), payload: { type: 'mcp_tool_call_begin', call_id: 'anon-m1' } },
    { type: 'event_msg', timestamp: iso(6000), payload: { type: 'mcp_tool_call_end', call_id: 'anon-m1', duration: { secs: 1, nanos: 500000000 }, invocation: { server: 'anon', tool: 'anon' } } },
    { type: 'response_item', timestamp: iso(6500), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'anon' }] } },
    { type: 'event_msg', timestamp: iso(7000), payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 12345, input_tokens: 10000, output_tokens: 2345 } } } },
    { type: 'event_msg', timestamp: iso(7500), payload: { type: 'task_complete', duration_ms: 7000, completed_at: iso(7500) } },
    { type: 'world_state', timestamp: iso(8000), payload: { type: 'world_state' } },
    { type: 'event_msg', timestamp: iso(60000), payload: { type: 'task_started', started_at: iso(60000) } },
    { type: 'event_msg', timestamp: iso(62000), payload: { type: 'task_complete', duration_ms: 2000, completed_at: iso(62000) } },
  ];
  const codexPath = join(dir, 'real-codex-anon.jsonl');
  writeFileSync(codexPath, `${codexLines.map((e) => JSON.stringify(e)).join('\n')}\n`);
  const realCodex = runMetrics([codexPath]);
  assertion('mc-real-codex-exit0-invariant', realCodex.status === 0 && invariantHolds(s0(realCodex)), { exit: realCodex.status });
  assertion('mc-real-codex-clean-quality', s0(realCodex).quality.unknownEvents === 0 && s0(realCodex).quality.skippedLines === 0, { q: realCodex.json && s0(realCodex).quality });
  assertion('mc-real-codex-durationcheck-mcp-token', s0(realCodex).durationCheckMs === 9000 && s0(realCodex).mcpDurationMs === 1500 && s0(realCodex).tokens.total_tokens === 12345, { dc: realCodex.json && s0(realCodex).durationCheckMs, mcp: realCodex.json && s0(realCodex).mcpDurationMs });

  // ログ世代交代で追加された Codex イベント種別（tool_search_call/output・web_search_call/end・agent_reasoning・
  // thread_rolled_back・image_generation_end・compacted・inter_agent_communication_metadata。2026-07-24 実ログ由来の
  // 種別構成）が unknownEvents を汚染せず、不変式と閉じた turn 窓検算が成立することを固定する。
  const newKinds = [
    { type: 'session_meta', timestamp: iso(0), payload: { id: 'anon', cwd: '/anon/repo', source: 'cli' } },
    { type: 'event_msg', timestamp: iso(500), payload: { type: 'task_started', started_at: iso(500) } },
    { type: 'response_item', timestamp: iso(1000), payload: { type: 'tool_search_call', id: 'tsc_anon1', call_id: 'call_anon1', status: 'completed' } },
    { type: 'response_item', timestamp: iso(1500), payload: { type: 'tool_search_output', call_id: 'call_anon1', status: 'completed' } },
    { type: 'event_msg', timestamp: iso(2000), payload: { type: 'agent_reasoning', text: 'anon' } },
    { type: 'response_item', timestamp: iso(2500), payload: { type: 'web_search_call', id: 'ws_anon1', status: 'completed' } },
    { type: 'event_msg', timestamp: iso(3000), payload: { type: 'web_search_end', call_id: 'ws_anon1', query: 'anon' } },
    { type: 'inter_agent_communication_metadata', timestamp: iso(3500), payload: { sender: 'anon' } },
    { type: 'event_msg', timestamp: iso(4000), payload: { type: 'thread_rolled_back', num_turns: 1 } },
    { type: 'event_msg', timestamp: iso(4500), payload: { type: 'image_generation_end', call_id: 'anon-img1' } },
    { type: 'compacted', timestamp: iso(5000), payload: {} },
    { type: 'event_msg', timestamp: iso(6000), payload: { type: 'task_complete', duration_ms: 5500, completed_at: iso(6000) } },
  ];
  const newKindsPath = join(dir, 'codex-new-event-kinds.jsonl');
  writeFileSync(newKindsPath, `${newKinds.map((e) => JSON.stringify(e)).join('\n')}\n`);
  const newKindsRun = runMetrics([newKindsPath]);
  assertion('mc-codex-new-kinds-clean-quality', newKindsRun.status === 0 && s0(newKindsRun).quality.unknownEvents === 0, { q: newKindsRun.json && s0(newKindsRun).quality });
  assertion('mc-codex-new-kinds-invariant', invariantHolds(s0(newKindsRun)));
  assertion('mc-codex-new-kinds-turnwindow', s0(newKindsRun).turnWindowActiveMs === 5500 && s0(newKindsRun).turnWindowCheckMs === 5500, { twa: newKindsRun.json && s0(newKindsRun).turnWindowActiveMs, twc: newKindsRun.json && s0(newKindsRun).turnWindowCheckMs });
  // tool_search_call→output（1000→1500）と web_search_call→end（2500→3000）は pending 追跡され
  // toolExecutionMs へ帰属する（llmGeneration への誤帰属だと 1000/4500 の配分が崩れて検知される）。
  assertion('mc-codex-new-kinds-tool-attribution', s0(newKindsRun).breakdown.toolExecutionMs === 1000 && s0(newKindsRun).breakdown.llmGenerationMs === 4500 && s0(newKindsRun).quality.orphanToolUses === 0, { bd: newKindsRun.json && s0(newKindsRun).breakdown, o: newKindsRun.json && s0(newKindsRun).quality.orphanToolUses });
}

function main() {
  mkdirSync(runsRoot, { recursive: true }); mkdirSync(logsRoot, { recursive: true });
  evidenceReadinessFixtures(); packageFixtures(); evidencePairRequirementFixtures(); manifestIntegrityFixtures(); resolverFixtures(); toolingFixtures(); detailedToolingFixtures(); waitUsageFixtures(); ledgerFixtures();
  reviewRuntimeStaticFixtures(); reviewParserFixtures(); fingerprintFixtures(); methodStatsFixtures(); sessionMetricsFixtures(); concurrentHarnessFixtures(); sharedClauseFixtures();
  const summary = { generated_at: new Date().toISOString(), total: results.length, passed: results.filter(({ passed }) => passed).length, failed: results.filter(({ passed }) => !passed).length, results };
  writeFileSync(join(workRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ total: summary.total, passed: summary.passed, failed: summary.failed, summary: join(workRoot, 'summary.json') })}\n`);
}

main();
