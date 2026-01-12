/**
 * server.js — Jarvis Assistant (Telegram webhook) — single file
 * Node 18+
 * ENV:
 *  BOT_TOKEN
 *  OPENAI_API_KEY
 *  PUBLIC_URL
 * Optional:
 *  OPENAI_MODEL (default: gpt-4.1-mini)
 *  DEBUG_KEY (если задан — /debug/* требует ?key=DEBUG_KEY)
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
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const DEBUG_KEY = process.env.DEBUG_KEY || "";

if (!BOT_TOKEN) console.error("❌ BOT_TOKEN missing");
if (!OPENAI_API_KEY) console.error("❌ OPENAI_API_KEY missing");
if (!PUBLIC_URL) console.error("❌ PUBLIC_URL missing");

console.log("✅ ENV CHECK:", {
  hasBotToken: !!BOT_TOKEN,
  hasOpenAIKey: !!OPENAI_API_KEY,
  publicUrl: PUBLIC_URL,
  openaiModel: OPENAI_MODEL,
  debugKeyEnabled: !!DEBUG_KEY,
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
const MAX_UPDATE_IDS = 700;

// Simple rate limit per user
const lastUserHit = new Map(); // userId -> timestamp
const RATE_LIMIT_MS = 900;

// ------------------------------
// Utils
// ------------------------------
function nowIso() {
  return new Date().toISOString();
}

function safeText(t, max = 180) {
  const s = String(t ?? "");
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function requireDebugKey(req, res) {
  if (!DEBUG_KEY) return true; // если ключ не задан — доступ открыт
  if (req.query.key === DEBUG_KEY) return true;
  res.status(403).json({ ok: false, error: "forbidden" });
  return false;
}

// ------------------------------
// Telegram helpers
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

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("❌ TG sendMessage failed:", {
        t: nowIso(),
        status: res.status,
        body: safeText(body, 400),
      });
    }
  } catch (e) {
    console.error("❌ TG sendMessage network error:", { t: nowIso(), message: e?.message });
  }
}

async function tgGetWebhookInfo() {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`;
  const res = await fetch(url);
  const data = await res.json().catch(() => null);
  return data;
}

async function setWebhook() {
  if (!PUBLIC_URL || !BOT_TOKEN) return;

  const hookUrl = `${PUBLIC_URL.replace(/\/$/, "")}/telegram`;

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: hookUrl,
      drop_pending_updates: false,
    }),
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
// ------------------------------
function parseReminder(textRaw) {
  const text = (textRaw || "").trim();

  const re =
    /^напомни\s+через\s+(\d+)\s*(секунд[уы]?|минут[уы]?|час(ов|а)?)\s+(.+)$/i;
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
    .slice(0, 25);

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

  for (const r of due) {
    const idx = reminders.findIndex((x) => x.id === r.id);
    if (idx !== -1) reminders.splice(idx, 1);
  }

  for (const r of due) {
    await tgSend(r.chatId, `⏰ Напоминание: ${r.text}`);
  }
}, 1000);

// ------------------------------
// History
// ------------------------------
function pushHistory(chatId, role, content) {
  const arr = histories.get(chatId) || [];
  arr.push({ role, content });
  histories.set(chatId, arr.slice(-8));
}

function buildMessages(chatId, userText, mode) {
  const history = histories.get(chatId) || [];

  const system = {
    role: "system",
    content:
      "Ты — личный ассистент в стиле JARVIS: коротко, точно, без воды. " +
      "Никогда не говори, что ты ИИ/бот/модель. Отвечай по-человечески.",
  };

  let modeInstruction = "";
  if (mode === "LINK_ONLY") {
    modeInstruction =
      "РЕЖИМ: LINK_ONLY. Верни строго один URL (http/https) и ничего больше. Без текста, без пояснений, без списков.";
  } else if (mode === "DETAILED") {
    modeInstruction =
      "РЕЖИМ: DETAILED. Формат: 1) Резюме (1–2 строки). 2) Объяснение. 3) Шаги (до 5 пунктов).";
  } else {
    modeInstruction =
      "РЕЖИМ: NORMAL. Ответ короткий и по делу (2–6 предложений). Без простыней.";
  }

  return [
    system,
    { role: "system", content: modeInstruction },
    ...history,
    { role: "user", content: userText },
  ];
}

// ------------------------------
// LINK_ONLY фильтр
// ------------------------------
function extractFirstUrl(text) {
  if (!text) return null;
  const m = text.match(/https?:\/\/[^\s<>"')\]]+/i);
  return m ? m[0] : null;
}

// ------------------------------
// OpenAI call (Responses API)
// ------------------------------
async function askOpenAI(chatId, userText, mode) {
  const messages = buildMessages(chatId, userText, mode);

  const resp = await openai.responses.create({
    model: OPENAI_MODEL,
    input: messages.map((m) => ({
      role: m.role,
      content: [{ type: "text", text: m.content }],
    })),
  });

  return (resp.output_text || "").trim();
}

// ------------------------------
// Routes
// ------------------------------
app.get("/health", (req, res) => res.status(200).send("ok"));

/**
 * Debug endpoint — показывает Telegram getWebhookInfo
 * (если DEBUG_KEY задан, требует /debug/webhook?key=DEBUG_KEY)
 */
app.get("/debug/webhook", async (req, res) => {
  if (!requireDebugKey(req, res)) return;
  try {
    const info = await tgGetWebhookInfo();
    res.json(info);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "unknown" });
  }
});

/**
 * Debug endpoint — показать счетчики/состояние
 */
app.get("/debug/state", (req, res) => {
  if (!requireDebugKey(req, res)) return;
  res.json({
    ok: true,
    historiesChats: histories.size,
    reminders: reminders.length,
    recentUpdateIds: recentUpdateIds.size,
    t: nowIso(),
  });
});

/**
 * Telegram webhook:
 * Важно: сразу 200 OK, остальное — async
 */
app.post("/telegram", (req, res) => {
  res.sendStatus(200);

  (async () => {
    try {
      const update = req.body;

      // Лог входящего апдейта (самое важное для диагностики)
      const msg = update?.message || update?.edited_message;
      const chatId = msg?.chat?.id;
      const userId = msg?.from?.id;
      const text = msg?.text;

      console.log("➡️ UPDATE:", {
        t: nowIso(),
        update_id: update?.update_id,
        chatId,
        userId,
        hasText: !!text,
        text: safeText(text),
      });

      // Dedup update_id
      if (typeof update?.update_id === "number") {
        const id = update.update_id;
        if (recentUpdateIds.has(id)) {
          console.log("↩️ DUP UPDATE ignored:", id);
          return;
        }
        recentUpdateIds.add(id);
        recentUpdateIdsQueue.push(id);
        if (recentUpdateIdsQueue.length > MAX_UPDATE_IDS) {
          const old = recentUpdateIdsQueue.shift();
          recentUpdateIds.delete(old);
        }
      }

      if (!msg?.text || !chatId) return;
      const userText = msg.text.trim();

      // Rate limit
      if (userId) {
        const now = Date.now();
        const last = lastUserHit.get(userId) || 0;
        if (now - last < RATE_LIMIT_MS) {
          console.log("⏱️ RATE LIMIT:", { userId, deltaMs: now - last });
          return;
        }
        lastUserHit.set(userId, now);
      }

      // Команды напоминаний
      if (/^(напоминания|мои напоминания)$/i.test(userText)) {
        await tgSend(chatId, listReminders(chatId));
        return;
      }

      const del = userText.match(/^удали\s+напоминание\s+(\d+)$/i);
      if (del) {
        const id = parseInt(del[1], 10);
        const ok = deleteReminder(chatId, id);
        await tgSend(chatId, ok ? `✅ Удалено: ${id}` : `Не нашёл напоминание: ${id}`);
        return;
      }

      const r = parseReminder(userText);
      if (r) {
        const { id, dueAt } = addReminder(chatId, r.task, r.delayMs);
        const sec = Math.round((dueAt - Date.now()) / 1000);
        await tgSend(chatId, `✅ Ок. Напомню через ${sec} сек: ${r.task}\n(ID: ${id})`);
        return;
      }

      // GPT
      const mode = detectMode(userText);
      pushHistory(chatId, "user", userText);

      let answer = "";
      try {
        answer = await askOpenAI(chatId, userText, mode);
      } catch (err) {
        console.error("❌ OPENAI ERROR:", {
          t: nowIso(),
          message: err?.message,
          status: err?.status,
          code: err?.code,
          responseStatus: err?.response?.status,
          responseData: err?.response?.data,
        });

        await tgSend(chatId, "Сейчас не могу ответить. Попробуй ещё раз чуть позже.");
        return;
      }

      if (mode === "LINK_ONLY") {
        let url = extractFirstUrl(answer);

        if (!url) {
          // retry один раз строго
          try {
            const retryText = `Верни строго один URL (http/https) на запрос: ${userText}`;
            const retry = await askOpenAI(chatId, retryText, "LINK_ONLY");
            url = extractFirstUrl(retry);
          } catch {}
        }

        if (!url) {
          const q = encodeURIComponent(userText.replace(/^дай\s+ссылку\s*/i, "").slice(0, 120));
          url = `https://www.google.com/search?q=${q}`;
        }

        pushHistory(chatId, "assistant", url);
        await tgSend(chatId, url, { disable_web_page_preview: false });
        return;
      }

      // “не говорить что ты ИИ”
      answer = (answer || "").replace(/я\s+ии|я\s+бот|как\s+ии|моя\s+модель/gi, "").trim();

      pushHistory(chatId, "assistant", answer || "…");
      await tgSend(chatId, answer || "…");
    } catch (e) {
      console.error("❌ TG HANDLER ERROR:", { t: nowIso(), message: e?.message, stack: e?.stack });
    }
  })();
});

// ------------------------------
// Process safety
// ------------------------------
process.on("unhandledRejection", (err) => {
  console.error("❌ UNHANDLED REJECTION:", err);
});
process.on("uncaughtException", (err) => {
  console.error("❌ UNCAUGHT EXCEPTION:", err);
});

// ------------------------------
// Start
// ------------------------------
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  await setWebhook();
});
