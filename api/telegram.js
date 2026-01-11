import { parseUserText } from "../lib/parse.js";
import { sendMessage, answerCallbackQuery } from "../lib/tg.js";
import { setPending, getPending, clearPending, addNote, listNotes } from "../lib/store.js";
import { geminiAnswer } from "../lib/gemini.js";
import { addToHistory, getHistory } from "../lib/memory.js";
import { kv } from "@vercel/kv";
import { parseReminder } from "../lib/remind_parse.js";
import { togetherAnswer } from "../lib/together.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function escapeHtml(s) {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function buildConfirmKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "✅ Сохранить", callback_data: "confirm:save" },
        { text: "✏️ Изменить", callback_data: "confirm:edit" },
        { text: "❌ Отмена", callback_data: "confirm:cancel" }
      ]
    ]
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
  try { return JSON.parse(raw); } catch { return null; }
}

function detectMode(userText) {
  const t = userText.toLowerCase();

  if (
    t.startsWith("дай ссылку") ||
    t.startsWith("пришли ссылку") ||
    t.startsWith("скинь ссылку") ||
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

async function sendChatAction(token, chatId) {
  const url = `https://api.telegram.org/bot${token}/sendChatAction`;
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" })
  }).catch(() => {});
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.status(200).send("OK");
      return;
    }

    const BOT_TOKEN = requireEnv("BOT_TOKEN");
    const update = await readUpdate(req);
    if (!update) return res.status(200).json({ ok: true });

    // ===== Кнопки =====
    if (update.callback_query) {
      const cq = update.callback_query;
      const userId = cq.from?.id;
      const chatId = cq.message?.chat?.id;
      const data = cq.data ?? "";

      await answerCallbackQuery(BOT_TOKEN, cq.id, "Ок");

      if (!userId || !chatId) return res.status(200).json({ ok: true });

      const pending = await getPending(userId);

      if (data === "confirm:save") {
        if (!pending) {
          await sendMessage(BOT_TOKEN, chatId, "Нечего подтверждать 🙂");
        } else if (pending.intent === "create_note") {
          const created = await addNote(userId, pending.fields.text);
          await clearPending(userId);
          await sendMessage(BOT_TOKEN, chatId, `Готово ✅\n\n<b>Заметка:</b>\n${escapeHtml(created.text)}`);
        }
        return res.status(200).json({ ok: true });
      }

      if (data === "confirm:edit") {
        if (!pending) {
          await sendMessage(BOT_TOKEN, chatId, "Нечего редактировать 🙂");
        } else {
          await setPending(userId, { ...pending, mode: "editing" });
          await sendMessage(BOT_TOKEN, chatId, "Ок. Пришли новый текст одним сообщением ✍️");
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

    // ===== Сообщения =====
    const msg = update.message;
    if (!msg?.text) return res.status(200).json({ ok: true });

    const chatId = msg.chat?.id;
    const userId = msg.from?.id;
    const text = msg.text;

    if (!chatId || !userId) return res.status(200).json({ ok: true });

    // Если пользователь редактирует заметку
    const prevPending = await getPending(userId);
    if (prevPending?.mode === "editing") {
      const newPending = { intent: prevPending.intent, fields: { text }, mode: "draft" };
      await setPending(userId, newPending);

      await sendMessage(
        BOT_TOKEN,
        chatId,
        `Обновил черновик ✏️\n\n<b>Заметка:</b>\n${escapeHtml(text)}\n\nСохранить?`,
        buildConfirmKeyboard()
      );
      return res.status(200).json({ ok: true });
    }

    // ⚠️ ЖЁСТКИЙ ПЕРЕХВАТ “НАПОМНИ …” ДО ЛЮБЫХ ИИ
    if (text.trim().toLowerCase().startsWith("напомни")) {
      const r = parseReminder(text);
      if (!r) {
        await sendMessage(
          BOT_TOKEN,
          chatId,
          "Напиши так:\n" +
            "• напомни через 10 минут купить воду\n" +
            "• напомни через 2 часа позвонить\n" +
            "• напомни завтра в 09:00 оплатить интернет"
        );
        return res.status(200).json({ ok: true });
      }

      const id = crypto.randomUUID();
      await kv.set(`reminder:${id}`, { chatId, text: r.body }, { ex: 60 * 60 * 24 * 30 });
      await kv.zadd("reminders:due", { score: r.fireAt, member: id });

      const when = new Date(r.fireAt).toLocaleString("ru-RU");
      await sendMessage(BOT_TOKEN, chatId, `Ок 👍 Напомню: <b>${escapeHtml(r.body)}</b>\nКогда: ${escapeHtml(when)}`);

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
          "• <b>напомни через 10 минут ...</b>\n\n" +
          "Подсказка: «дай ссылку на ...» — отвечу только URL."
      );
      return res.status(200).json({ ok: true });
    }

    if (parsed.intent === "list_notes") {
      const notes = await listNotes(userId, 5);
      if (!notes.length) await sendMessage(BOT_TOKEN, chatId, "Пока нет заметок.");
      else {
        const lines = notes.map((n, i) => `${i + 1}) ${escapeHtml(n.text)}`);
        await sendMessage(BOT_TOKEN, chatId, `<b>Последние заметки:</b>\n` + lines.join("\n"));
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

    // ===== ЧАТ (Gemini → fallback Together) =====
    if (parsed.intent === "chat") {
      await sendChatAction(BOT_TOKEN, chatId);

      const mode = detectMode(parsed.fields.text);

      await addToHistory(userId, "user", parsed.fields.text);
      const history = await getHistory(userId);

      // контекст короткий (ускоряет и уменьшает “простыни”)
      const context = history
        .slice(-8)
        .map((m) => (m.role === "user" ? `Пользователь: ${m.text}` : `Ассистент: ${m.text}`))
        .join("\n");

      const persona =
        "Ты — личный ассистент по жизни по имени Джарвис. " +
        "НЕ говори, что ты бот/ИИ/модель, если тебя не спросили. " +
        "Отвечай максимально точно под запрос. ";

      let style = "";
      let maxTokens = 320;

      if (mode === "LINK_ONLY") {
        style =
          "Пользователь просит ссылку. Ответь ТОЛЬКО одной ссылкой (URL) и ничего больше.";
        maxTokens = 80;
      } else if (mode === "DETAILED") {
        style =
          "Ответь развёрнуто: короткое резюме, затем объяснение, затем шаги. ";
        maxTokens = 700;
      } else {
        style =
          "Отвечай кратко и по делу (1–6 предложений). " +
          "Если пользователь захочет — предложи сказать «подробнее». ";
        maxTokens = 300;
      }

      const prompt =
        persona +
        style +
        "\n\nКонтекст:\n" +
        context +
        "\n\nЗапрос пользователя:\n" +
        parsed.fields.text;

      let answerText = "";
      let sources = [];

      // 1) пробуем Gemini
      try {
        const apiKey = requireEnv("GEMINI_API_KEY");
        const out = await geminiAnswer({ apiKey, userText: prompt, maxOutputTokens: maxTokens });
        answerText = out.text;
        sources = out.sources ?? [];
      } catch {
        // 2) fallback Together
        const apiKey = requireEnv("TOGETHER_API_KEY");
        const messages = [
          { role: "system", content: persona + style },
          { role: "user", content: "Контекст:\n" + context + "\n\nЗапрос:\n" + parsed.fields.text }
        ];
        const out = await togetherAnswer({ apiKey, messages, maxTokens });
        answerText = out.text;
      }

      // ЖЁСТКОЕ ПРАВИЛО: режим “ссылка” → отправляем только URL
      if (mode === "LINK_ONLY") {
        const url = extractFirstUrl(answerText);
        await addToHistory(userId, "assistant", url ?? answerText);
        await sendMessage(BOT_TOKEN, chatId, url ? escapeHtml(url) : "Не нашёл точную ссылку — уточни название.");
        return res.status(200).json({ ok: true });
      }

      await addToHistory(userId, "assistant", answerText);

      // Источники показываем ТОЛЬКО в подробном режиме, чтобы не засорять
      let finalText = answerText;
      if (mode === "DETAILED" && sources.length) {
        finalText +=
          "\n\n<b>Источники:</b>\n" +
          sources.slice(0, 3).map((s, i) => `${i + 1}) ${escapeHtml(s.title)}\n${escapeHtml(s.uri)}`).join("\n");
      }

      await sendMessage(BOT_TOKEN, chatId, finalText);
      return res.status(200).json({ ok: true });
    }

    await sendMessage(BOT_TOKEN, chatId, "Не понял. Попробуй иначе 🙂");
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(200).json({ ok: true });
  }
}
