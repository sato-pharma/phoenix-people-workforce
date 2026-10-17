import type { BusinessCardFields } from "@/lib/business-cards/card-content";

// What an employee's email signature says, derived from the same register row the business card
// reads. Pure — no database, no image — so the page, the picture and a test all agree on every line.
//
// The signature is ONE picture, on purpose (owner, 2026-10-17): a pasted signature made of a table,
// a logo and a few text cells lets a person delete the Phoenix logo, or the phone number, and keep
// the rest. A single picture can only be removed whole.

export const SIGNATURE_WEB = "satopharma.com";
export const SIGNATURE_WEB_URL = "https://www.satopharma.com";
export const SIGNATURE_OFFICE = "Sheraton El Matar, Cairo";
export const SIGNATURE_TAGLINE = "Sato Pharma\u2019s HR platform";

export type SignatureLines = {
  /** "Pedia · CAIRO" — the line and area as registered; empty when the register holds neither. */
  area: string;
  email: string;
  mobile: string;
  name: string;
  office: string;
  title: string;
  web: string;
};

/**
 * The picture is drawn in Montserrat (the Sato card face), which has Latin letters only. A character
 * outside that set would print as an empty box, so it is dropped and the page says so, rather than the
 * picture quietly carrying a box in someone's name.
 */
const PRINTABLE = /[^\u0020-\u007E\u00A0-\u00FF\u2019\u2013\u2014\u00B7]/g;

export function printableLine(value: string | null | undefined): { dropped: boolean; text: string } {
  const source = (value ?? "").replace(/\s+/g, " ").trim();
  const text = source.replace(PRINTABLE, "").replace(/\s+/g, " ").trim();
  return { dropped: text.length !== source.length, text };
}

export function signatureLinesFor(card: Pick<BusinessCardFields, "email" | "lineArea" | "mobile" | "name" | "title">): {
  dropped: boolean;
  lines: SignatureLines;
} {
  const name = printableLine(card.name);
  const title = printableLine(card.title);
  const area = printableLine(card.lineArea);
  const mobile = printableLine(card.mobile);
  const email = printableLine(card.email);
  return {
    dropped: [name, title, area, mobile, email].some((part) => part.dropped),
    lines: {
      area: area.text,
      email: email.text,
      mobile: mobile.text,
      name: name.text,
      office: SIGNATURE_OFFICE,
      title: title.text,
      web: SIGNATURE_WEB,
    },
  };
}

/** The picture's alternative text: what a mail app shows when it blocks pictures — every line, in order. */
export function signatureAltText(lines: SignatureLines): string {
  return [
    lines.name,
    lines.title ? `${lines.title}, Sato Pharma` : "Sato Pharma",
    lines.area,
    lines.mobile ? `Mobile ${lines.mobile}` : "",
    lines.email ? `Email ${lines.email}` : "",
    `Web ${lines.web}`,
    `Office ${lines.office}`,
    `Phoenix Workforce, ${SIGNATURE_TAGLINE}`,
  ]
    .filter(Boolean)
    .join(" | ");
}
