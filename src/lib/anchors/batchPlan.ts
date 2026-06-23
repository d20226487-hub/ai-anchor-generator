import type { JobAnchor, JobCriteria, JobInput } from "../types";
import type { BatchHints } from "./compose";

export interface BatchPlan {
  batchSize: number;
  batchesTotal: number;
}

/**
 * Compute how many input chunks to split the run into and how many anchors each batch
 * should produce. We chunk by inputs (not by anchors) so each batch is self-contained:
 * the AI sees the entries it must produce anchors for.
 */
export function planBatches(criteria: JobCriteria, inputs: JobInput[], desiredInputBatchSize = 10): BatchPlan {
  const total = Math.max(1, inputs.length);
  const batchSize = Math.max(1, Math.min(desiredInputBatchSize, total));
  const batchesTotal = Math.ceil(total / batchSize);
  return { batchSize, batchesTotal };
}

/**
 * For batch N, decide:
 * - which inputs go into this batch
 * - how many anchors to ask for, and the exact category/follow-status counts —
 *   accounting for cumulative drift from prior batches.
 *
 * Drift correction: at each batch we look at what's been produced so far vs. the overall
 * target, then distribute the remainder evenly across the remaining batches.
 */
export function planBatch(args: {
  batchIndex: number;
  batchesTotal: number;
  batchSize: number;
  inputs: JobInput[];
  criteria: JobCriteria;
  existingAnchors: JobAnchor[];
}): { inputsInBatch: JobInput[]; hints: BatchHints } {
  const { batchIndex, batchesTotal, batchSize, inputs, criteria, existingAnchors } = args;

  const start = batchIndex * batchSize;
  const end = Math.min(start + batchSize, inputs.length);
  const inputsInBatch = inputs.slice(start, end);

  const remainingBatches = Math.max(1, batchesTotal - batchIndex);

  // Total anchor budget remaining (overall target - already produced).
  // Target is exactly one anchor per Target URL — derived from the inputs list.
  const overallTarget = inputs.length;
  const producedSoFar = existingAnchors.length;
  const remainingTotal = Math.max(0, overallTarget - producedSoFar);
  const totalThisBatch = Math.max(1, Math.round(remainingTotal / remainingBatches));

  // Per-category targets: what the OVERALL job requires, minus what's already there, divided
  // across remaining batches.
  const overallGen = Math.round(overallTarget * (criteria.distribution.generic / 100));
  const overallBrn = Math.round(overallTarget * (criteria.distribution.branded / 100));
  const overallUrl = Math.round(overallTarget * ((criteria.distribution.url ?? 0) / 100));
  const overallKwd = overallTarget - overallGen - overallBrn - overallUrl; // ensures sum

  const haveGen = existingAnchors.filter((a) => a.category === "generic").length;
  const haveBrn = existingAnchors.filter((a) => a.category === "branded").length;
  const haveKwd = existingAnchors.filter((a) => a.category === "keyword").length;
  const haveUrl = existingAnchors.filter((a) => a.category === "url").length;

  let needGen = Math.max(0, Math.round((overallGen - haveGen) / remainingBatches));
  let needBrn = Math.max(0, Math.round((overallBrn - haveBrn) / remainingBatches));
  let needKwd = Math.max(0, Math.round((overallKwd - haveKwd) / remainingBatches));
  let needUrl = Math.max(0, Math.round((overallUrl - haveUrl) / remainingBatches));

  // Reconcile: rebalance to match totalThisBatch exactly. Add/remove from the largest bucket.
  const sumCats = needGen + needBrn + needKwd + needUrl;
  if (sumCats !== totalThisBatch) {
    const diff = totalThisBatch - sumCats;
    const buckets: Array<{ name: "gen" | "brn" | "kwd" | "url"; n: number }> = [
      { name: "gen", n: needGen },
      { name: "brn", n: needBrn },
      { name: "kwd", n: needKwd },
      { name: "url", n: needUrl },
    ];
    buckets.sort((a, b) => b.n - a.n);
    const top = buckets[0].name;
    if (top === "gen") needGen = Math.max(0, needGen + diff);
    else if (top === "brn") needBrn = Math.max(0, needBrn + diff);
    else if (top === "kwd") needKwd = Math.max(0, needKwd + diff);
    else needUrl = Math.max(0, needUrl + diff);
  }

  let dofollow: number | undefined;
  let nofollow: number | undefined;
  if (criteria.ratiosEnabled) {
    const overallDof = Math.round(overallTarget * (criteria.dofollowPct / 100));
    const haveDof = existingAnchors.filter((a) => a.followStatus === "dofollow").length;
    const needDof = Math.max(0, Math.round((overallDof - haveDof) / remainingBatches));
    dofollow = Math.max(0, Math.min(totalThisBatch, needDof));
    nofollow = totalThisBatch - dofollow;
  }

  const hints: BatchHints = {
    isBatch: true,
    batchIndex,
    batchesTotal,
    exactCounts: {
      total: totalThisBatch,
      generic: needGen,
      branded: needBrn,
      keyword: needKwd,
      url: needUrl,
      dofollow,
      nofollow,
    },
  };

  return { inputsInBatch, hints };
}

// =====================================================================
// V2 batch planning (2026-05-24, revised)
// V2 packs INPUT ROWS into a batch until the cumulative anchor total reaches a target
// cap (default 200). When a single row asks for more than the target, the row is
// SPLIT across multiple sub-batches — each sub-batch carries a proportional slice of
// the row's per-category counts. All sub-batches share the same input.id, so anchors
// land back on the same input row in the DB.
//
// `BatchPlan.batchSize` in V2 = TARGET ANCHORS per batch (not rows). Re-uses the existing
// jobs.batch_size INTEGER column.
//
// Edge cases:
//   - Single row exactly at target: one batch.
//   - Empty inputs → batchesTotal=1, planBatchV2 returns []. Loop ends as "failed" with
//     "No batches produced anchors".
//   - A row with 0 numberOfLinks (validation should reject this) → skipped during plan.
// =====================================================================

import type { AnchorCategory } from "../types";

const DEFAULT_V2_TARGET_ANCHORS_PER_BATCH = 200;

export interface V2BatchEntry {
  /** The originating input row. Carries id, targetUrl, and full payloadV2 for linkType/geo/lang echo. */
  input: JobInput;
  /**
   * EXACT integer counts the AI should produce for this entry within THIS batch.
   * For unsplit rows: sum equals the row's payloadV2.numberOfLinks.
   * For split rows: sum is a slice; concatenating all sub-batches gives the row's total.
   */
  exactCounts: Record<AnchorCategory, number>;
}

/** Hamilton/largest-remainder rounding: turn 4 floats summing to `total` into 4 ints. */
function hamiltonInts(parts: Record<AnchorCategory, number>, total: number): Record<AnchorCategory, number> {
  if (total <= 0) return { url: 0, branded: 0, generic: 0, keyword: 0 };
  const cats: AnchorCategory[] = ["url", "branded", "generic", "keyword"];
  const sum = cats.reduce((a, k) => a + (parts[k] ?? 0), 0) || 1;
  const raw = cats.map((k) => ((parts[k] ?? 0) / sum) * total);
  const floor = raw.map((x) => Math.floor(x));
  let allocated = floor.reduce((a, b) => a + b, 0);
  const remainder = raw.map((x, i) => ({ i, rem: x - floor[i] }));
  remainder.sort((a, b) => b.rem - a.rem);
  for (const { i } of remainder) {
    if (allocated >= total) break;
    floor[i]++;
    allocated++;
  }
  return { url: floor[0], branded: floor[1], generic: floor[2], keyword: floor[3] };
}

/**
 * Compute the row's full per-category counts (Hamilton-rounded to sum to numberOfLinks).
 * This is the "target" we then slice across one or more sub-batches.
 */
function rowExactCounts(input: JobInput): Record<AnchorCategory, number> {
  const p = input.payloadV2;
  if (!p) return { url: 0, branded: 0, generic: 0, keyword: 0 };
  return hamiltonInts(
    {
      url: p.distribution.url ?? 0,
      branded: p.distribution.branded ?? 0,
      generic: p.distribution.generic ?? 0,
      keyword: p.distribution.keyword ?? 0,
    },
    p.numberOfLinks
  );
}

/**
 * The core: convert a list of inputs into a flat list of batches, each containing one or
 * more V2BatchEntry items. Rows that exceed the target on their own get split across
 * multiple consecutive batches, each carrying a Hamilton-rounded slice of the row's
 * remaining per-category counts.
 *
 * Slicing strategy for a heavy row:
 *   - Remaining-per-category starts at the row's full Hamilton-rounded counts.
 *   - Each sub-batch takes `min(remainingTotal, target)` anchors, allocated proportionally
 *     across the remaining categories via a second Hamilton.
 *   - Subtract from remaining; repeat until remaining = 0.
 *   This guarantees the sum across sub-batches equals the row's intended total.
 */
function computeBatches(inputs: JobInput[], target: number): V2BatchEntry[][] {
  const batches: V2BatchEntry[][] = [];
  let current: V2BatchEntry[] = [];
  let currentTotal = 0;

  const closeBatch = () => {
    if (current.length > 0) {
      batches.push(current);
      current = [];
      currentTotal = 0;
    }
  };

  for (const input of inputs) {
    const n = input.payloadV2?.numberOfLinks ?? 0;
    if (n <= 0) continue;

    // Tracks how many anchors remain per category for THIS row as we slice.
    let remaining = rowExactCounts(input);
    let remainingTotal = remaining.url + remaining.branded + remaining.generic + remaining.keyword;

    while (remainingTotal > 0) {
      const capacity = target - currentTotal;

      // If the current batch is non-empty and has zero capacity for any of this row's
      // remaining anchors, close it and start fresh. This is the "pack-until-N" closure.
      if (capacity <= 0 && current.length > 0) {
        closeBatch();
        continue;
      }

      // Decide how many of this row's remaining anchors land in this batch.
      // Take the smaller of: full row-remainder OR the current batch's free capacity.
      const take = Math.min(remainingTotal, capacity > 0 ? capacity : target);

      // Slice `take` anchors out of `remaining`, Hamilton-rounded by the remaining ratios.
      const slice = hamiltonInts(remaining as Record<AnchorCategory, number>, take);
      current.push({ input, exactCounts: slice });
      currentTotal += take;

      // Subtract slice from remaining.
      remaining = {
        url: remaining.url - slice.url,
        branded: remaining.branded - slice.branded,
        generic: remaining.generic - slice.generic,
        keyword: remaining.keyword - slice.keyword,
      };
      remainingTotal = remaining.url + remaining.branded + remaining.generic + remaining.keyword;

      // If the batch is at or above target, close it. Otherwise keep packing more rows.
      if (currentTotal >= target) closeBatch();
    }
  }
  closeBatch();
  if (batches.length === 0) batches.push([]); // ensure batchesTotal >= 1
  return batches;
}

/** Number of batches needed for the run. Persisted on jobs.batches_total. */
export function planBatchesV2(inputs: JobInput[], targetAnchorsPerBatch = DEFAULT_V2_TARGET_ANCHORS_PER_BATCH): BatchPlan {
  const target = Math.max(1, targetAnchorsPerBatch);
  const batches = computeBatches(inputs, target);
  return { batchSize: target, batchesTotal: Math.max(1, batches.length) };
}

/** Entries (input + exact counts) for the requested batch index. Deterministic given same inputs + target. */
export function planBatchV2(args: {
  batchIndex: number;
  inputs: JobInput[];
  /** Same target used by planBatchesV2 when the job was created. Persisted as jobs.batch_size. */
  targetAnchorsPerBatch?: number;
}): V2BatchEntry[] {
  const { batchIndex, inputs, targetAnchorsPerBatch = DEFAULT_V2_TARGET_ANCHORS_PER_BATCH } = args;
  const target = Math.max(1, targetAnchorsPerBatch);
  const batches = computeBatches(inputs, target);
  return batches[batchIndex] ?? [];
}

// =====================================================================
// Пироги (v3) batching (2026-05-26)
// Pirogi asks the AI for a DEDUPED list of unique anchor texts + quantities per
// input row. Per-batch payload size depends on the number of UNIQUE anchors the
// AI decides to produce (which scales roughly with log(numberOfLinks), not with
// numberOfLinks itself). So we batch ONE INPUT ROW per AI call — predictable
// memory, easier failure isolation, and each row's "produce 10-80 unique anchors
// with quantities summing to N" is a self-contained task for the model.
//
// `batch_size` for Пироги stores 1 (rows per batch). `batches_total` = number of
// input rows with payloadV2 + numberOfLinks > 0.
// =====================================================================

/** Number of batches for a Пироги run — one per input row that has a positive numberOfLinks. */
export function planBatchesPirogi(inputs: JobInput[]): BatchPlan {
  const eligible = inputs.filter((i) => (i.payloadV2?.numberOfLinks ?? 0) > 0);
  return { batchSize: 1, batchesTotal: Math.max(1, eligible.length) };
}

/** Return the single input row that belongs to this batch index. */
export function planBatchPirogi(args: { batchIndex: number; inputs: JobInput[] }): JobInput | null {
  const { batchIndex, inputs } = args;
  const eligible = inputs.filter((i) => (i.payloadV2?.numberOfLinks ?? 0) > 0);
  return eligible[batchIndex] ?? null;
}
