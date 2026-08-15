import { comparableRecord, recordDiffFields } from './cloudflare.mjs';
import { DRIFT, planResource } from './plan.mjs';

// 同じ名前の TXT は用途ごとに並存するため、同種のレコードだけを比較対象にする
function txtKind(content) {
  const match = /^(v=spf1|v=DMARC1|v=DKIM1|google-site-verification|vc-domain-verify)/.exec(content);
  return match ? match[1] : content;
}

function groupKey(record) {
  const comparable = comparableRecord(record);
  const name = String(comparable.name).toLowerCase();
  return comparable.type === 'TXT' ? `TXT|${name}|${txtKind(comparable.content)}` : `${comparable.type}|${name}`;
}

// 同じ名前で CNAME と A/AAAA は共存できない。作成を提示せず乖離として停止する
const CONFLICTS = { A: ['CNAME'], AAAA: ['CNAME'], CNAME: ['A', 'AAAA'] };

function conflicting(desired, existing) {
  const types = CONFLICTS[desired.type] ?? [];
  return existing.find((record) => types.includes(record.type)
    && String(record.name).toLowerCase() === String(desired.name).toLowerCase()) ?? null;
}

function driftStep({ resource, desired, actual, drift, note }) {
  return { resource, action: DRIFT, desired, actual, drift, note, skipped: [], redactFields: [] };
}

// 期待集合と実在集合を用途ごとに突き合わせる。不足は create、余剰は drift（黙って残さない）
export function planDnsRecords({ desired, existing, createRecord }) {
  const steps = [];
  const groups = new Map();
  for (const record of desired) {
    const key = groupKey(record);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }

  for (const [key, group] of groups) {
    const actualGroup = existing.filter((record) => groupKey(record) === key);
    const exclusive = !group.some((record) => record.exclusive === false);
    const unmatched = actualGroup.filter((candidate) => !group
      .some((record) => comparableRecord(record).content === comparableRecord(candidate).content));
    const consumed = new Set();
    for (const record of group) {
      const resource = `dns ${record.type} ${record.name}`;
      const wanted = comparableRecord(record);
      let match = actualGroup.find((candidate) => comparableRecord(candidate).content === wanted.content) ?? null;
      // 用途上ひとつに定まるレコードは、値違いを「作成」ではなく乖離として報告する
      if (!match && exclusive) {
        match = unmatched.find((candidate) => !consumed.has(candidate)) ?? null;
        if (match) consumed.add(match);
      }
      const conflict = match ? null : conflicting(record, existing);
      if (conflict) {
        steps.push(driftStep({
          resource,
          desired: wanted,
          actual: comparableRecord(conflict),
          drift: [{ field: 'type', expected: record.type, actual: conflict.type }],
          note: `同じ名前に ${conflict.type} が存在するため ${record.type} を追加できません`,
        }));
        continue;
      }
      steps.push(planResource({
        resource,
        desired: wanted,
        actual: match ? comparableRecord(match) : null,
        fields: recordDiffFields(record),
        note: record.purpose,
        apply: createRecord ? () => createRecord(record) : undefined,
      }));
    }

    // 用途上ひとつに定まるレコード（SPF・DMARC・MX・A/CNAME）は余剰も乖離として報告する
    if (exclusive) {
      for (const extra of unmatched) {
        if (consumed.has(extra)) continue;
        const comparable = comparableRecord(extra);
        steps.push(driftStep({
          resource: `dns ${comparable.type} ${comparable.name}`,
          desired: null,
          actual: comparable,
          drift: [{ field: 'content', expected: '（契約に無い余剰レコード）', actual: comparable.content }],
          note: '同じ用途のレコードが余分に存在します。古い設定が残っていないか確認してください',
        }));
      }
    }
  }
  return steps;
}
