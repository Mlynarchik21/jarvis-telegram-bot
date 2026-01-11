export function parseUserText(text) {
  const t = (text ?? "").trim();
  const lower = t.toLowerCase();

  if (!t) return { intent: "empty" };

  if (lower === "/start") return { intent: "start" };
  if (lower === "заметки" || lower === "/notes") return { intent: "list_notes" };

  // явная заметка
  if (lower.startsWith("заметка:") || lower.startsWith("note:")) {
    const noteText = t.split(":").slice(1).join(":").trim();
    if (!noteText) return { intent: "chat", fields: { text: t } };
    return { intent: "create_note", fields: { text: noteText } };
  }

  // напоминания
  if (lower.startsWith("напомни")) {
    return { intent: "create_reminder", fields: { text: t } };
  }

  // по умолчанию — чат
  return { intent: "chat", fields: { text: t } };
}
