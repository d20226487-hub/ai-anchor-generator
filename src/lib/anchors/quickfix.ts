import type { JobAnchor, JobMode } from "../types";

export interface QuickFixGroup {
  key: string;
  targetCount: number;
  currentCount: number;
}

export interface QuickFixResult {
  changes: Array<{ id: string; newFollow: "dofollow" | "nofollow" }>;
  groups: QuickFixGroup[];
}

/**
 * Flips the minimum number of anchors needed to hit the target dofollow %.
 * Multi-site mode: per-brand. One-site mode: across all anchors.
 * Strategy: pick anchors with the OPPOSITE current follow status and flip until target is met.
 */
export function quickFixDofollowRatio(
  anchors: JobAnchor[],
  mode: JobMode,
  dofollowPct: number,
  brandKeyOf: (a: JobAnchor) => string
): QuickFixResult {
  const buckets = new Map<string, JobAnchor[]>();
  if (mode === "one_site") {
    buckets.set("__all__", anchors.slice());
  } else {
    for (const a of anchors) {
      const k = brandKeyOf(a);
      const list = buckets.get(k) ?? [];
      list.push(a);
      buckets.set(k, list);
    }
  }

  const changes: QuickFixResult["changes"] = [];
  const groups: QuickFixGroup[] = [];

  for (const [key, list] of buckets) {
    const total = list.length;
    if (total === 0) continue;
    const targetDof = Math.round((dofollowPct / 100) * total);
    const currentDof = list.filter((a) => a.followStatus === "dofollow").length;

    groups.push({ key, targetCount: targetDof, currentCount: currentDof });

    if (currentDof === targetDof) continue;

    if (currentDof < targetDof) {
      // need more dofollow — flip nofollow→dofollow
      const need = targetDof - currentDof;
      const candidates = list.filter((a) => a.followStatus !== "dofollow").slice(0, need);
      for (const a of candidates) changes.push({ id: a.id, newFollow: "dofollow" });
    } else {
      // need fewer dofollow — flip dofollow→nofollow
      const need = currentDof - targetDof;
      const candidates = list.filter((a) => a.followStatus === "dofollow").slice(0, need);
      for (const a of candidates) changes.push({ id: a.id, newFollow: "nofollow" });
    }
  }

  return { changes, groups };
}
