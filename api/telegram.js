import { parseUserText } from "../lib/parse.js";
import { sendMessage, answerCallbackQuery } from "../lib/tg.js";
import { setPending, getPending, clearPending, addNote, listNotes } from "../lib/store.js";
import { geminiAnswer } from "../lib/gemini.js";
import { addToHistory, getHistory } from "../lib/memory.js";
import { kv } from "@vercel/kv";
import { parseReminder } from "../lib/remind_parse.js";

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

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.status(200).send("OK");
      return;
    }

    const BOT_TOKEN = requireEnv("BOT_TOKEN");
    const update = await readUpdate(req);

    if (!update) {
      res.status(200).json({ ok: true });
      return;
    }

    // ===================== CALLBACKS (кнопки) =====================
    if (update.callback_query) {
      const cq = update.callback_query;
      const userId = cq.from?.id;
      const chatId = cq.message?.chat?.id;
      const data = cq.data ?? "";

      await answerCallbackQuery(BOT_TOKEN, cq.id, "Ок");

      if (!userId || !chatId) {
        res.status(200).json({ ok: true });
        return;
      }

      const pending = await getPending(userId);

      if (data === "confirm:save") {
        if (!pending) {
          await sendMessage(BOT_TOKEN, chatId, "Нечего подтверждать 🙂");
        } else if (pending.intent === "create_note") {
          const created = await addNote(userId, pending.fields.text);
          await clearPending(userId);

          await sendMessage(
            BOT_TOKEN,
            chatId,
            `Готово ✅\n\n<b>Заметка:</b>\n${escapeHtml(created.text)}`
          );
        } else {
          await sendMessage(BOT_TOKEN, chatId, "Пока подтверждение сделано только для заметок.");
        }

        res.status(200).json({ ok: true });
        return;
      }

      if (data === "confirm:edit") {
        if (!pending) {
          await sendMessage(BOT_TOKEN, chatId, "Нечего редактировать 🙂");
        } else {
          await setPending(userId, { ...pending, mode: "editing" });
          await sendMessage(BOT_TOKEN, chatId, "Ок. Пришли новый текст одним сообщением ✍️");
        }

        res.status(200).json({ ok: true });
        return;
      }

      if (data === "confirm:cancel") {
        await clearPending(userId);
        await sendMessage(BOT_TOKEN, chatId, "Отменено ❌");
        res.status(200).json({ ok: true });
        return;
      }

      res.status(200).json({ ok: true });
      return;
    }

    // ===================== MESSAGES =====================
    const msg = update.message;
    if (!msg?.text) {
      res.status(200).json({ ok: true });
      return;
    }

    const chatId = msg.chat?.id;
    const userId = msg.from?.id;
    const text = msg.text;

    if (!chatId || !userId) {
      res.status(200).json({ ok: true });
      return;
    }

    // режим редактирования черновика заметки
    const prevPending = await getPending(userId);
    if (prevPending?.mode === "editing") {
      const newPending = {
        intent: prevPending.intent,
        fields: { ...(prevPending.fields ?? {}), text },
        mode: "draft"
      };
      await setPending(userId, newPending);

      await sendMessage(
        BOT_TOKEN,
        chatId,
        `Обновил черновик ✏️\n\n<b>Заметка:</b>\n${escapeHtml(text)}\n\nСохранить?`,
        buildConfirmKeyboard()
      );

      res.status(200).json({ ok: true });
      return;
    }

    const parsed = parseUserText(text);

    // /start
    if (parsed.intent === "start") {
      await sendMessage(
        BOT_TOKEN,
        chatId,
        "Привет 🙂\n\n" +
          "Пиши обычным текстом — отвечу развёрнуто.\n\n" +
          "• <b>заметка: ...</b> — сохранить заметку\n" +
          "• <b>заметки</b> — показать последние\n" +
          "• <b>напомни через 10 минут ...</b>\n" +
          "• <b>напомни завтра в 09:00 ...</b>"
      );
      res.status(200).json({ ok: true });
      return;
    }

    // заметки
    if (parsed.intent === "list_notes") {
      const notes = await listNotes(userId, 5);
      if (!notes.length) {
        await sendMessage(BOT_TOKEN, chatId, "Пока нет заметок.");
      } else {
        const lines = notes.map((n, i) => `${i + 1}) ${escapeHtml(n.text)}`);
        await sendMessage(BOT_TOKEN, chatId, `<b>Последние заметки:</b>\n` + lines.join("\n"));
      }
      res.status(200).json({ ok: true });
      return;
    }

    // создать заметку (с подтверждением)
    if (parsed.intent === "create_note") {
      await setPending(userId, {
        intent: "create_note",
        fields: parsed.fields,
        mode: "draft"
      });

      await sendMessage(
        BOT_TOKEN,
        chatId,
        `Сохранить заметку?\n\n<b>${escapeHtml(parsed.fields.text)}</b>`,
        buildConfirmKeyboard()
      );

      res.status(200).json({ ok: true });
      return;
    }

    // создать напоминание
    if (parsed.intent === "create_reminder") {
      const r = parseReminder(parsed.fields.text);

      if (!r) {
        await sendMessage(
          BOT_TOKEN,
          chatId,
          "Понял. Можешь написать так:\n" +
            "• напомни через 10 минут купить воду\n" +
            "• напомни через 2 часа позвонить\n" +
            "• напомни завтра в 09:00 оплатить интернет"
        );
        res.status(200).json({ ok: true });
        return;
      }

      const id = crypto.randomUUID();

      await kv.set(`reminder:${id}`, { chatId, text: r.body }, { ex: 60 * 60 * 24 * 30 }); // 30 дней
      await kv.zadd("reminders:due", { score: r.fireAt, member: id });

      const when = new Date(r.fireAt).toLocaleString("ru-RU");
      await sendMessage(BOT_TOKEN, chatId, `Ок 👍 Напомню: <b>${escapeHtml(r.body)}</b>\nКогда: ${escapeHtml(when)}`);

      res.status(200).json({ ok: true });
      return;
    }

    // ===================== CHAT (ИИ) =====================
    if (parsed.intent === "chat") {
      const apiKey = requireEnv("GEMINI_API_KEY");

      // сохраняем сообщение пользователя в историю
      await addToHistory(userId, "user", parsed.fields.text);

      const history = await getHistory(userId);
      const context = history
        .map((m) => (m.role === "user" ? `Пользователь: ${m.text}` : `Ассистент: ${m.text}`))
        .join("\n");

      const persona =
        "Ты — личный ассистент по жизни по имени Джарвис. " +
        "Общайся естественно, как человек: уверенно, тепло, без лишних дисклеймеров. " +
        "НЕ говори, что ты бот/ИИ/модель, если тебя прямо не спросили. " +
        "Отвечай по-русски развёрнуто, с рассуждениями и шагами. " +
        "Если вопрос про факты/новости — используй поиск и добавляй источники. " +
        "Если не уверен — уточни, что именно нужно, но не пугай пользователя.";

      const { text: answer, sources } = await geminiAnswer({
        apiKey,
        userText:
          persona +
          "\n\nКонтекст последних сообщений:\n" +
          context +
          "\n\nТекущий запрос пользователя:\n" +
          parsed.fields.text
      });

      // сохраняем ответ ассистента в историю
      await addToHistory(userId, "assistant", answer);

      let finalText = answer ?? "Не получилось получить ответ.";

      if (sources?.length) {
        finalText +=
          "\n\n<b>Источники:</b>\n" +
          sources
            .slice(0, 3)
            .map((s, i) => `${i + 1}) ${escapeHtml(s.title)}\n${escapeHtml(s.uri)}`)
            .join("\n");
      }

      await sendMessage(BOT_TOKEN, chatId, finalText);
      res.status(200).json({ ok: true });
      return;
    }

    await sendMessage(BOT_TOKEN, chatId, "Не понял. Попробуй иначе 🙂");
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    // Telegram не любит 500
    res.status(200).json({ ok: true });
  }
}
