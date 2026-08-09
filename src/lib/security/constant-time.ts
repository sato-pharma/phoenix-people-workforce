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
 * to do when the secret is UNSET — the established rule is
 * `if (!secret) return !isProductionRuntime()`, i.e. fail closed in production and stay usable
 * locally — because that is a policy question, not a comparison one.
 */
export function bearerSecretMatches(authorizationHeader: string | null | undefined, expected: string): boolean {
  return secretMatches(authorizationHeader, `Bearer ${expected}`);
}
