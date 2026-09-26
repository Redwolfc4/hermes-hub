export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function shell(cmd: string, timeout: number = 30000): Promise<ShellResult> {
  const proc = Bun.spawn(["bash", "-lc", cmd], {
    cwd: process.env.HERMES_WORKSPACE || process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  return Promise.race([
    proc.exited.then(async (exitCode) => ({
      stdout: await new Response(proc.stdout).text(),
      stderr: await new Response(proc.stderr).text(),
      exitCode,
    })),
    new Promise<ShellResult>((_, reject) => setTimeout(() => reject(new Error(`Shell command timed out after ${timeout}ms`)), timeout)),
  ]);
}
