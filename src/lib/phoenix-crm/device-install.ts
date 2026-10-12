/**
 * Phoenix CRM — the id a browser install carries with every capture it sends.
 *
 * WHAT IT IS. A random v4 id, generated the first time this browser saves anything and kept in that
 * browser's own storage from then on. It names a BROWSER INSTALL and nothing else:
 *
 *   · not a person — a rep who signs in on a colleague's phone sends the colleague's id;
 *   · not a handset — no serial, no model, no advertising id, no package list. 🔴 The owner forbids
 *     a package or APK scan by name, and nothing here reads one;
 *   · not permanent — clearing site data, a private window, or a new browser all answer with a new
 *     id, and that is accepted. An id that could not be cleared would be a device fingerprint, which
 *     is a different thing from the question being asked.
 *
 * WHY. Nothing on a capture said which device sent it, so "two people saving from one phone" had no
 * answer at all. Two saves carrying the SAME id came from one browser profile; two carrying
 * different ids tell you nothing either way, which is the honest shape — it can only ever
 * corroborate, never accuse.
 *
 * 🔴 SILENT (Golden Rule #1). The rep is never told this id exists, it is never shown to him, and it
 * can never refuse him a visit: every path below answers `null` rather than throwing, and the server
 * stores `null` as NOT MEASURED. A browser with storage blocked saves exactly as it always did.
 */

const STORAGE_KEY = "phx-crm-install";

/** A v4 id from the platform's own generator, falling back to one built from `getRandomValues`. */
function newId(): string | null {
  const crypto = typeof globalThis === "undefined" ? undefined : globalThis.crypto;
  if (!crypto) return null;
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  if (typeof crypto.getRandomValues !== "function") return null;
  // `randomUUID` needs a secure context; `getRandomValues` does not, and a rep reaching the app over
  // plain http on a hotel wifi still has one. Same 128 bits, assembled by hand.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Whether a stored value is one of ours, rather than something else that wrote to the same key. */
function usable(value: string | null): value is string {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
}

/**
 * This browser install's id, or null when there is no storage to keep one in.
 *
 * Every failure answers null: storage disabled, a quota error, a private window that throws on
 * write, a platform with no crypto at all. Reading one must never be able to interrupt a save.
 */
export function deviceInstallId(): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const known = localStorage.getItem(STORAGE_KEY);
    if (usable(known)) return known;
    const fresh = newId();
    if (fresh === null) return null;
    localStorage.setItem(STORAGE_KEY, fresh);
    return fresh;
  } catch {
    return null;
  }
}
