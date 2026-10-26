import { utcDate } from "@/lib/format/cairo-datetime";
import { planPeriodLabel } from "@/lib/weekly-planning/plan-labels";

// How the "decisions I made" history WORDS what it lists: money, units, dates and weeks.
//
// Every function is pure so a test holds it, and none of them reaches the database or the browser.
// The history used to assemble these by hand in each feed, so the same list printed `2026-10-25`
// beside `25344 EGP` beside `Weekly plan · 2026-W43`.
//
// DATES. Every date here is a DATE-ONLY column (a leave's start, an excuse day, a resignation's
// effective date, a plan period). `utcDate` renders those in UTC on purpose — it is what stops the
// calendar day sliding — so none of them is dragged into Cairo. A decision INSTANT (`decidedAt`) is
// not worded here; the lists format it in Africa/Cairo themselves.

const MS_PER_DAY = 86_400_000;

/** `25 Oct 2026` for a date-only value; "" (never an em dash, never the raw string) when it is absent or unreadable. */
export function historyDate(value: string | null | undefined): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const label = utcDate(text);
  return label === "—" ? "" : label;
}

/** `25,344 EGP` — thousands separators, at most two decimals, and the same bytes on every engine. */
export function formatHistoryMoney(amount: number | string | null | undefined): string {
  const n = Number(amount ?? 0);
  const safe = Number.isFinite(n) ? n : 0;
  return `${safe.toLocaleString("en-US", { maximumFractionDigits: 2 })} EGP`;
}

/** `1,200` — whole units with thousands separators. */
export function formatHistoryUnits(qty: number | string | null | undefined): string {
  const n = Number(qty ?? 0);
  return (Number.isFinite(n) ? Math.round(n) : 0).toLocaleString("en-US");
}

/** The Sunday that closes the week starting on `weekStart` (a date-only Monday), or "" when it is unreadable. */
function weekEnd(weekStart: string): string {
  const start = new Date(`${weekStart}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return "";
  return new Date(start.getTime() + 6 * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * `12 Oct 2026 to 18 Oct 2026` for a week that starts on `weekStart`. Falls back to whatever the
 * caller holds (`fallback`, typically the week code) only when the date itself cannot be read.
 */
export function historyWeekLabel(weekStart: string | null | undefined, fallback = ""): string {
  const start = String(weekStart ?? "").trim().slice(0, 10);
  const label = planPeriodLabel(start, weekEnd(start));
  return label || fallback;
}

/**
 * A plan's period for a history title: the two period dates when the row carries them, else the
 * raw key as a last resort (still better than a blank).
 */
export function historyPlanPeriod(
  periodStart: string | null | undefined,
  periodEnd: string | null | undefined,
  periodKey: string | null | undefined,
): string {
  return planPeriodLabel(periodStart, periodEnd) || String(periodKey ?? "").trim();
}
