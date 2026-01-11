import { parseUserText } from "../lib/parse.js";
import { sendMessage, answerCallbackQuery } from "../lib/tg.js";
import { setPending, getPending, clearPending, addNote, listNotes } from "../lib/store.js";

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
        { text: "❌ Отмена", callback_data: "confirm:cancel" }
      ]
    ]
  };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.status(200).send("OK");
      return;
    }

    const BOT_TOKEN = requireEnv("BOT_TOKEN");
    const update = req.body;

    // кнопки
    if (update.callback_query) {
      const cq = update.callback_query;
      const userId = cq.from?.id;
      const chatId = cq.message?.chat?.id;
      const data = cq.data ?? "";

      await answerCallbackQuery(BOT_TOKEN, cq.id, "Ок");

      const pending = getPending(userId);

      if (data === "confirm:save" && pending?.intent === "create_note") {
        const created = addNote(userId, pending.fields.text);
        clearPending(userId);
        await sendMessage(BOT_TOKEN, chatId, `Сохранено ✅\n\nЗаметка:\n${created.text}`);
      }

      if (data === "confirm:cancel") {
        clearPending(userId);
        await sendMessage(BOT_TOKEN, chatId, "Отменено ❌");
      }

      res.status(200).json({ ok: true });
      return;
    }

    // обычные сообщения
    const msg = update.message;
    if (!msg?.text) return res.status(200).json({ ok: true });

    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;

    const parsed = parseUserText(text);

    if (parsed.intent === "list_notes") {
      const notes = listNotes(userId, 5);
      if (!notes.length) {
        await sendMessage(BOT_TOKEN, chatId, "Заметок пока нет.");
      } else {
        await sendMessage(
          BOT_TOKEN,
          chatId,
          "Последние заметки:\n" + notes.map((n, i) => `${i + 1}. ${n.text}`).join("\n")
        );
      }
      return res.status(200).json({ ok: true });
    }

    if (parsed.intent === "create_note") {
      setPending(userId, { intent: "create_note", fields: parsed.fields });
      await sendMessage(
        BOT_TOKEN,
        chatId,
        `Я понял: заметка\n\n${parsed.fields.text}\n\nСохранить?`,
        buildConfirmKeyboard()
      );
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(200).json({ ok: true });
  }
}
