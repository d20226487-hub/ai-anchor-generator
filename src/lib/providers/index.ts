import type { ProviderId, SettingsBlob } from "../types";
import { callOpenAICompatible } from "./openai-compat";
import { callGemini } from "./gemini";
import { callGitHubModels } from "./github";

export interface CallArgs {
  providerId: ProviderId;
  model: string;
  prompt: string;
  settings: SettingsBlob;
}

export async function callProvider(args: CallArgs): Promise<string> {
  const { providerId, settings } = args;
  const cfg = settings.providers[providerId];
  if (!cfg?.apiKey) throw new Error(`No API key configured for ${providerId}. Configure it in Settings.`);

  if (providerId === "openrouter") {
    return callOpenAICompatible({
      apiKey: cfg.apiKey,
      baseUrl: nonEmpty(cfg.baseUrl) || "https://openrouter.ai/api/v1",
      model: args.model,
      prompt: args.prompt,
      providerId,
    });
  }
  if (providerId === "github") {
    return callGitHubModels({
      apiKey: cfg.apiKey,
      baseUrl: nonEmpty(cfg.baseUrl) || "https://models.github.ai/inference",
      model: args.model,
      prompt: args.prompt,
    });
  }
  if (providerId === "gemini") {
    return callGemini({ apiKey: cfg.apiKey, model: args.model, prompt: args.prompt });
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
};

export async function pingProvider(providerId: ProviderId, settings: SettingsBlob): Promise<{ ok: boolean; message: string }> {
  try {
    const cfg = settings.providers[providerId];
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
