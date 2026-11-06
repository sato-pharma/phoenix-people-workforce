/**
 * Email types that are transactional: they are how a person gets back INTO their account.
 *
 * These must never be unsubscribable, and — the part that was missing — must never be
 * withheld because of an unsubscribe the person made from something else.
 *
 * THE BUG THIS EXISTS TO CLOSE: the unsubscribe endpoint already refused to unsubscribe
 * these types, and its landing page promised "You will still receive account and security
 * emails." But an unsubscribe from ANY other type wrote a durable row into
 * email_suppressions, and loadSuppressedRecipients() in send-phoenix-email.ts filtered
 * every outgoing address against that table with no regard for what was being sent. So one
 * click on a birthday or SLA email permanently blocked that person's password reset and
 * account-setup links — locking them out of their own account recovery, while the page they
 * clicked told them the opposite.
 *
 * Hard bounces and complaints still suppress everything, including these. That is not a
 * preference the recipient expressed, it is the mailbox provider telling us the address is
 * undeliverable or that we are damaging our sending reputation — overriding it would not get
 * the mail delivered anyway.
 *
 * Shared deliberately: the unsubscribe route and the send path must agree on this list, and
 * two copies of a security-relevant set is exactly the kind of thing that drifts apart.
 */
export const TRANSACTIONAL_EMAIL_TYPES = new Set<string>([
  "password_reset",
  "user_created",
  "password_setup",
]);

export function isTransactionalEmailType(type: string | null | undefined): boolean {
  return TRANSACTIONAL_EMAIL_TYPES.has(String(type ?? "").trim().toLowerCase());
}

// The standing admin BCC, and with it the reset-code exemption from it (2026-10-08), ended on
// 2026-11-06 (owner: "Stop the BCC copies") — no automated email is blind-copied to him any more.
// His copy of every email is the Telegram mirror, whose one exception is the list below.

/**
 * The two kinds of email that carry a live credential and are therefore NOT mirrored to the admin's
 * Telegram (owner decision, 23 Oct 2026, by multiple choice: "Skip credential emails"; audit P5-01).
 *
 *  - `password_reset_code` — the self-service 6-digit reset code.
 *  - `password_setup_link` — a one-time set-your-password link (the account-setup link, and the
 *    admin-minted reset link, which is the same password-setup token).
 *
 * EXPLICIT, NEVER GUESSED. The send site that builds one of these emails stamps the kind on the send
 * (`credentialEmail`), and only that stamp withholds the mirror. Nothing reads the subject, the body or
 * the template to decide it, and no other email loses its mirror: every other automated email keeps
 * its Telegram copy exactly as before. There is no standing BCC any more (owner, 2026-11-06).
 */
export const CREDENTIAL_EMAIL_KINDS = ["password_reset_code", "password_setup_link"] as const;
export type CredentialEmailKind = (typeof CREDENTIAL_EMAIL_KINDS)[number];

export function isCredentialEmailKind(value: unknown): value is CredentialEmailKind {
  return typeof value === "string" && (CREDENTIAL_EMAIL_KINDS as readonly string[]).includes(value);
}

/** Does this just-sent email get its Telegram twin? Pure, so the decision is tested on its own. */
export function shouldMirrorEmailToAdminTelegram(input: {
  credentialEmail?: CredentialEmailKind | string | null;
  testingRedirectActive: boolean;
}): boolean {
  if (input.testingRedirectActive) return false;
  if (isCredentialEmailKind(input.credentialEmail)) return false;
  return true;
}

/**
 * Suppression reasons that a recipient chose, as opposed to ones the mail system was told
 * about. Only these are overridden for transactional mail.
 */
export function isRecipientPreferenceSuppression(reason: string | null | undefined): boolean {
  return String(reason ?? "").trim().toLowerCase() === "unsubscribe";
}
