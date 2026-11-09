/**
 * THE FREQUENCY REPORT'S TEAMS — the arithmetic behind the premium pass of 9 November 2026 (owner: "eyeball
 * every report in My Team's Reports, premium polish big work, every single component", then "group reps by
 * district manager"), the Frequency page's half of what crm/kpi-coverage-teams.ts is for Coverage.
 *
 * Pure: no database, no React, nothing server-side, so the report's server component, its export and its
 * tests read the same answers. IT ADDS NO MEASURE. Every figure is the board's own arithmetic over a smaller
 * set of rows:
 *
 * - a team's frequency is `sumKpiTeamTotals` + `kpiTeamFigures` (crm/kpis-board.ts) over that team's rows,
 *   the ONE copy of the team arithmetic the Frequency tile already reads, so a team's "met" and its judged
 *   doctors add up across the teams to the tile;
 * - the judged doctors are the same denominator `kpiTeamFigures` divides by: the GRADED doctors under the
 *   Phoenix rules (rule 7), the planned list under the original rules;
 * - a rep's band is `frequencyBandOf` (crm/kpis-filters.ts), the cut every rep row's chip already shows.
 *
 * There is NO frequency floor. Coverage has the owner's 95% (2026-09-05); frequency has never been given one,
 * so nothing here invents a pass mark for a rep — a rep is in the band his own chip shows, and that is all.
 * The grouping itself is `groupKpiRepsByTeam`, the one the Coverage page uses, so a team sits in the same
 * place, under the same heading, on both pages.
 */

import { kpiTeamFigures, sumKpiTeamTotals, type KpiRepRow, type KpisBoard } from "@/lib/crm/kpis-board";
import { frequencyBandOf, kpiBandOf, type KpiBand } from "@/lib/crm/kpis-filters";
import { kpiNotValidatedTotal, type KpiCoverageTeam } from "@/lib/crm/kpi-coverage-teams";

/** The rules a board was scored under, as `kpiTeamFigures` takes them. */
export type KpiFrequencyRules = Parameters<typeof kpiTeamFigures>[1];

/** One team's frequency, from the board's own team arithmetic. */
export type KpiTeamFrequency = {
  /** Every rep in the team, the just-started included — a head is a head. */
  reps: number;
  /** Reps the team's figures are judged on: everyone but the just-started. */
  judgedReps: number;
  justStarted: number;
  /** The denominator of the team's percentage: graded doctors (Phoenix) or planned doctors (original). */
  judged: number;
  /** Doctors at the pass — exact on the plan (original) or at the grade's norm (Phoenix). */
  met: number;
  /** Doctors short of the plan or the norm. Under the Phoenix rules, a graded doctor never seen is here. */
  below: number;
  /** Doctors seen MORE than the plan asked — a deviation under the original rules, never counted (Phoenix). */
  above: number;
  /** Planned doctors with no grade, left out under the Phoenix rules (rule 7). 0 under the original rules. */
  ungraded: number;
  /**
   * The rest of the judged list under the original rules: planned doctors who are neither exact, below nor
   * above — not visited yet, or every planned day still ahead. 0 under the Phoenix rules, where `below`
   * already holds a graded doctor nobody has seen.
   */
  rest: number;
  /** met ÷ judged, as `kpiTeamFigures` rounds it. Null when the team has nobody to judge — "No plan", never 0%. */
  frequencyPct: number | null;
  band: KpiBand;
  /** Judged reps with a plan, and of them the reps whose own frequency chip reads 90% or more. */
  withPlan: number;
  topBand: number;
};

/**
 * A TEAM'S FREQUENCY — `sumKpiTeamTotals` and `kpiTeamFigures` over the team's own rows, which is what the
 * Frequency tile does over every row. A rep who has just started is a head and nothing else, exactly as in
 * the tile (owner, 2026-10-26).
 */
export function kpiTeamFrequency(rows: readonly KpiRepRow[], rules: KpiFrequencyRules): KpiTeamFrequency {
  const totals = sumKpiTeamTotals(rows);
  const figures = kpiTeamFigures(totals, rules);
  const phoenix = rules === "phoenix";
  const judged = phoenix ? totals.gradedDoctors : totals.plannedDoctors;
  const judgedRows = rows.filter((row) => !row.justStarted);
  const withPlan = judgedRows.filter((row) => row.hasMeasurablePlan);
  const frequencyPct = judged > 0 ? figures.frequencyPct : null;
  const above = phoenix ? 0 : totals.overDoctors;
  return {
    reps: rows.length,
    judgedReps: judgedRows.length,
    justStarted: rows.length - judgedRows.length,
    judged,
    met: totals.onPlanDoctors,
    below: totals.underDoctors,
    above,
    ungraded: phoenix ? totals.ungradedDoctors : 0,
    rest: phoenix ? 0 : Math.max(0, judged - totals.onPlanDoctors - totals.underDoctors - above),
    frequencyPct,
    band: kpiBandOf(frequencyPct),
    withPlan: withPlan.length,
    topBand: withPlan.filter((row) => frequencyBandOf(row) === "elite").length,
  };
}

/** One team with its frequency, ready to draw. */
export type KpiTeamWithFrequency = { team: KpiCoverageTeam<KpiRepRow>; frequency: KpiTeamFrequency };

/** Every team's frequency, from the board's own team arithmetic. Unscored boards read "legacy", as the board does. */
export function kpiTeamsWithFrequency(
  teams: ReadonlyArray<KpiCoverageTeam<KpiRepRow>>,
  rules: KpiFrequencyRules | null | undefined,
): KpiTeamWithFrequency[] {
  return teams.map((team) => ({
    team,
    frequency: kpiTeamFrequency(
      team.members.map((member) => member.row),
      rules ?? "legacy",
    ),
  }));
}

// ── Where the reps stand ─────────────────────────────────────────────────────────────────────

/** The order the band bar reads in: the best band first, then the two quiet states. */
export const KPI_FREQUENCY_BAND_ORDER = ["elite", "strong", "steady", "behind"] as const;

const BAND_LABEL: Record<(typeof KPI_FREQUENCY_BAND_ORDER)[number], string> = {
  elite: "90% and above",
  strong: "75 to 89%",
  steady: "50 to 74%",
  behind: "Under 50%",
};

/** One slice of the "the reps by frequency" bar. */
export type KpiFrequencyBandSlice = {
  key: "elite" | "strong" | "steady" | "behind" | "just-started" | "no-plan";
  label: string;
  band: KpiBand;
  count: number;
};

/**
 * THE REPS BY FREQUENCY — every rep in view in exactly one slice: one of the four bands his frequency chip
 * already shows, "Just started" (judged by nothing), or "No plan" (nothing to measure, never a 0%). The
 * slices add up to the Medical reps in reach tile. Empty slices are kept, in order; `count` says which.
 */
export function kpiFrequencyBandMix(rows: readonly KpiRepRow[]): KpiFrequencyBandSlice[] {
  const counts = { elite: 0, strong: 0, steady: 0, behind: 0, "just-started": 0, "no-plan": 0 };
  for (const row of rows) {
    if (row.justStarted) {
      counts["just-started"] += 1;
      continue;
    }
    const band = frequencyBandOf(row);
    if (band === "noplan") counts["no-plan"] += 1;
    else counts[band] += 1;
  }
  return [
    ...KPI_FREQUENCY_BAND_ORDER.map((band) => ({ key: band, label: BAND_LABEL[band], band, count: counts[band] })),
    { key: "just-started" as const, label: "Just started", band: "noplan" as const, count: counts["just-started"] },
    { key: "no-plan" as const, label: "No plan", band: "noplan" as const, count: counts["no-plan"] },
  ];
}

// ── The judged list ──────────────────────────────────────────────────────────────────────────

/** One slice of "the judged doctors" bar, in the rules' own words. */
export type KpiFrequencyDoctorSlice = {
  key: "met" | "below" | "above" | "rest" | "ungraded";
  label: string;
  count: number;
  /** True for the slice that IS the pass, so a caller colours it as such. */
  pass: boolean;
  /** True for a slice that sits outside the percentage (ungraded doctors under the Phoenix rules). */
  outside: boolean;
};

/**
 * THE JUDGED DOCTORS, IN THE RULES' OWN WORDS — the whole team's list as the pass against everything else.
 *
 * - Original rules: Exact (the only pass), Below, Above (also a deviation, owner 2026-09-02) and the rest of
 *   the planned list — not visited yet, or not due yet. The four add up to the planned doctors, the tile's
 *   denominator.
 * - Phoenix rules: At norm, Below norm (a graded doctor never seen included), and the ungraded doctors,
 *   marked as outside the percentage — they are on the list, rule 7 leaves them out of it.
 *
 * The words are the Frequency table's column heads, so the bar and the table never name a thing twice.
 */
export function kpiFrequencyDoctorMix(team: KpiTeamFrequency, rules: KpiFrequencyRules | null | undefined): KpiFrequencyDoctorSlice[] {
  if (rules === "phoenix") {
    return [
      { key: "met", label: "At norm", count: team.met, pass: true, outside: false },
      { key: "below", label: "Below norm", count: team.below, pass: false, outside: false },
      { key: "ungraded", label: "Ungraded · left out", count: team.ungraded, pass: false, outside: true },
    ];
  }
  return [
    { key: "met", label: "Exact · the only pass", count: team.met, pass: true, outside: false },
    { key: "below", label: "Below plan", count: team.below, pass: false, outside: false },
    { key: "above", label: "Above plan · also a deviation", count: team.above, pass: false, outside: false },
    { key: "rest", label: "Not visited yet, or not due yet", count: team.rest, pass: false, outside: false },
  ];
}

/**
 * The doctors that keep the team off the pass, in one number a manager can act on: below (and above, under
 * the original rules, where a doctor seen too often is a deviation as well). Never the ungraded doctors —
 * nobody can be short of a norm the doctor's grade does not set.
 */
export function kpiFrequencyOffTarget(team: Pick<KpiTeamFrequency, "below" | "above">): number {
  return team.below + team.above;
}

/** "3 reps · 1 just started" — the team's head count, with the reps the figure leaves out named. */
export function kpiFrequencyHeadCount(team: Pick<KpiTeamFrequency, "reps" | "justStarted">): string {
  const reps = `${team.reps} ${team.reps === 1 ? "rep" : "reps"}`;
  return team.justStarted > 0 ? `${reps} · ${team.justStarted} just started` : reps;
}

/** The team's figure as printed: "62%", or "No plan" when there is nobody to judge — never 0%. */
export function kpiFrequencyPctText(team: Pick<KpiTeamFrequency, "frequencyPct">): string {
  return team.frequencyPct == null ? "No plan" : `${team.frequencyPct}%`;
}

/**
 * THE TEAMS, WORST FIRST — for the sentence that names the team with the most doctors off target. Teams with
 * nobody to judge sit last; a tie goes to the larger judged list, then alphabetically by manager, so the
 * same board always names the same team.
 */
export function kpiFrequencyTeamsByGap(teams: readonly KpiTeamWithFrequency[]): KpiTeamWithFrequency[] {
  return [...teams].sort((left, right) => {
    const leftJudged = left.frequency.judged > 0;
    const rightJudged = right.frequency.judged > 0;
    if (leftJudged !== rightJudged) return leftJudged ? -1 : 1;
    return (
      kpiFrequencyOffTarget(right.frequency) - kpiFrequencyOffTarget(left.frequency) ||
      right.frequency.judged - left.frequency.judged ||
      left.team.managerName.localeCompare(right.team.managerName, undefined, { sensitivity: "base" })
    );
  });
}

/**
 * The one sentence under the teams: which team carries the most doctors off target, and how far apart the
 * best and the worst team's frequency are. Null when fewer than two teams can be judged — a single team is
 * the board itself, and the tile already says it.
 */
export function kpiFrequencyTeamsSentence(teams: readonly KpiTeamWithFrequency[]): string | null {
  const judged = teams.filter((entry) => entry.frequency.frequencyPct != null);
  if (judged.length < 2) return null;
  const [worst] = kpiFrequencyTeamsByGap(judged);
  const pcts = judged.map((entry) => entry.frequency.frequencyPct as number);
  const best = Math.max(...pcts);
  const lowest = Math.min(...pcts);
  const off = kpiFrequencyOffTarget(worst.frequency);
  const spread =
    best === lowest ? `Every team reads ${best}%.` : `The teams run from ${lowest}% to ${best}%, ${best - lowest} points apart.`;
  if (off === 0) return `No team has a doctor off target. ${spread}`;
  return `${worst.team.managerName}'s team has the most doctors off target: ${off} of ${worst.frequency.judged}. ${spread}`;
}

// ── The extra tiles ──────────────────────────────────────────────────────────────────────────

/**
 * The Frequency report's extra tiles beside its own tile: the doctors short of the plan or the norm, the
 * doctors seen too often (original rules) or left out ungraded (Phoenix), the reps whose own chip reads 90%
 * or more, and — when the count was read — the doctors not validated yet. Plain figures from the board, drawn
 * by the board view in its own `KpiTile`; a failed brick read prints no not-validated tile, never a 0.
 */
export function kpiFrequencyExtraTiles(
  board: Pick<KpisBoard, "reps" | "kpiRules">,
): Array<{ key: string; label: string; value: string; caption: string; band?: KpiBand }> {
  const phoenix = board.kpiRules === "phoenix";
  const team = kpiTeamFrequency(board.reps, board.kpiRules ?? "legacy");
  const notValidated = kpiNotValidatedTotal(board.reps);
  const tiles: Array<{ key: string; label: string; value: string; caption: string; band?: KpiBand }> = [
    {
      key: "below",
      label: phoenix ? "Below norm" : "Below plan",
      value: String(team.below),
      caption: phoenix
        ? `of ${team.judged} graded doctors got fewer visits than the grade asks`
        : `of ${team.judged} planned doctors got fewer visits than have come due`,
      band: team.judged > 0 && team.below === 0 ? "elite" : undefined,
    },
    phoenix
      ? {
          key: "ungraded",
          label: "Ungraded",
          value: String(team.ungraded),
          caption: "planned doctors with no grade, so no norm — left out of the percentage",
        }
      : {
          key: "above",
          label: "Above plan",
          value: String(team.above),
          caption: "doctors seen more often than the plan asked — also a deviation",
          band: team.judged > 0 && team.above === 0 ? "elite" : undefined,
        },
    {
      key: "top-band",
      label: "Reps at 90% or more",
      value: team.withPlan > 0 ? `${team.topBand} of ${team.withPlan}` : "No plan",
      caption: team.withPlan > 0 ? "reps with a plan, each on their own list" : "no rep in view carries a plan to judge",
      band:
        team.withPlan === 0 ? undefined : team.topBand === team.withPlan ? "elite" : team.topBand === 0 ? "behind" : "steady",
    },
  ];
  if (notValidated) {
    tiles.push({
      key: "not-validated",
      label: "Not validated yet",
      value: String(notValidated.doctors),
      caption:
        notValidated.doctors === 0
          ? "every planned doctor has a validated live photo"
          : `planned doctors with no validated live photo, across ${notValidated.reps} ${notValidated.reps === 1 ? "rep" : "reps"}`,
    });
  }
  return tiles;
}
