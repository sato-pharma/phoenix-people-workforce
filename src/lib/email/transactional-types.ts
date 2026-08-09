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
 * Suppression reasons that a recipient chose, as opposed to ones the mail system was told
 * about. Only these are overridden for transactional mail.
 */
export function isRecipientPreferenceSuppression(reason: string | null | undefined): boolean {
  return String(reason ?? "").trim().toLowerCase() === "unsubscribe";
}
