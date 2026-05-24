import type { ProviderId, SettingsBlob } from "../types";
import { callOpenAICompatible } from "./openai-compat";
import { callGemini } from "./gemini";
import { callGitHubModels } from "./github";
import { callVertex, pingVertex } from "./vertex";
import { resolveProviderLimits } from "./limits";

export interface CallArgs {
  providerId: ProviderId;
  model: string;
  prompt: string;
  settings: SettingsBlob;
}

export async function callProvider(args: CallArgs): Promise<string> {
  const { providerId, settings } = args;
  const cfg = settings.providers[providerId];
  // Vertex has its own credential check (either SA-JSON or apiKey) — let callVertex
  // raise a more informative error if neither is set. All other providers require apiKey.
  if (providerId !== "vertex" && !cfg?.apiKey) {
    throw new Error(`No API key configured for ${providerId}. Configure it in Settings.`);
  }

  // Pull the per-provider timeout from advanced settings. Other limits
  // (interBatchDelayMs, maxRateRetries) are applied higher up in the loop, not here.
  const { timeoutMs } = resolveProviderLimits(cfg);

  if (providerId === "openrouter") {
    return callOpenAICompatible({
      apiKey: cfg.apiKey,
      baseUrl: nonEmpty(cfg.baseUrl) || "https://openrouter.ai/api/v1",
      model: args.model,
      prompt: args.prompt,
      providerId,
      timeoutMs,
    });
  }
  if (providerId === "github") {
    return callGitHubModels({
      apiKey: cfg.apiKey,
      baseUrl: nonEmpty(cfg.baseUrl) || "https://models.github.ai/inference",
      model: args.model,
      prompt: args.prompt,
      timeoutMs,
    });
  }
  if (providerId === "gemini") {
    return callGemini({ apiKey: cfg.apiKey, model: args.model, prompt: args.prompt, timeoutMs });
  }
  if (providerId === "vertex") {
    return callVertex({
      serviceAccountJson: cfg?.serviceAccountJson,
      apiKey: cfg?.apiKey,
      projectId: cfg?.projectId,
      location: cfg?.location,
      model: args.model,
      prompt: args.prompt,
      timeoutMs,
    });
  }
  throw new Error(`Unknown provider: ${providerId}`);
}

function nonEmpty(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  return t.length === 0 ? null : t;
}

// Hardcoded fallbacks if the user hasn't set a per-provider default.
const PING_FALLBACK: Record<ProviderId, string> = {
  openrouter: "openai/gpt-4o-mini",
  github: "openai/gpt-4o-mini",
  gemini: "gemini-2.0-flash",
  vertex: "gemini-2.0-flash-001",
};

export async function pingProvider(providerId: ProviderId, settings: SettingsBlob): Promise<{ ok: boolean; message: string }> {
  try {
    const cfg = settings.providers[providerId];
    // Vertex has a dedicated free "list publisher models" probe (no token cost) — use it
    // instead of the generic "send a tiny prompt" path so the user can test SA-JSON creds
    // without spending quota. Mirrors Drop Sherlock's pattern.
    if (providerId === "vertex") {
      const { timeoutMs } = resolveProviderLimits(cfg);
      return await pingVertex({
        serviceAccountJson: cfg?.serviceAccountJson,
        apiKey: cfg?.apiKey,
        projectId: cfg?.projectId,
        location: cfg?.location,
        timeoutMs,
      });
    }
    if (!cfg?.apiKey) return { ok: false, message: "No API key set" };
    const userModel = settings.defaults.modelByProvider?.[providerId];
    const model = (userModel && userModel.trim()) || PING_FALLBACK[providerId];
    const out = await callProvider({
      providerId,
      model,
      prompt: 'Reply with the JSON {"ok":true} and nothing else.',
      settings,
    });
    return { ok: true, message: `OK — model "${model}" responded (${out.slice(0, 80).replace(/\s+/g, " ")}...)` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
