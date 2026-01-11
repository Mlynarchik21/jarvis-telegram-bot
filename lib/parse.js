export function parseUserText(text) {
  const t = text.toLowerCase();

  if (t.includes("заметки")) return { intent: "list_notes" };

  return {
    intent: "create_note",
    fields: { text }
  };
}
