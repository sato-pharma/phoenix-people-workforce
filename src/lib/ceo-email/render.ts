import { systemDeployment, systemLegalEntity } from "@/config/system-settings";
import { HOUSE_COLORS } from "@/lib/hiring-pack/house-identity";
import { satoLogoUrl } from "@/lib/offers/brand";
import { prepareSatoEmailBody, satoEmailHtmlToText } from "@/lib/sato-email/render";

import { CEO_DOCUMENT_KICKER, type CeoSignature } from "./identity";

/**
 * The CEO letter: the house identity (SATO-DIS-2026-01) as an executive communication.
 *
 * Owner 2026-10-06: a composer "exactly as sato email composer … but a more corporate template …
 * and the template is with the signature of the ceo".
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * 🔴 WHAT IS SHARED WITH THE SATO RENDERER, AND WHY EXACTLY THAT MUCH.
 *
 * The BODY PIPELINE is shared and must stay shared: `prepareSatoEmailBody` is what sanitizes the
 * sender's markup, strips every coloured ground so THE INK RULE holds, writes the house spacing onto
 * his paragraphs, inks the list markers, and stamps the 6% zebra row by row because Word's engine has
 * no `:nth-child`. Every one of those is a locked rule in `AGENTS.md` §4, and a second copy of that
 * pipeline is a second place for one of them to rot. So this file does not reimplement any of it.
 *
 * The FRAME is deliberately NOT shared. The Sato frame is a company announcement — a notice the
 * organisation issues, with no human name on it. This one is a letter from one named person, and the
 * three things that makes it are the office in the masthead, the DATE, and a signature over a rule.
 * An announcement with a signature bolted on is not an executive letter, which is why this is a
 * template and not a flag.
 *
 * Everything is inline, on the element it styles, for the same reason the Sato renderer gives: a
 * `<style>` sheet is the one thing email clients most reliably throw away, and Outlook lays mail out
 * with Word — no flex, no grid, no `:nth-child`, no `::marker`.
 *
 * 🔴 THE INK RULE HOLDS HERE TOO. There is no filled area anywhere in this letter except the zebra
 * row the shared pipeline stamps. The signature is a RULE and a name, never a tinted card — a filled
 * signature panel is the first thing a corporate email template reaches for and it is forbidden.
 *
 * 🔴 AND THE SIGNATURE NAME NEVER COMES FROM THE BROWSER — see ./identity. This function takes a
 * resolved `CeoSignature`; it has no way to read one from a draft, which is the point.
 * ───────────────────────────────────────────────────────────────────────────────────────────── */

const MAX_WIDTH = 640;
const LOGO_WIDTH = 124;
const COMPANY_NAME = systemLegalEntity.legalNameEn;

/** The house standard every company document wears. `AGENTS.md` §4, THE DOCUMENT IDENTITY. */
const DOCUMENT_STANDARD = "SATO-DIS-2026-01 v1.0";

/** The line under the colophon. A one-to-one letter supplies its own. */
const DEFAULT_FOOTNOTE =
  "Issued by the Office of the Chief Executive. This message was sent to a company distribution list, and recipients cannot see each other's addresses.";

/** Aptos first — the house face, and what Microsoft 365 reads mail in. The rest is a phone's stack. */
const FONT_STACK = "Aptos,'Segoe UI',Arial,Helvetica,sans-serif";
const MONO_STACK = "Consolas,'Courier New',monospace";

/** The house ornament, drawn by `scripts/build-house-band-asset.ts`. Ornament only — never structure. */
const BAND_PUBLIC_PATH = "/brand/sato-house-band.png";

/** The label voice: one uppercase tracked line, at different weights of emphasis. */
const MICRO =
  "font-size:10px;line-height:15px;letter-spacing:1.6px;text-transform:uppercase;font-weight:bold";

const MSO_TABLE_RESET = "mso-table-lspace:0pt;mso-table-rspace:0pt";
const MSO_EXACT_LEADING = "mso-line-height-rule:exactly";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function logoBaseUrl(): string {
  const configured = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || systemDeployment.productionUrl;
  return /^https?:\/\//i.test(configured) ? configured : `https://${configured}`;
}

/**
 * The date on the letter, in Cairo local time — the owner's standing rule, and the only correct
 * answer for a document a reader in Cairo reads. `6 October 2026`, never an ISO stamp and never UTC.
 */
export function ceoLetterDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(now);
}

export type CeoEmailContent = {
  bodyHtml: string;
  /** "Sincerely", "With appreciation". The sender's, already normalized by ./identity. */
  closing: string;
  /** The date printed under the brand rule. Defaults to today in Cairo. */
  date?: string;
  /** The line under the colophon. Defaults to the distribution-list note. */
  footnote?: string;
  /** What this letter is, in the masthead's label line. Defaults to the Office of the Chief Executive. */
  kicker?: string;
  /** Resolved SERVER-SIDE from the employee directory. Never from the draft. */
  signature: CeoSignature;
  subject: string;
};

export function renderCeoEmail(content: CeoEmailContent): { html: string; text: string } {
  const subject = content.subject.trim();
  const closing = content.closing.trim();
  const kicker = content.kicker?.trim() || CEO_DOCUMENT_KICKER;
  const footnote = content.footnote?.trim() || DEFAULT_FOOTNOTE;
  const date = content.date?.trim() || ceoLetterDate();
  const signature = content.signature;
  // 🔴 The shared pipeline — the ink rule, the zebra, the sanitizer, the house spacing. Never a copy.
  const body = prepareSatoEmailBody(content.bodyHtml);
  const bodyText = satoEmailHtmlToText(body);
  const logo = satoLogoUrl(logoBaseUrl());
  const band = `${logoBaseUrl().replace(/\/+$/, "")}${BAND_PUBLIC_PATH}`;

  const hairline = (color: string, space: string) =>
    `<tr><td style="padding:${space};font-size:0;line-height:0">` +
    `<div style="border-top:1px solid ${color};font-size:0;line-height:0">&nbsp;</div></td></tr>`;

  /**
   * The line a client shows beside the subject. Left empty, a client fills it with the alt text of
   * the mark, so every letter previewed as the company name.
   */
  const preheader = () => {
    const opening = bodyText.replace(/\s+/g, " ").trim().slice(0, 140);
    if (!opening) return "";
    return (
      '<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#ffffff">' +
      `${escapeHtml(opening)}${"&#847;&zwnj;&nbsp;".repeat(24)}</div>`
    );
  };

  // The masthead: the mark on one side, and on the other the OFFICE this letter comes from over the
  // standard that issued it. The company name is not typeset beside the mark — the mark says it, and
  // the legal person is stated once in the provenance foot where a document names its issuer.
  const masthead =
    '<tr><td style="padding:0 0 18px 0">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
    `style="width:100%;border-collapse:collapse;${MSO_TABLE_RESET}">` +
    '<tr><td align="left" valign="bottom" style="padding:0">' +
    `<img src="${escapeHtml(logo)}" width="${LOGO_WIDTH}" alt="${escapeHtml(COMPANY_NAME)}" ` +
    `style="display:block;width:${LOGO_WIDTH}px;height:auto;border:0"></td>` +
    '<td align="right" valign="bottom" style="padding:0 0 2px 0">' +
    `<div dir="ltr" class="ceo-kicker" style="${MICRO};letter-spacing:2.2px;` +
    `color:${HOUSE_COLORS.deep}">${escapeHtml(kicker)}</div>` +
    // Mono, because a file reference is a number and reads as one. The only line in the document
    // that is not the house text face, which is what marks it as a stamp rather than as prose.
    '<div dir="ltr" class="ceo-std" style="padding-top:5px;' +
    `font-family:${MONO_STACK};font-size:10px;line-height:15px;letter-spacing:0.4px;` +
    `color:${HOUSE_COLORS.muted}">${DOCUMENT_STANDARD}</div>` +
    "</td></tr></table></td></tr>";

  // The brand rule the whole letterhead hangs from. INK, not the band image, so a reader with
  // images blocked still gets a letterhead rather than a masthead floating over text.
  const brandRule = `<tr><td style="border-top:2px solid ${HOUSE_COLORS.blue};font-size:0;line-height:0">&nbsp;</td></tr>`;

  /**
   * 🔴 THE DATE IS WHAT MAKES THIS A LETTER AND NOT A NOTICE, and it is the first difference from
   * the Sato frame. A chief executive's communication is dated — it is referred back to, quoted in a
   * meeting and filed. An announcement is not, which is why the Sato template has no date line.
   */
  const dateLine =
    `<tr><td dir="ltr" style="padding:22px 0 0 0;${MICRO};font-size:10px;letter-spacing:1.4px;` +
    `color:${HOUSE_COLORS.muted}">${escapeHtml(date)}</td></tr>`;

  const titleBlock =
    `<tr><td dir="auto" class="ceo-title" style="padding:10px 0 20px 0;font-family:${FONT_STACK};` +
    `font-size:25px;line-height:33px;letter-spacing:-0.3px;font-weight:bold;${MSO_EXACT_LEADING};` +
    `color:${HOUSE_COLORS.deep}">${escapeHtml(subject)}</td></tr>` +
    hairline(HOUSE_COLORS.hair, "0");

  /**
   * 🔴 THE SIGNATURE BLOCK — the second difference, and the one the owner asked for by name.
   *
   * The closing line, then a SHORT RULE, then the name, the office, and the company. The rule is
   * the house's own signature device (`HOUSE_COLORS.ink`, "every signature rule" in
   * `house-identity.ts`): ink, 1px, 200px wide — the width of a written signature, not of the
   * column, because a full-width rule here would read as another section starting.
   *
   * It is a rule and four lines of type. NOT a tinted card, NOT a bordered panel, NOT a two-column
   * block with a photograph — those are what a generic "corporate email signature" looks like, and
   * every one of them puts a filled area into a document THE INK RULE forbids one in.
   */
  const signatureBlock =
    `<tr><td dir="auto" style="padding:30px 0 0 0;font-size:16px;line-height:26px;` +
    `color:${HOUSE_COLORS.body}">${escapeHtml(closing)},</td></tr>` +
    '<tr><td style="padding:16px 0 0 0">' +
    '<table role="presentation" width="200" cellpadding="0" cellspacing="0" border="0" ' +
    `style="width:200px;border-collapse:collapse;${MSO_TABLE_RESET}">` +
    `<tr><td style="border-top:1px solid ${HOUSE_COLORS.ink};font-size:0;line-height:0">&nbsp;</td></tr>` +
    "</table></td></tr>" +
    '<tr><td dir="ltr" style="padding:10px 0 0 0;font-size:16px;line-height:23px;font-weight:bold;' +
    `color:${HOUSE_COLORS.deep}">${escapeHtml(signature.name)}</td></tr>` +
    '<tr><td dir="ltr" style="padding:2px 0 0 0;font-size:12px;line-height:18px;font-weight:bold;' +
    `letter-spacing:0.3px;color:${HOUSE_COLORS.body}">${escapeHtml(signature.titleEn)}</td></tr>` +
    '<tr><td dir="ltr" style="padding:1px 0 0 0;font-size:12px;line-height:18px;' +
    `color:${HOUSE_COLORS.muted}">${escapeHtml(signature.companyEn)}</td></tr>` +
    // `dir` decides which way the RUN reads; alignment is a separate question and the block answers
    // it. Without the explicit `text-align`, the Arabic office is flung to the far edge while the
    // English lines it belongs with stay at the margin, and the pair reads broken.
    '<tr><td dir="rtl" lang="ar" style="padding:1px 0 0 0;text-align:left;font-size:12px;' +
    `line-height:19px;color:${HOUSE_COLORS.muted}">${escapeHtml(signature.titleAr)}` +
    ` &#183; ${escapeHtml(signature.companyAr)}</td></tr>`;

  // THE PROVENANCE BLOCK: a micro label over the value it names, in columns. It answers the two
  // questions a company document has to answer about itself — who issued it, and under what
  // standard — in the label voice the whole document is set in.
  const provenance = (label: string, value: string, align: "left" | "right") =>
    `<td align="${align}" valign="top" class="ceo-prov" style="padding:0">` +
    `<div dir="ltr" style="${MICRO};font-size:9px;line-height:13px;letter-spacing:1.4px;` +
    `color:${HOUSE_COLORS.muted}">${escapeHtml(label)}</div>${value}</td>`;

  const footer =
    hairline(HOUSE_COLORS.hair, "34px 0 0 0") +
    '<tr><td style="padding:15px 0 0 0">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
    `style="width:100%;border-collapse:collapse;${MSO_TABLE_RESET}"><tr>` +
    provenance(
      "Issued by",
      `<div dir="ltr" style="padding-top:6px;font-size:12px;line-height:18px;font-weight:bold;` +
        `color:${HOUSE_COLORS.deep}">${escapeHtml(CEO_DOCUMENT_KICKER)}</div>` +
        '<div dir="ltr" style="font-size:12px;line-height:18px;' +
        `color:${HOUSE_COLORS.muted}">${escapeHtml(signature.companyEn)}</div>`,
      "left",
    ) +
    provenance(
      "Reference",
      `<div dir="ltr" style="padding-top:6px;font-family:${MONO_STACK};font-size:12px;` +
        `line-height:18px;color:${HOUSE_COLORS.body}">${DOCUMENT_STANDARD}</div>`,
      "right",
    ) +
    "</tr></table></td></tr>" +
    // THE COLOPHON: a SHORT centred hairline — a third of the column — and one centred micro line.
    '<tr><td align="center" style="padding:26px 0 0 0">' +
    '<table role="presentation" width="180" cellpadding="0" cellspacing="0" border="0" ' +
    `style="width:180px;border-collapse:collapse;${MSO_TABLE_RESET}">` +
    `<tr><td style="border-top:1px solid ${HOUSE_COLORS.hair};font-size:0;line-height:0">&nbsp;</td></tr>` +
    "</table></td></tr>" +
    '<tr><td align="center" style="padding:12px 0 0 0">' +
    `<div dir="ltr" style="font-size:10px;line-height:17px;letter-spacing:0.4px;color:${HOUSE_COLORS.muted}">` +
    `${escapeHtml(footnote)}</div></td></tr>`;

  const documentBlock =
    '<tr><td class="ceo-pad" style="padding:30px 34px 30px 34px">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
    `style="width:100%;border-collapse:collapse;${MSO_TABLE_RESET}">` +
    masthead +
    brandRule +
    dateLine +
    titleBlock +
    // `sato-message` marks the sender's own words inside the house frame, and it keeps the SATO name
    // on purpose: `unwrapSatoEmailFrame` (sato-email/source-document.ts) looks for this class to take
    // a frame off an email that is uploaded back into a composer. Renaming it here would hand the
    // reader two mastheads and two colophons nested one inside the other.
    `<tr><td class="sato-message" style="padding:22px 0 0 0;font-size:16px;line-height:27px;` +
    `${MSO_EXACT_LEADING};color:${HOUSE_COLORS.body}">${body}</td></tr>` +
    signatureBlock +
    footer +
    "</table></td></tr>";

  // The only stylesheet in the message, and nothing depends on it: a client that discards it gets
  // the 640px layout it would have got anyway. It exists so a phone gets its gutter back.
  const responsiveCss =
    "@media only screen and (max-width:620px){" +
    ".ceo-shell{padding:20px 12px !important}" +
    ".ceo-pad{padding:22px 18px !important}" +
    ".ceo-title{font-size:21px !important;line-height:29px !important}" +
    ".ceo-kicker{letter-spacing:1.4px !important}" +
    ".ceo-std{letter-spacing:0 !important}" +
    ".ceo-prov{display:block !important;width:100% !important;text-align:left !important;" +
    "padding:0 0 14px 0 !important}" +
    ".sato-cell{padding:6px 7px !important;font-size:14px !important;line-height:20px !important}}";

  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light only">' +
    '<meta name="supported-color-schemes" content="light">' +
    `<title>${escapeHtml(subject)}</title>` +
    `<style>${responsiveCss}</style></head>` +
    '<body style="margin:0;padding:0;background:#ffffff;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">' +
    preheader() +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
    `style="width:100%;border-collapse:collapse;${MSO_TABLE_RESET};background:#ffffff">` +
    '<tr><td align="center" class="ceo-shell" style="padding:36px 24px">' +
    `<table role="presentation" width="${MAX_WIDTH}" cellpadding="0" cellspacing="0" border="0" ` +
    `style="width:100%;max-width:${MAX_WIDTH}px;border-collapse:collapse;${MSO_TABLE_RESET};` +
    `font-family:${FONT_STACK};color:${HOUSE_COLORS.body}">` +
    // The frame carries its border on the CELL rather than on the `<table>` element: Word's engine
    // honours a cell border reliably and a table border only sometimes.
    `<tr><td style="padding:0;border:1px solid ${HOUSE_COLORS.hair}">` +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
    `style="width:100%;border-collapse:collapse;${MSO_TABLE_RESET}">` +
    '<tr><td style="padding:0;font-size:0;line-height:0">' +
    `<img src="${escapeHtml(band)}" width="${MAX_WIDTH}" alt="" ` +
    `style="display:block;width:100%;max-width:${MAX_WIDTH}px;height:auto;border:0"></td></tr>` +
    documentBlock +
    // The foot rule, flush against the frame's own bottom edge: the double line engraved stationery
    // closes with, and the counterweight to the band at the head.
    `<tr><td style="border-top:2px solid ${HOUSE_COLORS.deep};font-size:0;line-height:0">&nbsp;</td></tr>` +
    "</table></td></tr></table></td></tr></table></body></html>";

  const textParts = [
    subject,
    date,
    bodyText,
    `${closing},\n${signature.name}\n${signature.titleEn}\n${signature.companyEn}`,
    `--\n${CEO_DOCUMENT_KICKER}\n${DOCUMENT_STANDARD}`,
  ];

  return { html, text: textParts.filter(Boolean).join("\n\n") };
}
