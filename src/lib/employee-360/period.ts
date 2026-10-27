// Employee 360 — period selection + previous-period comparison.
//
// Pure date logic (no DB). The page reads searchParams, resolves the current
// window and an equal-length immediately-preceding window (for period-over-period
// deltas), and passes both to the data layer. All dates are date-only YYYY-MM-DD
// strings, anchored to Africa/Cairo (never the runtime's UTC clock), to match the
// visit/check-in fetchers.

import { addDaysToDateOnly, parseDateOnly } from "@/lib/date-only";
import { currentCairoDateOnlyIso, currentCairoDateParts } from "@/lib/i18n/format";

import type { Employee360Window } from "./service";

export type PeriodKey =
  | "last30"
  | "last90"
  | "last180"
  | "thisMonth"
  | "thisQuarter"
  | "ytd"
  | "custom";

export type ResolvedPeriod = {
  key: PeriodKey;
  current: Employee360Window;
  previous: Employee360Window;
};

export type MetricDelta = { cur: number | null; prev: number | null };
export type Employee360Comparison = {
  previousLabel: string;
  productiveVisits: MetricDelta;
  visitsPerActiveDay: MetricDelta;
  distinctCustomers: MetricDelta;
  campaignShare: MetricDelta;
  checkinCoverage: MetricDelta;
  checkinCount: MetricDelta;
};

export const PERIOD_PRESETS: { key: PeriodKey; label: string }[] = [
  { key: "last30", label: "Last 30 days" },
  { key: "last90", label: "Last 90 days" },
  { key: "last180", label: "Last 180 days" },
  { key: "thisMonth", label: "This month" },
  { key: "thisQuarter", label: "This quarter" },
  { key: "ytd", label: "Year to date" },
];

// addDaysToDateOnly returns null only for an unparsable input; every call site here
// passes a string this module itself produced (Cairo "today" or another date-only
// string derived from it), so a null is a bug in this file, not a runtime input.
function addDaysStrict(value: string, days: number): string {
  const result = addDaysToDateOnly(value, days);
  if (!result) {
    throw new Error(`period.ts: could not add ${days} day(s) to "${value}"`);
  }
  return result;
}

function daysInclusive(from: string, to: string): number {
  const f = parseDateOnly(from);
  const t = parseDateOnly(to);
  if (!f || !t) return 0;
  return Math.round((t.getTime() - f.getTime()) / 86400000) + 1;
}

function isValidIso(s: string | undefined): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && parseDateOnly(s) !== null;
}

function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function pretty(from: string, to: string): string {
  const f = parseDateOnly(from);
  const t = parseDateOnly(to);
  if (!f || !t) return `${from} – ${to}`;
  const fLbl = `${MONTHS[f.getMonth()]} ${f.getDate()}`;
  const tLbl = `${MONTHS[t.getMonth()]} ${t.getDate()}, ${t.getFullYear()}`;
  return `${fLbl} – ${tLbl}`;
}

export function resolvePeriod(
  searchParams: Record<string, string | string[] | undefined>,
  now: Date = new Date(),
): ResolvedPeriod {
  // Anchor "today" and the current calendar year/month to Africa/Cairo, not the
  // server's UTC clock — between 00:00 and ~03:00 Cairo time (EEST, UTC+3) a UTC
  // read is still on yesterday's date, or last month on the 1st.
  const today = currentCairoDateOnlyIso(now);
  const { year, month } = currentCairoDateParts(now); // month is 1-indexed
  const rawKey = firstParam(searchParams.preset) as PeriodKey | undefined;
  const fromParam = firstParam(searchParams.from);
  const toParam = firstParam(searchParams.to);

  let key: PeriodKey;
  let from: string;
  let to: string;

  if (isValidIso(fromParam) && isValidIso(toParam) && fromParam <= toParam) {
    key = "custom";
    from = fromParam;
    to = toParam;
  } else {
    key = rawKey && PERIOD_PRESETS.some((p) => p.key === rawKey) ? rawKey : "ytd";
    to = today;
    switch (key) {
      case "last30":
        from = addDaysStrict(today, -29);
        break;
      case "last90":
        from = addDaysStrict(today, -89);
        break;
      case "last180":
        from = addDaysStrict(today, -179);
        break;
      case "thisMonth":
        from = `${year}-${String(month).padStart(2, "0")}-01`;
        break;
      case "thisQuarter": {
        const q = Math.floor((month - 1) / 3);
        from = `${year}-${String(q * 3 + 1).padStart(2, "0")}-01`;
        break;
      }
      case "ytd":
      default:
        from = `${year}-01-01`;
        break;
    }
  }

  const length = daysInclusive(from, to);
  const prevTo = addDaysStrict(from, -1);
  const prevFrom = addDaysStrict(prevTo, -(length - 1));

  const currentLabelBase =
    key === "ytd" ? `${year} year-to-date` : PERIOD_PRESETS.find((p) => p.key === key)?.label ?? "Custom period";

  return {
    key,
    current: { from, to, label: `${currentLabelBase} · ${pretty(from, to)}` },
    previous: { from: prevFrom, to: prevTo, label: `the previous ${length === 1 ? "day" : `${length} days`} · ${pretty(prevFrom, prevTo)}` },
  };
}
