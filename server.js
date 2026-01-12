/**
 * server.js — Jarvis Assistant (Telegram webhook) — single file
 * Требования:
 * - Node.js 18+
 * - ENV: BOT_TOKEN, OPENAI_API_KEY, PUBLIC_URL
 * - Webhook: PUBLIC_URL + "/telegram"
 */

import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));

const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PUBLIC_URL = process.env.PUBLIC_URL;

if (!BOT_TOKEN) console.error("❌ BOT_TOKEN missing");
if (!OPENAI_API_KEY) console.error("❌ OPENAI_API_KEY missing");
if (!PUBLIC_URL) console.error("❌ PUBLIC_URL missing");

console.log("✅ ENV CHECK:", {
  hasBotToken: !!BOT_TOKEN,
  hasOpenAIKey: !!OPENAI_API_KEY,
  publicUrl: PUBLIC_URL,
});

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ------------------------------
// In-memory storage
// ------------------------------
const histories = new Map(); // chatId -> [{role, content}]
const reminders = []; // { id, chatId, text, dueAt }
let reminderIdSeq = 1;

// Dedup updates (Telegram can resend)
const recentUpdateIds = new Set();
const recentUpdateIdsQueue = [];
const MAX_UPDATE_IDS = 500;

// Simple rate limit per user
const lastUserHit = new Map(); // userId -> timestamp
const RATE_LIMIT_MS = 1200;

// ------------------------------
// Helpers: Telegram
// ------------------------------
async function tgSend(chatId, text, extra = {}) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("TELEGRAM sendMessage failed:", res.status, body);
  }
}

async function setWebhook() {
  if (!PUBLIC_URL || !BOT_TOKEN) return;
  const hookUrl = `${PUBLIC_URL.replace(/\/$/, "")}/telegram`;

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: hookUrl }),
  });

  const data = await res.json().catch(() => null);
  console.log("🔗 setWebhook:", hookUrl, data);
}

// ------------------------------
// Modes
// ------------------------------
function detectMode(textRaw) {
  const text = (textRaw || "").toLowerCase();

  const linkOnlyTriggers = [
    "дай ссылку",
    "скинь ссылку",
    "только ссылку",
    "ссылку на",
    "пришли ссылку",
    "кинь ссылку",
  ];

  const detailedTriggers = ["расскажи", "объясни", "подробно", "детально", "развернуто"];

  if (linkOnlyTriggers.some((t) => text.includes(t))) return "LINK_ONLY";
  if (detailedTriggers.some((t) => text.includes(t))) return "DETAILED";
  return "NORMAL";
}

// ------------------------------
// Reminder parsing (локально, без GPT)
// Поддержка: "напомни через 1 минуту ...", "напомни через 10 секунд ...", "напомни через 2 часа ..."
// ------------------------------
function parseReminder(textRaw) {
  const text = (textRaw || "").trim();

  // Примеры:
  // "напомни через 1 минуту выключить чайник"
  // "напомни через 10 секунд проверить почту"
  // "напомни через 2 часа позвонить"

  const re = /^напомни\s+через\s+(\d+)\s*(секунд[уы]?|минут[уы]?|час(ов|а)?)\s+(.+)$/i;
  const m = text.match(re);
  if (!m) return null;

  const amount = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const task = m[4].trim();

  if (!amount || amount <= 0 || !task) return null;

  let ms = 0;
  if (unit.startsWith("сек")) ms = amount * 1000;
  else if (unit.startsWith("мин")) ms = amount * 60 * 1000;
  else if (unit.startsWith("час")) ms = amount * 60 * 60 * 1000;

  if (ms <= 0) return null;

  return { delayMs: ms, task };
}

function addReminder(chatId, task, delayMs) {
  const dueAt = Date.now() + delayMs;
  const id = reminderIdSeq++;
  reminders.push({ id, chatId, text: task, dueAt });
  return { id, dueAt };
}

function listReminders(chatId) {
  const now = Date.now();
  const items = reminders
    .filter((r) => r.chatId === chatId)
    .sort((a, b) => a.dueAt - b.dueAt)
    .slice(0, 20);

  if (items.length === 0) return "Напоминаний нет.";

  const lines = items.map((r) => {
    const sec = Math.max(0, Math.round((r.dueAt - now) / 1000));
    return `${r.id}) через ~${sec} сек — ${r.text}`;
  });

  return "📌 Напоминания:\n" + lines.join("\n");
}

function deleteReminder(chatId, id) {
  const idx = reminders.findIndex((r) => r.chatId === chatId && r.id === id);
  if (idx === -1) return false;
  reminders.splice(idx, 1);
  return true;
}

// Проверка напоминаний
setInterval(async () => {
  const now = Date.now();
  const due = reminders.filter((r) => r.dueAt <= now);

  if (due.length === 0) return;

  // Удаляем сработавшие
  for (const r of due) {
    const idx = reminders.findIndex((x) => x.id === r.id);
    if (idx !== -1) reminders.splice(idx, 1);
  }

  // Отправляем
  for (const r of due) {
    await tgSend(r.chatId, `⏰ Напоминание: ${r.text}`);
  }
}, 1000);

// ------------------------------
// History helpers
// ------------------------------
function pushHistory(chatId, role, content) {
  const arr = histories.get(chatId) || [];
  arr.push({ role, content });

  // оставляем последние 8 сообщений
  const trimmed = arr.slice(-8);
  histories.set(chatId, trimmed);
}

function buildMessages(chatId, userText, mode) {
  const history = histories.get(chatId) || [];

  // Системная инструкция: стиль Jarvis, без “я ИИ/бот”
  const system = {
    role: "system",
    content:
      "Ты — личный ассистент в стиле JARVIS: коротко, точно, без воды. Никогда не говори, что ты ИИ/бот/модель. " +
      "Если пользователь просит только ссылку — верни только один URL. Если просит подробно — дай резюме, объяснение и шаги.",
  };

  // Режим
  let modeInstruction = "";
  if (mode === "LINK_ONLY") {
    modeInstruction =
      "РЕЖИМ: LINK_ONLY. Верни строго один URL (http/https) и ничего больше. Без текста, без пояснений, без списков.";
  } else if (mode === "DETAILED") {
    modeInstruction =
      "РЕЖИМ: DETAILED. Формат: 1) Резюме (1–2 строки). 2) Объяснение. 3) Шаги (до 5 пунктов).";
  } else {
    modeInstruction =
      "РЕЖИМ: NORMAL. Ответ короткий и по делу (2–6 предложений). Без длинных простыней текста.";
  }

  const modeMsg = { role: "system", content: modeInstruction };

  const user = { role: "user", content: userText };

  return [system, modeMsg, ...history, user];
}

// ------------------------------
// LINK_ONLY фильтр (железобетонно)
// ------------------------------
function extractFirstUrl(text) {
  if (!text) return null;
  const m = text.match(/https?:\/\/[^\s<>"')\]]+/i);
  return m ? m[0] : null;
}

// ------------------------------
// OpenAI call
// ------------------------------
async function askOpenAI(chatId, userText, mode) {
  const messages = buildMessages(chatId, userText, mode);

  // Responses API
  // Важно: модель можно менять на нужную (пример: "gpt-4.1-mini" или др.)
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";

  const resp = await openai.responses.create({
    model,
    input: messages.map((m) => ({
      role: m.role,
      content: [{ type: "text", text: m.content }],
    })),
  });

  // Универсально вытаскиваем текст
  const out = resp.output_text || "";
  return out.trim();
}

// ------------------------------
// Express endpoints
// ------------------------------
app.get("/health", (req, res) => res.status(200).send("ok"));

/**
 * ВАЖНО:
 * Telegram должен быстро получать 200 OK.
 * Поэтому: res.sendStatus(200) сразу, обработка — async.
 */
app.post("/telegram", (req, res) => {
  res.sendStatus(200);

  (async () => {
    try {
      const update = req.body;

      // Dedup update_id
      if (typeof update?.update_id === "number") {
        const id = update.update_id;
        if (recentUpdateIds.has(id)) return;
        recentUpdateIds.add(id);
        recentUpdateIdsQueue.push(id);
        if (recentUpdateIdsQueue.length > MAX_UPDATE_IDS) {
          const old = recentUpdateIdsQueue.shift();
          recentUpdateIds.delete(old);
        }
      }

      const msg = update.message || update.edited_message;
      if (!msg?.text) return;

      const chatId = msg.chat?.id;
      const userId = msg.from?.id;
      const text = msg.text.trim();

      if (!chatId) return;

      // Rate limit
      if (userId) {
        const now = Date.now();
        const last = lastUserHit.get(userId) || 0;
        if (now - last < RATE_LIMIT_MS) return;
        lastUserHit.set(userId, now);
      }

      // Команды напоминаний
      // 1) список
      if (/^(напоминания|мои напоминания)$/i.test(text)) {
        await tgSend(chatId, listReminders(chatId));
        return;
      }

      // 2) удалить: "удали напоминание 2"
      const del = text.match(/^удали\s+напоминание\s+(\d+)$/i);
      if (del) {
        const id = parseInt(del[1], 10);
        const ok = deleteReminder(chatId, id);
        await tgSend(chatId, ok ? `✅ Удалено: ${id}` : `Не нашёл напоминание: ${id}`);
        return;
      }

      // 3) создать
      const r = parseReminder(text);
      if (r) {
        const { id, dueAt } = addReminder(chatId, r.task, r.delayMs);
        const sec = Math.round((dueAt - Date.now()) / 1000);
        await tgSend(chatId, `✅ Ок. Напомню через ${sec} сек: ${r.task}\n(ID: ${id})`);
        return;
      }

      // Иначе — GPT
      const mode = detectMode(text);

      // сохраняем user в историю сразу
      pushHistory(chatId, "user", text);

      let answer = "";
      try {
        answer = await askOpenAI(chatId, text, mode);
      } catch (err) {
        console.error("OPENAI ERROR:", {
          message: err?.message,
          status: err?.status,
          code: err?.code,
          responseStatus: err?.response?.status,
          responseData: err?.response?.data,
        });

        await tgSend(chatId, "Сейчас не могу достучаться до мозга. Попробуй ещё раз через минуту.");
        return;
      }

      // Пост-обработка режимов
      if (mode === "LINK_ONLY") {
        let url = extractFirstUrl(answer);

        // fallback: повторить один раз максимально жёстко
        if (!url) {
          try {
            const retryText = `Верни строго один URL (http/https) на запрос: ${text}`;
            url = extractFirstUrl(await askOpenAI(chatId, retryText, "LINK_ONLY"));
          } catch (e) {
            // ignore
          }
        }

        if (!url) {
          // последний fallback — поисковая ссылка
          const q = encodeURIComponent(text.replace(/^дай\s+ссылку\s*/i, "").slice(0, 120));
          url = `https://www.google.com/search?q=${q}`;
        }

        pushHistory(chatId, "assistant", url);
        await tgSend(chatId, url, { disable_web_page_preview: false });
        return;
      }

      // Фильтр фраз “я ИИ/бот” (если вдруг вылезло)
      const banned = /(я\s+ии|я\s+бот|как\s+ии|моя\s+модель|я\s+—\s+ии)/i;
      if (banned.test(answer)) {
        // мягкая зачистка — без повторного запроса
        answer = answer.replace(banned, "").trim();
      }

      pushHistory(chatId, "assistant", answer || "…");
      await tgSend(chatId, answer || "…");
    } catch (e) {
      console.error("TG HANDLER ERROR:", e);
    }
  })();
});

// ------------------------------
// Process safety
// ------------------------------
process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
});
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

// ------------------------------
// Start server
// ------------------------------
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  await setWebhook();
});
