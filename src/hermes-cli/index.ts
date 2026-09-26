#!/usr/bin/env bun
import { ROUTER_LOCAL_CONFIG, BLUE_ARCHIVE_AGENTS } from "../config/agents";
import * as readline from "readline";
import { runAgentLoop, getAllTools, getToolSchema } from "./tools/loop";
import { shell } from "./tools/shell";

const args = process.argv.slice(2);

// Check if running direct flags vs interactive menu
const agentFlag = args.findIndex(a => a === "--agent" || a === "-a");
const modelFlag = args.findIndex(a => a === "--model" || a === "-m");
const hasDirectPrompt = args.filter((_, idx) => idx !== agentFlag && idx !== agentFlag + 1 && idx !== modelFlag && idx !== modelFlag + 1).length > 0;

if (hasDirectPrompt || args.includes("--tools") || args.includes("-t") || args.includes("--shell") || args.includes("-s")) {
  runDirectMode();
} else {
  runInteractiveMenu();
}

async function runDirectMode() {
  const promptArg = args.filter((_, idx) => idx !== agentFlag && idx !== agentFlag + 1 && idx !== modelFlag && idx !== modelFlag + 1).join(" ");
  const agentId = agentFlag !== -1 ? args[agentFlag + 1] : "rinna-chan";
  const agent = BLUE_ARCHIVE_AGENTS.find(a => a.id === agentId) ?? BLUE_ARCHIVE_AGENTS[0]!;
  const model = (modelFlag !== -1 ? args[modelFlag + 1] : undefined) || agent.defaultModel || ROUTER_LOCAL_CONFIG.defaultModel;

  await runAgentLoop(promptArg, agent.id, model);
}

// ----------------------------------------------------
// Interactive Terminal Picker (Terminal UI)
// ----------------------------------------------------
async function runInteractiveMenu() {
  console.clear();
  console.log("\x1b[38;5;213m╔══════════════════════════════════════════════════════════════╗\x1b[0m");
  console.log("\x1b[38;5;213m║       🌸 HERMES HUB CLI — Blue Archive Agent Selector        ║\x1b[0m");
  console.log("\x1b[38;5;213m╚══════════════════════════════════════════════════════════════╝\x1b[0m\n");

  const agentIdx = await promptSelect(
    "Pilih Agent Blue Archive untuk Dijalankan:",
    BLUE_ARCHIVE_AGENTS.map((a, i) => `${a.avatar} \x1b[1m${a.name}\x1b[0m — \x1b[36m${a.title}\x1b[0m (\x1b[90m${a.specialty}\x1b[0m)`)
  );

  const selectedAgent = BLUE_ARCHIVE_AGENTS[agentIdx];
  if (!selectedAgent) return;
  console.log(`\n\x1b[32m✔ Terpilih:\x1b[0m ${selectedAgent.avatar} \x1b[1m${selectedAgent.name}\x1b[0m (${selectedAgent.role})\n`);

  // Fetch available models from 9Router
  let models = [selectedAgent.defaultModel, "ag/gemini-3.8-flash-high", "ag/gemini-3.8-flash-low", "cx/gpt-5.6-sol", "free-combo1"];
  try {
    const res = await fetch(`${ROUTER_LOCAL_CONFIG.baseUrl}/models`, {
      headers: { "Authorization": `Bearer ${ROUTER_LOCAL_CONFIG.apiKey}` }
    });
    if (res.ok) {
      const data = await res.json() as any;
      if (Array.isArray(data.data) && data.data.length > 0) {
        models = data.data.map((m: any) => m.id);
        // Put default model at top if present
        models = [selectedAgent.defaultModel, ...models.filter(m => m !== selectedAgent.defaultModel)];
      }
    }
  } catch (_) {}

  const modelIdx = await promptSelect(
    `Pilih Model 9Router untuk ${selectedAgent.name}:`,
    models.slice(0, 10).map((m, i) => `${m === selectedAgent.defaultModel ? "\x1b[33m★ (Default)\x1b[0m " : ""}${m}`)
  );
  const selectedModel = models[modelIdx];
  if (!selectedModel) return;

  console.log(`\x1b[32m✔ Model Aktif:\x1b[0m \x1b[33m${selectedModel}\x1b[0m\n`);
  console.log("\x1b[35m--------------------------------------------------------------\x1b[0m");
  console.log(`🌸 Sesi Chat Dimulai dengan \x1b[1m${selectedAgent.name}\x1b[0m! (Ketik 'exit' atau Ctrl+C untuk keluar)\n`);

  startChatSession(selectedAgent, selectedModel);
}

// Interactive Radio / List Picker with Up/Down Arrow & Enter
function promptSelect(title: string, options: string[]): Promise<number> {
  return new Promise((resolve) => {
    let cursor = 0;
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);

    function render() {
      // Clear previous lines
      process.stdout.write(`\x1b[1m${title}\x1b[0m (Gunakan ↑ / ↓ lalu tekan Enter):\n`);
      options.forEach((opt, idx) => {
        if (idx === cursor) {
          process.stdout.write(` \x1b[38;5;213m❯ \x1b[1m${opt}\x1b[0m\n`);
        } else {
          process.stdout.write(`   \x1b[90m${stripAnsi(opt)}\x1b[0m\n`);
        }
      });
    }

    render();

    const onKeypress = (str: string, key: any) => {
      if (key.name === "up") {
        cursor = (cursor - 1 + options.length) % options.length;
        readline.moveCursor(process.stdout, 0, -(options.length + 1));
        render();
      } else if (key.name === "down") {
        cursor = (cursor + 1) % options.length;
        readline.moveCursor(process.stdout, 0, -(options.length + 1));
        render();
      } else if (key.name === "return") {
        cleanup();
        resolve(cursor);
      } else if (key.ctrl && key.name === "c") {
        cleanup();
        process.exit(0);
      }
    };

    function cleanup() {
      process.stdin.removeListener("keypress", onKeypress);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      rl.close();
    }

    process.stdin.on("keypress", onKeypress);
  });
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

// Continuous Interactive Chat Session
function startChatSession(agent: any, model: string) {
  const conversation: { role: string; content: string }[] = [
    { role: "system", content: agent.systemPrompt }
  ];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const promptUser = () => {
    rl.question(`\x1b[1mSensei:\x1b[0m `, async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed.toLowerCase() === "exit" || trimmed.toLowerCase() === "quit") {
        console.log(`\n\x1b[35m[${agent.name}]:\x1b[0m Sampai jumpa, Sensei! Mata ne~ ✨`);
        rl.close();
        process.exit(0);
      }

      // Route interactive prompts through the same native tool loop as direct mode.
      try {
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        await runAgentLoop(trimmed, agent.id, model);
      } catch (err) {
        readline.clearLine(process.stdout, 0);
        console.error(`\x1b[31m[Hermes error]:\x1b[0m`, err instanceof Error ? err.message : String(err));
      }
      promptUser();
      return;

      conversation.push({ role: "user", content: trimmed });
      process.stdout.write(`\x1b[90m${agent.name} sedang berpikir via 9Router...\x1b[0m\r`);

      try {
        const res = await fetch(`${ROUTER_LOCAL_CONFIG.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${ROUTER_LOCAL_CONFIG.apiKey}`
          },
          body: JSON.stringify({
            model: model,
            messages: conversation,
            temperature: 0.7,
            stream: false
          })
        });

        const rawText = await res.text();
        let reply = "";
        try {
          const data = JSON.parse(rawText);
          reply = data.choices?.[0]?.message?.content || "";
        } catch (_) {
          if (rawText.includes("data:")) {
            const lines = rawText.split("\n");
            for (const line of lines) {
              const trimmedLine = line.trim();
              if (trimmedLine.startsWith("data:") && !trimmedLine.includes("[DONE]")) {
                try {
                  const chunk = JSON.parse(trimmedLine.slice(5).trim());
                  reply += chunk.choices?.[0]?.delta?.content || "";
                } catch (_) {}
              }
            }
          }
        }

        if (!reply) reply = rawText.trim() || "(No response)";

        conversation.push({ role: "assistant", content: reply });

        // Clear "sedang berpikir" text
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);

        console.log(`\x1b[1m\x1b[38;5;213m[${agent.name}]\x1b[0m:`);
        console.log(`${reply}\n`);
      } catch (err: any) {
        readline.clearLine(process.stdout, 0);
        console.error(`\x1b[31m[Error 9Router]:\x1b[0m`, err.message);
      }

      promptUser();
    });
  };

  promptUser();
}

async function executeQuery(agent: any, model: string, promptText: string) {
  const hasToolMode = promptText.includes("{{TOOL_LOOP}}");
  if (hasToolMode) {
    const cleanPrompt = promptText.replace("{{TOOL_LOOP}}", "").trim();
    await runAgentLoop(cleanPrompt, agent.id, model);
    return;
  }

  console.log(`\x1b[36mAgent:\x1b[0m ${agent.avatar} ${agent.name} (${agent.title})`);
  console.log(`\x1b[33mModel:\x1b[0m ${model}`);
  console.log(`\x1b[90mPrompt:\x1b[0m ${promptText}\n`);

  try {
    const res = await fetch(`${ROUTER_LOCAL_CONFIG.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${ROUTER_LOCAL_CONFIG.apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: "system", content: agent.systemPrompt },
          { role: "user", content: promptText }
        ],
        temperature: 0.7,
        stream: false
      })
    });

    const rawText = await res.text();
    let reply = "";
    try {
      const data = JSON.parse(rawText);
      reply = data.choices?.[0]?.message?.content || "";
    } catch (_) {
      if (rawText.includes("data:")) {
        const lines = rawText.split("\n");
        for (const line of lines) {
          const t = line.trim();
          if (t.startsWith("data:") && !t.includes("[DONE]")) {
            try {
              const chunk = JSON.parse(t.slice(5).trim());
              reply += chunk.choices?.[0]?.delta?.content || "";
            } catch (_) {}
          }
        }
      }
    }
    if (!reply) reply = rawText.trim();
    console.log(`\x1b[1m\x1b[35m[${agent.name}]\x1b[0m:`);
    console.log(reply);
  } catch (err: any) {
    console.error(`\x1b[31mError:\x1b[0m`, err.message);
  }
}

// ----------------------------------------------------
// Tool Mode: --tools flag prints available tools and schema
// ----------------------------------------------------
const toolsFlag = args.findIndex(a => a === "--tools" || a === "-t");
if (toolsFlag !== -1) {
  console.log(JSON.stringify({ tools: getToolSchema() }, null, 2));
  process.exit(0);
}

// ----------------------------------------------------
// Shell Mode: --shell "cmd" executes command directly
// ----------------------------------------------------
const shellFlag = args.findIndex(a => a === "--shell" || a === "-s");
if (shellFlag !== -1) {
  const cmd = args[shellFlag + 1];
  if (!cmd) {
    console.error("Usage: bun run src/hermes-cli/index.ts --shell \"command\"");
    process.exit(1);
  }
  shell(cmd, 30000).then((res) => {
    if (res.stdout) console.log(res.stdout);
    if (res.stderr) console.error(res.stderr);
    process.exit(res.exitCode);
  }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
