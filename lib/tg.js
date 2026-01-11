export async function sendMessage(token, chatId, text, replyMarkup) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  const body = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Telegram sendMessage failed: ${res.status} ${t}`);
  }

  return res.json();
}

export async function answerCallbackQuery(token, callbackQueryId, text) {
  const url = `https://api.telegram.org/bot${token}/answerCallbackQuery`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text: text ?? "",
      show_alert: false
    })
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Telegram answerCallbackQuery failed: ${res.status} ${t}`);
  }

  return res.json();
}
