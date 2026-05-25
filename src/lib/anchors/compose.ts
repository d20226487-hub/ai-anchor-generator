import type { Brand, JobCriteria, JobInput, JobInputPayloadV2, JobMode, JobAnchor } from "../types";
import type { V2BatchEntry } from "./batchPlan";
import { matchBrand } from "./brands";

/** Resolve the language for an input — multi-site looks up the matched brand, single-site
 *  uses the job-level criteria.language. Falls back to "en" so older jobs without language
 *  data still render a valid prompt. */
function resolveInputLanguage(targetUrl: string, mode: JobMode, criteria: JobCriteria): string {
  if (mode === "multi_site") {
    const brand = matchBrand(targetUrl, criteria.brands);
    return (brand?.language || "en");
  }
  return (criteria.language || "en");
}

interface ComposeArgs {
  template: string;
  mode: JobMode;
  criteria: JobCriteria;
  /** Each entry MUST include `id` so the AI can echo it back; this is how anchors map
   *  to inputs — two rows with the same `targetUrl` are still distinct because their
   *  ids differ (fixes the URL-collision dedup bug). */
  inputs: Pick<JobInput, "id" | "targetUrl" | "title" | "keywords">[];
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
            (b: Brand) => {
              const lang = b.language ? ` [language: ${b.language}]` : "";
              return `- ${b.name} → domains: ${b.domains.length ? b.domains.join(", ") : "(none)"}${lang}`;
            }
          )
          .join("\n");

  const distNote =
    mode === "multi_site"
      ? "Apply the distribution percentages WITHIN EACH BRAND'S group of anchors, not just overall."
      : "Apply the distribution percentages across the full output.";

  const entriesBlock = inputs
    .map((e, i) => {
      const lang = resolveInputLanguage(e.targetUrl, mode, criteria);
      const parts = [
        `${i + 1}. id: ${e.id}`,
        `   Target URL: ${e.targetUrl}`,
        `   Language: ${lang}`,
      ];
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

// =====================================================================
// V2 compose — CSV-driven, per-row config (2026-05-24)
// =====================================================================

/**
 * Inject the job's free-text site description into a composed prompt as a "Site context"
 * section. If the template carries a `{{SITE_DESCRIPTION}}` placeholder (the current
 * defaults do), we substitute there; otherwise — e.g. a user customised their template
 * before this feature existed — we prepend the block so the context still reaches the AI.
 * Empty/blank description → no section (placeholder collapses to "").
 */
function injectSiteDescription(prompt: string, desc: string | null | undefined): string {
  const trimmed = (desc ?? "").trim();
  const block = trimmed
    ? `## Site context\nThe following describes the site(s)/page(s) these backlinks point to. Use it to make the anchors more relevant and on-topic:\n${trimmed}`
    : "";
  if (prompt.includes("{{SITE_DESCRIPTION}}")) {
    return prompt.replaceAll("{{SITE_DESCRIPTION}}", block);
  }
  return block ? `${block}\n\n${prompt}` : prompt;
}

interface ComposeV2Args {
  template: string;
  /** Pre-planned entries for this batch — each carries the input row + the exact per-
   *  category integer counts the AI should produce. Heavy rows appear in multiple
   *  consecutive batches; each batch sees its own slice via exactCounts. */
  entries: V2BatchEntry[];
  /** Optional job-level site description → injected as a "Site context" section. */
  siteDescription?: string | null;
}

export function composeGenerationPromptV2(args: ComposeV2Args): string {
  const { template, entries, siteDescription } = args;

  const entriesBlock = entries
    .map((e, i) => {
      const input = e.input;
      const p = input.payloadV2 as JobInputPayloadV2;
      const counts = e.exactCounts;
      const subTotal = counts.url + counts.branded + counts.generic + counts.keyword;
      // Brand-domain hint: hostname of target URL (with "www." stripped) — the prompt asks
      // the AI to derive brand-style anchors from this. Keeps the AI from inventing brands
      // unrelated to the actual host.
      let hostHint = "";
      try {
        const u = new URL(input.targetUrl);
        hostHint = u.hostname.replace(/^www\./i, "");
      } catch {
        // Not a valid URL — fall back to a best-effort substring before the first "/".
        hostHint = input.targetUrl.replace(/^https?:\/\//i, "").split("/")[0].replace(/^www\./i, "");
      }
      const lines = [
        `${i + 1}. id: ${input.id}`,
        `   targetUrl: ${input.targetUrl}`,
        `   hostnameForBrand: ${hostHint}`,
        `   linkType: ${p.linkType}`,
        // Show the sub-batch's own total so the AI knows EXACTLY how many anchors to emit
        // for THIS entry within THIS batch. The full row total (which may span multiple
        // batches) is intentionally NOT shown — it would confuse the AI when sub-batches
        // are involved.
        `   produceExactly: ${subTotal}`,
        `   exactCounts: { url: ${counts.url}, brand: ${counts.branded}, generic: ${counts.generic}, keyword: ${counts.keyword} }  ← produce EXACTLY these per category`,
        `   geo: ${p.geo || "(none)"}`,
        `   lang: ${p.lang || "(none)"}`,
      ];
      return lines.join("\n");
    })
    .join("\n");

  const out = template.replaceAll("{{ENTRIES_BLOCK_V2}}", entriesBlock);
  return injectSiteDescription(out, siteDescription);
}

interface RegenV2Args {
  template: string;
  /** Anchors to regenerate, must include V2 payload so the prompt can echo through. */
  anchors: Array<Pick<JobAnchor, "id" | "targetUrl" | "category" | "anchorText"> & { payloadV2: { linkType: string; geo: string; lang: string } }>;
  /** Optional job-level site description → injected as a "Site context" section. */
  siteDescription?: string | null;
}

export function composeRegenerationPromptV2(args: RegenV2Args): string {
  const { template, anchors, siteDescription } = args;
  const regenBlock = anchors
    .map((a) => {
      let hostHint = "";
      try { hostHint = new URL(a.targetUrl).hostname.replace(/^www\./i, ""); } catch { /* keep empty */ }
      return [
        `- id: ${a.id}`,
        `  targetUrl: ${a.targetUrl}`,
        `  hostnameForBrand: ${hostHint}`,
        `  category: ${a.category}`,
        `  linkType: ${a.payloadV2.linkType}`,
        `  geo: ${a.payloadV2.geo}`,
        `  lang: ${a.payloadV2.lang}`,
        `  current: ${a.anchorText}`,
      ].join("\n");
    })
    .join("\n");
  const out = template.replaceAll("{{REGEN_BLOCK_V2}}", regenBlock);
  return injectSiteDescription(out, siteDescription);
}
