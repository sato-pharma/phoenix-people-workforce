// One rep's Early Birds record, fortnight by fortnight.
//
// ─── WHY THIS READS FROZEN ROWS AND NEVER RECOMPUTES ─────────────────────────────────────────
//
// `early_birds_candidates` holds one row per rep per fortnight, written once by close.ts and
// guarded against edits in place (early_birds_candidates_guard_frozen). That makes it both the
// HONEST source and the CHEAP one:
//
//   * Honest — it is what the District Manager was actually shown when he confirmed that
//     fortnight's winner. Recomputing an old fortnight from today's directory would quietly
//     restate history every time someone transfers, resigns or has a hire date corrected, and a
//     rep would see his own past rank move under him.
//   * Cheap — `early_birds_candidates_employee_idx` answers a whole history in ONE round trip.
//     Recomputing eight fortnights would mean eight passes of collectEarlyBirdsInputs, i.e. eight
//     CRM visit reads plus eight check-in reads, on a page render.
//
// The live fortnight has no snapshot yet, by design: close.ts writes one only after the period
// ends. So the caller stitches the live ranking on top — see EarlyBirdsRepHistoryPanel, which
// takes today's score separately and marks it "live".
//
// SUPERSEDED SNAPSHOTS ARE EXCLUDED. A correction supersedes the whole snapshot rather than
// editing a score, so reading candidates without checking their snapshot's `superseded_at` would
// show a rep BOTH the wrong old rank and the corrected one, on adjacent rows, with nothing saying
// which is current.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { normalizeHrIdForAccess } from "@/lib/hr-id";
import { logError } from "@/lib/observability/log";
import { earlyBirdsPeriodFromKey, isEarlyBirdsPeriodKey } from "@/lib/early-birds/period";
import type { EarlyBirdsIneligibleReason } from "@/lib/early-birds/types";

/** One closed fortnight of a rep's record, straight off the frozen snapshot. */
export type EarlyBirdsRepHistoryEntry = {
  periodKey: string;
  /** Human label — never the raw key (owner rule: names, not codes). */
  periodLabel: string;
  /** The fortnight's own dates, so a table can show "Sep 1-15" without re-deriving 1-15 / 16-end. */
  startIso: string;
  endIso: string;
  /** Position among EVERY rep in the district that fortnight, eligible or not. 1-based. */
  rank: number;
  /** Position among the ELIGIBLE reps only — what the manager was offered. Null when ineligible. */
  candidateRank: number | null;
  /** Reps in the district that fortnight, so "3rd of 11" is sayable rather than a bare "3rd". */
  repCount: number;
  eligible: boolean;
  ineligibleReasons: EarlyBirdsIneligibleReason[];
  totalScore: number;
  /** Minutes past Cairo midnight. THE number this whole panel exists to answer. */
  medianStartMinutes: number | null;
  daysWithSubmission: number;
  expectedWorkingDays: number;
  totalVisits: number;
  regularVisits: number;
  /** Of `regularVisits`, the ones with NO matching GPS check-in (rule 10, owner 2026-09-20) — real
   * work, kept off Campaign, but never blended into the credited count. Identified on its own. */
  regularVisitsNoCheckin: number;
  campaignVisits: number;
  gpsShare: number | null;
  dailyWins: number;
  /** He was confirmed the district's Early Bird for this fortnight. */
  won: boolean;
  /** …and also the single company-wide winner. */
  isNational: boolean;
};

export type EarlyBirdsRepHistory = {
  hrId: string;
  hrIdKey: string;
  entries: EarlyBirdsRepHistoryEntry[];
  /** Best (lowest) rank ever reached, over the entries read. Null when he has no closed fortnight. */
  bestRank: number | null;
  /** Confirmed district wins over the entries read. */
  wins: number;
  /** Earliest median start he has ever recorded, in minutes past Cairo midnight. */
  earliestMedianStartMinutes: number | null;
  /** Median of his medians — his habitual start, not his best day. */
  typicalMedianStartMinutes: number | null;
  /**
   * True when the history could not be read at all. Distinct from an empty history: a rep who has
   * simply never been in a closed fortnight is a real, sayable answer, and rendering that copy at
   * someone whose read failed is the misleading-zero mistake this module refuses to make.
   */
  error?: boolean;
};

const EMPTY: Omit<EarlyBirdsRepHistory, "hrId" | "hrIdKey"> = {
  entries: [],
  bestRank: null,
  wins: 0,
  earliestMedianStartMinutes: null,
  typicalMedianStartMinutes: null,
};

type CandidateRow = {
  snapshot_id: string;
  period_key: string;
  rank: number;
  candidate_rank: number | null;
  eligible: boolean;
  ineligible_reasons: string[] | null;
  total_score: number | string | null;
  median_start_minutes: number | null;
  days_with_submission: number | null;
  expected_working_days: number | null;
  total_visits: number | null;
  regular_visits: number | null;
  regular_visits_no_checkin: number | null;
  campaign_visits: number | null;
  gps_share: number | string | null;
  daily_wins: number | null;
};

const num = (value: unknown, fallback = 0): number => {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : fallback;
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Every closed fortnight this rep was scored in, newest first.
 *
 * `limit` counts FORTNIGHTS, not rows. The candidate read asks for more than that on purpose: a
 * superseded snapshot leaves a second row for the same fortnight, and trimming to `limit` before
 * dropping those would silently shorten the history by however many corrections it contains.
 */
export async function getEarlyBirdsRepHistory(input: {
  hrId: string;
  limit?: number;
}): Promise<EarlyBirdsRepHistory> {
  const hrIdKey = normalizeHrIdForAccess(input.hrId) ?? "";
  const base = { ...EMPTY, hrId: input.hrId, hrIdKey };
  if (!hrIdKey) return base;

  const limit = Math.max(1, Math.min(input.limit ?? 12, 24));

  try {
    const supabase = getSupabaseAdmin();

    // Both reads are indexed on employee_hr_id_compact, and both carry an explicit order and
    // limit — an unbounded PostgREST select stops at 1000 rows with no marker at all.
    const [{ data: candidateData, error: candidateError }, { data: winnerData, error: winnerError }] =
      await Promise.all([
        supabase
          .from("early_birds_candidates")
          .select(
            "snapshot_id, period_key, rank, candidate_rank, eligible, ineligible_reasons, " +
              "total_score, median_start_minutes, days_with_submission, expected_working_days, " +
              "total_visits, regular_visits, regular_visits_no_checkin, campaign_visits, gps_share, daily_wins",
          )
          .eq("employee_hr_id_compact", hrIdKey)
          .order("period_key", { ascending: false })
          .limit(limit * 3),
        supabase
          .from("early_birds_winners")
          .select("id, period_key")
          .eq("employee_hr_id_compact", hrIdKey)
          .is("revoked_at", null)
          .order("period_key", { ascending: false })
          .limit(limit * 3),
      ]);
    if (candidateError) throw new Error(candidateError.message);
    if (winnerError) throw new Error(winnerError.message);

    const candidates = (candidateData ?? []) as unknown as CandidateRow[];
    if (candidates.length === 0) return base;

    // Drop the rows whose snapshot has been superseded by a correction. Done as a second read
    // rather than an embedded join so a PostgREST relationship rename cannot silently turn this
    // filter into a no-op — which would show the stale rank beside the corrected one.
    const snapshotIds = [...new Set(candidates.map((row) => row.snapshot_id).filter(Boolean))];
    const { data: snapshotData, error: snapshotError } = await supabase
      .from("early_birds_period_snapshots")
      .select("id, rep_count")
      .in("id", snapshotIds)
      .is("superseded_at", null)
      .limit(snapshotIds.length);
    if (snapshotError) throw new Error(snapshotError.message);

    const repCountBySnapshot = new Map<string, number>();
    for (const row of (snapshotData ?? []) as unknown as Array<{ id: string; rep_count: number | null }>) {
      repCountBySnapshot.set(String(row.id), num(row.rep_count));
    }

    const winnerPeriods = new Set(
      ((winnerData ?? []) as unknown as Array<{ id: string; period_key: string }>).map((row) =>
        String(row.period_key),
      ),
    );
    const nationalPeriods = await listNationalPeriodsFor(
      supabase,
      ((winnerData ?? []) as unknown as Array<{ id: string }>).map((row) => String(row.id)),
    );

    const entries: EarlyBirdsRepHistoryEntry[] = [];
    const seenPeriods = new Set<string>();
    for (const row of candidates) {
      if (!repCountBySnapshot.has(row.snapshot_id)) continue; // superseded
      const periodKey = String(row.period_key ?? "");
      if (!isEarlyBirdsPeriodKey(periodKey) || seenPeriods.has(periodKey)) continue;
      seenPeriods.add(periodKey);

      const period = earlyBirdsPeriodFromKey(periodKey);
      entries.push({
        periodKey,
        periodLabel: period.label,
        startIso: period.startIso,
        endIso: period.endIso,
        rank: num(row.rank, 0),
        candidateRank: row.candidate_rank === null ? null : num(row.candidate_rank),
        repCount: repCountBySnapshot.get(row.snapshot_id) ?? 0,
        eligible: Boolean(row.eligible),
        ineligibleReasons: (row.ineligible_reasons ?? []) as EarlyBirdsIneligibleReason[],
        totalScore: num(row.total_score),
        medianStartMinutes: row.median_start_minutes === null ? null : num(row.median_start_minutes),
        daysWithSubmission: num(row.days_with_submission),
        expectedWorkingDays: num(row.expected_working_days),
        totalVisits: num(row.total_visits),
        regularVisits: num(row.regular_visits),
        regularVisitsNoCheckin: num(row.regular_visits_no_checkin),
        campaignVisits: num(row.campaign_visits),
        gpsShare: row.gps_share === null ? null : num(row.gps_share),
        dailyWins: num(row.daily_wins),
        won: winnerPeriods.has(periodKey),
        isNational: nationalPeriods.has(periodKey),
      });
      if (entries.length >= limit) break;
    }

    const starts = entries
      .map((entry) => entry.medianStartMinutes)
      .filter((value): value is number => value !== null);

    return {
      hrId: input.hrId,
      hrIdKey,
      entries,
      bestRank: entries.length > 0 ? Math.min(...entries.map((entry) => entry.rank)) : null,
      wins: entries.filter((entry) => entry.won).length,
      earliestMedianStartMinutes: starts.length > 0 ? Math.min(...starts) : null,
      typicalMedianStartMinutes: median(starts),
    };
  } catch (error) {
    logError("Early Birds rep history read failed", {
      labels: { event: "early_birds_rep_history_failed", employee: hrIdKey },
      error,
    });
    return { ...base, error: true };
  }
}

/** The fortnights among `winnerIds` that were ALSO crowned company-wide. */
async function listNationalPeriodsFor(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  winnerIds: readonly string[],
): Promise<Set<string>> {
  if (winnerIds.length === 0) return new Set();
  try {
    const { data } = await supabase
      .from("early_birds_national_winners")
      .select("period_key")
      .in("winner_id", [...winnerIds])
      .is("revoked_at", null)
      .limit(winnerIds.length);
    return new Set(
      ((data ?? []) as unknown as Array<{ period_key: string }>).map((row) => String(row.period_key)),
    );
  } catch {
    // A missing national crown is not a failed history. Degrade to "district win, not marked
    // national" rather than failing the whole panel over the decoration.
    return new Set();
  }
}
