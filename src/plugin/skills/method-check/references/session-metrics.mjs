import { createReadStream, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

// Claude / Codex 両セッションログの時間内訳を決定論的に実測する。fs 読み取りと stdout/stderr のみ。
// 排他パーティション: 各イベント間区間を userWaitMs か breakdown の5フィールドのちょうど1つへ割り当て、
// 不変式 breakdown合計 = activeMs、activeMs + userWaitMs = wallClockMs を常に満たす。

const CLAUDE_TOP = new Set([
  'user', 'assistant', 'system', 'queue-operation',
  'summary', 'mode', 'permission-mode', 'bridge-session',
  'file-history-snapshot', 'file-history-delta', 'attachment', 'ai-title', 'last-prompt',
]);
const CLAUDE_BLOCK = new Set(['text', 'thinking', 'redacted_thinking', 'tool_use', 'tool_result', 'image']);
const CODEX_TOP = new Set(['session_meta', 'event_msg', 'response_item', 'turn_context', 'world_state']);
const CODEX_EVENT_MSG = new Set([
  'task_started', 'task_complete', 'turn_aborted', 'token_count',
  'mcp_tool_call_begin', 'mcp_tool_call_end', 'user_message', 'agent_message',
  'thread_settings_applied', 'patch_apply_begin', 'patch_apply_end', 'sub_agent_activity', 'context_compacted',
]);
const CODEX_RESPONSE_ITEM = new Set([
  'message', 'reasoning', 'custom_tool_call', 'custom_tool_call_output',
  'function_call', 'function_call_output', 'agent_message',
]);
// 委譲・バックグラウンド待機系ツール名（契約の「Agent / Task 等」の範囲。Codex の待機ツール wait_agent を含む）。
const DELEGATION_NAMES = new Set(['Agent', 'Task', 'wait_agent']);
const INJECTED_MARKERS = ['<teammate-message', 'Another Claude session sent a message', 'task-notification', '<task-notification'];

function fail(message) {
  process.stderr.write(`session-metrics: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const sessions = [];
  const methodPaths = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--session') { sessions.push(argv[i + 1]); i += 1; }
    else if (argv[i] === '--method-path') { methodPaths.push(argv[i + 1]); i += 1; }
    else fail(`未知の引数です: ${argv[i]}`);
  }
  if (sessions.some((value) => value == null)) fail('--session に値がありません');
  if (methodPaths.some((value) => value == null)) fail('--method-path に値がありません');
  return { sessions, methodPaths };
}

function tsMs(value) {
  if (typeof value !== 'string') return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

// --- method-op 判定（入力側パスのみ・キー限定列挙方式） ---
// 判定は値の形状でなくキーの意味で行う。パスキー列挙の値は形状フィルタなしで候補化し（裸ファイル名も matcher
// 正規表現へ渡す）、本文キー列挙は値形状によらず候補化しない（本文中のパス言及での過検知を排除）。列挙外の
// 未知キーは候補化しない（過小検知方向。ヒューリスティック値の性質と整合）。採用列挙は method-check SKILL.md に記載。
// パスキー（値がパスを運ぶキー・形状フィルタなしで候補化）。列挙外の本文キー（content・old_string・new_string・
// message・prompt・description・patch・text・body・instructions・query・pattern・replace 等）と未知キーは候補化しない。
const PATH_KEYS = new Set(['file_path', 'filePath', 'path', 'notebook_path', 'notebookPath', 'target_file', 'cwd', 'file', 'directory', 'dir']);
const SHELL_KEYS = new Set(['command', 'cmd', 'script']);

// command / cmd / script はシェル文字列（または ['bash','-lc', ...] の配列）として空白分割し / 始まりの
// 絶対パストークンを抽出する。
function shellPathTokens(value) {
  const out = [];
  const parts = Array.isArray(value) ? value : [value];
  for (const part of parts) {
    if (typeof part !== 'string') continue;
    for (const token of part.split(/\s+/)) if (token.startsWith('/')) out.push(token);
  }
  return out;
}

function candidatePaths(input) {
  const out = [];
  if (!input || typeof input !== 'object') return out;
  for (const [key, value] of Object.entries(input)) {
    if (SHELL_KEYS.has(key)) out.push(...shellPathTokens(value));
    else if (PATH_KEYS.has(key) && typeof value === 'string' && value.length > 0) out.push(value); // 形状フィルタなし
    // BODY_KEYS・列挙外の未知キーは候補化しない
  }
  return out;
}

function isMethodOpPath(path, methodPaths) {
  if (typeof path !== 'string') return false;
  const normalized = path.startsWith('/') ? path : `/${path}`;
  const inWork = normalized.includes('/.work/');
  const workNamed = inWork && /(review-ledger|plan-review|evidence)/.test(normalized);
  if (normalized.includes('/direction/') && normalized.includes('/dev-notes/')) return true;
  if (/(^|\/)friction\.md$/.test(normalized)) return true; // セグメント末尾一致のみ（naive contains は迂回面 fail-open）
  if (workNamed) return true;
  for (const substring of methodPaths) if (substring && path.includes(substring)) return true;
  return false;
}

function isMethodOpCall(input, methodPaths) {
  return candidatePaths(input).some((path) => isMethodOpPath(path, methodPaths));
}

// arguments（Codex function_call / custom_tool_call）を入力オブジェクトへ復元する。既に object ならそのまま、
// JSON 文字列ならパース、解釈不能なら空 object（キー限定列挙方式のため未知キーは候補化されない）。
function codexInput(argumentsRaw) {
  if (argumentsRaw && typeof argumentsRaw === 'object') return argumentsRaw;
  if (typeof argumentsRaw === 'string') {
    try {
      const parsed = JSON.parse(argumentsRaw);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* 解釈不能は空 object */ }
  }
  return {};
}

function primaryPath(input) {
  const paths = candidatePaths(input);
  return paths.length ? paths[0] : null;
}

// --- セッション単位の集計器 ---
function makeSession(path, client) {
  return {
    path, client,
    wallClockMs: 0, userWaitMs: 0, activeMs: 0,
    breakdown: { llmGenerationMs: 0, methodOpsMs: 0, toolExecutionMs: 0, delegationWaitMs: 0, unattributedMs: 0 },
    ...(client === 'codex'
      ? { durationCheckMs: null, mcpDurationMs: 0, tokens: null }
      : { turnDurationCheckMs: null, tokens: null }),
    cutoffBytes: null, // 測定 cutoff（起動時のファイルサイズ）。ファイル解析時のみ設定、配列解析（analyze）では null
    loops: [],
    quality: { parsedLines: 0, skippedLines: 0, orphanToolUses: 0, unknownEvents: 0, timestampMissing: 0 },
  };
}

const BREAKDOWN_KEYS = ['llmGenerationMs', 'methodOpsMs', 'toolExecutionMs', 'delegationWaitMs', 'unattributedMs'];

function pendingBucket(pending) {
  let hasDelegation = false;
  for (const call of pending.values()) {
    if (call.methodOp) return 'methodOpsMs';
    if (call.delegation) hasDelegation = true;
  }
  return hasDelegation ? 'delegationWaitMs' : 'toolExecutionMs';
}

// Codex 判定は session_meta 行の存在を必要条件とする（EC-MC-2）。session_meta も Claude 既知キーも無ければ
// 判別不能（null）として呼び出し側で exit 1（EC-MC-4 fail-closed）。
function detectClientFromEvent(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.type === 'session_meta') return 'codex';
  if (event.type === 'assistant' || event.type === 'user' || (event.type === 'system' && event.subtype)) return 'claude';
  return null;
}

function detectClient(lines) {
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const client = detectClientFromEvent(event);
    if (client) return client;
  }
  return null;
}

function claudeUnknownLine(event) {
  if (!CLAUDE_TOP.has(event.type)) return true;
  const content = event.message?.content;
  // content block の discriminator を既知集合照合の前段で検証する（Codex 側と対称の fail-closed）。非 object block・
  // type 非文字列（欠落・null 含む）・既知集合外の type はいずれも unknown 扱いにする。
  if ((event.type === 'assistant' || event.type === 'user') && Array.isArray(content)) {
    if (content.some((block) => !block || typeof block !== 'object' || typeof block.type !== 'string' || !CLAUDE_BLOCK.has(block.type))) return true;
  }
  return false;
}

function codexUnknownLine(event) {
  if (!CODEX_TOP.has(event.type)) return true;
  // event_msg / response_item は discriminator（payload.type）の存在を先に検証する。payload が object でない、
  // または payload.type が文字列でない（欠落・null 含む）行は既知集合照合の前段で unknown 扱いにする（fail-closed）。
  if (event.type === 'event_msg' || event.type === 'response_item') {
    const payload = event.payload;
    if (!payload || typeof payload !== 'object') return true;
    if (typeof payload.type !== 'string') return true;
    const known = event.type === 'event_msg' ? CODEX_EVENT_MSG : CODEX_RESPONSE_ITEM;
    if (!known.has(payload.type)) return true;
  }
  return false;
}

// user イベントのプロンプト種別を返す。'human'=人間の入力（ユーザー応答待ちの終端）、'injected'=teammate /
// task 通知（ユーザー待ちではなく委譲・バックグラウンド待ちの終端）、null=tool_result 等プロンプトでない。
function promptKind(event) {
  if (event.type !== 'user' || event.isMeta) return null;
  const content = event.message?.content;
  let text = null;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    if (content.some((block) => block?.type === 'tool_result')) return null;
    if (!content.some((block) => block?.type === 'text' || block?.type === 'image')) return null;
    text = content.filter((block) => block?.type === 'text').map((block) => block.text ?? '').join('\n');
  } else return null;
  if (text && INJECTED_MARKERS.some((marker) => text.includes(marker))) return 'injected';
  return 'human';
}

function bumpLoop(loops, tool, path) {
  if (!tool || !path) return;
  const key = `${tool} ${path}`;
  const found = loops.get(key);
  if (found) found.count += 1;
  else loops.set(key, { tool, path, count: 1 });
}

export function analyze(lines, methodPaths = []) {
  const client = detectClient(lines);
  if (!client) return null;
  return client === 'codex' ? analyzeCodex(lines, methodPaths) : analyzeClaude(lines, methodPaths);
}

function createClaudeAnalyzer(methodPaths) {
  const session = makeSession(null, 'claude');
  const pending = new Map();
  const loops = new Map();
  let turnDurationSum = null;
  let firstTs = null; let lastTs = null;
  let prevTs = null; let prevUnknown = false;
  let taint = false; // untimestamped/unknown timing イベントを跨ぐ区間の汚染

  const addInterval = (curr, currTs) => {
    if (prevTs == null) return;
    const gap = currTs - prevTs;
    if (gap < 0) { session.breakdown.unattributedMs += 0; return; } // 逆行は加算しない（後で正規化）
    let bucket;
    if (taint || prevUnknown || curr.unknown) bucket = 'unattributedMs';
    else if (pending.size > 0) bucket = pendingBucket(pending);
    else if (curr.methodOpCall) bucket = 'methodOpsMs';
    else if (curr.promptKind === 'human') { session.userWaitMs += gap; return; }
    else bucket = 'llmGenerationMs'; // injected（teammate/task）や tool_result 後の区間は直前イベント種別規則で LLM 生成へ
    session.breakdown[bucket] += gap;
  };

  const feed = (line) => {
    if (line.trim() === '') return;
    let event;
    try { event = JSON.parse(line); } catch { session.quality.skippedLines += 1; taint = true; return; }
    session.quality.parsedLines += 1;
    const unknown = claudeUnknownLine(event);
    if (unknown) session.quality.unknownEvents += 1;

    if (event.type === 'system' && event.subtype === 'turn_duration' && Number.isFinite(event.durationMs)) {
      turnDurationSum = (turnDurationSum ?? 0) + event.durationMs;
    }

    // wallClock 端点は timestamp を持つ全イベント（system・queue-operation・未知含む）で更新する（Codex と対称）。
    // 端点まで拡張された結果、先頭メタ→最初の timeline・最後の timeline→末尾メタの未被覆区間は finalize の
    // 残差として unattributedMs へ反映される。
    const ts = tsMs(event.timestamp);
    if (Number.isFinite(ts)) { if (firstTs == null) firstTs = ts; lastTs = ts; }

    // timeline に載せる型は user / assistant のみ。既知メタ・system・queue-operation は時間分類へ関与させない。
    const isTimeline = !unknown && (event.type === 'user' || event.type === 'assistant');
    if (!isTimeline) {
      // 未知型は隣接区間を汚染する。既知メタは汚染しない（端点拡張のみ）。
      if (unknown) taint = true;
      return;
    }

    if (!Number.isFinite(ts)) { session.quality.timestampMissing += 1; taint = true; return; }

    const content = event.message?.content;
    const curr = { promptKind: null, methodOpCall: false, unknown: false };
    if (event.type === 'user') {
      curr.promptKind = promptKind(event);
    } else if (event.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block?.type !== 'tool_use') continue;
        if (isMethodOpCall(block.input, methodPaths)) curr.methodOpCall = true;
        bumpLoop(loops, block.name, primaryPath(block.input));
      }
    }

    // 区間分類は pending 解決より先に行う（tool_use→tool_result 区間は解決時点でも pending 扱い）。
    addInterval(curr, ts);

    // 区間分類後に tool_result で pending を解決し、tool_use を pending へ追加する。
    if (event.type === 'user' && Array.isArray(content)) {
      for (const block of content) if (block?.type === 'tool_result' && block.tool_use_id) pending.delete(block.tool_use_id);
    } else if (event.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block?.type !== 'tool_use' || !block.id) continue;
        pending.set(block.id, { methodOp: isMethodOpCall(block.input, methodPaths), delegation: DELEGATION_NAMES.has(block.name) });
      }
    }

    prevTs = ts; prevUnknown = false; taint = false;
  };

  const done = () => {
    session.quality.orphanToolUses = pending.size;
    session.loops = [...loops.values()].filter((entry) => entry.count >= 3).map(({ tool, path, count }) => ({ tool, path, count }));
    session.wallClockMs = firstTs == null || lastTs == null ? 0 : lastTs - firstTs;
    session.turnDurationCheckMs = turnDurationSum;
    finalize(session);
    return session;
  };
  return { feed, done };
}

function analyzeClaude(lines, methodPaths) {
  const analyzer = createClaudeAnalyzer(methodPaths);
  for (const line of lines) analyzer.feed(line);
  return analyzer.done();
}

function createCodexAnalyzer(methodPaths) {
  const session = makeSession(null, 'codex');
  const pending = new Map();
  const loops = new Map();
  let durationCheckSum = null;
  let orphanCount = 0;
  let firstTs = null; let lastTs = null;
  let prevTs = null; let inTurn = false; let taint = false; let prevUnknown = false;

  const addInterval = (curr, currTs) => {
    if (prevTs == null) return;
    const gap = currTs - prevTs;
    if (gap < 0) return;
    let bucket;
    // turn 外区間は途中に非 task イベント・pending・未知が挟まっても全体を userWaitMs へ一意帰属する（最優先）。
    // unattributedMs は turn 内の未分類・timestamp 欠落・未知隣接区間だけに限る。
    if (!inTurn) { session.userWaitMs += gap; return; }
    if (taint || prevUnknown || curr.unknown) bucket = 'unattributedMs';
    else if (pending.size > 0) bucket = pendingBucket(pending);
    else if (curr.methodOpCall) bucket = 'methodOpsMs';
    else bucket = 'llmGenerationMs';
    session.breakdown[bucket] += gap;
  };

  const feed = (line) => {
    if (line.trim() === '') return;
    let event;
    try { event = JSON.parse(line); } catch { session.quality.skippedLines += 1; taint = true; return; }
    session.quality.parsedLines += 1;
    const unknown = codexUnknownLine(event);
    if (unknown) session.quality.unknownEvents += 1;

    const nested = event.payload?.type;
    if (event.type === 'event_msg' && (nested === 'task_complete' || nested === 'turn_aborted') && Number.isFinite(event.payload.duration_ms)) {
      durationCheckSum = (durationCheckSum ?? 0) + event.payload.duration_ms;
    }
    if (event.type === 'event_msg' && nested === 'token_count') {
      const usage = event.payload?.info?.total_token_usage;
      if (usage && typeof usage === 'object') session.tokens = usage;
    }

    const ts = tsMs(event.timestamp);
    if (!Number.isFinite(ts)) { session.quality.timestampMissing += 1; taint = true; return; }
    if (firstTs == null) firstTs = ts;
    lastTs = ts;

    const curr = { methodOpCall: false, unknown };
    if (event.type === 'response_item' && (nested === 'function_call' || nested === 'custom_tool_call')) {
      const mInput = codexInput(event.payload.arguments);
      if (isMethodOpCall(mInput, methodPaths)) curr.methodOpCall = true;
      bumpLoop(loops, event.payload.name ?? nested, primaryPath(mInput));
    }

    // 区間分類は pending 解決より先に行う（call→output・mcp begin→end 区間は解決時点でも pending 扱い）。
    addInterval(curr, ts);

    // 区間分類後に出力・MCP end で pending を解決する。
    if (event.type === 'response_item' && (nested === 'function_call_output' || nested === 'custom_tool_call_output') && event.payload.call_id) {
      pending.delete(event.payload.call_id);
    }
    if (event.type === 'event_msg' && nested === 'mcp_tool_call_end') {
      const cid = event.payload.call_id;
      if (cid) pending.delete(`mcp ${cid}`);
      const duration = event.payload.duration;
      if (duration && typeof duration === 'object' && Number.isFinite(duration.secs)) {
        session.mcpDurationMs += duration.secs * 1000 + (Number.isFinite(duration.nanos) ? duration.nanos / 1e6 : 0);
      }
    }
    // turn 境界と pending 追加を反映する。turn 終端では残留 pending を orphan として計上しクリアする
    // （中断で残留すると以後の turn 外区間へ pending が漏れて toolExecution/delegationWait を誤算入するため）。
    if (event.type === 'event_msg' && nested === 'task_started') inTurn = true;
    else if (event.type === 'event_msg' && (nested === 'task_complete' || nested === 'turn_aborted')) {
      inTurn = false;
      orphanCount += pending.size;
      pending.clear();
    }
    if (event.type === 'response_item' && (nested === 'function_call' || nested === 'custom_tool_call') && event.payload.call_id) {
      pending.set(event.payload.call_id, { methodOp: curr.methodOpCall, delegation: DELEGATION_NAMES.has(event.payload.name) });
    }
    if (event.type === 'event_msg' && nested === 'mcp_tool_call_begin' && event.payload.call_id) {
      pending.set(`mcp ${event.payload.call_id}`, { methodOp: false, delegation: false });
    }

    prevTs = ts; prevUnknown = unknown; taint = false;
  };

  const done = () => {
    session.quality.orphanToolUses = orphanCount + pending.size;
    session.loops = [...loops.values()].filter((entry) => entry.count >= 3).map(({ tool, path, count }) => ({ tool, path, count }));
    session.wallClockMs = firstTs == null || lastTs == null ? 0 : lastTs - firstTs;
    session.durationCheckMs = durationCheckSum;
    session.mcpDurationMs = Math.round(session.mcpDurationMs);
    finalize(session);
    return session;
  };
  return { feed, done };
}

function analyzeCodex(lines, methodPaths) {
  const analyzer = createCodexAnalyzer(methodPaths);
  for (const line of lines) analyzer.feed(line);
  return analyzer.done();
}

function finalize(session) {
  session.activeMs = BREAKDOWN_KEYS.reduce((total, key) => total + session.breakdown[key], 0);
  // 不変式 activeMs + userWaitMs = wallClockMs を厳密成立させる（浮動小数の丸め残差を unattributed へ吸収）。
  const residual = session.wallClockMs - (session.activeMs + session.userWaitMs);
  if (residual !== 0) {
    session.breakdown.unattributedMs += residual;
    session.activeMs += residual;
  }
}

// 判別前バッファの上限（行数）。上限まで判別できなければ全行保持せず fail-closed で打ち切る。実 Codex rollout は
// session_meta が先頭行、Claude も先頭付近で判別できるため正当ログへの影響はない。
const PRE_DETECTION_LIMIT = 256;

// ファイルを readline で1行ずつ処理し、raw 全文・全行配列を保持しない。**測定 cutoff**: 起動時に statSync で
// 取得したサイズを createReadStream の end へ固定し、解析中に追記された（実測コマンド自身を含む）イベントを
// 読まない。cutoffBytes として出力へ載せる。クライアント判別は最初の判別可能行で確定し、判別前の行だけを上限
// 付きの一時バッファへ退避してから analyzer へ供給する。判別できなければ null（呼び出し側で fail-closed）。
async function analyzeFile(path, methodPaths) {
  const size = statSync(path).size;
  let client = null;
  let analyzer = null;
  const preDetection = [];
  const input = createReadStream(path, size > 0 ? { start: 0, end: size - 1 } : { start: 0 });
  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (analyzer) { analyzer.feed(line); continue; }
    let event = null;
    try { event = JSON.parse(line); } catch { /* 判別不能行 */ }
    client = detectClientFromEvent(event);
    if (!client) {
      preDetection.push(line);
      if (preDetection.length > PRE_DETECTION_LIMIT) { rl.close(); return null; } // 上限超過 fail-closed（全行保持しない）
      continue;
    }
    analyzer = client === 'codex' ? createCodexAnalyzer(methodPaths) : createClaudeAnalyzer(methodPaths);
    for (const buffered of preDetection) analyzer.feed(buffered);
    preDetection.length = 0;
    analyzer.feed(line);
  }
  if (!analyzer) return null;
  const session = analyzer.done();
  session.cutoffBytes = size;
  return session;
}

async function main() {
  const { sessions, methodPaths } = parseArgs(process.argv.slice(2));
  if (sessions.length === 0) fail('--session を1件以上指定してください');
  const results = [];
  for (const path of sessions) {
    let session;
    try { session = await analyzeFile(path, methodPaths); } catch { fail(`セッションログを読み込めません: ${path}`); }
    if (!session) fail(`claude / codex いずれの形式とも判別できません: ${path}`);
    session.path = path;
    results.push(session);
  }
  const totals = { wallClockMs: 0, userWaitMs: 0, activeMs: 0, breakdown: { llmGenerationMs: 0, methodOpsMs: 0, toolExecutionMs: 0, delegationWaitMs: 0, unattributedMs: 0 } };
  for (const session of results) {
    totals.wallClockMs += session.wallClockMs;
    totals.userWaitMs += session.userWaitMs;
    totals.activeMs += session.activeMs;
    for (const key of BREAKDOWN_KEYS) totals.breakdown[key] += session.breakdown[key];
  }
  process.stdout.write(`${JSON.stringify({ sessions: results, totals }, null, 2)}\n`);
}

// 直接実行時のみ CLI として動く。import 時は analyze / BREAKDOWN_KEYS を副作用なしで公開する（Evidence entrypoint 用）。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

export { BREAKDOWN_KEYS };
