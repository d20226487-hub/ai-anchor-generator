import Papa from "papaparse";

export interface CsvRow {
  targetUrl: string;
  title: string | null;
  keywords: string | null;
}

export interface CsvParseResult {
  rows: CsvRow[];
  errors: string[];
  warnings: string[];
  skipped: number;
}

const REQUIRED_KEY = "target url";
const TITLE_KEY = "title";
const KEYWORDS_KEY = "keywords";

export function parseCsvText(text: string): CsvParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const parsed = Papa.parse<Record<string, string>>(text.trim(), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });

  if (parsed.errors.length) {
    for (const e of parsed.errors) {
      // PapaParse fires "UndetectableDelimiter" whenever a file has only one column (no delimiter
      // to detect). The data still parses correctly with the default comma — this is benign,
      // so we suppress it. Same for "Quotes" mismatches if no rows actually broke.
      if (e.code === "UndetectableDelimiter") continue;
      errors.push(`Row ${e.row ?? "?"}: ${e.message}`);
    }
  }

  const fields = parsed.meta.fields ?? [];
  // Case-insensitive lookup: map normalized header → original header (so we read with the
  // exact key Papa stored values under).
  const fieldByLower = new Map<string, string>();
  for (const f of fields) fieldByLower.set(f.toLowerCase().trim(), f);

  const targetField = fieldByLower.get(REQUIRED_KEY);
  const titleField = fieldByLower.get(TITLE_KEY);
  const keywordsField = fieldByLower.get(KEYWORDS_KEY);

  if (!targetField) {
    errors.push(`Missing required column "Target URL" (case-insensitive). Found: ${fields.join(", ") || "(none)"}`);
    return { rows: [], errors, warnings, skipped: 0 };
  }

  const rows: CsvRow[] = [];
  let skipped = 0;
  for (let i = 0; i < parsed.data.length; i++) {
    const r = parsed.data[i];
    const url = (r[targetField] ?? "").trim();
    if (!url) {
      skipped++;
      continue;
    }
    rows.push({
      targetUrl: url,
      title: titleField ? (r[titleField] ?? "").trim() || null : null,
      keywords: keywordsField ? (r[keywordsField] ?? "").trim() || null : null,
    });
  }

  if (skipped > 0) {
    warnings.push(`Skipped ${skipped} row${skipped === 1 ? "" : "s"} with empty Target URL.`);
  }

  return { rows, errors, warnings, skipped };
}

export function rowsToCsv(rows: Array<Record<string, string | number | null>>, headers: string[]): string {
  return Papa.unparse({ fields: headers, data: rows.map((r) => headers.map((h) => r[h] ?? "")) });
}
