import Papa from "papaparse";
import type { AnchorCategory } from "../types";

/**
 * Convert Пироги (v3) anchors to the 9-column CSV deliverable.
 *
 * Layout:
 *   URL | Anchor | Quantity | Language | Country | Keyword Group | Anchor Type | KEYWORD | KEYWORD GROUP
 *
 * Keyword Group = UNIQUE-ANCHOR ID. Walk the anchor list in arrival order and
 * assign `group 1` to the first unique anchor text seen (case-insensitive),
 * `group 2` to the next new one, etc.; every later occurrence of an already-seen
 * anchor reuses its number. The max group number therefore equals the number of
 * UNIQUE anchors in the job (e.g. 461 unique out of 1079 rows), NOT the row count.
 *
 * BOTH group columns carry this same value for a given row:
 *   - "Keyword Group" (LEFT)   — the deliverable.
 *   - "KEYWORD GROUP" (helper) — matches the LEFT exactly, so the helper pair
 *     (KEYWORD = the anchor text, KEYWORD GROUP = its group id) is a sortable
 *     side reference that lines up 1:1 with the left column.
 *
 * Computed at export time across the complete anchor list — never per-batch.
 *
 * History note: an earlier version numbered the helper KEYWORD GROUP per ROW
 * (1..total rows) while the left used a different scheme, so the two maxes
 * disagreed (461 vs 1079). Both now use unique-anchor numbering. (2026-05-27)
 */
export function pirogiAnchorsToCsv(
  anchors: Array<{
    targetUrl: string;
    anchorText: string;
    category: AnchorCategory;
    payloadV2?: { linkType: string; geo: string; lang: string; quantity?: number } | null;
  }>
): string {
  // Sequential unique-anchor numbering (case-insensitive). Same anchor → same number.
  // Used for BOTH the LEFT "Keyword Group" and the helper "KEYWORD GROUP" so they match.
  const groupForRow = computePirogiKeywordGroups(anchors.map((a) => a.anchorText));

  return Papa.unparse({
    fields: ["URL", "Anchor", "Quantity", "Language", "Country", "Keyword Group", "Anchor Type", "KEYWORD", "KEYWORD GROUP"],
    data: anchors.map((a, i) => [
      a.targetUrl,
      a.anchorText,
      a.payloadV2?.quantity ?? 1,
      a.payloadV2?.lang ?? "",
      a.payloadV2?.geo ?? "",
      groupForRow[i],
      a.category,
      a.anchorText,     // KEYWORD = duplicate of Anchor (spreadsheet helper col)
      groupForRow[i],   // KEYWORD GROUP = SAME unique-anchor id as the left column
    ]),
  });
}

/**
 * Assign each anchor a `group N` label by unique anchor text (case-insensitive),
 * numbered 1..(unique count) in arrival order. Shared by the CSV export and the
 * on-screen table so both always show the same value. Exported for reuse.
 */
export function computePirogiKeywordGroups(anchorTexts: string[]): string[] {
  const byLowered = new Map<string, number>();
  let next = 1;
  return anchorTexts.map((text) => {
    const key = text.toLowerCase();
    let g = byLowered.get(key);
    if (g === undefined) {
      g = next++;
      byLowered.set(key, g);
    }
    return `group ${g}`;
  });
}
