import { parseUserText } from "../lib/parse.js";
import { sendMessage, answerCallbackQuery } from "../lib/tg.js";
import {
  setPending,
  getPending,
  clearPending,
  addNote,
  listNotes,
} from "../lib/store.js";
import { geminiAnswer } from "../lib/gemini.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
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

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function readUpdate(req) {
  // Иногда Vercel отдаёт body как объект, иногда как строку
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

export default async function handler(req, res) {
  try {
    // Telegram webhooks = POST
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

    // ========== 1) Нажатия на inline-кнопки ==========
    if (update.callback_query) {
      const cq = update.callback_query;
      const userId = cq.from?.id;
      const chatId = cq.message?.chat?.id;
      const data = cq.data ?? "";

      // Чтобы Telegram убрал "часики" на кнопке
      await answerCallbackQuery(BOT_TOKEN, cq.id, "Ок");

      if (!userId || !chatId) {
        res.status(200).json({ ok: true });
        return;
      }

      const pending = getPending(userId);

      // ✅ Сохранить
      if (data === "confirm:save") {
        if (!pending) {
          await sendMessage(BOT_TOKEN, chatId, "Нечего подтверждать 🙂");
        } else if (pending.intent === "create_note") {
          const created = addNote(userId, pending.fields.text);
          clearPending(userId);

          await sendMessage(
            BOT_TOKEN,
            chatId,
            `Сохранено ✅\n\n<b>Заметка:</b>\n${escapeHtml(created.text)}`
          );
        } else {
          await sendMessage(BOT_TOKEN, chatId, "Пока поддерживаются только заметки 🙂");
        }

        res.status(200).json({ ok: true });
        return;
      }

      // ✏️ Изменить
      if (data === "confirm:edit") {
        if (!pending) {
          await sendMessage(BOT_TOKEN, chatId, "Нечего редактировать 🙂");
        } else {
          // Включаем режим редактирования: следующее сообщение пользователя заменит черновик
          setPending(userId, { ...pending, mode: "editing" });
          await sendMessage(
            BOT_TOKEN,
            chatId,
            "Ок 👍 Пришли новый текст одним сообщением — я обновлю черновик и снова попрошу подтверждение."
          );
        }

        res.status(200).json({ ok: true });
        return;
      }

      // ❌ Отмена
      if (data === "confirm:cancel") {
        clearPending(userId);
        await sendMessage(BOT_TOKEN, chatId, "Отменено ❌");
        res.status(200).json({ ok: true });
        return;
      }

      res.status(200).json({ ok: true });
      return;
    }

    // ========== 2) Обычные сообщения ==========
    const msg = update.message;
    if (!msg || !msg.text) {
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

    // Если пользователь редактирует черновик
    const prevPending = getPending(userId);
    if (prevPending?.mode === "editing") {
      const newPending = {
        intent: prevPending.intent,
        fields: { ...(prevPending.fields ?? {}), text },
        mode: "draft",
      };
      setPending(userId, newPending);

      await sendMessage(
        BOT_TOKEN,
        chatId,
        `Обновил черновик ✏️\n\n<b>Я понял:</b> заметка\n<b>Текст:</b>\n${escapeHtml(text)}\n\nСохранить?`,
        buildConfirmKeyboard()
      );

      res.status(200).json({ ok: true });
      return;
    }

    // Парсим текст
    const parsed = parseUserText(text);

    // /start
    if (parsed.intent === "start") {
      await sendMessage(
        BOT_TOKEN,
        chatId,
        "Привет! Я ассистент.\n\n" +
          "• Пиши обычным текстом — я отвечу как человек.\n" +
          "• Чтобы сохранить заметку: <b>заметка: ...</b>\n" +
          "• Чтобы увидеть заметки: <b>заметки</b>\n"
      );
      res.status(200).json({ ok: true });
      return;
    }

    // список заметок
    if (parsed.intent === "list_notes") {
      const notes = listNotes(userId, 5);
      if (!notes.length) {
        await sendMessage(BOT_TOKEN, chatId, "Заметок пока нет.");
      } else {
        const lines = notes.map((n, i) => `${i + 1}) ${escapeHtml(n.text)}`);
        await sendMessage(
          BOT_TOKEN,
          chatId,
          `<b>Последние заметки:</b>\n` + lines.join("\n")
        );
      }
      res.status(200).json({ ok: true });
      return;
    }

    // создать заметку (с подтверждением)
    if (parsed.intent === "create_note") {
      setPending(userId, { intent: "create_note", fields: parsed.fields, mode: "draft" });

      await sendMessage(
        BOT_TOKEN,
        chatId,
        `Я понял:\n<b>Заметка</b>\n\n<b>Текст:</b>\n${escapeHtml(
          parsed.fields.text
        )}\n\nСохранить?`,
        buildConfirmKeyboard()
      );

      res.status(200).json({ ok: true });
      return;
    }

    // чат через Gemini (по умолчанию)
    if (parsed.intent === "chat") {
      const apiKey = requireEnv("GEMINI_API_KEY");

      const { text: answer, sources } = await geminiAnswer({
        apiKey,
        userText:
          "Ты дружелюбный ассистент. Отвечай по-русски развёрнуто, с рассуждениями и структурой.\n" +
          "Если вопрос про факты/новости — используй поиск и добавляй источники.\n" +
          "Если не уверен — прямо скажи, что не уверен.\n\n" +
          "Запрос пользователя: " +
          parsed.fields.text,
      });

      let finalText = answer ?? "Не получилось получить ответ.";

      if (sources?.length) {
        finalText +=
          "\n\nИсточники:\n" +
          sources
            .slice(0, 3)
            .map((s, i) => `${i + 1}) ${s.title}\n${s.uri}`)
            .join("\n");
      }

      await sendMessage(BOT_TOKEN, chatId, finalText);
      res.status(200).json({ ok: true });
      return;
    }

    // fallback
    await sendMessage(BOT_TOKEN, chatId, "Не понял. Попробуй иначе 🙂");
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    // Telegram не любит 500, поэтому всегда 200
    res.status(200).json({ ok: true });
  }
}
