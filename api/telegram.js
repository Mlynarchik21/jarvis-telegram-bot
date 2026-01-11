import { kv } from "@vercel/kv";
import { openaiAnswer } from "../lib/openai.js";

// ---------------- helpers ----------------
function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function readUpdate(req) {
  if (req.body && typeof req.body === "object") return req.body;

  let raw = "";
  await new Promise((resolve) => {
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", resolve);
  });

  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function tgCall(token, method, payload) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Telegram ${method} failed: ${res.status} ${t}`);
  }
  return res.json();
}

async function sendMessage(token, chatId, text, replyMarkup) {
  return tgCall(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

async function answerCallbackQuery(token, id) {
  return tgCall(token, "answerCallbackQuery", {
    callback_query_id: id,
    text: "Ок",
    show_alert: false,
  });
}

async function sendChatAction(token, chatId) {
  // typing (не критично, если не получится)
  try {
    await tgCall(token, "sendChatAction", { chat_id: chatId, action: "typing" });
  } catch {}
}

function buildConfirmKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "✅ Сохранить", callback_data: "confirm:save" },
        { text: "✏️ Изменить", callback_data: "confirm:edit" },
        { text: "❌ Отмена", callback_data: "confirm:cancel" },
      ],
    ],
  };
}

function extractFirstUrl(text) {
  const m = String(text).match(/https?:\/\/[^\s)]+/i);
  return m ? m[0] : null;
}

// ---------------- storage (KV) ----------------
async function setPending(userId, obj) {
  await kv.set(`pending:${userId}`, obj, { ex: 60 * 30 }); // 30 мин
}
async function getPending(userId) {
  return (await kv.get(`pending:${userId}`)) ?? null;
}
async function clearPending(userId) {
  await kv.del(`pending:${userId}`);
}

async function addNote(userId, text) {
  const item = { id: crypto.randomUUID(), text, createdAt: Date.now() };
  await kv.lpush(`notes:${userId}`, JSON.stringify(item));
  await kv.ltrim(`notes:${userId}`, 0, 49);
  return item;
}
async function listNotes(userId, limit = 5) {
  const raw = await kv.lrange(`notes:${userId}`, 0, limit - 1);
  return raw
    .map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function addToHistory(userId, role, text) {
  const item = { role, text, at: Date.now() };
  await kv.lpush(`hist:${userId}`, JSON.stringify(item));
  await kv.ltrim(`hist:${userId}`, 0, 7); // 8 сообщений
}
async function getHistory(userId) {
  const raw = await kv.lrange(`hist:${userId}`, 0, 7);
  return raw
    .map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .reverse();
}

// ---------------- intent ----------------
function detectMode(text) {
  const t = text.toLowerCase();

  if (
    t.startsWith("дай ссылку") ||
    t.startsWith("пришли ссылку") ||
    t.startsWith("скинь ссылку") ||
    t.includes("только ссылку") ||
    t.includes("ссылка на")
  )
    return "LINK_ONLY";

  if (
    t.startsWith("расскажи") ||
    t.startsWith("объясни") ||
    t.includes("подробно") ||
    t.includes("детально")
  )
    return "DETAILED";

  return "NORMAL";
}

function parseReminder(text) {
  const t = text.trim();

  // напомни через N минут/часов ...
  const m1 = t.match(/напомни\s+через\s+(\d+)\s*(минут|мин|час|часа|часов)\s+(.+)/i);
  if (m1) {
    const n = parseInt(m1[1], 10);
    const unit = m1[2].toLowerCase();
    const body = m1[3].trim();
    const ms = unit.startsWith("мин") ? n * 60_000 : n * 3_600_000;
    return { fireAt: Date.now() + ms, body };
  }

  // напомни завтра в HH:MM ...
  const m2 = t.match(/напомни\s+завтра\s+в\s+(\d{1,2}):(\d{2})\s+(.+)/i);
  if (m2) {
    const hh = Number(m2[1]);
    const mm = Number(m2[2]);
    const body = m2[3].trim();
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    tomorrow.setHours(hh, mm, 0, 0);
    return { fireAt: tomorrow.getTime(), body };
  }

  return null;
}

// ---------------- handler ----------------
export default async function handler(req, res) {
  try {
    const BOT_TOKEN = requireEnv("BOT_TOKEN");
    requireEnv("OPENAI_API_KEY"); // чтобы сразу ловить проблему

    if (req.method !== "POST") {
      res.status(200).send("OK");
      return;
    }

    const update = await readUpdate(req);
    if (!update) {
      res.status(200).json({ ok: true });
      return;
    }

    // ---------- callbacks ----------
    if (update.callback_query) {
      const cq = update.callback_query;
      const userId = cq.from?.id;
      const chatId = cq.message?.chat?.id;
      const data = cq.data ?? "";

      await answerCallbackQuery(BOT_TOKEN, cq.id);

      if (!userId || !chatId) return res.status(200).json({ ok: true });

      const pending = await getPending(userId);

      if (data === "confirm:save") {
        if (pending?.intent === "create_note") {
          const created = await addNote(userId, pending.fields.text);
          await clearPending(userId);
          await sendMessage(
            BOT_TOKEN,
            chatId,
            `Готово ✅\n\n<b>Заметка:</b>\n${escapeHtml(created.text)}`
          );
        } else {
          await sendMessage(BOT_TOKEN, chatId, "Нечего сохранять 🙂");
        }
        return res.status(200).json({ ok: true });
      }

      if (data === "confirm:edit") {
        if (pending) {
          await setPending(userId, { ...pending, mode: "editing" });
          await sendMessage(BOT_TOKEN, chatId, "Ок. Пришли новый текст одним сообщением ✍️");
        } else {
          await sendMessage(BOT_TOKEN, chatId, "Нечего редактировать 🙂");
        }
        return res.status(200).json({ ok: true });
      }

      if (data === "confirm:cancel") {
        await clearPending(userId);
        await sendMessage(BOT_TOKEN, chatId, "Отменено ❌");
        return res.status(200).json({ ok: true });
      }

      return res.status(200).json({ ok: true });
    }

    // ---------- message ----------
    const msg = update.message;
    if (!msg?.text) return res.status(200).json({ ok: true });

    const chatId = msg.chat?.id;
    const userId = msg.from?.id;
    const text = msg.text.trim();

    if (!chatId || !userId) return res.status(200).json({ ok: true });

    // editing note flow
    const prevPending = await getPending(userId);
    if (prevPending?.mode === "editing") {
      await setPending(userId, { intent: prevPending.intent, fields: { text }, mode: "draft" });
      await sendMessage(
        BOT_TOKEN,
        chatId,
        `Обновил ✏️\n\n<b>Заметка:</b>\n${escapeHtml(text)}\n\nСохранить?`,
        buildConfirmKeyboard()
      );
      return res.status(200).json({ ok: true });
    }

    // /start
    if (text.toLowerCase() === "/start") {
      await sendMessage(
        BOT_TOKEN,
        chatId,
        "Привет 🙂\n\n" +
          "• обычный текст — отвечаю\n" +
          "• <b>заметка: ...</b> — сохранить\n" +
          "• <b>заметки</b> — показать\n" +
          "• <b>напомни через 10 минут ...</b>\n\n" +
          "Подсказка: «дай ссылку на ...» — отвечу только URL."
      );
      return res.status(200).json({ ok: true });
    }

    // list notes
    if (text.toLowerCase() === "заметки" || text.toLowerCase() === "/notes") {
      const notes = await listNotes(userId, 5);
      if (!notes.length) {
        await sendMessage(BOT_TOKEN, chatId, "Пока нет заметок.");
      } else {
        const lines = notes.map((n, i) => `${i + 1}) ${escapeHtml(n.text)}`);
        await sendMessage(BOT_TOKEN, chatId, `<b>Заметки:</b>\n` + lines.join("\n"));
      }
      return res.status(200).json({ ok: true });
    }

    // create note
    if (text.toLowerCase().startsWith("заметка:") || text.toLowerCase().startsWith("note:")) {
      const noteText = text.split(":").slice(1).join(":").trim();
      if (!noteText) {
        await sendMessage(BOT_TOKEN, chatId, "Напиши так: <b>заметка: купить молоко</b>");
        return res.status(200).json({ ok: true });
      }

      await setPending(userId, { intent: "create_note", fields: { text: noteText }, mode: "draft" });
      await sendMessage(
        BOT_TOKEN,
        chatId,
        `Сохранить заметку?\n\n<b>${escapeHtml(noteText)}</b>`,
        buildConfirmKeyboard()
      );
      return res.status(200).json({ ok: true });
    }

    // ✅ reminders (НЕ отдаём в GPT)
    if (text.toLowerCase().startsWith("напомни")) {
      const r = parseReminder(text);
      if (!r) {
        await sendMessage(
          BOT_TOKEN,
          chatId,
          "Пример:\n• напомни через 10 минут купить воду\n• напомни завтра в 09:00 оплатить интернет"
        );
        return res.status(200).json({ ok: true });
      }

      const id = crypto.randomUUID();
      await kv.set(`reminder:${id}`, { chatId, text: r.body }, { ex: 60 * 60 * 24 * 30 });
      await kv.zadd("reminders:due", { score: r.fireAt, member: id });

      const when = new Date(r.fireAt).toLocaleString("ru-RU");
      await sendMessage(
        BOT_TOKEN,
        chatId,
        `Ок 👍 Напомню: <b>${escapeHtml(r.body)}</b>\nКогда: ${escapeHtml(when)}`
      );
      return res.status(200).json({ ok: true });
    }

    // ---------- GPT chat ----------
    await sendChatAction(BOT_TOKEN, chatId);

    const mode = detectMode(text);

    await addToHistory(userId, "user", text);
    const history = await getHistory(userId);
    const context = history
      .map((m) => (m.role === "user" ? `Пользователь: ${m.text}` : `Ассистент: ${m.text}`))
      .join("\n");

    const persona =
      "Ты — личный ассистент по имени Джарвис. " +
      "НЕ говори, что ты бот/ИИ/модель, если тебя не спрашивают. " +
      "Отвечай точно под запрос пользователя.";

    let rules = "";
    let maxTokens = 320;

    if (mode === "LINK_ONLY") {
      rules = "Ответь ТОЛЬКО одним URL. Без пояснений. Без списка. Без источников.";
      maxTokens = 80;
    } else if (mode === "DETAILED") {
      rules = "Ответь развёрнуто: сначала кратко, потом объяснение и шаги.";
      maxTokens = 700;
    } else {
      rules = "Отвечай кратко и по делу (1–6 предложений). Если нужно — предложи «подробнее».";
      maxTokens = 320;
    }

    const prompt = `${persona}\n${rules}\n\nКонтекст:\n${context}\n\nЗапрос:\n${text}`;

    const { text: answer } = await openaiAnswer({ prompt, maxTokens });

    if (mode === "LINK_ONLY") {
      const url = extractFirstUrl(answer);
      const out = url ?? "Не нашёл точную ссылку — уточни название.";
      await addToHistory(userId, "assistant", out);
      await sendMessage(BOT_TOKEN, chatId, escapeHtml(out));
      return res.status(200).json({ ok: true });
    }

    await addToHistory(userId, "assistant", answer);
    await sendMessage(BOT_TOKEN, chatId, answer);

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    // Telegram не любит 500
    return res.status(200).json({ ok: true });
  }
}
