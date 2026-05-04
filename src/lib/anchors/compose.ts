import type { Brand, JobCriteria, JobInput, JobMode, JobAnchor } from "../types";

interface ComposeArgs {
  template: string;
  mode: JobMode;
  criteria: JobCriteria;
  inputs: Pick<JobInput, "targetUrl" | "title" | "keywords">[];
  batch?: BatchHints;
}

export interface BatchHints {
  isBatch: true;
  batchIndex: number;       // 0-based
  batchesTotal: number;
  exactCounts: {
    total: number;
    generic: number;
    branded: number;
    keyword: number;
    url: number;
    dofollow?: number;     // omitted when ratiosEnabled is false
    nofollow?: number;
  };
}

export function composeGenerationPrompt(args: ComposeArgs): string {
  const { template, mode, criteria, inputs, batch } = args;
  const ratiosOn = criteria.ratiosEnabled;
  const modeDesc =
    mode === "one_site"
      ? "ONE SITE MODE — all entries belong to the same target site/brand. Apply ratios across the whole batch."
      : "MULTIPLE SITES MODE — each entry may belong to a different brand. Apply the dofollow ratio AND the anchor distribution SEPARATELY for each brand (group by Target URL → brand mapping below). Aim for the ratios within every brand's anchors.";

  // When running in batch mode we override the natural-language ratio block with EXACT integer
  // counts that have been pre-computed to keep the cumulative output on target despite drift
  // from prior batches.
  let ratioBlock: string;
  let totalAnchorsForPrompt: number;
  if (batch) {
    const c = batch.exactCounts;
    const lines = [
      `THIS IS BATCH ${batch.batchIndex + 1} of ${batch.batchesTotal} for this job.`,
      `For THIS batch ONLY, generate EXACTLY ${c.total} anchors total, distributed across the entries below.`,
      `Required category counts (must hit these EXACTLY):`,
      `- generic: ${c.generic}`,
      `- branded: ${c.branded}`,
      `- keyword: ${c.keyword}`,
      `- url: ${c.url}`,
    ];
    if (ratiosOn && c.dofollow !== undefined && c.nofollow !== undefined) {
      lines.push(`Required follow-status counts (must hit these EXACTLY):`);
      lines.push(`- dofollow: ${c.dofollow}`);
      lines.push(`- nofollow: ${c.nofollow}`);
    } else {
      lines.push(`Dofollow ratio is DISABLED — do not include "followStatus" in output objects.`);
    }
    ratioBlock = lines.join("\n");
    totalAnchorsForPrompt = c.total;
  } else {
    ratioBlock = ratiosOn
      ? `Dofollow vs nofollow: ${criteria.dofollowPct}% dofollow, ${100 - criteria.dofollowPct}% nofollow. Set "followStatus" on every anchor.`
      : `Dofollow ratio is DISABLED — do not include "followStatus" in output objects.`;
    // Total anchors = one per Target URL (inputs.length).
    totalAnchorsForPrompt = inputs.length;
  }

  const brandsBlock =
    criteria.brands.length === 0
      ? "(No brands specified — invent natural brand-style mentions where needed using the URL's domain.)"
      : criteria.brands
          .map(
            (b: Brand) =>
              `- ${b.name} → domains: ${b.domains.length ? b.domains.join(", ") : "(none)"}`
          )
          .join("\n");

  const distNote =
    mode === "multi_site"
      ? "Apply the distribution percentages WITHIN EACH BRAND'S group of anchors, not just overall."
      : "Apply the distribution percentages across the full output.";

  const entriesBlock = inputs
    .map((e, i) => {
      const parts = [`${i + 1}. Target URL: ${e.targetUrl}`];
      if (e.title) parts.push(`   Title: ${e.title}`);
      if (e.keywords) parts.push(`   Keywords: ${e.keywords}`);
      return parts.join("\n");
    })
    .join("\n");

  return template
    .replaceAll("{{MODE_DESCRIPTION}}", modeDesc)
    .replaceAll("{{RATIO_BLOCK}}", ratioBlock)
    .replaceAll("{{GENERIC_PCT}}", String(criteria.distribution.generic))
    .replaceAll("{{BRANDED_PCT}}", String(criteria.distribution.branded))
    .replaceAll("{{KEYWORD_PCT}}", String(criteria.distribution.keyword))
    .replaceAll("{{URL_PCT}}", String(criteria.distribution.url ?? 0))
    .replaceAll("{{BRANDS_BLOCK}}", brandsBlock)
    .replaceAll("{{INPUT_COUNT}}", String(inputs.length))
    .replaceAll("{{TOTAL_ANCHORS}}", String(totalAnchorsForPrompt))
    .replaceAll("{{DISTRIBUTION_PER_SITE_NOTE}}", distNote)
    .replaceAll("{{ENTRIES_BLOCK}}", entriesBlock);
}

interface RegenArgs {
  template: string;
  criteria: JobCriteria;
  anchors: JobAnchor[];
}

export function composeRegenerationPrompt(args: RegenArgs): string {
  const { template, criteria, anchors } = args;
  const brandsBlock =
    criteria.brands.length === 0
      ? "(No brands specified.)"
      : criteria.brands
          .map((b) => `- ${b.name} → domains: ${b.domains.join(", ") || "(none)"}`)
          .join("\n");

  const regenBlock = anchors
    .map(
      (a) =>
        `- id: ${a.id}\n  targetUrl: ${a.targetUrl}\n  category: ${a.category}\n  followStatus: ${a.followStatus ?? "(n/a)"}\n  current: ${a.anchorText}`
    )
    .join("\n");

  return template
    .replaceAll("{{BRANDS_BLOCK}}", brandsBlock)
    .replaceAll("{{REGEN_BLOCK}}", regenBlock);
}
