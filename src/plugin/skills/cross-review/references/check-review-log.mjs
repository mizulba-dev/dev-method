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

// POSIX 系クォート規則でコマンド文字列を語へ分解する（展開はせずクォート除去のみ）。シングルクォート内は
// 無エスケープ、ダブルクォート内は \\ \" \$ \` だけ復元、クォート外の \ は次の1文字をエスケープする。
// クォート連結（'a'"b"c → abc）は1語に畳む。未終端クォートは unterminated で返し、呼び出し側で
// fail-closed（違反扱い）にする。
function tokenizeShellWords(command) {
  const words = [];
  let current = null; // null = 語未開始（空のクォート '' も1語にするため '' と区別する）
  let quote = null;
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\" && i + 1 < command.length && '\\"$`'.includes(command[i + 1])) {
        current += command[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') quote = null;
      else current += ch;
      i += 1;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      current = (current ?? "") + command[i + 1];
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current = current ?? "";
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current != null) {
        words.push(current);
        current = null;
      }
      i += 1;
      continue;
    }
    current = (current ?? "") + ch;
    i += 1;
  }
  if (current != null) words.push(current);
  return { words, unterminated: quote !== null };
}

// codex exec --json はシェルラッパー越しにコマンドを渡す（例: /bin/zsh -lc 'git diff --stat HEAD' /
// /bin/zsh -lc "sed \"...\" file | node ..."）。payload はクォート連結（'a'"b"' c' 等）を含み得るため
// 正規表現でなく tokenizeShellWords でクォート除去し、`<shell> -lc <payload>` の第3語を取り出す。
// ラッパー形式なのに payload を取り出せないコマンドは解析不能（unparseable）として呼び出し側で
// fail-closed（違反扱い）にする。
function unwrapShellCommand(command) {
  const wrapperLike = /^\/bin\/(?:zsh|bash|sh)\s+-l?c(\s|$)/.test(command);
  if (!wrapperLike) return { command, unparseable: false };
  const { words, unterminated } = tokenizeShellWords(command);
  // ちょうど3語だけを許す。payload 後の余剰 argv 語（`-lc 'eval "$0"' 'npm test'` の positional 引数）は
  // payload 経由で実行され得るのに判定対象から漏れるため、fail-closed で解析不能に倒す。
  if (!unterminated && words.length === 3 && /^\/bin\/(?:zsh|bash|sh)$/.test(words[0]) && /^-l?c$/.test(words[1])) {
    return { command: words[2], unparseable: false };
  }
  return { command, unparseable: true };
}

// シングルクォート外の live substitution（$(...)・`...`・<(...)・>(...)）の本体を列挙する。ダブルクォート内も
// 実行時に展開されるため不活性にしない。\ エスケープ（\$・\`）は不活性。$( と <( >( は対応する ) まで depth で
// 追い、閉じない場合は unbalanced（fail-closed で違反扱い）にする。
function extractSubstitutions(command) {
  const bodies = [];
  let quote = null; // "'" のみ不活性化に使う（ダブルクォートは live）
  let i = 0;
  const readParen = (start) => {
    let depth = 1;
    let q = null;
    let j = start;
    while (j < command.length) {
      const c = command[j];
      if (q === "'") {
        if (c === "'") q = null;
        j += 1;
        continue;
      }
      if (c === "\\") { j += 2; continue; }
      if (c === "'") { q = c; j += 1; continue; }
      if (c === "(") depth += 1;
      else if (c === ")") {
        depth -= 1;
        if (depth === 0) return { body: command.slice(start, j), end: j + 1 };
      }
      j += 1;
    }
    return null;
  };
  while (i < command.length) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      i += 1;
      continue;
    }
    if (ch === "\\") { i += 2; continue; }
    if (ch === "'") { quote = ch; i += 1; continue; }
    if ((ch === "$" || ch === "<" || ch === ">") && command[i + 1] === "(") {
      const paren = readParen(i + 2);
      if (!paren) return { bodies, unbalanced: true };
      bodies.push(paren.body);
      i = paren.end;
      continue;
    }
    if (ch === "`") {
      const close = command.indexOf("`", i + 1);
      if (close === -1) return { bodies, unbalanced: true };
      bodies.push(command.slice(i + 1, close));
      i = close + 1;
      continue;
    }
    i += 1;
  }
  return { bodies, unbalanced: false };
}

// シングル・ダブル両クォートの外にある書込リダイレクト（> / >>）を検出する。`>&2` 等の fd 複製は書込先が
// 既存ストリームのため許可し、ファイルへの > / >> だけを拒否する。
function hasWriteRedirect(command) {
  let quote = null;
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (quote) {
      if (ch === "\\" && quote === '"') { i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "\\") { i += 2; continue; }
    if (ch === "'" || ch === '"') { quote = ch; i += 1; continue; }
    if (ch === ">") {
      if (command[i + 1] === "&" && /\d/.test(command[i + 2] ?? "")) { i += 3; continue; }
      return true;
    }
    i += 1;
  }
  return false;
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

// 制御構文・前置形の実行位置を剥がしてから本体コマンドを判定する。`do go test`・`case x in x) npm test`・
// `{ npm test`・`(npm test)`・`FOO=1 npm test`・`! npm test` のような前置で denylist の ^ アンカーが
// 素通りする false green と、`do sed …` の正当な閲覧系がコマンドとして判定されない両方を防ぐ。
// keyword 単独のステートメント（done/fi 等）はコマンドではない。case のアーム前置 `pattern)` は
// case の外では文法エラーになる形のため、剥がしても正当コマンドを壊さない。
const CONTROL_PREFIX = new RegExp(
  [
    "^(?:do|then|else|elif|if|while|until|time|!)\\s+",
    "^[{(]\\s*",
    "^[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+",
    "^case\\s+\\S+\\s+in\\s+",
    "^[^()|;&\\s]*\\)\\s*",
  ].join("|"),
);
const CONTROL_ONLY = /^(?:do|done|then|fi|else|esac|!|\{|\}|\(|\))$/;

function stripControlPrefix(statement) {
  let out = statement;
  while (CONTROL_PREFIX.test(out)) out = out.replace(CONTROL_PREFIX, "");
  return out;
}

// 複合コマンド（例: git diff HEAD && go test ./...）を ; && || で独立ステートメントに分割し、
// 各ステートメント内はさらに | でパイプ連鎖に分割する（いずれもクォート外のトークンのみで分割）。
// パイプ連鎖の先頭は制御 keyword を剥がして通常のコマンドとして判定し、2番目以降は read-only フィルタ
// （head/tail/wc/grep/rg/sort/awk/cut/uniq/sed/nl/jq/cat/tr）なら許可、`sh -c` / `xargs … sh -c` は
// classifyShellFollower で内側 payload が全部閲覧系の場合だけ許可、それ以外（tee 等の書込・実行系）は
// 無条件で違反として扱う。
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
    const head = stripControlPrefix(pipeline[0]);
    if (head.length > 0 && !CONTROL_ONLY.test(head)) primaries.push(head);
    pipeFollowers.push(...pipeline.slice(1));
  }
  return { primaries, pipeFollowers, unbalanced };
}

const READ_ONLY_PIPE_FILTER = /^(head|tail|wc|grep|rg|sort|awk|cut|uniq|sed|nl|jq|cat|tr)\b/;
// sh -c の内側 payload に許す閲覧系（パイプ後段フィルタ＋出力系 echo/printf）。
const READ_ONLY_INNER = /^(echo|printf|head|tail|wc|grep|rg|sort|awk|cut|uniq|sed|nl|jq|cat|tr)\b/;
const GIT_PREFIX = /^git\b/;

// 閲覧系 head でも書込になる in-place フラグ（sed -i / sort -o / awk -i inplace）は read-only にしない。
function hasInPlaceFlag(statement) {
  const { words } = tokenizeShellWords(statement);
  const head = words[0] ?? "";
  if (/^sed$/.test(head)) return words.some((w) => /^-i/.test(w) || /^--in-place/.test(w));
  if (/^sort$/.test(head)) return words.some((w) => w === "-o" || /^--output/.test(w));
  if (/^awk$/.test(head)) return words.some((w) => w === "-i" || w === "inplace");
  return false;
}

// sh -c 内側 payload の許可条件（allowlist 文脈）: 全サブコマンドが閲覧系 head かつ in-place フラグなし、
// live substitution（$()・バッククォート・<() >()）なし、ファイルへの書込リダイレクト（> / >>）なし。
function innerPayloadReadOnly(payload) {
  const inner = splitCommand(payload);
  if (inner.unbalanced) return { readOnly: false, unparseable: true };
  const substitutions = extractSubstitutions(payload);
  if (substitutions.unbalanced) return { readOnly: false, unparseable: true };
  const statements = [...inner.primaries, ...inner.pipeFollowers];
  const readOnly =
    inner.primaries.length > 0 &&
    substitutions.bodies.length === 0 &&
    !hasWriteRedirect(payload) &&
    statements.every((p) => READ_ONLY_INNER.test(p) && !hasInPlaceFlag(p));
  return { readOnly, unparseable: false };
}

// 引数を取る xargs オプションの分離形式（-n 1 等）。結合形式（-n1）は startsWith('-') の読み飛ばしで足りる。
const XARGS_FLAG_WITH_ARG = /^-(n|L|P|I|s|d|a|E|e)$/;

// パイプ後段の `sh -c '<payload>'` / `xargs [flags] sh -c '<payload>'` は、引用 payload を同じ規則で
// 再解析し、innerPayloadReadOnly の全条件を満たす場合だけ read-only として許可する。
// payload の欠落・未終端クォート・分割不能は unparseable（fail-closed で違反）、実行系の混入は違反。
function classifyShellFollower(follower) {
  const { words, unterminated } = tokenizeShellWords(follower);
  if (unterminated) return { readOnly: false, unparseable: true };
  let index = 0;
  const startedWithXargs = words[index] === "xargs";
  if (startedWithXargs) {
    index += 1;
    while (index < words.length && words[index].startsWith("-")) {
      if (XARGS_FLAG_WITH_ARG.test(words[index])) index += 1;
      index += 1;
    }
  }
  if (!(index < words.length && /^(?:\/bin\/|\/usr\/bin\/)?(?:zsh|bash|sh)$/.test(words[index]))) {
    // xargs 直接実行形（xargs rg -n … 等）: 実行対象 head が閲覧系なら sh -c payload と同じ read-only 条件
    //（in-place フラグ・live substitution・書込リダイレクトなし）で許可する。
    if (startedWithXargs && index < words.length) {
      const substitutions = extractSubstitutions(follower);
      const readOnly =
        READ_ONLY_INNER.test(words[index]) &&
        !hasInPlaceFlag(words.slice(index).join(" ")) &&
        !substitutions.unbalanced &&
        substitutions.bodies.length === 0 &&
        !hasWriteRedirect(follower);
      return { readOnly, unparseable: false };
    }
    return { readOnly: false, unparseable: false };
  }
  index += 1;
  if (index >= words.length || !/^-l?c$/.test(words[index])) return { readOnly: false, unparseable: false };
  index += 1;
  if (index >= words.length) return { readOnly: false, unparseable: true };
  return innerPayloadReadOnly(words[index]);
}

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
// フィルタなら無視し、`sh -c` / `xargs … sh -c` は内側 payload が全部閲覧系の場合だけ許可、
// それ以外（tee 等の書込・実行系）は無条件で違反に含める。denylist に一致しない
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
  let violation = primaries.some((p) => !isAllowed(p) && pattern.test(p));
  let unparseable = false;
  for (const p of pipeFollowers) {
    if (isAllowed(p) || READ_ONLY_PIPE_FILTER.test(p)) continue;
    const follower = classifyShellFollower(p);
    if (follower.readOnly) continue;
    violation = true;
    if (follower.unparseable) unparseable = true;
  }
  // live substitution（$()・バッククォート・<() >()）の本体を再帰分類する。primary 自体は denylist に一致
  // しなくても、置換本体に denylist 実行を隠す迂回（例: echo "$(npm test)"）を実行位置として検知する。
  const substitutions = extractSubstitutions(command);
  if (substitutions.unbalanced) {
    violation = true;
    unparseable = true;
  }
  for (const body of substitutions.bodies) {
    const sub = classifyCommand(body);
    allowed.push(...sub.allowed);
    if (sub.violation) {
      violation = true;
      if (sub.unparseable) unparseable = true;
    }
  }
  const hasNonGit = primaries.some((p) => !GIT_PREFIX.test(p));
  return { violation, hasNonGit, unparseable, allowed };
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
