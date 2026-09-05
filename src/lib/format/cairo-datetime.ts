// One Africa/Cairo timestamp format, for screens that show when something happened.
//
// The owner reports and reads every time in Cairo local, never raw UTC. This was a private function
// inside recruitment-candidates-portal.tsx until the candidate comment thread needed the same
// format on 2026-08-30; it is here rather than copied so the two cannot drift into showing the same
// instant two ways on one card.
//
// Client-safe: no database, no server-only import. That matters — it is called from "use client"
// components, and a formatter that reached for anything server-side would drag it into the bundle.

function parseIsoInstant(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const value = new Date(iso);
  return Number.isNaN(value.getTime()) ? null : value;
}

function formatCairoDatePart(value: Date): string {
  return value.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  });
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
  const time = value.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Cairo" });
  return `${formatCairoDatePart(value)} · ${time}`;
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
  // `en-CA` is the locale whose short date is already YYYY-MM-DD. The time is taken from en-GB with
  // hour12 forced off, because en-CA renders midnight as "24:00" in some ICU builds — which is a
  // valid time string and a wrong day.
  const date = value.toLocaleDateString("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Africa/Cairo",
    year: "numeric",
  });
  const time = value.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    timeZone: "Africa/Cairo",
  });
  return `${date} ${time}`;
}
