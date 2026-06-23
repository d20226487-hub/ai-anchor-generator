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

/**
 * Fix mixed-delimiter pastes: when the header row uses commas (typical "Insert headers"
 * button output) but data rows use tabs (typical Google Sheets / Excel paste), PapaParse
 * picks ONE delimiter for the whole file and the other rows fail with "too few fields".
 * Detect that exact case and normalize the header to tabs so PapaParse auto-detects TSV.
 *
 * Conservative — only triggers when:
 *   1) at least one data line contains a tab,
 *   2) the header line contains NO tab but contains a comma.
 * Other shapes (all-comma, all-tab, single-line) are left alone.
 */
function normalizeMixedDelimiters(text: string): string {
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return text;
  const header = lines[0];
  const dataLines = lines.slice(1).filter((l) => l.trim().length > 0);
  if (dataLines.length === 0) return text;
  const dataHasTab = dataLines.some((l) => l.includes("\t"));
  const headerHasTab = header.includes("\t");
  const headerHasComma = header.includes(",");
  if (!dataHasTab || headerHasTab || !headerHasComma) return text;
  // Replace ", " / "," in the header with a single tab so the header field count
  // matches the data's tab count.
  lines[0] = header.replace(/\s*,\s*/g, "\t");
  return lines.join("\n");
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

/**
 * @param opts.linkTypeRequired - V2 requires Link Type on every row (it's a primary
 *   axis of the V2 distribution model). Пироги (v3) reuses this parser but doesn't
 *   care about Link Type — set false to drop the column from the required set AND
 *   stop erroring on empty per-row values. Defaults to true for V2 back-compat.
 */
export function parseCsvTextV2(text: string, opts: { linkTypeRequired?: boolean } = {}): CsvParseResultV2 {
  const linkTypeRequired = opts.linkTypeRequired ?? true;
  const errors: string[] = [];
  const warnings: string[] = [];
  // Normalize the common "comma-header + tab-data" mixed-delimiter case before parsing.
  const normalized = normalizeMixedDelimiters(text.trim());
  const parsed = Papa.parse<Record<string, string>>(normalized, {
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

  // Required headers must all be present. Link Type joins the required set only in V2.
  const REQUIRED_KEYS: readonly string[] = linkTypeRequired
    ? ["targetUrl", "linkType", "numberOfLinks", "distUrl", "distBrand", "distGeneric", "distKeyword"]
    : ["targetUrl", "numberOfLinks", "distUrl", "distBrand", "distGeneric", "distKeyword"];
  const missing: string[] = [];
  for (const k of REQUIRED_KEYS) if (!lookup.has(k)) missing.push(k);
  if (missing.length) {
    const expectedHeaders = linkTypeRequired
      ? "Target URL, Link Type, Number of links, URL, Brand, Generic, Keyword, GEO (optional), Lang (optional)"
      : "Target URL, Number of links, URL, Brand, Generic, Keyword, Link Type (optional), GEO (optional), Lang (optional)";
    errors.push(
      `Missing required columns: ${missing.join(", ")}. Expected headers (case-insensitive): ` +
      `${expectedHeaders}. Found: ${fields.join(", ") || "(none)"}`
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

    // Link Type is optional in Пироги mode — lookup may not have a column at all, and
    // even when it does, an empty cell is acceptable. In V2 we still require it.
    const linkTypeField = lookup.get("linkType");
    const linkType = linkTypeField ? (r[linkTypeField] ?? "").trim() : "";
    if (linkTypeRequired && !linkType) { errors.push(`${rowNumLabel}: Link Type is required.`); continue; }

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
 * Convert V2 / Пироги inputs back to the CSV form the user would have pasted.
 * Used by the edit pages to pre-fill the CSV textarea with the job's current rows.
 * Emits all 9 V2 columns even if Link Type / GEO / Lang are empty — the parser
 * accepts that, and seeing the empty columns reminds the user the slots exist.
 */
export function v2InputsToCsv(
  inputs: Array<{ targetUrl: string; payloadV2?: JobInputPayloadV2 | null }>
): string {
  if (inputs.length === 0) return "";
  return Papa.unparse({
    fields: ["Target URL", "Link Type", "Number of links", "URL", "Brand", "Generic", "Keyword", "GEO", "Lang"],
    data: inputs.map((i) => {
      const p = i.payloadV2;
      if (!p) return [i.targetUrl, "", "", "0", "0", "0", "0", "", ""];
      return [
        i.targetUrl,
        p.linkType,
        String(p.numberOfLinks),
        String(p.distribution.url ?? 0),
        String(p.distribution.branded ?? 0),
        String(p.distribution.generic ?? 0),
        String(p.distribution.keyword ?? 0),
        p.geo,
        p.lang,
      ];
    }),
  });
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
