export function parseReminder(text) {
  const t = text.trim();

  // напомни через N минут/часов ...
  const m1 = t.match(/напомни\s+через\s+(\d+)\s*(минут|мин|час|часа|часов)\s+(.+)/i);
  if (m1) {
    const n = parseInt(m1[1], 10);
    const unit = m1[2].toLowerCase();
    const body = m1[3].trim();

    const ms = unit.startsWith("мин") ? n * 60_000 : n * 3_600_000;
    return { fireAt: Date.now() + ms, body };
  }

  // напомни завтра в HH:MM ...
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
