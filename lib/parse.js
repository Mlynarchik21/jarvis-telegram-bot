export function parseUserText(text) {
  const t = (text ?? "").trim();
  const lower = t.toLowerCase();

  if (!t) return { intent: "empty" };
  if (lower === "/start") return { intent: "start" };
  if (lower === "заметки" || lower === "/notes") return { intent: "list_notes" };

  // Явная заметка
  if (lower.startsWith("заметка:") || lower.startsWith("note:")) {
    const noteText = t.split(":").slice(1).join(":").trim();
    if (!noteText) return { intent: "chat", fields: { text: t } };
    return { intent: "create_note", fields: { text: noteText } };
  }

  // По умолчанию: чат с ИИ
  return { intent: "chat", fields: { text: t } };
}
