import { db } from "./db";
import {
  DEFAULT_GENERATION_PROMPT,
  DEFAULT_GENERATION_PROMPT_V2,
  DEFAULT_REGENERATION_PROMPT,
  DEFAULT_REGENERATION_PROMPT_V2,
} from "./prompts";
import { KEY_CLEAR_SENTINEL, type ProviderConfig, type ProviderId, type SettingsBlob } from "./types";

export const DEFAULT_SETTINGS: SettingsBlob = {
  providers: {
    openrouter: { apiKey: "", baseUrl: "https://openrouter.ai/api/v1" },
    github: { apiKey: "", baseUrl: "https://models.github.ai/inference" },
    gemini: { apiKey: "" },
    vertex: { apiKey: "", location: "us-central1" },
  },
  customModels: {
    openrouter: [],
    github: [],
    gemini: [],
    vertex: [],
  },
  prompts: {
    generation: DEFAULT_GENERATION_PROMPT,
    regeneration: DEFAULT_REGENERATION_PROMPT,
    v2: {
      generation: DEFAULT_GENERATION_PROMPT_V2,
      regeneration: DEFAULT_REGENERATION_PROMPT_V2,
    },
  },
  defaults: {
    providerId: "openrouter",
    modelByProvider: {
      openrouter: "openai/gpt-4o-mini",
      github: "openai/gpt-4o-mini",
      gemini: "gemini-2.0-flash",
      vertex: "gemini-2.0-flash-001",
    },
  },
  locale: "en",
  theme: "dark",
};

export const PREDEFINED_MODELS: Record<string, string[]> = {
  openrouter: [
    "openai/gpt-4o-mini",
    "openai/gpt-4o",
    "anthropic/claude-3.5-sonnet",
    "anthropic/claude-3.5-haiku",
    "google/gemini-2.0-flash-001",
    "meta-llama/llama-3.3-70b-instruct",
    "deepseek/deepseek-chat",
  ],
  github: [
    "openai/gpt-4o-mini",
    "openai/gpt-4o",
    "meta/Llama-3.3-70B-Instruct",
    "mistral-ai/Mistral-large",
    "xai/grok-3-mini",
  ],
  gemini: [
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-1.5-flash",
    "gemini-1.5-pro",
  ],
  vertex: [
    // Gemini 2.5+ on Vertex auto-applies implicit prompt caching ≥1024-token prefixes.
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.0-flash-001",
    "gemini-2.0-flash-lite-001",
    // Anthropic Claude is also served on Vertex with the same generateContent shape.
    "claude-3-5-sonnet-v2@20241022",
    "claude-3-5-haiku@20241022",
  ],
};

export async function loadSettings(): Promise<SettingsBlob> {
  const client = await db();
  const res = await client.execute("SELECT blob FROM settings WHERE id = 1");
  if (res.rows.length === 0) return DEFAULT_SETTINGS;
  try {
    const parsed = JSON.parse(String(res.rows[0].blob)) as Partial<SettingsBlob>;
    return mergeSettings(parsed);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/**
 * Build a "redacted" view of settings safe to ship to the client.
 *
 * Replaces every provider's `apiKey` with the empty string and adds an `apiKeyPreview`
 * showing first-6 + last-4 chars (never the middle). The client form treats an empty
 * `apiKey` on save as "keep existing" (see mergeIncomingSettings).
 *
 * Audit fix: actionGetSettings used to ship plaintext keys to the browser.
 */
export function redactSettings(blob: SettingsBlob): SettingsBlob {
  const providers = Object.fromEntries(
    Object.entries(blob.providers).map(([id, cfg]) => {
      const k = cfg.apiKey ?? "";
      const preview = k.length >= 12 ? `${k.slice(0, 6)}…${k.slice(-4)}` : k.length > 0 ? "•••set" : null;
      // Vertex-only: SA-JSON gets its own redacted preview showing the client_email so the
      // user can tell at a glance which service account is configured.
      let saPreview: string | null = null;
      const sa = (cfg.serviceAccountJson ?? "").trim();
      if (sa) {
        try {
          const info = JSON.parse(sa) as { client_email?: string };
          saPreview = info.client_email ? `•••set (${info.client_email})` : "•••set";
        } catch {
          saPreview = "•••set (invalid JSON)";
        }
      }
      const out: ProviderConfig = {
        apiKey: "",
        baseUrl: cfg.baseUrl,
        apiKeyPreview: preview,
        advanced: cfg.advanced,
        // Vertex-only fields (undefined for other providers — JSON serialization drops them)
        serviceAccountJson: "",
        serviceAccountJsonPreview: saPreview,
        projectId: cfg.projectId,
        location: cfg.location,
      };
      return [id, out];
    })
  ) as SettingsBlob["providers"];
  return { ...blob, providers };
}

/**
 * Merge an incoming (potentially redacted) settings blob from the client with the
 * stored copy. For each provider:
 *   - if incoming `apiKey === KEY_CLEAR_SENTINEL` → remove (set to "")
 *   - else if incoming `apiKey` is empty AND a stored key exists → keep stored
 *   - else → use incoming
 * Always strips `apiKeyPreview` (transport-only).
 */
export function mergeIncomingSettings(incoming: SettingsBlob, stored: SettingsBlob): SettingsBlob {
  const providers = Object.fromEntries(
    (Object.keys(incoming.providers) as ProviderId[]).map((id) => {
      const inc = incoming.providers[id];
      const cur = stored.providers[id];
      const incKey = inc.apiKey ?? "";
      let resolved: string;
      if (incKey === KEY_CLEAR_SENTINEL) resolved = "";
      else if (incKey === "" && (cur?.apiKey ?? "") !== "") resolved = cur.apiKey;
      else resolved = incKey;
      // Vertex-only SA-JSON — same secret-merge logic as apiKey: empty incoming = keep
      // stored; KEY_CLEAR_SENTINEL = explicit removal; otherwise = use incoming.
      const incSa = inc.serviceAccountJson ?? "";
      let resolvedSa: string | undefined;
      if (incSa === KEY_CLEAR_SENTINEL) resolvedSa = "";
      else if (incSa === "" && (cur?.serviceAccountJson ?? "") !== "") resolvedSa = cur.serviceAccountJson;
      else resolvedSa = incSa;
      const out: ProviderConfig = {
        apiKey: resolved,
        baseUrl: inc.baseUrl,
        advanced: inc.advanced,
        // Vertex fields — undefined when the provider doesn't use them, JSON drops them
        serviceAccountJson: resolvedSa || undefined,
        projectId: inc.projectId,
        location: inc.location,
        // strip transport-only fields (apiKeyPreview, serviceAccountJsonPreview)
      };
      return [id, out];
    })
  ) as SettingsBlob["providers"];
  return { ...incoming, providers };
}

export async function saveSettings(blob: SettingsBlob): Promise<void> {
  const client = await db();
  const now = Date.now();
  await client.execute({
    sql: "INSERT INTO settings (id, blob, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at",
    args: [JSON.stringify(blob), now],
  });
}

function mergeSettings(p: Partial<SettingsBlob>): SettingsBlob {
  // Forward-compat: older blobs had defaults: { providerId, model } (single string).
  // Migrate by populating modelByProvider from the legacy single field for the default provider only.
  const rawDefaults = (p.defaults ?? {}) as Partial<SettingsBlob["defaults"]> & { model?: string };
  const providerId = rawDefaults.providerId ?? DEFAULT_SETTINGS.defaults.providerId;
  const modelByProvider: Record<string, string> = { ...DEFAULT_SETTINGS.defaults.modelByProvider, ...(rawDefaults.modelByProvider ?? {}) };
  if (rawDefaults.model && !rawDefaults.modelByProvider) modelByProvider[providerId] = rawDefaults.model;

  // V2 prompts (2026-05-24) — fill defaults on any stored blob that predates V2.
  const promptsIn = (p.prompts ?? {}) as Partial<SettingsBlob["prompts"]>;
  const v2In = (promptsIn.v2 ?? {}) as Partial<SettingsBlob["prompts"]["v2"]>;
  return {
    providers: { ...DEFAULT_SETTINGS.providers, ...(p.providers ?? {}) } as SettingsBlob["providers"],
    customModels: { ...DEFAULT_SETTINGS.customModels, ...(p.customModels ?? {}) } as SettingsBlob["customModels"],
    prompts: {
      generation: promptsIn.generation ?? DEFAULT_SETTINGS.prompts.generation,
      regeneration: promptsIn.regeneration ?? DEFAULT_SETTINGS.prompts.regeneration,
      v2: {
        generation: v2In.generation ?? DEFAULT_SETTINGS.prompts.v2.generation,
        regeneration: v2In.regeneration ?? DEFAULT_SETTINGS.prompts.v2.regeneration,
      },
    },
    defaults: { providerId, modelByProvider: modelByProvider as SettingsBlob["defaults"]["modelByProvider"] },
    locale: p.locale === "ru" ? "ru" : "en",
    theme: p.theme === "light" ? "light" : "dark",
  };
}
