import { GoogleGenerativeAI } from "@google/generative-ai";

interface Args {
  apiKey: string;
  model: string;
  prompt: string;
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
  const r = await model.generateContent(args.prompt);
  return r.response.text();
}
