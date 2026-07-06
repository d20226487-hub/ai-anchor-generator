"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { loadSettings, mergeIncomingSettings, redactSettings, saveSettings } from "./settings";
import {
  addJobCostAndTokens,
  appendJobAnchors,
  clearJobAnchors,
  clearRunnerLease,
  computeAiCost,
  createFolder,
  deleteModelPricing,
  listModelPricing,
  saveModelPricing,
  createJob,
  deleteJob,
  deleteJobs,
  forceClaimRunnerLease,
  getAnchorsByIds,
  getJob,
  getRunnerLease,
  moveFolder,
  moveJobsToFolder,
  purgeFolder,
  purgeJob,
  renameFolder,
  renameJob,
  replaceJobAnchors,
  resetJobCost,
  restoreFolder,
  restoreJob,
  setAnchorPayloads,
  setJobStatus,
  softDeleteFolder,
  updateAnchorFollow,
  updateAnchorText,
  updateAnchorsByMap,
  updateJob,
} from "./jobs";
import { isLoopRunning, runJobLoop, stopJobLoop } from "./jobLoop";
import { pingProvider, callProvider } from "./providers";
import { composeGenerationPrompt, composeGenerationPromptPirogi, composeGenerationPromptV2, composeRegenerationPrompt, composeRegenerationPromptPirogi, composeRegenerationPromptV2 } from "./anchors/compose";
import { planBatches, planBatchesPirogi, planBatchesV2, planBatchV2 } from "./anchors/batchPlan";
import { resolveProviderLimits } from "./providers/limits";
import { planRebalance, planRebalanceV2, type RebalanceMode } from "./anchors/rebalance";
import { brandKeyOf as brandKeyForAnchor, brandKeyOf, matchBrand } from "./anchors/brands";
import { db } from "./db";
import { parseAnchorsResponse, parseAnchorsResponseV2, parseRegenResponse } from "./anchors/parse";
import type { JobInput } from "./types";
import { quickFixDofollowRatio } from "./anchors/quickfix";
import type { Brand, JobCriteria, JobInputPayloadV2, JobMode, Locale, ModelPricing, ProviderId, SettingsBlob, Theme, JobAnchor } from "./types";
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
  /** Each input may carry a V2 payload. V1 inputs leave payloadV2 undefined. */
  inputs: Array<{ targetUrl: string; title: string | null; keywords: string | null; payloadV2?: JobInputPayloadV2 | null }>;
  /** Containing folder; null = root. */
  folderId?: string | null;
  /** Display-name attribution from the browser. The Settings modal blocks the UI until set. */
  createdBy?: string | null;
  /** Job version. 1 = legacy form-driven (default). 2 = V2 CSV per-row config. 3 = Пироги (deduped anchors with quantities). */
  version?: 1 | 2 | 3;
}

export async function actionCreateJob(args: CreateJobArgs): Promise<string> {
  const id = await createJob(args);
  revalidatePath("/");
  return id;
}

/**
 * Create a job, kick off generation, and redirect to the job page in ONE server round-trip.
 *
 * The server-side redirect() is the load-bearing fix for the "I clicked Generate, the job
 * ran in the background, but I was never sent to the progress page" bug. Calling
 * router.push() on the client immediately after an awaited action that ran revalidatePath()
 * races with the revalidation and is frequently swallowed by the App Router — so the user
 * sat on /jobs/new while the job silently completed. redirect() navigates reliably.
 *
 * A generation-start failure does NOT block the redirect: we still land on the job page,
 * which surfaces the error and offers Rerun/Resume. redirect() MUST stay outside the
 * try/catch (it throws NEXT_REDIRECT, which the framework needs to see).
 */
export async function actionCreateJobAndStart(args: CreateJobArgs): Promise<never> {
  const id = await createJob(args);
  revalidatePath("/");
  try {
    await actionStartGeneration(id);
  } catch (e) {
    console.error("[actionCreateJobAndStart] generation start failed:", e);
  }
  redirect(`/jobs/${id}`);
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
  /** V1 jobs use just targetUrl/title/keywords; V2 and Пироги carry per-row payloadV2. */
  inputs: Array<{ targetUrl: string; title: string | null; keywords: string | null; payloadV2?: JobInputPayloadV2 | null }>;
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

  // V1 chunks by INPUT count (10 rows/batch). V2 chunks by ANCHOR count — pack rows
  // (and split heavy rows) until each AI call asks for ~v2BatchTargetAnchors anchors.
  // Пироги (v3) chunks by INPUT count too, but ALWAYS one row per batch (the AI's job
  // per row is to produce a deduped list of unique anchors with quantities — bounded
  // and self-contained regardless of numberOfLinks).
  let planned;
  if (job.version === 3) {
    planned = planBatchesPirogi(inputs);
  } else if (job.version === 2) {
    const target = opts.batchInputSize
      ?? resolveProviderLimits(await loadSettings().then((s) => s.providers[job.criteria.providerId])).v2BatchTargetAnchors;
    planned = planBatchesV2(inputs, target);
  } else {
    planned = planBatches(job.criteria, inputs, opts.batchInputSize ?? 10);
  }

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
    // Anchors clear → reset cost. Drop Sherlock's lock-in semantics mean "this run's cost"
    // is the only thing we want to show after a rerun. Resume (which doesn't clear
    // anchors) keeps the existing cost intact and continues accumulating.
    await resetJobCost(jobId);
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
      const result = await callProvider({ providerId: job.criteria.providerId, model: job.criteria.model, prompt, settings });
      raw = result.text;
      // Rebalance is an AI call → spend tokens → lock in cost. Same pattern as the loop.
      const cost = await computeAiCost({
        providerId: job.criteria.providerId,
        model: job.criteria.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      });
      await addJobCostAndTokens(jobId, {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cachedInputTokens: result.usage.cachedInputTokens,
        costUsd: cost.costUsd,
      });
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

// =====================================================================
// V2 rebalance — per (Target URL, Link Type) (2026-05-24)
// =====================================================================

export interface RebalanceV2RowResult {
  ok: boolean;
  message: string;
  url: string;
  linkType: string;
  deleted: number;
  added: number;
  warnings: string[];
}

/**
 * Rebalance ONE (Target URL, Link Type) group on a V2 job. Manual edits preserved.
 * Two modes: 'surgical' trims surplus + tops up deficit; 'replace_ai' wipes all AI
 * anchors and regenerates to target. Sequential per-group is the caller's job — this
 * action handles just one group per call.
 */
export async function actionRebalanceV2Row(
  jobId: string,
  url: string,
  linkType: string,
  opts: { mode: RebalanceMode }
): Promise<RebalanceV2RowResult> {
  const settings = await loadSettings();
  const job = await getJob(jobId);
  if (!job) return { ok: false, message: "Job not found", url, linkType, deleted: 0, added: 0, warnings: [] };
  if (job.version !== 2) return { ok: false, message: "Job is not V2", url, linkType, deleted: 0, added: 0, warnings: [] };

  const rowAnchors = (job.anchors ?? []).filter((a) => a.targetUrl === url && (a.payloadV2?.linkType ?? "") === linkType);
  const rowInputs = (job.inputs ?? []).filter((i) => i.targetUrl === url && i.payloadV2?.linkType === linkType);
  if (rowInputs.length === 0) {
    return { ok: false, message: `No V2 input for ${url} / ${linkType}`, url, linkType, deleted: 0, added: 0, warnings: [] };
  }

  // Normalize rowInputs so the planner sees non-null payloadV2.
  const inputsForPlan = rowInputs
    .filter((i) => i.payloadV2 != null)
    .map((i) => ({ id: i.id, payloadV2: i.payloadV2! }));

  const plan = planRebalanceV2({ rowAnchors, rowInputs: inputsForPlan, mode: opts.mode });
  if (plan.generate.total === 0 && plan.deleteIds.length === 0) {
    return { ok: true, message: "Row is already on target — nothing to do.", url, linkType, deleted: 0, added: 0, warnings: plan.warnings };
  }

  let added = 0;
  if (plan.generate.total > 0) {
    // Build a single V2BatchEntry that asks the AI for the deficit. The entry's input
    // id is reused from the row's first input, so produced anchors map back via the
    // existing byId lookup pattern. exactCounts comes from the planner.
    const ownerInput = rowInputs[0];
    if (!ownerInput.payloadV2) {
      return { ok: false, message: "Owner input is missing V2 payload", url, linkType, deleted: 0, added: 0, warnings: plan.warnings };
    }
    const entry = {
      input: ownerInput,
      // Rebalance is per (URL, Link Type) and doesn't language-split: keep the bare input
      // id (so the `p.id === ownerId` filter below still matches) and let compose fall
      // back to the input's raw lang string.
      lang: "",
      promptId: ownerInput.id,
      exactCounts: plan.generate.perCategory,
    };
    const prompt = composeGenerationPromptV2({
      template: settings.prompts.v2.generation,
      entries: [entry],
      siteDescription: job.criteria.siteDescription,
    });

    let raw: string;
    let usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number };
    try {
      const result = await callProvider({ providerId: job.criteria.providerId, model: job.criteria.model, prompt, settings });
      raw = result.text;
      usage = result.usage;
      // Lock in cost — same write-time pattern as the main loop.
      const cost = await computeAiCost({
        providerId: job.criteria.providerId,
        model: job.criteria.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      });
      await addJobCostAndTokens(jobId, {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        costUsd: cost.costUsd,
      });
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e), url, linkType, deleted: 0, added: 0, warnings: plan.warnings };
    }

    let parsed: ReturnType<typeof parseAnchorsResponseV2>;
    try {
      parsed = parseAnchorsResponseV2(raw);
    } catch (e) {
      return {
        ok: false,
        message: `Could not parse AI output: ${e instanceof Error ? e.message : String(e)}`,
        url, linkType, deleted: 0, added: 0, warnings: plan.warnings,
      };
    }
    if (parsed.length === 0) {
      return { ok: false, message: "AI returned no anchors", url, linkType, deleted: 0, added: 0, warnings: plan.warnings };
    }

    // Map back by id — all parsed anchors should carry the owner's input id since we sent
    // only one entry. If the AI hallucinates other ids we drop them.
    const ownerId = ownerInput.id;
    const newAnchors = parsed
      .filter((p) => p.id === ownerId)
      .map((p) => {
        const payload = ownerInput.payloadV2!;
        // url-category force: anchorText = exact Target URL, same defensive rule as
        // initial generation in processBatchV2.
        const anchorText = p.category === "url" ? ownerInput.targetUrl : p.anchorText;
        return {
          inputId: ownerId,
          targetUrl: ownerInput.targetUrl,
          brandId: null,
          followStatus: null,
          anchorText,
          category: p.category,
          payloadV2: {
            linkType: p.linkType || payload.linkType,
            geo: p.geo || payload.geo,
            lang: p.lang || payload.lang,
          },
        };
      });

    // Apply DB changes: delete plan first, then insert.
    if (plan.deleteIds.length > 0) await deleteAnchorsByIds(plan.deleteIds);
    await appendJobAnchors(jobId, newAnchors);
    added = newAnchors.length;
  } else if (plan.deleteIds.length > 0) {
    // Surgical case where the row is over-saturated and only needs trimming.
    await deleteAnchorsByIds(plan.deleteIds);
  }

  revalidatePath(`/jobs/${jobId}`);
  return {
    ok: true,
    message: `Rebalanced ${url} / ${linkType}: deleted ${plan.deleteIds.length}, added ${added}.`,
    url, linkType,
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
    const result = await callProvider({ providerId: job.criteria.providerId, model: job.criteria.model, prompt, settings });
    raw = result.text;
    const cost = await computeAiCost({
      providerId: job.criteria.providerId,
      model: job.criteria.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    });
    await addJobCostAndTokens(jobId, {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cachedInputTokens: result.usage.cachedInputTokens,
      costUsd: cost.costUsd,
    });
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }

  const parsed = parseRegenResponse(raw);
  if (parsed.length === 0) return { ok: false, message: "AI returned no replacements" };

  await updateAnchorsByMap(jobId, parsed.map((p) => ({ id: p.id, anchorText: p.anchorText })));
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true, message: `Regenerated ${parsed.length} anchors.` };
}

/**
 * V2 regenerate. Skips url-category anchors entirely — they're locked to the input's
 * exact Target URL by design, so sending them through the AI is pure token waste (the
 * result would just be the same Target URL). Returns counts for both the regenerated
 * and the skipped buckets so the UI can be honest.
 */
export async function actionRegenerateV2(
  jobId: string,
  anchorIds: string[]
): Promise<{ ok: boolean; message: string; regenerated: number; skippedUrl: number }> {
  if (anchorIds.length === 0) return { ok: false, message: "No anchors selected", regenerated: 0, skippedUrl: 0 };
  const settings = await loadSettings();
  const job = await getJob(jobId);
  if (!job) return { ok: false, message: "Job not found", regenerated: 0, skippedUrl: 0 };
  if (job.version !== 2) return { ok: false, message: "Job is not V2", regenerated: 0, skippedUrl: 0 };

  const targets: JobAnchor[] = (job.anchors ?? []).filter((a) => anchorIds.includes(a.id));
  if (targets.length === 0) return { ok: false, message: "Selected anchors not found", regenerated: 0, skippedUrl: 0 };

  // Skip url-category anchors. They're already locked to the Target URL by the server-
  // side enforcement in jobLoop.processBatchV2 — sending them to the AI would just spend
  // tokens to produce the same string.
  const aiTargets = targets.filter((a) => a.category !== "url");
  const skippedUrl = targets.length - aiTargets.length;

  if (aiTargets.length === 0) {
    return { ok: true, message: `All ${skippedUrl} selected anchors are URL-category — nothing to regenerate (they always equal the Target URL).`, regenerated: 0, skippedUrl };
  }

  // Each anchor must carry its V2 payload so the prompt can echo linkType/geo/lang.
  // Fall back to empty payload strings if somehow a legacy row sneaks in (gated on
  // job.version above, but be defensive).
  const promptInputs = aiTargets.map((a) => ({
    id: a.id,
    targetUrl: a.targetUrl,
    category: a.category,
    anchorText: a.anchorText,
    payloadV2: a.payloadV2 ?? { linkType: "", geo: "", lang: "" },
  }));

  const prompt = composeRegenerationPromptV2({
    template: settings.prompts.v2.regeneration,
    anchors: promptInputs,
    siteDescription: job.criteria.siteDescription,
  });

  let raw: string;
  try {
    const result = await callProvider({ providerId: job.criteria.providerId, model: job.criteria.model, prompt, settings });
    raw = result.text;
    const cost = await computeAiCost({
      providerId: job.criteria.providerId,
      model: job.criteria.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    });
    await addJobCostAndTokens(jobId, {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cachedInputTokens: result.usage.cachedInputTokens,
      costUsd: cost.costUsd,
    });
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e), regenerated: 0, skippedUrl };
  }

  const parsed = parseRegenResponse(raw);
  if (parsed.length === 0) return { ok: false, message: "AI returned no replacements", regenerated: 0, skippedUrl };

  // Only accept replacements for ids that were actually in our AI-targets set — protects
  // against the AI hallucinating ids and stomping unrelated anchors.
  const targetIds = new Set(aiTargets.map((a) => a.id));
  const updates = parsed.filter((p) => targetIds.has(p.id)).map((p) => ({ id: p.id, anchorText: p.anchorText }));

  await updateAnchorsByMap(jobId, updates);
  revalidatePath(`/jobs/${jobId}`);

  const msgParts = [`Regenerated ${updates.length} anchor(s).`];
  if (skippedUrl > 0) msgParts.push(`${skippedUrl} URL-category anchor(s) skipped (always equal to Target URL).`);
  return { ok: true, message: msgParts.join(" "), regenerated: updates.length, skippedUrl };
}

// ----- Пироги quantity reconcile -----

export interface ReconcilePirogiResult {
  ok: boolean;
  message: string;
  /** Input rows whose anchors had their quantities adjusted. */
  rowsReconciled: number;
  /** Total link count (sum of quantities) before and after. */
  before: number;
  after: number;
  /** Sum of numberOfLinks across all input rows — the target the export should hit. */
  requested: number;
  /** Rows that produced ZERO anchors during generation and so can't be reconciled
   *  (nothing to split onto). These keep the total below `requested`. */
  rowsWithNoAnchors: number;
}

/**
 * Even out Пироги anchor quantities per input row. For each row (a page + Link Type +
 * language + GEO), split its `numberOfLinks` EVENLY across the row's unique anchors
 * (largest-remainder for the leftover), so every row sums to exactly numberOfLinks and
 * each anchor is used an equal number of times. Link types stay separate. Only the
 * per-anchor `quantity` changes — anchor text / category / rows are untouched.
 *
 * Fixes the "export total < requested" gap that happens when the AI returns quantities
 * summing to less than numberOfLinks. Rows that generated NO anchors can't be topped up
 * (nothing to split onto) — those are reported via rowsWithNoAnchors.
 */
export async function actionReconcilePirogiQuantities(jobId: string): Promise<ReconcilePirogiResult> {
  const empty = { rowsReconciled: 0, before: 0, after: 0, requested: 0, rowsWithNoAnchors: 0 };
  const job = await getJob(jobId);
  if (!job) return { ok: false, message: "Job not found", ...empty };
  if (job.version !== 3) return { ok: false, message: "Job is not Пироги (v3)", ...empty };

  const inputs = job.inputs ?? [];
  const anchors = job.anchors ?? [];

  // Group anchors by their input row.
  const byInput = new Map<string, JobAnchor[]>();
  for (const a of anchors) {
    if (!a.inputId) continue;
    if (!byInput.has(a.inputId)) byInput.set(a.inputId, []);
    byInput.get(a.inputId)!.push(a);
  }

  const nById = new Map<string, number>();
  let requested = 0;
  for (const i of inputs) {
    if (!i.payloadV2) continue;
    nById.set(i.id, i.payloadV2.numberOfLinks);
    requested += i.payloadV2.numberOfLinks;
  }

  let before = 0;
  let after = 0;
  let rowsReconciled = 0;
  let rowsWithNoAnchors = 0;
  const updates: Array<{ id: string; payloadV2: JobAnchor["payloadV2"] }> = [];

  for (const i of inputs) {
    const list = byInput.get(i.id) ?? [];
    const K = list.length;
    const T = nById.get(i.id) ?? list.reduce((s, a) => s + (a.payloadV2?.quantity ?? 1), 0);
    if (K === 0) { if (T > 0) rowsWithNoAnchors++; continue; }

    const rowBefore = list.reduce((s, a) => s + (a.payloadV2?.quantity ?? 1), 0);
    before += rowBefore;

    // Even split of T across K anchors (largest-remainder): first `rem` get base+1.
    const base = Math.floor(T / K);
    const rem = T - base * K;
    let changed = false;
    for (let idx = 0; idx < K; idx++) {
      const a = list[idx];
      let nq = base + (idx < rem ? 1 : 0);
      if (nq === 0) nq = 1; // T < K edge: keep every anchor (accepts a tiny overage)
      after += nq;
      const prev = a.payloadV2?.quantity ?? 1;
      if (nq !== prev) {
        changed = true;
        const basePayload = a.payloadV2 ?? { linkType: "", geo: "", lang: "" };
        updates.push({ id: a.id, payloadV2: { ...basePayload, quantity: nq } });
      }
    }
    if (changed) rowsReconciled++;
  }

  await setAnchorPayloads(jobId, updates.filter((u) => u.payloadV2 != null) as Array<{ id: string; payloadV2: NonNullable<JobAnchor["payloadV2"]> }>);
  revalidatePath(`/jobs/${jobId}`);

  const parts = [`Evened out quantities on ${rowsReconciled} row(s). Total is now ${after} of ${requested} requested.`];
  if (rowsWithNoAnchors > 0) parts.push(`${rowsWithNoAnchors} row(s) generated no anchors and can't be filled — rerun/resume the job to produce them.`);
  return { ok: true, message: parts.join(" "), rowsReconciled, before, after, requested, rowsWithNoAnchors };
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

/** V2 preview — composes the V2 prompt for the FIRST batch of the given inputs, using
 *  the provider's configured target. Shows the user what the AI will actually see on
 *  batch 1 (including how rows pack and how heavy rows split). */
export async function actionPreviewPromptV2(args: {
  inputs: Array<{ targetUrl: string; payloadV2: JobInputPayloadV2 }>;
  providerId?: ProviderId;
  siteDescription?: string | null;
}): Promise<string> {
  const settings = await loadSettings();
  // Synthetic ids so the prompt looks representative without touching the DB.
  const inputsWithIds = args.inputs.map((i, idx) => ({
    id: `preview_${idx + 1}`,
    jobId: "preview",
    targetUrl: i.targetUrl,
    title: null,
    keywords: null,
    payloadV2: i.payloadV2,
  }));
  // Use the provider's effective target so preview matches what the loop will do.
  const providerId = args.providerId ?? settings.defaults.providerId;
  const limits = resolveProviderLimits(settings.providers[providerId]);
  const entries = planBatchV2({ batchIndex: 0, inputs: inputsWithIds, targetAnchorsPerBatch: limits.v2BatchTargetAnchors });
  return composeGenerationPromptV2({ template: settings.prompts.v2.generation, entries, siteDescription: args.siteDescription });
}

/**
 * Пироги preview — composes the prompt for the FIRST input row of the given set.
 * The Пироги planner always batches one row per AI call, so showing the first row's
 * prompt is exactly what the live AI call will see for batch 0.
 */
export async function actionPreviewPromptPirogi(args: {
  inputs: Array<{ targetUrl: string; payloadV2: JobInputPayloadV2 }>;
  siteDescription?: string | null;
}): Promise<string> {
  const settings = await loadSettings();
  if (args.inputs.length === 0) {
    return composeGenerationPromptPirogi({
      template: settings.prompts.pirogi.generation,
      entries: [],
      siteDescription: args.siteDescription,
    });
  }
  // Preview the first row only — mirrors the planner's one-row-per-batch behaviour.
  const first = args.inputs[0];
  const entry: JobInput = {
    id: "preview_1",
    jobId: "preview",
    targetUrl: first.targetUrl,
    title: null,
    keywords: null,
    payloadV2: first.payloadV2,
  };
  return composeGenerationPromptPirogi({
    template: settings.prompts.pirogi.generation,
    entries: [entry],
    siteDescription: args.siteDescription,
  });
}

/**
 * Пироги regenerate — rewrites the anchorText of selected anchors, keeping their
 * quantity, category, linkType, geo, lang, and Keyword Group intact (group is
 * recomputed at export time based on case-insensitive anchor text, so the AI's
 * new text will naturally join a new or existing group). url-category anchors are
 * skipped (they're locked to the Target URL by design).
 */
export async function actionRegeneratePirogi(
  jobId: string,
  anchorIds: string[]
): Promise<{ ok: boolean; message: string; regenerated: number; skippedUrl: number }> {
  if (anchorIds.length === 0) return { ok: false, message: "No anchors selected", regenerated: 0, skippedUrl: 0 };
  const settings = await loadSettings();
  const job = await getJob(jobId);
  if (!job) return { ok: false, message: "Job not found", regenerated: 0, skippedUrl: 0 };
  if (job.version !== 3) return { ok: false, message: "Job is not Пироги (v3)", regenerated: 0, skippedUrl: 0 };

  const targets: JobAnchor[] = (job.anchors ?? []).filter((a) => anchorIds.includes(a.id));
  if (targets.length === 0) return { ok: false, message: "Selected anchors not found", regenerated: 0, skippedUrl: 0 };

  const aiTargets = targets.filter((a) => a.category !== "url");
  const skippedUrl = targets.length - aiTargets.length;
  if (aiTargets.length === 0) {
    return { ok: true, message: `All ${skippedUrl} selected anchors are URL-category — nothing to regenerate.`, regenerated: 0, skippedUrl };
  }

  const promptInputs = aiTargets.map((a) => ({
    id: a.id,
    targetUrl: a.targetUrl,
    category: a.category,
    anchorText: a.anchorText,
    payloadV2: a.payloadV2 ?? { linkType: "", geo: "", lang: "" },
  }));

  const prompt = composeRegenerationPromptPirogi({
    template: settings.prompts.pirogi.regeneration,
    anchors: promptInputs,
    siteDescription: job.criteria.siteDescription,
  });

  let raw: string;
  try {
    const result = await callProvider({ providerId: job.criteria.providerId, model: job.criteria.model, prompt, settings });
    raw = result.text;
    const cost = await computeAiCost({
      providerId: job.criteria.providerId,
      model: job.criteria.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    });
    await addJobCostAndTokens(jobId, {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cachedInputTokens: result.usage.cachedInputTokens,
      costUsd: cost.costUsd,
    });
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e), regenerated: 0, skippedUrl };
  }

  const parsed = parseRegenResponse(raw);
  if (parsed.length === 0) return { ok: false, message: "AI returned no replacements", regenerated: 0, skippedUrl };

  const targetIds = new Set(aiTargets.map((a) => a.id));
  const updates = parsed.filter((p) => targetIds.has(p.id)).map((p) => ({ id: p.id, anchorText: p.anchorText }));

  await updateAnchorsByMap(jobId, updates);
  revalidatePath(`/jobs/${jobId}`);

  const msgParts = [`Regenerated ${updates.length} anchor(s).`];
  if (skippedUrl > 0) msgParts.push(`${skippedUrl} URL-category anchor(s) skipped.`);
  return { ok: true, message: msgParts.join(" "), regenerated: updates.length, skippedUrl };
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

// ----- Folders & trash (2026-05-24) -----
//
// Display-name attribution: the client passes `createdBy` explicitly because server
// actions can't read localStorage. The DisplayNameProvider gates the UI on first
// visit so null shouldn't reach these actions in practice — but we accept null
// (renders as "Unknown") so a broken localStorage doesn't lock the whole feature.

export async function actionCreateFolder(args: { name: string; parentId: string | null }): Promise<{ ok: boolean; id?: string; message?: string }> {
  const name = (args.name ?? "").trim();
  if (name.length === 0) return { ok: false, message: "Folder name cannot be empty." };
  if (name.length > 80) return { ok: false, message: "Folder name is too long (max 80 characters)." };
  const id = await createFolder({ name, parentId: args.parentId });
  revalidatePath("/");
  return { ok: true, id };
}

export async function actionRenameFolder(id: string, name: string): Promise<{ ok: boolean; message?: string }> {
  const trimmed = (name ?? "").trim();
  if (trimmed.length === 0) return { ok: false, message: "Folder name cannot be empty." };
  if (trimmed.length > 80) return { ok: false, message: "Folder name is too long (max 80 characters)." };
  await renameFolder(id, trimmed);
  revalidatePath("/");
  return { ok: true };
}

export async function actionMoveFolder(id: string, newParentId: string | null): Promise<{ ok: boolean; message?: string }> {
  const r = await moveFolder(id, newParentId);
  if (r.ok) revalidatePath("/");
  return r;
}

export async function actionDeleteFolder(id: string): Promise<void> {
  await softDeleteFolder(id);
  revalidatePath("/");
}

export async function actionMoveJobs(jobIds: string[], folderId: string | null): Promise<{ ok: boolean; moved: number }> {
  if (jobIds.length === 0) return { ok: false, moved: 0 };
  const moved = await moveJobsToFolder(jobIds, folderId);
  revalidatePath("/");
  return { ok: true, moved };
}

// ----- Trash -----

export async function actionRestoreFolder(id: string): Promise<void> {
  await restoreFolder(id);
  revalidatePath("/");
  revalidatePath("/trash");
}

export async function actionRestoreJob(id: string): Promise<void> {
  await restoreJob(id);
  revalidatePath("/");
  revalidatePath("/trash");
}

export async function actionPurgeFolder(id: string): Promise<void> {
  await purgeFolder(id);
  revalidatePath("/trash");
}

export async function actionPurgeJob(id: string): Promise<void> {
  await purgeJob(id);
  revalidatePath("/trash");
}

/**
 * Hard-delete everything currently in the trash (folders AND jobs). Irreversible.
 * Jobs are wiped first because they may live inside trashed folders; deleting jobs
 * cascades to job_inputs and job_anchors via the existing FK ON DELETE CASCADE.
 * Returns the count of rows removed from each table so the UI can summarise.
 */
export async function actionEmptyTrash(): Promise<{ ok: boolean; folders: number; jobs: number }> {
  const c = await db();
  const jobsR = await c.execute("DELETE FROM jobs WHERE deleted_at IS NOT NULL");
  const foldersR = await c.execute("DELETE FROM folders WHERE deleted_at IS NOT NULL");
  revalidatePath("/trash");
  return {
    ok: true,
    jobs: Number(jobsR.rowsAffected ?? 0),
    folders: Number(foldersR.rowsAffected ?? 0),
  };
}

// ----- Model pricing (2026-05-24) -----

export async function actionListModelPricing(): Promise<ModelPricing[]> {
  return listModelPricing();
}

export async function actionSaveModelPricing(p: Omit<ModelPricing, "updatedAt">): Promise<{ ok: boolean; message?: string }> {
  if (!p.model || !p.model.trim()) return { ok: false, message: "Model name required" };
  if (!Number.isFinite(p.inputPerMillion) || p.inputPerMillion < 0) return { ok: false, message: "Input rate must be >= 0" };
  if (!Number.isFinite(p.outputPerMillion) || p.outputPerMillion < 0) return { ok: false, message: "Output rate must be >= 0" };
  await saveModelPricing({ ...p, model: p.model.trim() });
  revalidatePath("/settings");
  return { ok: true };
}

export async function actionDeleteModelPricing(providerId: ProviderId, model: string): Promise<void> {
  await deleteModelPricing(providerId, model);
  revalidatePath("/settings");
}
