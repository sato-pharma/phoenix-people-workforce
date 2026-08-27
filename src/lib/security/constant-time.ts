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
 * The shape every cron and notification route needs. Callers still own the decision about what to
 * do when the secret is UNSET — that is a policy question, not a comparison one — but the answer
 * is settled: `if (!secret) return process.env.NODE_ENV === "development"`. An unset secret may be
 * bypassed on a developer machine and nowhere else.
 *
 * This comment used to prescribe `if (!secret) return !isProductionRuntime()`, described as "fail
 * closed in production and stay usable locally". The second clause is the one that is not true.
 * isProductionRuntime() reads APP_ENV || VERCEL_ENV || NODE_ENV, so its negation does not mean
 * "locally" — it means any environment that fails to label itself production, including staging,
 * which runs a 1:1 clone of production data. Anywhere the secret was unset, a route following this
 * advice was callable unauthenticated by anyone. Clearing it took three passes (#1529, #1949,
 * #2479) across 22 routes, and this sentence is why it was in all 22. Do not restore it.
 */
export function bearerSecretMatches(authorizationHeader: string | null | undefined, expected: string): boolean {
  return secretMatches(authorizationHeader, `Bearer ${expected}`);
}
