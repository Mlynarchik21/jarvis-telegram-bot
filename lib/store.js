const mem = {
  pending: new Map(),
  notes: new Map()
};

export function setPending(userId, data) {
  mem.pending.set(String(userId), data);
}

export function getPending(userId) {
  return mem.pending.get(String(userId));
}

export function clearPending(userId) {
  mem.pending.delete(String(userId));
}

export function addNote(userId, text) {
  const key = String(userId);
  const arr = mem.notes.get(key) || [];
  const note = { id: Date.now(), text };
  arr.unshift(note);
  mem.notes.set(key, arr);
  return note;
}

export function listNotes(userId, limit = 5) {
  const key = String(userId);
  return (mem.notes.get(key) || []).slice(0, limit);
}
