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

let sawSendMessage = false;
// 「認識可能な行」は JSON.parse が通っただけでなく message.content 配列を持つ行に限定する。
// スキーマが未知形式に変わり JSON は parse できても content 配列が無い場合、判定材料が無いのと
// 同じなので fail-open 側に倒す。SendMessage 判定の分母と fail-open 判定を同じ基準に揃える。
let recognizedLineCount = 0;
for (const line of raw.split("\n")) {
  if (line.trim().length === 0) continue;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    continue; // 壊れた行はスキップして継続
  }
  const content = entry?.message?.content;
  if (!Array.isArray(content)) continue;
  recognizedLineCount += 1;
  for (const block of content) {
    if (block?.type === "tool_use" && block?.name === "SendMessage") {
      sawSendMessage = true;
      break;
    }
  }
  if (sawSendMessage) break;
}

if (sawSendMessage) {
  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
}

// transcript は読めたが認識可能な行が1つも無い場合は判定材料が無い（fail-open）。
// ブロックは「1行以上認識できた上で SendMessage が無い」ときだけに限定する。
if (recognizedLineCount === 0) {
  failOpen("報告ゲート判定不能: transcriptに解釈可能な行がありませんでした");
}

console.error(
  "最終報告を SendMessage でリーダーへ送信してから終了する。手順どおり、変更ファイル一覧・検証証跡・逸脱・未達事項を含む最終報告を送るまでこのターンは完了していない。",
);
process.exit(2);
