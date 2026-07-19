import { globSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SHORT_CYCLE_MIN_CALLS = 10;
// wait_agent は timeout_ms 込みで呼び出し間隔が60秒をわずかに超えることが多く（実測: 07-16 中央値73.7秒、
// 07-17 中央値64.4秒）、60秒未満だと正しい運用（timeout最大で一度に待つ）からの逸脱を取りこぼす。
// 07-17 改訂後の正しい運用は待機が少数回・長間隔になるため、10回以上かつ中央値3分未満を短周期反復とみなす。
const SHORT_CYCLE_MAX_MEDIAN_SECONDS = 180;

function listSessionFiles(argPath) {
  if (argPath) return [argPath];
  const sessionsDir = join(homedir(), '.codex', 'sessions');
  try {
    statSync(sessionsDir);
  } catch {
    return [];
  }
  return globSync(join(sessionsDir, '**', '*.jsonl'));
}

function extractWaitAgentTimestamps(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  // wait_agent を含まないファイルは行ごとの JSON.parse を避ける（737MB 級のログ全体走査のコスト対策）
  if (!raw.includes('wait_agent')) return [];

  const timestamps = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // 壊れた行はスキップして継続
    }
    if (entry.type !== 'response_item') continue;
    const p = entry.payload;
    if (!p) continue;
    if ((p.type === 'function_call' || p.type === 'custom_tool_call') && p.name === 'wait_agent') {
      const t = Date.parse(entry.timestamp);
      if (!Number.isNaN(t)) timestamps.push(t);
    }
  }
  timestamps.sort((a, b) => a - b);
  return timestamps;
}

function median(nums) {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function analyzeSession(path) {
  const timestamps = extractWaitAgentTimestamps(path);
  if (timestamps === null) return { path, status: 'unreadable' };
  if (timestamps.length === 0) return { path, status: 'no-wait-agent' };

  const intervalsSeconds = [];
  for (let i = 1; i < timestamps.length; i++) {
    intervalsSeconds.push((timestamps[i] - timestamps[i - 1]) / 1000);
  }
  const medianSeconds = median(intervalsSeconds);
  const isShortCycle =
    timestamps.length >= SHORT_CYCLE_MIN_CALLS &&
    medianSeconds !== null &&
    medianSeconds < SHORT_CYCLE_MAX_MEDIAN_SECONDS;

  return {
    path,
    status: isShortCycle ? 'short-cycle-warning' : 'ok',
    callCount: timestamps.length,
    medianIntervalSeconds: medianSeconds,
  };
}

function main() {
  const argPath = process.argv[2];
  const files = listSessionFiles(argPath);

  if (files.length === 0) {
    console.log('対象のセッション JSONL が見つかりませんでした。');
    return;
  }

  const results = files.map(analyzeSession).filter((r) => r.status !== 'no-wait-agent' && r.status !== 'unreadable');
  const warnings = results.filter((r) => r.status === 'short-cycle-warning');

  if (results.length === 0) {
    console.log('wait_agent 呼び出しを含むセッションがありませんでした（対象外）。');
    return;
  }

  console.log(`wait_agent 呼び出しを含むセッション: ${results.length}件`);
  for (const r of results) {
    const medianLabel =
      r.medianIntervalSeconds === null ? '算出不可（呼び出し1回）' : `${r.medianIntervalSeconds.toFixed(1)}秒`;
    console.log(
      `- ${r.path}: ${r.callCount}回, 間隔中央値 ${medianLabel}${
        r.status === 'short-cycle-warning' ? ' [短周期反復・警告]' : ''
      }`,
    );
  }

  console.log(
    `\n警告（${SHORT_CYCLE_MIN_CALLS}回以上かつ間隔中央値${SHORT_CYCLE_MAX_MEDIAN_SECONDS}秒未満）: ${warnings.length}件`,
  );
}

main();
