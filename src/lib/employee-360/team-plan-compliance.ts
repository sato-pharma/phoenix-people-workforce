// Employee 360 — the PURE half of the team "Plans submitted" / "Plans approved" tiles.
//
// 🔴 A MEDICAL REP PLANS IN PHOENIX CRM, NOT IN THE LEGACY PLANS TAB. `employee_plan_headers` refuses
// a Medical Rep outright (WEEKLY_MONTHLY_PLAN_ELIGIBLE_JOB_TITLES), so the tiles read 0 / N for every
// field team while they counted it. A rep's week is `phoenix_crm_plans`: ONE row per territory seat
// and week, edited in place (`version`), never copied — so each week is counted once, by its plan of
// record, however many times it was returned and re-sent (owner, 2026-10-19: "once per week").
//
// A week counts as SUBMITTED once it has been sent (`submitted_at`) and is now submitted, approved
// or returned for rework — a returned week is the same plan being reworked, not a missing one. A
// draft never counts. APPROVED is the manager's approval of the week.

/** One Phoenix CRM rep week, as the loader reads it. */
export type RepWeekPlanRow = {
  seatId: string;
  weekStart: string;
  status: string;
  submittedAt: string | null;
  submittedByHrId: string | null;
};

const SUBMITTED_STATUSES = new Set(["submitted", "approved", "returned"]);

export function countTeamPlanCompliance(input: {
  rows: readonly RepWeekPlanRow[];
  /** The team rep (canonical key) who holds each territory seat now. */
  repKeyBySeat: ReadonlyMap<string, string>;
  /** Canonical key of each team rep, keyed by any HR id spelling the plan rows may carry. */
  repKeyOf: (hrId: string | null | undefined) => string | null;
}): { submitted: number; approved: number } {
  const submitted = new Set<string>();
  const approved = new Set<string>();
  const seenWeeks = new Set<string>();
  for (const row of input.rows) {
    // The plan of record: one per seat and week. A duplicate read of the same week is the same plan.
    const weekKey = `${row.seatId}\u0000${row.weekStart}`;
    if (seenWeeks.has(weekKey)) continue;
    seenWeeks.add(weekKey);
    // Whoever sent it, if they are on this team; otherwise the rep holding the territory now.
    const repKey = input.repKeyOf(row.submittedByHrId) ?? input.repKeyBySeat.get(row.seatId) ?? null;
    if (!repKey) continue;
    if (row.submittedAt && SUBMITTED_STATUSES.has(row.status)) submitted.add(repKey);
    if (row.status === "approved") approved.add(repKey);
  }
  return { submitted: submitted.size, approved: approved.size };
}
