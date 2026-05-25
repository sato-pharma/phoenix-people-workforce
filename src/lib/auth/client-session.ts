export const phoenixLastActivityStorageKey = "phoenix_last_activity_at";
export const phoenixSessionTimeoutReason = "session-timeout";

type SessionActivityStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

function resolveStorage(storage?: SessionActivityStorage) {
  if (storage) return storage;
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

export function readSessionActivityAt(storage?: SessionActivityStorage) {
  const value = resolveStorage(storage)?.getItem(phoenixLastActivityStorageKey);
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function markSessionActivity(storage?: SessionActivityStorage, now = Date.now()) {
  resolveStorage(storage)?.setItem(phoenixLastActivityStorageKey, String(now));
}

export function clearSessionActivity(storage?: SessionActivityStorage) {
  resolveStorage(storage)?.removeItem(phoenixLastActivityStorageKey);
}
