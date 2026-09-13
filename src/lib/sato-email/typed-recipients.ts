/**
 * Email addresses the sender types by hand into the Sato Email Composer.
 *
 * Owner 2026-09-13: "make an option to manual search and choose single or multiple reciepients and
 * option to manually write emails my self".
 *
 * Pure and dependency-free on purpose. The screen reads a pasted list with it as he types, and
 * parseSatoEmailDraft reads the posted draft with the very same function — so an address the screen
 * accepted is never one the server refuses for a different reason, and the other way round.
 */

/** A request-size guard, not an audience rule: an audience that large belongs on a distribution list. */
export const SATO_EMAIL_MAX_TYPED_ADDRESSES = 200;

/**
 * The company's own domain, as the SCREEN's hint for when to ask for a reason.
 *
 * The server does not read it. A send is judged by validateManualEmailRecipientPolicy against the
 * configured domains and the preview reports that verdict, so a hint that drifts can only ask for a
 * reason too early or too late — it can never let an outside address through unexplained.
 */
export const SATO_EMAIL_COMPANY_DOMAIN = "satopharma.com";

const ADDRESS = /^[^\s@<>()[\],;:"]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

export function normalizeTypedEmailAddress(value: string): string {
  return String(value ?? "")
    .trim()
    .replace(/^mailto:/i, "")
    .toLowerCase();
}

export function isTypedEmailAddress(value: string): boolean {
  const email = normalizeTypedEmailAddress(value);
  if (!ADDRESS.test(email)) return false;
  const domain = email.slice(email.lastIndexOf("@") + 1);
  // `.local` never routes — `phoenix.local` is the login-key identity address, not a mailbox, and a
  // send to it hard-bounces and damages the sending domain.
  return domain !== "local" && !domain.endsWith(".local");
}

/**
 * Splits whatever was typed or pasted into addresses.
 *
 * Commas, semicolons, new lines and spaces all separate, and an Outlook paste
 * (`Omar Gawish <omar@satopharma.com>; …`) keeps only the part inside the angle brackets. Anything
 * that is not an address comes back in `invalid`, exactly as typed, so the screen can leave it in
 * the box for the sender to correct instead of dropping it without a word.
 */
export function parseTypedEmailAddresses(text: string): { invalid: string[]; valid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const piece of String(text ?? "").split(/[,;\n\r]+/)) {
    const angled = [...piece.matchAll(/<([^<>]*)>/g)].map((match) => match[1]);
    const tokens = angled.length > 0 ? angled : piece.split(/\s+/);
    for (const token of tokens) {
      const raw = token.trim();
      if (!raw) continue;
      if (!isTypedEmailAddress(raw)) {
        if (!invalid.includes(raw)) invalid.push(raw);
        continue;
      }
      const email = normalizeTypedEmailAddress(raw);
      if (!valid.includes(email)) valid.push(email);
    }
  }
  return { invalid, valid };
}

export function isOutsideCompanyAddress(email: string): boolean {
  const domain = normalizeTypedEmailAddress(email).split("@").pop() ?? "";
  return domain !== SATO_EMAIL_COMPANY_DOMAIN && !domain.endsWith(`.${SATO_EMAIL_COMPANY_DOMAIN}`);
}
