export const CREATE = 'create';
export const SKIP = 'skip';
export const DRIFT = 'drift';
export const MANUAL = 'manual';

function normalize(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(normalize).join(',');
  return String(value);
}

export function diffFields(desired, actual, fields) {
  const drift = [];
  for (const field of fields) {
    const expected = normalize(desired?.[field]);
    if (expected === null) continue;
    const found = normalize(actual?.[field]);
    if (expected !== found) drift.push({ field, expected, actual: found });
  }
  return drift;
}

// 契約側が値を持たず照合しなかったフィールド（暗黙のスキップを出力で可視化する）
export function unspecifiedFields(desired, fields) {
  return fields.filter((field) => normalize(desired?.[field]) === null);
}

// 冪等の中核: 存在しなければ create、存在して契約と一致すれば skip、乖離があれば drift（自動上書きしない）
export function planResource({ resource, desired, actual, fields, apply, note, redactFields = [] }) {
  const skipped = unspecifiedFields(desired, fields);
  if (!actual) return { resource, action: CREATE, desired, note, apply, skipped, redactFields };
  const drift = diffFields(desired, actual, fields);
  if (drift.length === 0) return { resource, action: SKIP, desired, actual, note, skipped, redactFields };
  return { resource, action: DRIFT, desired, actual, drift, note, skipped, redactFields };
}

// blocking:false の manual は工程を止めない（恒久的に人の作業として残るもの）
export function manualStep({ resource, note, instructions, blocking = true }) {
  return { resource, action: MANUAL, note, instructions, blocking };
}

export function summarize(steps) {
  const counts = { create: 0, skip: 0, drift: 0, manual: 0 };
  for (const step of steps) counts[step.action] += 1;
  return counts;
}

export function hasDrift(steps) {
  return steps.some((step) => step.action === DRIFT);
}

export function blockingManual(steps) {
  return steps.filter((step) => step.action === MANUAL && step.blocking !== false);
}

function renderSkipped(step) {
  return step.skipped?.length ? `。未照合: ${step.skipped.join(', ')}` : '';
}

export function renderStep(step) {
  if (step.action === CREATE) return `create  ${step.resource}${step.note ? ` — ${step.note}` : ''}`;
  if (step.action === SKIP) return `skip    ${step.resource}（契約と一致${renderSkipped(step)}）`;
  if (step.action === MANUAL) {
    return `manual  ${step.resource}${step.blocking === false ? '（工程は止めません）' : ''} — ${step.note}`;
  }
  const clamp = (value) => (String(value).length > 80 ? `${String(value).slice(0, 80)}…` : value);
  const redacted = new Set(step.redactFields ?? []);
  const drift = step.drift.map((d) => (redacted.has(d.field)
    ? `${d.field}: 契約と一致しません（値は表示しません）`
    : `${d.field}: 契約=${clamp(d.expected)} / 実際=${clamp(d.actual)}`)).join(' | ');
  return `DRIFT   ${step.resource} — ${drift}`;
}

export async function applySteps(steps, logger) {
  const applied = [];
  for (const step of steps) {
    if (step.action === DRIFT) {
      logger.line(renderStep(step));
      logger.line('乖離を検出したため停止しました。自動上書きは行いません。');
      return { applied, stopped: step };
    }
    if (step.action === MANUAL) {
      logger.line(renderStep(step));
      for (const line of step.instructions ?? []) logger.line(`  ${line}`);
      if (step.blocking === false) continue;
      return { applied, stopped: step };
    }
    if (step.action === SKIP) {
      logger.line(renderStep(step));
      continue;
    }
    try {
      const result = await step.apply();
      applied.push({ resource: step.resource, result });
      logger.line(`applied ${step.resource}`);
    } catch (error) {
      logger.line(`FAILED  ${step.resource}: ${error.message}`);
      logger.line(`ここまでの適用: ${applied.length ? applied.map((a) => a.resource).join(', ') : 'なし'}`);
      return { applied, failed: { resource: step.resource, error } };
    }
  }
  return { applied };
}
