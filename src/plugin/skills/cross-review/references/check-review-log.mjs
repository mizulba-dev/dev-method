import { readFileSync, writeFileSync } from "node:fs";

const rawArgs = process.argv.slice(2);
let allowRaw = null;
const positional = [];
for (let i = 0; i < rawArgs.length; i += 1) {
  if (rawArgs[i] === "--allow") {
    allowRaw = rawArgs[i + 1];
    i += 1;
  } else {
    positional.push(rawArgs[i]);
  }
}
const [logPath, patternRaw, resultOutPath] = positional;

if (!logPath || !patternRaw) {
  console.error(
    [
      "使い方: node check-review-log.mjs <event-log-path> <pattern> [result-out-path] [--allow <pattern>]",
      "  <pattern> は claude / codex 両モード共通で検証・変更系コマンドの denylist パターン。一致する実行だけを違反とする。",
      "  denylist に一致しない非 git コマンド（閲覧系）は otherCommands の info 列挙に留め、逸脱にはしない。",
      "  --allow は検知器変更レビューの検体照合実行だけを許可するパターン。一致したサブコマンドは allowedCommands の info 列挙に留める。",
    ].join("\n"),
  );
  process.exit(1);
}

let allowPattern = null;
if (allowRaw != null) {
  try {
    allowPattern = new RegExp(allowRaw);
  } catch {
    console.error(`check-review-log: --allow パターンを正規表現として解釈できません: ${allowRaw}`);
    process.exit(1);
  }
}

let pattern;
try {
  pattern = new RegExp(patternRaw);
} catch {
  console.error(`check-review-log: パターンを正規表現として解釈できません: ${patternRaw}`);
  process.exit(1);
}

let raw;
try {
  raw = readFileSync(logPath, "utf8");
} catch {
  console.error(`check-review-log: イベントログを読み込めません: ${logPath}`);
  process.exit(1);
}

const lines = raw.split("\n").filter((line) => line.trim().length > 0);

// codex exec --json はシェルラッパー越しにコマンドを渡す（例: /bin/zsh -lc 'git diff --stat HEAD' /
// /bin/zsh -lc "sed \"...\" file | node ..."）。二重引用符 payload はシェルの規則で \\ \" \$ \` を復元する。
// ラッパー形式なのにどちらの payload とも取り出せないコマンドは解析不能（unparseable）として呼び出し側で
// fail-closed（違反扱い）にする。
function unwrapShellCommand(command) {
  const single = /^\/bin\/(?:zsh|bash|sh)\s+-l?c\s+'([\s\S]*)'$/.exec(command);
  if (single) return { command: single[1], unparseable: false };
  const double = /^\/bin\/(?:zsh|bash|sh)\s+-l?c\s+"([\s\S]*)"$/.exec(command);
  if (double) return { command: double[1].replace(/\\([\\"$`])/g, "$1"), unparseable: false };
  const wrapperLike = /^\/bin\/(?:zsh|bash|sh)\s+-l?c(\s|$)/.test(command);
  return { command, unparseable: wrapperLike };
}

// シングル/ダブルクォート（ダブルクォート内の \" エスケープを考慮）の外側にある区切りトークンだけで
// 分割する。クォート内の denylist 文字列・正規表現・引数に含まれる ; && || | は分割対象にしない。
// クォート外でもバックスラッシュエスケープされた区切り文字（例: echo foo\|bar の \|）は分割しない
// （\\ の連続も 2 文字単位で消費するため、\\| のような「エスケープされた \」+「素の |」は正しく分割される）。
// separators は長いトークンから順にマッチを試す（|| を | 2つに誤分割しないため）。
// 走査終了時にクォートが閉じていないコマンドは分割結果を信頼できない（区切りがクォート内へ吸われて素通りする）
// ため unbalanced を返し、呼び出し側で fail-closed（違反扱い）にする。
function splitOutsideQuotes(command, separators) {
  const parts = [];
  let current = "";
  let quote = null; // "'" | '"' | null
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        current += ch + command[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      current += ch + command[i + 1];
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      i += 1;
      continue;
    }
    const matchedSep = separators.find((sep) => command.startsWith(sep, i));
    if (matchedSep) {
      parts.push(current);
      current = "";
      i += matchedSep.length;
      continue;
    }
    current += ch;
    i += 1;
  }
  parts.push(current);
  return {
    parts: parts.map((part) => part.trim()).filter((part) => part.length > 0),
    unbalanced: quote !== null,
  };
}

// 複合コマンド（例: git diff HEAD && go test ./...）を ; && || で独立ステートメントに分割し、
// 各ステートメント内はさらに | でパイプ連鎖に分割する（いずれもクォート外のトークンのみで分割）。
// パイプ連鎖の先頭は通常のコマンドとして判定し、2番目以降は read-only フィルタ
// （head/tail/wc/grep/rg/sort/awk/cut/uniq/sed/nl/jq/cat/tr）なら許可、
// それ以外（xargs/sh/tee 等の書込・実行系）は無条件で違反として扱う。
function splitCommand(command) {
  const statementSplit = splitOutsideQuotes(command, ["&&", "||", ";"]);
  let unbalanced = statementSplit.unbalanced;
  const primaries = [];
  const pipeFollowers = [];
  for (const stmt of statementSplit.parts) {
    const pipelineSplit = splitOutsideQuotes(stmt, ["|"]);
    unbalanced = unbalanced || pipelineSplit.unbalanced;
    const pipeline = pipelineSplit.parts;
    if (pipeline.length === 0) continue;
    primaries.push(pipeline[0]);
    pipeFollowers.push(...pipeline.slice(1));
  }
  return { primaries, pipeFollowers, unbalanced };
}

const READ_ONLY_PIPE_FILTER = /^(head|tail|wc|grep|rg|sort|awk|cut|uniq|sed|nl|jq|cat|tr)\b/;
const GIT_PREFIX = /^git\b/;

function normalizeResultJson(resultText) {
  const trimmed = resultText.trim();
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```[ \t]*$/.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isFinding(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    "body",
    "file",
    "line_end",
    "line_start",
    "recommendation",
    "severity",
    "title",
  ];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) return false;
  return (
    ["must-fix", "should-fix", "nit"].includes(value.severity) &&
    isNonEmptyString(value.title) &&
    isNonEmptyString(value.body) &&
    isNonEmptyString(value.file) &&
    Number.isInteger(value.line_start) &&
    value.line_start >= 0 &&
    Number.isInteger(value.line_end) &&
    value.line_end >= 0 &&
    typeof value.recommendation === "string"
  );
}

function parseReviewResult(resultText) {
  const normalized = normalizeResultJson(resultText);
  let result;
  try {
    result = JSON.parse(normalized);
  } catch {
    return { error: "結果JSONが単一のJSON objectとして解釈できませんでした" };
  }

  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { error: "結果JSONのトップレベルはobjectでなければなりません" };
  }
  const keys = Object.keys(result).sort();
  const expectedKeys = ["diff_fingerprint", "findings", "summary", "verdict"];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    return { error: "結果JSONの必須欄または許可されない欄が不正です" };
  }
  if (!/^[0-9a-f]{64}$/.test(result.diff_fingerprint) || !["approve", "needs-attention"].includes(result.verdict) || !isNonEmptyString(result.summary) || !Array.isArray(result.findings) || !result.findings.every(isFinding)) {
    return { error: "結果JSONがcross-review schemaに適合しません" };
  }

  const actionableFindingCount = result.findings.filter(
    (finding) => finding.severity === "must-fix" || finding.severity === "should-fix",
  ).length;
  if (
    (result.verdict === "approve" && actionableFindingCount > 0) ||
    (result.verdict === "needs-attention" && actionableFindingCount === 0)
  ) {
    return { error: "結果JSONのverdictとmust-fix / should-fix件数が整合しません" };
  }
  return { result };
}

// denylist（検証・変更系コマンド）に一致する実行だけを違反とする。パイプ後段は read-only
// フィルタなら無視し、それ以外（xargs/sh/tee 等）は無条件で違反に含める。denylist に一致しない
// 非 git コマンド（閲覧系）は違反にせず、hasNonGit で otherCommands 判定に使う。
// --allow パターン（検知器変更レビューの検体照合実行の許可）に一致するサブコマンドは違反にせず
// allowed へ列挙する。解析不能（クォート不均衡・unwrap 不能ラッパー）は allow より優先して違反とする
// （何が実行されたか検証できない実行を許可しない）。
function classifyCommand(command, wrapperUnparseable = false) {
  const { primaries, pipeFollowers, unbalanced } = splitCommand(command);
  if (wrapperUnparseable || unbalanced) {
    return { violation: true, hasNonGit: true, unparseable: true, allowed: [] };
  }
  const isAllowed = (p) => allowPattern != null && allowPattern.test(p);
  const allowed = [...primaries, ...pipeFollowers].filter(isAllowed);
  const violation =
    primaries.some((p) => !isAllowed(p) && pattern.test(p)) ||
    pipeFollowers.some((p) => !isAllowed(p) && !READ_ONLY_PIPE_FILTER.test(p));
  const hasNonGit = primaries.some((p) => !GIT_PREFIX.test(p));
  return { violation, hasNonGit, unparseable: false, allowed };
}

const entries = [];
let parsedLineCount = 0;
for (const line of lines) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    continue; // 壊れた行はスキップして継続
  }
  parsedLineCount += 1;
  entries.push(entry);
}

if (parsedLineCount === 0) {
  console.error("check-review-log: イベントログを解釈できる行がありませんでした");
  process.exit(1);
}

const isClaudeMode = entries.some((e) => e.type === "assistant" || e.type === "result");
const isCodexMode = entries.some((e) => e.type === "item.completed" && ["command_execution", "agent_message"].includes(e.item?.type));

if (!isClaudeMode && !isCodexMode) {
  console.error(
    "check-review-log: claude/codex いずれの認識可能なイベントも見つかりませんでした（ログ解釈不能）",
  );
  process.exit(1);
}

const violations = [];
const deniedAttempts = [];
const otherCommands = [];
const unparseableCommands = [];
const allowedCommands = [];
let lastResultText = null;

function recordClassification(command, classification) {
  const { violation, hasNonGit, unparseable, allowed } = classification;
  allowedCommands.push(...allowed);
  if (violation) {
    violations.push(command);
    if (unparseable) unparseableCommands.push(command);
    return;
  }
  if (hasNonGit) otherCommands.push(command);
}

if (isClaudeMode) {
  // allowedTools はグローバル settings の許可ルールと合成されるため、指定外の閲覧系コマンドも
  // 実行され得る（実測）。sandbox ではなくログの機械判定が正: denylist 一致の実行のみ違反とする。
  // tool_use は denial 前にログへ記録されるため、result.permission_denials と tool_use_id で突合し、
  // 拒否済み（allowedTools が機能した正常系）は violations から除外して deniedAttempts に分離する。
  const deniedToolUseIds = new Set();
  for (const entry of entries) {
    if (entry.type !== "result") continue;
    if (Array.isArray(entry.permission_denials)) {
      for (const d of entry.permission_denials) {
        if (d?.tool_use_id) deniedToolUseIds.add(d.tool_use_id);
      }
    }
    lastResultText = typeof entry.result === "string" ? entry.result : null;
  }

  for (const entry of entries) {
    if (entry.type !== "assistant") continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== "tool_use" || block?.name !== "Bash") continue;
      const command = block.input?.command ?? "";
      // denial 突合は violation 判定より先に行う: denylist 対象外でも拒否された試行は
      // 実行済みとして otherCommands に載せず、分類によらず deniedAttempts へ分離する。
      if (deniedToolUseIds.has(block.id)) {
        deniedAttempts.push(command);
        continue;
      }
      recordClassification(command, classifyCommand(command));
    }
  }
} else if (isCodexMode) {
  // codex exec は閲覧（cat/sed/rg 等）もシェル経由で行うため許可リスト方式は偽陽性になりやすい。
  // 検証・変更系コマンドの denylist に一致した実行だけを違反として扱い、他の非 git コマンドは info 列挙に留める。
  for (const entry of entries) {
    if (entry.type === "item.completed" && entry.item?.type === "agent_message" && typeof entry.item.text === "string") {
      lastResultText = entry.item.text;
      continue;
    }
    if (entry.type !== "item.completed" || entry.item?.type !== "command_execution") continue;
    const unwrapped = unwrapShellCommand(entry.item.command ?? "");
    recordClassification(unwrapped.command, classifyCommand(unwrapped.command, unwrapped.unparseable));
  }
}

let resultError = null;
if (isClaudeMode || isCodexMode) {
  if (lastResultText === null) {
    resultError = "result イベントが見つからず、結果JSONを書き出せませんでした";
  } else {
    const parsedResult = parseReviewResult(lastResultText);
    if (parsedResult.error) {
      resultError = parsedResult.error;
    } else if (resultOutPath) {
      writeFileSync(resultOutPath, JSON.stringify(parsedResult.result, null, 2) + "\n", "utf8");
    }
  }
}

if (resultError) {
  console.error(`check-review-log: ${resultError}`);
}

const report = {
  violationCount: violations.length,
  violations,
  unparseableCommandCount: unparseableCommands.length,
  unparseableCommands,
  allowedCommandCount: allowedCommands.length,
  allowedCommands,
  deniedAttemptCount: deniedAttempts.length,
  deniedAttempts,
  otherCommandCount: otherCommands.length,
  otherCommands,
};
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
process.exit(resultError ? 1 : violations.length > 0 ? 2 : 0);
