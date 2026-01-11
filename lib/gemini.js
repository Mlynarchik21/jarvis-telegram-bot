function withTimeout(ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(id) };
}

function needsWebSearch(userText) {
  const t = userText.toLowerCase();
  return (
    t.includes("ссылка") ||
    t.includes("официальный") ||
    t.includes("сайт") ||
    t.includes("новости") ||
    t.includes("что нового") ||
    t.includes("сейчас") ||
    t.includes("сегодня") ||
    t.includes("актуально") ||
    t.includes("цены") ||
    t.includes("адрес") ||
    t.includes("контакты")
  );
}

export async function geminiAnswer({ apiKey, userText, maxOutputTokens = 500 }) {
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

  const body = {
    contents: [{ parts: [{ text: userText }] }],
    generationConfig: {
      maxOutputTokens
    },
    ...(needsWebSearch(userText) ? { tools: [{ google_search: {} }] } : {})
  };

  const t = withTimeout(10000);

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

    const parts = json?.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((p) => p.text ?? "").join("").trim() || "Не получилось сформировать ответ.";

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
          "Я завис на запросе и не успел ответить вовремя. Попробуй переформулировать короче или скажи: «кратко» / «только ссылка».",
        sources: [],
        error: msg
      };
    }

    return {
      text:
        "Не получилось получить ответ (возможно, ограничение доступа/сети). Попробуй ещё раз или напиши «кратко».",
      sources: [],
      error: msg
    };
  } finally {
    t.cancel();
  }
}
