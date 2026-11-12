/**
 * The password setup/reset link, written as a WhatsApp message the admin never has to type.
 *
 * WHY THIS IS A PREPARED LINK AND NOT AN API SEND, WHICH IS NOT A SHORTCUT. The owner asked to be able
 * to send the setup link over WhatsApp (2026-10-29), because an employee who has never signed in reads
 * WhatsApp long before he reads a mailbox he cannot open yet. **WhatsApp's Cloud API cannot carry a
 * free-form message to someone who has not written to the business in the last 24 hours**, and no
 * approved utility template exists to carry a one-time credential link — so an "automatic" send would
 * be a silent failure on exactly the people this is for.
 *
 * So this composes the whole message and hands it to WhatsApp with the recipient's own chat already
 * open, where the admin presses send. That is the pattern this codebase already established, in its own
 * words at `src/lib/phoenix-crm/forecast-whatsapp.ts`: "the only 'send' in this codebase PREPARES a
 * wa.me link for a human to press in their own WhatsApp."
 *
 * 🔴 DO NOT "FINISH" THIS INTO AN AUTOMATIC SEND. There is no endpoint to send it to for a recipient
 * outside a 24-hour window, and a future session that posts to `graph.facebook.com` here gets a 470 or
 * a 131047 and concludes the token is wrong.
 *
 * 🔴 AND THE LINK IS NEVER PUT IN THE MESSAGE BY ANYONE BUT THE SERVER. The whole value of the URL is
 * that it sets a password, so it is minted on the POST that prepares it and travels nowhere else.
 *
 * Pure on purpose — no imports, no server types — so the wording is tested without a browser and a
 * client component can read it without dragging server code into the bundle.
 */

export type PasswordSetupWhatsAppInput = {
  /** When the link stops working, as the server issued it (ISO, UTC). */
  readonly expiresAt: string;
  /** The id the person signs in with afterwards. */
  readonly loginId: string;
  /** The person's real name, for the greeting. */
  readonly name: string;
  readonly purpose: "reset" | "setup";
  /** The absolute `https://…/password-setup/<token>` URL. */
  readonly setupUrl: string;
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/**
 * The expiry, in Cairo, written the way the recipient reads it.
 *
 * 🔴 ASSEMBLED FROM NUMERIC PARTS WITH OUR OWN MONTH NAMES, never handed to a locale formatter whole.
 * `toLocaleString("en-US", …)` prints `10/30/2026, 7:45:00 PM` and its separators and month spellings
 * move with the engine's ICU build — which is the standing trap in this repo: a string formatted one
 * way on this laptop and another on the runner. Only the TIME ZONE comes from Intl, because converting
 * UTC to Cairo by hand is where the DST errors live.
 */
export function passwordSetupExpiryLabel(expiresAt: string): string {
  const when = new Date(expiresAt);
  if (Number.isNaN(when.getTime())) return expiresAt;

  const parts = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    hour: "numeric",
    hour12: true,
    minute: "2-digit",
    month: "numeric",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).formatToParts(when);

  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  const month = MONTH_NAMES[Number(part("month")) - 1] ?? part("month");
  const dayPeriod = part("dayPeriod").toUpperCase().replace(/[^AMP]/gu, "");

  return `${Number(part("day"))} ${month} ${part("year")}, ${Number(part("hour"))}:${part("minute")} ${dayPeriod} (Cairo)`;
}

/**
 * The message itself. English always, the person's NAME rather than a code in the greeting, the expiry
 * in Cairo local time, and no ellipsis anywhere — the same four house rules the emailed version obeys.
 *
 * The login ID is spelled out on purpose even though the set-password page needs no login: the link
 * only sets the password, and the very next thing the person does is sign in with that id. The
 * activation email carries it for the same reason.
 *
 * 🔴 NO PASSWORD, NO CODE IN THIS ONE — only the one-time link. The message is composed for a chat that
 * lives on two handsets forever, so the only secret it may carry is one that expires. The account
 * message below (composeTemporaryPasswordMessage, owner 12 Nov 2026) is the one exception, because its
 * password expires too and dies at first sign-in.
 */
export function composePasswordSetupWhatsAppMessage(input: PasswordSetupWhatsAppInput): string {
  const name = input.name.trim() || input.loginId.trim();
  const opening =
    input.purpose === "setup"
      ? "Your Phoenix Workforce account is ready. Open this link to set your password:"
      : "Here is your one-time link to reset your Phoenix Workforce password:";

  return [
    `Dear ${name},`,
    "",
    opening,
    input.setupUrl.trim(),
    "",
    `Your login ID is ${input.loginId.trim()}.`,
    `The link can be used once, and it works until ${passwordSetupExpiryLabel(input.expiresAt)}.`,
  ].join("\n");
}

export type TemporaryPasswordMessageInput = {
  /** When the temporary password stops working (ISO, UTC). */
  readonly expiresAt: string;
  readonly loginId: string;
  readonly name: string;
  readonly purpose: "reset" | "setup";
  /** The production sign-in page. */
  readonly signInUrl: string;
  readonly temporaryPassword: string;
};

/** The validity line in Cairo, the same wording the email's "Valid until" row carries. */
export function temporaryPasswordExpiryLabel(expiresAt: string): string {
  return passwordSetupExpiryLabel(expiresAt);
}

/**
 * THE ACCOUNT MESSAGE (owner, 12 Nov 2026): username, temporary password, then the production link —
 * in that order, each on its own line so it copies cleanly from a phone. Used for WhatsApp and
 * Telegram alike. This is the one message allowed to carry a password, because the password is
 * temporary: it only opens the choose-your-own-password screen, it dies the moment the person picks
 * theirs, and it expires on its own (src/lib/auth/temporary-password.ts).
 */
export function composeTemporaryPasswordMessage(input: TemporaryPasswordMessageInput): string {
  const name = input.name.trim() || input.loginId.trim();
  const opening =
    input.purpose === "setup"
      ? "Your Phoenix Workforce account is ready. Sign in with:"
      : "Here is a new temporary password for Phoenix Workforce. Sign in with:";

  return [
    `Dear ${name},`,
    "",
    opening,
    "",
    `Username: ${input.loginId.trim()}`,
    `Temporary password: ${input.temporaryPassword.trim()}`,
    `Sign in at: ${input.signInUrl.trim()}`,
    "",
    "After you sign in, Phoenix asks you to choose your own password, and the temporary one stops working.",
    `The temporary password works until ${passwordSetupExpiryLabel(input.expiresAt)}.`,
  ].join("\n");
}

export function composeTemporaryPasswordWhatsAppMessage(input: TemporaryPasswordMessageInput): string {
  return composeTemporaryPasswordMessage(input);
}

/**
 * WhatsApp, with that person's chat open and the message already written in it.
 *
 * 🔴 THE NUMBER IS REQUIRED HERE, unlike the CRM forecast's share sheet. A setup link is addressed to
 * ONE person: `wa.me/?text=` would open the picker and invite the admin to send a live credential to
 * whichever chat he taps, which is the one mistake this flow cannot afford. The caller resolves the
 * number from the employee register and renders nothing at all when it cannot be read with confidence.
 */
export function passwordSetupWhatsAppUrl(whatsAppNumber: string, message: string): string {
  return `https://wa.me/${whatsAppNumber.replace(/[^0-9]/gu, "")}?text=${encodeURIComponent(message)}`;
}
