import OpenAI from "openai";

// SDK сам читает OPENAI_API_KEY из env. :contentReference[oaicite:4]{index=4}
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function openaiAnswer({ userText, maxOutputTokens = 350 }) {
  // Responses API (рекомендуется для новых проектов) :contentReference[oaicite:5]{index=5}
  const resp = await client.responses.create({
    model: "gpt-4.1-mini",
    max_output_tokens: maxOutputTokens,
    input: userText
  });

  // Текст ответа
  const text = resp.output_text?.trim() || "Не получилось сформировать ответ.";
  return { text };
}
