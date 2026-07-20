const chunks = [];

for await (const chunk of process.stdin) {
  chunks.push(chunk);
}

let input;

try {
  input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
} catch {
  console.error("SubagentStop hook: 入力JSONを解析できませんでした");
  process.exit(1);
}

if (input.hook_event_name !== "SubagentStop") {
  console.error("SubagentStop hook: 対象外のイベントです");
  process.exit(1);
}

const agentType =
  typeof input.agent_type === "string" && input.agent_type.length > 0
    ? input.agent_type
    : "subagent";
const model =
  typeof input.model === "string" && input.model.length > 0
    ? input.model
    : null;
const agentId =
  typeof input.agent_id === "string" && input.agent_id.length > 0
    ? input.agent_id.slice(0, 8)
    : "unknown";

process.stdout.write(
  JSON.stringify({
    continue: true,
    systemMessage: `サブエージェント ${agentType}${model ? ` / ${model}` : ""}（${agentId}）が終了しました。結果は親スレッドへ配送されます。`,
    suppressOutput: false,
  }),
);
