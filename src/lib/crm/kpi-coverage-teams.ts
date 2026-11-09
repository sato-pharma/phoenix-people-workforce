/**
 * THE COVERAGE REPORT'S TEAMS — the arithmetic behind the premium pass of 9 November 2026 (owner: "eyeball
 * every report in My Team's Reports, premium polish big work, every single component", then "group reps by
 * district manager").
 *
 * Pure: no database, no React, nothing server-side, so the report's server component, its tests and any
 * later export can all read the same answers. It ADDS NO MEASURE. Every percentage here is the board's
 * own arithmetic applied to a smaller set of rows:
 *
 * - a team's coverage is `sumKpiTeamTotals` + `kpiTeamFigures` (crm/kpis-board.ts), the ONE copy of the
 *   team arithmetic the Coverage tile and the Business Review pack already read, run over that team's
 *   rows. So the teams' covered and planned add up to the tile's "353 of 769", and a rep who has just
 *   started is a head in his team and nothing else, exactly as he is in the tile;
 * - a rep's band is `coverageBandOf` (crm/kpis-filters.ts), the cut the rep rows and their chips use;
 * - a brick's band is `kpiBandOf` over the brick line's own covered ÷ planned, as the brick table prints it.
 *
 * Nothing here re-scores a rep, re-reads a plan or decides who is in reach. The board decided all of that
 * before these functions see a row.
 */

import { kpiTeamFigures, sumKpiTeamTotals, type KpiRepRow } from "@/lib/crm/kpis-board";
import type { KpiBrickRow } from "@/lib/crm/kpis-brick-table";
import { KPI_DOCTOR_BRICK_NONE, KPI_DOCTOR_NOT_VALIDATED } from "@/lib/crm/kpis-doctor-filters";
import { coverageBandOf, kpiBandOf, type KpiBand } from "@/lib/crm/kpis-filters";

/** What a row with no region on the employee record is filed under. Never someone else's region. */
export const KPI_TEAM_NO_REGION = "Region not recorded";
/** What a row with no manager on the employee record is filed under. Never someone else's manager. */
export const KPI_TEAM_NO_MANAGER = "No manager recorded";

/** One team: every rep in view who shares a region and a direct manager, in the board's own order. */
export type KpiCoverageTeam<Row> = {
  /** Stable across renders and unique per team: the region and the manager, joined. */
  key: string;
  regionName: string;
  managerName: string;
  /** True when the employee record named no region for these reps. */
  regionMissing: boolean;
  /** True when the employee record named no manager for these reps. */
  managerMissing: boolean;
  /** The rows, each with its place on the whole board, so a rank disc keeps the board's own number. */
  members: Array<{ row: Row; boardIndex: number }>;
};

type TeamIdentity = Pick<KpiRepRow, "regionName" | "managerName">;

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** The two words a team is headed by, read off one row. */
export function kpiTeamIdentityOf(row: TeamIdentity): {
  regionName: string;
  managerName: string;
  regionMissing: boolean;
  managerMissing: boolean;
  key: string;
} {
  const region = clean(row.regionName);
  const manager = clean(row.managerName);
  const regionName = region ?? KPI_TEAM_NO_REGION;
  const managerName = manager ?? KPI_TEAM_NO_MANAGER;
  return {
    regionName,
    managerName,
    regionMissing: region == null,
    managerMissing: manager == null,
    key: `${regionName.toLowerCase()}\u0000${managerName.toLowerCase()}`,
  };
}

/**
 * Compare two team headings: by region, then by manager, alphabetically, with "not recorded" last on
 * either level. Case-insensitive, and locale-aware so an Arabic name sorts as Arabic.
 */
function compareTeams(
  left: Pick<KpiCoverageTeam<unknown>, "regionName" | "managerName" | "regionMissing" | "managerMissing">,
  right: Pick<KpiCoverageTeam<unknown>, "regionName" | "managerName" | "regionMissing" | "managerMissing">,
): number {
  if (left.regionMissing !== right.regionMissing) return left.regionMissing ? 1 : -1;
  const region = left.regionName.localeCompare(right.regionName, undefined, { sensitivity: "base" });
  if (region !== 0) return region;
  if (left.managerMissing !== right.managerMissing) return left.managerMissing ? 1 : -1;
  return left.managerName.localeCompare(right.managerName, undefined, { sensitivity: "base" });
}

/**
 * FILE EVERY REP UNDER HIS REGION AND HIS DIRECT MANAGER — the Regional Sales Manager rule every screen
 * built for him follows (owner, 9 Nov 2026: "group reps by district manager").
 *
 * - Teams are ordered by region, then by manager, so the same team sits in the same place whatever the
 *   board is sorted by.
 * - Inside a team the board's own order is kept, so a sort by Coverage still reads top-down within each
 *   team, and each row keeps its `boardIndex` — its place on the WHOLE board — so a rank disc never
 *   restarts at 1 under every heading.
 * - Every row lands in exactly one team, so the team sizes add up to the Medical reps in reach tile.
 * - A missing region or manager is said in words ("Region not recorded", "No manager recorded"), never
 *   filed under a neighbour.
 */
export function groupKpiRepsByTeam<Row extends TeamIdentity>(rows: readonly Row[]): Array<KpiCoverageTeam<Row>> {
  const teams = new Map<string, KpiCoverageTeam<Row>>();
  rows.forEach((row, boardIndex) => {
    const identity = kpiTeamIdentityOf(row);
    let team = teams.get(identity.key);
    if (!team) {
      team = {
        key: identity.key,
        regionName: identity.regionName,
        managerName: identity.managerName,
        regionMissing: identity.regionMissing,
        managerMissing: identity.managerMissing,
        members: [],
      };
      teams.set(identity.key, team);
    }
    team.members.push({ row, boardIndex });
  });
  return [...teams.values()].sort(compareTeams);
}

/** The heading a team is printed under: "Alex-BHR · Mohamed Eleiwa". */
export function kpiTeamHeading(team: Pick<KpiCoverageTeam<unknown>, "regionName" | "managerName">): string {
  return `${team.regionName} · ${team.managerName}`;
}

/** One team's coverage, from the board's own team arithmetic. */
export type KpiTeamCoverage = {
  /** Every rep in the team, the just-started included — a head is a head. */
  reps: number;
  /** Reps the team's figures are judged on: everyone but the just-started. */
  judgedReps: number;
  justStarted: number;
  planned: number;
  covered: number;
  notReached: number;
  /** Null when no judged rep in the team carries a planned doctor — "No plan", never 0%. */
  coveragePct: number | null;
  band: KpiBand;
  /** Judged reps at or above the 95% floor, and judged reps with a plan at all. */
  atFloor: number;
  withPlan: number;
  /** Off-plan doctors the team's judged reps saw: real work, outside the list, never in the percentage. */
  offPlan: number;
};

/**
 * A TEAM'S COVERAGE — `sumKpiTeamTotals` and `kpiTeamFigures` over the team's own rows, which is what the
 * Coverage tile does over every row. Planned and covered therefore add up across the teams to the tile.
 */
export function kpiTeamCoverage(rows: readonly KpiRepRow[], rules: KpisRules): KpiTeamCoverage {
  const totals = sumKpiTeamTotals(rows);
  const figures = kpiTeamFigures(totals, rules);
  const judged = rows.filter((row) => !row.justStarted);
  const withPlan = judged.filter((row) => row.hasMeasurablePlan);
  const coveragePct = totals.plannedDoctors > 0 ? figures.coveragePct : null;
  return {
    reps: rows.length,
    judgedReps: judged.length,
    justStarted: rows.length - judged.length,
    planned: totals.plannedDoctors,
    covered: totals.visitedDoctors,
    notReached: Math.max(0, totals.plannedDoctors - totals.visitedDoctors),
    coveragePct,
    band: kpiBandOf(coveragePct),
    atFloor: withPlan.filter((row) => row.meetsCoverageFloor === true).length,
    withPlan: withPlan.length,
    offPlan: judged.reduce((sum, row) => sum + (row.offPlanDoctors ?? 0), 0),
  };
}

/** The rules a board was scored under, as `kpiTeamFigures` takes them. */
type KpisRules = Parameters<typeof kpiTeamFigures>[1];

/** The order the band bar reads in: the best band first, then the two quiet states. */
export const KPI_COVERAGE_BAND_ORDER = ["elite", "strong", "steady", "behind"] as const;

/** One slice of the "where the reps stand" bar. */
export type KpiCoverageBandSlice = {
  key: "elite" | "strong" | "steady" | "behind" | "just-started" | "no-plan";
  label: string;
  band: KpiBand;
  count: number;
};

const BAND_LABEL: Record<(typeof KPI_COVERAGE_BAND_ORDER)[number], string> = {
  elite: "90% and above",
  strong: "75 to 89%",
  steady: "50 to 74%",
  behind: "Under 50%",
};

/**
 * WHERE THE REPS STAND — every rep in view in exactly one slice: one of the four bands his coverage chip
 * already shows, "Just started" (judged by nothing, owner 2026-10-26), or "No plan" (nothing to measure,
 * never a 0%). The slices add up to the Medical reps in reach tile. Empty slices are kept, in order, so a
 * caller decides what to draw; `count` says which are empty.
 */
export function kpiCoverageBandMix(rows: readonly KpiRepRow[]): KpiCoverageBandSlice[] {
  const counts = { elite: 0, strong: 0, steady: 0, behind: 0, "just-started": 0, "no-plan": 0 };
  for (const row of rows) {
    if (row.justStarted) {
      counts["just-started"] += 1;
      continue;
    }
    const band = coverageBandOf(row);
    if (band === "noplan") counts["no-plan"] += 1;
    else counts[band] += 1;
  }
  return [
    ...KPI_COVERAGE_BAND_ORDER.map((band) => ({ key: band, label: BAND_LABEL[band], band, count: counts[band] })),
    { key: "just-started" as const, label: "Just started", band: "noplan" as const, count: counts["just-started"] },
    { key: "no-plan" as const, label: "No plan", band: "noplan" as const, count: counts["no-plan"] },
  ];
}

/**
 * HOW MANY OF THE JUDGED REPS CLEAR THE 95% FLOOR — the floor every rep row's badge already applies
 * (`meetsCoverageFloor`). A rep with no plan, or one who has just started, is in neither count.
 */
export function kpiCoverageFloorCount(rows: readonly KpiRepRow[]): { atFloor: number; belowFloor: number } {
  let atFloor = 0;
  let belowFloor = 0;
  for (const row of rows) {
    if (row.justStarted || !row.hasMeasurablePlan) continue;
    if (row.meetsCoverageFloor === true) atFloor += 1;
    else if (row.meetsCoverageFloor === false) belowFloor += 1;
  }
  return { atFloor, belowFloor };
}

/**
 * THE DOCTORS NOT VALIDATED YET, ADDED UP over every rep whose count was read. Null when not one rep's
 * count was read (the brick read failed, or this tab does not ask it), so a failed read prints nothing,
 * never a 0 — the rule `notValidatedDoctors` itself follows. A just-started rep carries no count.
 */
export function kpiNotValidatedTotal(rows: readonly KpiRepRow[]): { doctors: number; reps: number } | null {
  let doctors = 0;
  let reps = 0;
  let read = false;
  for (const row of rows) {
    const count = row.notValidatedDoctors;
    if (typeof count !== "number") continue;
    read = true;
    doctors += count;
    if (count > 0) reps += 1;
  }
  return read ? { doctors, reps } : null;
}

/** The two brick lines that are not a place on the map: no brick on record, and not validated yet. */
export function isKpiSentinelBrick(row: Pick<KpiBrickRow, "brick">): boolean {
  return row.brick === KPI_DOCTOR_BRICK_NONE || row.brick === KPI_DOCTOR_NOT_VALIDATED;
}

/** One brick's coverage, as the brick table prints it: covered ÷ planned, rounded. */
export function kpiBrickCoveragePct(row: Pick<KpiBrickRow, "covered" | "planned">): number | null {
  return row.planned > 0 ? Math.round((row.covered / row.planned) * 100) : null;
}

/** One slice of the "the bricks at a glance" bar. */
export type KpiBrickBandSlice = {
  key: "full" | "elite" | "strong" | "steady" | "behind" | "untouched";
  label: string;
  band: KpiBand;
  count: number;
};

/**
 * THE BRICKS AT A GLANCE — every real brick (the two sentinel lines left out: they are not places) in
 * exactly one slice by its own coverage: fully covered, the four bands, or not reached at all. "Fully
 * covered" and "Not reached yet" are pulled out of Elite and Behind because they are the two answers a
 * manager acts on — a brick done, and a brick nobody has walked into. The slices add up to the real
 * bricks in the table below.
 */
export function kpiBrickBandMix(rows: readonly KpiBrickRow[]): KpiBrickBandSlice[] {
  const counts = { full: 0, elite: 0, strong: 0, steady: 0, behind: 0, untouched: 0 };
  for (const row of rows) {
    if (isKpiSentinelBrick(row)) continue;
    const pct = kpiBrickCoveragePct(row);
    if (pct == null) continue;
    if (row.covered === 0) counts.untouched += 1;
    else if (row.covered >= row.planned) counts.full += 1;
    else {
      const band = kpiBandOf(pct);
      if (band === "elite" || band === "strong" || band === "steady" || band === "behind") counts[band] += 1;
    }
  }
  return [
    { key: "full", label: "Fully covered", band: "elite", count: counts.full },
    { key: "elite", label: "90% and above", band: "elite", count: counts.elite },
    { key: "strong", label: "75 to 89%", band: "strong", count: counts.strong },
    { key: "steady", label: "50 to 74%", band: "steady", count: counts.steady },
    { key: "behind", label: "Under 50%", band: "behind", count: counts.behind },
    { key: "untouched", label: "Not reached yet", band: "behind", count: counts.untouched },
  ];
}

/**
 * THE BRICKS NOBODY HAS REACHED — real bricks with planned doctors and not one of them seen, the largest
 * first (more doctors waiting is the bigger gap), then by name. Sentinel lines are never listed: "Not
 * validated yet" is not a place a rep can walk into.
 */
export function kpiBricksNotReached(rows: readonly KpiBrickRow[]): KpiBrickRow[] {
  return rows
    .filter((row) => !isKpiSentinelBrick(row) && row.planned > 0 && row.covered === 0)
    .sort((left, right) => right.planned - left.planned || left.label.localeCompare(right.label));
}

/**
 * THE BRICKS WITH THE MOST LEFT TO SEE — real bricks ranked by the planned doctors NOT seen yet, largest
 * first, a reached brick only (a brick with nobody seen is already in `kpiBricksNotReached`). `limit`
 * caps the list for a chart; the table below still holds every brick.
 */
export function kpiBricksMostLeft(rows: readonly KpiBrickRow[], limit = 6): Array<KpiBrickRow & { left: number }> {
  return rows
    .filter((row) => !isKpiSentinelBrick(row) && row.covered > 0 && row.covered < row.planned)
    .map((row) => ({ ...row, left: row.planned - row.covered }))
    .sort((left, right) => right.left - left.left || left.label.localeCompare(right.label))
    .slice(0, Math.max(0, limit));
}

/** The real bricks' own totals, so a caption can say "53 bricks, 12 fully covered". */
export function kpiBrickTotals(rows: readonly KpiBrickRow[]): { bricks: number; planned: number; covered: number } {
  let bricks = 0;
  let planned = 0;
  let covered = 0;
  for (const row of rows) {
    if (isKpiSentinelBrick(row)) continue;
    bricks += 1;
    planned += row.planned;
    covered += row.covered;
  }
  return { bricks, planned, covered };
}

/**
 * A meter's width for one value against the largest in view, 0 to 100. A list of one, or a largest of 0,
 * reads as an empty track, never a full one.
 */
export function kpiMeterWidth(value: number, largest: number): number {
  if (!(largest > 0) || !(value > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((value / largest) * 100)));
}

/**
 * The slices' share of their whole, in whole percents that add up to exactly 100 (the largest remainder
 * takes the rounding), so a legend never reads 33 + 33 + 33. All-zero slices read 0 each.
 */
export function kpiSharePercents(counts: readonly number[]): number[] {
  const total = counts.reduce((sum, count) => sum + Math.max(0, count), 0);
  if (total <= 0) return counts.map(() => 0);
  const raw = counts.map((count) => (Math.max(0, count) / total) * 100);
  const floors = raw.map((value) => Math.floor(value));
  let remainder = 100 - floors.reduce((sum, value) => sum + value, 0);
  const order = raw
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (const { index } of order) {
    if (remainder <= 0) break;
    if (counts[index] > 0) {
      floors[index] += 1;
      remainder -= 1;
    }
  }
  return floors;
}
