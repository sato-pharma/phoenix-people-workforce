import { createHmac, randomInt, timingSafeEqual } from "crypto";

// Self-service password-reset CODE logic, kept pure and free of any database so the attempt-cap,
// expiry and hashing rules can be unit-tested directly. The DB orchestration that stores and emails
// these codes lives in src/lib/auth/password-setup.ts (requestPasswordResetCode /
// verifyPasswordResetCode); it calls the helpers here.

export const passwordResetCodeLength = 6;
export const passwordResetCodeExpiryMs = 15 * 60 * 1000;
export const passwordResetCodeMaxAttempts = 5;

/**
 * The metric label the six digits travel under, from requestPasswordResetCode to the email.
 *
 * It is a named constant because the code reaches the employee ONLY through the notification
 * metrics -> {{detailsTable}} path: the sender writes this label, the password_reset_code template
 * renders it, and nothing else in the email carries the digits. Shipped on 2026-10-07 against the
 * shared password_reset template, whose stored body has no {{detailsTable}}, which is why three
 * codes were delivered to Sato mailboxes with no code inside them.
 */
export const passwordResetCodeMetricLabel = "Your code";

// HMAC key. Reusing the session-signing secret (same fail-closed contract as session-token.ts) means
// the stored code hash cannot be brute-forced offline from a table dump — the key is not in the DB.
function getCodeHmacSecret() {
  const secret = process.env.PHOENIX_AUTH_SECRET?.trim();
  if (!secret) {
    throw new Error("PHOENIX_AUTH_SECRET is required to hash password reset codes.");
  }
  return secret;
}

/** A 6-digit code, 000000–999999, drawn without modulo bias. */
export function generatePasswordResetCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(passwordResetCodeLength, "0");
}

/** Strip everything a person might type around the digits (spaces, dashes) before compare/hash. */
export function normalizePasswordResetCode(value: string | null | undefined): string {
  return String(value ?? "").replace(/\D+/g, "");
}

/**
 * HMAC-SHA256(secret, "<login_id lowercased>:<digits>"). Binding the hash to the login_id means a
 * code minted for one account can never verify against another, even if two accounts were ever
 * issued the same six digits.
 */
export function hashPasswordResetCode(loginId: string, code: string): string {
  return createHmac("sha256", getCodeHmacSecret())
    .update(`${String(loginId).trim().toLowerCase()}:${normalizePasswordResetCode(code)}`)
    .digest("hex");
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export type ResetCodeRow = {
  attempts: number;
  code_hash: string;
  consumed_at: string | null;
  expires_at: string;
  login_id: string;
  max_attempts: number;
};

export type ResetCodeOutcome =
  | { status: "ok" }
  | { status: "expired" }
  | { status: "consumed" }
  | { status: "locked" }
  | { status: "mismatch"; locked: boolean; nextAttempts: number };

/**
 * The whole decision for a submitted code, given the stored row and the current time — no I/O. The
 * caller consumes the row on "ok", writes `nextAttempts` on "mismatch" (and treats a `locked:true`
 * mismatch as the code now being dead), and returns the SAME generic error to the client for every
 * non-ok status so nothing distinguishes "wrong code" from "no such code".
 */
export function evaluatePasswordResetCode(input: {
  code: string;
  now?: number;
  row: ResetCodeRow | null;
}): ResetCodeOutcome {
  const { row } = input;
  // No live row reads as a mismatch, so an unknown email and a wrong code are indistinguishable.
  if (!row) return { locked: false, nextAttempts: 0, status: "mismatch" };

  const now = input.now ?? Date.now();
  if (row.consumed_at) return { status: "consumed" };
  if (row.attempts >= row.max_attempts) return { status: "locked" };
  if (new Date(row.expires_at).getTime() <= now) return { status: "expired" };

  const expectedHash = hashPasswordResetCode(row.login_id, input.code);
  if (constantTimeEquals(expectedHash, row.code_hash)) {
    return { status: "ok" };
  }

  const nextAttempts = row.attempts + 1;
  return { locked: nextAttempts >= row.max_attempts, nextAttempts, status: "mismatch" };
}
