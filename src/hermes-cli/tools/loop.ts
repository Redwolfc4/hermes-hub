import { getAllTools, getToolSchema, getTool, parseToolCall } from "./schema.ts";
import { ROUTER_LOCAL_CONFIG, BLUE_ARCHIVE_AGENTS } from "../../config/agents.ts";
import { read_file, write_file, list_dir, shell, git_status, git_diff, git_log } from "./index.ts";

type Message = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
};

const TOOL_USE_PROMPT = `You are a reasoning agent that can make tool calls. Use the available tools to gather information and complete tasks.

Workspace operating context:
- The current workspace is the Qualita Odoo monorepo at the process working directory.
- erp-api is Go + Fiber v2 + GORM + PostgreSQL + Redis + JWT + MinIO.
- erp-app is Next.js App Router + React + TypeScript + Tailwind + TanStack Query.
- Follow repository instructions from .opencode/project-instructions.md, .opencode/AGENTS.md, and relevant global agent/skill configuration when present. Read them with read_file before planning changes.
- Inspect prd/ before feature work. For non-trivial work inspect plans/ and write a plan/changelog only when the user requests implementation.

Orchestration policy:
- Do not pretend to be a subagent. For feature work, report a concrete delegation plan using the available agents: arona-scout, yuka-planner, rin-architect, noa-database, maki-backend, momoi-frontend, utaha-qa, karin-reviewer, tsurugi-security, kotori-docs.
- Delegate DB work to noa-database, backend work to maki-backend, frontend work to momoi-frontend, QA to utaha-qa, review to karin-reviewer, security to tsurugi-security, documentation to kotori-docs.
- Before any implementation, inspect real files and route the work to the correct layer. Never claim a tool, MCP server, skill, file change, or test ran unless the tool returned evidence.
- For architecture questions, return the repository structure, affected files, boundaries, risks, and next agent assignments.

Available Tools:
- read_file(path): Read a file and get its content
- write_file(path, content): Write content to a file
- list_dir(path): List directory contents
- shell(cmd, timeout): Execute a shell command
- git_status(): Show git status
- git_diff(): Show git diff
- git_log(n): Show recent git commits
- search_workspace(pattern, path): Search repository source files

Never emit terminal, DSML, XML, or shell pseudo-tool calls. Use native tool_calls only.
For a file request, call read_file directly. Do not call shell to emulate read_file.
Never ask the user to run a command or offer a command instead of executing tools.
If read_file reports exists=false, immediately use list_dir or shell to locate the requested file, then read every matching candidate with read_file. Continue until the task is complete.
If the requested file is absent, state that clearly only after checking the current directory and likely descendants. End with a concise result, not a question.

To use a tool, output ONLY this JSON format (no markdown, no explanation):
{"name": "tool_name", "arguments": {"param1": "value1"}}

After receiving tool results, continue reasoning. When task is complete, output ONLY the final answer text (no JSON).

Rules:
- Do NOT use shell or read_file to access paths outside workspace
- Always explain briefly before making a tool call
- Wait for tool result before continuing reasoning
`;

async function executeToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  const tool = getTool(name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.handler(args);
}

async function runAgentLoop(prompt: string, agentId: string = "hermes-prime", model?: string) {
  const agent = BLUE_ARCHIVE_AGENTS.find((a) => a.id === agentId) ?? BLUE_ARCHIVE_AGENTS[0]!;
  const modelId = model || agent.defaultModel || ROUTER_LOCAL_CONFIG.defaultModel;

  console.log(`\x1b[36m🚀 Hermes Agent Loop Started\x1b[0m`);
  console.log(`Agent: ${agent.name} (${agent.role})`);
  console.log(`Model: ${modelId}`);
  console.log(`Tools: ${getAllTools().map((t) => t.name).join(", ")}`);
  console.log("");

  const messages: Message[] = [
    { role: "system", content: TOOL_USE_PROMPT + "\n" + agent.systemPrompt },
    { role: "user", content: prompt },
  ];

  for (let iteration = 0; iteration < 20; iteration++) {
    const body = {
      model: modelId,
      messages,
      tools: getToolSchema(),
      tool_choice: "auto",
      temperature: 0.6,
      stream: false,
    };

    const res = await fetch(`${ROUTER_LOCAL_CONFIG.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${ROUTER_LOCAL_CONFIG.apiKey}` },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    let reply = "";
    let message: { content?: string | null; tool_calls?: Array<{ id: string; function?: { name?: string; arguments?: string } }> } | undefined;

    try {
      const data = JSON.parse(raw);
      message = data.choices?.[0]?.message;
      reply = message?.content || "";
    } catch (_) {}

    // Handle native tool_calls from provider
    if (message?.tool_calls?.length) {
      messages.push({ role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls });
      for (const tc of message.tool_calls) {
        const name = tc.function?.name;
        if (!name) continue;
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.function?.arguments || "{}"); } catch (_) {}
        console.log(`\x1b[33m🔧 Tool Call: ${name}(${JSON.stringify(args)})\x1b[0m`);
        try {
          const result = await executeToolCall(name, args);
          const resultStr = typeof result === "string" ? result : JSON.stringify(result, null, 2);
          messages.push({ role: "tool", tool_call_id: tc.id, content: resultStr.slice(0, 12000) });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ error }) });
        }
      }
      continue;
    }

    if (!reply) {
      console.log("No response from model.");
      break;
    }

    // Fallback: try parsing JSON text tool call
    const parsedCall = parseToolCall(reply);
    if (parsedCall) {
      const { name, args } = parsedCall;
      console.log(`\x1b[33m🔧 Text Tool Call: ${name}(${JSON.stringify(args)})\x1b[0m`);
      try {
        const result = await executeToolCall(name, args);
        const resultStr = JSON.stringify(result, null, 2).slice(0, 4000);
        messages.push({ role: "assistant", content: reply });
        messages.push({ role: "user", content: `Tool result for ${name}: ${resultStr}` });
      } catch (err: any) {
        messages.push({ role: "assistant", content: reply });
        messages.push({ role: "user", content: `Tool error for ${name}: ${err.message}` });
      }
      continue;
    }

    // No tool call — final answer
    console.log(`\x1b[35m[${agent.name}]:\x1b[0m`);
    console.log(reply);
    break;
  }
}

async function runDirectMode() {
  const args = process.argv.slice(2);
  const agentFlag = args.findIndex(a => a === "--agent" || a === "-a");
  const modelFlag = args.findIndex(a => a === "--model" || a === "-m");
  const hasDirectPrompt = args.filter((_, idx) => idx !== agentFlag && idx !== agentFlag + 1 && idx !== modelFlag && idx !== modelFlag + 1).length > 0;

  if (!hasDirectPrompt) return;

  const promptArg = args.filter((_, idx) => idx !== agentFlag && idx !== agentFlag + 1 && idx !== modelFlag && idx !== modelFlag + 1).join(" ");
  const agentId = agentFlag !== -1 ? args[agentFlag + 1] : "hermes-prime";
  const agent = BLUE_ARCHIVE_AGENTS.find(a => a.id === agentId) ?? BLUE_ARCHIVE_AGENTS[0]!;
  const model = modelFlag !== -1 ? args[modelFlag + 1] : agent.defaultModel;

  await runAgentLoop(promptArg, agentId, model);
}

export { runAgentLoop, runDirectMode };
export { getAllTools, getToolSchema, parseToolCall };
export { read_file, write_file, list_dir, shell, git_status, git_diff, git_log };
