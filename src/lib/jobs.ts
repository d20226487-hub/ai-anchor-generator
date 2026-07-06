import { db } from "./db";
import { normalizeDistribution } from "./types";
import type {
  Folder, FolderRow, Job, JobAnchor, JobAnchorPayloadV2, JobCriteria, JobInput,
  JobInputPayloadV2, JobMode, JobStatus, JobVersion, ModelPricing, ProviderId,
} from "./types";
import { uid } from "./utils";

function rowToJob(r: Record<string, unknown>): Job {
  const criteria = JSON.parse(String(r.criteria)) as JobCriteria;
  // Backward-compat: older jobs may not have url% in their distribution.
  criteria.distribution = normalizeDistribution(criteria.distribution);
  // Backward-compat: older jobs predate per-job and per-brand language → default null.
  // Compose silently falls back to "en" so existing jobs still produce a valid prompt.
  if (!("language" in criteria) || criteria.language === undefined) criteria.language = null;
  for (const b of criteria.brands ?? []) {
    if (!("language" in b) || b.language === undefined) b.language = null;
  }
  // Version: SQLite returns the new column as 1 (default) for legacy rows.
  const version = (r.version == null ? 1 : Number(r.version)) as JobVersion;
  return {
    id: String(r.id),
    name: String(r.name),
    version,
    mode: String(r.mode) as JobMode,
    criteria,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    status: (r.status ? String(r.status) : "idle") as JobStatus,
    lastError: r.last_error == null ? null : String(r.last_error),
    batchSize: r.batch_size == null ? 10 : Number(r.batch_size),
    batchesDone: r.batches_done == null ? 0 : Number(r.batches_done),
    batchesTotal: r.batches_total == null ? 0 : Number(r.batches_total),
    runStartedAt: r.run_started_at == null ? null : Number(r.run_started_at),
    runnerId: r.runner_id == null ? null : String(r.runner_id),
    runnerHeartbeatAt: r.runner_heartbeat_at == null ? null : Number(r.runner_heartbeat_at),
    folderId: r.folder_id == null ? null : String(r.folder_id),
    createdBy: r.created_by == null ? null : String(r.created_by),
    deletedAt: r.deleted_at == null ? null : Number(r.deleted_at),
    aiInputTokens: r.ai_input_tokens == null ? 0 : Number(r.ai_input_tokens),
    aiOutputTokens: r.ai_output_tokens == null ? 0 : Number(r.ai_output_tokens),
    aiCachedInputTokens: r.ai_cached_input_tokens == null ? 0 : Number(r.ai_cached_input_tokens),
    aiCostUsd: r.ai_cost_usd == null ? 0 : Number(r.ai_cost_usd),
  };
}

function rowToFolder(r: Record<string, unknown>): Folder {
  return {
    id: String(r.id),
    parentId: r.parent_id == null ? null : String(r.parent_id),
    name: String(r.name),
    createdAt: Number(r.created_at),
    // Folders intentionally have no creator attribution — only jobs are stamped.
    // The created_by column may still exist on legacy DBs; it's ignored.
    deletedAt: r.deleted_at == null ? null : Number(r.deleted_at),
  };
}
function parseJsonPayload<T>(raw: unknown): T | null {
  if (raw == null) return null;
  try { return JSON.parse(String(raw)) as T; } catch { return null; }
}
function rowToInput(r: Record<string, unknown>): JobInput {
  return {
    id: String(r.id),
    jobId: String(r.job_id),
    targetUrl: String(r.target_url),
    title: r.title == null ? null : String(r.title),
    keywords: r.keywords == null ? null : String(r.keywords),
    payloadV2: parseJsonPayload<JobInputPayloadV2>(r.payload),
  };
}
function rowToAnchor(r: Record<string, unknown>): JobAnchor {
  return {
    id: String(r.id),
    jobId: String(r.job_id),
    inputId: r.input_id == null ? null : String(r.input_id),
    targetUrl: String(r.target_url),
    brandId: r.brand_id == null ? null : String(r.brand_id),
    followStatus: r.follow_status == null ? null : (String(r.follow_status) as JobAnchor["followStatus"]),
    anchorText: String(r.anchor_text),
    category: String(r.category) as JobAnchor["category"],
    manuallyEdited: (Number(r.manually_edited) ? 1 : 0) as 0 | 1,
    payloadV2: parseJsonPayload<JobAnchorPayloadV2>(r.payload),
  };
}

/** Stuck-job grace period: longer than RUNNER_LEASE_TTL_MS (2 min) so transient hiccups
 *  don't get flagged. After 5 min of zero heartbeat updates while status='running',
 *  we conclude the runner died (server restart, killed process, network partition). */
const STUCK_RUNNING_GRACE_MS = 5 * 60_000;

/**
 * Reclassify jobs whose status='running' but whose runner has clearly died.
 * - Has anchors in DB → 'partial' (some progress was made before the crash)
 * - Zero anchors      → 'failed'  (nothing produced)
 *
 * Idempotent and cheap: a single targeted UPDATE per branch. Called on every listJobs()
 * so the user never sees ghost-running jobs after a server restart.
 */
async function reconcileStuckRunningJobs(): Promise<void> {
  const c = await db();
  const cutoff = Date.now() - STUCK_RUNNING_GRACE_MS;
  // Stuck + has anchors → partial. Skip soft-deleted rows (they're in the trash and
  // don't need to be reclassified; their `runner_*` are already cleared at delete time).
  await c.execute({
    sql: `UPDATE jobs
            SET status = 'partial',
                last_error = COALESCE(last_error, 'Server interrupted generation'),
                runner_id = NULL,
                runner_heartbeat_at = NULL,
                updated_at = ?
          WHERE status = 'running'
            AND deleted_at IS NULL
            AND (runner_heartbeat_at IS NULL OR runner_heartbeat_at < ?)
            AND updated_at < ?
            AND id IN (SELECT job_id FROM job_anchors GROUP BY job_id)`,
    args: [Date.now(), cutoff, cutoff],
  });
  // Stuck + no anchors → failed
  await c.execute({
    sql: `UPDATE jobs
            SET status = 'failed',
                last_error = COALESCE(last_error, 'Server interrupted before any anchors were produced'),
                runner_id = NULL,
                runner_heartbeat_at = NULL,
                updated_at = ?
          WHERE status = 'running'
            AND deleted_at IS NULL
            AND (runner_heartbeat_at IS NULL OR runner_heartbeat_at < ?)
            AND updated_at < ?
            AND id NOT IN (SELECT job_id FROM job_anchors GROUP BY job_id)`,
    args: [Date.now(), cutoff, cutoff],
  });
}

/**
 * List jobs in a folder (direct children only — never recursive). Matches the way
 * real file managers work: each folder shows its direct contents, subfolders are
 * shown as separate rows and you click in to see what's inside.
 *
 *   - Pass `folderId: null` (the default) to list jobs at root (folder_id IS NULL).
 *   - Pass `folderId: <id>` to list jobs directly inside that folder.
 *   - Pass `includeDeleted: true` ONLY for the Trash view.
 */
export async function listJobs(opts: {
  folderId?: string | null;
  includeDeleted?: boolean;
} = {}): Promise<Job[]> {
  const c = await db();
  await reconcileStuckRunningJobs();

  const where: string[] = [];
  const args: (string | number | null)[] = [];

  if (!opts.includeDeleted) where.push("deleted_at IS NULL");

  const folderId = opts.folderId ?? null;
  if (folderId === null) where.push("folder_id IS NULL");
  else { where.push("folder_id = ?"); args.push(folderId); }

  const sql = `SELECT * FROM jobs WHERE ${where.join(" AND ")} ORDER BY updated_at DESC`;
  const r = await c.execute({ sql, args });
  return r.rows.map((row) => rowToJob(row as unknown as Record<string, unknown>));
}

/** Load a single job. Pass `includeDeleted: true` for the Trash view. */
export async function getJob(id: string, opts: { includeDeleted?: boolean } = {}): Promise<Job | null> {
  const c = await db();
  const sql = opts.includeDeleted
    ? "SELECT * FROM jobs WHERE id = ?"
    : "SELECT * FROM jobs WHERE id = ? AND deleted_at IS NULL";
  const r = await c.execute({ sql, args: [id] });
  if (r.rows.length === 0) return null;
  const job = rowToJob(r.rows[0] as unknown as Record<string, unknown>);
  const inputs = await c.execute({ sql: "SELECT * FROM job_inputs WHERE job_id = ? ORDER BY position", args: [id] });
  const anchors = await c.execute({ sql: "SELECT * FROM job_anchors WHERE job_id = ? ORDER BY position", args: [id] });
  job.inputs = inputs.rows.map((row) => rowToInput(row as unknown as Record<string, unknown>));
  job.anchors = anchors.rows.map((row) => rowToAnchor(row as unknown as Record<string, unknown>));
  return job;
}

export async function createJob(args: {
  name: string;
  mode: JobMode;
  criteria: JobCriteria;
  inputs: Array<{ targetUrl: string; title: string | null; keywords: string | null; payloadV2?: JobInputPayloadV2 | null }>;
  folderId?: string | null;
  createdBy?: string | null;
  /** 1 = legacy form-driven. 2 = CSV-driven per-row config. Defaults to 1 for back-compat. */
  version?: JobVersion;
}): Promise<string> {
  const c = await db();
  const id = uid("job");
  const now = Date.now();
  const version: JobVersion = args.version ?? 1;
  await c.execute({
    sql: "INSERT INTO jobs (id, name, mode, criteria, created_at, updated_at, folder_id, created_by, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    args: [id, args.name, args.mode, JSON.stringify(args.criteria), now, now, args.folderId ?? null, args.createdBy ?? null, version],
  });
  for (let i = 0; i < args.inputs.length; i++) {
    const inp = args.inputs[i];
    await c.execute({
      sql: "INSERT INTO job_inputs (id, job_id, target_url, title, keywords, position, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
      args: [uid("inp"), id, inp.targetUrl, inp.title, inp.keywords, i, inp.payloadV2 ? JSON.stringify(inp.payloadV2) : null],
    });
  }
  return id;
}

export async function renameJob(id: string, name: string): Promise<void> {
  const c = await db();
  await c.execute({ sql: "UPDATE jobs SET name = ?, updated_at = ? WHERE id = ?", args: [name, Date.now(), id] });
}

export async function updateJob(args: {
  id: string;
  name: string;
  mode: JobMode;
  criteria: JobCriteria;
  inputs: Array<{ targetUrl: string; title: string | null; keywords: string | null; payloadV2?: JobInputPayloadV2 | null }>;
}): Promise<void> {
  const c = await db();
  const now = Date.now();
  await c.execute({
    sql: "UPDATE jobs SET name = ?, mode = ?, criteria = ?, updated_at = ? WHERE id = ?",
    args: [args.name, args.mode, JSON.stringify(args.criteria), now, args.id],
  });
  // Replace inputs (preserves anchors but they may now reference removed inputs — that's OK,
  // input_id is nullable and anchors will get new input_ids on next generate).
  await c.execute({ sql: "DELETE FROM job_inputs WHERE job_id = ?", args: [args.id] });
  for (let i = 0; i < args.inputs.length; i++) {
    const inp = args.inputs[i];
    await c.execute({
      sql: "INSERT INTO job_inputs (id, job_id, target_url, title, keywords, position, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
      args: [uid("inp"), args.id, inp.targetUrl, inp.title, inp.keywords, i, inp.payloadV2 ? JSON.stringify(inp.payloadV2) : null],
    });
  }
}

/**
 * Soft-delete: mark the job's deleted_at and clear any runner lease + flip a 'running'
 * status to 'cancelled' so the Trash view doesn't show ghost-running jobs.
 * Use `purgeJob` for permanent removal from the Trash view.
 */
export async function deleteJob(id: string): Promise<void> {
  const c = await db();
  const now = Date.now();
  await c.execute({
    sql: `UPDATE jobs
            SET deleted_at = ?,
                runner_id = NULL,
                runner_heartbeat_at = NULL,
                status = CASE WHEN status = 'running' THEN 'cancelled' ELSE status END,
                updated_at = ?
          WHERE id = ? AND deleted_at IS NULL`,
    args: [now, now, id],
  });
}

/** Bulk soft-delete. Returns count of rows newly tombstoned. */
export async function deleteJobs(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const c = await db();
  const now = Date.now();
  const placeholders = ids.map(() => "?").join(",");
  const r = await c.execute({
    sql: `UPDATE jobs
            SET deleted_at = ?,
                runner_id = NULL,
                runner_heartbeat_at = NULL,
                status = CASE WHEN status = 'running' THEN 'cancelled' ELSE status END,
                updated_at = ?
          WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
    args: [now, now, ...ids],
  });
  return Number(r.rowsAffected ?? 0);
}

/** Restore a soft-deleted job. No-op if it isn't in trash. */
export async function restoreJob(id: string): Promise<void> {
  const c = await db();
  await c.execute({
    sql: "UPDATE jobs SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL",
    args: [Date.now(), id],
  });
}

/** Permanent removal — cascade-removes inputs and anchors via FK ON DELETE CASCADE. */
export async function purgeJob(id: string): Promise<void> {
  const c = await db();
  await c.execute({ sql: "DELETE FROM jobs WHERE id = ?", args: [id] });
}

/** Move jobs into a folder (or root with folderId=null). Returns count actually moved. */
export async function moveJobsToFolder(ids: string[], folderId: string | null): Promise<number> {
  if (ids.length === 0) return 0;
  const c = await db();
  const placeholders = ids.map(() => "?").join(",");
  const r = await c.execute({
    sql: `UPDATE jobs SET folder_id = ?, updated_at = ? WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
    args: [folderId, Date.now(), ...ids],
  });
  return Number(r.rowsAffected ?? 0);
}

export async function replaceJobAnchors(jobId: string, anchors: Array<Omit<JobAnchor, "id" | "jobId" | "manuallyEdited"> & { id?: string }>): Promise<void> {
  const c = await db();
  await c.execute({ sql: "DELETE FROM job_anchors WHERE job_id = ?", args: [jobId] });
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    await c.execute({
      sql: "INSERT INTO job_anchors (id, job_id, input_id, target_url, brand_id, follow_status, anchor_text, category, manually_edited, position, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
      args: [a.id ?? uid("anc"), jobId, a.inputId, a.targetUrl, a.brandId, a.followStatus, a.anchorText, a.category, i, a.payloadV2 ? JSON.stringify(a.payloadV2) : null],
    });
  }
  await c.execute({ sql: "UPDATE jobs SET updated_at = ? WHERE id = ?", args: [Date.now(), jobId] });
}

export async function updateAnchorText(jobId: string, anchorId: string, text: string): Promise<void> {
  const c = await db();
  await c.execute({
    sql: "UPDATE job_anchors SET anchor_text = ?, manually_edited = 1 WHERE id = ? AND job_id = ?",
    args: [text, anchorId, jobId],
  });
}

export async function updateAnchorFollow(jobId: string, anchorId: string, follow: "dofollow" | "nofollow"): Promise<void> {
  const c = await db();
  await c.execute({
    sql: "UPDATE job_anchors SET follow_status = ?, manually_edited = 1 WHERE id = ? AND job_id = ?",
    args: [follow, anchorId, jobId],
  });
}

export async function updateAnchorsByMap(jobId: string, updates: Array<{ id: string; anchorText?: string; followStatus?: "dofollow" | "nofollow" }>): Promise<void> {
  if (updates.length === 0) return;
  const c = await db();
  for (const u of updates) {
    if (u.anchorText !== undefined) {
      await c.execute({ sql: "UPDATE job_anchors SET anchor_text = ?, manually_edited = 1 WHERE id = ? AND job_id = ?", args: [u.anchorText, u.id, jobId] });
    }
    if (u.followStatus !== undefined) {
      await c.execute({ sql: "UPDATE job_anchors SET follow_status = ?, manually_edited = 1 WHERE id = ? AND job_id = ?", args: [u.followStatus, u.id, jobId] });
    }
  }
}

export async function setJobStatus(
  id: string,
  status: JobStatus,
  opts: { lastError?: string | null; batchSize?: number; batchesTotal?: number; runStartedAt?: number | null; resetBatchesDone?: boolean } = {}
): Promise<void> {
  const c = await db();
  const fields: string[] = ["status = ?", "updated_at = ?"];
  const args: (string | number | null)[] = [status, Date.now()];
  if (opts.lastError !== undefined) {
    fields.push("last_error = ?");
    args.push(opts.lastError);
  }
  if (opts.batchSize !== undefined) {
    fields.push("batch_size = ?");
    args.push(opts.batchSize);
  }
  if (opts.batchesTotal !== undefined) {
    fields.push("batches_total = ?");
    args.push(opts.batchesTotal);
  }
  if (opts.runStartedAt !== undefined) {
    fields.push("run_started_at = ?");
    args.push(opts.runStartedAt);
  }
  if (opts.resetBatchesDone) {
    fields.push("batches_done = 0");
  }
  args.push(id);
  await c.execute({ sql: `UPDATE jobs SET ${fields.join(", ")} WHERE id = ?`, args });
}

export async function incrementBatchesDone(id: string): Promise<void> {
  const c = await db();
  await c.execute({ sql: "UPDATE jobs SET batches_done = batches_done + 1, updated_at = ? WHERE id = ?", args: [Date.now(), id] });
}

export async function appendJobAnchors(
  jobId: string,
  anchors: Array<Omit<JobAnchor, "id" | "jobId" | "manuallyEdited">>
): Promise<void> {
  if (anchors.length === 0) return;
  const c = await db();
  // Find current max position so new anchors append after existing ones.
  const r = await c.execute({ sql: "SELECT COALESCE(MAX(position), -1) AS maxp FROM job_anchors WHERE job_id = ?", args: [jobId] });
  const startPos = (r.rows[0]?.maxp == null ? -1 : Number(r.rows[0].maxp)) + 1;
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    await c.execute({
      sql: "INSERT INTO job_anchors (id, job_id, input_id, target_url, brand_id, follow_status, anchor_text, category, manually_edited, position, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
      args: [uid("anc"), jobId, a.inputId, a.targetUrl, a.brandId, a.followStatus, a.anchorText, a.category, startPos + i, a.payloadV2 ? JSON.stringify(a.payloadV2) : null],
    });
  }
  await c.execute({ sql: "UPDATE jobs SET updated_at = ? WHERE id = ?", args: [Date.now(), jobId] });
}

export async function clearJobAnchors(jobId: string): Promise<void> {
  const c = await db();
  await c.execute({ sql: "DELETE FROM job_anchors WHERE job_id = ?", args: [jobId] });
}

/**
 * Overwrite the full V2/Пироги `payload` (JSON) of specific anchors. Used by the Пироги
 * quantity reconcile to write adjusted `quantity` values. Does NOT set manually_edited
 * (this is a bulk quantity normalisation, not a hand edit of anchor text).
 */
export async function setAnchorPayloads(jobId: string, updates: Array<{ id: string; payloadV2: JobAnchorPayloadV2 }>): Promise<void> {
  if (updates.length === 0) return;
  const c = await db();
  for (const u of updates) {
    await c.execute({
      sql: "UPDATE job_anchors SET payload = ? WHERE id = ? AND job_id = ?",
      args: [JSON.stringify(u.payloadV2), u.id, jobId],
    });
  }
  await c.execute({ sql: "UPDATE jobs SET updated_at = ? WHERE id = ?", args: [Date.now(), jobId] });
}

export async function getAnchorsByIds(ids: string[]): Promise<JobAnchor[]> {
  if (ids.length === 0) return [];
  const c = await db();
  const placeholders = ids.map(() => "?").join(",");
  const r = await c.execute({ sql: `SELECT * FROM job_anchors WHERE id IN (${placeholders})`, args: ids });
  return r.rows.map((row) => rowToAnchor(row as unknown as Record<string, unknown>));
}

// ----- Runner lease -----
//
// Ensures only one client orchestrator is generating batches for a given job at a time
// across ALL browsers and laptops (audit High #7). The localStorage tab guard catches the
// same-browser case cheaply; this lease is the authoritative cross-host gate.
//
// Lease lifecycle:
//   - First batch call: claimOrRefreshRunnerLease(jobId, runnerId, ttlMs) atomically claims.
//   - Subsequent batch calls: same call refreshes the heartbeat (UPDATE succeeds because
//     runner_id matches).
//   - On pause / cancel / fresh-start: clearRunnerLease(jobId).
//   - If the holder dies (tab closed, laptop sleep), the lease becomes stale after ttlMs
//     and another orchestrator can claim it.
//   - If a user explicitly wants to wrest control: forceClaimRunnerLease(jobId, runnerId).

export const RUNNER_LEASE_TTL_MS = 120_000; // 2 minutes — covers slow models + rate-limit backoff

export interface RunnerLeaseResult {
  ok: boolean;
  /** The runner_id currently holding the lease (us if ok=true, otherwise the holder). */
  currentRunnerId: string | null;
  /** ms since the current holder's last heartbeat. null if no holder. */
  heartbeatAgeMs: number | null;
}

/**
 * Atomically claim or refresh the runner lease for a job.
 * Returns ok=true if we now hold the lease (either freshly claimed or refreshed).
 * Returns ok=false with currentRunnerId set to whoever else holds it.
 */
export async function claimOrRefreshRunnerLease(
  jobId: string,
  runnerId: string,
  ttlMs: number = RUNNER_LEASE_TTL_MS,
): Promise<RunnerLeaseResult> {
  const c = await db();
  const now = Date.now();
  const staleBefore = now - ttlMs;
  // Atomic: succeeds iff no holder, OR we already hold it, OR holder is stale.
  const r = await c.execute({
    sql: `UPDATE jobs
            SET runner_id = ?, runner_heartbeat_at = ?
          WHERE id = ?
            AND (runner_id IS NULL
                 OR runner_id = ?
                 OR runner_heartbeat_at IS NULL
                 OR runner_heartbeat_at < ?)`,
    args: [runnerId, now, jobId, runnerId, staleBefore],
  });
  if (r.rowsAffected === 1) {
    return { ok: true, currentRunnerId: runnerId, heartbeatAgeMs: 0 };
  }
  // Lost — read whoever holds it.
  const cur = await c.execute({ sql: "SELECT runner_id, runner_heartbeat_at FROM jobs WHERE id = ?", args: [jobId] });
  const row = cur.rows[0] as Record<string, unknown> | undefined;
  return {
    ok: false,
    currentRunnerId: row?.runner_id == null ? null : String(row.runner_id),
    heartbeatAgeMs: row?.runner_heartbeat_at == null ? null : (now - Number(row.runner_heartbeat_at)),
  };
}

/** Best-effort release. Only clears if we own it (so we don't stomp another holder). */
export async function releaseRunnerLease(jobId: string, runnerId: string): Promise<void> {
  const c = await db();
  await c.execute({
    sql: "UPDATE jobs SET runner_id = NULL, runner_heartbeat_at = NULL WHERE id = ? AND runner_id = ?",
    args: [jobId, runnerId],
  });
}

/** Unconditionally clear the lease. Used on pause/cancel/fresh-start. */
export async function clearRunnerLease(jobId: string): Promise<void> {
  const c = await db();
  await c.execute({
    sql: "UPDATE jobs SET runner_id = NULL, runner_heartbeat_at = NULL WHERE id = ?",
    args: [jobId],
  });
}

/** Forcibly take over a held lease. The previous holder will see lease_lost on next batch. */
export async function forceClaimRunnerLease(jobId: string, runnerId: string): Promise<void> {
  const c = await db();
  await c.execute({
    sql: "UPDATE jobs SET runner_id = ?, runner_heartbeat_at = ? WHERE id = ?",
    args: [runnerId, Date.now(), jobId],
  });
}

/** Read the current lease holder + age (no mutation). For UI display. */
export async function getRunnerLease(jobId: string): Promise<{ runnerId: string | null; heartbeatAgeMs: number | null }> {
  const c = await db();
  const r = await c.execute({ sql: "SELECT runner_id, runner_heartbeat_at FROM jobs WHERE id = ?", args: [jobId] });
  const row = r.rows[0] as Record<string, unknown> | undefined;
  if (!row) return { runnerId: null, heartbeatAgeMs: null };
  return {
    runnerId: row.runner_id == null ? null : String(row.runner_id),
    heartbeatAgeMs: row.runner_heartbeat_at == null ? null : (Date.now() - Number(row.runner_heartbeat_at)),
  };
}

// ============================================================================
// Folders — organizational tree for the jobs list (2026-05-24)
// ============================================================================
// Model: jobs.folder_id (nullable) points at folders.id; NULL = root. Folders
// are a self-referential tree via folders.parent_id (NULL = top-level).
// Soft-delete: folders.deleted_at + jobs.deleted_at. Deleting a folder cascades
// the tombstone to every descendant folder + every job in the subtree, so the
// whole branch disappears from the browser at once. Restoring a folder by id
// only restores that folder + its descendants — jobs that were already in the
// trash before the cascade stay in the trash.

/** Get a single folder by id. Pass `includeDeleted: true` for the Trash view. */
export async function getFolder(id: string, opts: { includeDeleted?: boolean } = {}): Promise<Folder | null> {
  const c = await db();
  const sql = opts.includeDeleted
    ? "SELECT * FROM folders WHERE id = ?"
    : "SELECT * FROM folders WHERE id = ? AND deleted_at IS NULL";
  const r = await c.execute({ sql, args: [id] });
  if (r.rows.length === 0) return null;
  return rowToFolder(r.rows[0] as unknown as Record<string, unknown>);
}

/** List direct children of a parent folder. `parentId === null` = top-level folders. */
export async function listChildFolders(parentId: string | null, opts: { includeDeleted?: boolean } = {}): Promise<Folder[]> {
  const c = await db();
  const deletedClause = opts.includeDeleted ? "" : " AND deleted_at IS NULL";
  const sql = parentId === null
    ? `SELECT * FROM folders WHERE parent_id IS NULL${deletedClause} ORDER BY LOWER(name) ASC`
    : `SELECT * FROM folders WHERE parent_id = ?${deletedClause} ORDER BY LOWER(name) ASC`;
  const r = await c.execute(parentId === null ? sql : { sql, args: [parentId] });
  return r.rows.map((row) => rowToFolder(row as unknown as Record<string, unknown>));
}

/** All folders (live), for the move-modal tree picker. */
export async function listAllFolders(): Promise<Folder[]> {
  const c = await db();
  const r = await c.execute("SELECT * FROM folders WHERE deleted_at IS NULL ORDER BY LOWER(name) ASC");
  return r.rows.map((row) => rowToFolder(row as unknown as Record<string, unknown>));
}

/** Walk parent_id up to the root. Returns [root, …, self]. */
export async function getFolderBreadcrumb(id: string): Promise<Folder[]> {
  const chain: Folder[] = [];
  let cursor: string | null = id;
  // Hard cap protects against a pathological cycle if data ever got corrupted.
  for (let i = 0; i < 64 && cursor; i++) {
    const f = await getFolder(cursor, { includeDeleted: true });
    if (!f) break;
    chain.unshift(f);
    cursor = f.parentId;
  }
  return chain;
}

/** Recursively collect every descendant folder id (does NOT include the folder itself). */
async function getDescendantFolderIds(folderId: string): Promise<string[]> {
  const c = await db();
  const out: string[] = [];
  let frontier: string[] = [folderId];
  while (frontier.length > 0) {
    const placeholders = frontier.map(() => "?").join(",");
    const r = await c.execute({
      sql: `SELECT id FROM folders WHERE parent_id IN (${placeholders})`,
      args: frontier,
    });
    const next = r.rows.map((row) => String((row as unknown as Record<string, unknown>).id));
    for (const id of next) out.push(id);
    frontier = next;
  }
  return out;
}

/**
 * Folder rows ready for the browser: each child of `parentId`, with counts of
 * jobs and subfolders DIRECTLY inside (not recursive). The count matches what
 * you'll see when you click into the folder — no surprise where "8 jobs" on a
 * folder row resolves to "3 jobs visible after click + 5 hidden in subfolders".
 */
export async function listFolderRows(parentId: string | null): Promise<FolderRow[]> {
  const children = await listChildFolders(parentId);
  const out: FolderRow[] = [];
  const c = await db();
  for (const f of children) {
    const [jobsR, subR] = await Promise.all([
      c.execute({
        sql: "SELECT COUNT(*) AS n FROM jobs WHERE deleted_at IS NULL AND folder_id = ?",
        args: [f.id],
      }),
      c.execute({
        sql: "SELECT COUNT(*) AS n FROM folders WHERE deleted_at IS NULL AND parent_id = ?",
        args: [f.id],
      }),
    ]);
    out.push({
      ...f,
      jobCount: Number((jobsR.rows[0] as unknown as Record<string, unknown>).n ?? 0),
      subfolderCount: Number((subR.rows[0] as unknown as Record<string, unknown>).n ?? 0),
    });
  }
  return out;
}

export async function createFolder(args: { name: string; parentId: string | null }): Promise<string> {
  const c = await db();
  const id = uid("fld");
  const now = Date.now();
  await c.execute({
    sql: "INSERT INTO folders (id, parent_id, name, created_at) VALUES (?, ?, ?, ?)",
    args: [id, args.parentId, args.name.trim(), now],
  });
  return id;
}

export async function renameFolder(id: string, name: string): Promise<void> {
  const c = await db();
  await c.execute({ sql: "UPDATE folders SET name = ? WHERE id = ?", args: [name.trim(), id] });
}

/**
 * Move a folder to a new parent (or to root with `newParentId = null`).
 * Rejects cycles: you cannot move a folder into itself or into one of its descendants.
 */
export async function moveFolder(id: string, newParentId: string | null): Promise<{ ok: boolean; message?: string }> {
  if (newParentId === id) return { ok: false, message: "Cannot move a folder into itself." };
  if (newParentId !== null) {
    // Walk the proposed parent's ancestor chain. If we encounter `id`, it's a cycle.
    const ancestors = await getFolderBreadcrumb(newParentId);
    if (ancestors.some((a) => a.id === id)) {
      return { ok: false, message: "Cannot move a folder into one of its own subfolders." };
    }
  }
  const c = await db();
  await c.execute({ sql: "UPDATE folders SET parent_id = ? WHERE id = ?", args: [newParentId, id] });
  return { ok: true };
}

/**
 * Soft-delete a folder and CASCADE the tombstone to:
 *   - every descendant folder
 *   - every live job in the subtree (jobs already in trash are untouched)
 * Restoring just brings the folder + descendants back. Jobs that were tombstoned
 * by this cascade have the same deleted_at timestamp, so the Trash view can group
 * them as "deleted with folder X" if we ever want that — not implemented yet.
 */
export async function softDeleteFolder(id: string): Promise<void> {
  const c = await db();
  const now = Date.now();
  const descendants = await getDescendantFolderIds(id);
  const allFolderIds = [id, ...descendants];
  const placeholders = allFolderIds.map(() => "?").join(",");
  // Mark folders
  await c.execute({
    sql: `UPDATE folders SET deleted_at = ? WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
    args: [now, ...allFolderIds],
  });
  // Tombstone live jobs in any of those folders
  await c.execute({
    sql: `UPDATE jobs
            SET deleted_at = ?,
                runner_id = NULL,
                runner_heartbeat_at = NULL,
                status = CASE WHEN status = 'running' THEN 'cancelled' ELSE status END,
                updated_at = ?
          WHERE deleted_at IS NULL AND folder_id IN (${placeholders})`,
    args: [now, now, ...allFolderIds],
  });
}

/**
 * Restore a soft-deleted folder + every descendant folder + every job that was
 * deleted as part of the same cascade (same deleted_at timestamp on the folder).
 * Jobs that were already in trash before the cascade have a DIFFERENT timestamp
 * and are left in the trash — restore them individually if needed.
 */
export async function restoreFolder(id: string): Promise<void> {
  const c = await db();
  const f = await getFolder(id, { includeDeleted: true });
  if (!f || f.deletedAt == null) return;
  const cascadeStamp = f.deletedAt;
  // Walk the (deleted) descendant tree starting from `id`.
  const out: string[] = [];
  let frontier: string[] = [id];
  while (frontier.length > 0) {
    const placeholders = frontier.map(() => "?").join(",");
    const r = await c.execute({
      sql: `SELECT id FROM folders WHERE parent_id IN (${placeholders})`,
      args: frontier,
    });
    const next = r.rows.map((row) => String((row as unknown as Record<string, unknown>).id));
    for (const next_id of next) out.push(next_id);
    frontier = next;
  }
  const allFolderIds = [id, ...out];
  const placeholders = allFolderIds.map(() => "?").join(",");
  // Untombstone folders that share the cascade timestamp (avoid resurrecting
  // folders the user deleted separately and just happen to be descendants).
  await c.execute({
    sql: `UPDATE folders SET deleted_at = NULL WHERE id IN (${placeholders}) AND deleted_at = ?`,
    args: [...allFolderIds, cascadeStamp],
  });
  // Same logic for jobs in the subtree.
  await c.execute({
    sql: `UPDATE jobs SET deleted_at = NULL, updated_at = ?
          WHERE folder_id IN (${placeholders}) AND deleted_at = ?`,
    args: [Date.now(), ...allFolderIds, cascadeStamp],
  });
}

/** Hard-delete folder + descendants + all contained jobs. Irreversible. */
export async function purgeFolder(id: string): Promise<void> {
  const c = await db();
  const descendants = await getDescendantFolderIds(id);
  const allFolderIds = [id, ...descendants];
  const placeholders = allFolderIds.map(() => "?").join(",");
  // Jobs first (FK has ON DELETE CASCADE from folders → jobs.folder_id, but jobs.folder_id
  // has no FK constraint in our schema — explicit DELETE is clearer + portable).
  await c.execute({
    sql: `DELETE FROM jobs WHERE folder_id IN (${placeholders})`,
    args: allFolderIds,
  });
  await c.execute({
    sql: `DELETE FROM folders WHERE id IN (${placeholders})`,
    args: allFolderIds,
  });
}

/** List soft-deleted items for the Trash view (folders + jobs, separately). */
export async function listTrash(): Promise<{ folders: Folder[]; jobs: Job[] }> {
  const c = await db();
  const [foldersR, jobsR] = await Promise.all([
    c.execute("SELECT * FROM folders WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC"),
    c.execute("SELECT * FROM jobs WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC"),
  ]);
  return {
    folders: foldersR.rows.map((row) => rowToFolder(row as unknown as Record<string, unknown>)),
    jobs: jobsR.rows.map((row) => rowToJob(row as unknown as Record<string, unknown>)),
  };
}

// ============================================================================
// Model pricing (2026-05-24, "Drop Sherlock-style" cost tracking)
// ============================================================================
// One row per (provider, model). Rates in USD per 1 MILLION tokens. Editing here
// does NOT retroactively recompute old jobs' costs — those are locked in at
// batch-write time via addJobCostAndTokens below. Missing rows = $0/M for both;
// the UI shows a "missing pricing" warning to flag this.

function rowToModelPricing(r: Record<string, unknown>): ModelPricing {
  return {
    providerId: String(r.provider) as ProviderId,
    model: String(r.model),
    inputPerMillion: Number(r.input_per_million ?? 0),
    outputPerMillion: Number(r.output_per_million ?? 0),
    updatedAt: Number(r.updated_at ?? 0),
  };
}

export async function listModelPricing(): Promise<ModelPricing[]> {
  const c = await db();
  const r = await c.execute("SELECT * FROM model_pricing ORDER BY provider, model");
  return r.rows.map((row) => rowToModelPricing(row as unknown as Record<string, unknown>));
}

export async function getModelPricing(providerId: ProviderId, model: string): Promise<ModelPricing | null> {
  const c = await db();
  const r = await c.execute({
    sql: "SELECT * FROM model_pricing WHERE provider = ? AND model = ?",
    args: [providerId, model],
  });
  if (r.rows.length === 0) return null;
  return rowToModelPricing(r.rows[0] as unknown as Record<string, unknown>);
}

/** Upsert a pricing row. Use 0 for either rate when the provider is genuinely free. */
export async function saveModelPricing(p: Omit<ModelPricing, "updatedAt">): Promise<void> {
  const c = await db();
  await c.execute({
    sql: `INSERT INTO model_pricing (provider, model, input_per_million, output_per_million, updated_at)
            VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(provider, model) DO UPDATE SET
            input_per_million = excluded.input_per_million,
            output_per_million = excluded.output_per_million,
            updated_at = excluded.updated_at`,
    args: [p.providerId, p.model, p.inputPerMillion, p.outputPerMillion, Date.now()],
  });
}

export async function deleteModelPricing(providerId: ProviderId, model: string): Promise<void> {
  const c = await db();
  await c.execute({
    sql: "DELETE FROM model_pricing WHERE provider = ? AND model = ?",
    args: [providerId, model],
  });
}

/**
 * Add tokens + cost to a job after a successful batch. Atomic UPDATE (no read-modify-
 * write race even if two batches finish near-simultaneously — SQLite serializes the
 * writes thanks to WAL). Cost is captured by the caller using the pricing row that
 * existed at write time; this function just adds it.
 */
export async function addJobCostAndTokens(
  jobId: string,
  delta: { inputTokens: number; outputTokens: number; cachedInputTokens: number; costUsd: number }
): Promise<void> {
  const c = await db();
  await c.execute({
    sql: `UPDATE jobs SET
            ai_input_tokens = ai_input_tokens + ?,
            ai_output_tokens = ai_output_tokens + ?,
            ai_cached_input_tokens = ai_cached_input_tokens + ?,
            ai_cost_usd = ai_cost_usd + ?,
            updated_at = ?
          WHERE id = ?`,
    args: [
      Math.max(0, Math.floor(delta.inputTokens)),
      Math.max(0, Math.floor(delta.outputTokens)),
      Math.max(0, Math.floor(delta.cachedInputTokens)),
      Math.max(0, delta.costUsd),
      Date.now(),
      jobId,
    ],
  });
}

/**
 * Compute the USD cost for one AI call using the pricing row that exists RIGHT NOW.
 * Returns 0 if there's no pricing row (caller can detect by checking `priced=false`).
 * Math: (inputTokens × inputPerMillion + outputTokens × outputPerMillion) / 1_000_000.
 * Cached input tokens are billed at the same rate — we don't apply a discount because
 * provider discount semantics aren't reliably published; we just surface the cache-hit
 * count separately for visibility.
 */
export async function computeAiCost(args: {
  providerId: ProviderId;
  model: string;
  inputTokens: number;
  outputTokens: number;
}): Promise<{ costUsd: number; priced: boolean }> {
  const row = await getModelPricing(args.providerId, args.model);
  if (!row) return { costUsd: 0, priced: false };
  const cost = (args.inputTokens * row.inputPerMillion + args.outputTokens * row.outputPerMillion) / 1_000_000;
  return { costUsd: cost, priced: true };
}

/** Zero out a job's cost counters. Called on rerun (when anchors are cleared) so
 *  "this run" is the only contribution to the displayed cost. */
export async function resetJobCost(jobId: string): Promise<void> {
  const c = await db();
  await c.execute({
    sql: `UPDATE jobs SET
            ai_input_tokens = 0,
            ai_output_tokens = 0,
            ai_cached_input_tokens = 0,
            ai_cost_usd = 0,
            updated_at = ?
          WHERE id = ?`,
    args: [Date.now(), jobId],
  });
}
