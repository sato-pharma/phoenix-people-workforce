/**
 * CEO Command Brief — honest executive brief from EXISTING real aggregates only.
 *
 * Phase 1.1: direction signals are MONTH-OVER-MONTH (latest vs previous trend point)
 * derived from the canonical executive dashboard snapshot — never fabricated. True
 * week-over-week KPI deltas require a snapshot baseline that is NOT captured yet
 * (`weeklySnapshotAvailable: false`), so the UI shows an explicit unavailable state.
 */
import type { AccessContext } from "@/lib/auth/permissions";
import { getExecutiveDashboardSnapshot } from "@/lib/executive/dashboard-snapshot";
import type { OverviewDashboardData } from "@/lib/overview/service";

export type TrendDirection = "up" | "down" | "flat" | "unavailable";
export type SignalVerdict = "improved" | "worse" | "flat" | "unavailable";
export type SignalFormat = "currency" | "percent" | "number";

export type BriefSignal = {
  key: string;
  label: string;
  direction: TrendDirection;
  latest: number | null;
  previous: number | null;
  deltaPct: number | null;
  /** Whether a rising value means "improved" (true) or "worse" (false). */
  positiveIsUp: boolean;
  comparisonLabel: string;
  format: SignalFormat;
};

export type CeoBriefActivityItem = {
  description: string;
  module: string;
  status: string;
  timestamp: string;
  userName: string;
};

export type CeoBriefUpcoming = {
  type: "contract" | "probation";
  name: string;
  date: string;
  days: number;
};

export type CeoBriefAlert = { type: "contract" | "probation"; name: string; date: string; days: number };

export type CeoBriefData = {
  signals: BriefSignal[];
  impact: { revenue: number; peopleCost: number; grossMargin: number };
  activity: CeoBriefActivityItem[];
  upcoming: CeoBriefUpcoming[];
  alerts: CeoBriefAlert[];
  workforce: { activeEmployees: number; totalStructure: number; vacantPositions: number };
  salesAchievementPct: number;
  /** Phase 1.1: weekly snapshot baseline is not captured; true weekly deltas unavailable. */
  weeklySnapshotAvailable: false;
};

/** Pure: direction from a numeric series (latest vs previous finite point). Never fabricates. */
export function computeTrendDirection(series: Array<number | null | undefined>): {
  direction: TrendDirection;
  latest: number | null;
  previous: number | null;
  deltaPct: number | null;
} {
  const points = series.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (points.length < 2) {
    return { direction: "unavailable", latest: points.length ? points[points.length - 1] : null, previous: null, deltaPct: null };
  }
  const latest = points[points.length - 1];
  const previous = points[points.length - 2];
  const deltaPct = previous !== 0 ? ((latest - previous) / Math.abs(previous)) * 100 : null;
  const direction: TrendDirection = latest > previous ? "up" : latest < previous ? "down" : "flat";
  return { direction, latest, previous, deltaPct };
}

/** Pure: map a signal's direction + polarity into an executive verdict. */
export function classifySignal(signal: Pick<BriefSignal, "direction" | "positiveIsUp">): SignalVerdict {
  if (signal.direction === "unavailable") return "unavailable";
  if (signal.direction === "flat") return "flat";
  const isUp = signal.direction === "up";
  return isUp === signal.positiveIsUp ? "improved" : "worse";
}

function buildSignal(
  key: string,
  label: string,
  series: Array<number | null | undefined>,
  positiveIsUp: boolean,
  format: SignalFormat,
): BriefSignal {
  const direction = computeTrendDirection(series);
  return { key, label, positiveIsUp, comparisonLabel: "vs previous month", format, ...direction };
}

/** Pure: derive the month-over-month signals from a real overview snapshot. */
export function buildBriefSignals(o: OverviewDashboardData): BriefSignal[] {
  const salesAchievementSeries = o.sales.trend.map((point) => (point.target > 0 ? (point.sales / point.target) * 100 : null));
  const marginSeries = o.financial.trend.map((point) => (point.revenue > 0 ? ((point.revenue - point.cost) / point.revenue) * 100 : null));
  return [
    buildSignal("sales_achievement", "Sales achievement", salesAchievementSeries, true, "percent"),
    buildSignal("revenue", "Revenue", o.financial.trend.map((point) => point.revenue), true, "currency"),
    buildSignal("gross_margin", "Gross margin", marginSeries, true, "percent"),
    buildSignal("people_cost", "People cost", o.financial.trend.map((point) => point.cost), false, "currency"),
    buildSignal("expenses", "Outstation expenses", o.expenses.trend.map((point) => point.amount), false, "currency"),
  ];
}

export async function getCeoBrief(accessContext: AccessContext): Promise<CeoBriefData> {
  return (await getExecutiveDashboardSnapshot(accessContext)).brief;
}
