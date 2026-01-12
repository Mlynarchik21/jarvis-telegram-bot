import "dotenv/config";
import express from "express";
import OpenAI from "openai";

const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PUBLIC_URL = process.env.PUBLIC_URL;

if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN in .env");
if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY in .env");
if (!PUBLIC_URL) throw new Error("Missing PUBLIC_URL in .env");

const app = express();
app.use(express.json({ limit: "2mb" }));

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Память в RAM (пока просто)
const history = new Map(); // userId -> [{role,text}]
const reminders = []; // { chatId, fireAt, text }

function addHist(userId, role, text) {
  const arr = history.get(userId) ?? [];
  arr.push({ role, text });
  while (arr.length > 8) arr.shift();
  history.set(userId, arr);
}

function getContext(userId) {
  const arr = history.get(userId) ?? [];
  return arr.map(m => (m.role === "user" ? `Пользователь: ${m.text}` : `Ассистент: ${m.text}`)).join("\n");
}

function detectMode(text) {
  const t = text.toLowerCase().trim();

  if (
    t.startsWith("дай ссылку") ||
    t.startsWith("скинь ссылку") ||
    t.startsWith("пришли ссылку") ||
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

function parseReminder(text) {
  const t = text.trim();

  const m1 = t.match(/напомни\s+через\s+(\d+)\s*(минут|мин|час|часа|часов)\s+(.+)/i);
  if (m1) {
    const n = parseInt(m1[1], 10);
    const unit = m1[2].toLowerCase();
    const body = m1[3].trim();
    const ms = unit.startsWith("мин") ? n * 60_000 : n * 3_600_000;
    return { fireAt: Date.now() + ms, body };
  }

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

async function tgSend(chatId, text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true
    })
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Telegram sendMessage failed: ${res.status} ${t}`);
  }
}

async function setWebhook() {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`;
  const hook = `${PUBLIC_URL}/telegram`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: hook })
  });
  const json = await res.json().catch(() => ({}));
  console.log("setWebhook:", json);
}

setInterval(async () => {
  const now = Date.now();
  const due = reminders.filter(r => r.fireAt <= now);
  if (!due.length) return;

  for (const r of due) {
    try {
      await tgSend(r.chatId, `⏰ Напоминание: ${r.text}`);
    } catch (e) {
      console.error("Reminder send failed:", e);
    }
  }

  for (let i = reminders.length - 1; i >= 0; i--) {
    if (reminders[i].fireAt <= now) reminders.splice(i, 1);
  }
}, 1000);

app.get("/", (req, res) => res.status(200).send("OK"));

app.post("/telegram", async (req, res) => {
  try {
    const update = req.body;
    const msg = update?.message;

    if (!msg?.text) return res.status(200).json({ ok: true });

    const chatId = msg.chat?.id;
    const userId = msg.from?.id;
    const text = msg.text.trim();

    if (!chatId || !userId) return res.status(200).json({ ok: true });

    if (text === "/start") {
      await tgSend(
        chatId,
        "Привет 🙂\n\n" +
          "• обычный текст — отвечаю\n" +
          "• «дай ссылку на ...» — только ссылка\n" +
          "• «напомни через 1 минуту ...» — напоминание"
      );
      return res.status(200).json({ ok: true });
    }

    // напоминание — без GPT
    if (text.toLowerCase().startsWith("напомни")) {
      const r = parseReminder(text);
      if (!r) {
        await tgSend(chatId, "Пример: «напомни через 1 минуту выключить чайник»");
        return res.status(200).json({ ok: true });
      }
      reminders.push({ chatId, fireAt: r.fireAt, text: r.body });
      await tgSend(chatId, `Ок 👍 Напомню: ${r.body}`);
      return res.status(200).json({ ok: true });
    }

    const mode = detectMode(text);
    addHist(userId, "user", text);
    const context = getContext(userId);

    const persona =
      "Ты — личный ассистент по имени Джарвис. " +
      "НЕ говори, что ты бот/ИИ, если тебя не спрашивают. " +
      "Отвечай точно по запросу.";

    let rules = "";
    let maxTokens = 320;

    if (mode === "LINK_ONLY") {
      rules = "Ответь ТОЛЬКО одним URL. Без пояснений.";
      maxTokens = 80;
    } else if (mode === "DETAILED") {
      rules = "Ответь развёрнуто: сначала кратко, потом объяснение и шаги.";
      maxTokens = 700;
    } else {
      rules = "Отвечай кратко и по делу (1–6 предложений).";
      maxTokens = 320;
    }

    const prompt = `${persona}\n${rules}\n\nКонтекст:\n${context}\n\nЗапрос:\n${text}`;

    const resp = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: prompt,
      max_output_tokens: maxTokens
    });

    const answer = (resp.output_text || "").trim() || "Не смог ответить.";

    if (mode === "LINK_ONLY") {
      const url = extractFirstUrl(answer);
      const out = url ?? "Не нашёл точную ссылку — уточни название.";
      addHist(userId, "assistant", out);
      await tgSend(chatId, out);
      return res.status(200).json({ ok: true });
    }

    addHist(userId, "assistant", answer);
    await tgSend(chatId, answer);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(200).json({ ok: true });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, async () => {
  console.log("Listening on", port);
  await setWebhook();
});
