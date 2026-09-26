import {
  read_file,
  write_file,
  list_dir,
  shell,
  git_status,
  git_diff,
  git_log,
  git_log_with_stats,
} from "./index.ts";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  handler: (...args: any[]) => Promise<any>;
}

const tools: Record<string, ToolDefinition> = {
  read_file: {
    name: "read_file",
    description: "Read a file from the workspace. Returns content, existence, and size.",
    parameters: {
      path: { type: "string", description: "Relative path to the file", required: true },
    },
    handler: async (args: any) => read_file(args.path),
  },
  write_file: {
    name: "write_file",
    description: "Write content to a file in the workspace. Creates parent directories.",
    parameters: {
      path: { type: "string", description: "Relative path to the file", required: true },
      content: { type: "string", description: "Content to write", required: true },
    },
    handler: async (args: any) => write_file(args.path, args.content),
  },
  list_dir: {
    name: "list_dir",
    description: "List directory contents. Returns entries with name and isDir.",
    parameters: {
      path: { type: "string", description: "Relative path to directory", required: false },
    },
    handler: async (args: any) => list_dir(args.path || ""),
  },
  shell: {
    name: "shell",
    description: "Execute a shell command with timeout. Returns stdout, stderr, and exitCode.",
    parameters: {
      cmd: { type: "string", description: "Command string to execute", required: true },
      timeout: { type: "number", description: "Timeout in ms (default 30000)", required: false },
    },
    handler: async (args: any) => shell(args.cmd, args.timeout),
  },
  git_status: {
    name: "git_status",
    description: "Get git status of the repository.",
    parameters: {},
    handler: async () => git_status(),
  },
  git_diff: {
    name: "git_diff",
    description: "Get git diff of the working tree.",
    parameters: {},
    handler: async () => git_diff(),
  },
  git_log: {
    name: "git_log",
    description: "Get recent git log commits.",
    parameters: {
      n: { type: "number", description: "Number of commits (default 10)", required: false },
    },
    handler: async (args: any) => git_log("", args.n),
  },
  search_workspace: {
    name: "search_workspace",
    description: "Search repository files for a text pattern, excluding generated directories.",
    parameters: {
      pattern: { type: "string", description: "Text or regular expression to search", required: true },
      path: { type: "string", description: "Relative directory to search", required: false },
    },
    handler: async (args: any) => shell(`grep -RIn --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=build --exclude-dir=.next --exclude-dir=coverage ${JSON.stringify(args.pattern)} ${JSON.stringify(args.path || ".")} 2>/dev/null | head -100`),
  },
};

export function getTool(name: string): ToolDefinition | undefined {
  return tools[name];
}

export function getAllTools(): ToolDefinition[] {
  return Object.values(tools);
}

export function getToolSchema(): object[] {
  return getAllTools().map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(t.parameters).map(([k, p]) => [
            k,
            { type: p.type, description: p.description },
          ]),
        ),
        required: Object.entries(t.parameters)
          .filter(([, p]) => p.required)
          .map(([k]) => k),
      },
    },
  }));
}

export function parseToolCall(content: string): { name: string; args: Record<string, any> } | null {
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const text = jsonMatch?.[1] || content;
  try {
    const parsed = JSON.parse(text.trim());
    if (parsed && typeof parsed === "object" && "name" in parsed && "arguments" in parsed) {
      return { name: parsed.name, args: parsed.arguments };
    }
  } catch (_) {}
  const dsml = content.match(/<invoke\s+name=["']terminal["'][^>]*>[\s\S]*?<parameter\s+name=["']command["'][^>]*>([\s\S]*?)<\/parameter>[\s\S]*?<\/invoke>/i);
  if (dsml?.[1]) return { name: "shell", args: { cmd: dsml[1].trim() } };
  return null;
}
