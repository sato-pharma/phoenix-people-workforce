/**
 * The first password a new hire's mailbox is given, and how it is handed over.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE FLOW THIS SERVES (owner, 2026-10-02). Turbify sends NO invite — the invite field is left
 * empty on purpose, so no mail ever reaches the employee or any other address. The robot creates the
 * mailbox, signs into it with the one-time password Turbify shows, and immediately sets the password
 * to the COMPANY PATTERN. That value is recorded on the employee's row, readable by the System
 * Administrator alone, and the one remaining human act in the whole process is him passing the
 * address and the password to the new joiner.
 *
 * ONE COMPANY PASSWORD, BY THE OWNER'S DECISION (2026-10-02, "make it a company pattern"). He was
 * shown the exposure — a shared pattern is guessable, and a new joiner is the slowest person in the
 * company to change anything — and ruled for the pattern anyway, because the handover has to be
 * something he can give from memory. That is settled: do NOT reintroduce a per-mailbox random
 * password, and do not re-raise it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 🔴 WHY THE VALUE IS NOT IN THIS FILE. No password may be committed to this repository. So the
 * pattern lives in one environment variable the owner controls, and `readCompanyInitialPassword()`
 * returns null when it is unset rather than falling back to a default — a built-in default is how a
 * public, guessable password ends up on real mailboxes. The robot refuses to create anything when it
 * is missing, which is the right failure: no mailbox exists yet, so nothing is half-done.
 *
 * WHY IT IS STILL STORED PER EMPLOYEE. The pattern is one value TODAY, but the owner can change it
 * whenever he likes, and mailboxes created before the change keep the password they were actually
 * given. A row recording "this is the password this mailbox got" is therefore the only thing that
 * stays true; reading today's variable and showing it against an older mailbox would hand him a
 * password that does not open it.
 */

/** The one variable holding the company pattern. Set in Railway; never committed. */
export const COMPANY_PASSWORD_ENV = "PHOENIX_NEW_MAILBOX_INITIAL_PASSWORD" as const;

/**
 * The company password, from the environment.
 *
 * Never falls back to a default and never logs the value. Null when unset, so the caller can refuse
 * before touching the console.
 */
export function readCompanyInitialPassword(
  value: string | undefined = process.env[COMPANY_PASSWORD_ENV],
): string | null {
  const password = String(value ?? "").trim();
  return password.length > 0 ? password : null;
}

/**
 * Whether a configured password is one Turbify will accept and a person can pass on.
 *
 * This is NOT a judgement about strength — the owner has settled that. It catches the two failures
 * that would bite mid-flow: a value Turbify rejects for missing a character class, which fails
 * AFTER the mailbox already exists and leaves it on the one-time password; and a value carrying a
 * character that breaks a form field, a shell or a spreadsheet on its way to the new hire.
 */
export function isUsableInitialPassword(password: string | null | undefined): boolean {
  const text = String(password ?? "");
  if (text.length < 8) return false;
  // Whitespace, quotes and backslashes break the console form, CSV exports and shell quoting.
  if (/[\s'"\\`]/.test(text)) return false;
  return /[A-Z]/.test(text) && /[a-z]/.test(text) && /[0-9]/.test(text) && /[^A-Za-z0-9]/.test(text);
}

/** Why a configured password was refused, in words for whoever has to change it. */
export function explainUnusableInitialPassword(password: string | null | undefined): string | null {
  const text = String(password ?? "");
  if (text.length === 0) {
    return `${COMPANY_PASSWORD_ENV} is not set, so the robot has no password to give a new mailbox.`;
  }
  if (text.length < 8) return `${COMPANY_PASSWORD_ENV} is shorter than 8 characters, which Turbify refuses.`;
  if (/[\s'"\\`]/.test(text)) {
    return `${COMPANY_PASSWORD_ENV} contains a space, quote or backslash, which breaks the console form and every export it travels through.`;
  }
  const missing: string[] = [];
  if (!/[A-Z]/.test(text)) missing.push("a capital letter");
  if (!/[a-z]/.test(text)) missing.push("a small letter");
  if (!/[0-9]/.test(text)) missing.push("a digit");
  if (!/[^A-Za-z0-9]/.test(text)) missing.push("a symbol");
  if (missing.length > 0) {
    return `${COMPANY_PASSWORD_ENV} is missing ${missing.join(", ")}; Turbify would refuse it after the mailbox already exists.`;
  }
  return null;
}

/**
 * Who may read a stored initial password.
 *
 * It is recoverable by design — the System Administrator has to read it to hand it over — so it is
 * encrypted at rest and this is the ONLY audience. Enforced server-side in the route that reads it,
 * never by hiding a field in the UI: `system-navigation.ts` hiding a link is UX, not a boundary.
 */
export const INITIAL_PASSWORD_AUDIENCE = "super_admin_only" as const;

/**
 * Turbify's invite field is left EMPTY, by the owner's instruction — nobody is emailed.
 *
 * Exported as a constant rather than an inline blank so the intent cannot be read as an oversight
 * and quietly "fixed" by filling in an address. If Turbify ever refuses the form without one, the
 * robot fails closed and reports it rather than inventing a recipient.
 */
export const TURBIFY_INVITE_RECIPIENT = "" as const;
