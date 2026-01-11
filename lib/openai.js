import OpenAI from "openai";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const client = new OpenAI({
  apiKey: requireEnv("OPENAI_API_KEY"),
});

export async function openaiAnswer({ prompt, maxTokens = 320 }) {
  // Responses API
  const resp = await client.responses.create({
    model: "gpt-4.1-mini",
    input: prompt,
    max_output_tokens: maxTokens,
  });

  const text = resp.output_text?.trim();
  return { text: text || "Не удалось получить ответ." };
}
