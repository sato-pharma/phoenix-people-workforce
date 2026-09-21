/**
 * The Weekly tab's two switches — which roll-up it shows, and which measure the rep table reads.
 *
 * DELIBERATELY DEPENDENCY-FREE, for the reason crm/kpis-tabs.ts gives: the period picker is a
 * `"use client"` component and carries these through its URL, so a runtime import from
 * crm/kpis-trend.ts would drag the Supabase admin client into the browser bundle and 500 the page
 * while `tsc` stays green. Values live here; the server module imports them from here.
 */

/**
 * The three roll-ups, each one level of the owner's ladder (2026-09-22: "week one, week two, week
 * three, week four, months consolidated, a quarter, semester"). Each shows the level below it
 * beside its own total, so the screen is always "the pieces, and what they add up to":
 *
 *   month     the month's weeks, then the month so far
 *   quarter   the quarter's months, then the quarter so far
 *   semester  the semester's months, then the semester so far
 */
export const KPI_TREND_SCALES = ["month", "quarter", "semester"] as const;

export type KpiTrendScale = (typeof KPI_TREND_SCALES)[number];

export const KPI_TREND_SCALE_LABEL: Record<KpiTrendScale, string> = {
  month: "Month by week",
  quarter: "Quarter by month",
  semester: "Semester by month",
};

/**
 * The five measures the rep table can be read on, one at a time.
 *
 * AM and PM are TWO measures, never one — the owner's rule of 2026-09-04 ("this two and this ten.
 * Don't never get average"). Pharmacy is a third call rate, apart from both (owner, 2026-09-05),
 * and carries no percentage because no pharmacy target exists yet.
 */
export const KPI_TREND_METRICS = ["am", "pm", "pharmacy", "coverage", "frequency"] as const;

export type KpiTrendMetric = (typeof KPI_TREND_METRICS)[number];

export const KPI_TREND_METRIC_LABEL: Record<KpiTrendMetric, string> = {
  am: "AM call rate",
  pm: "PM call rate",
  pharmacy: "Pharmacy call rate",
  coverage: "Coverage",
  frequency: "Frequency",
};

/** The URL parameters the two switches ride in. Written only on the Weekly tab. */
export const KPI_TREND_PARAMS = { scale: "trend", metric: "measure" } as const;

/** `?trend=`, falling back to the month — an unknown value widens to the default, never a blank. */
export function resolveKpiTrendScale(raw: string | null | undefined): KpiTrendScale {
  const value = raw?.trim().toLowerCase() ?? "";
  return (KPI_TREND_SCALES as readonly string[]).includes(value) ? (value as KpiTrendScale) : "month";
}

/** `?measure=`, falling back to the AM call rate — the call rate is the first KPI the owner names. */
export function resolveKpiTrendMetric(raw: string | null | undefined): KpiTrendMetric {
  const value = raw?.trim().toLowerCase() ?? "";
  return (KPI_TREND_METRICS as readonly string[]).includes(value) ? (value as KpiTrendMetric) : "am";
}
