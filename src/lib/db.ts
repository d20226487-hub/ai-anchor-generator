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
  runner_heartbeat_at INTEGER
);

CREATE TABLE IF NOT EXISTS job_inputs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  target_url TEXT NOT NULL,
  title TEXT,
  keywords TEXT,
  position INTEGER NOT NULL DEFAULT 0
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
  position INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_job_anchors_job ON job_anchors(job_id);
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
}

export async function db(): Promise<Client> {
  if (!_initPromise) _initPromise = init();
  await _initPromise;
  return getClient();
}
