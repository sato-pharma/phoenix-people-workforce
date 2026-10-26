// The District Manager's approve / reject, and the pending recommendation he acts on.
//
// All the ordering safety lives in the RPC (phx_decide_early_birds_candidate): it re-derives the
// current candidate under a row lock and returns `stale_candidate` if the client is out of date, so
// two open tabs cannot reject the wrong rep. This module is the authorization and announcement
// layer around it.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { AccessContext } from "@/lib/auth/permissions";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey, normalizeHrIdForAccess, resolveStoredHrId } from "@/lib/hr-id";
import { logError } from "@/lib/observability/log";
import { earlyBirdsPeriodFromKey, isEarlyBirdsPeriodKey } from "@/lib/early-birds/period";
import { resolveCurrentEarlyBirdsCandidate } from "@/lib/early-birds/current-candidate";
import { resolveEarlyBirdsScope } from "@/lib/early-birds/permissions";
import { loadWinnerIdentities } from "@/lib/early-birds/winner-identity";
import { formatStartClock } from "@/components/early-birds/early-birds-format";

export type EarlyBirdsPendingCandidate = {
  snapshotId: string;
  candidateId: string;
  candidateRank: number;
  periodKey: string;
  periodLabel: string;
  managerHrId: string;
  employeeHrId: string;
  employeeName: string;
  areaName: string | null;
  hireDate: string | null;
  totalScore: number;
  medianStartMinutes: number | null;
  daysWithSubmission: number;
  expectedWorkingDays: number;
  regularVisits: number;
  /** Of `regularVisits`, the ones WITH a matching GPS check-in — the figure that actually earned
   * Regular credit (rule 10, owner 2026-09-20). Show this, never the `regularVisits` total, as
   * "Regular visits" anywhere the number is read as a justification for the score. */
  regularVisitsWithCheckin: number;
  /** Regular visits with NO matching GPS check-in (rule 10, owner 2026-09-20) — real work, kept off
   * Campaign, but never blended into `regularVisitsWithCheckin`'s credited count. Identified on its
   * own. */
  regularVisitsNoCheckin: number;
  gpsVerifiedVisits: number;
  gpsEligibleVisits: number;
  dailyWins: number;
  /** Every rep already rejected this fortnight, so a third recommendation reads as a chain. */
  rejectedSoFar: Array<{ name: string; reason: string }>;
  /** Ranks 2-5, so the manager sees who he is choosing over. */
  runnersUp: Array<{ name: string; rank: number; medianStartMinutes: number | null; totalScore: number }>;
};

type CandidateRow = {
  id: string;
  snapshot_id: string;
  candidate_rank: number | null;
  eligible: boolean;
  employee_hr_id: string;
  employee_name: string | null;
  total_score: number;
  median_start_minutes: number | null;
  days_with_submission: number;
  expected_working_days: number;
  regular_visits: number;
  regular_visits_with_checkin: number;
  regular_visits_no_checkin: number;
  gps_verified_visits: number;
  gps_eligible_visits: number;
  daily_wins: number;
};

/** Human-readable justification, built from the frozen numbers rather than from prose. */
export function earlyBirdsReasonSummary(candidate: EarlyBirdsPendingCandidate): string {
  return [
    `${candidate.daysWithSubmission}/${candidate.expectedWorkingDays} days`,
    `median ${formatStartClock(candidate.medianStartMinutes)}`,
    `${candidate.gpsVerifiedVisits} GPS-verified`,
    // The credited figure — regularVisitsWithCheckin, never the regularVisits total — so this
    // never reads as more Regular credit than the score actually reflects.
    `${candidate.regularVisitsWithCheckin} Regular visits`,
    // Rule 10 (owner, 2026-09-20): a SEPARATE figure, shown whenever it is not zero — never "of
    // those", since these visits earned no Regular credit at all.
    ...(candidate.regularVisitsNoCheckin > 0
      ? [`${candidate.regularVisitsNoCheckin} more Regular, no check-in`]
      : []),
    `${candidate.dailyWins} first place${candidate.dailyWins === 1 ? "" : "s"}`,
  ].join(" · ");
}

/**
 * Recommendations awaiting a decision, scoped to the districts the viewer actually owns. A
 * District Manager sees his own; a Regional/National manager sees the districts under him; the
 * executive audience sees all of them.
 */
export async function listPendingEarlyBirdsRecommendations(
  access: AccessContext,
): Promise<EarlyBirdsPendingCandidate[]> {
  const scope = await resolveEarlyBirdsScope(access);
  // An unreadable directory yields no districts, so this returns nothing either way. That is the
  // right call for an approvals list — inventing rows we cannot prove the viewer owns would be
  // worse — and the cost is only a badge that reads 0 until the directory recovers. The board
  // itself says so out loud; see EarlyBirdsScope.directoryUnavailable.
  if (scope.districts.length === 0) return [];
  return listPendingEarlyBirdsForManagers(scope.districts.map((district) => district.hrId));
}

/**
 * The same read, addressed by district rather than by viewer.
 *
 * The scheduler needs this: it runs with no session at all, and faking an AccessContext to satisfy
 * a signature would make an unauthenticated caller look authenticated in every future reading of
 * this code. Callers with a session must go through {@link listPendingEarlyBirdsRecommendations},
 * which resolves the district list from the reporting chain.
 */
export async function listPendingEarlyBirdsForManagers(
  managerHrIds: readonly string[],
): Promise<EarlyBirdsPendingCandidate[]> {
  try {
    if (managerHrIds.length === 0) return [];

    const supabase = getSupabaseAdmin();
    const { data: snapshots, error } = await supabase
      .from("early_birds_period_snapshots")
      .select("id, period_key, manager_hr_id")
      .eq("status", "open")
      .is("superseded_at", null)
      .in("manager_hr_id", [...managerHrIds])
      .order("period_key", { ascending: false })
      .limit(24);
    if (error) throw new Error(error.message);

    const snapshotRows = (snapshots ?? []) as unknown as Array<{
      id: string;
      period_key: string;
      manager_hr_id: string;
    }>;
    if (snapshotRows.length === 0) return [];

    const snapshotIds = snapshotRows.map((row) => row.id);

    const [{ data: candidateData }, { data: decisionData }, directory] = await Promise.all([
      supabase
        .from("early_birds_candidates")
        .select(
          "id, snapshot_id, candidate_rank, eligible, employee_hr_id, employee_name, total_score, " +
            "median_start_minutes, days_with_submission, expected_working_days, regular_visits, " +
            "regular_visits_with_checkin, regular_visits_no_checkin, gps_verified_visits, gps_eligible_visits, daily_wins",
        )
        .in("snapshot_id", snapshotIds)
        .order("candidate_rank", { ascending: true }),
      supabase
        .from("early_birds_decisions")
        .select("snapshot_id, candidate_id, decision_status, decision_reason")
        .in("snapshot_id", snapshotIds),
      getEmployeeDirectoryRows().catch(() => []),
    ]);

    const candidates = (candidateData ?? []) as unknown as CandidateRow[];
    const decisions = (decisionData ?? []) as unknown as Array<{
      snapshot_id: string;
      candidate_id: string;
      decision_status: "approved" | "rejected";
      decision_reason: string;
    }>;

    const profileByKey = new Map(
      directory.map((row) => [normalizeHrIdForAccess(row.hrId) ?? "", row] as const),
    );

    const pending: EarlyBirdsPendingCandidate[] = [];

    for (const snapshot of snapshotRows) {
      const own = candidates.filter((row) => row.snapshot_id === snapshot.id);
      const ownDecisions = decisions.filter((row) => row.snapshot_id === snapshot.id);

      const current = resolveCurrentEarlyBirdsCandidate(
        own.map((row) => ({ id: row.id, candidateRank: row.candidate_rank, eligible: row.eligible })),
        ownDecisions.map((row) => ({ candidateId: row.candidate_id, decisionStatus: row.decision_status })),
      );
      if (!current.candidate) continue;

      const row = own.find((entry) => entry.id === current.candidate?.id);
      if (!row) continue;

      const profile = profileByKey.get(normalizeHrIdForAccess(row.employee_hr_id) ?? "");
      const rejectedIds = new Set(
        ownDecisions.filter((entry) => entry.decision_status === "rejected").map((entry) => entry.candidate_id),
      );

      pending.push({
        snapshotId: snapshot.id,
        candidateId: row.id,
        candidateRank: row.candidate_rank ?? 1,
        periodKey: snapshot.period_key,
        periodLabel: isEarlyBirdsPeriodKey(snapshot.period_key)
          ? earlyBirdsPeriodFromKey(snapshot.period_key).label
          : snapshot.period_key,
        managerHrId: snapshot.manager_hr_id,
        employeeHrId: row.employee_hr_id,
        employeeName: profile?.displayName ?? row.employee_name ?? row.employee_hr_id,
        areaName: profile?.areaName ?? null,
        hireDate: profile?.hireDate ?? null,
        totalScore: Number(row.total_score),
        medianStartMinutes: row.median_start_minutes,
        daysWithSubmission: row.days_with_submission,
        expectedWorkingDays: row.expected_working_days,
        regularVisits: row.regular_visits,
        regularVisitsWithCheckin: row.regular_visits_with_checkin,
        regularVisitsNoCheckin: row.regular_visits_no_checkin,
        gpsVerifiedVisits: row.gps_verified_visits,
        gpsEligibleVisits: row.gps_eligible_visits,
        dailyWins: row.daily_wins,
        rejectedSoFar: own
          .filter((entry) => rejectedIds.has(entry.id))
          .map((entry) => ({
            name:
              profileByKey.get(normalizeHrIdForAccess(entry.employee_hr_id) ?? "")?.displayName ??
              entry.employee_name ??
              entry.employee_hr_id,
            reason:
              ownDecisions.find((decision) => decision.candidate_id === entry.id)?.decision_reason ?? "",
          })),
        runnersUp: own
          .filter((entry) => entry.eligible && (entry.candidate_rank ?? 0) > (row.candidate_rank ?? 0))
          .slice(0, 4)
          .map((entry) => ({
            name:
              profileByKey.get(normalizeHrIdForAccess(entry.employee_hr_id) ?? "")?.displayName ??
              entry.employee_name ??
              entry.employee_hr_id,
            rank: entry.candidate_rank ?? 0,
            medianStartMinutes: entry.median_start_minutes,
            totalScore: Number(entry.total_score),
          })),
      });
    }

    return pending;
  } catch (error) {
    logError("Early Birds pending recommendations read failed", {
      labels: { event: "early_birds_pending_read_failed" },
      error,
    });
    return [];
  }
}

export type EarlyBirdsDecisionResult =
  | { ok: true; status: string; winnerId: string | null }
  | { ok: false; error: "forbidden" | "stale_candidate" | "no_candidate" | "snapshot_not_open" | "failed"; message: string };

/**
 * Record a District Manager's decision.
 *
 * Authorization is by DISTRICT OWNERSHIP, not by role name: the actor must own the district the
 * snapshot belongs to (or be a company-wide viewer). A Regional Manager can therefore act for a
 * district under him, which is what makes the five-day escalation possible without a second
 * approval surface.
 */
export async function decideEarlyBirdsCandidate(
  access: AccessContext,
  input: { snapshotId: string; candidateId: string; decision: "approve" | "reject"; comment?: string },
): Promise<EarlyBirdsDecisionResult> {
  if (input.decision === "reject" && !String(input.comment ?? "").trim()) {
    return { ok: false, error: "failed", message: "A reason is required to reject a recommendation." };
  }

  try {
    const supabase = getSupabaseAdmin();
    const { data: snapshotData, error: snapshotError } = await supabase
      .from("early_birds_period_snapshots")
      .select("id, manager_hr_id")
      .eq("id", input.snapshotId)
      .limit(1);
    if (snapshotError) throw new Error(snapshotError.message);

    const snapshot = ((snapshotData ?? []) as unknown as Array<{ id: string; manager_hr_id: string }>)[0];
    if (!snapshot) return { ok: false, error: "failed", message: "That recommendation no longer exists." };

    const scope = await resolveEarlyBirdsScope(access);
    if (scope.directoryUnavailable) {
      // Ownership is derived from the directory. With the directory down we cannot prove the viewer
      // owns this district, so we must refuse — but refusing with "that district is not yours"
      // would accuse a legitimate District Manager of reaching outside his scope during an outage.
      return {
        ok: false,
        error: "failed",
        message: "The employee directory could not be read, so your district could not be confirmed. Nothing was recorded — please try again in a minute.",
      };
    }
    const owns =
      scope.isCompanyWide ||
      scope.districts.some(
        (district) => district.hrIdKey === normalizeHrIdForAccess(snapshot.manager_hr_id),
      );
    if (!owns) {
      return { ok: false, error: "forbidden", message: "That district is not yours to decide." };
    }

    const directory = await getEmployeeDirectoryRows().catch(() => []);
    const byHrId = new Map(directory.map((row) => [normalizeHrIdForAccess(row.hrId) ?? "", { hrId: row.hrId }]));
    // employees.hr_id is a case-sensitive primary key and every actor column here is an FK to it —
    // a lower-cased write dies with 23503 inside an unattended job.
    const decidedBy = resolveStoredHrId(access.hrId, byHrId) ?? access.hrId;

    const announcement = await buildAnnouncement(input.candidateId, "manager");

    const { data, error } = await supabase.rpc("phx_decide_early_birds_candidate", {
      p_snapshot_id: input.snapshotId,
      p_candidate_id: input.candidateId,
      p_decision: input.decision === "approve" ? "approved" : "rejected",
      p_reason: String(input.comment ?? "").trim(),
      p_decided_by: decidedBy,
      p_actor_role: access.role,
      p_announcement: announcement,
    });
    if (error) throw new Error(error.message);

    const result = (data ?? {}) as { ok?: boolean; error?: string; status?: string; winner_id?: string | null };
    if (result.error) {
      const known = ["stale_candidate", "no_candidate", "snapshot_not_open"] as const;
      const code = known.find((entry) => entry === result.error) ?? "failed";
      return {
        ok: false,
        error: code,
        message:
          code === "stale_candidate"
            ? "This recommendation has moved on — reload to see the current one."
            : code === "snapshot_not_open"
              ? "This fortnight has already been decided."
              : "There is no recommendation left to decide.",
      };
    }

    return { ok: true, status: String(result.status ?? "open"), winnerId: result.winner_id ?? null };
  } catch (error) {
    logError("Early Birds decision failed", {
      labels: { event: "early_birds_decision_failed", snapshot: input.snapshotId },
      error,
    });
    return { ok: false, error: "failed", message: "The decision could not be recorded." };
  }
}

/**
 * The frozen announcement payload — copied, never joined, so a later transfer cannot relabel it.
 *
 * Used by BOTH crowning paths: the manager's approval and the automatic confirmation in close.ts.
 * The automatic path used to send a bare `{ confirmation_source: "auto" }`, so every winner it crowned
 * was stored with no area, region, line, hire date, stats or timeline — the Hall of Fame's blank
 * area slots. A rep the active-only directory no longer lists (left, or spelled differently) falls
 * back to the employee's own record for name and area.
 */
export async function buildAnnouncement(
  candidateId: string,
  source: "manager" | "auto",
): Promise<Record<string, unknown>> {
  try {
    const supabase = getSupabaseAdmin();
    const { data } = await supabase
      .from("early_birds_candidates")
      .select("employee_hr_id, employee_name, evidence, median_start_minutes, days_with_submission, expected_working_days, gps_verified_visits, daily_wins")
      .eq("id", candidateId)
      .limit(1);

    const row = ((data ?? []) as unknown as Array<Record<string, unknown>>)[0];
    if (!row) return { confirmation_source: source };

    const directory = await getEmployeeDirectoryRows().catch(() => []);
    const profile = directory.find(
      (entry) => normalizeHrIdForAccess(entry.hrId) === normalizeHrIdForAccess(String(row.employee_hr_id ?? "")),
    );

    const live = profile?.areaName
      ? null
      : (await loadWinnerIdentities([String(row.employee_hr_id ?? "")])).get(
          canonicalHrIdKey(String(row.employee_hr_id ?? "")) ?? "",
        ) ?? null;

    const evidence = (row.evidence as { timeline?: unknown[]; visitStartDays?: unknown } | null) ?? null;
    const timeline = Array.isArray(evidence?.timeline) ? evidence.timeline : [];
    // A Phoenix CRM fortnight (close.ts): its starts are first visits, never GPS — the card a whole
    // district reads never tells a rep his location is read (Phoenix CRM golden rule #1).
    const visitStartDays = Number(evidence?.visitStartDays ?? 0);
    const startDayCount = timeline.filter(
      (day) => typeof day === "object" && day !== null && (day as { startMinutes?: unknown }).startMinutes != null,
    ).length;

    return {
      confirmation_source: source,
      employee_name: profile?.displayName ?? row.employee_name ?? row.employee_hr_id,
      area_name: profile?.areaName ?? live?.areaName ?? null,
      region_name: profile?.regionName ?? null,
      line_name: profile?.lineName ?? null,
      hire_date: profile?.hireDate ?? null,
      has_photo: Boolean(profile?.hasPhoto),
      headline_stats: {
        Days: `${row.days_with_submission}/${row.expected_working_days}`,
        Median: formatStartClock(row.median_start_minutes as number | null),
        ...(visitStartDays > 0
          ? { "Start days": String(startDayCount) }
          : { GPS: String(row.gps_verified_visits ?? 0) }),
        "1st places": String(row.daily_wins ?? 0),
      },
      timeline,
    };
  } catch {
    return { confirmation_source: source };
  }
}
