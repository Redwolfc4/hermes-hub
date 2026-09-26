export { read_file, write_file, list_dir } from "./filesystem.ts";
export type { ReadResult, WriteResult, ListEntry, ListResult } from "./filesystem.ts";
export { shell } from "./shell.ts";
export type { ShellResult } from "./shell.ts";
export { git_status, git_diff, git_log, git_log_with_stats } from "./git.ts";

export const TOOL_NAMES = ["read_file", "write_file", "list_dir", "shell", "git_status", "git_diff", "git_log", "git_log_with_stats"] as const;
export type ToolName = typeof TOOL_NAMES[number];
