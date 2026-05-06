import { db } from "./db";
import { normalizeDistribution } from "./types";
import type { Job, JobAnchor, JobCriteria, JobInput, JobMode, JobStatus } from "./types";
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
  return {
    id: String(r.id),
    name: String(r.name),
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
  };
}
function rowToInput(r: Record<string, unknown>): JobInput {
  return {
    id: String(r.id),
    jobId: String(r.job_id),
    targetUrl: String(r.target_url),
    title: r.title == null ? null : String(r.title),
    keywords: r.keywords == null ? null : String(r.keywords),
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
  // Stuck + has anchors → partial
  await c.execute({
    sql: `UPDATE jobs
            SET status = 'partial',
                last_error = COALESCE(last_error, 'Server interrupted generation'),
                runner_id = NULL,
                runner_heartbeat_at = NULL,
                updated_at = ?
          WHERE status = 'running'
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
            AND (runner_heartbeat_at IS NULL OR runner_heartbeat_at < ?)
            AND updated_at < ?
            AND id NOT IN (SELECT job_id FROM job_anchors GROUP BY job_id)`,
    args: [Date.now(), cutoff, cutoff],
  });
}

export async function listJobs(): Promise<Job[]> {
  const c = await db();
  await reconcileStuckRunningJobs();
  const r = await c.execute("SELECT * FROM jobs ORDER BY updated_at DESC");
  return r.rows.map((row) => rowToJob(row as unknown as Record<string, unknown>));
}

export async function getJob(id: string): Promise<Job | null> {
  const c = await db();
  const r = await c.execute({ sql: "SELECT * FROM jobs WHERE id = ?", args: [id] });
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
  inputs: Array<{ targetUrl: string; title: string | null; keywords: string | null }>;
}): Promise<string> {
  const c = await db();
  const id = uid("job");
  const now = Date.now();
  await c.execute({
    sql: "INSERT INTO jobs (id, name, mode, criteria, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    args: [id, args.name, args.mode, JSON.stringify(args.criteria), now, now],
  });
  for (let i = 0; i < args.inputs.length; i++) {
    const inp = args.inputs[i];
    await c.execute({
      sql: "INSERT INTO job_inputs (id, job_id, target_url, title, keywords, position) VALUES (?, ?, ?, ?, ?, ?)",
      args: [uid("inp"), id, inp.targetUrl, inp.title, inp.keywords, i],
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
  inputs: Array<{ targetUrl: string; title: string | null; keywords: string | null }>;
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
      sql: "INSERT INTO job_inputs (id, job_id, target_url, title, keywords, position) VALUES (?, ?, ?, ?, ?, ?)",
      args: [uid("inp"), args.id, inp.targetUrl, inp.title, inp.keywords, i],
    });
  }
}

export async function deleteJob(id: string): Promise<void> {
  const c = await db();
  await c.execute({ sql: "DELETE FROM jobs WHERE id = ?", args: [id] });
}

/** Bulk delete. Returns the number of rows actually removed. */
export async function deleteJobs(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const c = await db();
  const placeholders = ids.map(() => "?").join(",");
  const r = await c.execute({ sql: `DELETE FROM jobs WHERE id IN (${placeholders})`, args: ids });
  return Number(r.rowsAffected ?? 0);
}

export async function replaceJobAnchors(jobId: string, anchors: Array<Omit<JobAnchor, "id" | "jobId" | "manuallyEdited"> & { id?: string }>): Promise<void> {
  const c = await db();
  await c.execute({ sql: "DELETE FROM job_anchors WHERE job_id = ?", args: [jobId] });
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    await c.execute({
      sql: "INSERT INTO job_anchors (id, job_id, input_id, target_url, brand_id, follow_status, anchor_text, category, manually_edited, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
      args: [a.id ?? uid("anc"), jobId, a.inputId, a.targetUrl, a.brandId, a.followStatus, a.anchorText, a.category, i],
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
      sql: "INSERT INTO job_anchors (id, job_id, input_id, target_url, brand_id, follow_status, anchor_text, category, manually_edited, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
      args: [uid("anc"), jobId, a.inputId, a.targetUrl, a.brandId, a.followStatus, a.anchorText, a.category, startPos + i],
    });
  }
  await c.execute({ sql: "UPDATE jobs SET updated_at = ? WHERE id = ?", args: [Date.now(), jobId] });
}

export async function clearJobAnchors(jobId: string): Promise<void> {
  const c = await db();
  await c.execute({ sql: "DELETE FROM job_anchors WHERE job_id = ?", args: [jobId] });
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
