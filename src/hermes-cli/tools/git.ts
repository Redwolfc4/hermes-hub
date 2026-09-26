import { shell } from "./shell.js";

export async function git_status(cwd: string = ""): Promise<string> {
  const res = await shell(`cd "${cwd || process.env.HERMES_WORKSPACE || "."}" && git status --short 2>&1`);
  return res.stdout || res.stderr;
}

export async function git_diff(cwd: string = ""): Promise<string> {
  const res = await shell(`cd "${cwd || process.env.HERMES_WORKSPACE || "."}" && git diff 2>&1`);
  return res.stdout || res.stderr;
}

export async function git_log(cwd: string = "", n: number = 10): Promise<string> {
  const res = await shell(`cd "${cwd || process.env.HERMES_WORKSPACE || "."}" && git log --oneline -n ${n} 2>&1`);
  return res.stdout || res.stderr;
}

export async function git_log_with_stats(cwd: string = "", n: number = 10): Promise<string> {
  const res = await shell(`cd "${cwd || process.env.HERMES_WORKSPACE || "."}" && git log --oneline --stat -n ${n} 2>&1`);
  return res.stdout || res.stderr;
}
