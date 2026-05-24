"use client";

import * as React from "react";
import { useT } from "@/lib/i18n/I18nProvider";
import { AlertTriangle, DollarSign } from "lucide-react";
import type { Job } from "@/lib/types";

/**
 * Render the per-job AI cost as a pill with a hover-tooltip token breakdown.
 *
 *   - Cost under $1 is shown with 4 decimals ($0.0023) so tiny calls aren't truncated to $0.00.
 *   - Cost $1+ is shown with 2 decimals.
 *   - Tokens are localized with thousands separators.
 *   - Cached input tokens (Vertex implicit cache) are shown only when > 0.
 *   - `pricingMissing` tilts the pill to a warning color so the user sees that tokens were
 *     spent but no pricing row exists — explains an unexpected $0.
 */
export function CostPill({
  job,
  pricingMissing = false,
  compact = false,
}: {
  job: Pick<Job, "aiCostUsd" | "aiInputTokens" | "aiOutputTokens" | "aiCachedInputTokens">;
  pricingMissing?: boolean;
  compact?: boolean;
}) {
  const { t, locale } = useT();
  const formatNum = React.useCallback(
    (n: number) => n.toLocaleString(locale === "ru" ? "ru-RU" : undefined),
    [locale]
  );

  const cost = job.aiCostUsd;
  const display = cost === 0 ? "$0" : cost < 1 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
  const hasTokens = job.aiInputTokens > 0 || job.aiOutputTokens > 0;

  const warnState = pricingMissing && hasTokens;

  const tooltipLines: string[] = [
    t("cost.tipInput", { n: formatNum(job.aiInputTokens) }),
    t("cost.tipOutput", { n: formatNum(job.aiOutputTokens) }),
  ];
  if (job.aiCachedInputTokens > 0) {
    tooltipLines.push(t("cost.tipCached", { n: formatNum(job.aiCachedInputTokens), total: formatNum(job.aiInputTokens) }));
  }
  if (warnState) tooltipLines.push(t("cost.tipMissingPricing"));
  const tooltip = tooltipLines.join("\n");

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium tabular-nums ${
        warnState
          ? "border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 text-[var(--color-warn)]"
          : "border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text-dim)]"
      }`}
      title={tooltip}
      aria-label={t("cost.ariaLabel", { cost: display })}
    >
      {warnState ? <AlertTriangle className="h-3 w-3" /> : <DollarSign className="h-3 w-3" />}
      <span>{display}</span>
      {!compact && hasTokens && (
        <span className="text-[10px] opacity-70">
          {t("cost.tokensSuffix", { in: formatNum(job.aiInputTokens), out: formatNum(job.aiOutputTokens) })}
        </span>
      )}
    </span>
  );
}
