import type { AnchorCategory, FollowStatus } from "../types";

export interface ParsedAnchor {
  /** The input entry id the AI echoed back. Empty string if missing — caller decides
   *  whether to fall back to URL-based matching for backwards compatibility. */
  id: string;
  /** Optional URL the AI returned. Only used when id is missing (legacy AI responses). */
  targetUrl: string;
  anchorText: string;
  category: AnchorCategory;
  followStatus?: FollowStatus;
}

export interface ParsedRegen {
  id: string;
  anchorText: string;
}

function stripFences(s: string): string {
  let t = s.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json|JSON)?\s*/, "");
    t = t.replace(/```\s*$/, "");
  }
  return t.trim();
}

function extractJsonObject(s: string): unknown {
  const t = stripFences(s);
  try { return JSON.parse(t); } catch { /* fall through */ }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const slice = t.slice(start, end + 1);
    try { return JSON.parse(slice); } catch { /* fall through */ }
  }
  throw new Error("AI output was not valid JSON");
}

const CATS: AnchorCategory[] = ["generic", "branded", "keyword", "url"];
const FOLLOW: FollowStatus[] = ["dofollow", "nofollow"];

// Defensive caps against runaway / adversarial AI output.
const MAX_ANCHOR_TEXT_LEN = 500;
const MAX_TARGET_URL_LEN = 2048;
const MAX_ANCHORS_PER_RESPONSE = 5000;
const MAX_ID_LEN = 128;

export function parseAnchorsResponse(raw: string): ParsedAnchor[] {
  const obj = extractJsonObject(raw) as { anchors?: unknown };
  const arr = Array.isArray(obj.anchors) ? obj.anchors.slice(0, MAX_ANCHORS_PER_RESPONSE) : [];
  const out: ParsedAnchor[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const i = item as Record<string, unknown>;
    const id = typeof i.id === "string" ? i.id.trim().slice(0, MAX_ID_LEN) : "";
    const targetUrl = typeof i.targetUrl === "string" ? i.targetUrl.trim().slice(0, MAX_TARGET_URL_LEN) : "";
    const anchorText = typeof i.anchorText === "string" ? i.anchorText.trim().slice(0, MAX_ANCHOR_TEXT_LEN) : "";
    const catRaw = typeof i.category === "string" ? i.category.toLowerCase() : "";
    const category = (CATS as string[]).includes(catRaw) ? (catRaw as AnchorCategory) : "generic";
    const followRaw = typeof i.followStatus === "string" ? i.followStatus.toLowerCase() : undefined;
    const followStatus = followRaw && (FOLLOW as string[]).includes(followRaw) ? (followRaw as FollowStatus) : undefined;
    // Drop entries with no anchorText AND no way to map back (no id or url).
    if (!anchorText) continue;
    if (!id && !targetUrl) continue;
    out.push({ id, targetUrl, anchorText, category, followStatus });
  }
  return out;
}

export function parseRegenResponse(raw: string): ParsedRegen[] {
  const obj = extractJsonObject(raw) as { anchors?: unknown };
  const arr = Array.isArray(obj.anchors) ? obj.anchors.slice(0, MAX_ANCHORS_PER_RESPONSE) : [];
  const out: ParsedRegen[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const i = item as Record<string, unknown>;
    const id = typeof i.id === "string" ? i.id.slice(0, MAX_ID_LEN) : "";
    const anchorText = typeof i.anchorText === "string" ? i.anchorText.trim().slice(0, MAX_ANCHOR_TEXT_LEN) : "";
    if (!id || !anchorText) continue;
    out.push({ id, anchorText });
  }
  return out;
}

// =====================================================================
// V2 parser — same JSON envelope, extra fields per anchor (2026-05-24)
// =====================================================================

const MAX_PASSTHROUGH_LEN = 100; // linkType / geo / lang are display strings — cap to keep DB tidy.

export interface ParsedAnchorV2 {
  id: string;
  anchorText: string;
  category: AnchorCategory;
  linkType: string;
  geo: string;
  lang: string;
}

/**
 * Parse the V2 AI response. Same envelope `{ anchors: [...] }` as V1; each anchor adds
 * linkType/geo/lang echoed from the input. Category normalizes both "brand" (the prompt
 * label) and "branded" (the internal enum value) to "branded".
 */
export function parseAnchorsResponseV2(raw: string): ParsedAnchorV2[] {
  const obj = extractJsonObject(raw) as { anchors?: unknown };
  const arr = Array.isArray(obj.anchors) ? obj.anchors.slice(0, MAX_ANCHORS_PER_RESPONSE) : [];
  const out: ParsedAnchorV2[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const i = item as Record<string, unknown>;
    const id = typeof i.id === "string" ? i.id.trim().slice(0, MAX_ID_LEN) : "";
    const anchorText = typeof i.anchorText === "string" ? i.anchorText.trim().slice(0, MAX_ANCHOR_TEXT_LEN) : "";
    if (!id || !anchorText) continue;
    let catRaw = typeof i.category === "string" ? i.category.toLowerCase().trim() : "";
    if (catRaw === "brand") catRaw = "branded"; // V2 prompt label → internal enum
    const category = (CATS as string[]).includes(catRaw) ? (catRaw as AnchorCategory) : "generic";
    const linkType = typeof i.linkType === "string" ? i.linkType.trim().slice(0, MAX_PASSTHROUGH_LEN) : "";
    const geo = typeof i.geo === "string" ? i.geo.trim().slice(0, MAX_PASSTHROUGH_LEN) : "";
    const lang = typeof i.lang === "string" ? i.lang.trim().slice(0, MAX_PASSTHROUGH_LEN) : "";
    out.push({ id, anchorText, category, linkType, geo, lang });
  }
  return out;
}

// =====================================================================
// Пироги (v3) parser (2026-05-26) — JSON envelope { anchors: [{ id, anchorText,
// category, quantity, linkType, geo, lang }] }. Quantities are positive integers;
// items sharing the same (id, lowercased anchorText) are merged (quantities summed)
// — this is the same "same anchor = same group" rule applied at parse time so the
// AI doesn't break the dedup invariant.
// =====================================================================

export interface ParsedAnchorPirogi {
  id: string;
  anchorText: string;
  category: AnchorCategory;
  quantity: number;
  linkType: string;
  geo: string;
  lang: string;
}

const MAX_QUANTITY_PER_ANCHOR = 100_000; // 6-figure spend per single anchor variant is implausible — cap to keep DB sane.

export function parseAnchorsResponsePirogi(raw: string): ParsedAnchorPirogi[] {
  const obj = extractJsonObject(raw) as { anchors?: unknown };
  const arr = Array.isArray(obj.anchors) ? obj.anchors.slice(0, MAX_ANCHORS_PER_RESPONSE) : [];
  // Dedup map: key = `${id}\x01${anchorText.toLowerCase()}`. Merging here means the
  // job_anchors table never holds two rows for the same (id, anchor) — keeps Keyword
  // Group computation simple and matches the "same anchor = same group" rule.
  const byKey = new Map<string, ParsedAnchorPirogi>();
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const i = item as Record<string, unknown>;
    const id = typeof i.id === "string" ? i.id.trim().slice(0, MAX_ID_LEN) : "";
    const anchorText = typeof i.anchorText === "string" ? i.anchorText.trim().slice(0, MAX_ANCHOR_TEXT_LEN) : "";
    if (!id || !anchorText) continue;
    let catRaw = typeof i.category === "string" ? i.category.toLowerCase().trim() : "";
    if (catRaw === "brand") catRaw = "branded";
    const category = (CATS as string[]).includes(catRaw) ? (catRaw as AnchorCategory) : "generic";
    const qRaw = typeof i.quantity === "number" ? i.quantity : Number(i.quantity);
    const quantity = Number.isFinite(qRaw) && qRaw > 0 ? Math.min(Math.round(qRaw), MAX_QUANTITY_PER_ANCHOR) : 1;
    const linkType = typeof i.linkType === "string" ? i.linkType.trim().slice(0, MAX_PASSTHROUGH_LEN) : "";
    const geo = typeof i.geo === "string" ? i.geo.trim().slice(0, MAX_PASSTHROUGH_LEN) : "";
    const lang = typeof i.lang === "string" ? i.lang.trim().slice(0, MAX_PASSTHROUGH_LEN) : "";
    const key = `${id}\x01${anchorText.toLowerCase()}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.quantity = Math.min(existing.quantity + quantity, MAX_QUANTITY_PER_ANCHOR);
    } else {
      byKey.set(key, { id, anchorText, category, quantity, linkType, geo, lang });
    }
  }
  return Array.from(byKey.values());
}
