import OpenAI from "openai";

interface Args {
  apiKey: string;
  baseUrl: string;
  model: string;
  prompt: string;
  providerId: "openrouter";
  /** Per-call timeout in ms — comes from per-provider advanced settings, default 60_000. */
  timeoutMs: number;
}

export async function callOpenAICompatible(args: Args): Promise<string> {
  const { apiKey, baseUrl, model, prompt, providerId, timeoutMs } = args;
  const label = "OpenRouter";

  const headers: Record<string, string> = {
    "HTTP-Referer": "https://localhost/ai-anchor-generator",
    "X-Title": "AI Anchor Generator",
  };

  // Explicit per-call timeout + limited internal retries (1 retry beyond the initial
  // attempt). The OpenAI SDK defaults are 10 minutes / 2 retries — when the upstream
  // provider hangs or terminates the connection that default lets one batch block for
  // up to ~30 minutes silently. With these limits, a stuck call surfaces as an
  // APIConnectionError within ~2× timeoutMs total and bubbles up to processBatch.
  const client = new OpenAI({ apiKey, baseURL: baseUrl, defaultHeaders: headers, timeout: timeoutMs, maxRetries: 1 });

  try {
    try {
      const r = await client.chat.completions.create({
        model,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        temperature: 0.8,
      });
      return r.choices[0]?.message?.content ?? "";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/response_format|json_object/i.test(msg)) {
        const r = await client.chat.completions.create({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.8,
        });
        return r.choices[0]?.message?.content ?? "";
      }
      throw e;
    }
  } catch (e) {
    throw rewrapProviderError(e, label, providerId);
  }
}

function rewrapProviderError(e: unknown, label: string, _providerId: "openrouter"): Error {
  const status = (e as { status?: number })?.status;
  const raw = e instanceof Error ? e.message : String(e);

  // The OpenAI SDK falls back to "...find your API key at https://platform.openai.com..." when
  // the underlying provider returns a 401 without a parseable body. Replace it with the right URL.
  let cleaned = raw.replace(/https:\/\/platform\.openai\.com[^\s"]*/g, "https://openrouter.ai/keys");
  cleaned = cleaned.replace(/you can find your API key/i, `you can find your ${label} API key`);

  if (status === 401) {
    return new Error(`${label}: 401 Unauthorized. Check that your API key is valid and has access to model "${tryExtractModel(raw)}". (${cleaned})`);
  }
  if (status === 404) {
    return new Error(`${label}: 404 Not Found. The model name may be wrong or unavailable to your account. (${cleaned})`);
  }
  return new Error(`${label}: ${cleaned}`);
}

function tryExtractModel(raw: string): string {
  const m = raw.match(/model[:= "']+([\w\/.\-:]+)/i);
  return m?.[1] ?? "?";
}
