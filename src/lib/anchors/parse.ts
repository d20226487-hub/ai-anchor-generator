import type { AnchorCategory, FollowStatus } from "../types";

export interface ParsedAnchor {
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
    const targetUrl = typeof i.targetUrl === "string" ? i.targetUrl.trim().slice(0, MAX_TARGET_URL_LEN) : "";
    let anchorText = typeof i.anchorText === "string" ? i.anchorText.trim().slice(0, MAX_ANCHOR_TEXT_LEN) : "";
    const catRaw = typeof i.category === "string" ? i.category.toLowerCase() : "";
    const category = (CATS as string[]).includes(catRaw) ? (catRaw as AnchorCategory) : "generic";
    // For URL category, force the anchor text to be exactly the Target URL — the AI sometimes
    // returns "click here" or a stripped version even when it categorized correctly.
    if (category === "url" && targetUrl) anchorText = targetUrl;
    const followRaw = typeof i.followStatus === "string" ? i.followStatus.toLowerCase() : undefined;
    const followStatus = followRaw && (FOLLOW as string[]).includes(followRaw) ? (followRaw as FollowStatus) : undefined;
    if (!targetUrl || !anchorText) continue;
    out.push({ targetUrl, anchorText, category, followStatus });
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
