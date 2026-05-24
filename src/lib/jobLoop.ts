// Server-side background generation loop.
//
// Runs IN-PROCESS in the Next.js server. Each running job has one async loop fetching
// batches from the AI provider, persisting anchors, advancing batches_done. The browser
// is a passive viewer: it polls actionGetJobStatus to refresh progress, and clicking
// Pause/Cancel from the UI calls stopJobLoop to abort this loop.
//
// Trade-off: in-flight loops die on server restart (deploy / reboot). Job state in DB
// (status, batches_done, anchors) survives. The user clicks Resume to start a new loop.
// We do NOT auto-resume on startup (intentional: avoids restart-crash-restart loops).

import { loadSettings } from "./settings";
import {
  addJobCostAndTokens,
  appendJobAnchors,
  claimOrRefreshRunnerLease,
  computeAiCost,
  getJob,
  incrementBatchesDone,
  releaseRunnerLease,
  setJobStatus,
} from "./jobs";
import { callProvider } from "./providers";
import { composeGenerationPrompt, composeGenerationPromptV2 } from "./anchors/compose";
import { planBatch, planBatchV2 } from "./anchors/batchPlan";
import { matchBrand } from "./anchors/brands";
import { parseAnchorsResponse, parseAnchorsResponseV2 } from "./anchors/parse";
import { resolveProviderLimits } from "./providers/limits";

const RATE_LIMIT_HINTS = /rate|429|too many requests|quota/i;

// One AbortController per running job. Used by stopJobLoop to signal the loop to exit
// at the next batch boundary. The current in-flight AI call is NOT aborted — we let it
// finish so anchors are saved and we don't waste the API call.
const RUNNING: Map<string, AbortController> = new Map();

/** True if a server-side loop is currently running for this job. */
export function isLoopRunning(jobId: string): boolean {
  return RUNNING.has(jobId);
}

/**
 * Kick off the background loop for a job. Idempotent: if a loop is already running for
 * this jobId, this is a no-op. Returns immediately — the loop runs in the background.
 *
 * The caller is responsible for setting status='running' and any setup (clearing anchors,
 * planning batches) BEFORE invoking this.
 */
export function runJobLoop(jobId: string): void {
  if (RUNNING.has(jobId)) return;
  const ac = new AbortController();
  RUNNING.set(jobId, ac);
  // Fire and forget. We never await this. The .catch protects the process from unhandled
  // rejections; the loop body has its own try/catch and writes errors to job.lastError.
  void runLoop(jobId, ac).catch((err) => {
    console.error(`[jobLoop ${jobId}] crashed:`, err);
  }).finally(() => {
    RUNNING.delete(jobId);
  });
}

/**
 * Signal the loop to stop. Returns immediately. The loop will exit at the next batch
 * boundary; the in-flight batch (if any) finishes and its result is saved.
 *
 * Safe to call even if no loop is running.
 */
export function stopJobLoop(jobId: string): void {
  const ac = RUNNING.get(jobId);
  if (!ac) return;
  ac.abort();
  RUNNING.delete(jobId);
}

async function runLoop(jobId: string, ac: AbortController): Promise<void> {
  // Stable runnerId for this loop's lifetime. Used as the lease holder.
  const runnerId = `server_${crypto.randomUUID()}`;
  let rateLimitBackoffMs = 0;
  let consecutiveRateLimits = 0;

  while (!ac.signal.aborted) {
    // Re-read job at the top of every batch — status / batches_done / criteria may have
    // been updated since the last iteration (pause from another action, etc.).
    const job = await getJob(jobId);
    if (!job) return;
    if (job.status !== "running") return;
    if (job.batchesDone >= job.batchesTotal) {
      // Already done somehow — make sure status reflects it.
      if (job.batchesTotal > 0 && (job.anchors?.length ?? 0) > 0) {
        await setJobStatus(jobId, "succeeded", { lastError: null });
      }
      await releaseRunnerLease(jobId, runnerId);
      return;
    }

    // Effective per-provider limits — re-resolved each iteration so a settings change
    // mid-run takes effect at the next batch boundary without restarting the loop.
    const settings = await loadSettings();
    const limits = resolveProviderLimits(settings.providers[job.criteria.providerId]);

    // V1 and V2 share the orchestration loop (status / rate-limit retry / lease) but
    // diverge in how a single batch is composed/parsed and what data is persisted.
    const result = job.version === 2
      ? await processBatchV2(jobId, job.batchesDone, runnerId)
      : await processBatch(jobId, job.batchesDone, runnerId);

    if (ac.signal.aborted) return;

    // Lease lost — another runner has taken over (or someone forced clearance).
    if (result.kind === "lease_lost") return;

    // Terminal status — loop exits.
    if (result.kind === "succeeded" || result.kind === "failed" || result.kind === "partial" || result.kind === "cancelled" || result.kind === "paused") {
      return;
    }

    if (result.kind === "rate_limited") {
      consecutiveRateLimits++;
      // Give up after the per-provider cap — flip to partial/failed so the user sees a
      // real terminal state instead of an invisible infinite retry loop.
      if (consecutiveRateLimits >= limits.maxRateRetries) {
        const anchorsCount = job.anchors?.length ?? 0;
        const finalStatus = anchorsCount > 0 ? "partial" : "failed";
        await setJobStatus(jobId, finalStatus, {
          lastError: `Provider rate-limited ${limits.maxRateRetries} times in a row (giving up). Last message: ${result.message}`,
        });
        await releaseRunnerLease(jobId, runnerId);
        return;
      }
      rateLimitBackoffMs = Math.min(30_000, rateLimitBackoffMs ? rateLimitBackoffMs * 2 : 3_000);
      await sleep(rateLimitBackoffMs, ac.signal);
      continue;
    }

    // Successful batch — pause to be polite to the provider, then continue.
    consecutiveRateLimits = 0;
    rateLimitBackoffMs = 0;
    await sleep(limits.interBatchDelayMs, ac.signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const id = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(id); resolve(); }, { once: true });
  });
}

// ----- processBatch (extracted from the old actionGenerateBatch) -----

export type BatchKind =
  | "running" | "succeeded" | "failed" | "partial" | "cancelled" | "paused"
  | "lease_lost" | "rate_limited";

export interface ProcessBatchResult {
  kind: BatchKind;
  message: string;
  anchorsAdded: number;
}

/**
 * Process ONE batch: claim lease, plan batch inputs, call AI, parse + persist anchors,
 * advance batches_done, set terminal status if done. Releases lease on terminal kinds.
 *
 * Does NOT call revalidatePath (no request context inside the loop). The browser polls
 * actionGetJobStatus for live updates.
 */
export async function processBatch(jobId: string, batchIndex: number, runnerId: string): Promise<ProcessBatchResult> {
  const settings = await loadSettings();
  const job = await getJob(jobId);
  if (!job) return { kind: "failed", message: "Job not found", anchorsAdded: 0 };
  if (job.status === "cancelled") return { kind: "cancelled", message: "Cancelled", anchorsAdded: 0 };
  if (job.status === "paused") return { kind: "paused", message: "Paused", anchorsAdded: 0 };

  // Cross-runner guard. With server-side loops in a single process this is mostly
  // belt-and-suspenders (RUNNING map already prevents duplicates locally) but the lease
  // also covers transient deploy windows where the old process is still up.
  const lease = await claimOrRefreshRunnerLease(jobId, runnerId);
  if (!lease.ok) {
    return { kind: "lease_lost", message: `Lease held by ${lease.currentRunnerId} (${lease.heartbeatAgeMs}ms ago)`, anchorsAdded: 0 };
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
    const status = existing.length > 0 ? "succeeded" : "failed";
    await setJobStatus(jobId, status, { lastError: status === "failed" ? "No batches produced anchors" : null });
    await releaseRunnerLease(jobId, runnerId);
    return { kind: status, message: "No more batches", anchorsAdded: 0 };
  }

  const prompt = composeGenerationPrompt({
    template: settings.prompts.generation,
    mode: job.mode, criteria: job.criteria, inputs: inputsInBatch, batch: hints,
  });

  let raw: string;
  let usage: import("./types").ProviderUsage;
  try {
    const result = await callProvider({ providerId: job.criteria.providerId, model: job.criteria.model, prompt, settings });
    raw = result.text;
    usage = result.usage;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (RATE_LIMIT_HINTS.test(message)) {
      // Surface the rate-limit reason to the UI even though the loop will retry. Without
      // this `lastError` stays null and the user sees "running, no progress" with no clue
      // why. Status stays "running" so the loop keeps the lease and continues retrying.
      await setJobStatus(jobId, "running", {
        lastError: `Rate-limited at batch ${batchIndex + 1}/${job.batchesTotal}: ${message}. Retrying with backoff…`,
      });
      return { kind: "rate_limited", message, anchorsAdded: 0 };
    }
    const finalStatus = existing.length > 0 ? "partial" : "failed";
    await setJobStatus(jobId, finalStatus, { lastError: `Batch ${batchIndex + 1}/${job.batchesTotal}: ${message}` });
    await releaseRunnerLease(jobId, runnerId);
    return { kind: finalStatus, message, anchorsAdded: 0 };
  }

  // Lock in cost for this batch against the pricing row that exists RIGHT NOW. Even if
  // the AI output is unparseable, we still spent the tokens — record them so the job's
  // cost reflects real spend. (Drop Sherlock follows the same write-time lock-in pattern.)
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

  let parsed: ReturnType<typeof parseAnchorsResponse>;
  try {
    parsed = parseAnchorsResponse(raw);
  } catch (e) {
    const message = `Could not parse AI output: ${e instanceof Error ? e.message : String(e)}`;
    const finalStatus = existing.length > 0 ? "partial" : "failed";
    await setJobStatus(jobId, finalStatus, { lastError: `Batch ${batchIndex + 1}/${job.batchesTotal}: ${message}` });
    await releaseRunnerLease(jobId, runnerId);
    return { kind: finalStatus, message, anchorsAdded: 0 };
  }

  if (parsed.length === 0) {
    await incrementBatchesDone(jobId);
    const isLast = batchIndex + 1 >= job.batchesTotal;
    if (isLast) {
      const finalStatus = existing.length > 0 ? "partial" : "failed";
      await setJobStatus(jobId, finalStatus, { lastError: "Last batch returned no anchors." });
      await releaseRunnerLease(jobId, runnerId);
      return { kind: finalStatus, message: "Empty last batch", anchorsAdded: 0 };
    }
    return { kind: "running", message: "Empty batch (continuing)", anchorsAdded: 0 };
  }

  // Map parsed anchors back to inputs. PRIMARY key = input id (echoed by AI) —
  // this is collision-free even when many inputs share the same Target URL.
  // FALLBACK = URL match (legacy responses that miss the id field). The URL fallback
  // is only safe when its matches are unique within the batch — we filter out URLs
  // that appear on >1 input to avoid the dedup bug.
  const batchById = new Map(inputsInBatch.map((i) => [i.id, i]));
  const urlOccurrences = new Map<string, number>();
  for (const i of inputsInBatch) {
    const k = i.targetUrl.toLowerCase();
    urlOccurrences.set(k, (urlOccurrences.get(k) ?? 0) + 1);
  }
  const uniqueUrlMap = new Map<string, typeof inputsInBatch[number]>();
  for (const i of inputsInBatch) {
    const k = i.targetUrl.toLowerCase();
    if (urlOccurrences.get(k) === 1) uniqueUrlMap.set(k, i);
  }
  const anchors = parsed
    .map((p) => {
      // `||` (not `??`) so empty-string id falls through to URL fallback —
      // `??` only triggers on null/undefined, leaving empty strings as final values.
      const matched = (p.id ? batchById.get(p.id) : undefined)
        || (p.targetUrl ? uniqueUrlMap.get(p.targetUrl.toLowerCase()) : undefined)
        || null;
      if (!matched) return null;
      const brand = matchBrand(matched.targetUrl, job.criteria.brands);
      // For URL-category anchors, force anchorText to the matched input's URL.
      // (The AI sometimes drops the scheme or paraphrases.)
      const anchorText = p.category === "url" ? matched.targetUrl : p.anchorText;
      return {
        inputId: matched.id, targetUrl: matched.targetUrl, brandId: brand?.id ?? null,
        followStatus: job.criteria.ratiosEnabled ? (p.followStatus ?? "dofollow") : null,
        anchorText, category: p.category,
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
    return { kind: "succeeded", message: `Batch ${batchIndex + 1} added ${anchors.length} anchors`, anchorsAdded: anchors.length };
  }
  return { kind: "running", message: `Batch ${batchIndex + 1} added ${anchors.length} anchors`, anchorsAdded: anchors.length };
}

// =====================================================================
// V2 batch processor (2026-05-24)
// Same orchestration contract as processBatch (same BatchKind/ProcessBatchResult),
// but uses the V2 compose + V2 parser, and persists V2 payload on each anchor.
// =====================================================================

export async function processBatchV2(jobId: string, batchIndex: number, runnerId: string): Promise<ProcessBatchResult> {
  const settings = await loadSettings();
  const job = await getJob(jobId);
  if (!job) return { kind: "failed", message: "Job not found", anchorsAdded: 0 };
  if (job.status === "cancelled") return { kind: "cancelled", message: "Cancelled", anchorsAdded: 0 };
  if (job.status === "paused") return { kind: "paused", message: "Paused", anchorsAdded: 0 };

  const lease = await claimOrRefreshRunnerLease(jobId, runnerId);
  if (!lease.ok) {
    return { kind: "lease_lost", message: `Lease held by ${lease.currentRunnerId} (${lease.heartbeatAgeMs}ms ago)`, anchorsAdded: 0 };
  }

  const inputs = job.inputs ?? [];
  const existing = job.anchors ?? [];

  // V2 batchSize on the job row holds the TARGET ANCHORS per batch (not rows). The
  // planner re-walks inputs and packs them until the running anchor total would exceed
  // the target. Heavy rows are SPLIT across consecutive batches — `entries` may contain
  // the same input multiple times across batches, each with its own slice of the row's
  // per-category counts. Deterministic given immutable inputs.
  const entries = planBatchV2({ batchIndex, inputs, targetAnchorsPerBatch: job.batchSize || 200 });

  // Filter out any entries whose input is missing V2 payload — shouldn't happen for V2
  // jobs (the form blocks creation without it), but be defensive.
  const validEntries = entries.filter((e) => e.input.payloadV2 != null);

  if (validEntries.length === 0) {
    const status = existing.length > 0 ? "succeeded" : "failed";
    await setJobStatus(jobId, status, { lastError: status === "failed" ? "No batches produced anchors" : null });
    await releaseRunnerLease(jobId, runnerId);
    return { kind: status, message: "No more V2 batches", anchorsAdded: 0 };
  }

  const prompt = composeGenerationPromptV2({
    template: settings.prompts.v2.generation,
    entries: validEntries,
  });

  let raw: string;
  let usageV2: import("./types").ProviderUsage;
  try {
    const result = await callProvider({ providerId: job.criteria.providerId, model: job.criteria.model, prompt, settings });
    raw = result.text;
    usageV2 = result.usage;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (RATE_LIMIT_HINTS.test(message)) {
      await setJobStatus(jobId, "running", {
        lastError: `Rate-limited at batch ${batchIndex + 1}/${job.batchesTotal}: ${message}. Retrying with backoff…`,
      });
      return { kind: "rate_limited", message, anchorsAdded: 0 };
    }
    const finalStatus = existing.length > 0 ? "partial" : "failed";
    await setJobStatus(jobId, finalStatus, { lastError: `Batch ${batchIndex + 1}/${job.batchesTotal}: ${message}` });
    await releaseRunnerLease(jobId, runnerId);
    return { kind: finalStatus, message, anchorsAdded: 0 };
  }

  // Lock in cost for this V2 batch — same pattern as V1.
  const costV2 = await computeAiCost({
    providerId: job.criteria.providerId,
    model: job.criteria.model,
    inputTokens: usageV2.inputTokens,
    outputTokens: usageV2.outputTokens,
  });
  await addJobCostAndTokens(jobId, {
    inputTokens: usageV2.inputTokens,
    outputTokens: usageV2.outputTokens,
    cachedInputTokens: usageV2.cachedInputTokens,
    costUsd: costV2.costUsd,
  });

  let parsed: ReturnType<typeof parseAnchorsResponseV2>;
  try {
    parsed = parseAnchorsResponseV2(raw);
  } catch (e) {
    const message = `Could not parse AI output: ${e instanceof Error ? e.message : String(e)}`;
    const finalStatus = existing.length > 0 ? "partial" : "failed";
    await setJobStatus(jobId, finalStatus, { lastError: `Batch ${batchIndex + 1}/${job.batchesTotal}: ${message}` });
    await releaseRunnerLease(jobId, runnerId);
    return { kind: finalStatus, message, anchorsAdded: 0 };
  }

  if (parsed.length === 0) {
    await incrementBatchesDone(jobId);
    const isLast = batchIndex + 1 >= job.batchesTotal;
    if (isLast) {
      const finalStatus = existing.length > 0 ? "partial" : "failed";
      await setJobStatus(jobId, finalStatus, { lastError: "Last batch returned no anchors." });
      await releaseRunnerLease(jobId, runnerId);
      return { kind: finalStatus, message: "Empty last batch", anchorsAdded: 0 };
    }
    return { kind: "running", message: "Empty batch (continuing)", anchorsAdded: 0 };
  }

  // Map parsed → input by id. URL fallback is intentionally NOT included for V2 because
  // every entry already has a unique id and V2 inputs commonly share Target URLs across
  // rows (different Link Types), so URL-based fallback would be ambiguous.
  // Note: multiple entries in this batch may share the same input.id when a heavy row
  // got split across sub-batches. The lookup is by input.id (not entry id), so all
  // sub-batch anchors collapse back onto the right input row — which is what we want.
  const byId = new Map(validEntries.map((e) => [e.input.id, e.input]));
  const anchorsToInsert = parsed
    .map((p) => {
      const matched = byId.get(p.id);
      if (!matched) return null;
      const payload = matched.payloadV2!;
      // For url-category anchors, FORCE anchorText to the input's exact Target URL,
      // character-for-character. The AI is repeatedly observed to hallucinate variations
      // (lordfilmhd.co / lordfilmhd.com / lordfilmhd.net for example.com), so we don't
      // trust its url-category output at all. Belt-and-suspenders even when the prompt
      // is explicit. For non-url categories, use the AI's text as-is.
      const anchorText = p.category === "url" ? matched.targetUrl : p.anchorText;
      return {
        inputId: matched.id,
        targetUrl: matched.targetUrl,
        brandId: null,
        followStatus: null,
        anchorText,
        category: p.category,
        // V2 echo-through fields. Prefer what AI returned, fall back to the input's value
        // so a stripped-output anchor still carries the right metadata.
        payloadV2: {
          linkType: p.linkType || payload.linkType,
          geo: p.geo || payload.geo,
          lang: p.lang || payload.lang,
        },
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  await appendJobAnchors(jobId, anchorsToInsert);
  await incrementBatchesDone(jobId);

  const newBatchesDone = job.batchesDone + 1;
  const isLastBatch = newBatchesDone >= job.batchesTotal;
  if (isLastBatch) {
    await setJobStatus(jobId, "succeeded", { lastError: null });
    await releaseRunnerLease(jobId, runnerId);
    return { kind: "succeeded", message: `V2 batch ${batchIndex + 1} added ${anchorsToInsert.length} anchors`, anchorsAdded: anchorsToInsert.length };
  }
  return { kind: "running", message: `V2 batch ${batchIndex + 1} added ${anchorsToInsert.length} anchors`, anchorsAdded: anchorsToInsert.length };
}
