import Papa from "papaparse";
import type { AnchorCategory } from "../types";

/**
 * Convert Пироги (v3) anchors to the 9-column CSV deliverable.
 *
 * Layout:
 *   URL | Anchor | Quantity | Language | Country | Keyword Group | Anchor Type | KEYWORD | KEYWORD GROUP
 *
 * - "Keyword Group" groups by CASE-INSENSITIVE anchor text — every occurrence of the
 *   same anchor (regardless of case) carries the same `group N` label. Numbering is
 *   sequential across the whole export based on first-appearance order.
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
  // Keyword Group: case-insensitive dedup → sequential group label by first appearance.
  const groupByLowered = new Map<string, number>();
  let nextGroup = 1;
  const groupForRow: string[] = [];
  for (const a of anchors) {
    const key = a.anchorText.toLowerCase();
    let g = groupByLowered.get(key);
    if (g === undefined) {
      g = nextGroup++;
      groupByLowered.set(key, g);
    }
    groupForRow.push(`group ${g}`);
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
