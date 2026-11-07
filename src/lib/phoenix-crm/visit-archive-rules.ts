/**
 * Phoenix CRM — the visits archive screen's pure rules (owner, 2026-11-07).
 *
 * The old iReports360 visits that could not be carried into Phoenix CRM as visits — a campaign visit, or a
 * visit with no check-in location — were retired into `public.phoenix_crm_visit_archive`. The Super Admin
 * and the SFE Manager read that table on /admin/phoenix-crm/visits-archive; the reader is
 * `src/lib/phoenix-crm/server/visit-archive.ts`. Everything here is pure, so the labels, the month bounds
 * and the page cursor are pinned without a database (tests/phoenix-crm-visit-archive-screen.test.ts).
 *
 * 🔴 `visit_date` IS A PLAIN DATE, NEVER AN INSTANT. It is formatted from its own digits and never passed
 * through a time zone: `new Date("2026-11-07")` is UTC midnight, and any zone west of it prints the 6th.
 */

export const VISIT_ARCHIVE_REASONS = ["campaign", "no_checkin_location"] as const;
export type VisitArchiveReason = (typeof VISIT_ARCHIVE_REASONS)[number];

/** What each reason reads as on the screen. A stored code is never shown. */
export const VISIT_ARCHIVE_REASON_LABELS: Readonly<Record<VisitArchiveReason, string>> = {
  campaign: "Campaign visit",
  no_checkin_location: "No check-in location",
};

/** Rows on one page of the list. */
export const VISIT_ARCHIVE_PAGE_SIZE = 100;

export function parseVisitArchiveReason(value: string | null | undefined): VisitArchiveReason | null {
  const text = String(value ?? "").trim();
  return (VISIT_ARCHIVE_REASONS as readonly string[]).includes(text) ? (text as VisitArchiveReason) : null;
}

/** The label for a stored reason; a reason this screen does not know reads as words, never as its code. */
export function visitArchiveReasonLabel(value: string | null | undefined): string {
  const reason = parseVisitArchiveReason(value);
  if (reason) return VISIT_ARCHIVE_REASON_LABELS[reason];
  const words = String(value ?? "")
    .trim()
    .replace(/[_-]+/g, " ")
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "—";
}

// ── Months ─────────────────────────────────────────────────────────────────────────────────────────

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DATE_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A `YYYY-MM` month, or null for anything else (an empty value means every month). */
export function parseVisitArchiveMonth(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return MONTH_PATTERN.test(text) ? text : null;
}

/** The first day of the month and the first day of the next one: `visit_date >= from AND visit_date < before`. */
export function visitArchiveMonthBounds(month: string): { from: string; before: string } | null {
  const match = MONTH_PATTERN.exec(month);
  if (!match) return null;
  const year = Number(match[1]);
  const index = Number(match[2]);
  const nextYear = index === 12 ? year + 1 : year;
  const nextIndex = index === 12 ? 1 : index + 1;
  return {
    from: `${match[1]}-${match[2]}-01`,
    before: `${String(nextYear).padStart(4, "0")}-${String(nextIndex).padStart(2, "0")}-01`,
  };
}

/** "November 2026". */
export function visitArchiveMonthLabel(month: string): string {
  const match = MONTH_PATTERN.exec(month);
  return match ? `${MONTH_NAMES[Number(match[2]) - 1]} ${match[1]}` : month;
}

/** The `YYYY-MM` a plain date falls in. */
export function visitArchiveMonthOf(date: string): string | null {
  const match = DATE_PATTERN.exec(date);
  return match ? `${match[1]}-${match[2]}` : null;
}

/** "Sat, 7 Nov 2026" — from the date's own digits, with no time zone anywhere (see the header). */
export function visitArchiveDateText(date: string | null | undefined): string {
  const match = DATE_PATTERN.exec(String(date ?? ""));
  if (!match) return "—";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Day of the week by Zeller-style arithmetic on the calendar digits, so no Date and no zone is involved.
  const shifted = month < 3 ? year - 1 : year;
  const weekday = (shifted + Math.floor(shifted / 4) - Math.floor(shifted / 100) + Math.floor(shifted / 400) + [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4][month - 1] + day) % 7;
  return `${WEEKDAYS[weekday]}, ${day} ${SHORT_MONTHS[month - 1]} ${year}`;
}

// ── The page cursor: keyset on (visit_date desc, crm_visit_id desc) ─────────────────────────────────

export type VisitArchiveCursor = { visitDate: string; crmVisitId: string };

/** `2026-11-07.123456` — the last row a page showed. The id stays a digit string: it is a bigint. */
export function encodeVisitArchiveCursor(cursor: VisitArchiveCursor): string {
  return `${cursor.visitDate}.${cursor.crmVisitId}`;
}

export function decodeVisitArchiveCursor(value: string | null | undefined): VisitArchiveCursor | null {
  const match = /^(\d{4}-\d{2}-\d{2})\.(\d{1,19})$/.exec(String(value ?? "").trim());
  if (!match || !DATE_PATTERN.test(match[1])) return null;
  const crmVisitId = match[2].replace(/^0+(?=\d)/, "");
  return { visitDate: match[1], crmVisitId };
}

// The keyset filter itself is built in server/visit-archive.ts, through the shared PostgREST quoting helper:
// these rules stay pure (tests/phoenix-crm-boundary.test.ts).

// ── The other filters ──────────────────────────────────────────────────────────────────────────────

/** An HR id picked from the rep list. Anything else is dropped rather than sent to the database. */
export function parseVisitArchiveRep(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return /^[A-Za-z0-9-]{1,24}$/.test(text) ? text : null;
}

/** A line code picked from the line list. */
export function parseVisitArchiveLine(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return /^[A-Za-z0-9 _&().-]{1,40}$/.test(text) ? text : null;
}

/** A person is marked as having left when their employee record says anything but active. */
export function visitArchivePersonLeft(employmentStatus: string | null | undefined): boolean {
  const status = String(employmentStatus ?? "").trim().toLowerCase();
  return status !== "" && status !== "active";
}

export type VisitArchiveFilter = {
  month: string | null;
  reason: VisitArchiveReason | null;
  rep: string | null;
  line: string | null;
  cursor: VisitArchiveCursor | null;
};

type SearchValue = string | string[] | undefined;

function firstOf(value: SearchValue): string {
  return (Array.isArray(value) ? (value[0] ?? "") : (value ?? "")).trim();
}

/** The page's search parameters, each one checked; a value that does not parse is simply not applied. */
export function parseVisitArchiveFilter(params: Record<string, SearchValue>): VisitArchiveFilter {
  return {
    month: parseVisitArchiveMonth(firstOf(params.month)),
    reason: parseVisitArchiveReason(firstOf(params.reason)),
    rep: parseVisitArchiveRep(firstOf(params.rep)),
    line: parseVisitArchiveLine(firstOf(params.line)),
    cursor: decodeVisitArchiveCursor(firstOf(params.after)),
  };
}

export const VISIT_ARCHIVE_PATH = "/admin/phoenix-crm/visits-archive";

/** The address of a filtered view; `after` moves to the page past that cursor. */
export function visitArchiveHref(filter: Omit<VisitArchiveFilter, "cursor">, after: VisitArchiveCursor | null = null): string {
  const query = new URLSearchParams();
  if (filter.month) query.set("month", filter.month);
  if (filter.reason) query.set("reason", filter.reason);
  if (filter.rep) query.set("rep", filter.rep);
  if (filter.line) query.set("line", filter.line);
  if (after) query.set("after", encodeVisitArchiveCursor(after));
  const text = query.toString();
  return text ? `${VISIT_ARCHIVE_PATH}?${text}` : VISIT_ARCHIVE_PATH;
}
