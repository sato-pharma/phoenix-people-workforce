/**
 * The PREVIOUS value of a rotated secret — accepted for a limited time, and only where a stale
 * credential can open what it always opened and mint nothing new.
 *
 * WHY THIS EXISTS. On 21 October 2026 Railway, the host, reported a security incident that may have
 * exposed every service's environment variables. `PHOENIX_AUTH_SECRET` (the key behind login
 * sessions AND several emailed or pasted links) and `CRON_SECRET` (the bearer cron-job.org sends)
 * are therefore being replaced. Replacing the auth secret on its own would kill every link people
 * already hold — signature pictures inside sent emails, unsubscribe links, offer acceptance links,
 * closing-workbook PDF links, shared cards. The owner's ruling: replace it, but keep the old LINKS
 * opening for a limited time; LOGINS never fall back to the old secret.
 *
 * WHERE THE PREVIOUS VALUE IS ACCEPTED — when checking a token, never when issuing one:
 *  - the email-signature picture address        (src/lib/email-signature/signature-token.ts)
 *  - the one-click unsubscribe link             (src/lib/email/unsubscribe-token.ts)
 *  - the offer acceptance / joining-form link   (src/lib/offers/accept-token.ts)
 *  - the Monthly Closing Export PDF seal        (src/lib/sales/closing-pdf-link-seal.ts)
 *  - the public share-card link                 (src/lib/share/share-card-token.ts)
 *  - the cron bearer, `CRON_SECRET_PREVIOUS`    (src/lib/security/cron-auth.ts), so cron-job.org's
 *    jobs can be moved to the new value one at a time without a single 401.
 *
 * WHERE IT IS DELIBERATELY NOT: the session cookie, password-reset codes, the native web hand-off,
 * the seat-view token, the payroll acknowledgment link (money-adjacent: an old one simply stops
 * working) and the proxy. A leaked old secret must never sign anybody in.
 *
 * 🔴 THE END DATE IS HARD. After `PREVIOUS_SECRET_ACCEPTED_UNTIL` the previous value is ignored even
 * if it is still set. After that date remove this file, every caller's fallback, and both
 * `PHOENIX_AUTH_SECRET_PREVIOUS` and `CRON_SECRET_PREVIOUS` from Railway and `.env.example`.
 */

/** Midnight Cairo (EET, UTC+2) at the start of 22 November 2026 — 30 days after the rotation. */
export const PREVIOUS_SECRET_ACCEPTED_UNTIL = "2026-11-22T00:00:00+02:00";

const ACCEPTED_UNTIL_MS = Date.parse(PREVIOUS_SECRET_ACCEPTED_UNTIL);

/** Shorter than this is a typo or a placeholder, never a real signing secret. */
const MIN_PREVIOUS_LENGTH = 16;

function acceptedPrevious(previousRaw: string | undefined, currentRaw: string | undefined, now: Date): string | null {
  const previous = previousRaw?.trim();
  if (!previous || previous.length < MIN_PREVIOUS_LENGTH) return null;
  // The same value twice is no rotation at all — nothing extra to try.
  if (previous === currentRaw?.trim()) return null;
  // `!(a < b)` rather than `a >= b`, so an unreadable date fails closed too.
  if (!(now.getTime() < ACCEPTED_UNTIL_MS)) return null;
  return previous;
}

/** The pre-rotation `PHOENIX_AUTH_SECRET`, for VERIFYING an old link only — or null. */
export function previousAuthSecret(now: Date = new Date()): string | null {
  return acceptedPrevious(process.env.PHOENIX_AUTH_SECRET_PREVIOUS, process.env.PHOENIX_AUTH_SECRET, now);
}

/** The pre-rotation `CRON_SECRET`, accepted as a cron bearer until the end date — or null. */
export function previousCronSecret(now: Date = new Date()): string | null {
  return acceptedPrevious(process.env.CRON_SECRET_PREVIOUS, process.env.CRON_SECRET, now);
}
