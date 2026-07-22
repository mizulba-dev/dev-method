import { globSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SHORT_CYCLE_MIN_CALLS = 10;
const SHORT_TIMEOUT_MAX_MS = 180000;
const MAX_TIMEOUT_MS = 3600000;
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

function timeoutFromArguments(argumentsValue) {
  try {
    const value = typeof argumentsValue === 'string' ? JSON.parse(argumentsValue) : argumentsValue;
    return Number.isFinite(value?.timeout_ms) ? value.timeout_ms : null;
  } catch {
    return null;
  }
}

function extractWaitAgentCalls(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  // wait_agent を含まないファイルは行ごとの JSON.parse を避ける（737MB 級のログ全体走査のコスト対策）
  if (!raw.includes('wait_agent')) return [];

  const calls = [];
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
      if (!Number.isNaN(t)) calls.push({ timestamp: t, timeoutMs: timeoutFromArguments(p.arguments) });
    }
  }
  calls.sort((a, b) => a.timestamp - b.timestamp);
  return calls;
}

function median(nums) {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function analyzeSession(path) {
  const calls = extractWaitAgentCalls(path);
  if (calls === null) return { path, status: 'unreadable' };
  if (calls.length === 0) return { path, status: 'no-wait-agent' };

  const knownTimeoutCalls = calls.filter(({ timeoutMs }) => timeoutMs !== null);
  const shortTimeoutCalls = knownTimeoutCalls.filter(({ timeoutMs }) => timeoutMs < SHORT_TIMEOUT_MAX_MS);
  const intervalSource = shortTimeoutCalls.length > 0 ? shortTimeoutCalls : calls;
  const intervalsSeconds = [];
  for (let i = 1; i < intervalSource.length; i++) {
    intervalsSeconds.push((intervalSource[i].timestamp - intervalSource[i - 1].timestamp) / 1000);
  }
  const medianSeconds = median(intervalsSeconds);
  const allIntervalsSeconds = [];
  for (let i = 1; i < calls.length; i++) {
    allIntervalsSeconds.push((calls[i].timestamp - calls[i - 1].timestamp) / 1000);
  }
  const allMedianSeconds = median(allIntervalsSeconds);
  const repeatedQuickly =
    intervalSource.length >= SHORT_CYCLE_MIN_CALLS &&
    medianSeconds !== null &&
    medianSeconds < SHORT_CYCLE_MAX_MEDIAN_SECONDS;
  const isShortCycle = shortTimeoutCalls.length >= SHORT_CYCLE_MIN_CALLS && repeatedQuickly;
  const hasMissingArguments = knownTimeoutCalls.length !== calls.length;
  const isReferenceWarning = !isShortCycle
    && hasMissingArguments
    && calls.length >= SHORT_CYCLE_MIN_CALLS
    && allMedianSeconds !== null
    && allMedianSeconds < SHORT_CYCLE_MAX_MEDIAN_SECONDS;

  return {
    path,
    status: isShortCycle ? 'short-timeout-warning' : isReferenceWarning ? 'legacy-reference-warning' : 'ok',
    callCount: calls.length,
    shortTimeoutCallCount: shortTimeoutCalls.length,
    maxTimeoutCallCount: knownTimeoutCalls.filter(({ timeoutMs }) => timeoutMs === MAX_TIMEOUT_MS).length,
    missingArgumentsCallCount: calls.length - knownTimeoutCalls.length,
    medianIntervalSeconds: isReferenceWarning ? allMedianSeconds : medianSeconds,
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
  const warnings = results.filter((r) => r.status === 'short-timeout-warning');
  const references = results.filter((r) => r.status === 'legacy-reference-warning');

  if (results.length === 0) {
    console.log('wait_agent 呼び出しを含むセッションがありませんでした（対象外）。');
    return;
  }

  console.log(`wait_agent 呼び出しを含むセッション: ${results.length}件`);
  for (const r of results) {
    const medianLabel =
      r.medianIntervalSeconds === null ? '算出不可（呼び出し1回）' : `${r.medianIntervalSeconds.toFixed(1)}秒`;
    console.log(
      `- ${r.path}: ${r.callCount}回（短timeout ${r.shortTimeoutCallCount}回、最大timeout ${r.maxTimeoutCallCount}回、arguments欠落 ${r.missingArgumentsCallCount}回）, 間隔中央値 ${medianLabel}${
        r.status === 'short-timeout-warning' ? ' [短timeout反復・確定警告]' : r.status === 'legacy-reference-warning' ? ' [旧ログ・参考警告]' : ''
      }`,
    );
  }

  console.log(
    `\n確定警告（timeout_ms < ${SHORT_TIMEOUT_MAX_MS} が${SHORT_CYCLE_MIN_CALLS}回以上かつ間隔中央値${SHORT_CYCLE_MAX_MEDIAN_SECONDS}秒未満）: ${warnings.length}件`,
  );
  console.log(`参考警告（arguments欠落の旧ログで実間隔のみ該当）: ${references.length}件`);
}

main();
