import { GoogleGenerativeAI } from "@google/generative-ai";
import type { ProviderUsage } from "../types";

interface Args {
  apiKey: string;
  model: string;
  prompt: string;
  /** Per-call timeout in ms — comes from per-provider advanced settings, default 60_000.
   *  The Gemini SDK doesn't expose a timeout option directly, so we race the call against
   *  a timer. */
  timeoutMs: number;
}

export interface CallResult {
  text: string;
  usage: ProviderUsage;
}

const ZERO_USAGE: ProviderUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };

export async function callGemini(args: Args): Promise<CallResult> {
  const genAI = new GoogleGenerativeAI(args.apiKey);
  const model = genAI.getGenerativeModel({
    model: args.model,
    generationConfig: {
      temperature: 0.8,
      responseMimeType: "application/json",
    },
  });
  // The SDK's GenerateContentResponse exposes both text() and usageMetadata. We pull
  // both off the same response so token counts match the text we actually got back.
  const callPromise = model.generateContent(args.prompt).then((r) => {
    const text = r.response.text();
    const meta = (r.response as unknown as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number } }).usageMetadata;
    const usage: ProviderUsage = meta
      ? {
          inputTokens: Number(meta.promptTokenCount ?? 0),
          outputTokens: Number(meta.candidatesTokenCount ?? 0),
          cachedInputTokens: Number(meta.cachedContentTokenCount ?? 0),
        }
      : ZERO_USAGE;
    return { text, usage };
  });
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Gemini: timed out after ${args.timeoutMs / 1000}s waiting for response`)), args.timeoutMs);
  });
  return Promise.race([callPromise, timeoutPromise]);
}
