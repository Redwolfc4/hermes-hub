import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "fs";
import { join } from "path";

const DATA_DIR = join(__dirname, "../data");
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = join(DATA_DIR, "hermes.db");
export const db = new Database(DB_PATH, { create: true });

// Optimize SQLite for high concurrency & speed
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA synchronous = NORMAL;");

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    model TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(agent_id, id);

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    task_number INTEGER UNIQUE,
    title TEXT NOT NULL,
    description TEXT,
    assigned_agent TEXT NOT NULL,
    model TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    result TEXT
  );

  CREATE TABLE IF NOT EXISTS provider_endpoints (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key TEXT DEFAULT '',
    is_active INTEGER DEFAULT 0,
    last_status TEXT DEFAULT '',
    last_message TEXT DEFAULT '',
    last_checked_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

// why: pesan bergambar butuh kolom image_url; migrasi aman bila kolom sudah ada.
try {
  db.exec(`ALTER TABLE messages ADD COLUMN image_url TEXT`);
} catch (_) {}
try { db.exec("ALTER TABLE tasks ADD COLUMN task_number INTEGER"); } catch (_) {}
try { db.exec("ALTER TABLE tasks ADD COLUMN started_at TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE tasks ADD COLUMN completed_at TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE tasks ADD COLUMN files_changed TEXT"); } catch (_) {}

export interface DBMessage {
  id?: number;
  agent_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  model?: string;
  image_url?: string | null;
  created_at?: string;
}

export interface DBTask {
  id: string;
  title: string;
  description: string;
  assignedAgent: string;
  model: string;
  status: "todo" | "in-progress" | "review" | "done";
  createdAt: string;
  result?: string;
  taskNumber?: number;
  startedAt?: string;
  completedAt?: string;
  filesChanged?: string[];
}

export const ChatRepo = {
  getMessagesByAgent(agentId: string, limit = 100): DBMessage[] {
    const query = db.query<DBMessage, [string, number]>(`
      SELECT id, agent_id, role, content, model, image_url, created_at 
      FROM (
        SELECT id, agent_id, role, content, model, image_url, created_at 
        FROM messages 
        WHERE agent_id = ? 
        ORDER BY id DESC 
        LIMIT ?
      )
      ORDER BY id ASC
    `);
    const rows = query.all(agentId, limit);
    return rows.map((r: any) => ({
      ...r,
      image_urls: r.image_url ? JSON.parse(r.image_url) : []
    })) as DBMessage[];
  },

  addMessage(agentId: string, role: string, content: string, model?: string, imageUrls?: string | string[]) {
    const urls = typeof imageUrls === 'string' ? [imageUrls] : (imageUrls || []);
    const imageUrlStr = urls.length ? JSON.stringify(urls) : null;
    const insert = db.query(`
      INSERT INTO messages (agent_id, role, content, model, image_url) 
      VALUES (?, ?, ?, ?, ?)
    `);
    return insert.run(agentId, role, content, model || null, imageUrlStr);
  },

  clearMessages(agentId: string) {
    const del = db.query(`DELETE FROM messages WHERE agent_id = ?`);
    return del.run(agentId);
  },
};

function parseFilesChanged(raw: unknown): string[] | undefined {
  if (raw == null || raw === "") return undefined;
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String);
      return [raw];
    } catch {
      return [raw];
    }
  }
  return undefined;
}

function normalizeTask(row: any): DBTask {
  return {
    id: row.id,
    taskNumber: row.taskNumber ?? row.task_number ?? undefined,
    title: row.title,
    description: row.description || "",
    assignedAgent: row.assignedAgent || row.assigned_agent,
    model: row.model || "",
    status: row.status,
    createdAt: row.createdAt || row.created_at,
    result: row.result || undefined,
    startedAt: row.startedAt || row.started_at || undefined,
    completedAt: row.completedAt || row.completed_at || undefined,
    filesChanged: parseFilesChanged(row.filesChanged ?? row.files_changed),
  };
}

function backfillTaskNumbers(): void {
  const rows = db.query<any, []>(`SELECT id FROM tasks WHERE task_number IS NULL ORDER BY created_at ASC`).all();
  if (rows.length === 0) return;
  let next = Number((db.query(`SELECT COALESCE(MAX(task_number), 0) AS m FROM tasks`).get() as any)?.m ?? 0);
  for (const r of rows) {
    next += 1;
    db.query(`UPDATE tasks SET task_number = ? WHERE id = ?`).run(next, r.id);
  }
}

export const TaskRepo = {
  getAllTasks(): DBTask[] {
    backfillTaskNumbers();
    const rows = db.query<any, []>(`
      SELECT id, task_number AS taskNumber, title, description, assigned_agent AS assignedAgent, model, status, created_at AS createdAt, result, started_at AS startedAt, completed_at AS completedAt, files_changed AS filesChanged
      FROM tasks
      ORDER BY COALESCE(task_number, 999999999) ASC, created_at ASC
    `).all();

    if (rows.length === 0) {
      // Seed default initial tasks
      const seedTasks: DBTask[] = [
        {
          id: "task-1",
          title: "Audit DB Schema Qualita Odoo",
          description: "Periksa relasi PostgreSQL 16 dan deteksi apakah ada cascade drop yang berbahaya.",
          assignedAgent: "noa-database",
          model: "cl/deepseek/deepseek-r1-distill-llama-70b",
          status: "done",
          createdAt: new Date(Date.now() - 3600000).toISOString(),
          result: "Audit selesai: Relasi sys_modules dan sys_role_modules terverifikasi aman. Tidak ada cascade yang merusak data."
        },
        {
          id: "task-2",
          title: "Setup 9Router Quota Watcher & Hermes CLI",
          description: "Integrasikan endpoint 127.0.0.1:20128 dengan matrix kepribadian Blue Archive.",
          assignedAgent: "rinna-chan",
          model: "harbor-ai/gemini-3.7-flash",
          status: "in-progress",
          createdAt: new Date().toISOString()
        }
      ];
      for (const t of seedTasks) {
        TaskRepo.upsertTask(t);
      }
      return seedTasks;
    }
    return rows.map(normalizeTask);
  },

  upsertTask(task: DBTask) {
    backfillTaskNumbers();
    const existing = db.query<any, [string]>(`SELECT task_number AS taskNumber FROM tasks WHERE id = ?`).get(task.id) as any;
    let taskNumber: number | undefined = task.taskNumber ?? existing?.taskNumber;
    if (taskNumber == null) {
      const nextRow = db.query<{ next: number }, []>("SELECT COALESCE(MAX(task_number), 0) + 1 AS next FROM tasks").get();
      taskNumber = Number(nextRow?.next ?? 1);
    }
    const stmt = db.query(`
      INSERT INTO tasks (task_number, id, title, description, assigned_agent, model, status, created_at, result, started_at, completed_at, files_changed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        assigned_agent = excluded.assigned_agent,
        model = excluded.model,
        status = excluded.status,
        result = excluded.result, started_at = excluded.started_at, completed_at = excluded.completed_at, files_changed = excluded.files_changed
    `);
    return stmt.run(
      taskNumber, task.id,
      task.title,
      task.description || "",
      task.assignedAgent,
      task.model || "",
      task.status,
      task.createdAt,
      task.result || null, task.startedAt || null, task.completedAt || null, task.filesChanged ? JSON.stringify(task.filesChanged) : null
    );
  },

  updateStatus(id: string, status: string, result?: string) {
    if (result !== undefined) {
      const stmt = db.query(`UPDATE tasks SET status = ?, result = ? WHERE id = ?`);
      return stmt.run(status, result, id);
    }
    const stmt = db.query(`UPDATE tasks SET status = ? WHERE id = ?`);
    return stmt.run(status, id);
  },

  updateTask(id: string, patch: Partial<DBTask>) {
    const fields: string[] = [];
    const values: (string | number | null)[] = [];
    if (patch.title !== undefined) { fields.push("title = ?"); values.push(patch.title); }
    if (patch.description !== undefined) { fields.push("description = ?"); values.push(patch.description); }
    if (patch.assignedAgent !== undefined) { fields.push("assigned_agent = ?"); values.push(patch.assignedAgent); }
    if (patch.model !== undefined) { fields.push("model = ?"); values.push(patch.model); }
    if (patch.status !== undefined) { fields.push("status = ?"); values.push(patch.status); }
    if (patch.result !== undefined) { fields.push("result = ?"); values.push(patch.result); }
    if (fields.length === 0) return null;
    const stmt = db.query(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`);
    return stmt.run(...values, id);
  },

  deleteTask(id: string) {
    return db.query(`DELETE FROM tasks WHERE id = ?`).run(id);
  },

  claimNextTask(): DBTask | null {
    backfillTaskNumbers();
    const row = db.query<any, []>(`SELECT id FROM tasks WHERE status = 'todo' ORDER BY COALESCE(task_number, 999999999) ASC, created_at ASC LIMIT 1`).get();
    if (!row) return null;
    const now = new Date().toISOString();
    const changed = db.query(`UPDATE tasks SET status = 'in-progress', started_at = ? WHERE id = ? AND status = 'todo'`).run(now, row.id);
    if (changed.changes === 0) return null;
    return this.getAllTasks().find((task) => task.id === row.id) || null;
  },

  completeTask(id: string, status: DBTask["status"], result: string, filesChanged: string[] = []) {
    const now = new Date().toISOString();
    return db.query(`UPDATE tasks SET status = ?, result = ?, completed_at = ?, files_changed = ? WHERE id = ?`)
      .run(status, result, now, JSON.stringify(filesChanged), id);
  },
};

export interface DBProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  isActive: number;
  lastStatus: string;
  lastMessage: string;
  lastCheckedAt?: string;
  createdAt: string;
  updatedAt: string;
}

const PROVIDER_SEEDS: Array<{ id: string; name: string; baseUrl: string }> = [
  { id: "9router-local", name: "9Router Local", baseUrl: "http://127.0.0.1:20128/v1" },
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "omniroute", name: "OmniRoute (Contoh)", baseUrl: "https://api.omniroute.ai/v1" },
  { id: "openai", name: "OpenAI Compatible", baseUrl: "https://api.openai.com/v1" },
  { id: "global-custom", name: "Global Custom (Manual)", baseUrl: "" },
];

export const ProviderRepo = {
  ensureSeeds() {
    const now = new Date().toISOString();
    for (let i = 0; i < PROVIDER_SEEDS.length; i++) {
      const s = PROVIDER_SEEDS[i];
      if (!s) continue;
      const existing = db.query(`SELECT id FROM provider_endpoints WHERE id = ?`).get(s.id) as any;
      if (!existing) {
        db.query(`
          INSERT INTO provider_endpoints (id, name, base_url, api_key, is_active, created_at, updated_at)
          VALUES (?, ?, ?, '', ?, ?, ?)
        `).run(s.id, s.name, s.baseUrl, 0, now, now);
      }
    }
    const activeCount = (db.query(`SELECT count(*) as c FROM provider_endpoints WHERE is_active = 1`).get() as any)?.c || 0;
    if (activeCount === 0) {
      db.query(`UPDATE provider_endpoints SET is_active = 1 WHERE id = '9router-local'`).run();
    }
  },

  getAll(): DBProvider[] {
    ProviderRepo.ensureSeeds();
    const rows = db.query<any, []>(`
      SELECT id, name, base_url AS baseUrl, api_key AS apiKey, is_active AS isActive,
             last_status AS lastStatus, last_message AS lastMessage,
             last_checked_at AS lastCheckedAt, created_at AS createdAt, updated_at AS updatedAt
      FROM provider_endpoints ORDER BY created_at ASC
    `).all();
    return rows as DBProvider[];
  },

  getActive(): DBProvider | null {
    ProviderRepo.getAll();
    const row = db.query<any, []>(`
      SELECT id, name, base_url AS baseUrl, api_key AS apiKey, is_active AS isActive,
             last_status AS lastStatus, last_message AS lastMessage,
             last_checked_at AS lastCheckedAt, created_at AS createdAt, updated_at AS updatedAt
      FROM provider_endpoints WHERE is_active = 1 LIMIT 1
    `).get();
    return (row as DBProvider) || null;
  },

  upsert(input: { id?: string; name: string; baseUrl: string; apiKey?: string; isActive?: boolean }): DBProvider {
    const now = new Date().toISOString();
    const id = input.id || ("custom-" + Date.now().toString(36));
    const existing = db.query(`SELECT id FROM provider_endpoints WHERE id = ?`).get(id) as any;
    if (!existing) {
      db.query(`
        INSERT INTO provider_endpoints (id, name, base_url, api_key, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, input.name, input.baseUrl, input.apiKey || "", input.isActive ? 1 : 0, now, now);
    } else {
      db.query(`
        UPDATE provider_endpoints SET name = ?, base_url = ?, api_key = COALESCE(NULLIF(?, ''), api_key),
          updated_at = ? WHERE id = ?
      `).run(input.name, input.baseUrl, input.apiKey || "", now, id);
      if (input.isActive !== undefined) {
        ProviderRepo.setActive(id);
      }
    }
    if (input.isActive) {
      ProviderRepo.setActive(id);
    }
    return ProviderRepo.getById(id)!;
  },

  getById(id: string): DBProvider | null {
    const row = db.query<any, [string]>(`
      SELECT id, name, base_url AS baseUrl, api_key AS apiKey, is_active AS isActive,
             last_status AS lastStatus, last_message AS lastMessage,
             last_checked_at AS lastCheckedAt, created_at AS createdAt, updated_at AS updatedAt
      FROM provider_endpoints WHERE id = ?
    `).get(id);
    return (row as DBProvider) || null;
  },

  setActive(id: string) {
    db.query(`UPDATE provider_endpoints SET is_active = 0`).run();
    db.query(`UPDATE provider_endpoints SET is_active = 1, updated_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
  },

  saveTestResult(id: string, status: string, message: string) {
    db.query(`
      UPDATE provider_endpoints SET last_status = ?, last_message = ?, last_checked_at = ?, updated_at = ?
      WHERE id = ?
    `).run(status, message, new Date().toISOString(), new Date().toISOString(), id);
  },

  maskKey(key: string): string {
    if (!key) return "";
    if (key.length <= 8) return "****";
    return key.slice(0, 4) + "****" + key.slice(-4);
  }
};
