import { Database } from "bun:sqlite";
import { existsSync } from "fs";

// Live quota fetching for Antigravity accounts, mirroring 9Router's own
// reverse-engineered flow (see 9router dashboard bundle):
//   loadCodeAssist -> fetchAvailableModels + retrieveUserQuotaSummary
//
// Tokens are read from 9Router's local SQLite (readonly) and used only
// server-side toward Google. They are NEVER returned to the browser.

const ROUTER_DB_PATH = `${process.env.HOME || "/home/salahudin"}/.9router/db/data.sqlite`;

const AG_BASE = "https://daily-cloudcode-pa.googleapis.com";
const AG_LOAD_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const AG_UA = "antigravity/ide/2.11.0 darwin/arm64";
const AG_CLIENT_VERSION = "2.11.0";
const AG_CLIENT_ID = process.env.AG_CLIENT_ID ?? "";
const AG_CLIENT_SECRET = process.env.AG_CLIENT_SECRET ?? "";
const AG_METADATA = { ideType: 9, platform: 3, pluginType: 2 };

const CACHE_TTL_MS = 3 * 60 * 1000; // same as 9Router dashboard cache

export type LiveProvider = "antigravity" | "codex" | "codebuddy-intl" | "qoder" | "openrouter" | "kiro" | "zed" | "grok-cli";

export interface LiveQuotaBucket {
  key: string;
  label: string;
  used: number;
  total: number;
  remainingPct: number;
  resetAt: string | null;
  resetLabel: string | null;
}

export interface LiveModelQuota {
  model: string;
  displayName: string;
  used: number;
  total: number;
  remainingPct: number;
  resetAt: string | null;
}

export interface LiveQuotaResult {
  provider: string;
  id: string;
  label: string;
  plan: string;
  fetchedAt: string;
  cached: boolean;
  buckets: LiveQuotaBucket[];
  models: LiveModelQuota[];
  note?: string | null;
}

const cache = new Map<string, { result: LiveQuotaResult; expiresAt: number }>();

function resetLabel(resetAt: string | null): string | null {
  if (!resetAt) return null;
  const diff = new Date(resetAt).getTime() - Date.now();
  if (!Number.isFinite(diff) || diff <= 0) return "reset soon";
  const mins = Math.floor(diff / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `in ${d}d ${h}h ${m}m`;
  if (h > 0) return `in ${h}h ${m}m`;
  return `in ${m}m`;
}

async function agPost(token: string, url: string, body: unknown): Promise<{ ok: boolean; status: number; json: any }> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": AG_UA,
      "Content-Type": "application/json",
      "X-Client-Name": "antigravity",
      "X-Client-Version": AG_CLIENT_VERSION
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  let json: any = null;
  try { json = await res.json(); } catch (_) {}
  return { ok: res.ok, status: res.status, json };
}

async function refreshAccessToken(refreshToken: string): Promise<string | null> {
  if (!AG_CLIENT_ID || !AG_CLIENT_SECRET) return null;
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: AG_CLIENT_ID,
        client_secret: AG_CLIENT_SECRET
      }).toString()
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    return typeof data.access_token === "string" ? data.access_token : null;
  } catch (_) {
    return null;
  }
}

function getConnectionRow(id: string): { provider: string; email: string | null; name: string; data: any } | null {
  if (!existsSync(ROUTER_DB_PATH)) return null;
  const db = new Database(ROUTER_DB_PATH, { readonly: true });
  try {
    const row = db.query<{ provider: string; email: string | null; name: string | null; data: string }, [string]>(
      `SELECT provider, email, name, data FROM providerConnections WHERE id = ? LIMIT 1`
    ).get(id) as any;
    if (!row) return null;
    return { provider: row.provider, email: row.email, name: row.name || row.email || "Unnamed", data: JSON.parse(row.data) };
  } catch (_) {
    return null;
  } finally {
    db.close();
  }
}

function getAntigravityRow(email: string): { accessToken: string; refreshToken: string } | null {
  if (!existsSync(ROUTER_DB_PATH)) return null;
  const db = new Database(ROUTER_DB_PATH, { readonly: true });
  try {
    const row = db.query<{ data: string }, [string]>(
      `SELECT data FROM providerConnections WHERE email = ? AND provider = 'antigravity' LIMIT 1`
    ).get(email) as any;
    if (!row) return null;
    const data = JSON.parse(row.data);
    if (!data.accessToken) return null;
    return { accessToken: data.accessToken, refreshToken: data.refreshToken };
  } catch (_) {
    return null;
  } finally {
    db.close();
  }
}

// Models shown on the Antigravity cards (same allowlist as 9Router).
const TRACKED_MODELS = new Set([
  "gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low",
  "gemini-3.7-flash-high", "gemini-3.7-flash-medium", "gemini-3.7-flash-low",
  "gemini-3.6-flash-high", "gemini-3.6-flash-medium", "gemini-3.6-flash-low",
  "gemini-3.5-flash-low", "gemini-3.5-flash-extra-low",
  "gemini-pro-agent", "gemini-3.1-pro-low",
  "claude-sonnet-4-6", "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium", "gemini-3.1-flash-image"
]);

export async function fetchLiveAntigravityQuota(email: string): Promise<LiveQuotaResult> {
  const cached = cache.get(`ag:${email}`);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.result, cached: true };
  }

  const creds = getAntigravityRow(email);
  if (!creds) throw new Error("Antigravity account not found in 9Router DB");

  let token = creds.accessToken;
  const call = async () => {
    const load = await agPost(token, AG_LOAD_URL, { metadata: AG_METADATA, mode: 1 });
    if (!load.ok) return { load, project: null as string | null };
    const project = load.json?.cloudaicompanionProject || "aicode-consumers";
    const plan = load.json?.currentTier?.name || "Unknown";
    const [avail, summary] = await Promise.all([
      agPost(token, `${AG_BASE}/v1internal:fetchAvailableModels`, { project }),
      agPost(token, `${AG_BASE}/v1internal:retrieveUserQuotaSummary`, { project })
    ]);
    return { load, project, plan, avail, summary };
  };

  let r = await call();
  if (!r.load.ok && r.load.status === 401 && creds.refreshToken) {
    const fresh = await refreshAccessToken(creds.refreshToken);
    if (fresh) {
      token = fresh;
      r = await call();
    }
  }
  if (!r.load.ok) {
    throw new Error(`Google auth failed (${r.load.status}). 9Router will refresh the token itself — try again shortly.`);
  }

  const models: LiveModelQuota[] = [];
  const availModels = r.avail?.json?.models || {};
  for (const [mid, m] of Object.entries<any>(availModels)) {
    if (m?.isInternal || !TRACKED_MODELS.has(mid) || !m?.quotaInfo) continue;
    const frac = Number(m.quotaInfo.remainingFraction ?? 0);
    const used = Math.max(0, 1000 - Math.round(1000 * frac));
    models.push({
      model: mid,
      displayName: m.displayName || mid,
      used,
      total: 1000,
      remainingPct: Math.round(100 * frac),
      resetAt: m.quotaInfo.resetTime || null
    });
  }

  const buckets: LiveQuotaBucket[] = [];
  const groups = r.summary?.json?.groups || [];
  const defs = [
    { pattern: /gemini/i, key: "gemini_weekly", label: "Gemini (Weekly)" },
    { pattern: /claude|gpt/i, key: "claude_gpt_weekly", label: "Claude & GPT (Weekly)" }
  ];
  for (const g of groups) {
    const gName = g.displayName || "";
    for (const b of g.buckets || []) {
      const win = String(b.window || "").toLowerCase();
      if (win !== "weekly") continue;
      const frac = Number(b.remainingFraction ?? 0);
      const def = defs.find(d => d.pattern.test(gName));
      if (!def || buckets.some(x => x.key === def.key)) continue;
      buckets.push({
        key: def.key,
        label: def.label,
        used: Math.max(0, 1000 - Math.round(1000 * frac)),
        total: 1000,
        remainingPct: Math.round(100 * frac),
        resetAt: b.resetTime || null,
        resetLabel: resetLabel(b.resetTime || null)
      });
    }
  }

  const result: LiveQuotaResult = {
    provider: "antigravity",
    id: `ag:${email}`,
    label: email,
    plan: r.plan || "Unknown",
    fetchedAt: new Date().toISOString(),
    cached: false,
    buckets,
    models: models.sort((a, b) => a.remainingPct - b.remainingPct)
  };
  cache.set(`ag:${email}`, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

// ---- OpenAI Codex: GET https://chatgpt.com/backend-api/wham/usage ----
export async function fetchLiveCodexQuota(id: string): Promise<LiveQuotaResult> {
  const cached = cache.get(id);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.result, cached: true };
  }
  const conn = getConnectionRow(id);
  if (!conn || conn.provider !== "codex") throw new Error("Codex account not found in 9Router DB");
  const token = conn.data.accessToken;
  if (!token) throw new Error("Codex credential not available");

  const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
  });
  if (!res.ok) throw new Error(`Codex usage API error (${res.status})`);
  const j = await res.json() as any;

  const buckets: LiveQuotaBucket[] = [];
  const pushWindow = (key: string, label: string, w: any) => {
    if (!w || typeof w.used_percent !== "number") return;
    const used = Math.max(0, Math.min(100, Math.round(w.used_percent)));
    buckets.push({
      key, label, used, total: 100,
      remainingPct: Math.max(0, 100 - used),
      resetAt: w.reset_at ? new Date(w.reset_at * 1000).toISOString() : null,
      resetLabel: resetLabel(w.reset_at ? new Date(w.reset_at * 1000).toISOString() : null)
    });
  };
  const rl = j.rate_limit || {};
  pushWindow("session", "5h", rl.primary_window);
  pushWindow("weekly", "Weekly", rl.secondary_window);

  const result: LiveQuotaResult = {
    provider: "codex",
    id,
    label: conn.email || conn.name,
    plan: j.plan_type || "unknown",
    fetchedAt: new Date().toISOString(),
    cached: false,
    buckets,
    models: []
  };
  cache.set(id, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

// ---- CodeBuddy Intl: POST https://www.codebuddy.ai/v2/billing/meter/get-user-resource ----
const CB_HEADERS = {
  "User-Agent": "IDE/2.108.1 CodeBuddy/2.108.1",
  "X-Product": "SaaS",
  "X-IDE-Type": "IDE",
  "X-IDE-Name": "IDE",
  "x-requested-with": "XMLHttpRequest",
  "x-codebuddy-request": "1"
};

export async function fetchLiveCodeBuddyQuota(id: string): Promise<LiveQuotaResult> {
  const cached = cache.get(id);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.result, cached: true };
  }
  const conn = getConnectionRow(id);
  if (!conn || conn.provider !== "codebuddy-intl") throw new Error("CodeBuddy account not found in 9Router DB");
  const token = conn.data.accessToken || conn.data.apiKey;
  if (!token) throw new Error("CodeBuddy credential not available");

  const res = await fetch("https://www.codebuddy.ai/v2/billing/meter/get-user-resource", {
    method: "POST",
    headers: { ...CB_HEADERS, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: "{}"
  });
  if (!res.ok) throw new Error(`CodeBuddy quota API error (${res.status})`);
  const j = await res.json() as any;
  if (j?.code !== 0) throw new Error(`CodeBuddy quota error: ${j?.msg || "unknown"}`);
  const accounts: any[] = j?.data?.Response?.Data?.Accounts || [];

  const num = (v: any, fb = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fb;
  };
  const byCycleEnd = (a: any, b: any) =>
    new Date(a.CycleEndTime || 0).getTime() - new Date(b.CycleEndTime || 0).getTime();
  const isRecurring = (a: any) => {
    const end = new Date(a.CycleEndTime || 0).getTime();
    const ded = Number(a.DeductionEndTime);
    return Number.isFinite(end) && Number.isFinite(ded) && ded - end > 1728e5;
  };
  const recurring = accounts.filter(isRecurring).sort(byCycleEnd);
  const oneTime = accounts.filter(a => !isRecurring(a)).sort(byCycleEnd);

  const buckets: LiveQuotaBucket[] = [];
  recurring.forEach((a) => {
    const used = num(a.CycleCapacityUsedPrecise, num(a.CycleCapacityUsed));
    const total = num(a.CycleCapacitySizePrecise, num(a.CycleCapacitySize));
    const remaining = total > 0 ? Math.max(0, Math.round(((total - used) / total) * 100)) : 100;
    buckets.push({
      key: "monthly",
      label: /bonus/i.test(a.PackageName || "") ? (a.PackageName || "Bonus") : "Monthly",
      used, total,
      remainingPct: remaining,
      resetAt: a.CycleEndTime ? new Date(a.CycleEndTime).toISOString() : null,
      resetLabel: resetLabel(a.CycleEndTime ? new Date(a.CycleEndTime).toISOString() : null)
    });
  });
  oneTime.forEach((a, i) => {
    const used = num(a.CapacityUsedPrecise, num(a.CapacityUsed));
    const total = num(a.CapacitySizePrecise, num(a.CapacitySize));
    const remaining = total > 0 ? Math.max(0, Math.round(((total - used) / total) * 100)) : 100;
    buckets.push({
      key: `bonus-${i + 1}`,
      label: `Bonus Pack ${i + 1}`,
      used, total,
      remainingPct: remaining,
      resetAt: a.CycleEndTime ? new Date(a.CycleEndTime).toISOString() : null,
      resetLabel: resetLabel(a.CycleEndTime ? new Date(a.CycleEndTime).toISOString() : null)
    });
  });

  const first = recurring[0] || accounts[0] || {};
  const result: LiveQuotaResult = {
    provider: "codebuddy-intl",
    id,
    label: conn.name,
    plan: first.PackageName || first.SubProductName || "CodeBuddy",
    fetchedAt: new Date().toISOString(),
    cached: false,
    buckets,
    models: []
  };
  cache.set(id, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

export async function fetchLiveQuotaById(id: string): Promise<LiveQuotaResult> {
  const cached = cache.get(id);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.result, cached: true };
  }
  const conn = getConnectionRow(id);
  if (!conn) throw new Error("Account not found in 9Router DB");
  if (conn.provider === "codex") return fetchLiveCodexQuota(id);
  if (conn.provider === "codebuddy-intl") return fetchLiveCodeBuddyQuota(id);
  if (conn.provider === "qoder" || conn.provider === "qoder-cn") return fetchLiveQoderQuota(id);
  if (conn.provider === "openrouter") return fetchLiveOpenRouterQuota(id);
  if (conn.provider === "kiro") return fetchLiveKiroQuota(id);
  if (conn.provider === "zed") return fetchLiveZedQuota(id);
  if (conn.provider === "grok-cli") return fetchLiveGrokQuota(id);
  if (conn.provider === "antigravity") {
    if (!conn.email) throw new Error("Antigravity account has no email");
    return fetchLiveAntigravityQuota(conn.email);
  }
  if (conn.provider === "cline" || conn.provider === "clinepass") {
    return {
      provider: conn.provider, id, label: conn.email || conn.name,
      plan: "Cline", fetchedAt: new Date().toISOString(), cached: false,
      buckets: [], models: [],
      note: "Token OAuth expired — silakan re-auth akun ini di dashboard 9Router dulu, baru ⚡ Live bisa jalan."
    };
  }
  return {
    provider: conn.provider, id, label: conn.email || conn.name,
    plan: "Free tier", fetchedAt: new Date().toISOString(), cached: false,
    buckets: [], models: [],
    note: "Free-tier API key — provider ini tidak punya quota API, pemakaian unlimited selama key aktif."
  };
}

// ---- Qoder: GET https://openapi.qoder.sh/api/v2/quota/usage ----
export async function fetchLiveQoderQuota(id: string): Promise<LiveQuotaResult> {
  const cached = cache.get(id);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.result, cached: true };
  }
  const conn = getConnectionRow(id);
  if (!conn || (conn.provider !== "qoder" && conn.provider !== "qoder-cn")) throw new Error("Qoder account not found in 9Router DB");
  const token = conn.data.accessToken;
  if (!token) throw new Error("Qoder credential not available");

  const res = await fetch("https://openapi.qoder.sh/api/v2/quota/usage", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`Qoder usage API error (${res.status})`);
  const j = await res.json() as any;
  const buckets: LiveQuotaBucket[] = [];
  const pushCredits = (key: string, label: string, q: any, resetAt: string | null) => {
    if (!q) return;
    const total = Number(q.total) || 0;
    const used = Number(q.used) || 0;
    if (total <= 0 && used <= 0) return;
    buckets.push({
      key, label, used, total,
      remainingPct: total > 0 ? Math.max(0, Math.round(((total - used) / total) * 100)) : 0,
      resetAt, resetLabel: resetLabel(resetAt)
    });
  };
  const resetAt = j.expiresAt && Number(j.expiresAt) > 0 ? new Date(Number(j.expiresAt)).toISOString() : null;
  pushCredits("user", "User Credits", j.userQuota, resetAt);
  pushCredits("org", "Organization Credits", j.orgResourcePackage, resetAt);

  const result: LiveQuotaResult = {
    provider: conn.provider, id,
    label: conn.email || conn.name,
    plan: buckets.length === 0 ? "Qoder" : (j.isQuotaExceeded ? "Qoder (limit reached)" : "Qoder"),
    fetchedAt: new Date().toISOString(), cached: false,
    buckets, models: [],
    note: buckets.length === 0 ? "Quota kosong / habis — cek upgrade di qoder.com/pricing." : null
  };
  cache.set(id, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

// ---- OpenRouter: GET https://openrouter.ai/api/v1/auth/key ----
export async function fetchLiveOpenRouterQuota(id: string): Promise<LiveQuotaResult> {
  const cached = cache.get(id);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.result, cached: true };
  }
  const conn = getConnectionRow(id);
  if (!conn || conn.provider !== "openrouter") throw new Error("OpenRouter account not found in 9Router DB");
  const key = conn.data.apiKey;
  if (!key) throw new Error("OpenRouter API key not available");

  const res = await fetch("https://openrouter.ai/api/v1/auth/key", {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`OpenRouter key API error (${res.status})`);
  const j = await res.json() as any;
  const d = j.data || {};
  const buckets: LiveQuotaBucket[] = [];
  const free = d.free_model_daily_requests || {};
  if (typeof free.limit === "number" && free.limit > 0) {
    const used = Number(free.used) || 0;
    buckets.push({
      key: "free-daily", label: "Free Models (Daily)", used, total: free.limit,
      remainingPct: Math.max(0, Math.round(((free.limit - used) / free.limit) * 100)),
      resetAt: null, resetLabel: "resets daily"
    });
  }
  if (typeof d.limit === "number" && d.limit > 0) {
    const used = Number(d.usage) || 0;
    buckets.push({
      key: "credits", label: "Credits (USD)", used, total: d.limit,
      remainingPct: Math.max(0, Math.round(((d.limit - used) / d.limit) * 100)),
      resetAt: null, resetLabel: null
    });
  } else {
    buckets.push({
      key: "usage", label: "Usage (credits)", used: Number(d.usage) || 0, total: 0,
      remainingPct: 100, resetAt: null, resetLabel: d.is_free_tier ? "free tier" : null
    });
  }

  const result: LiveQuotaResult = {
    provider: conn.provider, id,
    label: d.label || conn.name,
    plan: d.is_free_tier ? "Free tier" : "Pay-as-you-go",
    fetchedAt: new Date().toISOString(), cached: false,
    buckets, models: []
  };
  cache.set(id, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

// ---- Kiro: GET https://codewhisperer.us-east-1.amazonaws.com/getUsageLimits ----
export async function fetchLiveKiroQuota(id: string): Promise<LiveQuotaResult> {
  const cached = cache.get(id);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.result, cached: true };
  }
  const conn = getConnectionRow(id);
  if (!conn || conn.provider !== "kiro") throw new Error("Kiro account not found in 9Router DB");
  const token = conn.data.accessToken;
  if (!token) throw new Error("Kiro credential not available");

  const qs = new URLSearchParams({ isEmailRequired: "true", origin: "AI_EDITOR", resourceType: "AGENTIC_REQUEST" });
  const res = await fetch(`https://codewhisperer.us-east-1.amazonaws.com/getUsageLimits?${qs.toString()}`, {
    headers: {
      Authorization: `Bearer ${token}`, Accept: "application/json",
      "x-amz-user-agent": "aws-sdk-js/1.0.0 KiroIDE", "user-agent": "aws-sdk-js/1.0.0 KiroIDE"
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`Kiro usage API error (${res.status})`);
  const j = await res.json() as any;
  const buckets: LiveQuotaBucket[] = [];
  const list = Array.isArray(j.usageBreakdownList) ? j.usageBreakdownList : [];
  for (const u of list) {
    const total = Number(u.usageLimitWithPrecision ?? u.usageLimit);
    const used = Number(u.currentUsageWithPrecision ?? u.currentUsage) || 0;
    if (!Number.isFinite(total) || total <= 0) continue;
    const resetAt = u.nextDateReset ? new Date(Number(u.nextDateReset) * 1000).toISOString() : null;
    buckets.push({
      key: (u.displayName || "credit").toLowerCase().replace(/\s+/g, "-"),
      label: `${u.displayName || "Credit"} (${u.unit || "invocations"})`,
      used, total,
      remainingPct: Math.max(0, Math.round(((total - used) / total) * 100)),
      resetAt, resetLabel: resetLabel(resetAt)
    });
  }

  const result: LiveQuotaResult = {
    provider: conn.provider, id,
    label: j.userInfo?.email || conn.name,
    plan: j.subscriptionInfo?.subscriptionTitle || "Kiro",
    fetchedAt: new Date().toISOString(), cached: false,
    buckets, models: [],
    note: buckets.length === 0 ? "Tidak ada paket kredit aktif di akun ini." : null
  };
  cache.set(id, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

// ---- Zed: GET https://cloud.zed.dev/client/users/me ----
const ZED_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export async function fetchLiveZedQuota(id: string): Promise<LiveQuotaResult> {
  const cached = cache.get(id);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.result, cached: true };
  }
  const conn = getConnectionRow(id);
  if (!conn || conn.provider !== "zed") throw new Error("Zed account not found in 9Router DB");
  const psd = conn.data.providerSpecificData || {};
  const userId = psd.userId;
  const token = conn.data.accessToken;
  if (!userId || !token) throw new Error("Zed credential is missing userId or accessToken");

  const res = await fetch("https://cloud.zed.dev/client/users/me", {
    headers: {
      Authorization: `${userId} ${token}`, Accept: "application/json",
      "x-zed-system-id": psd.systemId || "", "User-Agent": ZED_UA
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`Zed API error (${res.status})`);
  const j = await res.json() as any;
  const plan = j.plan?.plan_v3 || j.plan?.plan || "zed_free";
  const planLabel = String(plan).toLowerCase() === "zed_free" ? "Zed Free" : String(plan).toLowerCase() === "zed_pro" ? "Zed Pro" : String(plan);
  const periodEnd = j.plan?.subscription_period?.ended_at || null;
  const usage = j.plan?.usage || {};
  const buckets: LiveQuotaBucket[] = [];
  const pushUsage = (key: string, label: string, u: any) => {
    if (!u) return;
    const lim = u.limit || {};
    const total = Number(lim.limited);
    const used = Number(u.used) || 0;
    if (!Number.isFinite(total) || total <= 0) return;
    buckets.push({
      key, label, used, total,
      remainingPct: Math.max(0, Math.round(((total - used) / total) * 100)),
      resetAt: periodEnd ? new Date(periodEnd).toISOString() : null,
      resetLabel: resetLabel(periodEnd ? new Date(periodEnd).toISOString() : null)
    });
  };
  pushUsage("models", "Hosted Model Requests", usage.model_requests);
  pushUsage("edits", "Edit Predictions", usage.edit_predictions);

  const result: LiveQuotaResult = {
    provider: conn.provider, id,
    label: j.user?.email || j.user?.github_login || conn.name,
    plan: planLabel,
    fetchedAt: new Date().toISOString(), cached: false,
    buckets, models: [],
    note: buckets.length === 0 ? "Model requests pay-per-token — tracking di dashboard.zed.dev." : null
  };
  cache.set(id, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

// ---- Grok gRPC helpers (ported from 9Router dashboard bundle) ----
function grpcReadVarint(buf: Buffer, off: number): { value: number; next: number } | null {
  let v = 0n;
  let shift = 0n;
  let e = off;
  for (;;) {
    if (e >= buf.length) return null;
    const b = buf[e];
    if (b === undefined) return null;
    v |= BigInt(127 & b) << shift;
    e += 1;
    if ((128 & b) === 0) break;
    shift += 7n;
    if (shift > 70n) return null;
  }
  return { value: Number(v), next: e };
}

interface ProtoField { wireType: number; bytes?: Buffer; value?: number }

function grpcDecodeMessage(buf: Buffer): Map<number, ProtoField> | null {
  const out = new Map<number, ProtoField>();
  let c = 0;
  while (c < buf.length) {
    const tag = grpcReadVarint(buf, c);
    if (!tag) return null;
    const fieldNumber = tag.value >>> 3;
    const wt = 7 & tag.value;
    if (fieldNumber === 0) return null;
    if (wt === 0) {
      const v = grpcReadVarint(buf, tag.next);
      if (!v) return null;
      out.set(fieldNumber, { wireType: 0, value: v.value });
      c = v.next;
    } else if (wt === 2) {
      const len = grpcReadVarint(buf, tag.next);
      if (!len) return null;
      const { value: d, next: e } = len;
      if (d < 0 || e + d > buf.length) return null;
      out.set(fieldNumber, { wireType: 2, bytes: buf.subarray(e, e + d) });
      c = e + d;
    } else if (wt === 1 || wt === 5) {
      const size = wt === 1 ? 8 : 4;
      if (tag.next + size > buf.length) return null;
      out.set(fieldNumber, { wireType: wt, bytes: buf.subarray(tag.next, tag.next + size) });
      c = tag.next + size;
    } else {
      return null;
    }
  }
  return out;
}

function grpcParseFrame(buf: Buffer, off: number): { flag: number; payloadStart: number; payloadLength: number } | null {
  if (off < 0 || buf.length - off < 5) return null;
  const flag = buf[off];
  if (flag !== 0 && flag !== 1 && flag !== 128 && flag !== 129) return null;
  const len = buf.readUInt32BE(off + 1);
  const start = off + 5;
  if (len > buf.length - start) return null;
  return { flag, payloadStart: start, payloadLength: len };
}

async function grokGrpcCredits(token: string): Promise<{ percentUsed: number; resetAt: string | null } | null> {
  try {
    const res = await fetch("https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/grpc-web+proto",
        "X-Grpc-Web": "1",
        Accept: "application/grpc-web+proto"
      },
      body: Buffer.from([0, 0, 0, 0, 0]),
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return null;
    const raw = Buffer.from(await res.arrayBuffer());
    if (!raw.length) return null;
    // Unwrap grpc-web frames, take first DATA frame payload
    let payload: Buffer | null = null;
    let b = 0;
    while (b < raw.length) {
      const f = grpcParseFrame(raw, b);
      if (!f) break;
      const end = f.payloadStart + f.payloadLength;
      if ((128 & f.flag) === 0) {
        payload = raw.subarray(f.payloadStart, end);
        break;
      }
      b = end;
    }
    if (!payload) return null;
    const msg = grpcDecodeMessage(payload);
    if (!msg) return null;
    const f1 = msg.get(1);
    const nested = f1 && f1.wireType === 2 && f1.bytes ? grpcDecodeMessage(f1.bytes) : null;
    if (!nested) return null;
    const g1 = nested.get(1);
    const frac = g1 && g1.bytes
      ? (g1.wireType === 5 ? g1.bytes.readFloatLE(0) : g1.wireType === 1 ? g1.bytes.readDoubleLE(0) : null)
      : 0;
    if (frac === null || !Number.isFinite(frac) || frac < 0) return null;
    const f5 = nested.get(5);
    let resetAt: string | null = null;
    if (f5 && f5.wireType === 2 && f5.bytes) {
      const ts = grpcDecodeMessage(f5.bytes);
      const sec = ts?.get(1);
      const nano = ts?.get(2);
      const s = sec?.wireType === 0 ? sec.value || 0 : 0;
      const n = nano?.wireType === 0 ? nano.value || 0 : 0;
      const dt = new Date(1000 * s + Math.round(n / 1e6));
      if (!Number.isNaN(dt.getTime())) resetAt = dt.toISOString();
    }
    return { percentUsed: Math.min(100, 100 * frac), resetAt };
  } catch (_) {
    return null;
  }
}

function grokPlanFromToken(token: string): string {
  try {
    const seg = token.split(".")[1];
    if (!seg) return "";
    const payload = JSON.parse(Buffer.from(seg, "base64url").toString("utf8"));
    const names: Record<number, string> = { 0: "Free", 1: "SuperGrok", 2: "X Basic", 3: "X Premium", 4: "X Premium Plus", 5: "SuperGrok Heavy", 6: "SuperGrok Lite" };
    return names[payload.tier] || "";
  } catch (_) {
    return "";
  }
}

// ---- Grok CLI: GET billing + user (REST; angka % detail ada di grpc binary) ----
export async function fetchLiveGrokQuota(id: string): Promise<LiveQuotaResult> {
  const cached = cache.get(id);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.result, cached: true };
  }
  const conn = getConnectionRow(id);
  if (!conn || conn.provider !== "grok-cli") throw new Error("Grok account not found in 9Router DB");
  const token = conn.data.accessToken;
  if (!token) throw new Error("Grok credential not available");
  const psd = conn.data.providerSpecificData || {};
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`, Accept: "application/json",
    "User-Agent": "grok-shell/0.2.99 (linux; x86_64)",
    "x-xai-token-auth": "xai-grok-cli",
    "x-grok-client-identifier": "grok-shell",
    "x-grok-client-version": "0.2.99",
    "x-grok-client-mode": "headless"
  };
  if (psd.email) headers["x-email"] = psd.email;
  if (psd.userId || psd.principalId) headers["x-userid"] = psd.userId || psd.principalId;

  const [billingRes, userRes] = await Promise.all([
    fetch("https://cli-chat-proxy.grok.com/v1/billing?format=credits", { headers, signal: AbortSignal.timeout(15000) }),
    fetch("https://cli-chat-proxy.grok.com/v1/user?include=subscription", { headers, signal: AbortSignal.timeout(15000) }).catch(() => null)
  ]);
  if (!billingRes.ok) throw new Error(`Grok billing API error (${billingRes.status})`);
  const billing = await billingRes.json() as any;
  const user = userRes && userRes.ok ? await userRes.json().catch(() => null) as any : null;
  const cfg = billing.config || billing;
  const periodEnd = cfg.billingPeriodEnd || cfg.currentPeriod?.end || null;

  const num = (v: any) => {
    const n = Number(v?.val ?? v);
    return Number.isFinite(n) ? n : NaN;
  };
  const buckets: LiveQuotaBucket[] = [];
  const monthly = num(cfg.monthlyLimit ?? cfg.monthly_limit);
  if (Number.isFinite(monthly) && monthly > 0) {
    const used = num(cfg.includedUsed ?? cfg.included_used ?? cfg.totalUsed ?? cfg.total_used) || 0;
    buckets.push({
      key: "monthly", label: "Monthly Included", used, total: monthly,
      remainingPct: Math.max(0, Math.round(((monthly - used) / monthly) * 100)),
      resetAt: periodEnd, resetLabel: resetLabel(periodEnd)
    });
  }
  const prepaid = num(cfg.prepaidBalance);
  if (Number.isFinite(prepaid) && prepaid > 0) {
    buckets.push({
      key: "prepaid", label: "Prepaid Balance", used: 0, total: prepaid,
      remainingPct: 100, resetAt: null, resetLabel: null
    });
  }

  const tier = user?.subscriptionTier || psd.subscriptionTier || null;
  const grpcPlan = grokPlanFromToken(token);
  // grpc percent (authoritative weekly usage) fills in when REST has no numbers
  if (buckets.length === 0) {
    const grpc = await grokGrpcCredits(token);
    if (grpc && Number.isFinite(grpc.percentUsed)) {
      const used = Math.round(Math.max(0, Math.min(100, grpc.percentUsed)));
      buckets.push({
        key: "weekly-supergrok", label: "Weekly SuperGrok", used, total: 100,
        remainingPct: Math.max(0, 100 - used),
        resetAt: grpc.resetAt, resetLabel: resetLabel(grpc.resetAt)
      });
    }
  }
  const result: LiveQuotaResult = {
    provider: conn.provider, id,
    label: user?.email || psd.email || conn.email || conn.name,
    plan: grpcPlan || (tier ? String(tier) : (user?.hasGrokCodeAccess ? "Grok Code" : "Grok")),
    fetchedAt: new Date().toISOString(), cached: false,
    buckets, models: [],
    note: buckets.length === 0
      ? `Periode ${(cfg.currentPeriod?.type || "weekly").toLowerCase()} s/d ${periodEnd ? new Date(periodEnd).toLocaleDateString() : "-"} — Grok tidak mengekspos angka quota numerik.`
      : null
  };
  cache.set(id, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}
