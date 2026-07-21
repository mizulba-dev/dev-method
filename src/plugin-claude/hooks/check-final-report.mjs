import { readFileSync } from "node:fs";

function failOpen(message) {
  process.stdout.write(
    JSON.stringify({
      continue: true,
      systemMessage: message,
      suppressOutput: false,
    }),
  );
  process.exit(0);
}

const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}

let input;
try {
  input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
} catch {
  failOpen("報告ゲート判定不能: 入力JSONを解析できませんでした");
}

if (input.hook_event_name !== "SubagentStop") {
  failOpen("報告ゲート判定不能: 対象外のイベントです");
}

// 再入時（前回このhookがブロックし、モデルが応答を試みた後の再終了）は無限ループ防止のためブロックしない
if (input.stop_hook_active === true) {
  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
}

const agentTranscriptPath = input.agent_transcript_path;
if (typeof agentTranscriptPath !== "string" || agentTranscriptPath.length === 0) {
  failOpen("報告ゲート判定不能: agent_transcript_path がありません");
}

let raw;
try {
  raw = readFileSync(agentTranscriptPath, "utf8");
} catch {
  failOpen("報告ゲート判定不能: transcriptを読み込めませんでした");
}

const role = input.agent_type === "dev-method-claude:reviewer" ? "reviewer" : "implementer";
const requiredLabels =
  role === "reviewer"
    ? ["レビュー完了報告", "diff指紋", "指摘", "承認可否"]
    : ["完了報告", "検証証跡", "逸脱", "未達事項"];

function isWorkInstruction(entry, content) {
  if (entry?.type !== "user") return false;
  const fromCoordinator = entry?.origin?.kind === "coordinator";
  if (entry?.isMeta === true && !fromCoordinator) return false;
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  if (content.some((block) => block?.type === "tool_result")) return false;
  return content.some((block) => block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0);
}

function sendMessageBody(inputValue) {
  if (typeof inputValue?.message === "string") return inputValue.message;
  if (
    typeof inputValue === "object" &&
    inputValue !== null &&
    !("message" in inputValue) &&
    typeof inputValue.content === "string"
  ) {
    return inputValue.content;
  }
  return null;
}

function hasRequiredLabels(body) {
  return requiredLabels.every((label) => new RegExp(`^${label}:`, "m").test(body));
}

// 「認識可能な行」は実作業指示、または message.content 配列を持つ行に限定する。
// スキーマが未知形式に変わり JSON は parse できても該当行が無い場合は、判定材料が無いので
// fail-open 側に倒す。壊れた JSON 行は従来どおりスキップする。
let recognizedLineCount = 0;
let latestInstructionLine = -1;
const sendMessages = [];
const lines = raw.split("\n");
for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
  const line = lines[lineNumber];
  if (line.trim().length === 0) continue;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    continue; // 壊れた行はスキップして継続
  }
  const content = entry?.message?.content;
  const workInstruction = isWorkInstruction(entry, content);
  const messageLine = Array.isArray(content);
  if (!workInstruction && !messageLine) continue;
  recognizedLineCount += 1;
  if (workInstruction) latestInstructionLine = lineNumber;
  if (!messageLine) continue;
  for (const block of content) {
    if (block?.type === "tool_use" && block?.name === "SendMessage") {
      sendMessages.push({ lineNumber, body: sendMessageBody(block.input) });
    }
  }
}

// transcript は読めたが認識可能な行が1つも無い場合は判定材料が無い（fail-open）。
// ブロックは「1行以上認識できた上で SendMessage が無い」ときだけに限定する。
if (recognizedLineCount === 0) {
  failOpen("報告ゲート判定不能: transcriptに解釈可能な行がありませんでした");
}

const hasCompleteReport = sendMessages.some(
  ({ lineNumber, body }) => lineNumber > latestInstructionLine && typeof body === "string" && hasRequiredLabels(body),
);
if (hasCompleteReport) {
  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
}

console.error(
  `最新の実作業指示より後に、${requiredLabels.map((label) => `${label}:`).join("・")} を各行頭に置いた最終報告を SendMessage でリーダーへ送信してから終了する。`,
);
process.exit(2);
