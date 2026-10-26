// Closing a fortnight, without a cron job.
//
// GCP Cloud Scheduler is dead and cron-control/job-registry.ts is inert. The real production
// scheduler is a third-party cron-job.org account outside this repo with a 30-second request cap —
// far too short for a company-wide close across every district. So this runs IN-PROCESS, on its own
// timer (close-scheduler.ts). It rode the live CRM poller's tick until 2026-09-13, which tied it to
// the iReports360 credentials it never uses.
//
// The marker is the DATABASE, not an in-memory timestamp: "which periods already have a snapshot?"
// A process down for a week comes back, sees the gap and fills it. That is deliberately unlike the
// poller's own scheduled-work markers, which need re-seeding after a deploy — a fortnightly job
// that forgets across a restart would simply never run.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { cairoHourMinute, cairoTodayIso } from "@/lib/crm/dates";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { normalizeHrIdForAccess, resolveStoredHrId } from "@/lib/hr-id";
import { logError, logInfo } from "@/lib/observability/log";
import { buildEarlyBirdsCandidateKey } from "@/lib/early-birds/candidate-key";
import { collectEarlyBirdsInputs, listEarlyBirdsDistrictManagers } from "@/lib/early-birds/collect";
import { isEarlyBirdsPeriodKey, type EarlyBirdsPeriod } from "@/lib/early-birds/period";
import { resolveCurrentEarlyBirdsCandidate } from "@/lib/early-birds/current-candidate";
import {
  EARLY_BIRDS_CLOSE_MAX_PER_TICK,
  EARLY_BIRDS_DUE_CHECK_MIN_GAP_MS,
  isEarlyBirdsAutoApproveDue,
  isEarlyBirdsNationalCrownDue,
  resolveDueEarlyBirdsPeriods,
} from "@/lib/early-birds/schedule";
import {
  EARLY_BIRDS_SCORING_VERSION,
  EARLY_BIRDS_WEIGHTS,
  buildEarlyBirdsRanking,
} from "@/lib/early-birds/scoring";
import { buildAnnouncement, listPendingEarlyBirdsForManagers } from "@/lib/early-birds/decisions";
import { notifyEarlyBirdsRecommendation } from "@/lib/early-birds/notify";

/** In-memory throttle on how often the DATABASE is asked. Losing it on restart costs one query. */
let lastDueCheckMs = 0;

/**
 * Would runDueEarlyBirdsClose do real work now, or return idle at its throttle? The scheduler asks this
 * before registering the job, so an idle minute is never named as the culprit of an event-loop stall.
 */
export function isEarlyBirdsCloseCheckDue(nowMs = Date.now()): boolean {
  return nowMs - lastDueCheckMs >= EARLY_BIRDS_DUE_CHECK_MIN_GAP_MS;
}

type SnapshotRow = {
  id: string;
  period_key: string;
  manager_hr_id: string;
  status: string;
  computed_at: string;
};

async function listLiveSnapshots(): Promise<SnapshotRow[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("early_birds_period_snapshots")
    .select("id, period_key, manager_hr_id, status, computed_at")
    .is("superseded_at", null)
    .order("period_key", { ascending: false })
    .limit(500);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as SnapshotRow[];
}

/** Close one district's fortnight. Returns false when it was already closed (a genuine no-op). */
async function closeDistrictPeriod(input: {
  period: EarlyBirdsPeriod;
  manager: { hrId: string; hrIdKey: string; name: string };
  todayIso: string;
  storedHrId: (value: string) => string;
}): Promise<boolean> {
  const inputs = await collectEarlyBirdsInputs({
    period: input.period,
    managerHrId: input.manager.hrId,
    todayIso: input.todayIso,
  });
  if (inputs.reps.length === 0) return false;

  const ranking = buildEarlyBirdsRanking({
    period: input.period,
    reps: inputs.reps,
    facts: inputs.facts,
    dailyWinnerHrIdKeys: inputs.dailyWinnerHrIdKeys,
    gpsStartByRepDay: inputs.gpsStartByRepDay,
    phoenixClockRepDays: inputs.phoenixClockRepDays,
    throughIso: input.period.endIso,
  });

  let candidateRank = 0;
  const candidates = ranking.scores.map((score, index) => {
    if (score.eligible) candidateRank += 1;
    return {
      // employees.hr_id is a case-sensitive PK and every hr_id column here is an FK to it. This
      // runs unattended at 03:00, where a lower-cased write dies with 23503 into a log nobody reads.
      employee_hr_id: input.storedHrId(score.hrId),
      employee_hr_id_compact: score.hrIdKey,
      employee_name: score.name,
      candidate_key: buildEarlyBirdsCandidateKey({
        periodKey: input.period.periodKey,
        managerHrId: input.manager.hrId,
        employeeHrId: score.hrId,
      }),
      rank: index + 1,
      candidate_rank: score.eligible ? candidateRank : null,
      eligible: score.eligible,
      ineligible_reasons: score.ineligibleReasons,
      total_score: score.totalScore,
      base_score: score.baseScore,
      quality_weight: score.qualityWeight,
      component_scores: score.components,
      median_start_minutes: score.medianStartMinutes,
      days_with_submission: score.daysWithSubmission,
      expected_working_days: score.expectedWorkingDays,
      total_visits: score.totalVisits,
      regular_visits: score.regularVisits,
      // Rule 10, owner 2026-09-20: identified on their own, never blended into `regular_visits`'
      // credited count and never relabelled Campaign.
      regular_visits_with_checkin: score.regularVisitsWithCheckin,
      regular_visits_no_checkin: score.regularVisitsNoCheckin,
      campaign_visits: score.campaignVisits,
      gps_eligible_visits: score.gpsEligibleVisits,
      gps_verified_visits: score.gpsVerifiedVisits,
      gps_share: score.gpsShare,
      daily_wins: score.dailyWins,
      // `visitStartDays` rides along on a Phoenix CRM fortnight, so the frozen announcement names those
      // starts as first visits, never as GPS (decisions.ts).
      evidence: { timeline: score.timeline, ...(score.visitStartDays ? { visitStartDays: score.visitStartDays } : {}) },
    };
  });

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("phx_close_early_birds_period", {
    p_period_key: input.period.periodKey,
    p_period_start: input.period.startIso,
    p_period_end: input.period.endIso,
    p_manager_hr_id: input.storedHrId(input.manager.hrId),
    p_manager_hr_id_compact: input.manager.hrIdKey,
    p_scoring_version: EARLY_BIRDS_SCORING_VERSION,
    p_weights: EARLY_BIRDS_WEIGHTS,
    p_contested_days: ranking.contestedDays,
    p_trigger: "scheduler",
    p_computed_by: "system",
    // Never replace. A recompute over an existing snapshot is refused by the RPC anyway once a
    // decision exists; passing false makes the ordinary re-run a silent no-op instead.
    p_replace: false,
    p_candidates: candidates,
  });
  if (error) throw new Error(error.message);

  return Boolean((data as { created?: boolean } | null)?.created);
}

/**
 * Crown rank #1 for any fortnight the manager never answered.
 *
 * The rep is never punished for his manager's inaction, and the award always lands while it still
 * feels current. `confirmation_source: "auto"` is recorded and surfaced on the winner panel — a rep
 * must never be told his manager chose him when nobody did.
 */
async function autoApproveStaleSnapshots(todayIso: string, storedHrId: (value: string) => string): Promise<number> {
  const supabase = getSupabaseAdmin();
  const snapshots = (await listLiveSnapshots()).filter((row) => row.status === "open");
  let crowned = 0;

  for (const snapshot of snapshots) {
    if (!isEarlyBirdsPeriodKey(snapshot.period_key)) continue;
    // Measured from when the manager was ASKED, not from when the fortnight ended. A backfilled
    // period is past a period-end deadline the instant it is created, so the old check crowned
    // every district in the same tick that created it — nobody was ever asked.
    if (!isEarlyBirdsAutoApproveDue({ computedAtIso: snapshot.computed_at, todayIso })) continue;

    const [{ data: candidateData }, { data: decisionData }] = await Promise.all([
      supabase
        .from("early_birds_candidates")
        .select("id, candidate_rank, eligible")
        .eq("snapshot_id", snapshot.id),
      supabase.from("early_birds_decisions").select("candidate_id, decision_status").eq("snapshot_id", snapshot.id),
    ]);

    const current = resolveCurrentEarlyBirdsCandidate(
      ((candidateData ?? []) as unknown as Array<{ id: string; candidate_rank: number | null; eligible: boolean }>).map(
        (row) => ({ id: row.id, candidateRank: row.candidate_rank, eligible: row.eligible }),
      ),
      ((decisionData ?? []) as unknown as Array<{ candidate_id: string; decision_status: "approved" | "rejected" }>).map(
        (row) => ({ candidateId: row.candidate_id, decisionStatus: row.decision_status }),
      ),
    );
    if (!current.candidate) continue;

    const { error } = await supabase.rpc("phx_decide_early_birds_candidate", {
      p_snapshot_id: snapshot.id,
      p_candidate_id: current.candidate.id,
      p_decision: "approved",
      p_reason: "Confirmed automatically — no decision was recorded within the window.",
      p_decided_by: storedHrId(snapshot.manager_hr_id),
      p_actor_role: "System",
      p_announcement: await buildAnnouncement(current.candidate.id, "auto"),
    });
    if (error) {
      logError("Early Birds auto-approve failed", {
        labels: { event: "early_birds_auto_approve_failed", snapshot: snapshot.id },
        error,
      });
      continue;
    }
    crowned += 1;
  }

  return crowned;
}

/**
 * Crown the national Early Bird: the highest-scoring APPROVED district star of the fortnight.
 *
 * Waits until every district has settled, or until the auto-approve deadline — whichever comes
 * first. Waiting only on "all settled" would stall forever behind one district with no eligible
 * rep; waiting only on the deadline would delay a fortnight everyone had already decided.
 */
async function crownNationalWinners(todayIso: string): Promise<number> {
  const supabase = getSupabaseAdmin();
  const snapshots = await listLiveSnapshots();

  const byPeriod = new Map<string, SnapshotRow[]>();
  for (const row of snapshots) {
    const bucket = byPeriod.get(row.period_key);
    if (bucket) bucket.push(row);
    else byPeriod.set(row.period_key, [row]);
  }

  let crowned = 0;

  for (const [periodKey, rows] of byPeriod) {
    if (!isEarlyBirdsPeriodKey(periodKey)) continue;
    const openDistrictCount = rows.filter((row) => row.status === "open").length;
    const latestComputedAtIso = rows.map((row) => row.computed_at).sort().at(-1) ?? null;
    // Keyed off the LAST manager asked, so a backfill cannot crown the first district to approve as
    // the national winner while the rest have not been asked yet.
    if (!isEarlyBirdsNationalCrownDue({ todayIso, openDistrictCount, latestComputedAtIso })) continue;

    const { data: existing } = await supabase
      .from("early_birds_national_winners")
      .select("id")
      .eq("period_key", periodKey)
      .is("revoked_at", null)
      .limit(1);
    if (((existing ?? []) as unknown as unknown[]).length > 0) continue;

    const { data: winnerData } = await supabase
      .from("early_birds_winners")
      .select("id, employee_hr_id, total_score")
      .eq("period_key", periodKey)
      .is("revoked_at", null)
      .order("total_score", { ascending: false })
      .limit(1);

    const winner = ((winnerData ?? []) as unknown as Array<{
      id: string;
      employee_hr_id: string;
      total_score: number;
    }>)[0];
    if (!winner) continue;

    const { error } = await supabase.from("early_birds_national_winners").insert({
      period_key: periodKey,
      winner_id: winner.id,
      employee_hr_id: winner.employee_hr_id,
      total_score: winner.total_score,
      district_count: rows.length,
    });
    // A unique-violation here means a concurrent replica won the race; that is the constraint doing
    // its job, not a failure.
    if (error && !/duplicate key/i.test(error.message)) {
      logError("Early Birds national crown failed", {
        labels: { event: "early_birds_national_crown_failed", period: periodKey },
        error,
      });
      continue;
    }
    if (!error) crowned += 1;
  }

  return crowned;
}

/**
 * The whole sweep. Called from the Early Birds close scheduler's timer (close-scheduler.ts); never
 * throws into it.
 *
 * Bounded to EARLY_BIRDS_CLOSE_MAX_PER_TICK closes so a cold start with several missing fortnights
 * spreads across ticks instead of holding one call open for minutes.
 */
export async function runDueEarlyBirdsClose(nowMs = Date.now()): Promise<{
  ran: boolean;
  closed: string[];
  autoApproved: number;
  nationalCrowned: number;
}> {
  const idle = { ran: false, closed: [] as string[], autoApproved: 0, nationalCrowned: 0 };
  if (nowMs - lastDueCheckMs < EARLY_BIRDS_DUE_CHECK_MIN_GAP_MS) return idle;
  lastDueCheckMs = nowMs;

  try {
    const todayIso = cairoTodayIso();
    const { hour, minute } = cairoHourMinute();

    const [snapshots, managers, directory] = await Promise.all([
      listLiveSnapshots(),
      listEarlyBirdsDistrictManagers(),
      getEmployeeDirectoryRows().catch(() => []),
    ]);

    const byHrId = new Map(directory.map((row) => [normalizeHrIdForAccess(row.hrId) ?? "", { hrId: row.hrId }]));
    const storedHrId = (value: string) => resolveStoredHrId(value, byHrId) ?? value;

    // A period counts as done only when EVERY district has a snapshot for it — otherwise a partial
    // close would mark the period settled and strand the remaining districts forever.
    const countByPeriod = new Map<string, number>();
    for (const row of snapshots) countByPeriod.set(row.period_key, (countByPeriod.get(row.period_key) ?? 0) + 1);
    const complete = new Set(
      Array.from(countByPeriod.entries())
        .filter(([, count]) => count >= managers.length && managers.length > 0)
        .map(([periodKey]) => periodKey),
    );

    const due = resolveDueEarlyBirdsPeriods({
      todayIso,
      minutesSinceMidnight: hour * 60 + minute,
      snapshottedPeriodKeys: complete,
    });

    const closed: string[] = [];
    let budget = EARLY_BIRDS_CLOSE_MAX_PER_TICK;

    for (const period of due) {
      for (const manager of managers) {
        if (budget <= 0) break;
        const already = snapshots.some(
          (row) =>
            row.period_key === period.periodKey &&
            normalizeHrIdForAccess(row.manager_hr_id) === manager.hrIdKey,
        );
        if (already) continue;

        budget -= 1;
        try {
          const created = await closeDistrictPeriod({ period, manager, todayIso, storedHrId });
          if (created) closed.push(`${period.periodKey}:${manager.hrId}`);
        } catch (error) {
          logError("Early Birds period close failed", {
            labels: {
              event: "early_birds_close_failed",
              period: period.periodKey,
              manager: manager.hrId,
            },
            error,
          });
        }
      }
      if (budget <= 0) break;
    }

    const autoApproved = await autoApproveStaleSnapshots(todayIso, storedHrId).catch(() => 0);
    const nationalCrowned = await crownNationalWinners(todayIso).catch(() => 0);

    if (closed.length > 0) {
      // Notify only what was newly closed, after the writes have landed. Addressed by district, not
      // by a fabricated session — the scheduler has no viewer.
      const pending = await listPendingEarlyBirdsForManagers(managers.map((manager) => manager.hrId)).catch(
        () => [],
      );
      for (const candidate of pending) {
        if (closed.includes(`${candidate.periodKey}:${candidate.managerHrId}`)) {
          await notifyEarlyBirdsRecommendation(candidate);
        }
      }
    }

    if (closed.length > 0 || autoApproved > 0 || nationalCrowned > 0) {
      logInfo("Early Birds sweep completed", {
        labels: {
          event: "early_birds_sweep",
          closed: closed.length,
          autoApproved,
          nationalCrowned,
        },
      });
    }

    return { ran: true, closed, autoApproved, nationalCrowned };
  } catch (error) {
    logError("Early Birds sweep failed", { labels: { event: "early_birds_sweep_failed" }, error });
    return idle;
  }
}
