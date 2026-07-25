import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const devNotesDir = join(homedir(), 'dev-notes');
const frictionPath = join(devNotesDir, 'dev-method', 'friction.md');
const FOOTER_LINE = /^[-*]?\s*実測:\s*(.+)$/;
const FIELD_SPLIT = /\s*\/\s*(?=(?:担当|レビュー|ledger |R\d+ |E2E |実働|Evidence Package|4分類|差し戻し|リーダー直修正|追補\d|QA\s|smoke\s|逸脱:))/;
const QA_GRAMMAR = /^(PASS|FAIL \d+件|BLOCKED|SKIPPED|未実施)$/;
const SMOKE_GRAMMAR = /^(PASS|FAIL \d+件|評価不能|対象外|未整備)$/;
const PARALLEL_REVIEW_GRAMMAR = /^レビュー並列(\d+)R・(\d+)分（R1 pre must(\d+)\+should(\d+)；cross must(\d+)\+should(\d+)；固有 pre(\d+)\+cross(\d+)；重複(\d+)）$/;
// 分値の「約」接頭・R2以降のラウンド別内訳・0R（省略注記）・境界別内訳（N境界×各MR、／区切り）・対象外/eligibleの括弧注記は
// 実フッターで反復した表記のため文法として受理する。数値は R1（境界別は全境界の合算）だけを集計に使う。
const PLAN_REVIEW_GRAMMAR = /^レビュー計画(\d+)R・約?(\d+)分（R1 must(\d+)\+should(\d+)\+nit(\d+)((?:；R\d+ must\d+\+should\d+\+nit\d+)*)）$/;
// 0R（レビュー省略）は理由の括弧注記を必須とする専用文法だけで受理する。通常文法の rounds=0 は文法外（0R・5分（R1…）等の迂回を塞ぐ）。
const PLAN_REVIEW_ZERO = /^レビュー計画0R(?:・約?0分)?（[^）]+）$/;
const CODE_BOUNDARY_BLOCK = /^(?:\S+ )?R1 pre must(\d+)\+should(\d+)；cross must(\d+)\+should(\d+)；固有 pre(\d+)\+cross(\d+)；重複(\d+)$/;
const CODE_REVIEW_GRAMMAR = /^レビューコード(\d+)R・約?(\d+)分（((?:\S+ )?R1 pre must\d+\+should\d+；cross must\d+\+should\d+；固有 pre\d+\+cross\d+；重複\d+)）$/;
const CODE_REVIEW_MULTI_GRAMMAR = /^レビューコード(\d+)境界×各(\d+)R・約?(\d+)分（(.+)）$/;
const CODE_REVIEW_ZERO = /^レビューコード0R(?:・約?0分)?（[^）]+）$/;
const PLAN_LEDGER_GRAMMAR = /^ledger plan 結果受領(\d+)\/(\d+)・合意直前(\d+)\/(\d+)・stale(\d+)・eligible=(true|false)(?:（([^）]+)）)?$/;
const CODE_LEDGER_GRAMMAR = /^ledger code 両結果受領(\d+)\/(\d+)・完了直前(\d+)\/(\d+)・stale(\d+)・eligible=(true|false)(?:（([^）]+)）)?$/;
const OUTCOME_GRAMMAR = {
  plan: new Set(['approved', 'findings', 'stale_approved_plan', 'needs-attention', '対象外']),
  code: new Set(['approved', 'findings', 'verdict_missing', 'stale_approved_diff', 'needs-attention', '対象外']),
};
const CLASSIFICATION_GRAMMAR = /^4分類 plan-escape(\d+)\+implementation-deviation(\d+)\+evidence-gap(\d+)\+new-risk(\d+)$/;
// 4レーン: Evidence 型フッターは Sign / Seal（旧 Ask を Seal 系譜として読む）。Seal 系譜だけが ledger を持ち dogfood 適格。
// Sign は ledger 欄・Evidence 欄を「対象外」と記載し、それらの検証を警告なしでスキップする。
const EVIDENCE_LANES = new Set(['Ask', 'Sign', 'Seal']);
const SEAL_LINEAGE = new Set(['Ask', 'Seal']);

function listDirectionFiles() {
  const files = [];
  if (!existsSync(devNotesDir)) return files;
  for (const project of readdirSync(devNotesDir)) {
    const directionDir = join(devNotesDir, project, 'direction');
    if (!existsSync(directionDir) || !statSync(directionDir).isDirectory()) continue;
    for (const name of readdirSync(directionDir)) {
      if (name.endsWith('.md')) files.push({ project, name, path: join(directionDir, name) });
    }
  }
  return files;
}

function newRow() {
  return {
    lane: null, roundCount: null, reviewMode: '旧形式', reviewMinutes: null, r1: null,
    preMust: null, preShould: null, crossMust: null, crossShould: null,
    uniquePre: null, uniqueCross: null, duplicate: null, parallelValid: false, parallelEligible: false,
    reverts: null, directFixes: null, addenda: null, addendaContracts: null, qa: null, smoke: null,
    deviation: null, newFormat: false, plan: {}, code: {}, e2eMinutes: null,
    actualMinutes: null, methodOpsMinutes: null, actualInvalid: false, actualEligible: false,
    evidencePrepMinutes: null, evidencePrepStart: null, evidencePrepEnd: null, evidenceTestMinutes: null, classification: null,
  };
}

function parseLedger(seg, phase, row, warnings) {
  const grammar = phase === 'plan' ? PLAN_LEDGER_GRAMMAR : CODE_LEDGER_GRAMMAR;
  const match = seg.match(grammar);
  if (!match) {
    warnings.push(`${phase} ledger文法外`);
    row[phase].ledgerInvalid = true;
    return;
  }
  const [received, receivedExpected, final, finalExpected, stale] = match.slice(1, 6).map(Number);
  row[phase].ledger = { received, receivedExpected, final, finalExpected, stale, eligible: match[6] === 'true', note: match[7] ?? null };
}

function validateLedger(phase, row, warnings) {
  const ledger = row[phase].ledger;
  if (!ledger) {
    warnings.push(`${phase} ledger欠落`);
    return false;
  }
  const expectedFinal = ledger.stale + 1;
  const countsMatch = ledger.received === ledger.receivedExpected && ledger.final === ledger.finalExpected;
  // eligible=false は帳簿数が揃っていても、注記で理由（backstop 到達・ユーザー判断継続等）が明記されていれば受理する。
  const eligibleConsistent = ledger.eligible === countsMatch || (!ledger.eligible && countsMatch && ledger.note != null);
  const valid = ledger.receivedExpected === row[phase].rounds
    && ledger.finalExpected === expectedFinal
    && eligibleConsistent;
  if (!valid) {
    warnings.push(`${phase} ledgerの観測数/期待数/stale/eligibleが内部不一致`);
  }
  return valid && ledger.eligible;
}

function validateOutcome(phase, row, warnings) {
  const { outcome, rounds } = row[phase];
  const findings = phase === 'plan'
    ? (row.plan.must ?? 0) + (row.plan.should ?? 0) + (row.plan.nit ?? 0)
    : (row.code.preMust ?? 0) + (row.code.preShould ?? 0) + (row.code.crossMust ?? 0) + (row.code.crossShould ?? 0);
  // 0R（レビュー省略）の phase は outcome 省略または「対象外」だけを受理し、承認判定の対象外とする。
  if (rounds === 0) {
    if (outcome != null && outcome !== '対象外') warnings.push(`${phase} 0Rとoutcomeが矛盾`);
    return false;
  }
  if (!OUTCOME_GRAMMAR[phase].has(outcome)) {
    warnings.push(`${phase} R1 outcome欠落または文法外`);
    return false;
  }
  if (outcome === '対象外') {
    warnings.push(`${phase} 対象外outcomeとラウンド数が矛盾`);
    return false;
  }
  if (rounds == null || rounds < 1) {
    warnings.push(`${phase} ラウンド数欠落または0以下`);
    return false;
  }
  // outcome のラウンド番号は R1（従来固定形）か最終ラウンドのどちらか。それ以外は宣言ラウンドとの照合不能として不成立。
  const { outcomeRound } = row[phase];
  if (outcomeRound != null && outcomeRound !== 1 && outcomeRound !== rounds) {
    warnings.push(`${phase} outcomeのラウンド番号がラウンド数と不一致`);
    return false;
  }
  // needs-attention は指摘残存または未収束のユーザー判断終了。R1 件数からは閉包状態を検証できないため件数整合は課さず、
  // 有効な非承認 outcome として承認率の分母に含める。
  if (outcome === 'needs-attention') return true;
  if (outcome === 'approved' && (findings !== 0 || rounds !== 1)) {
    warnings.push(`${phase} approvedとラウンド数/指摘数が矛盾`);
    return false;
  }
  if (outcome === 'findings' && findings === 0) {
    warnings.push(`${phase} findingsとR1指摘数が矛盾`);
    return false;
  }
  if ((outcome === 'stale_approved_plan' || outcome === 'stale_approved_diff') && (findings !== 0 || rounds < 2)) {
    warnings.push(`${phase} stale outcomeとラウンド数/指摘数が矛盾`);
    return false;
  }
  if (outcome === 'verdict_missing' && (findings !== 0 || rounds < 2)) {
    warnings.push('code verdict_missingとラウンド数/指摘数が矛盾');
    return false;
  }
  return true;
}

function validateCodeBreakdown(row, warnings) {
  const { preMust, preShould, crossMust, crossShould, uniquePre, uniqueCross, duplicate } = row.code;
  if ([preMust, preShould, crossMust, crossShould, uniquePre, uniqueCross, duplicate].some((value) => value == null)) {
    warnings.push('code R1 pre/cross内訳または固有/重複欠落');
    return false;
  }
  // 境界別内訳は各境界単位で整合を検査済み（合算では境界間の過不足が相殺され得るため合算検査で代用しない）。
  const valid = row.code.boundaries != null
    ? !row.code.blockInconsistent
    : uniquePre + duplicate === preMust + preShould && uniqueCross + duplicate === crossMust + crossShould;
  if (!valid) warnings.push('code R1 pre/cross内訳と固有/重複が不整合');
  return valid;
}

function parseCodeBoundaryBlocks(inner, row) {
  const blocks = inner.split(/\s*／\s*/);
  if (blocks.length !== row.code.boundaries) return false;
  const totals = [0, 0, 0, 0, 0, 0, 0];
  for (const block of blocks) {
    const m = block.match(CODE_BOUNDARY_BLOCK);
    if (!m) return false;
    const values = m.slice(1).map(Number);
    if (values[4] + values[6] !== values[0] + values[1] || values[5] + values[6] !== values[2] + values[3]) row.code.blockInconsistent = true;
    values.forEach((value, index) => { totals[index] += value; });
  }
  [row.code.preMust, row.code.preShould, row.code.crossMust, row.code.crossShould, row.code.uniquePre, row.code.uniqueCross, row.code.duplicate] = totals;
  return true;
}

export function parseFooter(body) {
  const row = newRow();
  const warnings = [];
  for (const seg of body.split(FIELD_SPLIT).map((s) => s.trim())) {
    let m;
    if ((m = seg.match(/^レーン(\S+)$/))) { row.lane = m[1]; continue; }
    if ((m = seg.match(PLAN_REVIEW_GRAMMAR)) && Number(m[1]) > 0) {
      row.newFormat = true;
      [row.plan.rounds, row.plan.minutes, row.plan.must, row.plan.should, row.plan.nit] = m.slice(1, 6).map(Number);
      // ラウンド別内訳は任意だが、書くなら R2 から宣言ラウンドまでの連番に限る（欠番・重複・番号飛びは不一致）。
      const extraRounds = [...m[6].matchAll(/；R(\d+) /g)].map((x) => Number(x[1]));
      if (extraRounds.length > 0 && (extraRounds.length + 1 !== row.plan.rounds || extraRounds.some((value, index) => value !== index + 2))) {
        warnings.push('計画レビューのラウンド別内訳とラウンド数不一致');
      }
      continue;
    }
    if (PLAN_REVIEW_ZERO.test(seg)) {
      row.newFormat = true;
      [row.plan.rounds, row.plan.minutes, row.plan.must, row.plan.should, row.plan.nit] = [0, 0, 0, 0, 0];
      continue;
    }
    if (/^レビュー計画/.test(seg)) { row.newFormat = true; row.plan.invalid = true; warnings.push('計画レビュー文法外'); continue; }
    if ((m = seg.match(CODE_REVIEW_GRAMMAR)) && Number(m[1]) > 0) {
      row.newFormat = true;
      [row.code.rounds, row.code.minutes] = [Number(m[1]), Number(m[2])];
      [row.code.preMust, row.code.preShould, row.code.crossMust, row.code.crossShould, row.code.uniquePre, row.code.uniqueCross, row.code.duplicate] = m[3].match(CODE_BOUNDARY_BLOCK).slice(1).map(Number);
      continue;
    }
    if ((m = seg.match(CODE_REVIEW_MULTI_GRAMMAR)) && Number(m[1]) > 0 && Number(m[2]) > 0) {
      row.newFormat = true;
      [row.code.boundaries, row.code.rounds, row.code.minutes] = m.slice(1, 4).map(Number);
      if (parseCodeBoundaryBlocks(m[4], row)) continue;
      row.code.invalid = true; warnings.push('コードレビュー文法外'); continue;
    }
    if (CODE_REVIEW_ZERO.test(seg)) {
      row.newFormat = true;
      [row.code.rounds, row.code.minutes, row.code.preMust, row.code.preShould, row.code.crossMust, row.code.crossShould, row.code.uniquePre, row.code.uniqueCross, row.code.duplicate] = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      continue;
    }
    if (/^レビューコード/.test(seg)) { row.newFormat = true; row.code.invalid = true; warnings.push('コードレビュー文法外'); continue; }
    if (/^ledger plan /.test(seg)) { row.newFormat = true; if (seg === 'ledger plan 対象外') row.plan.ledgerNA = true; else parseLedger(seg, 'plan', row, warnings); continue; }
    if (/^ledger code /.test(seg)) { row.newFormat = true; if (seg === 'ledger code 対象外') row.code.ledgerNA = true; else parseLedger(seg, 'code', row, warnings); continue; }
    // outcome の中黒注記は needs-attention だけに許す（approved 等への自由文の付加は outcome 不成立として扱い、欠落警告に落とす）。
    if ((m = seg.match(/^R(\d+) (plan|code) ([^・\s（]+)(・.+|（[^）]*）)?$/))) {
      row.newFormat = true;
      if (m[4]?.startsWith('・') && m[3] !== 'needs-attention') continue;
      row[m[2]].outcomeRound = Number(m[1]); row[m[2]].outcome = m[3]; continue;
    }
    if ((m = seg.match(/^E2E 約?(\d+)分$/))) { row.newFormat = true; row.e2eMinutes = Number(m[1]); continue; }
    if (/^E2E /.test(seg)) { row.newFormat = true; warnings.push('E2E文法外'); continue; }
    // 実働欄はレーン不問（Show 簡易フッターにも載る）。newFormat 判定には関与させない。
    if ((m = seg.match(/^実働(\d+)分（手法運用(\d+)分）$/))) { row.actualMinutes = Number(m[1]); row.methodOpsMinutes = Number(m[2]); continue; }
    if (/^実働/.test(seg)) { row.actualInvalid = true; warnings.push('実働欄文法外'); continue; }
    if (/^Evidence Package 対象外(?:（[^）]*）)?$/.test(seg)) { row.newFormat = true; row.evidenceNA = true; continue; }
    if ((m = seg.match(/^Evidence Package 準備(\d+)分（開始(\d{2}:\d{2})・終了(\d{2}:\d{2})；テスト(\d+)分）$/))) {
      row.newFormat = true;
      row.evidencePrepMinutes = Number(m[1]); row.evidencePrepStart = m[2]; row.evidencePrepEnd = m[3]; row.evidenceTestMinutes = Number(m[4]);
      const toMinutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
      const elapsed = (toMinutes(row.evidencePrepEnd) - toMinutes(row.evidencePrepStart) + 24 * 60) % (24 * 60);
      if (elapsed !== row.evidencePrepMinutes) warnings.push('Evidence Package準備時間が開始・終了との差分と不整合');
      continue;
    }
    if (/^Evidence Package /.test(seg)) { row.newFormat = true; warnings.push('Evidence Package準備時間文法外'); continue; }
    if ((m = seg.match(CLASSIFICATION_GRAMMAR))) { row.newFormat = true; row.classification = m.slice(1).map(Number); continue; }
    if (/^4分類 /.test(seg)) { row.newFormat = true; warnings.push('4分類文法外'); continue; }
    if (/^レビュー並列/.test(seg)) {
      row.reviewMode = '並列';
      const full = seg.match(PARALLEL_REVIEW_GRAMMAR);
      if (full) {
        [row.roundCount, row.reviewMinutes, row.preMust, row.preShould, row.crossMust, row.crossShould, row.uniquePre, row.uniqueCross, row.duplicate] = full.slice(1).map(Number);
        row.parallelValid = true;
      } else {
        if ((m = seg.match(/^レビュー並列(\d+)R/))) row.roundCount = Number(m[1]);
        if ((m = seg.match(/R・(\d+)分/))) row.reviewMinutes = Number(m[1]);
      }
      continue;
    }
    if (/^担当/.test(seg) || /^レビュー/.test(seg)) {
      const rounds = [...seg.matchAll(/(\d+)R\b/g)].map((x) => Number(x[1]));
      if (rounds.length) row.roundCount = (row.roundCount ?? 0) + rounds.reduce((a, b) => a + b, 0);
      if ((m = seg.match(/R1\s*(must\d+\+should\d+(?:\+nit\d+)?)/))) row.r1 = m[1];
      continue;
    }
    if ((m = seg.match(/^差し戻し(\d+)/))) { row.reverts = Number(m[1]); continue; }
    if ((m = seg.match(/^リーダー直修正(\d+)/))) { row.directFixes = Number(m[1]); continue; }
    if ((m = seg.match(/^追補(\d+)（契約(\d+)）/))) { row.addenda = Number(m[1]); row.addendaContracts = Number(m[2]); continue; }
    if ((m = seg.match(/^QA\s+(.+)$/))) { row.qa = m[1]; continue; }
    if ((m = seg.match(/^smoke\s+(.+)$/))) { row.smoke = m[1]; continue; }
    if (/^逸脱:/.test(seg)) { row.deviation = seg.replace(/^逸脱:\s*/, '').trim(); }
  }
  if (row.newFormat) {
    if (row.plan.rounds == null || row.plan.minutes == null) warnings.push('計画レビューのラウンド数または時間欠落');
    if (row.code.rounds == null || row.code.minutes == null) warnings.push('コードレビューのラウンド数または時間欠落');
    if ([row.plan.must, row.plan.should, row.plan.nit].some((value) => value == null)) warnings.push('plan R1 3区分件数欠落');
    if (row.e2eMinutes == null) warnings.push('E2E時間欠落');
    else if (row.plan.minutes != null && row.code.minutes != null && row.e2eMinutes !== row.plan.minutes + row.code.minutes) warnings.push('E2E時間がplan+codeと不整合');
    if (row.evidencePrepMinutes == null && !row.evidenceNA) warnings.push('Evidence Package準備時間欠落');
    row.code.breakdownEligible = validateCodeBreakdown(row, warnings);
    if (!row.classification) warnings.push('4分類欠落');
    // code 0R（レビュー省略）では 4分類の出どころがレビュー指摘に限らない（機械ゲート・帳簿由来）ため、R1 内訳との合計整合は課さない。
    else if (row.code.rounds !== 0 && (!row.code.breakdownEligible || row.classification.reduce((total, value) => total + value, 0) !== row.code.uniquePre + row.code.uniqueCross + row.code.duplicate)) {
      warnings.push('4分類合計がcode R1固有/重複合計と不整合');
      row.classification = null;
    }
    // Sign は ledger を持たない（対象外）。検証・適格判定をスキップし警告しない。Seal 系譜（Ask/Seal）だけが ledger 適格・dogfood 適格。
    row.plan.ledgerEligible = row.plan.ledgerNA ? false : validateLedger('plan', row, warnings);
    row.code.ledgerEligible = row.code.ledgerNA ? false : validateLedger('code', row, warnings);
    row.plan.outcomeEligible = validateOutcome('plan', row, warnings);
    row.code.outcomeEligible = validateOutcome('code', row, warnings);
    row.dogfoodEligible = SEAL_LINEAGE.has(row.lane) && row.plan.ledgerEligible && row.code.ledgerEligible;
    if (!EVIDENCE_LANES.has(row.lane)) warnings.push(`新形式のレーン不一致: ${row.lane ?? '欠落'}（Sign/Seal 必須、旧 Ask は Seal 系譜）`);
  } else {
    // 旧 serial-Seal 形式のみ serial 欄（差し戻し・直修正・追補・R数・R1内訳）を要求する。Show / Ship の簡易フッターは
    // これらを持たないため警告しない（旧形式のまま許容）。
    const serialLane = row.lane !== 'Show' && row.lane !== 'Ship';
    if (serialLane) {
      if (row.roundCount == null) warnings.push('R数を抽出できず');
      if (row.reverts == null) warnings.push('差し戻し数を抽出できず');
      if (row.directFixes == null) warnings.push('リーダー直修正数を抽出できず');
      if (row.addenda == null) warnings.push('追補数を抽出できず');
      if (row.deviation == null) warnings.push('逸脱欄を抽出できず');
    }
    if (row.reviewMode === '並列') {
      if (row.reviewMinutes == null) warnings.push('並列レビュー分欠落');
      if ([row.preMust, row.preShould, row.crossMust, row.crossShould, row.uniquePre, row.uniqueCross, row.duplicate].some((value) => value == null)) warnings.push('並列R1内訳欠落');
      if (!row.parallelValid) warnings.push('並列レビュー文法外（並列集計から除外）');
      if (!SEAL_LINEAGE.has(row.lane)) warnings.push(`並列レビューのレーン不一致: ${row.lane ?? '欠落'}（Ask/Seal 必須、並列集計から除外）`);
      row.parallelEligible = row.parallelValid && SEAL_LINEAGE.has(row.lane);
    } else if (serialLane && !row.r1) warnings.push('R1内訳欠落');
  }
  // 実働欄はレーン不問で有効判定する（Show 簡易フッター含む）。欠測（null かつ非文法外）は警告なし。文法外・制約違反
  // （手法運用>実働）だけ警告して集計から除外する。
  if (row.actualMinutes != null && row.methodOpsMinutes != null && row.methodOpsMinutes > row.actualMinutes) { warnings.push('実働欄の手法運用が実働を超過'); row.actualInvalid = true; }
  row.actualEligible = row.actualMinutes != null && row.methodOpsMinutes != null && !row.actualInvalid;
  if (row.qa != null && !QA_GRAMMAR.test(row.qa)) warnings.push(`QA値が文法外: ${row.qa}`);
  if (row.smoke != null && !SMOKE_GRAMMAR.test(row.smoke)) warnings.push(`smoke値が文法外: ${row.smoke}`);
  if (row.qa != null && row.smoke != null) warnings.push('QA欄とsmoke欄が同一フッターに両方存在');
  if (row.qa == null && row.smoke == null) row.qa = '未実施';
  return { row, warnings };
}

function extractDate(filename) { return filename.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? '(不明)'; }

function collectFooters(files) {
  const rows = []; const parseWarnings = [];
  for (const file of files) {
    let text; try { text = readFileSync(file.path, 'utf8'); } catch { continue; }
    text.split('\n').forEach((line, index) => {
      const footer = line.trim().match(FOOTER_LINE); if (!footer) return;
      const { row, warnings } = parseFooter(footer[1]); const location = `${file.path}:${index + 1}`;
      rows.push({
        日付: extractDate(file.name), プロジェクト: file.project, レーン: row.lane ?? '?', 方式: row.newFormat ? 'Evidence' : row.reviewMode,
        'plan R/分': row.newFormat ? `${row.plan.rounds ?? '?'}/${row.plan.minutes ?? '—'}` : '—',
        'code R/分': row.newFormat ? `${row.code.rounds ?? '?'}/${row.code.minutes ?? '—'}` : '—',
        E2E分: row.e2eMinutes ?? '—', '準備/テスト分': row.evidencePrepMinutes != null ? `${row.evidencePrepMinutes}/${row.evidenceTestMinutes}` : '—',
        'plan R1 outcome': row.plan.outcome ?? '—', 'code R1 outcome': row.code.outcome ?? '—', dogfood: row.newFormat ? (row.dogfoodEligible ? 'eligible' : '除外') : '—',
        R数: row.roundCount ?? '—', レビュー分: row.reviewMinutes ?? '—', 'R1(must/should)': row.r1 ?? '—',
        'R1 pre': row.preMust != null ? `must${row.preMust}+should${row.preShould}` : '—', 'R1 cross': row.crossMust != null ? `must${row.crossMust}+should${row.crossShould}` : '—',
        '固有(pre/cross)': row.uniquePre != null ? `${row.uniquePre}/${row.uniqueCross}` : '—', 重複: row.duplicate ?? '—',
        差し戻し: row.reverts ?? '?', 直修正: row.directFixes ?? '?', '追補(契約)': row.addenda != null ? `${row.addenda}(${row.addendaContracts ?? '?'})` : '?',
        'QA(旧)': row.qa ?? '—', smoke: row.smoke ?? '—', 逸脱有無: row.deviation && row.deviation !== 'なし' ? '有' : '無',
        parallel: row.parallelEligible ? row : null, evidence: row.newFormat ? row : null, parsed: row, location,
      });
      for (const warning of warnings) parseWarnings.push(`パース不完全 ${location}: ${warning}`);
    });
  }
  return { rows, parseWarnings };
}

function countQualityMisses() {
  if (!existsSync(frictionPath)) return { count: 0, exists: false };
  return { count: readFileSync(frictionPath, 'utf8').split('\n').filter((line) => /^-\s*\d{4}-\d{2}-\d{2}/.test(line.trim()) && /品質漏れ/.test(line)).length, exists: true };
}

// 実働欄の集計（純関数）。有効行 = actualEligible（文法適合かつ手法運用 ≦ 実働）。欠測・文法外・制約違反は除外。
// 手法運用比率は重み付き比（手法運用合計 ÷ 実働合計）で行別平均比ではない（セッション長の重みを保つため）。
export function aggregateActual(rows) {
  const eligible = rows.filter((row) => row.actualEligible);
  const actualSum = eligible.reduce((total, row) => total + row.actualMinutes, 0);
  const methodOpsSum = eligible.reduce((total, row) => total + row.methodOpsMinutes, 0);
  return {
    recorded: eligible.length,
    total: rows.length,
    actualSum,
    methodOpsSum,
    average: eligible.length ? actualSum / eligible.length : null,
    ratio: actualSum ? methodOpsSum / actualSum : null,
  };
}

function main() {
  const { rows, parseWarnings } = collectFooters(listDirectionFiles());
  if (rows.length === 0) console.log('実測フッターが見つかりませんでした（~/dev-notes 不在、または対象0件）。');
  else console.table(rows.map(({ location, parallel, evidence, ...rest }) => rest));
  if (parseWarnings.length) { console.log('\n警告:'); for (const warning of parseWarnings) console.log(`- ${warning}`); }
  const sum = (values) => values.reduce((total, value) => total + value, 0);
  const average = (values) => values.length ? (sum(values) / values.length).toFixed(1) : '該当なし';
  const ratio = (n, d) => d ? `${n}/${d} (${((n / d) * 100).toFixed(1)}%)` : '該当なし';
  const parallelRows = rows.filter((row) => row.parallel); const evidenceRows = rows.filter((row) => row.evidence);
  const dogfoodRows = evidenceRows.filter((row) => row.evidence.dogfoodEligible);
  const classifiedRows = evidenceRows.filter((row) => row.evidence.classification);
  const preparedRows = evidenceRows.filter((row) => {
    if (row.evidence.evidencePrepMinutes == null || row.evidence.evidencePrepStart == null) return false;
    const toMinutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    return (toMinutes(row.evidence.evidencePrepEnd) - toMinutes(row.evidence.evidencePrepStart) + 24 * 60) % (24 * 60) === row.evidence.evidencePrepMinutes;
  });
  const e2eRows = evidenceRows.filter((row) => row.evidence.e2eMinutes != null && row.evidence.plan.minutes != null && row.evidence.code.minutes != null && row.evidence.e2eMinutes === row.evidence.plan.minutes + row.evidence.code.minutes);
  const approved = (phase) => dogfoodRows.filter((row) => row.evidence[phase].outcomeEligible && row.evidence[phase].outcome === 'approved').length;
  const smokeRecordedRows = rows.filter((row) => row.smoke !== '—' && SMOKE_GRAMMAR.test(row.smoke));
  const smokeDone = smokeRecordedRows.filter((row) => row.smoke === 'PASS' || /^FAIL/.test(row.smoke)).length;
  const smokeMissing = rows.filter((row) => row.smoke === '—').length;
  const smokeInvalid = rows.length - smokeRecordedRows.length - smokeMissing;
  const { count: qualityMissCount, exists: frictionExists } = countQualityMisses();
  console.log('\n集計:');
  console.log(`- 実測フッター件数: ${rows.length}`);
  console.log(`- Evidence新形式件数: ${evidenceRows.length}`);
  console.log(`- dogfood適格件数: ${dogfoodRows.length}`);
  console.log(`- plan R1承認率（dogfood適格のみ）: ${ratio(approved('plan'), dogfoodRows.filter((row) => row.evidence.plan.outcomeEligible).length)}`);
  console.log(`- code R1承認率（dogfood適格のみ）: ${ratio(approved('code'), dogfoodRows.filter((row) => row.evidence.code.outcomeEligible).length)}`);
  // 0R（レビュー省略）の 0 分はレビュー所要時間の実績ではないため、平均は実施済み（rounds ≥ 1）だけで取る。
  console.log(`- plan平均レビュー分: ${average(evidenceRows.filter((row) => row.evidence.plan.minutes != null && row.evidence.plan.rounds > 0).map((row) => row.evidence.plan.minutes))}`);
  console.log(`- code平均レビュー分: ${average(evidenceRows.filter((row) => row.evidence.code.minutes != null && row.evidence.code.rounds > 0).map((row) => row.evidence.code.minutes))}`);
  console.log(`- E2E平均分: ${average(e2eRows.map((row) => row.evidence.e2eMinutes))}`);
  // 実働欄はレーン不問（Show 簡易フッター含む）。集計対象は実働欄を持つ全レーンの有効行。カバレッジ分母は Evidence 系件数を維持。
  const actual = aggregateActual(rows.map((row) => row.parsed));
  console.log(`- 実働記録件数（Show含む）: ${actual.recorded}/${evidenceRows.length}`);
  console.log(`- 実働平均分: ${actual.average == null ? '該当なし' : actual.average.toFixed(1)}`);
  console.log(`- 手法運用比率: ${actual.ratio == null ? '該当なし' : ratio(actual.methodOpsSum, actual.actualSum)}`);
  console.log(`- Evidence Package準備平均分（テスト時間は含めない）: ${average(preparedRows.map((row) => row.evidence.evidencePrepMinutes))}`);
  console.log(`- R1 4分類合計（plan-escape / implementation-deviation / evidence-gap / new-risk）: ${[0, 1, 2, 3].map((index) => sum(classifiedRows.map((row) => row.evidence.classification[index]))).join(' / ')}`);
  console.log(`- 並列Ask件数（旧形式）: ${parallelRows.length}`);
  console.log(`- 並列Ask平均レビュー分（旧形式）: ${average(parallelRows.map((row) => row.parallel.reviewMinutes))}`);
  console.log(`- smoke実施率: ${ratio(smokeDone, rows.length)}`);
  console.log(`- smoke記録不備: 未記載${smokeMissing}件 / 文法外${smokeInvalid}件`);
  console.log(frictionExists ? `- friction.md 品質漏れエントリ件数: ${qualityMissCount}` : '- friction.md が見つかりませんでした（0件として扱う）');
}

// 直接実行時のみ集計を出力する。import 時は parseFooter を副作用なしで公開する（Evidence entrypoint 用）。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
