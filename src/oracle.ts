export interface Fortune {
  answer: string;
  model: string;
}

export interface GenerateFortuneOptions {
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export async function generateFortune(
  options: GenerateFortuneOptions,
): Promise<Fortune> {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const response = await fetchImplementation(
    options.baseUrl.replace(/\/$/, "") + "/api/chat",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: options.model,
        stream: false,
        messages: [
          {
            role: "system",
            content: "You are a magic 8-ball. Reply with a short prediction.",
          },
          { role: "user", content: "Reveal the answer now." },
        ],
        options: { temperature: 1, num_predict: 24 },
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    },
  );

  if (!response.ok) {
    throw new Error("The AI oracle returned HTTP " + response.status + ".");
  }

  const body = await response.json() as { message: { content: string } };
  return { answer: body.message.content, model: options.model };
}
