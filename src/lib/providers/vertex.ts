// Vertex AI provider — mirrors Drop Sherlock's vertex_ai.py shape (two auth modes,
// OAuth2 access-token caching, regional vs global endpoint selection).
//
// Two modes, auto-selected by which creds are filled:
//
//   1. Service Account JSON (enterprise) — mint an OAuth2 access token via
//      google-auth-library, hit the regional aiplatform endpoint against a specific
//      project. Required: serviceAccountJson + projectId + location.
//   2. Express (API key) — global aiplatform endpoint via `?key=`. Required: apiKey.
//
// Request/response shape is the standard Gemini schema (systemInstruction + contents +
// generationConfig). Vertex Gemini 2.0+ auto-caches identical prefixes ≥1024 tokens; the
// restructured prompts.ts template puts all stable content first to maximize cache hits.

import { JWT } from "google-auth-library";

interface Args {
  serviceAccountJson?: string;
  apiKey?: string;
  projectId?: string;
  location?: string;
  model: string;
  prompt: string;
  timeoutMs: number;
}

// Module-level cache of OAuth2 access tokens. Vertex tokens are valid ~1 hour; we keep
// each token until ~10 min before expiry so a long batch run never trips a 401 mid-flight.
// Keyed by client_email so swapping the SA JSON in Settings doesn't keep serving a stale
// token from a previous identity.
interface CachedToken { token: string; expiresAtMs: number; }
const _vertexTokenCache = new Map<string, CachedToken>();
const TOKEN_REFRESH_LEAD_MS = 60_000; // refresh 1 min before expiry

async function mintVertexAccessToken(serviceAccountJson: string): Promise<string> {
  let info: { client_email?: string; private_key?: string; project_id?: string };
  try {
    info = JSON.parse(serviceAccountJson);
  } catch (e) {
    throw new Error(`Vertex AI: service_account_json is not valid JSON — ${e instanceof Error ? e.message : String(e)}`);
  }
  const email = info.client_email;
  const key = info.private_key;
  if (!email || !key) {
    throw new Error("Vertex AI: service_account_json missing client_email or private_key");
  }
  const cached = _vertexTokenCache.get(email);
  const now = Date.now();
  if (cached && cached.expiresAtMs > now + TOKEN_REFRESH_LEAD_MS) {
    return cached.token;
  }
  const jwt = new JWT({
    email,
    key,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  try {
    const tok = await jwt.authorize();
    if (!tok.access_token) throw new Error("token mint returned no access_token");
    const expiresAtMs = tok.expiry_date ?? (now + 3300_000); // fallback ~55min
    _vertexTokenCache.set(email, { token: tok.access_token, expiresAtMs });
    return tok.access_token;
  } catch (e) {
    throw new Error(`Vertex AI: failed to mint OAuth2 access token — ${e instanceof Error ? e.message : String(e)}`);
  }
}

interface GenerateBody {
  contents: Array<{ role: "user"; parts: Array<{ text: string }> }>;
  generationConfig: { responseMimeType: string; temperature?: number };
}

interface UsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  /** Vertex Gemini 2.0+ implicit-cache hit count — present only when caching kicked in. */
  cachedContentTokenCount?: number;
}
interface VertexResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: UsageMetadata;
  error?: { message?: string; code?: number; status?: string };
}

export interface CallResult {
  text: string;
  usage: import("../types").ProviderUsage;
}

export async function callVertex(args: Args): Promise<CallResult> {
  const { model, prompt, timeoutMs } = args;
  const sa = (args.serviceAccountJson ?? "").trim();
  const apiKey = (args.apiKey ?? "").trim();

  const body: GenerateBody = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0.8 },
  };

  let url: string;
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (sa) {
    const projectId = (args.projectId ?? "").trim();
    const location = (args.location ?? "").trim();
    if (!projectId) throw new Error("Vertex AI: projectId required for service-account mode");
    if (!location) throw new Error("Vertex AI: location required for service-account mode");
    const token = await mintVertexAccessToken(sa);
    headers["Authorization"] = `Bearer ${token}`;
    url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:generateContent`;
  } else if (apiKey) {
    // Vertex Express — global endpoint, no project/location.
    url = `https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  } else {
    throw new Error("Vertex AI: neither service_account_json nor api_key is set");
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof Error && (e.name === "TimeoutError" || /timeout/i.test(msg))) {
      throw new Error(`Vertex AI: timed out after ${timeoutMs / 1000}s waiting for response`);
    }
    throw new Error(`Vertex AI: network error — ${msg}`);
  }

  const text = await res.text();
  let data: VertexResponse | null = null;
  try { data = text ? (JSON.parse(text) as VertexResponse) : null; } catch { /* fall through */ }

  if (!res.ok) {
    const reason = data?.error?.message ?? text.slice(0, 400) ?? res.statusText;
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Vertex AI: ${res.status} ${reason}. Check the service-account JSON / API key and that Vertex AI is enabled on the project.`);
    }
    if (res.status === 404) {
      throw new Error(`Vertex AI: 404 — model "${model}" not found in region or project doesn't have it enabled. (${reason})`);
    }
    if (res.status === 429) {
      // Surface as rate-limit so the loop's retry logic picks it up.
      throw new Error(`Vertex AI: 429 rate limit — ${reason}`);
    }
    throw new Error(`Vertex AI: ${res.status} ${reason}`);
  }

  // Cache observability — log when an implicit cache hit happened so the user can verify
  // caching is working. Only logs to dev console; doesn't affect job state.
  const usage = data?.usageMetadata;
  if (usage?.cachedContentTokenCount) {
    console.log(`[vertex] cache hit: ${usage.cachedContentTokenCount}/${usage.promptTokenCount ?? "?"} prompt tokens served from cache (model=${model})`);
  }

  const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof content !== "string") {
    throw new Error(`Vertex AI: response missing candidates[0].content.parts[0].text. Raw: ${text.slice(0, 300)}`);
  }
  return {
    text: content,
    usage: {
      inputTokens: Number(usage?.promptTokenCount ?? 0),
      outputTokens: Number(usage?.candidatesTokenCount ?? 0),
      cachedInputTokens: Number(usage?.cachedContentTokenCount ?? 0),
    },
  };
}

/** Free test-connection — lists publisher models without burning quota. Mirrors
 *  Drop Sherlock's _test_service_account / _test_api_key. */
export async function pingVertex(args: {
  serviceAccountJson?: string; apiKey?: string; projectId?: string; location?: string; timeoutMs: number;
}): Promise<{ ok: boolean; message: string }> {
  const sa = (args.serviceAccountJson ?? "").trim();
  const apiKey = (args.apiKey ?? "").trim();
  const headers: Record<string, string> = {};
  let url: string;
  let mode: string;

  try {
    if (sa) {
      const projectId = (args.projectId ?? "").trim();
      const location = (args.location ?? "").trim();
      if (!projectId) return { ok: false, message: "Vertex AI: projectId required for service-account mode" };
      if (!location) return { ok: false, message: "Vertex AI: location required for service-account mode" };
      const token = await mintVertexAccessToken(sa);
      headers["Authorization"] = `Bearer ${token}`;
      url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models`;
      mode = "service-account";
    } else if (apiKey) {
      url = `https://aiplatform.googleapis.com/v1/publishers/google/models?key=${encodeURIComponent(apiKey)}`;
      mode = "express (API key)";
    } else {
      return { ok: false, message: "Vertex AI: no credentials configured (need either Service Account JSON or API key)" };
    }
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(args.timeoutMs) });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: `Vertex AI rejected credentials (${res.status}): ${text.slice(0, 200)}` };
    }
    if (!res.ok) {
      return { ok: false, message: `Vertex AI returned ${res.status}: ${text.slice(0, 200)}` };
    }
    let count = 0;
    try {
      const data = JSON.parse(text) as { publisherModels?: unknown[]; models?: unknown[] };
      count = (data.publisherModels?.length ?? data.models?.length ?? 0);
    } catch { /* ignore */ }
    return { ok: true, message: `OK — Vertex AI reachable (${mode}, ${count} publisher models)` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
