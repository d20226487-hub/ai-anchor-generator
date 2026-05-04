interface Args {
  apiKey: string;
  baseUrl: string;
  model: string;
  prompt: string;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string; code?: string };
  message?: string;
}

export async function callGitHubModels(args: Args): Promise<string> {
  const { apiKey, baseUrl, model, prompt } = args;

  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

  const body = {
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.8,
    response_format: { type: "json_object" } as const,
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Token ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`GitHub Models: network error — ${e instanceof Error ? e.message : String(e)}`);
  }

  const text = await res.text();
  let data: ChatResponse | null = null;
  try {
    data = text ? (JSON.parse(text) as ChatResponse) : null;
  } catch {
    /* leave as null, surface raw text below */
  }

  if (!res.ok) {
    const reason =
      data?.error?.message ??
      data?.message ??
      text.slice(0, 400) ??
      res.statusText;
    if (res.status === 401) {
      throw new Error(`GitHub Models: 401 Unauthorized. Check your PAT has the "Models" permission and (if applicable) is SSO-authorized for your org. ${reason}`);
    }
    if (res.status === 404) {
      throw new Error(`GitHub Models: 404 Not Found. The model "${model}" may not exist or your account does not have access to it. ${reason}`);
    }
    if (res.status === 400) {
      // Retry without response_format — some models on GH Models reject it.
      if (/response_format|json_object/i.test(reason)) {
        return retryWithoutJsonFormat(url, apiKey, { model: body.model, messages: body.messages, temperature: body.temperature });
      }
      throw new Error(`GitHub Models: 400 Bad Request — ${reason}`);
    }
    throw new Error(`GitHub Models: ${res.status} — ${reason}`);
  }

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error(`GitHub Models: response missing message content. Raw: ${text.slice(0, 300)}`);
  }
  return content;
}

async function retryWithoutJsonFormat(
  url: string,
  apiKey: string,
  body: { model: string; messages: Array<{ role: string; content: string }>; temperature: number }
): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Token ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub Models: ${res.status} — ${text.slice(0, 400)}`);
  const data = JSON.parse(text) as ChatResponse;
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error(`GitHub Models: empty response`);
  return content;
}
