import { kv } from "@vercel/kv";

const MAX = 20;

export async function addToHistory(userId, role, text) {
  const key = `hist:${userId}`;
  const item = { role, text, at: Date.now() };

  await kv.lpush(key, JSON.stringify(item));
  await kv.ltrim(key, 0, MAX - 1);
}

export async function getHistory(userId) {
  const key = `hist:${userId}`;
  const raw = await kv.lrange(key, 0, MAX - 1);

  // newest->oldest, разворачиваем
  return raw
    .map((s) => {
      try { return JSON.parse(s); } catch { return null; }
    })
    .filter(Boolean)
    .reverse();
}
