// Probation SFE evidence aggregation (Phase 5, P5-T01).
//
// The SFE probation score is primarily DATA-DRIVEN. This module computes the field-KPI evidence
// from the CRM mirrors (ireports360_visits + ireports360_checkins) over the employee's probation
// window. It is kept strictly SEPARATE from the human SFE score: this produces system_evidence;
// the SFE user reviews it and enters their own score/comments/overrides (assessments.ts).
//
// Metrics that are NOT computable today (e.g. plan adherence — the weekly_plans tables are empty)
// are reported as unavailable rather than faked.

import { queryCheckins, queryVisits } from "@/lib/crm/reads";

const CAIRO_TZ = "Africa/Cairo";

export type SfeMetric = {
  key: string;
  label: string;
  value: number | null;
  unit: string;
  available: boolean;
  note?: string;
};

export type SfeEvidence = {
  window: { from: string | null; to: string; days: number };
  totalVisits: number;
  activeVisitDays: number;
  distinctCustomers: number;
  checkinCount: number;
  daysWithCheckin: number;
  metrics: SfeMetric[];
  generatedAt: string;
};

type VisitRow = { visit_date: string; contact_crm_id: number | null };
type CheckinRow = { check_date: string; contact_crm_id: number | null };

function daysBetween(from: string, to: string): number {
  const ms = new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime();
  return Math.max(1, Math.round(ms / 86_400_000) + 1);
}

function cairoHour(iso: string): number | null {
  try {
    const h = new Intl.DateTimeFormat("en-GB", { timeZone: CAIRO_TZ, hour: "2-digit", hour12: false, minute: "2-digit" }).format(new Date(iso));
    const [hh, mm] = h.split(":").map((x) => Number(x));
    if (!Number.isFinite(hh)) return null;
    return hh + (Number.isFinite(mm) ? mm / 60 : 0);
  } catch {
    return null;
  }
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Pure aggregation of SFE field KPIs from the employee's visits + check-ins in the window.
 * `to` defaults to the caller-provided window end (probation end or today).
 */
export function computeSfeEvidence(
  visits: VisitRow[],
  checkins: CheckinRow[],
  window: { from: string | null; to: string },
  generatedAt: string,
): SfeEvidence {
  const totalVisits = visits.length;
  const visitDays = new Set(visits.map((v) => v.visit_date));
  const activeVisitDays = visitDays.size;
  const distinctCustomers = new Set(
    visits.map((v) => v.contact_crm_id).filter((c): c is number => c != null),
  ).size;

  const checkinCount = checkins.length;
  const checkinDays = new Set(checkins.map((c) => c.check_date.slice(0, 10)));
  const daysWithCheckin = checkinDays.size;
  const windowDays = window.from ? daysBetween(window.from, window.to) : activeVisitDays || 1;

  // Earliest Cairo check-in hour per day → averaged (start-time compliance signal).
  const earliestByDay = new Map<string, number>();
  for (const c of checkins) {
    const day = c.check_date.slice(0, 10);
    const hour = cairoHour(c.check_date);
    if (hour == null) continue;
    const prev = earliestByDay.get(day);
    if (prev === undefined || hour < prev) earliestByDay.set(day, hour);
  }
  const startHours = Array.from(earliestByDay.values());
  const avgStartHour = startHours.length > 0 ? round(startHours.reduce((a, b) => a + b, 0) / startHours.length) : null;

  const callsPerActiveDay = activeVisitDays > 0 ? round(totalVisits / activeVisitDays) : null;
  const checkinsPerVisit = totalVisits > 0 ? round(checkinCount / totalVisits) : null;
  const activityConsistencyPct = windowDays > 0 ? round((activeVisitDays / windowDays) * 100, 1) : null;

  const metrics: SfeMetric[] = [
    { key: "call_rate", label: "Calls per active day", value: callsPerActiveDay, unit: "visits/day", available: callsPerActiveDay != null },
    { key: "visit_completion", label: "Total visits completed", value: totalVisits, unit: "visits", available: true },
    { key: "active_days", label: "Active field days", value: activeVisitDays, unit: "days", available: true },
    { key: "customer_coverage", label: "Distinct customers covered", value: distinctCustomers, unit: "customers", available: true },
    { key: "checkin_compliance", label: "GPS check-ins per visit", value: checkinsPerVisit, unit: "ratio", available: checkinsPerVisit != null },
    { key: "start_time", label: "Avg first check-in (Cairo)", value: avgStartHour, unit: "hour", available: avgStartHour != null },
    { key: "activity_consistency", label: "Active-day consistency", value: activityConsistencyPct, unit: "%", available: activityConsistencyPct != null },
    // Not available today — surfaced honestly, not faked.
    { key: "plan_adherence", label: "Weekly-plan adherence", value: null, unit: "%", available: false, note: "weekly_plans data unavailable" },
  ];

  return {
    window: { from: window.from, to: window.to, days: windowDays },
    totalVisits,
    activeVisitDays,
    distinctCustomers,
    checkinCount,
    daysWithCheckin,
    metrics,
    generatedAt,
  };
}

/** Load an employee's visits + check-ins for the window (read-only), then aggregate. */
export async function buildSfeEvidence(
  employeeHrId: string,
  window: { from: string | null; to: string },
  generatedAt: string = new Date().toISOString(),
): Promise<SfeEvidence> {
  const hrId = employeeHrId.trim();

  // Reads through the CRM single-door layer. agentHrIdILike preserves the case-insensitive match on
  // the stored agent_hr_id, and resigned/owner-excluded agents are removed inside the read layer.
  const [visits, checkins] = await Promise.all([
    queryVisits<VisitRow>({
      agentHrIdILike: hrId,
      dateFrom: window.from ?? undefined,
      dateTo: window.to,
      columns: "visit_date, contact_crm_id",
    }),
    queryCheckins<CheckinRow>({
      agentHrIdILike: hrId,
      dateFrom: window.from ?? undefined,
      dateTo: window.to,
      columns: "check_date, contact_crm_id",
    }),
  ]);

  return computeSfeEvidence(visits, checkins, window, generatedAt);
}
