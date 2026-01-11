function withTimeout(ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(id) };
}

// Together AI OpenAI-compatible chat endpoint
export async function togetherAnswer({ apiKey, messages, maxTokens = 350 }) {
  const url = "https://api.together.xyz/v1/chat/completions";

  // Бесплатная модель (можно сменить потом)
  const model = "meta-llama/Llama-3.3-70B-Instruct-Turbo-Free";

  const body = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature: 0.6
  };

  const t = withTimeout(10000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body),
      signal: t.signal
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Together HTTP ${res.status}: ${txt.slice(0, 250)}`);
    }

    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content?.trim() || "Не получилось сформировать ответ.";
    return { text };
  } finally {
    t.cancel();
  }
}
