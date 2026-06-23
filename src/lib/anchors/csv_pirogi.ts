import Papa from "papaparse";
import type { AnchorCategory } from "../types";

/**
 * Convert Пироги (v3) anchors to the 9-column CSV deliverable.
 *
 * Layout:
 *   URL | Anchor | Quantity | Language | Country | Keyword Group | Anchor Type | KEYWORD | KEYWORD GROUP
 *
 * - "Keyword Group" = unique-anchor ID. Computed AT EXPORT TIME (not per batch):
 *   walk all rows in arrival order, assign `group 1` to the first unique anchor
 *   text seen (case-insensitive), `group 2` to the next new one, and so on.
 *   Every subsequent occurrence of an already-seen anchor reuses its number.
 *   The max group number therefore equals the total number of unique anchors
 *   across the job, NOT the total row count.
 *
 *   History: this column previously tried two other schemes — sequential by
 *   unique-count and 1-based first-occurrence row index. The first-occurrence
 *   row index made the value semantically meaningless (it depended on where
 *   the AI happened to emit the row); switched back to a pure unique-anchor ID
 *   on 2026-05-27 per direct user instruction.
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
  // Keyword Group: case-insensitive dedup → sequential `group 1, 2, ...` per UNIQUE anchor.
  // Computed in arrival order; same anchor (any case) always gets the same number.
  const groupByLowered = new Map<string, number>();
  let nextGroup = 1;
  const groupForRow: string[] = new Array(anchors.length);
  for (let i = 0; i < anchors.length; i++) {
    const key = anchors[i].anchorText.toLowerCase();
    let g = groupByLowered.get(key);
    if (g === undefined) {
      g = nextGroup++;
      groupByLowered.set(key, g);
    }
    groupForRow[i] = `group ${g}`;
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
