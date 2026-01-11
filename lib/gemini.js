function withTimeout(ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(id) };
}

export async function geminiAnswer({ apiKey, userText }) {
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

  const body = {
    contents: [{ parts: [{ text: userText }] }],
    tools: [{ google_search: {} }]
  };

  const t = withTimeout(12000);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "content-type": "application/json"
      },
      body: JSON.stringify(body),
      signal: t.signal
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Gemini HTTP ${res.status}: ${txt.slice(0, 300)}`);
    }

    const json = await res.json();

    const text =
      json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("")?.trim() ||
      "Не получилось сгенерировать ответ.";

    const chunks = json?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    const sources = chunks
      .map((c) => c?.web)
      .filter(Boolean)
      .map((w) => ({ title: w.title, uri: w.uri }))
      .slice(0, 3);

    return { text, sources };
  } catch (e) {
    const msg = String(e?.message || e);

    if (msg.includes("AbortError") || msg.includes("aborted")) {
      return {
        text:
          "Похоже, сервис не ответил вовремя. Возможно, есть сетевые/региональные ограничения.\n" +
          "Если хочешь — подключим альтернативный AI API.",
        sources: [],
        error: msg
      };
    }

    return {
      text:
        "Не удалось получить ответ от AI-сервиса. Возможно, он недоступен в твоём регионе.\n" +
        "Если хочешь — подключим альтернативный AI API.",
      sources: [],
      error: msg
    };
  } finally {
    t.cancel();
  }
}
