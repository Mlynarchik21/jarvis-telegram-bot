function withTimeout(ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(id) };
}

export async function geminiAnswer({ apiKey, userText }) {
  // Можно поменять модель позже, но начнём с этой
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

  const body = {
    contents: [{ parts: [{ text: userText }] }],
    tools: [{ google_search: {} }], // источники из поиска (если доступно)
  };

  const t = withTimeout(12000); // 12 сек — чтобы не висеть в Vercel
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: t.signal,
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      const short = txt?.slice(0, 300) || "";
      throw new Error(`Gemini HTTP ${res.status}: ${short}`);
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
    // Разруливаем типовые кейсы “не работает в регионе / сеть / таймаут”
    const msg = String(e?.message || e);

    if (msg.includes("aborted") || msg.includes("AbortError")) {
      return {
        text:
          "Похоже, AI-сервис не ответил вовремя (таймаут). Возможно, он недоступен из твоего региона или есть сетевые ограничения.\n\n" +
          "Хочешь — подключим альтернативный AI API.",
        sources: [],
        error: msg,
      };
    }

    return {
      text:
        "Не удалось подключиться к AI-сервису. Возможно, он недоступен из твоего региона.\n\n" +
        "Могу подключить альтернативный AI API (заменим провайдера без переделки бота).",
      sources: [],
      error: msg,
    };
  } finally {
    t.cancel();
  }
}
