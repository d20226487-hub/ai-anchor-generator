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
