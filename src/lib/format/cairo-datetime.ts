// One Africa/Cairo timestamp format, for screens that show when something happened.
//
// The owner reports and reads every time in Cairo local, never raw UTC. This was a private function
// inside recruitment-candidates-portal.tsx until the candidate comment thread needed the same
// format on 2026-08-30; it is here rather than copied so the two cannot drift into showing the same
// instant two ways on one card.
//
// Client-safe: no database, no server-only import. That matters — it is called from "use client"
// components, and a formatter that reached for anything server-side would drag it into the bundle.

import { cairoWallClock, isCairoZone } from "@/lib/format/cairo-zone";

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
export const CAIRO_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"] as const;

/**
 * Every field NUMERIC, so the parts themselves carry no locale opinion — digits are digits on every
 * ICU version. The month name is applied afterwards from the table above.
 *
 * THE ZONE IS "UTC" AND THAT IS THE CAIRO FIX, not a regression of it. Asking an engine for
 * `timeZone: "Africa/Cairo"` gets Egypt's offset out of whatever timezone data that engine was
 * built with, and Egypt REINTRODUCED daylight saving in 2023 — so a browser older than that renders
 * every Cairo timestamp an hour early for half the year, while the server renders it correctly.
 * In a `"use client"` component both sides render the same text and React compares them: one digit
 * apart is hydration error #418. It was the whole of the platform's remaining #418 in
 * September 2026. So `cairoWallClock` moves the instant using a table that ships with the code,
 * and the digits are then read off in UTC — the one zone with no rules for two engines to disagree
 * about. See src/lib/format/cairo-zone.ts.
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
  timeZone: "UTC",
  year: "numeric",
});

type CairoParts = { day: string; hour: string; minute: string; month: string; year: string };

function cairoParts(value: Date): CairoParts {
  const parts: Record<string, string> = {};
  for (const part of CAIRO_PARTS.formatToParts(cairoWallClock(value))) {
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

/**
 * Engine-stable `en-GB`, for the sites that are NOT one of the fixed shapes above.
 *
 * `cairoDate`/`cairoDateTime`/`utcDate` cover the three formats this app renders most, and each
 * builds its string from numeric parts. That does not scale to the long tail: a repo sweep on
 * 2026-09-08 found 69 further client-side sites across 21 distinct option shapes — some with
 * seconds, some with a weekday, some month-only, some `hour12`, in four different zones. Twenty-one
 * more named helpers would be worse than the disease.
 *
 * So this keeps the CALLER'S options verbatim — every field, and above all the timeZone — and
 * replaces only the month token, which is the single thing measured to vary between ICU versions
 * (CLDR 42 renamed en-GB's abbreviated September from "Sep" to "Sept"). Structure, ordering and
 * separators still come from the engine; the month name now ships with the code.
 *
 * THE ZONE IS NEVER TOUCHED, and that is the point. Most of those 69 sites are correctly zoned
 * already — a `date` column pinned to UTC so the calendar day cannot shift, a vendor wall-clock
 * that is Cairo but tagged UTC — and a blanket move to Cairo would break every one of them. This
 * migration changes one axis, the locale data, and leaves the zone question to the separate
 * instant-format ratchet that already tracks it.
 *
 * Two mechanisms, one of them invisible:
 *
 *   1. The month token, as above.
 *   2. `formatToParts` and `format` DISAGREE WITH EACH OTHER inside one engine. On Node 24 / ICU 78,
 *      `en-GB` with `hour12` puts a plain space before "pm" via `format()` and U+202F (narrow
 *      no-break space) via `formatToParts()`. Joining the parts would therefore change a character
 *      nobody can see, on six of these sites — and an invisible character is still a text node, so
 *      it is still hydration error #418. Normalised back to a plain space, which is both what
 *      renders today and a value that cannot drift.
 *
 * Verified byte-identical to `new Intl.DateTimeFormat("en-GB", options).format(value)` on current
 * ICU across 16 shapes x 12 months x 3 days x 3 hours (1,728 cases), so nothing on screen moves.
 */
function applyStableMonth(parts: readonly Intl.DateTimeFormatPart[], monthIndex: number): string {
  return parts
    .map((part) => (part.type === "month" ? CAIRO_MONTHS[monthIndex] : part.value))
    .join("")
    .replace(/\u202f/g, " ");
}

/**
 * Drop-in for `new Intl.DateTimeFormat("en-GB", options)` — same `.format(date)` shape, so a module
 * that builds its formatter once still builds it once.
 */
export function stableEnGbFormatter(options: Intl.DateTimeFormatOptions): { format(value: Date): string } {
  // A CAIRO request is served from the shipped offset table and rendered in UTC, for the reason in
  // CAIRO_PARTS above: Egypt's 2023 return to daylight saving is absent from any engine built
  // before it, and this helper's whole job is bytes two engines agree on. Every other zone is
  // passed through untouched — most of this helper's ~69 call sites are correctly zoned already
  // (a `date` column pinned to UTC, a vendor wall-clock that is Cairo but tagged UTC), and the
  // zone was never the axis this module changes.
  const cairo = isCairoZone(options.timeZone);
  const resolved = cairo ? { ...options, timeZone: "UTC" } : options;
  const display = new Intl.DateTimeFormat("en-GB", resolved);
  // Numeric month in the SAME zone as the caller asked for; digits are identical on every ICU.
  const month = new Intl.DateTimeFormat("en-GB", { month: "2-digit", timeZone: resolved.timeZone });
  return {
    format(value: Date): string {
      const at = cairo ? cairoWallClock(value) : value;
      return applyStableMonth(display.formatToParts(at), Number(month.format(at)) - 1);
    },
  };
}

/** Drop-in for `date.toLocaleDateString("en-GB", options)` and its toLocaleString siblings. */
export function formatStableEnGb(value: Date, options: Intl.DateTimeFormatOptions): string {
  return stableEnGbFormatter(options).format(value);
}


/**
 * "Oct 20, 2026, 02:04 PM" — the 12-hour Cairo form, built from digits so every engine prints the same bytes.
 *
 * `new Intl.DateTimeFormat("en", { hour12: true, timeZone: "Africa/Cairo", … })` printed this on the
 * server, and an iPhone printed something else in two ways (System Audit APP-C3275308, the Vacation
 * Report, 7 hydration mismatches for 4 people, 4 Sep – 20 Oct 2026):
 *
 *   - The space before AM/PM. Node 24 (ICU 78, the Railway server) emits a plain space; Safari's
 *     WebKit — the engine every iPhone browser runs, Chrome and Edge included — emits U+202F, the
 *     narrow no-break space CLDR 42 introduced. One invisible character, still a text node: #418.
 *   - The hour itself on an older iPhone, whose timezone data predates Egypt's 2023 return to
 *     daylight saving — an hour early for half the year.
 *
 * So no Intl call is made at all: `cairoWallClock` moves the instant with the shipped offset table
 * and the parts are read off with getUTC*. The output is byte-for-byte what Node 24 printed before,
 * so nothing on screen changes for anyone whose phone already agreed.
 */
export function cairoDateTime12h(iso: string | null | undefined): string {
  const parts = cairo12hParts(iso);
  return parts ? `${parts.monthDay}, ${parts.year}, ${parts.time}` : "-";
}

/**
 * "Oct 28, 11:16 AM" — the same 12-hour Cairo form without the year, for a list that only ever shows
 * recent changes. Access Control drew it with `Intl.DateTimeFormat("en-US", { hour: "2-digit", … })`
 * on every account row, whose default is the 12-hour clock: the same AM/PM space, so the same #418
 * on any Apple device (31 Oct 2026). Byte-for-byte what Node 24 printed before.
 */
export function cairoMonthDayTime12h(iso: string | null | undefined): string {
  const parts = cairo12hParts(iso);
  return parts ? `${parts.monthDay}, ${parts.time}` : "-";
}

function cairo12hParts(iso: string | null | undefined): { monthDay: string; time: string; year: number } | null {
  const value = parseIsoInstant(iso);
  if (!value) return null;
  const wall = cairoWallClock(value);
  const hour24 = wall.getUTCHours();
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const pad = (n: number) => String(n).padStart(2, "0");
  // en-US says "Sep" where CAIRO_MONTHS says "Sept"; every other name is already three letters, and
  // one month table is the rule (tests/react-418-hydration-safe-text.test.ts).
  return {
    monthDay: `${CAIRO_MONTHS[wall.getUTCMonth()].slice(0, 3)} ${pad(wall.getUTCDate())}`,
    time: `${pad(hour12)}:${pad(wall.getUTCMinutes())} ${hour24 < 12 ? "AM" : "PM"}`,
    year: wall.getUTCFullYear(),
  };
}
