/**
 * Phoenix CRM — a module's first read, handed over by the page instead of asked for by the browser.
 *
 * 🔴 THE PAGE STARTS THE SCREEN'S FIRST READ (2026-11-01, "make every Phoenix CRM module tab load its first
 * data from the server"). A tab used to wait for the page, then for its script, and only then asked
 * /api/phoenix-crm for its data, which meant signing the person in and finding their seats a second time.
 * Now the page starts that read the moment it knows the seat (server/first-read.ts) and the answer rides in
 * the page's own stream. `useCrmGet` takes it when the address and the key are exactly what it was about to
 * ask for, and reads for itself in every other case, so a mismatch costs a read and never shows wrong data.
 *
 * Plain code with no React, so a test can run the rules below.
 */

export type CrmFirstRead = {
  /** The answer as JSON, the same text the route would send; null when the screen must read for itself. */
  body: Promise<string | null>;
  key: string;
  url: string;
};

/** How long after a screen first meets the read it may still use it. */
export const FIRST_READ_LIFETIME_MS = 30_000;

// 🔴 USED ONCE, AND NEVER LATE. Browser Back restores this page from the router's own copy, the read inside
// it included, so a rep who logs a visit elsewhere and presses Back would be handed the day as it stood
// before the visit. Kept outside React for that reason: the restored page mounts a fresh screen, and
// everything held in component state starts again. Keyed by the read's own object, which the restore reuses.
const firstMet = new WeakMap<CrmFirstRead, number>();

/** The handed-over read, when it is this screen's and can still be used. */
export function firstReadFor(firstRead: CrmFirstRead | null, url: string, key: string, now: number = Date.now()): CrmFirstRead | null {
  if (firstRead === null || firstRead.url !== url || firstRead.key !== key) return null;
  const met = firstMet.get(firstRead) ?? now;
  firstMet.set(firstRead, met);
  return now - met <= FIRST_READ_LIFETIME_MS ? firstRead : null;
}

/** The screen has drawn it, so nothing may draw it again. Not before: Strict Mode runs an effect twice. */
export function firstReadSpent(firstRead: CrmFirstRead): void {
  firstMet.set(firstRead, Number.NEGATIVE_INFINITY);
}

/**
 * The answer, or the screen's own read when there is none: the page's read failed or was refused (so the
 * route gets to say why, with a Try again), or the stream it was riding broke.
 *
 * `await` and never `.then().catch()`: what crosses from the server is React's own thenable, whose `then`
 * returns nothing, so a chain on it throws.
 */
export async function readFirst<T>(firstRead: CrmFirstRead, readItself: () => Promise<T>): Promise<T> {
  let body: string | null = null;
  try {
    body = await firstRead.body;
  } catch {
    body = null;
  }
  return body === null ? readItself() : (JSON.parse(body) as T);
}
