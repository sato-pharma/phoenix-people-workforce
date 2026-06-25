// Period-over-period comparison helpers for analytics dashboards. Pure
// functions only — no Supabase calls — so pages can fetch a prior period
// alongside the current one and feed the delta straight into
// AnalyticsKpiCard's existing `growth` prop.

export type PeriodDelta = {
  current: number;
  prior: number | null;
  pct: number | null;
};

export function computePeriodDelta(current: number, prior: number | null): PeriodDelta {
  if (prior == null || prior === 0) {
    return { current, prior, pct: null };
  }
  return { current, prior, pct: ((current - prior) / prior) * 100 };
}

/** "2026-06" shifted back 1 month -> "2026-05"; handles year rollover. */
export function shiftPeriod(period: string, monthsBack: number): string {
  const [yearStr, monthStr] = period.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  if (!Number.isInteger(year) || !Number.isInteger(month)) return period;

  const zeroBasedMonth = month - 1 - monthsBack;
  const shiftedYear = year + Math.floor(zeroBasedMonth / 12);
  const shiftedMonth = ((zeroBasedMonth % 12) + 12) % 12;
  return `${shiftedYear}-${String(shiftedMonth + 1).padStart(2, "0")}`;
}

/** ISO date string (week start) shifted back N weeks. */
export function shiftWeek(weekStartIso: string, weeksBack: number): string {
  const date = new Date(`${weekStartIso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return weekStartIso;
  date.setUTCDate(date.getUTCDate() - weeksBack * 7);
  return date.toISOString().slice(0, 10);
}
