import type { AnchorCategory, FollowStatus, JobAnchor, JobCriteria } from "../types";

export type RebalanceMode = "replace_ai" | "surgical";

export interface RebalancePlan {
  // Anchor IDs that should be deleted from the DB.
  deleteIds: string[];
  // How many new anchors to ask the AI for, with exact category + follow-status counts.
  generate: {
    total: number;
    perCategory: Record<AnchorCategory, number>;
    perFollow?: Record<FollowStatus, number>; // only when ratiosEnabled
  };
  // Notes for the UI to show (e.g. "manual edits already exceed target generic").
  warnings: string[];
}

const CATS: AnchorCategory[] = ["generic", "branded", "keyword", "url"];

/**
 * Plan a rebalance for a single brand's anchors.
 *
 * Always preserves manually-edited anchors. The two modes differ in how aggressively
 * AI-generated anchors are touched:
 *
 *  - replace_ai: delete every AI-generated anchor for this brand, then generate enough
 *    new ones to refill to the brand's existing total — with category/follow counts that
 *    push the overall mix (manual + new) toward the target distribution.
 *
 *  - surgical: keep AI-generated anchors that don't put any category over its target.
 *    Delete only AI anchors in surplus categories. Generate just the deficit.
 */
export function planRebalance(args: {
  brandAnchors: JobAnchor[];
  criteria: JobCriteria;
  mode: RebalanceMode;
}): RebalancePlan {
  const { brandAnchors, criteria, mode } = args;
  const warnings: string[] = [];

  const total = brandAnchors.length;
  if (total === 0) {
    return {
      deleteIds: [],
      generate: { total: 0, perCategory: { generic: 0, branded: 0, keyword: 0, url: 0 } },
      warnings: ["Brand has no anchors yet."],
    };
  }

  const manual = brandAnchors.filter((a) => a.manuallyEdited === 1);
  const ai = brandAnchors.filter((a) => a.manuallyEdited === 0);

  // Target counts per category for this brand, rounded to integers that sum to `total`.
  const targets: Record<AnchorCategory, number> = computeIntegerTargets(total, {
    generic: criteria.distribution.generic,
    branded: criteria.distribution.branded,
    keyword: criteria.distribution.keyword,
    url: criteria.distribution.url ?? 0,
  });

  const manualPerCat: Record<AnchorCategory, number> = countBy(manual, (a) => a.category);

  // Detect: manual edits alone exceed target for some category — we can't fix it without
  // touching manual edits (which we promised not to).
  for (const c of CATS) {
    if (manualPerCat[c] > targets[c]) {
      warnings.push(
        `${manualPerCat[c]} manually-edited "${c}" anchors already exceed the target of ${targets[c]} for this brand. Distribution will skew toward "${c}" unless you delete some manual ones.`
      );
    }
  }

  let deleteIds: string[] = [];
  const newPerCat: Record<AnchorCategory, number> = { generic: 0, branded: 0, keyword: 0, url: 0 };

  if (mode === "replace_ai") {
    deleteIds = ai.map((a) => a.id);
    const aiTotal = total - manual.length;
    const needRaw: Record<AnchorCategory, number> = {
      generic: Math.max(0, targets.generic - manualPerCat.generic),
      branded: Math.max(0, targets.branded - manualPerCat.branded),
      keyword: Math.max(0, targets.keyword - manualPerCat.keyword),
      url: Math.max(0, targets.url - manualPerCat.url),
    };
    const sum = CATS.reduce((acc, c) => acc + needRaw[c], 0);
    if (sum === 0) {
      newPerCat[smallestRatio(manualPerCat, targets)] = aiTotal;
    } else {
      // Scale needRaw to sum to aiTotal exactly using largest-remainder.
      const scaled = CATS.map((c) => ({ cat: c, exact: (needRaw[c] / sum) * aiTotal }));
      let assigned = 0;
      for (const s of scaled) {
        const f = Math.floor(s.exact);
        newPerCat[s.cat] = f;
        assigned += f;
      }
      const remainders = scaled.map((s) => ({ cat: s.cat, r: s.exact - Math.floor(s.exact) })).sort((a, b) => b.r - a.r);
      let i = 0;
      while (assigned < aiTotal && i < remainders.length) {
        newPerCat[remainders[i].cat] += 1;
        assigned += 1;
        i += 1;
      }
    }
  } else {
    // surgical: delete AI anchors in surplus categories, generate deficits.
    const aiPerCat: Record<AnchorCategory, JobAnchor[]> = {
      generic: ai.filter((a) => a.category === "generic"),
      branded: ai.filter((a) => a.category === "branded"),
      keyword: ai.filter((a) => a.category === "keyword"),
      url: ai.filter((a) => a.category === "url"),
    };
    for (const c of CATS) {
      const need = Math.max(0, targets[c] - manualPerCat[c]);
      const haveAI = aiPerCat[c].length;
      if (haveAI > need) {
        const excess = haveAI - need;
        deleteIds.push(...aiPerCat[c].slice(0, excess).map((a) => a.id));
      } else if (haveAI < need) {
        newPerCat[c] = need - haveAI;
      }
    }
  }

  const generateTotal = newPerCat.generic + newPerCat.branded + newPerCat.keyword;

  // Follow-status targets for the new anchors only.
  let perFollow: Record<FollowStatus, number> | undefined;
  if (criteria.ratiosEnabled && generateTotal > 0) {
    const targetDofTotal = Math.round((criteria.dofollowPct / 100) * total);
    const haveDofKept = brandAnchors
      .filter((a) => !deleteIds.includes(a.id))
      .filter((a) => a.followStatus === "dofollow").length;
    const needDof = Math.max(0, Math.min(generateTotal, targetDofTotal - haveDofKept));
    perFollow = {
      dofollow: needDof,
      nofollow: generateTotal - needDof,
    };
  }

  return {
    deleteIds,
    generate: {
      total: generateTotal,
      perCategory: newPerCat,
      perFollow,
    },
    warnings,
  };
}

function computeIntegerTargets(total: number, pct: Record<AnchorCategory, number>): Record<AnchorCategory, number> {
  // Hamilton/largest-remainder method to ensure ints sum to `total`.
  const exact: Record<AnchorCategory, number> = {
    generic: (total * pct.generic) / 100,
    branded: (total * pct.branded) / 100,
    keyword: (total * pct.keyword) / 100,
    url: (total * pct.url) / 100,
  };
  const floored: Record<AnchorCategory, number> = {
    generic: Math.floor(exact.generic),
    branded: Math.floor(exact.branded),
    keyword: Math.floor(exact.keyword),
    url: Math.floor(exact.url),
  };
  let assigned = floored.generic + floored.branded + floored.keyword + floored.url;
  const remainders: Array<{ cat: AnchorCategory; r: number }> = CATS.map((c) => ({ cat: c, r: exact[c] - floored[c] }));
  remainders.sort((a, b) => b.r - a.r);
  let i = 0;
  while (assigned < total && i < remainders.length) {
    floored[remainders[i].cat] += 1;
    assigned += 1;
    i += 1;
  }
  return floored;
}

function countBy<T>(items: T[], keyFn: (x: T) => AnchorCategory): Record<AnchorCategory, number> {
  const out: Record<AnchorCategory, number> = { generic: 0, branded: 0, keyword: 0, url: 0 };
  for (const it of items) out[keyFn(it)] += 1;
  return out;
}

function smallestRatio(have: Record<AnchorCategory, number>, target: Record<AnchorCategory, number>): AnchorCategory {
  let best: AnchorCategory = "generic";
  let bestRatio = Infinity;
  for (const c of CATS) {
    const t = target[c] || 1;
    const r = have[c] / t;
    if (r < bestRatio) {
      bestRatio = r;
      best = c;
    }
  }
  return best;
}
