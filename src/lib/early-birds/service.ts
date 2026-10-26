// The Early Birds read API. Everything a page renders comes from here.
//
// Scope rule: the caller's AccessContext decides WHICH districts are in view, and this module
// resolves the roster for each of them. A page never passes a roster in, and a rep never sees a
// district that is not his own.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { cairoTodayIso } from "@/lib/crm/dates";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { normalizeHrIdForAccess } from "@/lib/hr-id";
import { logError } from "@/lib/observability/log";
import { collectEarlyBirdsInputs } from "@/lib/early-birds/collect";
import { countWinsByHrIdKey } from "@/lib/early-birds/win-counts";
import { completeWinnerIdentities } from "@/lib/early-birds/winner-identity";
import { buildEarlyBirdsRanking } from "@/lib/early-birds/scoring";
import {
  currentEarlyBirdsPeriod,
  earlyBirdsPeriodFromKey,
  isEarlyBirdsPeriodKey,
  listRecentEarlyBirdsPeriods,
  type EarlyBirdsPeriod,
} from "@/lib/early-birds/period";
import type { EarlyBirdsRanking, EarlyBirdsRepProfile } from "@/lib/early-birds/types";

export type EarlyBirdsWinnerRecord = {
  id: string;
  periodKey: string;
  periodLabel: string;
  employeeHrId: string;
  employeeName: string;
  areaName: string | null;
  lineName: string | null;
  hireDate: string | null;
  managerHrId: string;
  totalScore: number;
  rankAtApproval: number;
  headlineStats: Record<string, unknown>;
  timeline: unknown[];
  confirmationSource: "manager" | "auto";
  confirmedAt: string | null;
  isNational: boolean;
};

export type EarlyBirdsBoardData = {
  period: EarlyBirdsPeriod;
  /** Last day scored — today for a live period, the end date once closed. */
  throughIso: string;
  daysRemaining: number;
  closed: boolean;
  ranking: EarlyBirdsRanking;
  profiles: Map<string, EarlyBirdsRepProfile>;
  winner: EarlyBirdsWinnerRecord | null;
  hallOfFame: EarlyBirdsWinnerRecord[];
  /** Winner counts across the shown history, for the ×N repeat badge. */
  winCountByHrIdKey: Map<string, number>;
  managerHrId: string;
  managerName: string;
  scopeLabel: string;
  error?: boolean;
};

const EMPTY_RANKING = (period: EarlyBirdsPeriod): EarlyBirdsRanking => ({
  period,
  scores: [],
  candidates: [],
  contestedDays: 0,
});

function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.round((to - from) / 86_400_000);
}

function mapWinnerRow(row: Record<string, unknown>, isNational: boolean): EarlyBirdsWinnerRecord {
  const periodKey = String(row.period_key ?? "");
  return {
    id: String(row.id ?? ""),
    periodKey,
    periodLabel: isEarlyBirdsPeriodKey(periodKey) ? earlyBirdsPeriodFromKey(periodKey).label : periodKey,
    employeeHrId: String(row.employee_hr_id ?? ""),
    employeeName: String(row.employee_name ?? ""),
    areaName: (row.area_name as string | null) ?? null,
    lineName: (row.line_name as string | null) ?? null,
    hireDate: (row.hire_date as string | null) ?? null,
    managerHrId: String(row.manager_hr_id ?? ""),
    totalScore: Number(row.total_score ?? 0),
    rankAtApproval: Number(row.rank_at_approval ?? 0),
    headlineStats: (row.headline_stats as Record<string, unknown>) ?? {},
    timeline: Array.isArray(row.timeline) ? (row.timeline as unknown[]) : [],
    confirmationSource: row.confirmation_source === "auto" ? "auto" : "manager",
    confirmedAt: (row.confirmed_at as string | null) ?? null,
    isNational,
  };
}

/**
 * Confirmed winners, newest first. `managerHrIds` narrows to a district set; omit it for the
 * company-wide wall the CEO / SFE / Marketing see.
 */
export async function listEarlyBirdsWinners(input: {
  managerHrIds?: readonly string[];
  periodKeys?: readonly string[];
  limit?: number;
}): Promise<EarlyBirdsWinnerRecord[]> {
  try {
    const supabase = getSupabaseAdmin();
    let query = supabase
      .from("early_birds_winners")
      .select(
        "id, period_key, employee_hr_id, employee_name, area_name, line_name, hire_date, " +
          "manager_hr_id, total_score, rank_at_approval, headline_stats, timeline, " +
          "confirmation_source, confirmed_at",
      )
      .is("revoked_at", null)
      .order("period_key", { ascending: false })
      .limit(input.limit ?? 24);

    if (input.managerHrIds) {
      if (input.managerHrIds.length === 0) return [];
      query = query.in("manager_hr_id", [...input.managerHrIds]);
    }
    if (input.periodKeys && input.periodKeys.length > 0) {
      query = query.in("period_key", [...input.periodKeys]);
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    // Double cast: PostgREST's builder types a failed select as GenericStringError[], which does
    // not structurally overlap a row shape, so a direct assertion is rejected.
    const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
    const nationalIds = await listNationalWinnerIds(rows.map((row) => String(row.period_key ?? "")));

    // Name and area are completed from the employee's live record (winner-identity.ts): the frozen
    // row left 90 of 125 areas empty and carried the same rep under two spellings.
    return await completeWinnerIdentities(rows.map((row) => mapWinnerRow(row, nationalIds.has(String(row.id ?? "")))));
  } catch (error) {
    logError("Early Birds winners read failed", {
      labels: { event: "early_birds_winners_read_failed" },
      error,
    });
    return [];
  }
}

async function listNationalWinnerIds(periodKeys: readonly string[]): Promise<Set<string>> {
  const keys = Array.from(new Set(periodKeys.filter(Boolean)));
  if (keys.length === 0) return new Set();
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("early_birds_national_winners")
      .select("winner_id")
      .is("revoked_at", null)
      .in("period_key", keys);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Array<{ winner_id?: unknown }>;
    return new Set(rows.map((row) => String(row.winner_id ?? "")));
  } catch {
    // A missing national crown must never blank the district wall.
    return new Set();
  }
}

/**
 * The board for ONE district and one fortnight.
 *
 * While the period is open this is a live preview computed from the mirror and persisted nowhere,
 * which is why a preview and a committed snapshot can never disagree — there is only one code path.
 */
export async function getEarlyBirdsBoard(input: {
  managerHrId: string;
  managerName?: string;
  periodKey?: string;
  todayIso?: string;
  scopeLabel?: string;
}): Promise<EarlyBirdsBoardData> {
  const todayIso = input.todayIso ?? cairoTodayIso();
  const period =
    input.periodKey && isEarlyBirdsPeriodKey(input.periodKey)
      ? earlyBirdsPeriodFromKey(input.periodKey)
      : currentEarlyBirdsPeriod(todayIso);

  const base: EarlyBirdsBoardData = {
    period,
    throughIso: todayIso < period.endIso ? todayIso : period.endIso,
    daysRemaining: Math.max(0, daysBetween(todayIso, period.endIso)),
    closed: todayIso > period.endIso,
    ranking: EMPTY_RANKING(period),
    profiles: new Map(),
    winner: null,
    hallOfFame: [],
    winCountByHrIdKey: new Map(),
    managerHrId: input.managerHrId,
    managerName: input.managerName ?? input.managerHrId,
    scopeLabel: input.scopeLabel ?? "your team",
  };

  try {
    const inputs = await collectEarlyBirdsInputs({ period, managerHrId: input.managerHrId, todayIso });

    const ranking = buildEarlyBirdsRanking({
      period,
      reps: inputs.reps,
      facts: inputs.facts,
      dailyWinnerHrIdKeys: inputs.dailyWinnerHrIdKeys,
      gpsStartByRepDay: inputs.gpsStartByRepDay,
      phoenixClockRepDays: inputs.phoenixClockRepDays,
      throughIso: inputs.throughIso,
    });

    const recentKeys = listRecentEarlyBirdsPeriods(todayIso, 8).map((entry) => entry.periodKey);
    const winners = await listEarlyBirdsWinners({
      managerHrIds: [input.managerHrId],
      periodKeys: recentKeys,
      limit: 12,
    });

    const winCountByHrIdKey = countWinsByHrIdKey(winners);

    return {
      ...base,
      throughIso: inputs.throughIso,
      ranking,
      profiles: inputs.profiles,
      winner: winners.find((record) => record.periodKey === period.periodKey) ?? null,
      hallOfFame: winners.filter((record) => record.periodKey !== period.periodKey),
      winCountByHrIdKey,
    };
  } catch (error) {
    logError("Early Birds board build failed", {
      labels: { event: "early_birds_board_failed", manager: input.managerHrId, period: period.periodKey },
      error,
    });
    return { ...base, error: true };
  }
}

/**
 * One star per line, highest score first. A single company-wide "best of the best" can go whole
 * fortnights without ever being someone's own line — this keeps every line represented instead of
 * gating one shared slot. Pure so the pick is regression-tested without a database, same reason as
 * {@link resolveEarlyBirdsScopeFrom}: ties keep the first-seen row, and a line simply does not
 * appear if it has no confirmed winner in `winners` — never a placeholder.
 */
export function pickTopEarlyBirdPerLine(winners: readonly EarlyBirdsWinnerRecord[]): EarlyBirdsWinnerRecord[] {
  const byLine = new Map<string, EarlyBirdsWinnerRecord>();
  for (const winner of [...winners].sort((a, b) => b.totalScore - a.totalScore)) {
    if (!winner.lineName || byLine.has(winner.lineName)) continue;
    byLine.set(winner.lineName, winner);
  }
  return Array.from(byLine.values()).sort((a, b) => b.totalScore - a.totalScore);
}

/**
 * This fortnight's stars, one per line (Pedia / Anti Infective / CNS), for the landing cards.
 * Scoped to the most recently crowned period — the same "every district has settled" signal
 * `early_birds_national_winners` already provides — then picks each line's own top scorer among
 * that period's confirmed district winners. `isNational` marks whichever of them is ALSO the
 * single overall company-wide winner for that period.
 */
export async function getLatestLineEarlyBirds(): Promise<EarlyBirdsWinnerRecord[]> {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("early_birds_national_winners")
      .select("winner_id, period_key")
      .is("revoked_at", null)
      .order("period_key", { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);

    const periodKey = String((data ?? [])[0]?.period_key ?? "");
    if (!periodKey) return [];
    const nationalWinnerId = String((data ?? [])[0]?.winner_id ?? "");

    const { data: winnerRows, error: winnerError } = await supabase
      .from("early_birds_winners")
      .select(
        "id, period_key, employee_hr_id, employee_name, area_name, line_name, hire_date, " +
          "manager_hr_id, total_score, rank_at_approval, headline_stats, timeline, " +
          "confirmation_source, confirmed_at",
      )
      .eq("period_key", periodKey)
      .is("revoked_at", null);
    if (winnerError) throw new Error(winnerError.message);

    const rows = (winnerRows ?? []) as unknown as Array<Record<string, unknown>>;
    if (rows.length === 0) return [];

    const candidates = rows.map((row) => mapWinnerRow(row, String(row.id ?? "") === nationalWinnerId));
    return await completeWinnerIdentities(pickTopEarlyBirdPerLine(candidates));
  } catch (error) {
    logError("Early Birds line stars read failed", {
      labels: { event: "early_birds_line_stars_read_failed" },
      error,
    });
    return [];
  }
}

/** Resolve a display name for a manager without a second directory round trip at the call site. */
export async function resolveEarlyBirdsManagerName(managerHrId: string): Promise<string> {
  const key = normalizeHrIdForAccess(managerHrId);
  if (!key) return managerHrId;
  const rows = await getEmployeeDirectoryRows().catch(() => []);
  return rows.find((row) => normalizeHrIdForAccess(row.hrId) === key)?.displayName ?? managerHrId;
}
