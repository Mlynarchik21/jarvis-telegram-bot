import { kv } from "@vercel/kv";

// helpers
function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function tgSend(token, chatId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Telegram sendMessage failed: ${res.status} ${t}`);
  }
}

export default async function handler(req, res) {
  try {
    const BOT_TOKEN = requireEnv("BOT_TOKEN");

    // Разрешаем вызывать только по GET/POST
    if (req.method !== "GET" && req.method !== "POST") {
      return res.status(200).send("OK");
    }

    const now = Date.now();

    // Берём все напоминания, срок которых <= сейчас
    // Мы храним id в ZSET "reminders:due" с score = fireAt (timestamp)
    const dueIds = await kv.zrange("reminders:due", 0, now, { byScore: true });

    if (!dueIds.length) {
      return res.status(200).json({ ok: true, sent: 0 });
    }

    let sent = 0;

    for (const id of dueIds) {
      const data = await kv.get(`reminder:${id}`);
      if (!data) {
        // если по какой-то причине записи нет — просто чистим очередь
        await kv.zrem("reminders:due", id);
        continue;
      }

      const { chatId, text } = data;

      try {
        await tgSend(BOT_TOKEN, chatId, `⏰ Напоминание: ${text}`);
        sent++;
      } catch (e) {
        console.error("Send reminder failed:", e);
      }

      // удаляем напоминание после отправки
      await kv.del(`reminder:${id}`);
      await kv.zrem("reminders:due", id);
    }

    return res.status(200).json({ ok: true, sent });
  } catch (e) {
    console.error("Cron error:", e);
    return res.status(200).json({ ok: true, error: true });
  }
}
