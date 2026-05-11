// Per-provider rate-limit / timeout settings — defaults + resolver.
//
// We expose three knobs in Settings (Advanced expander on each provider card):
//   - timeoutMs:           per-call timeout passed to the provider SDK
//   - interBatchDelayMs:   sleep between successful batches (politeness pacing)
//   - maxRateRetries:      consecutive 429s tolerated before giving up
//
// All three live in `ProviderConfig.advanced` (optional). Undefined ⇒ default below.

import type { ProviderAdvanced, ProviderConfig } from "../types";

export const PROVIDER_LIMIT_DEFAULTS: Required<ProviderAdvanced> = {
  timeoutMs: 60_000,
  interBatchDelayMs: 1_500,
  maxRateRetries: 10,
};

/** Sane min/max bounds — UI uses these for input validation; resolver clamps server-side
 *  too so a hand-edited settings file can't break the loop with negative or zero values. */
export const PROVIDER_LIMIT_BOUNDS = {
  timeoutMs:         { min: 5_000,  max: 600_000 },   // 5s to 10min
  interBatchDelayMs: { min: 0,      max: 60_000 },    // 0 to 60s
  maxRateRetries:    { min: 1,      max: 100 },
} as const;

function clamp(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/** Resolve the effective limits for a provider — applies defaults for missing fields and
 *  clamps any hand-edited values that are out of bounds. Always returns a complete triple. */
export function resolveProviderLimits(cfg: ProviderConfig | undefined): Required<ProviderAdvanced> {
  const a = cfg?.advanced ?? {};
  return {
    timeoutMs: a.timeoutMs == null
      ? PROVIDER_LIMIT_DEFAULTS.timeoutMs
      : clamp(a.timeoutMs, PROVIDER_LIMIT_BOUNDS.timeoutMs.min, PROVIDER_LIMIT_BOUNDS.timeoutMs.max),
    interBatchDelayMs: a.interBatchDelayMs == null
      ? PROVIDER_LIMIT_DEFAULTS.interBatchDelayMs
      : clamp(a.interBatchDelayMs, PROVIDER_LIMIT_BOUNDS.interBatchDelayMs.min, PROVIDER_LIMIT_BOUNDS.interBatchDelayMs.max),
    maxRateRetries: a.maxRateRetries == null
      ? PROVIDER_LIMIT_DEFAULTS.maxRateRetries
      : clamp(a.maxRateRetries, PROVIDER_LIMIT_BOUNDS.maxRateRetries.min, PROVIDER_LIMIT_BOUNDS.maxRateRetries.max),
  };
}
