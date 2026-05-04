"use server";

import { revalidatePath } from "next/cache";
import { loadSettings, mergeIncomingSettings, redactSettings, saveSettings } from "./settings";
import {
  appendJobAnchors,
  claimOrRefreshRunnerLease,
  clearJobAnchors,
  clearRunnerLease,
  createJob,
  deleteJob,
  forceClaimRunnerLease,
  getAnchorsByIds,
  getJob,
  getRunnerLease,
  incrementBatchesDone,
  releaseRunnerLease,
  renameJob,
  replaceJobAnchors,
  setJobStatus,
  updateAnchorFollow,
  updateAnchorText,
  updateAnchorsByMap,
  updateJob,
} from "./jobs";
import { callProvider, pingProvider } from "./providers";
import { composeGenerationPrompt, composeRegenerationPrompt } from "./anchors/compose";
import { planBatch, planBatches } from "./anchors/batchPlan";
import { planRebalance, type RebalanceMode } from "./anchors/rebalance";
import { brandKeyOf as brandKeyForAnchor } from "./anchors/brands";
import { db } from "./db";
import { parseAnchorsResponse, parseRegenResponse } from "./anchors/parse";
import { matchBrand, brandKeyOf } from "./anchors/brands";
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
  await deleteJob(id);
  revalidatePath("/");
}

// ----- Batched Generation -----

const RATE_LIMIT_HINTS = /rate|429|too many requests|quota/i;

export interface StartGenerationResult {
  ok: boolean;
  message: string;
  batchSize: number;
  batchesTotal: number;
}

/**
 * Mark the job as running, plan the batches, clear any prior anchors. Does NOT call the AI —
 * that happens via actionGenerateBatch (orchestrated by the client).
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
    // Don't touch anchors or progress — just flip status back to running so the orchestrator
    // can pick up at job.batchesDone. We do NOT clear the runner lease — if some other browser
    // is actively running, the new orchestrator's claim will fail and the user will see the
    // "another runner is active" banner with a Take-Over button.
    await setJobStatus(jobId, "running", {
      lastError: null,
      runStartedAt: Date.now(),
    });
    revalidatePath(`/jobs/${jobId}`);
    return { ok: true, message: "Resumed", batchSize: job.batchSize, batchesTotal: job.batchesTotal };
  }

  if (opts.resetAnchors !== false) {
    await clearJobAnchors(jobId);
  }
  // Fresh start — clear any stale lease so the new orchestrator can claim immediately.
  await clearRunnerLease(jobId);
  await setJobStatus(jobId, "running", {
    lastError: null,
    batchSize: planned.batchSize,
    batchesTotal: planned.batchesTotal,
    runStartedAt: Date.now(),
    resetBatchesDone: true,
  });
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true, message: "Generation started", batchSize: planned.batchSize, batchesTotal: planned.batchesTotal };
}

export interface BatchResult {
  ok: boolean;
  message: string;
  rateLimited?: boolean;
  batchIndex: number;
  batchesDone: number;
  batchesTotal: number;
  status: "running" | "succeeded" | "failed" | "partial" | "cancelled" | "paused" | "lease_lost";
  anchorsAdded: number;
  rawSample?: string;
  /** When status==="lease_lost", who currently holds the lease and how stale they are. */
  currentRunnerId?: string | null;
  heartbeatAgeMs?: number | null;
}

export async function actionGenerateBatch(jobId: string, batchIndex: number, runnerId: string): Promise<BatchResult> {
  const settings = await loadSettings();
  const job = await getJob(jobId);
  if (!job) {
    return { ok: false, message: "Job not found", batchIndex, batchesDone: 0, batchesTotal: 0, status: "failed", anchorsAdded: 0 };
  }
  if (job.status === "cancelled") {
    return { ok: false, message: "Cancelled", batchIndex, batchesDone: job.batchesDone, batchesTotal: job.batchesTotal, status: "cancelled", anchorsAdded: 0 };
  }
  if (job.status === "paused") {
    return { ok: false, message: "Paused", batchIndex, batchesDone: job.batchesDone, batchesTotal: job.batchesTotal, status: "paused", anchorsAdded: 0 };
  }

  // Cross-host two-runner guard: try to claim/refresh the runner lease BEFORE doing any
  // expensive work (AI call, anchor insert). If another orchestrator currently holds a fresh
  // lease, bail out — the client will surface a "take over" banner.
  const lease = await claimOrRefreshRunnerLease(jobId, runnerId);
  if (!lease.ok) {
    return {
      ok: false,
      message: "Another runner is active",
      batchIndex,
      batchesDone: job.batchesDone,
      batchesTotal: job.batchesTotal,
      status: "lease_lost",
      anchorsAdded: 0,
      currentRunnerId: lease.currentRunnerId,
      heartbeatAgeMs: lease.heartbeatAgeMs,
    };
  }

  const inputs = job.inputs ?? [];
  const existing = job.anchors ?? [];

  const { inputsInBatch, hints } = planBatch({
    batchIndex,
    batchesTotal: job.batchesTotal || 1,
    batchSize: job.batchSize || 10,
    inputs,
    criteria: job.criteria,
    existingAnchors: existing,
  });

  if (inputsInBatch.length === 0) {
    // Already past last batch — mark succeeded.
    const status = existing.length > 0 ? "succeeded" : "failed";
    await setJobStatus(jobId, status, { lastError: status === "failed" ? "No batches produced anchors" : null });
    await releaseRunnerLease(jobId, runnerId);
    revalidatePath(`/jobs/${jobId}`);
    return { ok: true, message: "No more batches", batchIndex, batchesDone: job.batchesDone, batchesTotal: job.batchesTotal, status, anchorsAdded: 0 };
  }

  const prompt = composeGenerationPrompt({
    template: settings.prompts.generation,
    mode: job.mode,
    criteria: job.criteria,
    inputs: inputsInBatch,
    batch: hints,
  });

  let raw: string;
  try {
    raw = await callProvider({ providerId: job.criteria.providerId, model: job.criteria.model, prompt, settings });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const rateLimited = RATE_LIMIT_HINTS.test(message);
    if (!rateLimited) {
      // Persist the error and mark the job failed (or partial if we already produced anchors).
      const finalStatus = existing.length > 0 ? "partial" : "failed";
      await setJobStatus(jobId, finalStatus, { lastError: `Batch ${batchIndex + 1}/${job.batchesTotal}: ${message}` });
      await releaseRunnerLease(jobId, runnerId);
      revalidatePath(`/jobs/${jobId}`);
    }
    return { ok: false, message, rateLimited, batchIndex, batchesDone: job.batchesDone, batchesTotal: job.batchesTotal, status: rateLimited ? "running" : (existing.length > 0 ? "partial" : "failed"), anchorsAdded: 0 };
  }

  let parsed: ReturnType<typeof parseAnchorsResponse>;
  try {
    parsed = parseAnchorsResponse(raw);
  } catch (e) {
    const message = `Could not parse AI output: ${e instanceof Error ? e.message : String(e)}`;
    const finalStatus = existing.length > 0 ? "partial" : "failed";
    await setJobStatus(jobId, finalStatus, { lastError: `Batch ${batchIndex + 1}/${job.batchesTotal}: ${message}` });
    await releaseRunnerLease(jobId, runnerId);
    revalidatePath(`/jobs/${jobId}`);
    return { ok: false, message, batchIndex, batchesDone: job.batchesDone, batchesTotal: job.batchesTotal, status: finalStatus, anchorsAdded: 0, rawSample: raw.slice(0, 800) };
  }

  if (parsed.length === 0) {
    // Empty batch — count it as done so we don't loop forever, but flag a warning.
    await incrementBatchesDone(jobId);
    const isLast = batchIndex + 1 >= job.batchesTotal;
    const finalStatus = isLast ? (existing.length > 0 ? "partial" : "failed") : "running";
    if (isLast) {
      await setJobStatus(jobId, finalStatus, { lastError: "Last batch returned no anchors." });
      await releaseRunnerLease(jobId, runnerId);
    }
    revalidatePath(`/jobs/${jobId}`);
    return { ok: false, message: "AI returned no anchors for this batch", batchIndex, batchesDone: job.batchesDone + 1, batchesTotal: job.batchesTotal, status: finalStatus, anchorsAdded: 0, rawSample: raw.slice(0, 400) };
  }

  // Map parsed anchors back to inputs/brands. Only accept URLs that match an input in THIS batch
  // — otherwise we'd accept hallucinated URLs.
  const batchUrlSet = new Map(inputsInBatch.map((i) => [i.targetUrl.toLowerCase(), i]));
  const anchors = parsed
    .map((p) => {
      const matched = batchUrlSet.get(p.targetUrl.toLowerCase());
      if (!matched) return null;
      const brand = matchBrand(matched.targetUrl, job.criteria.brands);
      return {
        inputId: matched.id,
        targetUrl: matched.targetUrl,
        brandId: brand?.id ?? null,
        followStatus: job.criteria.ratiosEnabled ? (p.followStatus ?? "dofollow") : null,
        anchorText: p.anchorText,
        category: p.category,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  await appendJobAnchors(jobId, anchors);
  await incrementBatchesDone(jobId);

  const newBatchesDone = job.batchesDone + 1;
  const isLastBatch = newBatchesDone >= job.batchesTotal;
  if (isLastBatch) {
    await setJobStatus(jobId, "succeeded", { lastError: null });
    await releaseRunnerLease(jobId, runnerId);
  }
  revalidatePath(`/jobs/${jobId}`);

  return {
    ok: true,
    message: `Batch ${batchIndex + 1} added ${anchors.length} anchors`,
    batchIndex,
    batchesDone: newBatchesDone,
    batchesTotal: job.batchesTotal,
    status: isLastBatch ? "succeeded" : "running",
    anchorsAdded: anchors.length,
  };
}

export async function actionCancelGeneration(jobId: string): Promise<void> {
  const job = await getJob(jobId);
  if (!job) return;
  await setJobStatus(jobId, "cancelled", { lastError: null });
  await clearRunnerLease(jobId);
  revalidatePath(`/jobs/${jobId}`);
}

export async function actionPauseGeneration(jobId: string): Promise<void> {
  const job = await getJob(jobId);
  if (!job) return;
  await setJobStatus(jobId, "paused", { lastError: null });
  await clearRunnerLease(jobId);
  revalidatePath(`/jobs/${jobId}`);
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

    const inputByUrl = new Map(inputs.map((i) => [i.targetUrl.toLowerCase(), i]));
    const newAnchors = parsed
      .map((p) => {
        const matched = inputByUrl.get(p.targetUrl.toLowerCase());
        if (!matched) return null;
        const b = brands.find((x) => x.id === brandKey) ?? null;
        return {
          inputId: matched.id,
          targetUrl: matched.targetUrl,
          brandId: b?.id ?? null,
          followStatus: job.criteria.ratiosEnabled ? (p.followStatus ?? "dofollow") : null,
          anchorText: p.anchorText,
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

export interface JobStatusSnapshot {
  status: string;
  batchesDone: number;
  batchesTotal: number;
  lastError: string | null;
  anchorsCount: number;
}

export async function actionGetJobStatus(jobId: string): Promise<JobStatusSnapshot | null> {
  const job = await getJob(jobId);
  if (!job) return null;
  return {
    status: job.status,
    batchesDone: job.batchesDone,
    batchesTotal: job.batchesTotal,
    lastError: job.lastError,
    anchorsCount: (job.anchors ?? []).length,
  };
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
  return composeGenerationPrompt({
    template: settings.prompts.generation,
    mode: args.mode,
    criteria: args.criteria,
    inputs: args.inputs,
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
