import { isCredentialEmailKind } from "@/lib/email/transactional-types";

/**
 * What a record keeps of a password credential: nothing usable (owner, 9 Nov 2026).
 *
 * The email outbox seals the reset code and the set-your-password link while a send waits
 * (src/lib/notifications/credential-seal.ts). Three other records kept them readable after the send:
 * the Notification Confidence Gate's copy of every rendered email (notification_send_reviews), the
 * notification's own row (notification_events.action_url and metadata.href) and the mail provider's
 * click events (email_delivery_events.raw_event). These helpers strip them before anything is stored.
 *
 * The link's token is 32 random bytes in base64url (password-setup.ts createToken), so a run of 16 or
 * more of those characters after `password-setup/` is a token. The six-digit code is the only
 * six-digit run in a reset-code email: measured on all 33 stored on production, once in the text
 * and once in the HTML, and a colour such as `#003366` is excluded by the `#` before it.
 */
export const CREDENTIAL_REMOVED = "[removed]";

const SETUP_LINK_TOKEN = /(password-setup\/)[A-Za-z0-9_-]{16,}/g;
const RESET_CODE = /(?<![#\w])\d{6}(?!\w)/g;

/** Any set-your-password link in the text, with its token removed. */
export function redactCredentialLinks(text: string): string {
  return text.replace(SETUP_LINK_TOKEN, `$1${CREDENTIAL_REMOVED}`);
}

/**
 * A rendered credential email as it may be stored: the link's token removed, and for the reset-code
 * email the six digits too. Any other email is returned unchanged.
 */
export function redactCredentialEmailBody(text: string, credentialEmail: unknown): string {
  if (!isCredentialEmailKind(credentialEmail)) return text;
  const withoutLinks = redactCredentialLinks(text);
  return credentialEmail === "password_reset_code" ? withoutLinks.replace(RESET_CODE, CREDENTIAL_REMOVED) : withoutLinks;
}

/** A JSON value (a provider's webhook payload) with every set-your-password link's token removed. */
export function redactCredentialLinksInJson<T>(value: T): T {
  const json = JSON.stringify(value);
  if (json === undefined) return value;
  const redacted = redactCredentialLinks(json);
  return redacted === json ? value : (JSON.parse(redacted) as T);
}
