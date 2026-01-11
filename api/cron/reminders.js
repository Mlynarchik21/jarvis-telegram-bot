import { kv } from "@vercel/kv";
import { sendMessage } from "../../lib/tg.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export default async function handler(req, res) {
  try {
    const BOT_TOKEN = requireEnv("BOT_TOKEN");
    const now = Date.now();

    // забираем до 50 напоминаний за один прогон
    const dueIds = await kv.zrangebyscore("reminders:due", 0, now, {
      limit: { offset: 0, count: 50 }
    });

    for (const id of dueIds) {
      const data = await kv.get(`reminder:${id}`);
      await kv.zrem("reminders:due", id);

      if (!data) continue;

      const { chatId, text } = data;
      await sendMessage(BOT_TOKEN, chatId, `⏰ <b>Напоминание</b>\n${escapeHtml(text)}`);
      await kv.del(`reminder:${id}`);
    }

    res.status(200).json({ ok: true, processed: dueIds.length });
  } catch (e) {
    console.error(e);
    res.status(200).json({ ok: true });
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
