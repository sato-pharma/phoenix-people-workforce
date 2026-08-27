import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time comparison of a caller-supplied secret against the expected value.
 *
 * `a === b` on strings short-circuits at the first differing byte, so the time it takes to
 * reject a wrong secret leaks how much of the prefix was right. Over the public internet that
 * signal is buried in jitter and this is not an urgent hole — but the repo already does the
 * right thing for the Telegram webhook and for session tokens, and having thirteen cron routes
 * do it differently is the kind of inconsistency that gets copied into the next route.
 *
 * The length comparison ahead of timingSafeEqual is required, not an optimisation:
 * timingSafeEqual THROWS on unequal-length buffers. Length is not the secret.
 */
export function secretMatches(received: string | null | undefined, expected: string): boolean {
  if (!received || !expected) return false;
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length && timingSafeEqual(receivedBuffer, expectedBuffer);
}

/**
 * Constant-time check of an `Authorization: Bearer <secret>` header.
 *
 * The shape every cron and notification route needs. Callers keep their own decision about what
 * to do when the secret is UNSET — because that is a policy question, not a comparison one.
 *
 * As of 2026-08-27 the rule is `if (!secret) return process.env.NODE_ENV === "development";`,
 * NOT `!isProductionRuntime()`. The latter reads "only in dev" but actually means "anywhere not
 * labelled production" — it silently opened 18 routes the moment an environment's APP_ENV went
 * unset (AGENTS.md §2.3). Do not reintroduce it, and do not copy it into a new route.
 *
 * Clearing the old pattern out took three passes — #1529 hardened the three
 * ireports360-visits-* crons, #1949 did reconciliation-check, and #2479 did the remaining 18.
 * Each prior pass fixed the routes without touching this comment, so the next route still
 * copied "the established rule" from here. That is why this paragraph is worth a commit of
 * its own, not just the routes.
 *
 * Even the hardened form is not a safety net on a laptop configured like this repo's: `.env.local`
 * points at PRODUCTION Supabase and carries no CRON_SECRET, so a local `pnpm run dev` still
 * bypasses every one of these routes against real data — including notifications/process, which
 * sends real mail. "Only a real developer machine" is a true statement about NODE_ENV; it is not
 * a claim that the machine is safe to leave unauthenticated.
 */
export function bearerSecretMatches(authorizationHeader: string | null | undefined, expected: string): boolean {
  return secretMatches(authorizationHeader, `Bearer ${expected}`);
}
