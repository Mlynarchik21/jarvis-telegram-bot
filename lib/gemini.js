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
    t.includes("сейчас") ||
    t.includes("сегодня") ||
    t.includes("актуально")
  );
}

async function callGeminiOnce({ apiKey, userText, maxOutputTokens }) {
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

  const body = {
    contents: [{ parts: [{ text: userText }] }],
    generationConfig: { maxOutputTokens },
    ...(needsWebSearch(userText) ? { tools: [{ google_search: {} }] } : {})
  };

  const t = withTimeout(9000);
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
      throw new Error(`Gemini HTTP ${res.status}: ${txt.slice(0, 250)}`);
    }

    const json = await res.json();

    const parts = json?.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((p) => p.text ?? "").join("").trim() || "Не получилось сформировать ответ.";

    // Источники иногда идут редиректами — мы будем их показывать только в “подробно”
    const chunks = json?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    const sources = chunks
      .map((c) => c?.web)
      .filter(Boolean)
      .map((w) => ({ title: w.title, uri: w.uri }))
      .slice(0, 3);

    return { text, sources };
  } finally {
    t.cancel();
  }
}

export async function geminiAnswer({ apiKey, userText, maxOutputTokens = 350 }) {
  try {
    return await callGeminiOnce({ apiKey, userText, maxOutputTokens });
  } catch (e) {
    // один быстрый ретрай
    return await callGeminiOnce({ apiKey, userText, maxOutputTokens });
  }
}
