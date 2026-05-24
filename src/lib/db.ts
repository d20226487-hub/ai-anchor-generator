import { createClient, type Client } from "@libsql/client";
import path from "node:path";

let _client: Client | null = null;
let _initPromise: Promise<void> | null = null;

function getClient(): Client {
  if (_client) return _client;
  const url = process.env.DATABASE_URL ?? `file:${path.join(process.cwd(), "data.db")}`;
  const authToken = process.env.DATABASE_AUTH_TOKEN;
  _client = createClient({ url, authToken });
  return _client;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  blob TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mode TEXT NOT NULL,
  criteria TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  last_error TEXT,
  batch_size INTEGER NOT NULL DEFAULT 10,
  batches_done INTEGER NOT NULL DEFAULT 0,
  batches_total INTEGER NOT NULL DEFAULT 0,
  run_started_at INTEGER,
  runner_id TEXT,
  runner_heartbeat_at INTEGER,
  folder_id TEXT,
  created_by TEXT,
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1
);

-- Folders: self-referential tree. parent_id NULL = top-level. deleted_at NOT NULL = soft-deleted (in trash).
-- Folder names are NOT globally unique; uniqueness is per (parent_id, name) at the app layer, not enforced
-- by SQL because SQLite doesn't index NULLs in a way that gives "one root with name X" cleanly.
-- No creator stamp on folders by design (only jobs are attributed). Legacy DBs may still
-- have a created_by column from an earlier iteration — it's ignored.
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS job_inputs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  target_url TEXT NOT NULL,
  title TEXT,
  keywords TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  -- V2-only JSON payload: {linkType, numberOfLinks, dist: {url, brand, generic, keyword}, geo, lang}
  -- V1 rows leave this NULL. Stored as JSON so we don't have to migrate 8+ columns nobody queries.
  payload TEXT
);

CREATE INDEX IF NOT EXISTS idx_job_inputs_job ON job_inputs(job_id);

CREATE TABLE IF NOT EXISTS job_anchors (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  input_id TEXT REFERENCES job_inputs(id) ON DELETE SET NULL,
  target_url TEXT NOT NULL,
  brand_id TEXT,
  follow_status TEXT,
  anchor_text TEXT NOT NULL,
  category TEXT NOT NULL,
  manually_edited INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  -- V2-only JSON payload: {linkType, geo, lang}. V1 rows leave this NULL.
  payload TEXT
);

CREATE INDEX IF NOT EXISTS idx_job_anchors_job ON job_anchors(job_id);

-- Per (provider, model) AI pricing. Rates in USD per 1 MILLION tokens (matches every
-- public provider's pricing page — gpt-4o-mini's $0.15/$0.60 etc.). Cost is computed
-- at write time using the row that exists at that moment; editing this table later
-- does NOT retroactively recompute old jobs' costs.
CREATE TABLE IF NOT EXISTS model_pricing (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_per_million REAL NOT NULL,
  output_per_million REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, model)
);
`;

// Idempotent migrations for users who created the DB before the run-tracking columns existed.
const ADD_COLUMNS = [
  "ALTER TABLE jobs ADD COLUMN status TEXT NOT NULL DEFAULT 'idle'",
  "ALTER TABLE jobs ADD COLUMN last_error TEXT",
  "ALTER TABLE jobs ADD COLUMN batch_size INTEGER NOT NULL DEFAULT 10",
  "ALTER TABLE jobs ADD COLUMN batches_done INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE jobs ADD COLUMN batches_total INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE jobs ADD COLUMN run_started_at INTEGER",
  // Runner lease — ensures only one orchestrator (across ALL browsers/laptops)
  // is generating batches for a given job at a time. See claimOrRefreshRunnerLease in jobs.ts.
  "ALTER TABLE jobs ADD COLUMN runner_id TEXT",
  "ALTER TABLE jobs ADD COLUMN runner_heartbeat_at INTEGER",
  // Organization + attribution + soft-delete (2026-05-24). folder_id NULL = job lives at root.
  // created_by NULL = "Unknown" (pre-attribution jobs). deleted_at NOT NULL = in trash.
  "ALTER TABLE jobs ADD COLUMN folder_id TEXT",
  "ALTER TABLE jobs ADD COLUMN created_by TEXT",
  "ALTER TABLE jobs ADD COLUMN deleted_at INTEGER",
  // V2 job mode (2026-05-24). 1 = legacy form-based flow with dofollow + distribution sliders.
  // 2 = per-row CSV-driven: dofollow gone, distribution + lang + linkType + count all per row.
  "ALTER TABLE jobs ADD COLUMN version INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE job_inputs ADD COLUMN payload TEXT",
  "ALTER TABLE job_anchors ADD COLUMN payload TEXT",
  // Per-job AI cost tracking (2026-05-24, "Drop Sherlock-style"). Tokens accumulate
  // across successful batches; cost_usd is locked in at write time. Resets on rerun
  // (when anchors are cleared). NULL on legacy jobs that ran before this column existed.
  "ALTER TABLE jobs ADD COLUMN ai_input_tokens INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE jobs ADD COLUMN ai_output_tokens INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE jobs ADD COLUMN ai_cached_input_tokens INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE jobs ADD COLUMN ai_cost_usd REAL NOT NULL DEFAULT 0",
];

// Indexes on columns introduced by ADD_COLUMNS must run AFTER those ALTERs — otherwise on
// an existing DB that predates the column, CREATE INDEX fails with "no such column" and,
// if it lives inside executeMultiple(SCHEMA_SQL), aborts the whole batch before the
// ALTERs ever execute. Each statement here runs individually with its own try/catch so
// one failure doesn't block the rest.
const POST_MIGRATION_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_jobs_folder ON jobs(folder_id)",
  "CREATE INDEX IF NOT EXISTS idx_jobs_deleted ON jobs(deleted_at)",
  "CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id)",
  "CREATE INDEX IF NOT EXISTS idx_folders_deleted ON folders(deleted_at)",
];

// Seed default pricing rows when `model_pricing` is empty. One-shot — once seeded, the
// user can edit in Settings and we won't overwrite. Values are approximate list prices
// from each provider's docs (Q2-2026); verify before relying on absolute accuracy. The
// user can override via Settings → Pricing.
const DEFAULT_PRICING: Array<{ provider: string; model: string; input: number; output: number }> = [
  // OpenRouter — list prices (markup is ~5.5% on top, accept it as noise)
  { provider: "openrouter", model: "openai/gpt-4o-mini",                  input: 0.15,  output: 0.60 },
  { provider: "openrouter", model: "openai/gpt-4o",                       input: 2.50,  output: 10.00 },
  { provider: "openrouter", model: "anthropic/claude-3.5-sonnet",         input: 3.00,  output: 15.00 },
  { provider: "openrouter", model: "anthropic/claude-3.5-haiku",          input: 0.80,  output: 4.00 },
  { provider: "openrouter", model: "google/gemini-2.0-flash-001",         input: 0.10,  output: 0.40 },
  { provider: "openrouter", model: "meta-llama/llama-3.3-70b-instruct",   input: 0.13,  output: 0.40 },
  { provider: "openrouter", model: "deepseek/deepseek-chat",              input: 0.27,  output: 1.10 },
  // GitHub Models — free tier with rate limits; 0/0 reflects "no charge" for most users.
  // Override in Settings if you're on a paid tier.
  { provider: "github",     model: "openai/gpt-4o-mini",                  input: 0,     output: 0 },
  { provider: "github",     model: "openai/gpt-4o",                       input: 0,     output: 0 },
  { provider: "github",     model: "meta/Llama-3.3-70B-Instruct",         input: 0,     output: 0 },
  { provider: "github",     model: "mistral-ai/Mistral-large",            input: 0,     output: 0 },
  { provider: "github",     model: "xai/grok-3-mini",                     input: 0,     output: 0 },
  // Google Gemini (public AI Studio API)
  { provider: "gemini",     model: "gemini-2.0-flash",                    input: 0.075, output: 0.30 },
  { provider: "gemini",     model: "gemini-2.0-flash-lite",               input: 0.075, output: 0.30 },
  { provider: "gemini",     model: "gemini-1.5-flash",                    input: 0.075, output: 0.30 },
  { provider: "gemini",     model: "gemini-1.5-pro",                      input: 1.25,  output: 5.00 },
  // Google Vertex AI (enterprise — different rates from public Gemini API)
  { provider: "vertex",     model: "gemini-2.5-pro",                      input: 1.25,  output: 10.00 },
  { provider: "vertex",     model: "gemini-2.5-flash",                    input: 0.30,  output: 2.50 },
  { provider: "vertex",     model: "gemini-2.0-flash-001",                input: 0.10,  output: 0.40 },
  { provider: "vertex",     model: "gemini-2.0-flash-lite-001",           input: 0.075, output: 0.30 },
  { provider: "vertex",     model: "claude-3-5-sonnet-v2@20241022",       input: 3.00,  output: 15.00 },
  { provider: "vertex",     model: "claude-3-5-haiku@20241022",           input: 0.80,  output: 4.00 },
];

async function init(): Promise<void> {
  const c = getClient();
  // WAL gives concurrent reads while a writer is active and survives crashes better
  // than the default rollback journal. No-op for remote libsql URLs.
  try { await c.execute("PRAGMA journal_mode=WAL"); } catch { /* not supported on remote */ }
  await c.executeMultiple(SCHEMA_SQL);
  for (const stmt of ADD_COLUMNS) {
    try {
      await c.execute(stmt);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/duplicate column name/i.test(msg)) throw e;
    }
  }
  for (const stmt of POST_MIGRATION_INDEXES) {
    try { await c.execute(stmt); } catch { /* skip — index referencing a column that's still missing */ }
  }
  // Seed default pricing rows ONLY if the table is empty (first boot of a fresh DB,
  // or a user who's never touched pricing yet). Never overwrites existing user edits.
  try {
    const r = await c.execute("SELECT COUNT(*) AS n FROM model_pricing");
    const n = Number((r.rows[0] as unknown as Record<string, unknown>).n ?? 0);
    if (n === 0) {
      const now = Date.now();
      for (const p of DEFAULT_PRICING) {
        await c.execute({
          sql: "INSERT OR IGNORE INTO model_pricing (provider, model, input_per_million, output_per_million, updated_at) VALUES (?, ?, ?, ?, ?)",
          args: [p.provider, p.model, p.input, p.output, now],
        });
      }
    }
  } catch { /* table not yet present on a very old DB — already handled by SCHEMA_SQL above */ }
}

export async function db(): Promise<Client> {
  if (!_initPromise) _initPromise = init();
  await _initPromise;
  return getClient();
}
