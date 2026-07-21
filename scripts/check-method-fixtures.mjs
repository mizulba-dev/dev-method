#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workRoot = join(repoRoot, '.work/2026-07-21-3-evidence-carrying-direction/method-fixtures');
const runsRoot = join(workRoot, 'runs');
const logsRoot = join(workRoot, 'logs');
const sourceChecker = join(repoRoot, 'src/plugin/skills/direction/references/check-evidence-package.mjs');
const reviewLogChecker = join(repoRoot, 'src/plugin/skills/cross-review/references/check-review-log.mjs');
const methodStats = join(repoRoot, 'scripts/method-stats.mjs');
const results = [];

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
  for (const [relativePath, body] of Object.entries(files)) {
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
  copyFileSync(join(repoRoot, 'src/plugin/skills/cross-review/references/review-diff-fingerprint.mjs'), join(distributionCross, 'review-diff-fingerprint.mjs'));
  const isolatedReview = join(distribution.root, '.work/isolated-unit');
  expect('ev04-isolated-distribution-bootstrap', process.execPath, [join(distributionDirection, 'check-evidence-package.mjs'), 'bootstrap', '--review-dir', isolatedReview], distribution.root, 0);
  const isolatedTooling = JSON.parse(readFileSync(join(isolatedReview, 'evidence/tooling/tooling-manifest.json')));
  assertion('ev04-fixed-minimal-header', isolatedTooling.format_version === 1 && /^[0-9a-f-]{36}$/i.test(isolatedTooling.review_unit_id));
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
    ['review-ledger', [revokedModes.fixed, 'review-ledger', '--review-dir', revokedModes.reviewDir, '--direction', revokedModes.directionPath, '--phase', 'plan', '--events', join(revokedModes.reviewDir, 'events.jsonl'), '--execution-point', 'results-received']],
  ];
  for (const [mode, command] of commands) expect(`ev04-revoked-block-${mode}`, process.execPath, command, revokedModes.root, 1, 'revoked_review_unit');
}

function rawFingerprint(fx) {
  writeFileSync(join(fx.root, '.git/info/exclude'), `/.work/${fx.reviewDir.split('/').at(-1)}/\n`);
  const result = run(process.execPath, [fx.tooling.files.fingerprint.path, fx.root], fx.root);
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function ledgerMaterial(fx, phase, options = {}) {
  const directionHash = sha(fx.directionPath); const diff = rawFingerprint(fx);
  const material = join(fx.reviewDir, 'evidence/ledger'); mkdirSync(material, { recursive: true });
  const events = [];
  const reviewers = phase === 'code' ? ['pre', 'cross'] : ['plan'];
  for (const reviewer of reviewers) {
    const prompt = join(material, `${reviewer}-prompt.md`); const resultPath = join(material, `${reviewer}-result.md`);
    writeFileSync(prompt, `prompt ${reviewer}`); writeFileSync(resultPath, `result ${reviewer}`);
    const promptHash = sha(prompt);
    events.push({ event: 'review_prompt', phase, review_unit_id: options.oldUnit ? '00000000-0000-4000-8000-000000000000' : fx.tooling.review_unit_id, direction_hash: directionHash, diff_fingerprint: options.badFingerprint && reviewer === 'cross' ? '1'.repeat(64) : diff, reviewer, round: 1, session_id: `${reviewer}-session`, prompt_path: prompt, prompt_hash: promptHash });
    if (!(options.missingResult && reviewer === 'cross')) {
      const value = { event: 'review_result', phase, review_unit_id: options.oldUnit ? '00000000-0000-4000-8000-000000000000' : fx.tooling.review_unit_id, direction_hash: directionHash, diff_fingerprint: options.badFingerprint && reviewer === 'cross' ? '1'.repeat(64) : diff, reviewer, round: 1, session_id: `${reviewer}-session`, prompt_hash: promptHash, result_path: resultPath, result_hash: sha(resultPath), must_fix: options.findings && reviewer === reviewers[0] ? ['fix'] : [], should_fix: [], nit: [], readonly_violations: [] };
      if (options.missingReadonly && reviewer === reviewers[0]) delete value.readonly_violations;
      if (!options.missingVerdict || reviewer !== reviewers[0]) value.verdict = options.invalidVerdict && reviewer === reviewers[0] ? 'maybe' : options.findings && reviewer === reviewers[0] ? 'needs-attention' : 'approve';
      events.push(value);
    }
  }
  const path = join(material, 'events.jsonl'); writeFileSync(path, `${events.map(JSON.stringify).join('\n')}\n`); return path;
}

function ledgerCase(name, phase, options, expectedExit, diagnostic) {
  const fx = initRepo(name);
  const events = ledgerMaterial(fx, phase, options);
  if (options.staleDiff) writeFileSync(join(fx.root, 'target.txt'), 'changed after approval\n');
  expect(name, process.execPath, [fx.fixed, 'review-ledger', '--phase', phase, '--review-dir', fx.reviewDir, '--direction', fx.directionPath, '--events', events, '--execution-point', 'results-received'], fx.root, expectedExit, diagnostic);
  if (expectedExit === 0) {
    const finalPoint = phase === 'plan' ? 'before-agreement' : 'before-completion';
    expect(`${name}-final`, process.execPath, [fx.fixed, 'review-ledger', '--phase', phase, '--review-dir', fx.reviewDir, '--direction', fx.directionPath, '--events', events, '--execution-point', finalPoint], fx.root, 0, null, ['"eligibility_token"']);
  }
}

function appendLedgerRound(fx, eventsPath, phase, round) {
  const directionHash = sha(fx.directionPath); const diff = rawFingerprint(fx);
  const reviewers = phase === 'code' ? ['pre', 'cross'] : ['plan']; const additions = [];
  for (const reviewer of reviewers) {
    const prompt = join(fx.reviewDir, `evidence/ledger/${reviewer}-prompt-${round}.md`); const resultPath = join(fx.reviewDir, `evidence/ledger/${reviewer}-result-${round}.md`);
    writeFileSync(prompt, `prompt ${reviewer} ${round}`); writeFileSync(resultPath, `result ${reviewer} ${round}`); const promptHash = sha(prompt);
    additions.push({ event: 'review_prompt', phase, review_unit_id: fx.tooling.review_unit_id, direction_hash: directionHash, diff_fingerprint: diff, reviewer, round, session_id: `${reviewer}-session`, prompt_path: prompt, prompt_hash: promptHash });
    additions.push({ event: 'review_result', phase, review_unit_id: fx.tooling.review_unit_id, direction_hash: directionHash, diff_fingerprint: diff, reviewer, round, session_id: `${reviewer}-session`, prompt_hash: promptHash, result_path: resultPath, result_hash: sha(resultPath), must_fix: [], should_fix: [], nit: [], readonly_violations: [], verdict: 'approve' });
  }
  writeFileSync(eventsPath, `${additions.map(JSON.stringify).join('\n')}\n`, { flag: 'a' });
}

function ledgerFixtures() {
  ledgerCase('pl01-normal', 'plan', {}, 0);
  ledgerCase('pl01-findings', 'plan', { findings: true }, 2, 'review_attention_required');
  ledgerCase('pl01-old-unit', 'plan', { oldUnit: true }, 1, 'ledger_review_unit_mismatch');
  const stale = initRepo('pl01-stale'); const events = ledgerMaterial(stale, 'plan');
  expect('pl01-stale-first', process.execPath, [stale.fixed, 'review-ledger', '--phase', 'plan', '--review-dir', stale.reviewDir, '--direction', stale.directionPath, '--events', events, '--execution-point', 'results-received'], stale.root, 0);
  writeFileSync(stale.directionPath, `${readFileSync(stale.directionPath, 'utf8')}\nchanged\n`);
  expect('pl01-stale', process.execPath, [stale.fixed, 'review-ledger', '--phase', 'plan', '--review-dir', stale.reviewDir, '--direction', stale.directionPath, '--events', events, '--execution-point', 'before-agreement'], stale.root, 2, 'stale_approved_plan');
  appendLedgerRound(stale, events, 'plan', 2);
  expect('pl01-r2-updated-direction-same-session', process.execPath, [stale.fixed, 'review-ledger', '--phase', 'plan', '--review-dir', stale.reviewDir, '--direction', stale.directionPath, '--events', events, '--execution-point', 'results-received'], stale.root, 0);
  expect('pl01-r2-final-token', process.execPath, [stale.fixed, 'review-ledger', '--phase', 'plan', '--review-dir', stale.reviewDir, '--direction', stale.directionPath, '--events', events, '--execution-point', 'before-agreement'], stale.root, 0, null, ['ledger plan 結果受領2/2・合意直前2/2・stale1・eligible=true']);
  ledgerCase('pl01-readonly-audit-missing', 'plan', { missingReadonly: true }, 1, 'ledger_result_invalid');
  ledgerCase('rv02-normal', 'code', {}, 0);
  ledgerCase('rv02-findings', 'code', { findings: true }, 2, 'review_attention_required');
  ledgerCase('rv02-verdict-missing', 'code', { missingVerdict: true }, 2, 'verdict_missing');
  ledgerCase('rv02-verdict-missing-findings', 'code', { missingVerdict: true, findings: true }, 2, 'review_attention_required');
  ledgerCase('rv02-stale-diff', 'code', { staleDiff: true }, 2, 'stale_approved_diff');
  ledgerCase('rv02-round-fingerprint', 'code', { badFingerprint: true }, 1, 'ledger_round_mismatch');
  ledgerCase('rv02-invalid-verdict', 'code', { invalidVerdict: true }, 1, 'ledger_verdict_inconsistent');
  ledgerCase('rv02-result-missing', 'code', { missingResult: true }, 1, 'ledger_reviewer_missing');
  ledgerCase('rv02-old-unit', 'code', { oldUnit: true }, 1, 'ledger_review_unit_mismatch');
  const duplicateInvocation = initRepo('rv02-duplicate-invocation'); const duplicateEvents = ledgerMaterial(duplicateInvocation, 'code');
  const duplicateHash = sha(duplicateInvocation.directionPath); const duplicateDiff = rawFingerprint(duplicateInvocation);
  const duplicateCheck = { event: 'review_ledger_check', phase: 'code', execution_point: 'results-received', invocation_id: '11111111-1111-4111-8111-111111111111', review_unit_id: duplicateInvocation.tooling.review_unit_id, direction_hash: duplicateHash, diff_fingerprint: duplicateDiff, checked_at: '2026-07-21T00:00:00Z' };
  writeFileSync(duplicateEvents, `${JSON.stringify(duplicateCheck)}\n${JSON.stringify(duplicateCheck)}\n`, { flag: 'a' });
  expect('rv02-duplicate-invocation', process.execPath, [duplicateInvocation.fixed, 'review-ledger', '--phase', 'code', '--review-dir', duplicateInvocation.reviewDir, '--direction', duplicateInvocation.directionPath, '--events', duplicateEvents, '--execution-point', 'results-received'], duplicateInvocation.root, 1, 'ledger_invocation_invalid');
}

function reviewRuntimeStaticFixtures() {
  const claude = readFileSync(join(repoRoot, 'src/plugin-claude/skills/team-impl/SKILL.md'), 'utf8');
  const codex = readFileSync(join(repoRoot, 'src/plugin-codex/skills/team-impl/SKILL.md'), 'utf8');
  const cross = readFileSync(join(repoRoot, 'src/plugin/skills/cross-review/SKILL.md'), 'utf8');
  const direction = readFileSync(join(repoRoot, 'src/plugin/skills/direction/SKILL.md'), 'utf8');
  const validator = (text) => text.includes('verify --review-dir') && text.includes('reviewer の spawn') && text.includes('source checker') && text.includes('単独起動する cross-review');
  assertion('rv01-claude-gate', validator(claude)); assertion('rv01-codex-gate', validator(codex));
  assertion('rv01-ask-gate-drift', !validator(claude.replace('verify --review-dir', 'verify-disabled')));
  assertion('rv01-standalone-backward-compatible', cross.includes('standalone') && cross.includes('Ask では') && !cross.includes('standalone では tooling manifest'));
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
}

function newFooter({ plan = 'レビュー計画1R・21分（R1 must0+should0+nit0）', code = 'レビューコード1R・23分（R1 pre must0+should0；cross must0+should0；固有 pre0+cross0；重複0）', planLedger = 'ledger plan 結果受領1/1・合意直前1/1・stale0・eligible=true', codeLedger = 'ledger code 両結果受領1/1・完了直前1/1・stale0・eligible=true', planOutcome = 'R1 plan approved', codeOutcome = 'R1 code approved', e2e = 'E2E 44分', prep = 'Evidence Package 準備2分（開始10:00・終了10:02；テスト5分）', classification = '4分類 plan-escape0+implementation-deviation0+evidence-gap0+new-risk0' } = {}) {
  return `実測: レーンAsk / 担当fixture / ${plan} / ${code} / ${planLedger} / ${codeLedger} / ${planOutcome} / ${codeOutcome} / ${e2e} / ${prep} / ${classification} / 差し戻し0 / リーダー直修正0 / 追補0（契約0） / smoke 対象外 / 逸脱: なし`;
}

function methodStatsFixtures() {
  const home = join(runsRoot, 'ob01-home'); rmSync(home, { recursive: true, force: true });
  const directionDir = join(home, 'dev-notes/project/direction'); mkdirSync(directionDir, { recursive: true });
  const rows = [
    newFooter(),
    newFooter({ plan: 'レビュー計画2R・25分（R1 must0+should0+nit0）', planLedger: 'ledger plan 結果受領2/2・合意直前2/2・stale1・eligible=true', planOutcome: 'R1 plan stale_approved_plan', e2e: 'E2E 48分' }),
    newFooter({ plan: 'レビュー計画2R・25分（R1 must1+should0+nit0）', code: 'レビューコード2R・26分（R1 pre must1+should0；cross must0+should0；固有 pre1+cross0；重複0）', planLedger: 'ledger plan 結果受領2/2・合意直前1/1・stale0・eligible=true', codeLedger: 'ledger code 両結果受領2/2・完了直前1/1・stale0・eligible=true', planOutcome: 'R1 plan findings', codeOutcome: 'R1 code findings', e2e: 'E2E 51分', classification: '4分類 plan-escape1+implementation-deviation0+evidence-gap0+new-risk0' }),
    newFooter({ planLedger: 'ledger plan 結果受領0/1・合意直前1/1・stale0・eligible=true' }),
    newFooter({ e2e: 'E2E 99分' }),
    newFooter({ prep: 'Evidence Package 準備3分（開始10:00・終了10:02；テスト5分）' }),
    newFooter({ classification: '4分類 broken' }),
    newFooter({ classification: '4分類 plan-escape1+implementation-deviation1+evidence-gap0+new-risk0' }),
    '実測: レーンAsk / 担当x / レビュー並列1R・10分（R1 pre must0+should0；cross must0+should0；固有 pre0+cross0；重複0） / 差し戻し0 / リーダー直修正0 / 追補0（契約0） / smoke 対象外 / 逸脱: なし',
  ];
  rows.forEach((row, index) => writeFileSync(join(directionDir, `2026-07-${String(index + 1).padStart(2, '0')}-fixture.md`), `${row}\n`));
  const result = run(process.execPath, [methodStats], repoRoot, { ...process.env, HOME: home });
  const combined = `${result.stdout}\n${result.stderr}`;
  const expected = ['Evidence新形式件数: 8', 'dogfood適格件数: 7', 'plan R1承認率（dogfood適格のみ）: 5/7 (71.4%)', 'code R1承認率（dogfood適格のみ）: 6/7 (85.7%)', 'plan平均レビュー分: 22.0', 'code平均レビュー分: 23.4', 'E2E平均分: 45.6', 'Evidence Package準備平均分（テスト時間は含めない）: 2.0', 'R1 4分類合計（plan-escape / implementation-deviation / evidence-gap / new-risk）: 1 / 0 / 0 / 0', 'plan ledgerの観測数/期待数/stale/eligibleが内部不一致', 'E2E時間がplan+codeと不整合', 'Evidence Package準備時間が開始・終了との差分と不整合', '4分類文法外', '4分類合計がcode R1固有/重複合計と不整合', '並列Ask件数（旧形式）: 1'];
  const passed = result.status === 0 && expected.every((value) => combined.includes(value));
  writeFileSync(join(logsRoot, 'ob01-method-stats.log'), combined);
  assertion('ob01-method-stats-new-old-and-drifts', passed, { exit: result.status, missing: expected.filter((value) => !combined.includes(value)) });
  const emptyHome = join(runsRoot, 'ob01-empty-home'); rmSync(emptyHome, { recursive: true, force: true }); mkdirSync(emptyHome, { recursive: true });
  const empty = run(process.execPath, [methodStats], repoRoot, { ...process.env, HOME: emptyHome });
  assertion('ob01-dev-notes-missing', empty.status === 0 && empty.stdout.includes('~/dev-notes 不在'));
}

function sharedClauseFixtures() {
  expect('ob02-shared-normal-and-all-drifts', process.execPath, [join(repoRoot, 'scripts/check-shared-clauses.mjs'), '--self-test'], repoRoot, 0, null, ['deliberate drifts detected']);
}

function main() {
  rmSync(workRoot, { recursive: true, force: true }); mkdirSync(runsRoot, { recursive: true }); mkdirSync(logsRoot, { recursive: true });
  evidenceReadinessFixtures(); packageFixtures(); manifestIntegrityFixtures(); resolverFixtures(); toolingFixtures(); detailedToolingFixtures(); ledgerFixtures();
  reviewRuntimeStaticFixtures(); reviewParserFixtures(); methodStatsFixtures(); sharedClauseFixtures();
  const summary = { generated_at: new Date().toISOString(), total: results.length, passed: results.filter(({ passed }) => passed).length, failed: results.filter(({ passed }) => !passed).length, results };
  writeFileSync(join(workRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ total: summary.total, passed: summary.passed, failed: summary.failed, summary: join(workRoot, 'summary.json') })}\n`);
}

main();
