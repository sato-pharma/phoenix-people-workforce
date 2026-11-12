import { randomInt } from "node:crypto";

/**
 * THE ACCOUNT EMAIL CARRIES A USERNAME AND A TEMPORARY PASSWORD (owner, 12 Nov 2026).
 *
 * His words: send the person their username, a password, and the production link; they copy the
 * username and password into the sign-in page, and are taken inside to change the password, which
 * stays their current password until they choose their own.
 *
 * How it holds together:
 *  - `sendPasswordSetupLink` in email mode writes a fresh temporary password (bcrypt only — the
 *    plain text exists in memory and in the one email), sets `force_password_reset` and
 *    `temporary_password_expires_at`, and emails Username · Temporary password · Sign in at.
 *  - The sign-in route asks `temporaryPasswordSignInGate` below. A correct temporary password inside
 *    its window does NOT open a session: it mints a short-lived setup token and sends the person to
 *    the existing /password-setup screen (`?then=sign-in`), which signs them in once they have chosen
 *    their own password. So nothing in the app is reachable on the temporary password itself.
 *  - Any OTHER pending password (an admin reset link, a new account never sent anything) keeps
 *    refusing the sign-in exactly as before — that is why the marker is its own column and not
 *    `force_password_reset` alone: a reset link leaves the old password in place, and reading the flag
 *    alone would let a password the admin meant to kill open the set-a-new-one screen.
 *
 * This file is pure (no database), so the decision and the password shape are tested on their own.
 */

/** How long an emailed temporary password opens the choose-your-password screen. */
export const temporaryPasswordExpiryMs = 7 * 24 * 60 * 60 * 1000;

/** How long the setup token minted at sign-in lives — the person is standing on the screen. */
export const temporaryPasswordSetupTokenExpiryMs = 15 * 60 * 1000;

export const TEMPORARY_PASSWORD_USERNAME_LABEL = "Username";
export const TEMPORARY_PASSWORD_METRIC_LABEL = "Temporary password";
export const TEMPORARY_PASSWORD_SIGN_IN_LABEL = "Sign in at";

// No 0/O, 1/l/I: the person copies it, and sometimes types it from a phone screen.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
const GROUPS = 3;
const GROUP_LENGTH = 4;

/**
 * Every temporary password matches this, and nothing ordinary in an email does: it is how a stored
 * copy of the rendered email has the password removed (src/lib/email/credential-redaction.ts).
 */
export const TEMPORARY_PASSWORD_PATTERN = /Phx-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}(?![A-Za-z0-9])/g;

/**
 * `Phx-Ab3d-K7mq-9TxR` — about 70 bits from a cryptographic source, with an upper-case letter, a
 * lower-case letter and a digit always present so no password policy refuses it.
 */
export function createReadableTemporaryPassword(): string {
  for (;;) {
    const groups = Array.from({ length: GROUPS }, () =>
      Array.from({ length: GROUP_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join(""),
    );
    const body = groups.join("");
    if (/[A-Z]/.test(body) && /[a-z]/.test(body) && /[0-9]/.test(body)) {
      return `Phx-${groups.join("-")}`;
    }
  }
}

export type TemporaryPasswordSignInDecision =
  /** No pending password: sign in normally. */
  | "sign_in"
  /** A correct temporary password inside its window: open the choose-your-password screen. */
  | "choose_password"
  /** A temporary password whose window has passed: refuse, and say to ask HR for a new one. */
  | "temporary_password_expired"
  /** Any other pending password (a reset link, a new account): refuse exactly as before. */
  | "setup_required";

/**
 * What a sign-in whose password was ALREADY VERIFIED does next. Reads only the two stored facts.
 * An unreadable expiry counts as expired: a marker nobody can read never opens anything.
 */
export function temporaryPasswordSignInGate(
  user: { forcePasswordReset: boolean; temporaryPasswordExpiresAt: string | null | undefined },
  now: Date = new Date(),
): TemporaryPasswordSignInDecision {
  if (!user.forcePasswordReset) return "sign_in";
  const marker = String(user.temporaryPasswordExpiresAt ?? "").trim();
  if (!marker) return "setup_required";
  const expiresAt = new Date(marker).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) return "temporary_password_expired";
  return "choose_password";
}

/** The query flag on /password-setup that signs the person in once their password is saved. */
export const SIGN_IN_AFTER_SETUP_PARAM = "then";
export const SIGN_IN_AFTER_SETUP_VALUE = "sign-in";

export function temporaryPasswordSetupPath(token: string): string {
  return `/password-setup/${encodeURIComponent(token)}?${SIGN_IN_AFTER_SETUP_PARAM}=${SIGN_IN_AFTER_SETUP_VALUE}`;
}
