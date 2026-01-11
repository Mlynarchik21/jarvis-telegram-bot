import { kv } from "@vercel/kv";

const NOTES_LIMIT = 50;

export async function setPending(userId, pendingAction) {
  await kv.set(`pending:${userId}`, pendingAction, { ex: 60 * 30 }); // 30 минут
}

export async function getPending(userId) {
  return (await kv.get(`pending:${userId}`)) ?? null;
}

export async function clearPending(userId) {
  await kv.del(`pending:${userId}`);
}

export async function addNote(userId, noteText) {
  const item = {
    id: crypto.randomUUID(),
    text: noteText,
    createdAt: new Date().toISOString()
  };

  const key = `notes:${userId}`;
  await kv.lpush(key, JSON.stringify(item));
  await kv.ltrim(key, 0, NOTES_LIMIT - 1);

  return item;
}

export async function listNotes(userId, limit = 5) {
  const key = `notes:${userId}`;
  const raw = await kv.lrange(key, 0, limit - 1);
  return raw
    .map((s) => {
      try { return JSON.parse(s); } catch { return null; }
    })
    .filter(Boolean);
}
