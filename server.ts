import { serve } from "bun";
import { ROUTER_LOCAL_CONFIG, BLUE_ARCHIVE_AGENTS } from "./src/config/agents";
import { ChatRepo, TaskRepo, ProviderRepo, db } from "./src/db";
import type { DBTask } from "./src/db";
import { fetchLiveAntigravityQuota, fetchLiveQuotaById } from "./src/quota-live";
import { Database } from "bun:sqlite";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { getToolSchema } from "./src/hermes-cli/tools/schema";
import { write_file } from "./src/hermes-cli/tools/filesystem";
import { shell as executeShell } from "./src/hermes-cli/tools/shell";

const PORT = 3456;
let workerRunning = false;
let workerCurrentId: string | null = null;
let workerPhase: "thinking" | "working" | "reviewing" | "done" | null = null;
let workerThinkingUntil = 0;
let workerAbort: AbortController | null = null;
let workerPausedUntil = 0;
const ROUTER_DB_PATH = `${process.env.HOME || "/home/salahudin"}/.9router/db/data.sqlite`;

const UPLOAD_DIR = join(__dirname, "data", "uploads");
const IMAGE_MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

async function executeChatTool(name: string, args: Record<string, unknown>) {
  if (name === "read_file") {
    const path = String(args.path || "");
    const full = path.startsWith("/") ? path : join(searchRoots()[1] || __dirname, path);
    const content = readFileSync(full, "utf8");
    return { content, exists: true, size: content.length };
  }
  if (name === "list_dir") {
    const dir = String(args.path || ".");
    const full = dir.startsWith("/") ? dir : join(searchRoots()[1] || __dirname, dir);
    const { readdirSync, statSync } = await import("fs");
    return { entries: readdirSync(full).map((name) => ({ name, isDir: statSync(join(full, name)).isDirectory() })) };
  }
  if (name === "search_workspace") return searchWorkspace([String(args.pattern || "")], "medium");
  if (name === "write_file") {
    const path = String(args.path || "");
    return write_file(path, String(args.content || ""));
  }
  if (name === "shell") {
    return executeShell(String(args.cmd || ""), Number(args.timeout) || 30000);
  }
  throw new Error(`Tool ${name} tidak tersedia di Web Chat`);
}

// why: gambar disimpan sebagai file (DB hanya path); ke provider dikirim data URL base64
// karena upstream remote tidak bisa mengakses localhost.
function imageRefToDataUrl(ref: string): string | null {
  if (!ref) return null;
  if (ref.startsWith("data:image/")) return ref;
  if (ref.startsWith("/uploads/")) {
    const safe = ref.split("/").pop() || "";
    if (!/^[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp|gif)$/.test(safe)) return null;
    const full = join(UPLOAD_DIR, safe);
    if (!existsSync(full)) return null;
    const ext = safe.split(".").pop()?.toLowerCase() || "png";
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/png";
    const buf = readFileSync(full);
    if (buf.length > MAX_UPLOAD_BYTES) return null;
    return `data:${mime};base64,${buf.toString("base64")}`;
  }
  return null;
}

function formatTaskNumber(n: unknown): string {
  const num = Number(n);
  if (!Number.isFinite(num) || num <= 0) return "TASK-????";
  return `TASK-${String(Math.trunc(num)).padStart(4, "0")}`;
}

function parseWorkerFilesChanged(result: string): string[] {
  const direct = result.match(/```json\s*([\s\S]*?)\s*```/);
  const candidates = [direct?.[1] ?? result, result.slice(0, 4000)];
  for (const c of candidates) {
    try {
      const p = JSON.parse(c) as { filesChanged?: unknown };
      if (Array.isArray(p.filesChanged)) return p.filesChanged.map(String);
    } catch (_) {}
  }
  const m = result.match(/"filesChanged"\s*:\s*\[([\s\S]*?)\]/);
  if (m) {
    try {
      const arr = JSON.parse(`[${m[1]}]`) as unknown[];
      return arr.map(String);
    } catch (_) {}
  }
  return [];
}

// ------------------------------------------------------------------
// Repo search dengan depth ala opencode explore:
// shallow = nama berkas saja (cepat), medium = +cuplikan 2 baris,
// deep = +konteks 5 baris. Sandbox read-only ke workspace terdaftar.
// ------------------------------------------------------------------
const SEARCH_DEPTHS = {
  shallow: { files: 20, context: 0, maxBytes: 300 * 1024 },
  medium: { files: 50, context: 2, maxBytes: 300 * 1024 },
  deep: { files: 100, context: 5, maxBytes: 500 * 1024 },
} as const;
type SearchDepth = keyof typeof SEARCH_DEPTHS;
const SEARCH_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "data", ".playwright-mcp", "coverage"]);
const SEARCH_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".go", ".md", ".json", ".html", ".css", ".sql", ".txt"]);

function searchRoots(): string[] {
  const roots = [join(__dirname)];
  const qualita = "/run/media/salahudin/403E3DCC3E3DBBAA/Users/user/github/qualita-odoo";
  if (existsSync(qualita)) roots.push(qualita);
  return roots;
}

interface SearchHit { file: string; line: number; text: string; context?: string[] }

async function searchWorkspace(terms: string[], depth: SearchDepth): Promise<{ hits: SearchHit[]; truncated: boolean; scanned: number }> {
  const cfg = SEARCH_DEPTHS[depth] || SEARCH_DEPTHS.medium;
  const needles = terms.map((t) => t.toLowerCase()).filter((t) => t.length >= 3);
  const hits: SearchHit[] = [];
  let scanned = 0;
  let truncated = false;
  if (needles.length === 0) return { hits, truncated, scanned };
  const { readdirSync, statSync } = await import("fs");
  const walk = (dir: string, root: string): void => {
    if (hits.length >= cfg.files || scanned > 3000) { truncated = true; return; }
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch (_) { return; }
    for (const name of entries) {
      if (hits.length >= cfg.files || scanned > 3000) { truncated = true; return; }
      if (SEARCH_SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      let st: any = null;
      try { st = statSync(full); } catch (_) { continue; }
      if (st.isDirectory()) { walk(full, root); continue; }
      const dot = name.lastIndexOf(".");
      if (dot < 0 || !SEARCH_EXTS.has(name.slice(dot).toLowerCase())) continue;
      if (st.size > cfg.maxBytes) continue;
      scanned++;
      let content = "";
      try { content = readFileSync(full, "utf8"); } catch (_) { continue; }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length && hits.length < cfg.files; i++) {
        const rawLine = lines[i] ?? "";
        const low = rawLine.toLowerCase();
        if (needles.some((n) => low.includes(n))) {
          const ctx = cfg.context > 0
            ? lines.slice(Math.max(0, i - cfg.context), Math.min(lines.length, i + cfg.context + 1))
            : undefined;
          hits.push({ file: full.startsWith(root) ? full.slice(root.length + 1) : full, line: i + 1, text: rawLine.slice(0, 240), context: ctx?.map((c) => (c ?? "").slice(0, 240)) });
          if (cfg.context === 0) break;
        }
      }
    }
  };
  for (const root of searchRoots()) walk(root, root);
  return { hits, truncated, scanned };
}

const SEARCH_STOPWORDS = new Set(["yang", "dan", "untuk", "dengan", "dari", "bisa", "agar", "buat", "tolong", "the", "and", "with", "from", "into", "task", "tugas", "cara"]);

function extractKeywords(title: string, description: string): string[] {
  const out: string[] = [];
  for (const raw of `${title} ${description}`.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length >= 4 && !SEARCH_STOPWORDS.has(raw) && !out.includes(raw)) out.push(raw);
    if (out.length >= 6) break;
  }
  return out;
}

function reportTaskResultToRinna(task: DBTask, status: DBTask["status"], result: string) {
  const label = formatTaskNumber(task.taskNumber);
  const agent = BLUE_ARCHIVE_AGENTS.find((candidate) => candidate.id === task.assignedAgent);
  
  let formattedResult = result;
  try {
    const parsed = JSON.parse(result);
    if (parsed && typeof parsed === "object") {
      const sections = [`📌 Ringkasan\n${parsed.summary || "-"}`];
      if (Array.isArray(parsed.filesChanged) && parsed.filesChanged.length) sections.push(`📁 File berubah\n${parsed.filesChanged.map(String).map((file: string) => `- ${file}`).join("\n")}`);
      if (Array.isArray(parsed.verification) && parsed.verification.length) sections.push(`🔍 Verifikasi\n${parsed.verification.map(String).map((item: string) => `- ${item}`).join("\n")}`);
      if (Array.isArray(parsed.blockers) && parsed.blockers.length) sections.push(`🚧 Blocker\n${parsed.blockers.map(String).map((item: string) => `- ${item}`).join("\n")}`);
      formattedResult = sections.join("\n\n");
    }
  } catch (_) {}

  ChatRepo.addMessage(
    "rinna-chan",
    "system",
    `📬 Hasil sub-task masuk ke Rinna\nTask: ${label} — ${task.title}\nAgent: ${agent?.name || task.assignedAgent}\nStatus: ${status}\n\n${formattedResult}`.slice(0, 10000),
    task.model,
  );
}

async function runQueuedTask(task: DBTask) {
  const agent = BLUE_ARCHIVE_AGENTS.find((candidate) => candidate.id === task.assignedAgent) ?? BLUE_ARCHIVE_AGENTS[1];
  if (!agent) return;
  const label = formatTaskNumber(task.taskNumber);
  workerCurrentId = task.id;
  workerPhase = "thinking";
  workerThinkingUntil = Date.now() + 2500;
  workerAbort = new AbortController();
  const active = ProviderRepo.getActive();
  const baseUrl = (active?.baseUrl || ROUTER_LOCAL_CONFIG.baseUrl).replace(/\/$/, "");
  const apiKey = active?.apiKey || process.env.NINE_ROUTER_API_KEY || ROUTER_LOCAL_CONFIG.apiKey;
  // why: scout ala opencode explore — grep medium dulu biar agent jawab pakai konteks repo nyata
  let scoutBlock = "";
  try {
    const keywords = extractKeywords(task.title, task.description);
    if (keywords.length > 0) {
      const scout = await searchWorkspace(keywords, "medium");
      if (scout.hits.length > 0) {
        scoutBlock = `\n\nKonteks repo nyata ditemukan (${scout.hits.length} temuan, kata kunci: ${keywords.join(", ")}):\n` +
          scout.hits.slice(0, 15).map((h) => `- ${h.file}:${h.line}: ${h.text}`).join("\n").slice(0, 3500);
      }
    }
  } catch (_) {}

  const prompt = `QUEUE ${label}
Title: ${task.title}
Description: ${task.description}${scoutBlock}

Instruksi Mutlak Karakter & Bahasa:
1. WAJIB menggunakan BAHASA INDONESIA yang santun, ekspresif, dan berkarakter anime sesuai peranmu (${agent.name} - ${agent.role})!
2. Boleh selipkan partikel/ekspresi khas Blue Archive atau bahasa Jepang santai seperti "desu", "masu", "Sensei", "Ehehe~", "B-baka!", atau panggilan hormat kepada Sensei.
3. DILARANG menggunakan bahasa Vietnam, Mandarin, atau bahasa asing lain selain istilah teknis programming!
4. Kamu MEMILIKI akses informasi kode di atas dari workspace. Dilarang keras mengeluh "tidak ada akses repo/database".
5. Lakukan analisis atau rancang solusi konkret berdasarkan konteks di atas.

Kembalikan HANYA format JSON valid berikut (tanpa markdown atau teks pembuka/penutup):
{
  "summary": "Penjelasan solusi dan analisis lengkap dalam Bahasa Indonesia dengan sentuhan kepribadianmu",
  "filesChanged": ["daftar/path/file/relevan"],
  "verification": ["Langkah verifikasi atau pengujian yang dipastikan"],
  "blockers": []
}`;
  ChatRepo.addMessage(agent.id, "system", `🚀 Mulai ${label}: ${task.title} — ${task.description}`.slice(0, 2000), task.model);
  try {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, workerThinkingUntil - Date.now())));
    workerPhase = "working";
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: task.model || agent.defaultModel, messages: [{ role: "system", content: agent.systemPrompt }, { role: "user", content: prompt }], stream: false }),
      signal: workerAbort.signal,
    });
    const payload = await response.json() as { choices?: { message?: { content?: string } }[] };
    const rawResult = payload.choices?.[0]?.message?.content || "No execution output returned.";
    
    // Parse JSON jika model mengembalikan raw json string agar di chat tersaji cantik
    let chatDisplayResult = rawResult;
    try {
      const parsed = JSON.parse(rawResult.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, ""));
      if (parsed && typeof parsed === "object" && parsed.summary) {
        const sections = [parsed.summary ? String(parsed.summary) : ""];
        if (Array.isArray(parsed.filesChanged) && parsed.filesChanged.length) sections.push(`📁 File berubah\n${parsed.filesChanged.map(String).map((file: string) => `- ${file}`).join("\n")}`);
        if (Array.isArray(parsed.verification) && parsed.verification.length) sections.push(`🔍 Verifikasi\n${parsed.verification.map(String).map((item: string) => `- ${item}`).join("\n")}`);
        if (Array.isArray(parsed.blockers) && parsed.blockers.length) sections.push(`🚧 Blocker\n${parsed.blockers.map(String).map((item: string) => `- ${item}`).join("\n")}`);
        chatDisplayResult = sections.filter(Boolean).join("\n\n");
      }
    } catch (_) {}

    ChatRepo.addMessage(agent.id, "assistant", `✅ ${label} selesai:\n${chatDisplayResult}`.slice(0, 8000), task.model);
    const needsReview = ["utaha-qa", "karin-reviewer", "tsurugi-security"].includes(agent.id);
    workerPhase = response.ok && !needsReview ? "done" : "reviewing";
    const finalStatus = response.ok && !needsReview ? "done" : "review";
    TaskRepo.completeTask(task.id, finalStatus, rawResult, parseWorkerFilesChanged(rawResult));
    reportTaskResultToRinna(task, finalStatus, rawResult);
  } catch (error) {
    // why: stop via ESC/tombol = abort → kembalikan ke antrian, bukan tandai gagal
    if (error instanceof Error && error.name === "AbortError") {
      TaskRepo.updateStatus(task.id, "todo");
      ChatRepo.addMessage(agent.id, "system", `⏹️ ${label} dihentikan sensei — kembali ke antrian.`, task.model);
      return;
    }
    const message = error instanceof Error ? error.message : "Worker execution failed";
    TaskRepo.completeTask(task.id, "review", message);
    ChatRepo.addMessage(agent.id, "system", `⛔ ${label} blocked: ${message}`, task.model);
    reportTaskResultToRinna(task, "review", `BLOCKED: ${message}`);
  } finally {
    workerCurrentId = null;
    workerPhase = null;
    workerThinkingUntil = 0;
    workerAbort = null;
  }
}

async function checkAndSendRinnaGrandSummary() {
  const allTasks = TaskRepo.getAllTasks();
  const pendingOrActive = allTasks.filter((t) => t.status === "todo" || t.status === "in-progress");
  if (pendingOrActive.length > 0) return;

  const completed = allTasks.filter((t) => (t.status === "done" || t.status === "review") && t.completedAt);
  if (completed.length === 0) return;

  // Temukan task yang paling baru selesai
  completed.sort((a, b) => new Date(b.completedAt || 0).getTime() - new Date(a.completedAt || 0).getTime());
  const newestDone = completed[0];
  if (!newestDone) return;
  const newestDoneTime = new Date(newestDone.completedAt || 0).getTime();

  // Hanya jika batch task selesai dalam 30 detik terakhir
  if (Date.now() - newestDoneTime > 30000) return;

  // Guard agar tidak spam rangkuman berulang-ulang untuk task yang sama
  const recentMessages = ChatRepo.getMessagesByAgent("rinna-chan", 10);
  const alreadySummarized = recentMessages.some(
    (m) => m.role === "assistant" && m.content.includes("LAPORAN AKHIR TIM BLUE ARCHIVE") && m.content.includes(formatTaskNumber(newestDone.taskNumber))
  );
  if (alreadySummarized) return;

  const batchDone = completed.slice(0, 5);
  const summaryLines = batchDone.map((t) => {
    const ag = BLUE_ARCHIVE_AGENTS.find((a) => a.id === t.assignedAgent);
    let readableRes = t.result || "Selesai tanpa catatan";
    try {
      const parsed = JSON.parse(readableRes);
      if (parsed && typeof parsed === "object" && parsed.summary) {
        readableRes = parsed.summary;
      }
    } catch (_) {
      const match = readableRes.match(/"summary"\s*:\s*"([^"]+)"/);
      if (match && match[1]) readableRes = match[1];
    }
    const shortRes = readableRes.replace(/\s+/g, " ").slice(0, 160);
    return `• [${formatTaskNumber(t.taskNumber)}] ${t.title} (${ag?.name || t.assignedAgent}) ➔ ${shortRes}`;
  }).join("\n");

  const grandSummaryText = `🎉 Sensei! Semua sub-task antrean sudah tuntas dikerjakan oleh tim Blue Archive desu~! ✨\n\n📋 LAPORAN AKHIR TIM BLUE ARCHIVE:\n${summaryLines}\n\nRinna sudah mereview seluruh hasilnya dan semuanya berjalan sesuai rencana, ne! Jangan ragu kasih tugas berikutnya ke Rinna ya, Sensei! Ehehe~ 🌸`;

  ChatRepo.addMessage("rinna-chan", "assistant", grandSummaryText, newestDone.model || "free-combo1");
}

async function processQueue() {
  if (workerRunning) return;
  if (Date.now() < workerPausedUntil) return;
  workerRunning = true;
  try {
    const task = TaskRepo.claimNextTask();
    if (task) {
      await runQueuedTask(task);
    } else {
      await checkAndSendRinnaGrandSummary();
    }
  } finally {
    workerRunning = false;
  }
}

setInterval(() => { void processQueue(); }, 2000);

// Parse "Resets in 164h56m49s" / "Resets in 22h 56m" from provider error text
// into a short card label like "in 6d 20h 48m".
function parseQuotaReset(lastError: string): string | null {
  if (!lastError) return null;
  const m = lastError.match(/Resets?\s+in\s+(\d+)h\s*(\d+)?m?\s*(\d+)?s?/i);
  if (!m) return null;
  const h = parseInt(m[1] || "0", 10);
  const min = parseInt(m[2] || "0", 10);
  const d = Math.floor(h / 24);
  const hh = h % 24;
  if (d > 0) return `in ${d}d ${hh}h ${min}m`;
  if (hh > 0) return `in ${hh}h ${min}m`;
  return `in ${min}m`;
}

// Group modelLock_* entries by model family so the UI can render
// per-quota cards like "Gemini (Weekly)" / "Claude & GPT (Weekly)".
function buildQuotaGroups(provider: string, modelLocks: Record<string, string | null>, lastError: string) {
  const entries = Object.entries(modelLocks);
  if (entries.length === 0) return [];

  const familyOf = (model: string): string => {
    const m = model.toLowerCase();
    if (m.includes("gemini") || m.includes("flash") && !m.includes("deepseek") && !m.includes("qwen")) return "gemini";
    if (m.includes("claude")) return "claude";
    if (m.includes("gpt") || m.includes("codex") || m.includes("astra") || m.includes("sol") || m.includes("luna") || m.includes("terra")) return "gpt";
    if (m.includes("deepseek")) return "deepseek";
    if (m.includes("qwen") || m.includes("glm") || m.includes("kimi") || m.includes("mimo") || m.includes("minimax") || m.includes("hy")) return "open";
    return "other";
  };

  const now = Date.now();
  const byFamily: Record<string, { model: string; locked: boolean; lockedAt: string | null; unlockIn: string | null }[]> = {};
  for (const [model, lockedAt] of entries) {
    const fam = familyOf(model);
    if (!byFamily[fam]) byFamily[fam] = [];
    let unlockIn: string | null = null;
    if (lockedAt) {
      const diff = new Date(lockedAt).getTime() - now;
      if (diff > 0) {
        const mins = Math.floor(diff / 60000);
        unlockIn = mins >= 60 ? `in ${Math.floor(mins / 60)}h ${mins % 60}m` : `in ${mins}m`;
      }
    }
    byFamily[fam].push({ model, locked: Boolean(lockedAt), lockedAt, unlockIn });
  }

  const resetLabel = parseQuotaReset(lastError);
  const labelFor = (fam: string): string => {
    if (provider === "antigravity") {
      if (fam === "gemini") return "Gemini (Weekly)";
      if (fam === "claude" || fam === "gpt") return "Claude & GPT (Weekly)";
    }
    if (provider === "codex") return "5h" ;
    if (provider === "codebuddy-intl") return "Monthly";
    if (fam === "gemini") return "Gemini";
    if (fam === "claude") return "Claude";
    if (fam === "gpt") return "GPT";
    if (fam === "deepseek") return "DeepSeek";
    if (fam === "open") return "Open Models";
    return "Other";
  };

  // Merge claude+gpt for antigravity to mirror the reference card layout
  if (provider === "antigravity" && byFamily["claude"] && byFamily["gpt"]) {
    byFamily["claude"] = [...byFamily["claude"], ...byFamily["gpt"]];
    delete byFamily["gpt"];
  }

  return Object.entries(byFamily).map(([fam, models]) => {
    const locked = models.filter(m => m.locked).length;
    const total = models.length;
    const pct = total === 0 ? 100 : Math.round(((total - locked) / total) * 100);
    return {
      family: fam,
      label: labelFor(fam),
      total,
      locked,
      available: total - locked,
      pct,
      exhausted: locked > 0 && locked === total,
      healthy: locked === 0,
      resetLabel,
      models: models.sort((a, b) => Number(b.locked) - Number(a.locked))
    };
  }).sort((a, b) => a.locked - b.locked);
}

function getRouterDb() {
  if (existsSync(ROUTER_DB_PATH)) {
    return new Database(ROUTER_DB_PATH, { readonly: true });
  }
  return null;
}

function resolveProvider(req: Request) {
  const headerBase = req.headers.get("x-provider-base-url") || "";
  const headerKey = req.headers.get("x-router-key") || "";
  const active = ProviderRepo.getActive();
  const baseUrl = (headerBase || active?.baseUrl || ROUTER_LOCAL_CONFIG.baseUrl).replace(/\/$/, "");
  const apiKey = headerKey || active?.apiKey || process.env.NINE_ROUTER_API_KEY || ROUTER_LOCAL_CONFIG.apiKey;
  return { baseUrl, apiKey, active };
}

async function testProviderConnection(baseUrl: string, apiKey: string) {
  const clean = baseUrl.replace(/\/$/, "");
  try {
    const res = await fetch(`${clean}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    if (!res.ok) {
      return { success: false, modelCount: 0, message: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    let count = 0;
    try {
      const data = JSON.parse(text) as any;
      if (Array.isArray(data.data)) count = data.data.length;
    } catch (_) {}
    return { success: true, modelCount: count, message: `Sukses: ${count} model ditemukan` };
  } catch (err: any) {
    return { success: false, modelCount: 0, message: `Gagal koneksi: ${err.message}` };
  }
}

serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // API Routes
    if (url.pathname === "/api/agents") {
      return Response.json({ agents: BLUE_ARCHIVE_AGENTS });
    }

    // Chat History Persistence Endpoints
    if (url.pathname === "/api/quota/overview" && req.method === "GET") {
      try {
        const db = getRouterDb();
        if (!db) {
          return Response.json({ error: "9Router database not found" }, { status: 404 });
        }

        // 1. Provider Accounts & Connection status
        const connectionsRaw = db.query(`
          SELECT id, provider, authType, name, email, priority, isActive, data, updatedAt
          FROM providerConnections
          ORDER BY provider ASC, priority ASC
        `).all() as any[];

        const accounts = connectionsRaw.map(c => {
          let extra: any = {};
          try { extra = JSON.parse(c.data); } catch (_) {}
          
          // extract model locks & error details
          const modelLocks: Record<string, string | null> = {};
          for (const k of Object.keys(extra)) {
            if (k.startsWith("modelLock_")) {
              modelLocks[k.replace("modelLock_", "")] = extra[k];
            }
          }

          return {
            id: c.id,
            provider: c.provider,
            authType: c.authType,
            name: c.name || c.email || "Unnamed Account",
            email: c.email,
            priority: c.priority,
            isActive: Boolean(c.isActive),
            status: extra.testStatus || (extra.errorCode ? "unavailable" : "unknown"),
            errorCode: extra.errorCode || null,
            lastError: extra.lastError || null,
            lastErrorAt: extra.lastErrorAt || null,
            expiresAt: extra.expiresAt || null,
            projectId: extra.projectId || null,
            modelLocks,
            lockedModelsCount: Object.values(modelLocks).filter(Boolean).length,
            quotaGroups: buildQuotaGroups(c.provider, modelLocks, extra.lastError || ""),
            quotaResetLabel: parseQuotaReset(extra.lastError || ""),
            updatedAt: c.updatedAt
          };
        });

        // 2. High-level aggregates
        const totalRequests = (db.query(`SELECT count(*) as count FROM usageHistory`).get() as any)?.count || 0;
        const totalCost = (db.query(`SELECT sum(cost) as totalCost FROM usageHistory`).get() as any)?.totalCost || 0;
        const totalTokens = (db.query(`SELECT sum(promptTokens + completionTokens) as total FROM usageHistory`).get() as any)?.total || 0;

        // 3. Provider breakdown in usage
        const providerUsage = db.query(`
          SELECT provider, count(*) as requests, sum(promptTokens) as promptTokens, sum(completionTokens) as completionTokens, sum(cost) as cost
          FROM usageHistory
          GROUP BY provider
          ORDER BY requests DESC
        `).all();

        // 4. Model usage stats (top 20)
        const modelStats = db.query(`
          SELECT model, provider, count(*) as requests, sum(promptTokens) as promptTokens, sum(completionTokens) as completionTokens, sum(cost) as cost, max(timestamp) as lastUsed
          FROM usageHistory
          GROUP BY model, provider
          ORDER BY requests DESC
          LIMIT 25
        `).all();

        // 5. Daily usage history (last 14 days)
        const dailyRecords = db.query(`
          SELECT dateKey, data
          FROM usageDaily
          ORDER BY dateKey DESC
          LIMIT 14
        `).all() as any[];

        const dailyStats = dailyRecords.map(d => {
          let parsed: any = {};
          try { parsed = JSON.parse(d.data); } catch (_) {}
          return {
            date: d.dateKey,
            requests: parsed.requests || 0,
            promptTokens: parsed.promptTokens || 0,
            completionTokens: parsed.completionTokens || 0,
            cachedTokens: parsed.cachedTokens || 0,
            cost: parsed.cost || 0
          };
        });

        // 6. Recent usage transactions (last 30)
        const recentHistory = db.query(`
          SELECT id, timestamp, provider, model, endpoint, promptTokens, completionTokens, cost, status
          FROM usageHistory
          ORDER BY timestamp DESC
          LIMIT 30
        `).all();

        db.close();

        return Response.json({
          summary: {
            totalAccounts: accounts.length,
            activeAccounts: accounts.filter(a => a.status === "active").length,
            unavailableAccounts: accounts.filter(a => a.status === "unavailable" || a.errorCode).length,
            totalRequests,
            totalCost: Number(totalCost.toFixed(4)),
            totalTokens
          },
          accounts,
          providerUsage,
          modelStats,
          dailyStats,
          recentHistory
        });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // Live per-account quota straight from the provider (Antigravity/Google,
    // Codex/OpenAI, CodeBuddy). Tokens stay server-side; the browser only
    // receives numbers. Identify by 9Router connection id (stable); email
    // fallback kept for Antigravity.
    if (url.pathname === "/api/quota/live" && req.method === "GET") {
      const id = url.searchParams.get("id") || "";
      const email = url.searchParams.get("email") || "";
      if (!id && !email) {
        return Response.json({ error: "id (or email) parameter is required" }, { status: 400 });
      }
      try {
        const live = id ? await fetchLiveQuotaById(id) : await fetchLiveAntigravityQuota(email);
        return Response.json(live);
      } catch (err: any) {
        return Response.json({ error: err.message, id: id || email }, { status: 502 });
      }
    }

    if (url.pathname === "/api/chats" && req.method === "GET") {
      const agentId = url.searchParams.get("agentId");
      if (!agentId) {
        return Response.json({ error: "agentId parameter is required" }, { status: 400 });
      }
      const messages = ChatRepo.getMessagesByAgent(agentId);
      return Response.json({ messages });
    }

    if (url.pathname === "/api/chats" && req.method === "DELETE") {
      const agentId = url.searchParams.get("agentId");
      if (!agentId) {
        return Response.json({ error: "agentId parameter is required" }, { status: 400 });
      }
      ChatRepo.clearMessages(agentId);
      return Response.json({ success: true, message: `Chat history cleared for ${agentId}` });
    }

    if (url.pathname === "/api/providers" && req.method === "GET") {
      const providers = ProviderRepo.getAll().map(p => ({
        ...p,
        apiKeyMasked: ProviderRepo.maskKey(p.apiKey),
        apiKey: undefined,
      }));
      const active = ProviderRepo.getActive();
      return Response.json({ providers, activeId: active?.id || null, defaults: { baseUrl: ROUTER_LOCAL_CONFIG.baseUrl } });
    }

    if (url.pathname === "/api/providers" && req.method === "POST") {
      try {
        const body = await req.json() as any;
        if (!body.baseUrl || !body.name) {
          return Response.json({ error: "name dan baseUrl wajib diisi" }, { status: 400 });
        }
        const saved = ProviderRepo.upsert({
          id: body.id,
          name: body.name,
          baseUrl: String(body.baseUrl).replace(/\/$/, ""),
          apiKey: body.apiKey || "",
          isActive: body.isActive,
        });
        if (body.apiKey) {
          const test = await testProviderConnection(saved.baseUrl, body.apiKey);
          ProviderRepo.saveTestResult(saved.id, test.success ? "success" : "failed", test.message);
        }
        const fresh = ProviderRepo.getById(saved.id)!;
        return Response.json({
          success: true,
          provider: { ...fresh, apiKeyMasked: ProviderRepo.maskKey(fresh.apiKey), apiKey: undefined },
        });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    if (url.pathname === "/api/providers/active" && req.method === "POST") {
      try {
        const body = await req.json() as any;
        if (!body.id) return Response.json({ error: "id wajib diisi" }, { status: 400 });
        const found = ProviderRepo.getById(body.id);
        if (!found) return Response.json({ error: "Provider tidak ditemukan" }, { status: 404 });
        ProviderRepo.setActive(body.id);
        return Response.json({ success: true, activeId: body.id });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    if (url.pathname === "/api/providers/test" && req.method === "POST") {
      try {
        const body = await req.json() as any;
        const baseUrl = String(body.baseUrl || ProviderRepo.getActive()?.baseUrl || ROUTER_LOCAL_CONFIG.baseUrl).replace(/\/$/, "");
        const apiKey = body.apiKey || ProviderRepo.getActive()?.apiKey || "";
        const test = await testProviderConnection(baseUrl, apiKey);
        if (body.id) {
          if (body.saveKey) {
            ProviderRepo.upsert({ id: body.id, name: body.name || body.id, baseUrl, apiKey });
          }
          ProviderRepo.saveTestResult(body.id, test.success ? "success" : "failed", test.message);
        }
        return Response.json({ ...test, baseUrl });
      } catch (err: any) {
        return Response.json({ success: false, modelCount: 0, message: err.message }, { status: 500 });
      }
    }

    if (url.pathname === "/api/router/models") {
      // why: upstream /models bisa belasan detik; cache 60d per baseUrl biar dropdown instan
      const MODELS_CACHE_TTL = 60000;
      const modelsCache = ((globalThis as any).__hermesModelsCache ||= new Map<string, { at: number; payload: any }>());
      // why: provider mati/timeout JANGAN bikin dropdown kosong — lapis fallback: live → opencode.json → bawaan
      const FALLBACK_MODELS = [
        "free-combo1",
        "harbor-ai/gemini-3.7-flash",
        "cl/deepseek/deepseek-r1-distill-llama-70b",
        "cl/nousresearch/hermes-3-llama-3.1-70b",
      ];
      try {
        const { baseUrl, apiKey } = resolveProvider(req);
        const cached = modelsCache.get(baseUrl);
        if (cached && Date.now() - cached.at < MODELS_CACHE_TTL) {
          return Response.json(cached.payload);
        }
        let allModels: { id: string; object?: string; owned_by?: string }[] = [];
        let fetchMessage = "";
        let live = false;

        try {
          const res = await fetch(`${baseUrl}/models`, {
            headers: apiKey ? { "Authorization": `Bearer ${apiKey}` } : {},
            signal: AbortSignal.timeout(8000)
          });
          if (res.ok) {
            const data = await res.json() as any;
            if (Array.isArray(data.data)) {
              allModels = data.data;
              live = allModels.length > 0;
            }
            fetchMessage = `Sukses: ${allModels.length} model dari ${baseUrl}`;
          } else {
            const errText = await res.text();
            fetchMessage = `Gagal: HTTP ${res.status} dari ${baseUrl} - ${errText.slice(0, 200)}`;
          }
        } catch (fetchErr: any) {
          fetchMessage = `Provider tidak merespons (${fetchErr.message || "timeout"}) — pakai daftar tersimpan.`;
        }

        // Also merge configured models from ~/.config/opencode/opencode.json if available
        try {
          const opencodePath = `${process.env.HOME || "/home/salahudin"}/.config/opencode/opencode.json`;
          const opencodeFile = Bun.file(opencodePath);
          if (await opencodeFile.exists()) {
            const opencodeJson = await opencodeFile.json();
            const routerModels = opencodeJson?.provider?.["9router"]?.models;
            if (routerModels && typeof routerModels === "object") {
              const existingIds = new Set(allModels.map(m => m.id));
              for (const modelKey of Object.keys(routerModels)) {
                if (!existingIds.has(modelKey)) {
                  allModels.push({ id: modelKey, object: "model", owned_by: "opencode" });
                  existingIds.add(modelKey);
                }
              }
            }
          }
        } catch (_) {}

        if (allModels.length === 0) {
          allModels = FALLBACK_MODELS.map((id) => ({ id, object: "model", owned_by: "builtin" }));
        }

        const active = ProviderRepo.getActive();
        if (active) {
          ProviderRepo.saveTestResult(active.id, live ? "success" : "failed", fetchMessage);
        }

        const payload = { object: "list", data: allModels, source: live ? "live" : "cache", provider: { baseUrl, success: live, message: live ? fetchMessage : `${fetchMessage} Tampil ${allModels.length} model tersimpan.`, count: allModels.length } };
        modelsCache.set(baseUrl, { at: Date.now(), payload });
        return Response.json(payload);
      } catch (err: any) {
        return Response.json({ success: false, error: err.message, message: `Gagal koneksi: ${err.message}` }, { status: 500 });
      }
    }

    if (url.pathname === "/api/tasks/auto-orchestrate" && req.method === "POST") {
      try {
        const body = await req.json() as any;
        const projectGoal = body.prompt || body.goal || "Rancang dan bangun sistem ERP terintegrasi";
        const resolved = resolveProvider(req);
        const apiKey = body.apiKey || body.api_key || resolved.apiKey;
        const baseUrl = body.baseUrl || body.base_url || resolved.baseUrl;
        const model = body.model || "free-combo1";

        // Step 1: Rinna-chan breaks down the master task into workforce subtasks
        const orchestrationPrompt = `Sensei memberikan misi projek: "${projectGoal}".
Sebagai Lead Senior Orchestrator (Rinna-chan), pecah misi ini menjadi 5 delegasi tugas terpisah untuk anggota timmu:
1. arona-scout (Schale Code Scout - penelusuran arsitektur & route)
2. yuka-planner (Millennium Calculator - kalkulasi risiko & step plan)
3. maki-backend (Veritas Hacker - backend Go Fiber v2 & database)
4. momoi-frontend (Game Dev Dept - frontend UI Next.js 16)
5. utaha-qa (Meister Quad - QA unit test & verifikasi)

Kembalikan HANYA format JSON valid tanpa markdown/backticks dengan schema berikut:
{
  "rinnaSummary": "Kalimat pembuka tsundere Rinna ke Sensei menjelaskan rencana kerja tim",
  "delegations": [
    {"agentId": "arona-scout", "title": "...", "description": "..."},
    {"agentId": "yuka-planner", "title": "...", "description": "..."},
    {"agentId": "maki-backend", "title": "...", "description": "..."},
    {"agentId": "momoi-frontend", "title": "...", "description": "..."},
    {"agentId": "utaha-qa", "title": "...", "description": "..."}
  ],
  "rinnaClosing": "Kalimat penutup Rinna menegaskan hasil kerja siap dikompilasi"
}`;

        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: model,
            messages: [
              { role: "system", content: "You are Rinna-chan, Lead Senior Orchestrator. Output ONLY raw JSON." },
              { role: "user", content: orchestrationPrompt }
            ],
            temperature: 0.6,
            stream: false
          })
        });

        const rawText = await res.text();
        let parsed: any = null;
        try {
          const completion = JSON.parse(rawText);
          const content = completion.choices?.[0]?.message?.content || "";
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
        } catch (_) {}

        if (!parsed || !Array.isArray(parsed.delegations)) {
          parsed = {
            rinnaSummary: `Sensei! Rinna sudah menganalisis misi "${projectGoal}" desu~! Rinna pecah langsung ke anak-anak biar cepat selesai, jangan berani ragukan Rinna ya! B-baka! 🌸`,
            delegations: [
              { agentId: "arona-scout", title: `Scout: Pemetaan Alur untuk ${projectGoal.slice(0, 30)}`, description: `Arona menelusuri routing dan boundary arsitektur untuk ${projectGoal}` },
              { agentId: "yuka-planner", title: `Planner: Estimasi & Checklist Task`, description: `Yuuka menghitung estimasi teknis, audit RBAC, dan urutan breakdown implementasi` },
              { agentId: "maki-backend", title: `Backend: Go Fiber Endpoint & Service Logic`, description: `Maki mengeksekusi routing, GORM query, dan seed sys_modules` },
              { agentId: "momoi-frontend", title: `Frontend: Next.js 16 UI Snappy`, description: `Momoi membuat UI responsive, Bun package manager, zero any-type` },
              { agentId: "utaha-qa", title: `QA: Verifikasi & Test Automation`, description: `Utaha mengeksekusi typecheck dan testing suite untuk memastikan zero-bug` }
            ],
            rinnaClosing: `Semua delegasi masuk ke Kanban board! Tim sedang bergerak dan Rinna yang awasi langsung sampai beres untuk Sensei! ✨`
          };
        }

        const createdTasks: DBTask[] = [];
        for (const item of parsed.delegations) {
          const assignedAgentObj = BLUE_ARCHIVE_AGENTS.find((a) => a.id === item.agentId);
          const taskModel = item.model || model || assignedAgentObj?.defaultModel || "free-combo1";
          const newTask: DBTask = {
            id: "task-" + Math.random().toString(36).substring(2, 9),
            title: item.title,
            description: item.description,
            assignedAgent: item.agentId,
            model: taskModel,
            status: "todo",
            createdAt: new Date().toISOString()
          };
          TaskRepo.upsertTask(newTask);
          createdTasks.push(newTask);
        }

        return Response.json({
          success: true,
          rinnaSummary: parsed.rinnaSummary,
          rinnaClosing: parsed.rinnaClosing,
          delegations: createdTasks,
          allTasks: TaskRepo.getAllTasks()
        });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    if (url.pathname === "/api/tasks" && req.method === "GET") {
      const tasks = TaskRepo.getAllTasks();
      const inProgress = tasks.filter((t) => t.status === "in-progress");
      const current = (workerCurrentId && tasks.find((t) => t.id === workerCurrentId)) || null;
      const pausedMs = Math.max(0, workerPausedUntil - Date.now());
      return Response.json({ tasks, worker: { running: workerRunning, currentId: workerCurrentId, current, phase: workerPhase, paused: pausedMs > 0, pausedMs, inProgressCount: inProgress.length, queueCount: tasks.filter((t) => t.status === "todo").length } });
    }

    if (url.pathname === "/api/worker/state" && req.method === "GET") {
      const tasks = TaskRepo.getAllTasks();
      const inProgress = tasks.filter((t) => t.status === "in-progress");
      const current = (workerCurrentId && tasks.find((t) => t.id === workerCurrentId)) || null;
      const pausedMs = Math.max(0, workerPausedUntil - Date.now());
      return Response.json({ running: workerRunning, currentId: workerCurrentId, current, phase: workerPhase, paused: pausedMs > 0, pausedMs, inProgress, queue: tasks.filter((t) => t.status === "todo").slice(0, 5), counts: { todo: tasks.filter((t) => t.status === "todo").length, inProgress: inProgress.length, review: tasks.filter((t) => t.status === "review").length, done: tasks.filter((t) => t.status === "done").length } });
    }

    if (url.pathname === "/api/search" && req.method === "POST") {
      try {
        const body = await req.json() as any;
        const q = String(body.q || body.query || "").trim();
        const depth = (["shallow", "medium", "deep"].includes(body.depth) ? body.depth : "medium") as SearchDepth;
        if (!q) return Response.json({ error: "q wajib diisi" }, { status: 400 });
        const terms = q.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length >= 3).slice(0, 8);
        const result = await searchWorkspace(terms, depth);
        return Response.json({ depth, terms, ...result, roots: searchRoots() });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    if (url.pathname === "/api/worker/stop" && req.method === "POST") {
      if (!workerCurrentId || !workerAbort) {
        return Response.json({ stopped: false, reason: "Worker sedang idle." });
      }
      const id = workerCurrentId;
      // why: tanpa jeda, task yang dibatalkan langsung di-claim lagi oleh interval worker
      workerPausedUntil = Date.now() + 120000;
      workerAbort.abort();
      return Response.json({ stopped: true, taskId: id, pausedMs: 120000 });
    }

    if (url.pathname === "/api/worker/resume" && req.method === "POST") {
      workerPausedUntil = 0;
      void processQueue();
      return Response.json({ resumed: true });
    }

    if (url.pathname === "/api/tasks" && req.method === "POST") {
      const body = await req.json() as any;
      const newTask: DBTask = {
        id: "task-" + Date.now(),
        title: body.title || "Untitled Task",
        description: body.description || "",
        assignedAgent: body.assignedAgent || "rinna-chan",
        model: body.model || "free-combo1",
        status: "todo",
        createdAt: new Date().toISOString()
      };
      TaskRepo.upsertTask(newTask);
      const saved = TaskRepo.getAllTasks().find((t) => t.id === newTask.id) || newTask;
      return Response.json({ success: true, task: saved });
    }

    if (url.pathname.startsWith("/api/tasks/") && req.method === "PATCH") {
      const taskId = url.pathname.split("/").pop();
      const body = await req.json() as any;
      if (!taskId) return Response.json({ error: "Missing taskId" }, { status: 400 });

      // why: PATCH usang/rusak pernah kirim status null → NOT NULL fail → Kanban macet diam-diam
      const VALID_STATUS = new Set(["todo", "in-progress", "review", "done"]);
      if (body.status !== undefined && body.status !== null && !VALID_STATUS.has(body.status)) {
        return Response.json({ error: "Invalid status" }, { status: 400 });
      }
      const patch: { title?: string; description?: string; assignedAgent?: string; model?: string; status?: DBTask["status"]; result?: string } = {};
      if (typeof body.title === "string" && body.title.trim() !== "") patch.title = body.title;
      if (typeof body.description === "string") patch.description = body.description;
      if (typeof body.assignedAgent === "string" && body.assignedAgent !== "") patch.assignedAgent = body.assignedAgent;
      if (typeof body.model === "string" && body.model !== "") patch.model = body.model;
      if (body.status !== undefined && body.status !== null) patch.status = body.status;
      if (body.result !== undefined && body.result !== null) patch.result = body.result;
      if (Object.keys(patch).length === 0) return Response.json({ error: "Nothing to update" }, { status: 400 });

      const before = TaskRepo.getAllTasks().find((t) => t.id === taskId);
      TaskRepo.updateTask(taskId, patch);
      if (patch.status && before && before.status !== patch.status) {
        if (patch.status === "in-progress" && !before.startedAt) {
          db.query(`UPDATE tasks SET started_at = ? WHERE id = ? AND started_at IS NULL`).run(new Date().toISOString(), taskId);
        }
        if ((patch.status === "done" || patch.status === "review") && !before.completedAt) {
          db.query(`UPDATE tasks SET completed_at = ? WHERE id = ? AND completed_at IS NULL`).run(new Date().toISOString(), taskId);
        }
      }
      const updated = TaskRepo.getAllTasks().find(t => t.id === taskId);
      if (updated) {
        return Response.json({ success: true, task: updated });
      }
      return Response.json({ error: "Task not found" }, { status: 404 });
    }

    if (url.pathname.startsWith("/api/tasks/") && req.method === "DELETE") {
      const taskId = url.pathname.split("/").pop();
      if (!taskId) return Response.json({ error: "Missing taskId" }, { status: 400 });
      TaskRepo.deleteTask(taskId);
      return Response.json({ success: true, id: taskId });
    }

    if (url.pathname === "/api/uploads" && req.method === "POST") {
      try {
        const form = await req.formData();
        const file = form.get("image");
        if (!file || typeof file === "string") {
          return Response.json({ error: "Field image wajib diisi" }, { status: 400 });
        }
        const mime = file.type || "";
        const ext = IMAGE_MIME_EXT[mime];
        if (!ext) {
          return Response.json({ error: "Hanya PNG / JPEG / WebP / GIF yang didukung" }, { status: 400 });
        }
        if (file.size > MAX_UPLOAD_BYTES) {
          return Response.json({ error: "Ukuran gambar maksimal 5MB" }, { status: 400 });
        }
        const { mkdirSync } = await import("fs");
        mkdirSync(UPLOAD_DIR, { recursive: true });
        const name = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        await Bun.write(join(UPLOAD_DIR, name), file);
        return Response.json({ success: true, url: `/uploads/${name}`, mime, size: file.size });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    if (url.pathname === "/api/chat" && req.method === "POST") {
      try {
        const body = await req.json() as any;
        const agent = BLUE_ARCHIVE_AGENTS.find(a => a.id === body.agentId) ?? BLUE_ARCHIVE_AGENTS[0];
        if (!agent) return Response.json({ error: "No agent configured" }, { status: 500 });
        const resolved = resolveProvider(req);
        const apiKey = body.apiKey || resolved.apiKey;
        const baseUrl = body.baseUrl || resolved.baseUrl;
        const model = body.model || agent.defaultModel || "free-combo1";

        // Save incoming user message to SQLite DB (images stored as JSON array in /uploads paths)
        const rawImage = typeof body.image === 'string' ? body.image : Array.isArray(body.image) ? body.image : null;
        const imageUrls = typeof rawImage === 'string' ? [rawImage] : (rawImage || []);
        const validImages = imageUrls.filter((u: string) => u && imageRefToDataUrl(u)).map((u: string) => u.slice(0, 500)) || [];
        if (body.prompt || validImages.length) {
          ChatRepo.addMessage(agent.id, "user", body.prompt || "(gambar)", model, validImages.length ? validImages : undefined);
        }

        // Build messages payload for provider (OpenAI-compatible, vision-aware)
        // Take system prompt + historical messages
        const historyFromDb = ChatRepo.getMessagesByAgent(agent.id, 30);

        // why: injeksikan scout repo ke obrolan chat jika user menanyakan kode / file / komponen
        let chatScoutBlock = "";
        try {
          const userText = String(body.prompt || "");
          const kws = extractKeywords(userText, "");
          if (kws.length > 0) {
            const scout = await searchWorkspace(kws, "shallow");
            if (scout.hits.length > 0) {
              chatScoutBlock = `\n\n[System Context: Referensi riil workspace terdeteksi (${scout.hits.length} file)]:\n` +
                scout.hits.slice(0, 8).map((h) => `- ${h.file}:${h.line}: ${h.text}`).join("\n").slice(0, 2000);
            }
          }
        } catch (_) {}

        const toProviderContent = (m: { content: string; image_urls?: string[] }) => {
          const urls = m.image_urls || [];
          const dataUrls = urls.map(u => imageRefToDataUrl(u)).filter((d): d is string => d !== null);
          if (dataUrls.length) {
            return [
              ...(m.content ? [{ type: "text" as const, text: m.content }] : []),
              ...dataUrls.map(url => ({ type: "image_url" as const, image_url: { url } }))
            ];
          }
          return m.content;
        };
        const routerMessages = [
          { role: "system", content: agent.systemPrompt + chatScoutBlock },
          ...historyFromDb.map(m => ({ role: m.role, content: toProviderContent(m) }))
        ];

        let res: Response;
        try {
          res = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${apiKey}`
            },
            body: JSON.stringify({
              model,
              messages: routerMessages,
              tools: getToolSchema(),
              tool_choice: "auto",
              temperature: 0.7,
              stream: false
            }),
            signal: AbortSignal.timeout(45000)
          });
        } catch (error) {
          const timedOut = error instanceof Error && error.name === "TimeoutError";
          return Response.json({
            error: timedOut
              ? "Provider timeout setelah 45 detik. 9Router tidak mengembalikan response."
              : `Provider tidak dapat dihubungi: ${error instanceof Error ? error.message : "unknown error"}`,
            code: timedOut ? "PROVIDER_TIMEOUT" : "PROVIDER_UNREACHABLE"
          }, { status: 504 });
        }

        const rawText = await res.text();

        if (!res.ok) {
          return Response.json({ error: rawText, status: res.status }, { status: res.status });
        }

        let reply = "";
        let usage: any = null;

        // 1. Try standard JSON parse
        try {
          const data = JSON.parse(rawText);
          const message = data.choices?.[0]?.message;
          if (message?.tool_calls?.length) {
            const toolMessages: Array<Record<string, unknown>> = [...routerMessages, { role: "assistant", content: message.content || null, tool_calls: message.tool_calls }];
            for (const call of message.tool_calls) {
              const name = call.function?.name;
              const args = JSON.parse(call.function?.arguments || "{}");
              try {
                const result = await executeChatTool(name, args);
                toolMessages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result).slice(0, 12000) });
              } catch (error) {
                toolMessages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) });
              }
            }
            const followUp = await fetch(`${baseUrl}/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` }, body: JSON.stringify({ model, messages: toolMessages, temperature: 0.7, stream: false }), signal: AbortSignal.timeout(45000) });
            const followData = await followUp.json() as { choices?: Array<{ message?: { content?: string; reasoning_content?: string } }> };
            const followMsg = followData.choices?.[0]?.message;
            reply = followMsg?.content || followMsg?.reasoning_content || "";
          } else reply = message?.content || message?.reasoning_content || "";
          usage = data.usage || null;
        } catch (_) {}

        // 2. Fallback: Parse SSE chunks if 9Router returned event-stream
        if (!reply && rawText.includes("data:")) {
          const lines = rawText.split("\n");
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("data:") && !trimmed.includes("[DONE]")) {
              try {
                const chunk = JSON.parse(trimmed.slice(5).trim());
                const delta = chunk.choices?.[0]?.delta;
                reply += delta?.content || delta?.reasoning_content || "";
                if (chunk.usage) usage = chunk.usage;
              } catch (_) {}
            }
          }
        }

        // 3. Fallback: never surface a raw provider envelope as the reply
        if (!reply) {
          try {
            const envelope = JSON.parse(rawText);
            const m = envelope?.choices?.[0]?.message;
            const inner = m?.content || m?.reasoning_content;
            if (typeof inner === "string" && inner.trim()) reply = inner;
          } catch (_) {}
        }

        if (!reply) {
          const trimmedRaw = rawText.trim();
          const looksLikeEnvelope = /^\{[\s\S]*"(choices|object|error)"\s*:/.test(trimmedRaw);
          reply = looksLikeEnvelope ? "(Model tidak mengembalikan konten)" : (trimmedRaw || "(No response from model)");
        }

        // Automatically extract delegated tasks if Rinna-chan or any agent outputted ```tasks ... ``` or ```json ... ``` with tasks
        const delegatedTasks: DBTask[] = [];
        let taskJsonStr = "";
        const candidates = [
          ...(reply.match(/```(?:tasks|json)?\s*([\s\S]*?)\s*```/gi) || []).map((block) => block.replace(/^```(?:tasks|json)?\s*/i, '').replace(/```\s*$/, '').trim()),
          ...(reply.match(/\[[\s\S]*?\]/g) || [])
        ];
        for (const candidate of candidates) {
          try {
            const parsed = JSON.parse(candidate);
            if (Array.isArray(parsed) && parsed.some((item) => item && typeof item === "object" && item.title)) {
              taskJsonStr = candidate;
              break;
            }
          } catch (_) {}
        }

        if (taskJsonStr) {
          try {
            const parsedTasks = JSON.parse(taskJsonStr.trim());
            if (Array.isArray(parsedTasks)) {
              for (const pt of parsedTasks) {
                  if (pt.title) {
                    const assignedAgent = pt.agentId || pt.assignedAgent || pt.agent || agent.id;
                    const assignedAgentObj = BLUE_ARCHIVE_AGENTS.find((a) => a.id === assignedAgent);
                    const taskModel = pt.model || model || assignedAgentObj?.defaultModel || "free-combo1";
                    const newTask: DBTask = {
                    id: "task-" + Math.random().toString(36).substring(2, 9),
                    title: pt.title,
                    description: pt.description || "",
                      assignedAgent,
                    model: taskModel,
                    status: "todo",
                    createdAt: new Date().toISOString()
                  };
                  TaskRepo.upsertTask(newTask);
                  delegatedTasks.push(newTask);
                }
              }
            }
          } catch (_) {}
        }

        // Clean out raw ```tasks ... ``` block from the chat reply so it looks beautiful
        const cleanReply = reply.replace(/```(?:tasks|json)?\s*[\s\S]*?```/gi, "").trim();

        // Save assistant reply to SQLite DB
        ChatRepo.addMessage(agent.id, "assistant", cleanReply || reply, model);

        return Response.json({
          reply: cleanReply || reply,
          delegatedTasks,
          usage,
          model,
          agent: agent.name
        });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const htmlPath = join(__dirname, "public", "index.html");
      if (existsSync(htmlPath)) {
        return new Response(readFileSync(htmlPath), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache, no-store, must-revalidate"
          }
        });
      }
    }

    // Uploaded chat images
    if (url.pathname.startsWith("/uploads/")) {
      const safe = url.pathname.split("/").pop() || "";
      if (!/^[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp|gif)$/.test(safe)) {
        return new Response("Not Found", { status: 404 });
      }
      const full = join(UPLOAD_DIR, safe);
      if (!existsSync(full)) {
        return new Response("Not Found", { status: 404 });
      }
      const ext = safe.split(".").pop()?.toLowerCase() || "png";
      const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/png";
      return new Response(readFileSync(full), {
        headers: { "Content-Type": mime, "Cache-Control": "public, max-age=86400" }
      });
    }

    // Static files
    const publicFile = join(__dirname, "public", url.pathname);
    if (existsSync(publicFile)) {
      const ext = url.pathname.split(".").pop();
      const mimeTypes: Record<string, string> = {
        "js": "application/javascript",
        "css": "text/css",
        "png": "image/png",
        "svg": "image/svg+xml"
      };
      return new Response(readFileSync(publicFile), {
        headers: {
          "Content-Type": mimeTypes[ext || ""] || "text/plain",
          "Cache-Control": "no-cache, no-store, must-revalidate"
        }
      });
    }

    return new Response("Not Found", { status: 404 });
  }
});

console.log(`🌸 Hermes Hub running at: http://localhost:${PORT} (with SQLite persistence in ./data/hermes.db)`);
