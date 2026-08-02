// Keeps the Brevo FAILOVER key alive.
//
// Brevo expires an API key after 90 CONSECUTIVE DAYS OF INACTIVITY, and its own generate-key
// dialog states this applies "regardless of the set expiry date" — so even the key we created
// with "No expiration" dies if nothing calls it. BREVO_API_KEY is the backup sender in
// src/lib/email/email-providers.ts: by design it is NEVER exercised while Resend is healthy.
// Left alone it would therefore expire silently, and the failover would be dead at the exact
// moment Resend finally fails — a backup that only breaks when you need it is worse than no
// backup, because the system reports [resend, brevo] and believes it is covered.
//
// Deliberately GET /v3/account, not a send: it authenticates the key without dispatching an
// email or burning a send credit (the account is on the free 300/day tier).
//
// This is also a live health check on the failover, not just a timer reset — a 401 here means
// the key has been revoked or has already expired, which is precisely the state nobody would
// otherwise notice until an outage.

const BREVO_ACCOUNT_ENDPOINT = "https://api.brevo.com/v3/account";
const KEEPALIVE_TIMEOUT_MS = 15_000;

export type BrevoKeepaliveResult =
  // No backup configured. A legitimate state (failover is optional), so NOT an alarm.
  | { status: "skipped"; reason: string }
  // Key authenticated — the 90-day inactivity clock is reset.
  | { status: "ok"; account: string | null }
  // Key rejected, or Brevo unreachable. The caller escalates this; see the route.
  | { status: "failed"; reason: string };

/**
 * Authenticates BREVO_API_KEY against Brevo. Never throws — the caller decides what a failure
 * means, so this stays usable from contexts (like a digest) where a dead backup must not abort
 * the surrounding work.
 */
export async function pingBrevoApiKey(): Promise<BrevoKeepaliveResult> {
  const apiKey = process.env.BREVO_API_KEY?.trim();
  if (!apiKey) return { status: "skipped", reason: "BREVO_API_KEY is not configured — no email failover to keep alive." };

  let response: Response;
  try {
    response = await fetch(BREVO_ACCOUNT_ENDPOINT, {
      headers: { accept: "application/json", "api-key": apiKey },
      method: "GET",
      signal: AbortSignal.timeout(KEEPALIVE_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      status: "failed",
      reason: error instanceof Error ? `Brevo keepalive request failed: ${error.message}` : "Brevo keepalive request failed.",
    };
  }

  if (!response.ok) {
    // 401/403 is the one worth waking someone for: the failover key is revoked or already expired.
    return { status: "failed", reason: `Brevo keepalive returned ${response.status}.` };
  }

  const payload = (await response.json().catch(() => null)) as { email?: string } | null;
  return { status: "ok", account: payload?.email ?? null };
}
