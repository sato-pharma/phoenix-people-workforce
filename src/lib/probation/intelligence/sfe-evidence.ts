// Probation SFE evidence aggregation (Phase 5, P5-T01).
//
// The SFE probation score is primarily DATA-DRIVEN. This module computes the field-KPI evidence
// from the CRM mirrors (ireports360_visits + ireports360_checkins) over the employee's probation
// window. It is kept strictly SEPARATE from the human SFE score: this produces system_evidence;
// the SFE user reviews it and enters their own score/comments/overrides (assessments.ts).
//
// Metrics that are NOT computable today (e.g. plan adherence — the weekly_plans tables are empty)
// are reported as unavailable rather than faked.

import { getSupabaseAdmin } from "@/lib/supabase/server";

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
  /** Visits whose contact is the CRM "unmapped/unspecified" sentinel (null or 0) — excluded from coverage. */
  unmappedContactVisits: number;
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

// check_date is a zone-less Cairo wall-clock stored verbatim as +00, so its stored clock reading
// is ALREADY Cairo-local — read it as-is (timeZone "UTC"). Converting through Africa/Cairo would
// double-add the Egypt offset and make reps look 2–3h late in the probation start-time metric.
function cairoHour(iso: string): number | null {
  try {
    const h = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", hour: "2-digit", hour12: false, minute: "2-digit" }).format(new Date(iso));
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
  // A visit whose contact_crm_id is 0 is the CRM "unspecified / unmapped contact" sentinel — NOT a
  // real customer (same convention as crm/master.ts: `contact_crm_id !== 0 ? ... : null`). Counting
  // it inflated coverage to "1 distinct customer" for reps whose visits are entirely unmapped; exclude
  // it so coverage reads truthfully (0), and surface how many visits are unmapped so an SFE reviewer
  // sees WHY coverage is low instead of assuming missing data.
  const distinctCustomers = new Set(
    visits.map((v) => v.contact_crm_id).filter((c): c is number => c != null && c !== 0),
  ).size;
  const unmappedContactVisits = visits.filter((v) => v.contact_crm_id == null || v.contact_crm_id === 0).length;

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
    {
      key: "customer_coverage",
      label: "Distinct customers covered",
      value: distinctCustomers,
      unit: "customers",
      available: true,
      note:
        unmappedContactVisits > 0
          ? `${unmappedContactVisits} of ${totalVisits} visit${totalVisits === 1 ? "" : "s"} have an unmapped contact in the CRM (excluded from coverage)`
          : undefined,
    },
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
    unmappedContactVisits,
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
  const supabase = getSupabaseAdmin();
  const hrId = employeeHrId.trim();

  let visitsQuery = supabase
    .from("ireports360_visits")
    .select("visit_date, contact_crm_id")
    .ilike("agent_hr_id", hrId)
    .lte("visit_date", window.to);
  if (window.from) visitsQuery = visitsQuery.gte("visit_date", window.from);
  const { data: visits, error: vErr } = await visitsQuery;
  if (vErr) throw new Error(vErr.message);

  let checkinsQuery = supabase
    .from("ireports360_checkins")
    .select("check_date, contact_crm_id")
    .ilike("agent_hr_id", hrId)
    .lte("check_date", `${window.to}T23:59:59Z`);
  if (window.from) checkinsQuery = checkinsQuery.gte("check_date", `${window.from}T00:00:00Z`);
  const { data: checkins, error: cErr } = await checkinsQuery;
  if (cErr) throw new Error(cErr.message);

  return computeSfeEvidence(
    (visits ?? []) as VisitRow[],
    (checkins ?? []) as CheckinRow[],
    window,
    generatedAt,
  );
}
