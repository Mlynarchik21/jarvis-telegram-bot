import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function openaiAnswer({ prompt, maxTokens = 300 }) {
  const r = await client.responses.create({
    model: "gpt-4.1-mini",
    input: prompt,
    max_output_tokens: maxTokens,
  });

  const text = r.output_text?.trim();
  return { text: text || "Не удалось получить ответ." };
}
