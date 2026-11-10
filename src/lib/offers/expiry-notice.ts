import { OFFER_DEFAULT_THEME } from "@/lib/offers/default-template";
import type { OfferRecord } from "@/lib/offers/types";

/**
 * The "your offer has expired" notice — the rules, with no database and no mail in them.
 *
 * Asked for by the owner on 2026-10-07: beside Resend, a button that tells the candidate the offer
 * has lapsed and withdraws it. It is the candidate-facing half that Withdraw never had — withdrawing
 * an offer flips the row to `withdrawn` silently, and the person who was sent a letter is told
 * nothing. This renders the short note they receive.
 *
 * ── Why this is NOT the offer letter ──
 * An expiry notice is a few lines, not a six-page letter with a salary table and a signature page.
 * So it is its own small renderer rather than a reuse of `renderOfferEmail`, which renders the
 * frozen offer blocks. It still speaks as Sato Pharma (never Phoenix) and carries the same Sato mark
 * the letter does, so the two read as coming from the same company — `src/lib/offers/identity.ts`
 * and `brand.ts` are the shared halves that guarantee that.
 *
 * ── Why it is MANUAL and one offer at a time ──
 * The standing owner rule is that a rejection-style notice is never sent automatically, in either
 * channel. This notice is reached only by a confirmed button press on a single sent offer — never a
 * batch, never a planner, never a cron — which is what keeps it inside that rule.
 */

/** Square-edge, hairline, Sato-ink — the same restraint the offer email body keeps. */
const MAX_WIDTH = 640;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Why this offer cannot be expired, or null when it can.
 *
 * Only a SENT offer. A draft was never sent, so there is nothing to expire. An accepted or declined
 * offer has been answered — the candidate acted on it, and telling them afterwards that it lapsed
 * would contradict a recorded fact. A withdrawn offer has already been taken back.
 */
export function offerExpiryRefusal(offer: Pick<OfferRecord, "candidateEmail" | "status">): string | null {
  switch (offer.status) {
    case "draft":
    case "pending_approval":
      return "This offer has not been sent yet, so there is nothing to expire.";
    case "accepted":
    case "declined":
      return "The candidate has already answered this offer, so it is not expired.";
    case "withdrawn":
      return "This offer has already been withdrawn.";
    case "sent":
      break;
    default:
      return "Only a sent offer can be expired.";
  }
  if (!offer.candidateEmail.trim()) {
    return "This offer has no candidate email address, so no expiry notice can be sent.";
  }
  return null;
}

/**
 * The key the notice goes out under, stable per offer.
 *
 * Stable, not per-press, because there is no legitimate reason to tell a candidate twice that the
 * same offer expired — and once the notice lands the offer is withdrawn, so the button is gone from
 * the row anyway. A stable key means a double-submit, or a retry after the status write failed, puts
 * a single notice in the inbox (Resend dedupes a repeated key for 24 hours).
 */
export function offerExpiryIdempotencyKey(offerId: string): string {
  return `offer-expiry:${offerId}`;
}

/** The subject line. Names the role so the candidate knows which offer, never the blunt word alone. */
export function offerExpirySubject(offer: Pick<OfferRecord, "title">): string {
  const title = offer.title.trim();
  return title ? `Update on your offer of employment — ${title}` : "Update on your offer of employment";
}

type ExpiryFields = Pick<OfferRecord, "candidateName" | "reference" | "salutationName" | "territory" | "title">;

export type RenderedOfferExpiryNotice = { html: string; text: string };

/**
 * The short notice as an email body, plus the plain-text alternative.
 *
 * `logoSrc` is a `cid:` part of the message (what the real send uses) or an https URL — never a
 * `data:` URI, which Gmail and Outlook strip. The caller resolves which, exactly as the letter does.
 */
export function renderOfferExpiryNotice(fields: ExpiryFields, options: { logoSrc?: string } = {}): RenderedOfferExpiryNotice {
  const theme = OFFER_DEFAULT_THEME;
  const greetingName = fields.salutationName.trim() || fields.candidateName.trim();
  const role = fields.title.trim();
  const territory = fields.territory.trim();
  const reference = fields.reference.trim();
  const position = role
    ? `the position of <strong>${escapeHtml(role)}</strong>${territory ? ` in ${escapeHtml(territory)}` : ""}`
    : "the position we offered you";

  const logo = String(options.logoSrc ?? "");
  const mark = /^(?:https:\/\/|cid:)/i.test(logo)
    ? `<img src="${escapeHtml(logo)}" alt="SATO PHARMACEUTICALS" height="34" style="height:34px;display:block;border:0">`
    : `<div style="font-size:15px;font-weight:bold;letter-spacing:1.5px;color:${theme.brand}">SATO PHARMACEUTICALS</div>`;

  const paragraph = (inner: string) =>
    `<p style="margin:0 0 12px;color:${theme.body};font-size:14px;line-height:1.6">${inner}</p>`;

  const body =
    // The letterhead, matched to the offer email's own: the mark left, the unit label right.
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse">' +
    `<tr><td style="padding:14px 0;vertical-align:bottom">${mark}</td>` +
    `<td style="padding:14px 0;text-align:right;vertical-align:bottom">` +
    `<div style="font-size:10px;letter-spacing:1.6px;text-transform:uppercase;font-weight:bold;color:${theme.brand}">SATO PHARMACEUTICALS</div>` +
    `<div style="margin-top:3px;font-size:10px;letter-spacing:1.4px;text-transform:uppercase;color:${theme.soft}">Human Resources</div>` +
    "</td></tr></table>" +
    `<div style="height:5px;background:${theme.brand};font-size:0;line-height:0">&nbsp;</div>` +
    (reference
      ? `<div style="margin-top:14px;font-size:10px;letter-spacing:1.2px;text-transform:uppercase;font-weight:bold;color:${theme.soft}">Reference</div>` +
        `<div style="margin-top:3px;font-size:13px;font-weight:bold;color:${theme.ink}">${escapeHtml(reference)}</div>`
      : "") +
    `<h1 style="margin:18px 0 0;font-size:20px;line-height:1.25;color:${theme.ink};font-weight:bold">Your offer of employment has expired</h1>` +
    `<div style="margin:12px 0;height:2px;width:72px;background:${theme.brand};font-size:0;line-height:0">&nbsp;</div>` +
    paragraph(`Dear <strong>${escapeHtml(greetingName)}</strong>,`) +
    paragraph(
      `Thank you for the time and interest you gave to Sato Pharmaceuticals. We are writing to let you ` +
        `know that the offer of employment we extended to you for ${position} has now expired and is no ` +
        `longer valid.`,
    ) +
    paragraph(
      `We were glad to have the chance to speak with you, and we wish you every success. Should the right ` +
        `opportunity arise in the future, we would be pleased to be in touch again.`,
    ) +
    paragraph("With kind regards,") +
    `<div style="margin-top:2px;font-size:14px;font-weight:bold;color:${theme.ink}">Human Resources</div>` +
    `<div style="font-size:12px;color:${theme.soft}">Sato Pharmaceuticals</div>`;

  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>Update on your offer of employment</title></head>" +
    '<body style="margin:0;padding:0;background:#f2f5f7">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;background:#f2f5f7">' +
    '<tr><td align="center" style="padding:24px 12px">' +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${MAX_WIDTH}" ` +
    `style="width:100%;max-width:${MAX_WIDTH}px;border-collapse:collapse;background:#ffffff;` +
    `font-family:'Segoe UI',Arial,Helvetica,sans-serif">` +
    `<tr><td style="padding:0 24px 28px">${body}</td></tr>` +
    "</table></td></tr></table></body></html>";

  const textLines = [
    "SATO PHARMACEUTICALS — Human Resources",
    "",
    "YOUR OFFER OF EMPLOYMENT HAS EXPIRED",
    reference ? `Reference: ${reference}` : "",
    "",
    `Dear ${greetingName},`,
    "",
    "Thank you for the time and interest you gave to Sato Pharmaceuticals. We are writing to let you " +
      `know that the offer of employment we extended to you for ${
        role ? `the position of ${role}${territory ? ` in ${territory}` : ""}` : "the position we offered you"
      } has now expired and is no longer valid.`,
    "",
    "We were glad to have the chance to speak with you, and we wish you every success. Should the right " +
      "opportunity arise in the future, we would be pleased to be in touch again.",
    "",
    "With kind regards,",
    "Human Resources",
    "Sato Pharmaceuticals",
  ];

  return { html, text: textLines.filter((line, index) => !(line === "" && textLines[index - 1] === "")).join("\n").trim() };
}
