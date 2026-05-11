import { GoogleGenerativeAI } from "@google/generative-ai";

interface Args {
  apiKey: string;
  model: string;
  prompt: string;
  /** Per-call timeout in ms — comes from per-provider advanced settings, default 60_000.
   *  The Gemini SDK doesn't expose a timeout option directly, so we race the call against
   *  a timer. */
  timeoutMs: number;
}

export async function callGemini(args: Args): Promise<string> {
  const genAI = new GoogleGenerativeAI(args.apiKey);
  const model = genAI.getGenerativeModel({
    model: args.model,
    generationConfig: {
      temperature: 0.8,
      responseMimeType: "application/json",
    },
  });
  const callPromise = model.generateContent(args.prompt).then((r) => r.response.text());
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Gemini: timed out after ${args.timeoutMs / 1000}s waiting for response`)), args.timeoutMs);
  });
  return Promise.race([callPromise, timeoutPromise]);
}
