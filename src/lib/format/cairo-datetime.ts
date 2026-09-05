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
 * ENGINE and this string gets hydrated.
 *
 * `toLocaleDateString("en-GB", { month: "short" })` used to build these. CLDR 42 (ICU 72, late 2022)
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

/** e.g. `30 Aug 2026 · 14:05`. An absent or unparseable value renders as an em dash, never as now. */
export function cairoDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return "—";
  const { day, hour, minute, month, year } = cairoParts(value);
  return `${day} ${CAIRO_MONTHS[Number(month) - 1]} ${year} · ${hour}:${minute}`;
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
  if (!iso) return "";
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return "";
  const { day, hour, minute, month, year } = cairoParts(value);
  return `${year}-${month}-${day} ${hour}:${minute}`;
}
