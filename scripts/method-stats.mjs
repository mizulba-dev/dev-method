import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const devNotesDir = join(homedir(), 'dev-notes');
const frictionPath = join(devNotesDir, 'dev-method', 'friction.md');

function listDirectionFiles() {
  const files = [];
  if (!existsSync(devNotesDir)) return files;
  for (const project of readdirSync(devNotesDir)) {
    const directionDir = join(devNotesDir, project, 'direction');
    if (!existsSync(directionDir) || !statSync(directionDir).isDirectory()) continue;
    for (const name of readdirSync(directionDir)) {
      if (!name.endsWith('.md')) continue;
      files.push({ project, name, path: join(directionDir, name) });
    }
  }
  return files;
}

const FOOTER_LINE = /^[-*]?\s*実測:\s*(.+)$/;

const FIELD_SPLIT = /\s*\/\s*(?=(?:担当|レビュー|差し戻し|リーダー直修正|追補\d|QA\s|逸脱:))/;
const QA_GRAMMAR = /^(PASS|FAIL \d+件|BLOCKED|SKIPPED|未実施)$/;

function parseFooter(body) {
  const segments = body.split(FIELD_SPLIT).map((s) => s.trim());
  const row = {
    roundCount: null,
    r1: null,
    reverts: null,
    directFixes: null,
    addenda: null,
    addendaContracts: null,
    qa: null,
    deviation: null,
  };
  for (const seg of segments) {
    let m;
    if (/^担当/.test(seg) || /^レビュー/.test(seg)) {
      const rMatches = [...seg.matchAll(/(\d+)R\b/g)].map((x) => Number(x[1]));
      if (rMatches.length > 0) {
        row.roundCount = (row.roundCount ?? 0) + rMatches.reduce((a, b) => a + b, 0);
      }
      const r1Match = seg.match(/R1\s*(must\d+\+should\d+(?:\+nit\d+)?)/);
      if (r1Match) row.r1 = r1Match[1];
      continue;
    }
    if ((m = seg.match(/^差し戻し(\d+)/))) { row.reverts = Number(m[1]); continue; }
    if ((m = seg.match(/^リーダー直修正(\d+)/))) { row.directFixes = Number(m[1]); continue; }
    if ((m = seg.match(/^追補(\d+)（契約(\d+)）/))) {
      row.addenda = Number(m[1]);
      row.addendaContracts = Number(m[2]);
      continue;
    }
    if ((m = seg.match(/^QA\s+(.+)$/))) { row.qa = m[1]; continue; }
    if (/^逸脱:/.test(seg)) { row.deviation = seg.replace(/^逸脱:\s*/, '').trim(); continue; }
  }
  const warnings = [];
  if (row.roundCount == null) warnings.push('R数を抽出できず');
  if (row.reverts == null) warnings.push('差し戻し数を抽出できず');
  if (row.directFixes == null) warnings.push('リーダー直修正数を抽出できず');
  if (row.addenda == null) warnings.push('追補数を抽出できず');
  if (row.deviation == null) warnings.push('逸脱欄を抽出できず');
  if (!row.r1) warnings.push('R1内訳欠落');
  if (row.qa != null && !QA_GRAMMAR.test(row.qa)) {
    warnings.push(`QA値が文法外: ${row.qa}`);
  }
  if (row.qa == null && /QA/.test(body)) {
    warnings.push('QA欄のパース失敗');
  }

  row.qa = row.qa ?? '未実施';

  return { row, warnings };
}

function extractDate(filename) {
  const m = filename.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '(不明)';
}

function collectFooters(files) {
  const rows = [];
  const parseWarnings = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file.path, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    lines.forEach((line, idx) => {
      const m = line.trim().match(FOOTER_LINE);
      if (!m) return;
      const { row, warnings } = parseFooter(m[1]);
      const location = `${file.path}:${idx + 1}`;
      rows.push({
        日付: extractDate(file.name),
        プロジェクト: file.project,
        R数: row.roundCount ?? '?',
        'R1(must/should)': row.r1 ?? '欠落',
        差し戻し: row.reverts ?? '?',
        直修正: row.directFixes ?? '?',
        '追補(契約)': row.addenda != null ? `${row.addenda}(${row.addendaContracts ?? '?'})` : '?',
        QA: row.qa,
        逸脱有無: row.deviation && row.deviation !== 'なし' ? '有' : '無',
        location,
      });
      const realWarnings = warnings.filter((w) => w !== 'R1内訳欠落');
      if (realWarnings.length > 0) {
        parseWarnings.push(`パース不完全 ${location}: ${realWarnings.join('・')}`);
      }
      if (warnings.includes('R1内訳欠落')) {
        parseWarnings.push(`R1内訳欠落 ${location}`);
      }
    });
  }
  return { rows, parseWarnings };
}

function countQualityMisses() {
  if (!existsSync(frictionPath)) return { count: 0, exists: false };
  const lines = readFileSync(frictionPath, 'utf8').split('\n');
  const entries = lines.filter((l) => /^-\s*\d{4}-\d{2}-\d{2}/.test(l.trim()));
  const count = entries.filter((l) => /品質漏れ/.test(l)).length;
  return { count, exists: true };
}

function main() {
  const files = listDirectionFiles();
  const { rows, parseWarnings } = collectFooters(files);

  if (rows.length === 0) {
    console.log('実測フッターが見つかりませんでした（~/dev-notes 不在、または対象0件）。');
  } else {
    console.table(
      rows.map(({ location, ...rest }) => rest),
    );
  }

  if (parseWarnings.length > 0) {
    console.log('\n警告:');
    for (const w of parseWarnings) console.log(`- ${w}`);
  }

  const qaDone = rows.filter((r) => r.QA !== '未実施').length;
  const qaFail = rows.filter((r) => /^FAIL/.test(r.QA)).length;
  const qaRate = rows.length > 0 ? ((qaDone / rows.length) * 100).toFixed(1) : '0.0';
  const { count: qualityMissCount, exists: frictionExists } = countQualityMisses();

  console.log('\n集計:');
  console.log(`- 実測フッター件数: ${rows.length}`);
  console.log(`- QA実施率: ${qaDone}/${rows.length} (${qaRate}%)`);
  console.log(`- QA FAIL件数: ${qaFail}`);
  console.log(
    frictionExists
      ? `- friction.md 品質漏れエントリ件数: ${qualityMissCount}`
      : '- friction.md が見つかりませんでした（0件として扱う）',
  );
}

main();
