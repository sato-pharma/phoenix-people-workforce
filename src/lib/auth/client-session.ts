import { hardNavigate } from "@/lib/navigation/browser-navigation";

export const phoenixLastActivityStorageKey = "phoenix_last_activity_at";
export const phoenixSessionTimeoutReason = "session-timeout";

type SessionActivityStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

// Same-tab signal set the instant SessionSecurityGuard decides the session is gone
// (heartbeat 401, or client-detected idle timeout) — BEFORE its async logout call and
// redirect complete. Any other in-flight or about-to-be-issued request that then gets a
// 403 can check this to tell "your session just died" apart from a genuine permission
// denial, instead of surfacing a confusing "you do not have access" error on a page that
// is a moment away from being redirected to /login anyway.
let sessionInvalidatedReason: string | null = null;

export function markSessionInvalidated(reason: string) {
  sessionInvalidatedReason = reason;
}

export function isSessionInvalidated() {
  return sessionInvalidatedReason !== null;
}

/**
 * Checks a fetch Response for the heartbeat/logout race: an outright 401 is always
 * authoritative (this app's API convention reserves 401 for "not authenticated"), and a
 * 403 counts only when SessionSecurityGuard has already flagged the session as dead —
 * otherwise a genuine permission-denied 403 would be misreported as a session timeout.
 * Redirects to the login page and returns true when it fires; callers should stop
 * treating the response as a normal success/failure and let the redirect take over.
 */
export function handlePossibleSessionDeath(response: Pick<Response, "status">): boolean {
  if (typeof window === "undefined") return false;
  const looksSessionDead = response.status === 401 || (response.status === 403 && isSessionInvalidated());
  if (!looksSessionDead) return false;

  hardNavigate(`/login?reason=${phoenixSessionTimeoutReason}`);
  return true;
}

function resolveStorage(storage?: SessionActivityStorage) {
  if (storage) return storage;
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

// Storage can throw on access (a private window, blocked site data). Each helper swallows that: the
// last-activity stamp is a convenience shared between tabs, and a page must never break because it
// could not be written (2026-10-26 cache audit, P3).
export function readSessionActivityAt(storage?: SessionActivityStorage) {
  let value: string | null | undefined;
  try {
    value = resolveStorage(storage)?.getItem(phoenixLastActivityStorageKey);
  } catch {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function markSessionActivity(storage?: SessionActivityStorage, now = Date.now()) {
  try {
    resolveStorage(storage)?.setItem(phoenixLastActivityStorageKey, String(now));
  } catch {
    // Not recorded; the idle timer counts from the last stamp it could read.
  }
}

export function clearSessionActivity(storage?: SessionActivityStorage) {
  try {
    resolveStorage(storage)?.removeItem(phoenixLastActivityStorageKey);
  } catch {
    // Nothing to clear that this page can reach.
  }
}
