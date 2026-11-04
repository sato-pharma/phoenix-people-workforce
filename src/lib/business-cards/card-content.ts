import { CARD_ADDRESS, CARD_WEBSITE } from "./card-layout.ts";

// What each line of a card says, derived from the employee record. Pure — no database, no PDF —
// so the screen shows exactly what the PDF will print, and a test can pin every rule.

export type BusinessCardFields = {
  address: string;
  email: string;
  lineArea: string;
  mobile: string;
  name: string;
  title: string;
  website: string;
};

export type BusinessCardSource = {
  areaName: string | null;
  displayName: string;
  /** The legal name — the made-up work address is built from it (see fallbackCardEmail). */
  fullName?: string | null;
  jobTitle: string | null;
  lineName: string | null;
  mobileNumber: string | null;
  workEmail: string | null;
};

/** The fields a person may correct on screen before printing. Website and address are the company's. */
export const EDITABLE_CARD_FIELDS = ["name", "title", "lineArea", "mobile", "email"] as const;
export type EditableCardField = (typeof EDITABLE_CARD_FIELDS)[number];

/** Longest value accepted for any one line — well past anything that fits the card at all. */
export const CARD_FIELD_MAX_LENGTH = 120;

function clean(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * "+20 10 1234 5678" — the design's own phone format.
 *
 * The register holds mobiles in several shapes: `1012345678` with the leading zero lost to a
 * spreadsheet, `01012345678`, `201012345678`, `010 123 45678`, `010-1234-5678`, and a few cells with
 * two numbers joined by a dash. The FIRST number is the one printed. Anything that is not an Egyptian
 * mobile once normalised is printed as typed rather than forced into a shape it does not have.
 *
 * The whole cell is tried as ONE number before it is split: a hyphen is also how a single number is
 * grouped, and splitting first would print `010-1234-5678` as `010`.
 */
function egyptianMobile(text: string): string | null {
  let digits = text.replace(/\D/g, "");
  if (digits.startsWith("0020")) digits = digits.slice(4);
  if (digits.length === 12 && digits.startsWith("20")) digits = digits.slice(2);
  if (digits.length === 10 && digits.startsWith("1")) digits = `0${digits}`;
  return /^01[0125]\d{8}$/.test(digits) ? `+20 ${digits.slice(1, 3)} ${digits.slice(3, 7)} ${digits.slice(7)}` : null;
}

export function formatCardMobile(raw: string | null | undefined): string {
  const whole = clean(raw);
  if (!whole) return "";
  const asOne = egyptianMobile(whole);
  if (asOne) return asOne;
  // Explicit separators first (a comma, slash, semicolon or spaced dash), each part again tried whole;
  // only then a bare hyphen, as in `01012345678-01298765432`.
  const first = clean(whole.split(/\s-\s|[,/;]/)[0]);
  const firstAsOne = egyptianMobile(first);
  if (firstAsOne) return firstAsOne;
  const beforeHyphen = clean(first.split("-")[0]);
  return egyptianMobile(beforeHyphen) ?? beforeHyphen;
}

/**
 * "Pedia · CAIRO" — the line as registered, the area in capitals, as on the design.
 *
 * An area that only repeats the line ("Head Office · HEAD OFFICE") prints the line alone.
 */
export function formatCardLineArea(lineName: string | null | undefined, areaName: string | null | undefined): string {
  const line = clean(lineName);
  const area = clean(areaName);
  if (!area) return line;
  if (!line) return area.toUpperCase();
  if (line.toLowerCase() === area.toLowerCase()) return line;
  return `${line} · ${area.toUpperCase()}`;
}

/** The company mail domain every card address is on. */
export const CARD_EMAIL_DOMAIN = "satopharma.com";

/**
 * "first.second@satopharma.com" — the address a card prints when the register holds no work email.
 *
 * Owner, 2026-11-04: "Even if no email, get his first name dot his second name at satopharma.com,
 * never make it empty." Built from the legal full name (else the display name): its first two words,
 * English letters only, lowercase. A name with no English letters at all yields "" — there is nothing
 * honest to spell, and the card then leaves the line off as before.
 */
export function fallbackCardEmail(fullName: string | null | undefined, displayName?: string | null): string {
  const words = (name: string | null | undefined) =>
    clean(name)
      .split(" ")
      .map((word) => word.toLowerCase().replace(/[^a-z]/g, ""))
      .filter(Boolean);
  const parts = words(fullName).length ? words(fullName) : words(displayName);
  return parts.length ? `${parts.slice(0, 2).join(".")}@${CARD_EMAIL_DOMAIN}` : "";
}

export function cardFieldsFor(source: BusinessCardSource): BusinessCardFields {
  return {
    address: CARD_ADDRESS,
    // NEVER EMPTY (owner, 2026-11-04): the register's work email, else first.second@satopharma.com.
    email: clean(source.workEmail).toLowerCase() || fallbackCardEmail(source.fullName, source.displayName),
    lineArea: formatCardLineArea(source.lineName, source.areaName),
    mobile: formatCardMobile(source.mobileNumber),
    name: clean(source.displayName),
    title: clean(source.jobTitle),
    website: CARD_WEBSITE,
  };
}

/**
 * Applies what was typed on screen over the record's values. Blank means "leave this line off" —
 * except the email, which is never left off (owner, 2026-11-04): a blanked email keeps the card's own.
 */
export function applyCardEdits(
  fields: BusinessCardFields,
  edits: Partial<Record<EditableCardField, unknown>> | null | undefined,
): BusinessCardFields {
  const next = { ...fields };
  for (const key of EDITABLE_CARD_FIELDS) {
    const value = edits?.[key];
    if (typeof value !== "string") continue;
    const typed = clean(value).slice(0, CARD_FIELD_MAX_LENGTH);
    if (key === "email" && !typed) continue;
    next[key] = typed;
  }
  return next;
}

/**
 * "Dr. Aya Elsawy" — the name with the doctor's title before it, for the per-card toggle on the HR
 * screen (owner, 2026-11-04: "If I turn on this toggle, the card is printed with doctor and the name
 * before it"). A name that already carries the title is left as it is, so it never prints "Dr. Dr.".
 */
export function withDoctorTitle(name: string): string {
  const cleaned = clean(name);
  if (!cleaned || /^(dr\.?|doctor)(\s|$)/i.test(cleaned)) return cleaned;
  return `Dr. ${cleaned}`.slice(0, CARD_FIELD_MAX_LENGTH);
}

/** The two lines an employee sets for their own card when they ask HR to print it. */
export type RequestedCardLines = { cardMobile: string | null; cardName: string | null; createdAt: string; status: string };

/**
 * The employee's own card as they last asked for it, laid over the record (owner, 2026-11-04: "one rep
 * or an employee edit in how his business card want. It syncs in the main module in the admin").
 *
 * The LATEST request that is not Cancelled wins. Its name prints when it has one; its mobile prints as
 * they sent it, and a request sent with the mobile cleared prints no mobile, as their own preview did.
 */
export function applyRequestedCard(fields: BusinessCardFields, request: RequestedCardLines | null | undefined): BusinessCardFields {
  if (!request) return fields;
  const name = clean(request.cardName).slice(0, CARD_FIELD_MAX_LENGTH);
  return {
    ...fields,
    mobile: clean(request.cardMobile).slice(0, CARD_FIELD_MAX_LENGTH),
    name: name || fields.name,
  };
}

/** The request that stands for each person's card: newest first, Cancelled skipped. */
export function latestRequestedCard<T extends RequestedCardLines>(requests: readonly T[]): T | null {
  return [...requests]
    .filter((request) => request.status !== "Cancelled")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}
