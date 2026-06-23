import Papa from "papaparse";
import type { AnchorCategory } from "../types";

/**
 * Convert Пироги (v3) anchors to the 9-column CSV deliverable.
 *
 * Layout:
 *   URL | Anchor | Quantity | Language | Country | Keyword Group | Anchor Type | KEYWORD | KEYWORD GROUP
 *
 * - "Keyword Group" groups by CASE-INSENSITIVE anchor text. The label is
 *   `group N` where **N is the 1-based ROW INDEX of the FIRST OCCURRENCE** of
 *   this anchor in the export. Duplicates of an earlier anchor inherit that
 *   earlier row's index (so e.g. row 16 echoing row 6's anchor → `group 6`).
 *   This matches the source spreadsheet's convention; an earlier implementation
 *   numbered sequentially (1, 2, 3, ...) per unique anchor, which made the LEFT
 *   max number much lower than the RIGHT helper max when many duplicates were
 *   present — fixed 2026-05-27.
 * - "Anchor Type" is the raw category (`generic` / `branded` / `keyword` / `url`).
 * - The last two columns are helper / planning-spreadsheet duplicates:
 *     • KEYWORD       — copy of Anchor (matches the user's source-of-truth sheet).
 *     • KEYWORD GROUP — sequential `group N` per output row (1, 2, 3, ...), no dedup.
 */
export function pirogiAnchorsToCsv(
  anchors: Array<{
    targetUrl: string;
    anchorText: string;
    category: AnchorCategory;
    payloadV2?: { linkType: string; geo: string; lang: string; quantity?: number } | null;
  }>
): string {
  // Keyword Group: case-insensitive dedup → `group <1-based row index of first occurrence>`.
  const firstIndexByLowered = new Map<string, number>();
  const groupForRow: string[] = new Array(anchors.length);
  for (let i = 0; i < anchors.length; i++) {
    const key = anchors[i].anchorText.toLowerCase();
    let firstIdx = firstIndexByLowered.get(key);
    if (firstIdx === undefined) {
      firstIdx = i + 1;
      firstIndexByLowered.set(key, firstIdx);
    }
    groupForRow[i] = `group ${firstIdx}`;
  }

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
      a.anchorText,        // KEYWORD = duplicate of Anchor (spreadsheet helper col)
      `group ${i + 1}`,    // KEYWORD GROUP = sequential per row, no dedup
    ]),
  });
}
