/**
 * A PASSWORD THAT HAS ALREADY LEAKED IS REFUSED WHEN IT IS CHOSEN (integration audit INT-006; owner,
 * 13 Nov 2026: "Refuse it when chosen").
 *
 * password-strength.ts refuses the passwords every guessing list starts with. This closes the next ones:
 * a password that looks strong but sits in a published breach, which is the list a real attacker tries
 * second. It is asked at the two moments a person chooses a password (changing it, and setting it from a
 * link or a temporary password). Passwords already in use are not touched, and nothing is checked at
 * sign-in.
 *
 * HOW IT ASKS WITHOUT TELLING. Have I Been Pwned's range service (api.pwnedpasswords.com) takes the FIRST
 * FIVE characters of the password's SHA-1 fingerprint and answers with every leaked fingerprint that
 * starts with them, several hundred of them. The match is made here, on the server. Neither the password
 * nor its whole fingerprint ever leaves, and the service cannot tell which of its answers was ours.
 * `Add-Padding` makes every answer the same rough size, so the size says nothing either. No key, no
 * account, no cost.
 *
 * 🔴 IT FAILS OPEN, ON PURPOSE, AND SAYS SO. If the service cannot be reached inside three seconds the
 * password is accepted on the rules it already passed and the verdict is "unknown", which the caller
 * writes on its audit row. Failing closed would let an outage of somebody else's service stop every
 * new hire from setting a password. This is the one check in the sign-in code that may fail open,
 * because it only ever ADDS a refusal: with it gone, the rules are exactly what they were before it.
 */

import { createHash } from "node:crypto";

export const LEAKED_PASSWORD_MESSAGE =
  "This password has appeared in a known data leak, so it is one of the first that would be tried against your account. Choose a different one.";

export const LEAKED_PASSWORD_RANGE_URL = "https://api.pwnedpasswords.com/range/";
export const LEAKED_PASSWORD_TIMEOUT_MS = 3000;

export type LeakedPasswordVerdict =
  /** In a published breach. `timesSeen` is how often, as the service counts it. */
  | { leaked: true; timesSeen: number }
  | { leaked: false }
  /** The service could not be asked. Not a pass and not a refusal: the caller accepts and records it. */
  | { leaked: "unknown"; reason: string };

/** The SHA-1 fingerprint the range service is keyed by, in upper-case hex, split where the service splits it. */
export function leakedPasswordFingerprint(password: string): { prefix: string; suffix: string } {
  const digest = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
  return { prefix: digest.slice(0, 5), suffix: digest.slice(5) };
}

/**
 * How many times `suffix` appears in one range answer: lines of `SUFFIX:COUNT`. A padded answer carries
 * made-up lines with a count of 0, which are not leaks. Anything that is not such a line is ignored.
 */
export function timesSeenInRange(body: string, suffix: string): number {
  const wanted = suffix.toUpperCase();
  for (const line of body.split(/\r?\n/)) {
    const [candidate, count] = line.trim().split(":");
    if (candidate?.toUpperCase() === wanted) {
      const seen = Number.parseInt(count ?? "", 10);
      return Number.isFinite(seen) && seen > 0 ? seen : 0;
    }
  }
  return 0;
}

type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/** Asks whether a chosen password is in a published breach. Never throws. */
export async function checkLeakedPassword(
  password: string,
  options: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<LeakedPasswordVerdict> {
  try {
    const { prefix, suffix } = leakedPasswordFingerprint(password);
    const fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
    const response = await fetchImpl(`${LEAKED_PASSWORD_RANGE_URL}${prefix}`, {
      headers: { "Add-Padding": "true" },
      signal: AbortSignal.timeout(options.timeoutMs ?? LEAKED_PASSWORD_TIMEOUT_MS),
    });
    if (!response.ok) return { leaked: "unknown", reason: `the range service answered ${response.status}` };
    const body = await response.text();
    // A real answer always carries lines; an empty one is a broken answer, not "never leaked".
    if (!/^[0-9A-F]{35}:\d+/im.test(body)) return { leaked: "unknown", reason: "the range service sent an answer with no fingerprints" };
    const timesSeen = timesSeenInRange(body, suffix);
    return timesSeen > 0 ? { leaked: true, timesSeen } : { leaked: false };
  } catch (error) {
    const name = (error as { name?: string } | null)?.name ?? "";
    return {
      leaked: "unknown",
      reason: name === "TimeoutError" || name === "AbortError" ? "the range service did not answer in time" : "the range service could not be reached",
    };
  }
}

/** What goes on the audit row of a password that was accepted. */
export function leakedPasswordAuditValue(verdict: LeakedPasswordVerdict): "not_leaked" | "not_checked" {
  if (verdict.leaked === "unknown") {
    console.warn(`[auth/leaked-password] check skipped: ${verdict.reason}`);
    return "not_checked";
  }
  return "not_leaked";
}
