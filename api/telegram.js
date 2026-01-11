import { parseUserText } from "../lib/parse.js";
import { sendMessage, answerCallbackQuery } from "../lib/tg.js";
import { setPending, getPending, clearPending, addNote, listNotes } from "../lib/store.js";
import { addToHistory, getHistory } from "../lib/memory.js";
import { kv } from "@vercel/kv";
import { parseReminder } from "../lib/remind_parse.js";
import { openaiAnswer } from "../lib/openai.js";

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

function detectMode(text) {
  const t = text.toLowerCase();

  if (
    t.startsWith("дай ссылку") ||
    t.startsWith("пришли ссылку") ||
    t.startsWith("скинь ссылку") ||
    t.includes("только ссылку") ||
    t.includes("ссылка на")
  ) return "LINK_ONLY";

  if (
    t.startsWith("расскажи") ||
    t.startsWith("объясни") ||
    t.includes("подробно") ||
    t.includes("детально")
  ) return "DETAILED";

  return "NORMAL";
}

function extractFirstUrl(text) {
  const m = String(text).match(/https?:\/\/[^\s)]+/i);
  return m ? m[0] : null;
}

export default async function handler(req, res) {
  try {
    requireEnv("OPENAI_API_KEY");
    const BOT_TOKEN = requireEnv("BOT_TOKEN");

    if (req.method !== "POST") return res.status(200).send("OK");

    const update = await readUpdate(req);
    if (!update) return res.status(200).json({ ok: true });

    // ===== CALLBACKS =====
    if (update.callback_query) {
      const cq = update.callback_query;
      const userId = cq.from?.id;
      const chatId = cq.message?.chat?.id;
      const data = cq.data ?? "";

      await answerCallbackQuery(BOT_TOKEN, cq.id, "Ок");

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
        }
        return res.status(200).json({ ok: true });
      }

      if (data === "confirm:edit") {
        if (pending) {
          await setPending(userId, { ...pending, mode: "editing" });
          await sendMessage(BOT_TOKEN, chatId, "Ок. Пришли новый текст ✍️");
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

    // ===== MESSAGES =====
    const msg = update.message;
    if (!msg?.text) return res.status(200).json({ ok: true });

    const chatId = msg.chat?.id;
    const userId = msg.from?.id;
    const text = msg.text;

    if (!chatId || !userId) return res.status(200).json({ ok: true });

    // edit mode
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

    // 🔥 НАПОМИНАНИЯ — НЕ УХОДЯТ В ИИ
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

    const parsed = parseUserText(text);

    if (parsed.intent === "start") {
      await sendMessage(
        BOT_TOKEN,
        chatId,
        "Привет 🙂\n\n" +
          "• обычный текст — отвечаю\n" +
          "• <b>заметка: ...</b> — сохранить\n" +
          "• <b>заметки</b> — показать\n" +
          "• <b>напомни ...</b> — поставить напоминание\n\n" +
          "Подсказка: «дай ссылку на ...» — отвечу только URL."
      );
      return res.status(200).json({ ok: true });
    }

    if (parsed.intent === "list_notes") {
      const notes = await listNotes(userId, 5);
      if (!notes.length) await sendMessage(BOT_TOKEN, chatId, "Пока нет заметок.");
      else {
        const lines = notes.map((n, i) => `${i + 1}) ${escapeHtml(n.text)}`);
        await sendMessage(BOT_TOKEN, chatId, `<b>Заметки:</b>\n` + lines.join("\n"));
      }
      return res.status(200).json({ ok: true });
    }

    if (parsed.intent === "create_note") {
      await setPending(userId, { intent: "create_note", fields: parsed.fields, mode: "draft" });
      await sendMessage(
        BOT_TOKEN,
        chatId,
        `Сохранить заметку?\n\n<b>${escapeHtml(parsed.fields.text)}</b>`,
        buildConfirmKeyboard()
      );
      return res.status(200).json({ ok: true });
    }

    // ===== GPT CHAT =====
    if (parsed.intent === "chat") {
      const mode = detectMode(parsed.fields.text);

      await addToHistory(userId, "user", parsed.fields.text);
      const history = await getHistory(userId);

      const context = history
        .slice(-8)
        .map((m) => (m.role === "user" ? `Пользователь: ${m.text}` : `Ассистент: ${m.text}`))
        .join("\n");

      const persona =
        "Ты — личный ассистент по имени Джарвис. " +
        "НЕ говори, что ты бот или ИИ, если тебя не спросили. " +
        "Отвечай точно по запросу.";

      let rules = "";
      let maxTokens = 300;

      if (mode === "LINK_ONLY") {
        rules = "Ответь ТОЛЬКО одной ссылкой (URL). Без пояснений.";
        maxTokens = 80;
      } else if (mode === "DETAILED") {
        rules = "Ответь развёрнуто: сначала кратко, потом объяснение.";
        maxTokens = 700;
      } else {
        rules = "Отвечай кратко и по делу (1–6 предложений).";
        maxTokens = 320;
      }

      const prompt =
        `${persona}\n${rules}\n\n` +
        `Контекст:\n${context}\n\n` +
        `Запрос:\n${parsed.fields.text}`;

      const { text: answer } = await openaiAnswer({
        prompt,
        maxTokens,
      });

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
    }

    await sendMessage(BOT_TOKEN, chatId, "Не понял. Попробуй иначе 🙂");
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(200).json({ ok: true });
  }
}
