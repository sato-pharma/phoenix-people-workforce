// Shared email send errors + helpers, kept in their own module so both the high-level sender
// (send-phoenix-email.ts) and the low-level provider adapters (email-providers.ts) can import
// them without a circular dependency. Re-exported from send-phoenix-email.ts for back-compat.

/**
 * A send failure that the outbox should RETRY (rate limit / provider 5xx / timeout),
 * optionally honouring a provider-supplied Retry-After delay. Distinct from a permanent
 * 4xx error which should not be retried.
 */
export class RetryableEmailError extends Error {
  retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = "RetryableEmailError";
    this.retryAfterMs = retryAfterMs;
  }
}

export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}
