/**
 * AN ACCEPTED DEDUCTION DISPUTE FIXES THE EMPLOYEE'S CALENDAR TOO (owner, 2026-11-13: "if approved the
 * dispute fix his deduction and calendar").
 *
 * Accepting a deduction dispute already cancels the deduction (Do Not Take Action, `deduction.ts`). Until
 * this file the calendar did not move: the day behind it still read "No Activity Recorded" (or Late, or
 * Short day) on the employee's Private Calendar, so his own page argued with the decision. Every day of a
 * deduction whose dispute is CURRENTLY accepted now becomes the same lime "✓ Verified" correction entry an
 * accepted whole-day review request makes (`buildAcceptedCorrectionItems`), and that clears the day's
 * findings through `withoutCorrectedDayFindings`.
 *
 * "Currently accepted" is read from three things, and all three must agree:
 *   1. the dispute's newest `decided` event is newer than its newest `reopened` event (it is decided now);
 *   2. that event's outcome is `accept` — a REDUCE charges some of the days and names none of them, so it
 *      verifies no particular day, and a REJECT verifies nothing;
 *   3. the module's own decision still reads "Do Not Take Action" — if HR later put the deduction back,
 *      the calendar must not show the day as verified while payroll charges it.
 *
 * Display only, and read best-effort: the calendar reads review requests the same way (a failed read
 * shows none), and nothing here can bring a person into a charge.
 */

import { canonicalHrIdKey } from "@/lib/hr-id";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { PrivateCalendarAcceptedCorrection } from "@/lib/private-calendar/logic";

export type AcceptedDeductionEventRow = {
  case_ref: string;
  created_at: string;
  details: Record<string, unknown> | null;
  event_type: string;
};

export type AcceptedDeductionCandidateRow = {
  category: string | null;
  dates: unknown;
  employee_hr_id: string | null;
  employee_name: string | null;
  id: string;
  superseded_at?: string | null;
};

export type AcceptedDeductionDecisionRow = {
  candidate_id: string;
  decision_status: string | null;
  hr_note?: string | null;
};

const time = (value: string) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Pure: the case refs whose dispute stands ACCEPTED right now (newest decision is an accept, no reopen since). */
export function currentlyAcceptedDeductionRefs(events: readonly AcceptedDeductionEventRow[]): Set<string> {
  const decided = new Map<string, AcceptedDeductionEventRow>();
  const reopened = new Map<string, AcceptedDeductionEventRow>();
  for (const event of events) {
    const target = event.event_type === "decided" ? decided : event.event_type === "reopened" ? reopened : null;
    if (!target) continue;
    const existing = target.get(event.case_ref);
    if (!existing || time(event.created_at) >= time(existing.created_at)) target.set(event.case_ref, event);
  }
  const accepted = new Set<string>();
  for (const [ref, event] of decided) {
    const reopen = reopened.get(ref);
    if (reopen && time(reopen.created_at) > time(event.created_at)) continue;
    if (String((event.details ?? {}).outcome ?? "") !== "accept") continue;
    accepted.add(ref);
  }
  return accepted;
}

/**
 * Pure: one calendar correction per day of every deduction whose dispute is accepted now, inside the
 * window and for the people in scope. `categoryLabel` turns the category into the words on the tile.
 */
export function selectAcceptedDeductionCorrections(input: {
  acceptedRefs: ReadonlySet<string>;
  candidates: readonly AcceptedDeductionCandidateRow[];
  categoryLabel: (category: string) => string;
  decisions: ReadonlyMap<string, AcceptedDeductionDecisionRow>;
  scopeHrIds: readonly string[];
  window: { end: string; start: string };
}): PrivateCalendarAcceptedCorrection[] {
  const scope = new Set(input.scopeHrIds.map((hrId) => canonicalHrIdKey(hrId)).filter(Boolean));
  const out: PrivateCalendarAcceptedCorrection[] = [];
  for (const candidate of input.candidates) {
    if (!input.acceptedRefs.has(candidate.id)) continue;
    if (candidate.superseded_at) continue;
    const decision = input.decisions.get(candidate.id);
    if (String(decision?.decision_status ?? "").trim() !== "Do Not Take Action") continue;
    const hrKey = canonicalHrIdKey(candidate.employee_hr_id);
    if (!hrKey || !scope.has(hrKey)) continue;
    const dates = Array.isArray(candidate.dates) ? (candidate.dates as unknown[]).map((value) => String(value).slice(0, 10)) : [];
    const label = input.categoryLabel(String(candidate.category ?? ""));
    const note = String(decision?.hr_note ?? "").trim() || null;
    for (const date of new Set(dates)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < input.window.start || date > input.window.end) continue;
      out.push({
        adminDecisionNote: note,
        claimSourceText: "the employee's deduction dispute",
        claimText: `${label} deduction dispute accepted`,
        disputeDate: date,
        employeeHrId: String(candidate.employee_hr_id),
        employeeName: candidate.employee_name,
        id: `deduction-dispute:${candidate.id}`,
        itemSource: null,
        origin: "deduction_dispute",
        status: "accepted",
      });
    }
  }
  return out;
}

/** Every accepted deduction dispute's days for the people in scope. Best-effort: a failed read shows none. */
export async function loadAcceptedDeductionCorrections(input: {
  categoryLabel: (category: string) => string;
  end: string;
  scopeHrIds: readonly string[];
  start: string;
}): Promise<PrivateCalendarAcceptedCorrection[]> {
  if (input.scopeHrIds.length === 0) return [];
  try {
    const supabase = getSupabaseAdmin();
    const events = await fetchAllRows<AcceptedDeductionEventRow & { id: string }>(
      () =>
        supabase
          .from("dispute_case_events")
          .select("id, case_ref, event_type, details, created_at")
          .eq("case_kind", "deduction")
          .in("event_type", ["decided", "reopened"]),
      "id",
    );
    const acceptedRefs = currentlyAcceptedDeductionRefs(events);
    if (acceptedRefs.size === 0) return [];
    const ids = Array.from(acceptedRefs);
    const candidates: AcceptedDeductionCandidateRow[] = [];
    const decisions = new Map<string, AcceptedDeductionDecisionRow>();
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      const [candidateResult, decisionResult] = await Promise.all([
        supabase
          .from("deductions_candidates")
          .select("id, employee_hr_id, employee_name, category, dates, superseded_at")
          .in("id", batch),
        supabase.from("deductions_decisions").select("candidate_id, decision_status, hr_note").in("candidate_id", batch),
      ]);
      if (candidateResult.error) throw candidateResult.error;
      if (decisionResult.error) throw decisionResult.error;
      candidates.push(...((candidateResult.data ?? []) as AcceptedDeductionCandidateRow[]));
      for (const row of (decisionResult.data ?? []) as AcceptedDeductionDecisionRow[]) decisions.set(row.candidate_id, row);
    }
    return selectAcceptedDeductionCorrections({
      acceptedRefs,
      candidates,
      categoryLabel: input.categoryLabel,
      decisions,
      scopeHrIds: input.scopeHrIds,
      window: { end: input.end, start: input.start },
    });
  } catch {
    return [];
  }
}
