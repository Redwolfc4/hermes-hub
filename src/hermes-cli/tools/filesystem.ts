import { readFileSync, writeFileSync, mkdirSync, rmSync, statSync, readdirSync, existsSync } from "fs";
import { join, resolve, isAbsolute } from "path";

const WORKSPACE_ROOT = process.env.HERMES_WORKSPACE || process.cwd();

export interface ReadResult {
  content: string;
  exists: boolean;
  size: number;
}

export interface WriteResult {
  success: boolean;
  written: number;
}

export interface ListEntry {
  name: string;
  isDir: boolean;
}

export interface ListResult {
  entries: ListEntry[];
  path: string;
}

function resolvePath(targetPath: string): string {
  const candidate = isAbsolute(targetPath) ? targetPath : join(WORKSPACE_ROOT, targetPath);
  const resolved = resolve(candidate);
  return resolved;
}

export function read_file(targetPath: string): ReadResult {
  const safe = resolvePath(targetPath);
  if (!existsSync(safe)) {
    return { content: "", exists: false, size: 0 };
  }
  const st = statSync(safe);
  const content = readFileSync(safe, "utf-8");
  return { content, exists: true, size: st.size };
}

export function write_file(targetPath: string, content: string): WriteResult {
  const safe = resolvePath(targetPath);
  const dir = join(safe, "..");
  if (existsSync(dir) && !statSync(dir).isDirectory()) {
    throw new Error(`Parent is not a directory: ${dir}`);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(safe, content, "utf-8");
  return { success: true, written: Buffer.byteLength(content, "utf-8") };
}

export function list_dir(targetPath: string = ""): ListResult {
  const safe = resolvePath(targetPath);
  if (!existsSync(safe) || !statSync(safe).isDirectory()) {
    throw new Error(`Not a directory: ${safe}`);
  }
  const entries = readdirSync(safe).map((name) => {
    const full = join(safe, name);
    return { name, isDir: statSync(full).isDirectory() };
  });
  return { entries, path: safe };
}
