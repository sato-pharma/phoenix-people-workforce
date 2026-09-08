// Recruitment / ATS — turning a rendered message plus a number into the one-press WhatsApp link.
//
// WHY A LINK AND NOT AN API SEND. An interview invitation goes to somebody who applied days ago, so
// the WhatsApp Cloud API's 24-hour customer-service window is shut (see whatsapp-interactive.ts,
// which documents the same boundary from the inbound side). Outside that window Meta accepts only a
// template it has itself approved, in its own positional `{{1}}` form, re-approved on every edit and
// billed per conversation — which cannot deliver "he writes the wording and it sends". A click-to-
// chat link has none of those limits: any wording, any length, Arabic and English together, free,
// no approval, and it goes out from the sender's own WhatsApp so the candidate sees a person.
//
// The cost of that choice, stated plainly because the UI must not overstate it: the recruiter still
// presses Send inside WhatsApp. Phoenix prepares the message; it does not deliver it. Nothing here
// may ever be logged or labelled as "sent".

import { toWhatsAppNumber } from "@/lib/reports/organogram-whatsapp";

/**
 * A number typed by hand, in international form, for anyone outside Egypt.
 *
 * Deliberately permissive about punctuation and strict about length: E.164 allows at most 15 digits
 * and no real number has fewer than 8. A leading `00` is the other way people write `+`.
 */
const INTERNATIONAL_DIGITS = /^[1-9][0-9]{7,14}$/u;

/**
 * The number WhatsApp wants: digits only, country code included, no `+`.
 *
 * Two readings are tried, Egyptian first. `toWhatsAppNumber` is the production-hardened repair used
 * by the organogram — it fixes the leading zero that seven in ten stored Egyptian mobiles have lost
 * to spreadsheet imports, and it REFUSES anything it cannot read with confidence rather than
 * trimming it into something plausible. That refusal is what we want: a wrong digit does not render
 * a broken screen, it opens a chat with a stranger.
 *
 * Only if that says no do we consider the text an already-international number. That order matters —
 * an Egyptian mobile written `01012345678` is 11 digits and would pass a naive international check
 * as a number in some other country entirely.
 */
export function toWhatsAppDialNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;

  const egyptian = toWhatsAppNumber(raw);
  if (egyptian) return egyptian;

  const trimmed = String(raw).trim();
  // `+20 …` and `0020 …` are the same number written two ways; strip either prefix, then judge.
  const digits = trimmed.replace(/^\+/u, "").replace(/^00/u, "").replace(/[^0-9]/gu, "");
  return INTERNATIONAL_DIGITS.test(digits) ? digits : null;
}

/** Whether a number — stored or typed — can be opened as a chat at all. */
export function isDialableWhatsApp(raw: string | null | undefined): boolean {
  return toWhatsAppDialNumber(raw) !== null;
}

/**
 * The click-to-chat URL carrying the whole message.
 *
 * `wa.me` is used rather than `api.whatsapp.com/send` because it is the form that resolves correctly
 * on a phone, in WhatsApp Desktop and on web without an intermediate "continue to chat" page.
 *
 * encodeURIComponent, not a hand-rolled escape: the message routinely holds newlines, Arabic, `&`
 * in an address and a Google Maps URL of its own. Any of those unescaped truncates the message at
 * the first special character — and it truncates SILENTLY, arriving as a half-written invitation.
 */
export function whatsAppSendUrl(number: string, message: string): string {
  const dial = toWhatsAppDialNumber(number);
  if (!dial) throw new Error("That number cannot be opened as a WhatsApp chat.");
  const text = message.trim();
  if (!text) return `https://wa.me/${dial}`;
  return `https://wa.me/${dial}?text=${encodeURIComponent(text)}`;
}

/**
 * The number as a human reads it back on screen — `+20 101 234 5678`.
 *
 * Display only. Every dial goes through `toWhatsAppDialNumber`, never through this, so a formatting
 * change here can never alter which chat opens.
 */
export function formatDialNumberForDisplay(raw: string | null | undefined): string | null {
  const dial = toWhatsAppDialNumber(raw);
  if (!dial) return null;
  if (dial.startsWith("20") && dial.length === 12) {
    // The national part is 10 digits: a TWO-digit operator code (10/11/12/15) then 4 + 4. Grouped
    // 3-4-3 it reads as a number from somewhere else entirely, which defeats the point of showing
    // it back — the sender is checking it against the number in front of them.
    const national = dial.slice(2);
    return `+20 ${national.slice(0, 2)} ${national.slice(2, 6)} ${national.slice(6)}`;
  }
  return `+${dial}`;
}
