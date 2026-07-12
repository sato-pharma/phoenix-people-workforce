// Employee 360 — period selection + previous-period comparison.
//
// Pure date logic (no DB). The page reads searchParams, resolves the current
// window and an equal-length immediately-preceding window (for period-over-period
// deltas), and passes both to the data layer. All dates are UTC YYYY-MM-DD to
// match the visit/check-in fetchers.

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

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function fromIso(s: string): Date {
  return new Date(`${s}T00:00:00Z`);
}
function addDays(s: string, delta: number): string {
  const d = fromIso(s);
  d.setUTCDate(d.getUTCDate() + delta);
  return iso(d);
}
function daysInclusive(from: string, to: string): number {
  return Math.round((fromIso(to).getTime() - fromIso(from).getTime()) / 86400000) + 1;
}
function isValidIso(s: string | undefined): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(fromIso(s).getTime());
}
function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function pretty(from: string, to: string): string {
  const f = fromIso(from);
  const t = fromIso(to);
  const fLbl = `${MONTHS[f.getUTCMonth()]} ${f.getUTCDate()}`;
  const tLbl = `${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}, ${t.getUTCFullYear()}`;
  return `${fLbl} – ${tLbl}`;
}

export function resolvePeriod(
  searchParams: Record<string, string | string[] | undefined>,
  now: Date = new Date(),
): ResolvedPeriod {
  const today = iso(now);
  const year = now.getUTCFullYear();
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
        from = addDays(today, -29);
        break;
      case "last90":
        from = addDays(today, -89);
        break;
      case "last180":
        from = addDays(today, -179);
        break;
      case "thisMonth":
        from = `${year}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
        break;
      case "thisQuarter": {
        const q = Math.floor(now.getUTCMonth() / 3);
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
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(length - 1));

  const currentLabelBase =
    key === "ytd" ? `${year} year-to-date` : PERIOD_PRESETS.find((p) => p.key === key)?.label ?? "Custom period";

  return {
    key,
    current: { from, to, label: `${currentLabelBase} · ${pretty(from, to)}` },
    previous: { from: prevFrom, to: prevTo, label: `Previous ${length}d · ${pretty(prevFrom, prevTo)}` },
  };
}
