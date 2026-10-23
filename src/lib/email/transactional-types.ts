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

/**
 * Template keys whose BODY IS a live credential, and which therefore take NO standing admin BCC.
 *
 * The owner's instruction, 2026-10-08: *"stop bcc-ing the reset code email to my mailbox"*. Every
 * automated email is BCC'd to ADMIN_STANDING_EMAIL (send-phoenix-email.ts), which is a copy of
 * outbound HR mail — but a self-service reset code is not a record of anything, it is the secret
 * itself, usable by whoever reads it for the 15 minutes it lives. A standing copy turns one
 * person's account recovery into a credential sitting in a second mailbox.
 *
 * Keyed on the TEMPLATE KEY, not the notification type: `password_reset` covers both this and the
 * admin-minted reset LINK, and only the code email is scoped here. The owner has not asked for the
 * link emails (`password_reset`, `password_setup`) to lose their copy, so they keep it.
 *
 * It is NOT a privacy flag in general — it removes exactly one recipient from exactly these
 * templates. Every other template, and every other channel, is untouched.
 */
export const NO_STANDING_COPY_TEMPLATE_KEYS = new Set<string>([
  "password_reset_code",
]);

export function isOneTimeCodeTemplateKey(templateKey: string | null | undefined): boolean {
  return NO_STANDING_COPY_TEMPLATE_KEYS.has(String(templateKey ?? "").trim().toLowerCase());
}

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
 * its Telegram copy exactly as before. The standing BCC is a separate rule (NO_STANDING_COPY above).
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
