import Papa from "papaparse";
import type { AnchorCategory, JobInputPayloadV2 } from "../types";

/**
 * V2 CSV input row. Each row is one AI request: generate `numberOfLinks` anchors
 * for `targetUrl` with the given category mix, Link Type, GEO, and Lang.
 *
 * Headers (case-insensitive, trimmed; both English and the Russian-localised
 * equivalents are accepted so colleagues can paste from spreadsheets in their
 * UI language):
 *   - Target URL      (required)
 *   - Link Type       (required)            also: Тип ссылки
 *   - Number of links (required, integer)   also: Кол-во ссылок / Количество ссылок
 *   - URL             (required, percent)   — bare URL / hostname anchors
 *   - Brand           (required, percent)   — brand-name anchors derived from host
 *   - Generic         (required, percent)   — generic phrases like "click here"
 *   - Keyword         (required, percent)
 *   - GEO             (optional, free text)
 *   - Lang            (optional, free text — code or name)
 *
 * Percentages may be entered as "100", "100%", or "100 %" — all parse to 100. The
 * four must sum to 100 (±1 to tolerate rounding from spreadsheets).
 */
export interface CsvRowV2 {
  targetUrl: string;
  payloadV2: JobInputPayloadV2;
}

export interface CsvParseResultV2 {
  rows: CsvRowV2[];
  errors: string[];
  warnings: string[];
  skipped: number;
}

// Header aliases: normalized form → set of accepted variants the user may type.
// Normalized = lowercased + trimmed.
const HEADER_ALIASES: Record<string, readonly string[]> = {
  targetUrl: ["target url", "targeturl", "url цель", "целевой url"],
  linkType: ["link type", "linktype", "type", "тип ссылки", "тип"],
  numberOfLinks: ["number of links", "numberoflinks", "links", "count", "кол-во ссылок", "количество ссылок"],
  distUrl: ["url"],
  distBrand: ["brand", "branded", "бренд"],
  distGeneric: ["generic", "общий"],
  distKeyword: ["keyword", "keywords", "ключевые слова"],
  geo: ["geo", "country", "страна", "гео"],
  lang: ["lang", "language", "язык"],
};

function buildFieldLookup(fields: string[]): Map<string, string> {
  const lower = new Map<string, string>();
  for (const f of fields) lower.set(f.toLowerCase().trim(), f);
  // Map alias → original header
  const found = new Map<string, string>();
  for (const [canonical, aliases] of Object.entries(HEADER_ALIASES)) {
    for (const a of aliases) {
      const real = lower.get(a);
      if (real) { found.set(canonical, real); break; }
    }
  }
  return found;
}

/** Parse "100", "100%", "100 %", "100,5" → number. Returns NaN if not numeric. */
function parsePct(raw: string): number {
  const cleaned = raw.replace(/[%\s]/g, "").replace(",", ".");
  if (cleaned === "") return NaN;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

function parseInt0(raw: string): number {
  const n = Number(raw.trim());
  return Number.isInteger(n) ? n : NaN;
}

export function parseCsvTextV2(text: string): CsvParseResultV2 {
  const errors: string[] = [];
  const warnings: string[] = [];
  const parsed = Papa.parse<Record<string, string>>(text.trim(), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });

  if (parsed.errors.length) {
    for (const e of parsed.errors) {
      // Same UndetectableDelimiter swallow as V1 — single-column files still parse fine.
      if (e.code === "UndetectableDelimiter") continue;
      errors.push(`Row ${e.row ?? "?"}: ${e.message}`);
    }
  }

  const fields = parsed.meta.fields ?? [];
  const lookup = buildFieldLookup(fields);

  // Required headers must all be present.
  const REQUIRED_KEYS = ["targetUrl", "linkType", "numberOfLinks", "distUrl", "distBrand", "distGeneric", "distKeyword"] as const;
  const missing: string[] = [];
  for (const k of REQUIRED_KEYS) if (!lookup.has(k)) missing.push(k);
  if (missing.length) {
    errors.push(
      `Missing required columns: ${missing.join(", ")}. Expected headers (case-insensitive): ` +
      `Target URL, Link Type, Number of links, URL, Brand, Generic, Keyword, GEO (optional), Lang (optional). ` +
      `Found: ${fields.join(", ") || "(none)"}`
    );
    return { rows: [], errors, warnings, skipped: 0 };
  }

  const rows: CsvRowV2[] = [];
  let skipped = 0;
  for (let i = 0; i < parsed.data.length; i++) {
    const r = parsed.data[i];
    const rowNumLabel = `row ${i + 2}`; // +2 because header is row 1, rows are 1-indexed

    const url = (r[lookup.get("targetUrl")!] ?? "").trim();
    if (!url) { skipped++; continue; }

    const linkType = (r[lookup.get("linkType")!] ?? "").trim();
    if (!linkType) { errors.push(`${rowNumLabel}: Link Type is required.`); continue; }

    const n = parseInt0(r[lookup.get("numberOfLinks")!] ?? "");
    if (!Number.isFinite(n) || n <= 0) {
      errors.push(`${rowNumLabel}: Number of links must be a positive integer (got "${r[lookup.get("numberOfLinks")!] ?? ""}").`);
      continue;
    }

    const distUrl = parsePct(r[lookup.get("distUrl")!] ?? "");
    const distBrand = parsePct(r[lookup.get("distBrand")!] ?? "");
    const distGeneric = parsePct(r[lookup.get("distGeneric")!] ?? "");
    const distKeyword = parsePct(r[lookup.get("distKeyword")!] ?? "");
    const pcts = [distUrl, distBrand, distGeneric, distKeyword];
    if (pcts.some((p) => !Number.isFinite(p) || p < 0 || p > 100)) {
      errors.push(`${rowNumLabel}: URL/Brand/Generic/Keyword must each be a number 0..100.`);
      continue;
    }
    const sum = pcts.reduce((a, b) => a + b, 0);
    // Tolerate small rounding from spreadsheets (e.g. 33+33+34 = 100, 33.3+33.3+33.4 = 100.0)
    if (Math.abs(sum - 100) > 1) {
      errors.push(`${rowNumLabel}: URL + Brand + Generic + Keyword must sum to 100 (got ${sum}).`);
      continue;
    }

    const geoField = lookup.get("geo");
    const langField = lookup.get("lang");
    const geo = geoField ? (r[geoField] ?? "").trim() : "";
    const lang = langField ? (r[langField] ?? "").trim() : "";

    rows.push({
      targetUrl: url,
      payloadV2: {
        linkType,
        numberOfLinks: n,
        // DistributionPct uses `branded` (matches V1 + anchor category enum).
        // The CSV header is "Brand" but internally we keep the same name as V1.
        distribution: {
          url: distUrl,
          branded: distBrand,
          generic: distGeneric,
          keyword: distKeyword,
        },
        geo,
        lang,
      },
    });
  }

  if (skipped > 0) {
    warnings.push(`Skipped ${skipped} row${skipped === 1 ? "" : "s"} with empty Target URL.`);
  }

  return { rows, errors, warnings, skipped };
}

/**
 * Convert V2 anchors back to CSV. Column order matches the V2 results table:
 * URL, Type (= link type), Anchor, Anchor type (= category), GEO, Lang.
 * The "Anchor type" column was added 2026-05-25; older exports had 5 columns.
 */
export function v2AnchorsToCsv(
  anchors: Array<{
    targetUrl: string;
    anchorText: string;
    category: AnchorCategory;
    payloadV2?: { linkType: string; geo: string; lang: string } | null;
  }>
): string {
  return Papa.unparse({
    fields: ["URL", "Type", "Anchor", "Anchor type", "GEO", "Lang"],
    data: anchors.map((a) => [
      a.targetUrl,
      a.payloadV2?.linkType ?? "",
      a.anchorText,
      a.category,
      a.payloadV2?.geo ?? "",
      a.payloadV2?.lang ?? "",
    ]),
  });
}
