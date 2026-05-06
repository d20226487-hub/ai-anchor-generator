"use server";

import { revalidatePath } from "next/cache";
import { loadSettings, mergeIncomingSettings, redactSettings, saveSettings } from "./settings";
import {
  appendJobAnchors,
  clearJobAnchors,
  clearRunnerLease,
  createJob,
  deleteJob,
  deleteJobs,
  forceClaimRunnerLease,
  getAnchorsByIds,
  getJob,
  getRunnerLease,
  renameJob,
  replaceJobAnchors,
  setJobStatus,
  updateAnchorFollow,
  updateAnchorText,
  updateAnchorsByMap,
  updateJob,
} from "./jobs";
import { isLoopRunning, runJobLoop, stopJobLoop } from "./jobLoop";
import { pingProvider, callProvider } from "./providers";
import { composeGenerationPrompt, composeRegenerationPrompt } from "./anchors/compose";
import { planBatches } from "./anchors/batchPlan";
import { planRebalance, type RebalanceMode } from "./anchors/rebalance";
import { brandKeyOf as brandKeyForAnchor, brandKeyOf, matchBrand } from "./anchors/brands";
import { db } from "./db";
import { parseAnchorsResponse, parseRegenResponse } from "./anchors/parse";
import { quickFixDofollowRatio } from "./anchors/quickfix";
import type { Brand, JobCriteria, JobMode, Locale, ProviderId, SettingsBlob, Theme, JobAnchor } from "./types";
import { uid } from "./utils";

// ----- Settings -----

/**
 * Returns settings with API keys REDACTED — `providers[*].apiKey` is "" and
 * `providers[*].apiKeyPreview` is set to a short hint like "sk-or…7107".
 * The full key never leaves the server. The Settings form must use empty-key-means-keep
 * semantics on save (handled below in actionSaveSettings via mergeIncomingSettings).
 */
export async function actionGetSettings(): Promise<SettingsBlob> {
  return redactSettings(await loadSettings());
}

export async function actionSaveSettings(blob: SettingsBlob): Promise<void> {
  // Merge with stored: empty incoming apiKey means "keep existing" (because the client
  // received a redacted view via actionGetSettings). This lets the form round-trip safely.
  const stored = await loadSettings();
  const merged = mergeIncomingSettings(blob, stored);
  await saveSettings(merged);
  revalidatePath("/settings");
  revalidatePath("/jobs/new");
}

export async function actionSetLocale(locale: Locale): Promise<void> {
  const current = await loadSettings();
  await saveSettings({ ...current, locale });
  // Locale affects every page, so revalidate the entire layout tree.
  revalidatePath("/", "layout");
}

export async function actionSetTheme(theme: Theme): Promise<void> {
  const current = await loadSettings();
  await saveSettings({ ...current, theme });
  revalidatePath("/", "layout");
}

export async function actionTestProvider(
  providerId: ProviderId,
  unsavedSettings?: SettingsBlob
): Promise<{ ok: boolean; message: string }> {
  // unsavedSettings comes from the client form which only ever holds redacted/empty keys
  // for fields the user hasn't replaced. Merge with the stored copy so unchanged keys
  // still authenticate correctly during a Test connection.
  const stored = await loadSettings();
  const settings = unsavedSettings ? mergeIncomingSettings(unsavedSettings, stored) : stored;
  return pingProvider(providerId, settings);
}

// ----- Jobs -----

export interface CreateJobArgs {
  name: string;
  mode: JobMode;
  criteria: JobCriteria;
  inputs: Array<{ targetUrl: string; title: string | null; keywords: string | null }>;
}

export async function actionCreateJob(args: CreateJobArgs): Promise<string> {
  const id = await createJob(args);
  revalidatePath("/");
  return id;
}

export async function actionRenameJob(id: string, name: string): Promise<void> {
  await renameJob(id, name);
  revalidatePath("/");
  revalidatePath(`/jobs/${id}`);
}

export interface UpdateJobArgs {
  id: string;
  name: string;
  mode: JobMode;
  criteria: JobCriteria;
  inputs: Array<{ targetUrl: string; title: string | null; keywords: string | null }>;
}

export async function actionUpdateJob(args: UpdateJobArgs): Promise<void> {
  await updateJob(args);
  revalidatePath("/");
  revalidatePath(`/jobs/${args.id}`);
  revalidatePath(`/jobs/${args.id}/edit`);
}

export async function actionDeleteJob(id: string): Promise<void> {
  // Stop any in-process loop for this job before deleting so it doesn't try to
  // operate on a non-existent row mid-batch.
  stopJobLoop(id);
  await deleteJob(id);
  revalidatePath("/");
}

/**
 * Bulk delete jobs. Stops any running loops first. Returns the number of jobs
 * actually removed (may be less than ids.length if some were already gone).
 */
export async function actionDeleteJobs(ids: string[]): Promise<{ ok: boolean; deleted: number }> {
  if (ids.length === 0) return { ok: false, deleted: 0 };
  for (const id of ids) stopJobLoop(id);
  const deleted = await deleteJobs(ids);
  revalidatePath("/");
  return { ok: true, deleted };
}

// ----- Batched Generation (server-side background loop) -----

export interface StartGenerationResult {
  ok: boolean;
  message: string;
  batchSize: number;
  batchesTotal: number;
}

/**
 * Set up the job for generation and kick off the SERVER-SIDE background loop.
 * Returns immediately — generation continues in the Next.js server process even
 * if the user closes the browser tab. The browser polls actionGetJobStatus for
 * progress updates.
 */
export async function actionStartGeneration(
  jobId: string,
  opts: { resetAnchors?: boolean; batchInputSize?: number; resume?: boolean } = {}
): Promise<StartGenerationResult> {
  const job = await getJob(jobId);
  if (!job) return { ok: false, message: "Job not found", batchSize: 0, batchesTotal: 0 };
  const inputs = job.inputs ?? [];
  if (inputs.length === 0) return { ok: false, message: "Job has no inputs", batchSize: 0, batchesTotal: 0 };

  const planned = planBatches(job.criteria, inputs, opts.batchInputSize ?? 10);

  if (opts.resume) {
    // Don't touch anchors or progress — just flip status back to running and clear the
    // (possibly stale) lease so the new server loop can claim it immediately. After a
    // server restart the in-process loop is gone but the DB still has status=running;
    // Resume re-spawns the loop.
    await clearRunnerLease(jobId);
    await setJobStatus(jobId, "running", { lastError: null, runStartedAt: Date.now() });
    runJobLoop(jobId);
    revalidatePath(`/jobs/${jobId}`);
    return { ok: true, message: "Resumed", batchSize: job.batchSize, batchesTotal: job.batchesTotal };
  }

  // Stop any lingering loop (e.g. user clicked Rerun while a previous run was active).
  stopJobLoop(jobId);

  if (opts.resetAnchors !== false) {
    await clearJobAnchors(jobId);
  }
  await clearRunnerLease(jobId);
  await setJobStatus(jobId, "running", {
    lastError: null,
    batchSize: planned.batchSize,
    batchesTotal: planned.batchesTotal,
    runStartedAt: Date.now(),
    resetBatchesDone: true,
  });
  runJobLoop(jobId);
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true, message: "Generation started", batchSize: planned.batchSize, batchesTotal: planned.batchesTotal };
}

export async function actionCancelGeneration(jobId: string): Promise<void> {
  const job = await getJob(jobId);
  if (!job) return;
  stopJobLoop(jobId);
  await setJobStatus(jobId, "cancelled", { lastError: null });
  await clearRunnerLease(jobId);
  revalidatePath(`/jobs/${jobId}`);
}

export async function actionPauseGeneration(jobId: string): Promise<void> {
  const job = await getJob(jobId);
  if (!job) return;
  stopJobLoop(jobId);
  await setJobStatus(jobId, "paused", { lastError: null });
  await clearRunnerLease(jobId);
  revalidatePath(`/jobs/${jobId}`);
}

// ----- Status polling (replaces the client-orchestrator return value) -----

export interface JobStatusSnapshot {
  status: string;
  batchesDone: number;
  batchesTotal: number;
  lastError: string | null;
  anchorsCount: number;
  runnerHeartbeatAt: number | null;
  loopAlive: boolean;
}

/**
 * Lightweight read of job status for browser polling. Returns just what the
 * RunStatusPanel needs to render — does NOT pull anchors or inputs.
 */
export async function actionGetJobStatus(jobId: string): Promise<JobStatusSnapshot | null> {
  const c = await db();
  const r = await c.execute({
    sql: `SELECT status, batches_done, batches_total, last_error, runner_heartbeat_at,
                 (SELECT COUNT(*) FROM job_anchors WHERE job_id = jobs.id) AS anchors_count
          FROM jobs WHERE id = ?`,
    args: [jobId],
  });
  const row = r.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    status: String(row.status ?? "idle"),
    batchesDone: Number(row.batches_done ?? 0),
    batchesTotal: Number(row.batches_total ?? 0),
    lastError: row.last_error == null ? null : String(row.last_error),
    anchorsCount: Number(row.anchors_count ?? 0),
    runnerHeartbeatAt: row.runner_heartbeat_at == null ? null : Number(row.runner_heartbeat_at),
    loopAlive: isLoopRunning(jobId),
  };
}

// ----- Runner lease (cross-host two-runner guard) -----

/**
 * Forcibly take over the runner lease — used when the user clicks "Take over now" on the
 * "another runner is active" banner. The previous holder will see lease_lost on its next
 * actionGenerateBatch call and stop.
 */
export async function actionTakeOverRunner(jobId: string, runnerId: string): Promise<void> {
  await forceClaimRunnerLease(jobId, runnerId);
  revalidatePath(`/jobs/${jobId}`);
}

/** Read current lease holder + heartbeat age. For the "another runner active" banner. */
export async function actionGetRunnerLease(jobId: string): Promise<{ runnerId: string | null; heartbeatAgeMs: number | null }> {
  return getRunnerLease(jobId);
}

// ----- Per-brand rebalance -----

export interface RebalanceBrandResult {
  ok: boolean;
  message: string;
  brandKey: string;
  deleted: number;
  added: number;
  warnings: string[];
}

/**
 * Rebalance ONE brand's anchors so its category (and follow) distribution lines up with
 * the job criteria. Manual edits are always preserved.
 */
export async function actionRebalanceBrand(
  jobId: string,
  brandKey: string,
  opts: { mode: RebalanceMode }
): Promise<RebalanceBrandResult> {
  const settings = await loadSettings();
  const job = await getJob(jobId);
  if (!job) return { ok: false, message: "Job not found", brandKey, deleted: 0, added: 0, warnings: [] };

  const allAnchors = job.anchors ?? [];
  const brands = job.criteria.brands;

  // Gather this brand's anchors and inputs.
  const brandAnchors = allAnchors.filter((a) => brandKeyForAnchor(a, brands) === brandKey);
  if (brandAnchors.length === 0) {
    return { ok: false, message: "No anchors for that brand", brandKey, deleted: 0, added: 0, warnings: [] };
  }
  const inputs = (job.inputs ?? []).filter((i) => {
    const matched = matchBrand(i.targetUrl, brands);
    if (matched) return matched.id === brandKey;
    // fall back to hostname-based key (same logic brandKeyOf uses for unbranded URLs)
    const fallbackProbe = { id: "", jobId: "", inputId: null, targetUrl: i.targetUrl, brandId: null, followStatus: null, anchorText: "", category: "generic" as const, manuallyEdited: 0 as const };
    return brandKeyForAnchor(fallbackProbe, brands) === brandKey;
  });
  if (inputs.length === 0) {
    return { ok: false, message: "No inputs for that brand", brandKey, deleted: 0, added: 0, warnings: [] };
  }

  const plan = planRebalance({ brandAnchors, criteria: job.criteria, mode: opts.mode });
  if (plan.generate.total === 0 && plan.deleteIds.length === 0) {
    return { ok: true, message: "Brand is already on target — nothing to do.", brandKey, deleted: 0, added: 0, warnings: plan.warnings };
  }

  // Compose a one-shot prompt for the new anchors, with exact counts.
  const hints = {
    isBatch: true as const,
    batchIndex: 0,
    batchesTotal: 1,
    exactCounts: {
      total: plan.generate.total,
      generic: plan.generate.perCategory.generic,
      branded: plan.generate.perCategory.branded,
      keyword: plan.generate.perCategory.keyword,
      url: plan.generate.perCategory.url,
      dofollow: plan.generate.perFollow?.dofollow,
      nofollow: plan.generate.perFollow?.nofollow,
    },
  };

  let added = 0;
  if (plan.generate.total > 0) {
    const prompt = composeGenerationPrompt({
      template: settings.prompts.generation,
      mode: job.mode,
      criteria: job.criteria,
      inputs,
      batch: hints,
    });

    let raw: string;
    try {
      raw = await callProvider({ providerId: job.criteria.providerId, model: job.criteria.model, prompt, settings });
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e), brandKey, deleted: 0, added: 0, warnings: plan.warnings };
    }

    let parsed: ReturnType<typeof parseAnchorsResponse>;
    try {
      parsed = parseAnchorsResponse(raw);
    } catch (e) {
      return { ok: false, message: `Could not parse AI output: ${e instanceof Error ? e.message : String(e)}`, brandKey, deleted: 0, added: 0, warnings: plan.warnings };
    }
    if (parsed.length === 0) {
      return { ok: false, message: "AI returned no usable anchors", brandKey, deleted: 0, added: 0, warnings: plan.warnings };
    }

    // Same id-based + URL-fallback strategy as the main batch loop (jobLoop.ts).
    // Primary key = input id (collision-free even when many rows share a URL).
    // Fallback = URL match, but only for URLs that occur exactly once in the batch.
    const inputById = new Map(inputs.map((i) => [i.id, i]));
    const urlOcc = new Map<string, number>();
    for (const i of inputs) {
      const k = i.targetUrl.toLowerCase();
      urlOcc.set(k, (urlOcc.get(k) ?? 0) + 1);
    }
    const uniqueUrlMap = new Map<string, typeof inputs[number]>();
    for (const i of inputs) {
      const k = i.targetUrl.toLowerCase();
      if (urlOcc.get(k) === 1) uniqueUrlMap.set(k, i);
    }
    const newAnchors = parsed
      .map((p) => {
        // `||` (not `??`) so empty-string id falls through to URL fallback.
        const matched = (p.id ? inputById.get(p.id) : undefined)
          || (p.targetUrl ? uniqueUrlMap.get(p.targetUrl.toLowerCase()) : undefined)
          || null;
        if (!matched) return null;
        const b = brands.find((x) => x.id === brandKey) ?? null;
        const anchorText = p.category === "url" ? matched.targetUrl : p.anchorText;
        return {
          inputId: matched.id,
          targetUrl: matched.targetUrl,
          brandId: b?.id ?? null,
          followStatus: job.criteria.ratiosEnabled ? (p.followStatus ?? "dofollow") : null,
          anchorText,
          category: p.category,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    // Apply DB changes: delete planned IDs first, then insert new anchors.
    if (plan.deleteIds.length > 0) await deleteAnchorsByIds(plan.deleteIds);
    await appendJobAnchors(jobId, newAnchors);
    added = newAnchors.length;
  } else if (plan.deleteIds.length > 0) {
    // generate.total === 0 but we still have deletions to apply (rare in surgical mode
    // when the brand is over-saturated and only needs trimming).
    await deleteAnchorsByIds(plan.deleteIds);
  }

  revalidatePath(`/jobs/${jobId}`);
  return {
    ok: true,
    message: `Rebalanced: deleted ${plan.deleteIds.length}, added ${added}.`,
    brandKey,
    deleted: plan.deleteIds.length,
    added,
    warnings: plan.warnings,
  };
}

async function deleteAnchorsByIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const c = await db();
  const placeholders = ids.map(() => "?").join(",");
  await c.execute({ sql: `DELETE FROM job_anchors WHERE id IN (${placeholders})`, args: ids });
}

// ----- Regenerate (subset) -----

export async function actionRegenerate(jobId: string, anchorIds: string[]): Promise<{ ok: boolean; message: string }> {
  if (anchorIds.length === 0) return { ok: false, message: "No anchors selected" };
  const settings = await loadSettings();
  const job = await getJob(jobId);
  if (!job) return { ok: false, message: "Job not found" };

  const targets: JobAnchor[] = (job.anchors ?? []).filter((a) => anchorIds.includes(a.id));
  if (targets.length === 0) return { ok: false, message: "Selected anchors not found" };

  const prompt = composeRegenerationPrompt({
    template: settings.prompts.regeneration,
    criteria: job.criteria,
    anchors: targets,
  });

  let raw: string;
  try {
    raw = await callProvider({ providerId: job.criteria.providerId, model: job.criteria.model, prompt, settings });
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }

  const parsed = parseRegenResponse(raw);
  if (parsed.length === 0) return { ok: false, message: "AI returned no replacements" };

  await updateAnchorsByMap(jobId, parsed.map((p) => ({ id: p.id, anchorText: p.anchorText })));
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true, message: `Regenerated ${parsed.length} anchors.` };
}

// ----- Manual edits -----

export async function actionEditAnchorText(jobId: string, anchorId: string, text: string): Promise<void> {
  await updateAnchorText(jobId, anchorId, text);
  revalidatePath(`/jobs/${jobId}`);
}

export async function actionEditAnchorFollow(jobId: string, anchorId: string, follow: "dofollow" | "nofollow"): Promise<void> {
  await updateAnchorFollow(jobId, anchorId, follow);
  revalidatePath(`/jobs/${jobId}`);
}

// ----- Quick-fix dofollow ratio -----

export async function actionQuickFixRatio(jobId: string): Promise<{ ok: boolean; message: string; flipped: number; groupCount: number }> {
  const job = await getJob(jobId);
  if (!job) return { ok: false, message: "Job not found", flipped: 0, groupCount: 0 };
  if (!job.criteria.ratiosEnabled) return { ok: false, message: "Dofollow ratio is disabled for this job", flipped: 0, groupCount: 0 };
  const anchors = job.anchors ?? [];
  if (anchors.length === 0) return { ok: false, message: "No anchors to fix", flipped: 0, groupCount: 0 };

  const result = quickFixDofollowRatio(anchors, job.mode, job.criteria.dofollowPct, (a) => brandKeyOf(a, job.criteria.brands));
  await updateAnchorsByMap(jobId, result.changes.map((c) => ({ id: c.id, followStatus: c.newFollow })));
  revalidatePath(`/jobs/${jobId}`);

  const target = job.criteria.dofollowPct;
  if (job.mode === "multi_site") {
    const adjustedGroups = result.groups.filter((g) => g.targetCount !== g.currentCount).length;
    return {
      ok: true,
      message: result.changes.length === 0
        ? `All ${result.groups.length} site${result.groups.length === 1 ? "" : "s"} already at the ${target}% dofollow target.`
        : `Flipped ${result.changes.length} anchors across ${adjustedGroups} site${adjustedGroups === 1 ? "" : "s"} to hit the ${target}% dofollow target per-site.`,
      flipped: result.changes.length,
      groupCount: result.groups.length,
    };
  }
  return {
    ok: true,
    message: result.changes.length === 0
      ? `Already at the ${target}% dofollow target.`
      : `Flipped ${result.changes.length} anchors to match the ${target}% dofollow target.`,
    flipped: result.changes.length,
    groupCount: 1,
  };
}

// ----- Prompt preview (for new-job form, before saving) -----

export async function actionPreviewPrompt(args: {
  mode: JobMode;
  criteria: JobCriteria;
  inputs: Array<{ targetUrl: string; title: string | null; keywords: string | null }>;
}): Promise<string> {
  const settings = await loadSettings();
  // The preview is for inputs that haven't been saved yet, so they have no real DB ids.
  // Synthesise stable preview ids — these never reach the DB; they only make the prompt
  // look representative of what the live AI call would see.
  const inputsWithIds = args.inputs.map((i, idx) => ({ ...i, id: `preview_${idx + 1}` }));
  return composeGenerationPrompt({
    template: settings.prompts.generation,
    mode: args.mode,
    criteria: args.criteria,
    inputs: inputsWithIds,
  });
}

// ----- Brand helpers (re-export for client) -----

export async function actionGetBrandsForAnchors(jobId: string): Promise<Brand[]> {
  const job = await getJob(jobId);
  return job?.criteria.brands ?? [];
}

// ----- Lookup helpers -----

export async function actionGetAnchors(ids: string[]): Promise<JobAnchor[]> {
  return getAnchorsByIds(ids);
}
