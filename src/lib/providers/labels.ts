import { PREDEFINED_MODELS } from "../settings";
import type { ProviderId, SettingsBlob } from "../types";

/**
 * Display names for the provider pickers.
 *
 * Client-safe on purpose: this module must NOT import `./index` (which pulls in the
 * provider SDKs and server-only config). Every job form is a client component and
 * only ever needs the label + ordering.
 *
 * Previously each form carried its own `labelFor()` copy. JobForm.tsx's copy predated
 * Vertex and fell through to "Google Gemini", so the V1 dropdown rendered two entries
 * both labelled "Google Gemini" and Vertex looked missing. One map, no drift.
 */
export const PROVIDER_LABELS: Record<ProviderId, string> = {
  openrouter: "OpenRouter",
  github: "GitHub Models",
  gemini: "Google Gemini",
  vertex: "Google Vertex AI",
};

/** Canonical order used when no default is known. */
export const ALL_PROVIDERS: ProviderId[] = ["openrouter", "github", "gemini", "vertex"];

export function providerLabel(p: ProviderId): string {
  return PROVIDER_LABELS[p] ?? p;
}

/**
 * Provider list with the Settings → Defaults provider hoisted to the front, so the
 * team's configured provider is the first thing in every picker (and the first option
 * a fresh <Select> lands on). The rest keep their canonical order.
 */
export function orderedProviders(defaultProviderId?: ProviderId | null): ProviderId[] {
  if (!defaultProviderId || !ALL_PROVIDERS.includes(defaultProviderId)) return ALL_PROVIDERS;
  return [defaultProviderId, ...ALL_PROVIDERS.filter((p) => p !== defaultProviderId)];
}

/**
 * Model suggestions for a provider's datalist, most-relevant first:
 *   1. the provider's default model from Settings → Defaults
 *   2. custom models the team added in Settings → Models
 *   3. the built-in predefined list
 * Deduped, order-preserving, empties dropped.
 */
export function modelSuggestions(providerId: ProviderId, settings: SettingsBlob): string[] {
  const preferred = settings.defaults.modelByProvider[providerId] ?? "";
  return Array.from(
    new Set([
      preferred,
      ...(settings.customModels[providerId] ?? []),
      ...(PREDEFINED_MODELS[providerId] ?? []),
    ].filter((m) => m && m.trim().length > 0))
  );
}
