// One Africa/Cairo timestamp format, for screens that show when something happened.
//
// The owner reports and reads every time in Cairo local, never raw UTC. This was a private function
// inside recruitment-candidates-portal.tsx until the candidate comment thread needed the same
// format on 2026-08-30; it is here rather than copied so the two cannot drift into showing the same
// instant two ways on one card.
//
// Client-safe: no database, no server-only import. That matters — it is called from "use client"
// components, and a formatter that reached for anything server-side would drag it into the bundle.

/**
 * The month names, written out rather than asked for, because the ANSWER IS NOT THE SAME ON EVERY
 * ENGINE and these strings get hydrated.
 *
 * `toLocaleDateString("en-GB", { month: "short" })` used to build them. CLDR 42 (ICU 72, late 2022)
 * renamed the en-GB abbreviation for September from "Sep" to "Sept", so the string an engine
 * produces depends on how old its bundled ICU data is:
 *
 *   Node 24 (ICU 78, the Railway server) -> "01 Sept 2026"
 *   Chrome 148 / modern Safari           -> "01 Sept 2026"
 *   Chrome 106 (Samsung Internet 20)     -> "01 Sep 2026"
 *
 * Half of this app's Cairo timestamps are rendered inside "use client" components, which means the
 * server renders the text and the browser re-renders it during hydration. When the two engines
 * disagree by one character React discards the server HTML and throws hydration error #418. That is
 * not hypothetical: every one of the four #418 events on /employee-portals/recruitment-candidates in
 * the fortnight to 2026-09-06 came from the one reader on Samsung Internet 20, on a card that
 * renders `cairoDateTime(candidate.createdAt)`.
 *
 * September is the only entry that differs, but the whole table is spelled out — a lookup where one
 * row is special and eleven are borrowed from the platform is the version that rots. The values are
 * exactly what current ICU produces, so nothing on screen changes for a reader on an up-to-date
 * browser; an old engine simply converges on the same string the server sent.
 */
const CAIRO_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"] as const;

/**
 * Every field NUMERIC, so the parts themselves carry no locale opinion — digits are digits on every
 * ICU version. The zone stays pinned to Cairo (the owner reads Cairo, never UTC) and the month name
 * is applied afterwards from the table above.
 *
 * `hourCycle: "h23"` rather than `hour12: false`: with `hour: "2-digit"` some ICU builds render
 * midnight as "24:00", which is a valid time string and the WRONG DAY beside a date that has
 * already rolled over. h23 pins the hour to 00-23.
 */
const CAIRO_PARTS = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  month: "2-digit",
  timeZone: "Africa/Cairo",
  year: "numeric",
});

type CairoParts = { day: string; hour: string; minute: string; month: string; year: string };

function cairoParts(value: Date): CairoParts {
  const parts: Record<string, string> = {};
  for (const part of CAIRO_PARTS.formatToParts(value)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return parts as CairoParts;
}

function parseIsoInstant(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const value = new Date(iso);
  return Number.isNaN(value.getTime()) ? null : value;
}

function formatCairoDatePart(value: Date): string {
  const { day, month, year } = cairoParts(value);
  return `${day} ${CAIRO_MONTHS[Number(month) - 1]} ${year}`;
}

/** e.g. `30 Aug 2026`. An absent or unparseable value renders as an em dash, never as today. */
export function cairoDate(iso: string | null | undefined): string {
  const value = parseIsoInstant(iso);
  return value ? formatCairoDatePart(value) : "—";
}

/** e.g. `30 Aug 2026 · 14:05`. An absent or unparseable value renders as an em dash, never as now. */
export function cairoDateTime(iso: string | null | undefined): string {
  const value = parseIsoInstant(iso);
  if (!value) return "—";
  const { hour, minute } = cairoParts(value);
  return `${formatCairoDatePart(value)} · ${hour}:${minute}`;
}

const UTC_PARTS = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "UTC",
  year: "numeric",
});

/**
 * e.g. `15 Sept 2026`, pinned to UTC — the DATE-ONLY sibling of `cairoDate`.
 *
 * A UTC formatter in a file named cairo-datetime looks out of place, and it is here on purpose.
 * Two kinds of value must NOT be dragged to Cairo: a DATE-ONLY column (`activity_date`, a period
 * key), which `new Date` parses as UTC midnight so UTC is what stops the calendar day shifting;
 * and a vendor wall-clock that is already Cairo but tagged UTC (iReports360 sends zone-less local
 * times). Both were already correct on that axis — their bug was the LOCALE.
 *
 * `en-GB` + `month: "short"` is engine-dependent: CLDR 42 (ICU 72) renamed the abbreviation for
 * September from "Sep" to "Sept", so Railway's Node 24 (ICU 78) and an older mobile browser
 * produce different bytes for the same value. In a `"use client"` component that text is built
 * twice — once by Node for the HTML, once by the browser on hydrate — and React discards the
 * server HTML over the one-character difference: hydration error #418.
 *
 * So this shares `CAIRO_MONTHS` rather than carrying its own copy. A second month table is exactly
 * how validated-customer-register grew an unsafe private `cairoDateTime`, and the point of putting
 * the names in code is lost the moment there are two lists to keep in step.
 *
 * Output is byte-identical to what `en-GB` renders on current ICU, so nothing on screen changes for
 * a reader on an up-to-date browser; an old engine simply converges on the string the server sent.
 */
export function utcDate(iso: string | null | undefined): string {
  const value = parseIsoInstant(iso);
  if (!value) return "—";
  const parts: Record<string, string> = {};
  for (const part of UTC_PARTS.formatToParts(value)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return `${parts.day} ${CAIRO_MONTHS[Number(parts.month) - 1]} ${parts.year}`;
}

/**
 * The same Cairo instant as `2026-08-30 14:05` — for spreadsheets, not screens.
 *
 * `cairoDateTime` above is built to be READ, and `30 Aug 2026 · 14:05` reads well and sorts
 * appallingly: a column of it in Google Sheets orders by the month's first letter, putting April
 * before August before December, and the middle dot stops Sheets recognising the cell as a date at
 * all. This form sorts correctly as text AND is parsed as a real datetime, so the sheet can filter,
 * group and chart on it.
 *
 * Deliberately added here rather than beside the feed that first needed it: the platform already
 * had several private Cairo formatters before this module existed, and a new one living next to one
 * consumer is how the next one gets written.
 *
 * Empty string, never an em dash, for an absent value — a spreadsheet's blank cell is its own "no
 * value", and a dash in a date column defeats both the sort and the date parsing.
 */
export function cairoDateTimeSortable(iso: string | null | undefined): string {
  const value = parseIsoInstant(iso);
  if (!value) return "";
  const { day, hour, minute, month, year } = cairoParts(value);
  return `${year}-${month}-${day} ${hour}:${minute}`;
}
