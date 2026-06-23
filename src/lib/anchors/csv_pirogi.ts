import Papa from "papaparse";
import type { AnchorCategory } from "../types";

/**
 * Convert Пироги (v3) anchors to the 9-column CSV deliverable.
 *
 * Layout:
 *   URL | Anchor | Quantity | Language | Country | Keyword Group | Anchor Type | KEYWORD | KEYWORD GROUP
 *
 * The LEFT "Keyword Group" and RIGHT helper "KEYWORD GROUP" columns share the
 * same row-index scale so the helper acts as a LOOKUP POINTER:
 *
 *   - KEYWORD GROUP (helper) = `group N` where N is this row's 1-based position
 *     in the export (1, 2, 3, ..., total rows).
 *   - Keyword Group (LEFT)  = `group N` where N is the row position of the
 *     FIRST occurrence of this anchor (case-insensitive). When you see LEFT=
 *     `group 214` at a row where RIGHT=`group 1079`, you scroll up to the row
 *     where RIGHT=`group 214` and that's where this anchor first appeared.
 *
 * Same anchor (case-insensitive) always gets the same LEFT value. Max LEFT
 * tracks max RIGHT closely (slightly lower if the last few rows are duplicates).
 *
 * This is the rule the source spreadsheet uses. Computed at export time across
 * the complete anchor list — never per-batch.
 *
 * History note: briefly tried "sequential unique-anchor ID" (1..unique count) —
 * that gave a max LEFT much smaller than max RIGHT and broke the lookup
 * relationship the helper column exists to support. Reverted 2026-05-27.
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
  // Uses the same row-index scale as the KEYWORD GROUP helper so the helper can be
  // used to navigate from a duplicate row back to where the anchor first appeared.
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
