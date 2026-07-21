import { readFileSync, writeFileSync } from "node:fs";

const [, , logPath, patternRaw, resultOutPath] = process.argv;

if (!logPath || !patternRaw) {
  console.error(
    [
      "使い方: node check-review-log.mjs <event-log-path> <pattern> [result-out-path]",
      "  <pattern> は claude / codex 両モード共通で検証・変更系コマンドの denylist パターン。一致する実行だけを違反とする。",
      "  denylist に一致しない非 git コマンド（閲覧系）は otherCommands の info 列挙に留め、逸脱にはしない。",
    ].join("\n"),
  );
  process.exit(1);
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

// codex exec --json はシェルラッパー越しにコマンドを渡す（例: /bin/zsh -lc 'git diff --stat HEAD'）。
function unwrapShellCommand(command) {
  const m = /^\/bin\/(?:zsh|bash|sh)\s+-l?c\s+'([\s\S]*)'$/.exec(command);
  return m ? m[1] : command;
}

// シングル/ダブルクォート（ダブルクォート内の \" エスケープを考慮）の外側にある区切りトークンだけで
// 分割する。クォート内の denylist 文字列・正規表現・引数に含まれる ; && || | は分割対象にしない。
// クォート外でもバックスラッシュエスケープされた区切り文字（例: echo foo\|bar の \|）は分割しない
// （\\ の連続も 2 文字単位で消費するため、\\| のような「エスケープされた \」+「素の |」は正しく分割される）。
// separators は長いトークンから順にマッチを試す（|| を | 2つに誤分割しないため）。
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
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

// 複合コマンド（例: git diff HEAD && go test ./...）を ; && || で独立ステートメントに分割し、
// 各ステートメント内はさらに | でパイプ連鎖に分割する（いずれもクォート外のトークンのみで分割）。
// パイプ連鎖の先頭は通常のコマンドとして判定し、2番目以降は read-only フィルタ
// （head/tail/wc/grep/rg/sort/awk/cut/uniq/sed/nl/jq/cat/tr）なら許可、
// それ以外（xargs/sh/tee 等の書込・実行系）は無条件で違反として扱う。
function splitCommand(command) {
  const statements = splitOutsideQuotes(command, ["&&", "||", ";"]);
  const primaries = [];
  const pipeFollowers = [];
  for (const stmt of statements) {
    const pipeline = splitOutsideQuotes(stmt, ["|"]);
    if (pipeline.length === 0) continue;
    primaries.push(pipeline[0]);
    pipeFollowers.push(...pipeline.slice(1));
  }
  return { primaries, pipeFollowers };
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
function classifyCommand(command) {
  const { primaries, pipeFollowers } = splitCommand(command);
  const violation =
    primaries.some((p) => pattern.test(p)) || pipeFollowers.some((p) => !READ_ONLY_PIPE_FILTER.test(p));
  const hasNonGit = primaries.some((p) => !GIT_PREFIX.test(p));
  return { violation, hasNonGit };
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
let lastResultText = null;

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
      const { violation, hasNonGit } = classifyCommand(command);
      if (violation) {
        violations.push(command);
        continue;
      }
      if (hasNonGit) {
        otherCommands.push(command);
      }
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
    const command = unwrapShellCommand(entry.item.command ?? "");
    const { violation, hasNonGit } = classifyCommand(command);
    if (violation) {
      violations.push(command);
      continue;
    }
    if (hasNonGit) {
      otherCommands.push(command);
    }
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
  deniedAttemptCount: deniedAttempts.length,
  deniedAttempts,
  otherCommandCount: otherCommands.length,
  otherCommands,
};
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
process.exit(resultError ? 1 : violations.length > 0 ? 2 : 0);
