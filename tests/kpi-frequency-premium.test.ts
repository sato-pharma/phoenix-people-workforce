import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ExcelJS from "exceljs";

import type { RepCallRate } from "../src/lib/crm/call-rate.ts";
import { groupKpiRepsByTeam, KPI_TEAM_NO_REGION, kpiTeamHeading } from "../src/lib/crm/kpi-coverage-teams.ts";
import {
  KPI_FREQUENCY_BAND_ORDER,
  kpiFrequencyBandMix,
  kpiFrequencyDoctorMix,
  kpiFrequencyExtraTiles,
  kpiFrequencyHeadCount,
  kpiFrequencyOffTarget,
  kpiFrequencyPctText,
  kpiFrequencyTeamsByGap,
  kpiFrequencyTeamsSentence,
  kpiTeamFrequency,
  kpiTeamsWithFrequency,
} from "../src/lib/crm/kpi-frequency-teams.ts";
import {
  joinKpiRows,
  kpiTeamFigures,
  sumKpiTeamTotals,
  type KpiCoverageDetail,
  type KpiCoverageDoctor,
  type KpiDirectoryEntry,
  type KpiRepRow,
  type KpisBoard,
} from "../src/lib/crm/kpis-board.ts";
import { buildKpisBoardWorkbook } from "../src/lib/crm/kpis-board-workbook.ts";
import { EMPTY_KPI_DOCTOR_FILTER } from "../src/lib/crm/kpis-doctor-filters.ts";
import { KPI_FLAGS_OFF_REPORT } from "../src/lib/crm/kpis-filters.ts";
import type { DoctorFrequency } from "../src/lib/crm/phoenix-kpi-rules.ts";
import type { RepDoctorListRepRow } from "../src/lib/crm/rep-doctor-lists.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * THE FREQUENCY REPORT'S PREMIUM PASS (owner, 9 Nov 2026: "eyeball every report in My Team's Reports, premium
 * polish big work, every single component", then "group reps by district manager").
 *
 * What would go wrong, each without an error anyone could see:
 *
 *   1. a team heading whose frequency does not add up to the Frequency tile — a regional manager adds the teams
 *      in his head, gets a different number from the tile, and stops trusting both;
 *   2. a rep who has just started pulling his team's percentage down for a calendar he had no part of
 *      (owner, 2026-10-26) — on the tile he is a head and nothing else, so on the heading too;
 *   3. a team with nobody to judge printed as 0%, which reads as a team that failed every doctor;
 *   4. the Phoenix rules' heading counting "above" (never a deviation there) or leaving the ungraded doctors in
 *      the percentage (rule 7);
 *   5. a sentence that names the wrong team, or names a team with nobody judged as the worst;
 *   6. a Frequency export whose Teams sheet still speaks coverage, or whose Doctors sheet has no Gap;
 *   7. the gloss finish (gradients, glow, drop shadows), round corners or a sideways scroll creeping into the
 *      new panels.
 *
 * Every figure is worked out by hand on the fixed rows below; the workbook is read back cell by cell; the
 * finish is read in the source with its comments stripped.
 */

const root = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const read = (path: string) => readFileSync(root(path), "utf8");

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────

type RowShape = {
  name: string;
  region: string | null;
  manager: string | null;
  planned: number;
  onPlan: number;
  under: number;
  over: number;
  justStarted?: boolean;
  notValidated?: number | null;
  /** The Phoenix rules' own split of the list: graded doctors (judged) and the ungraded left out. */
  phoenix?: { judged: number; ungraded: number };
};

/** A rep row with only what the Frequency arithmetic, `sumKpiTeamTotals` and the band chips read. */
function row(shape: RowShape): KpiRepRow {
  const measurable = shape.planned > 0;
  const denominator = shape.phoenix ? shape.phoenix.judged : shape.planned;
  return {
    agentCrmId: null,
    agentHrId: null,
    repName: shape.name,
    regionName: shape.region,
    managerName: shape.manager,
    lineName: "Pedia",
    areaName: null,
    jobTitle: "Medical Representative",
    justStarted: shape.justStarted ? { workingDays: 1, windowDays: 22 } : null,
    workingDays: 6,
    amVerified: 0,
    pmVerified: 0,
    amReported: 0,
    pmReported: 0,
    pharmacyVerified: 0,
    pharmacyReported: 0,
    campaignCalls: 0,
    totalCalls: 0,
    noGpsFeed: false,
    plannedDoctors: shape.planned,
    visitedDoctors: shape.onPlan + shape.under + shape.over,
    missedDoctors: 0,
    coveragePct: 0,
    meetsCoverageFloor: null,
    hasMeasurablePlan: measurable,
    onPlanDoctors: shape.onPlan,
    underDoctors: shape.under,
    overDoctors: shape.over,
    frequencyPct: denominator > 0 ? Math.round((shape.onPlan / denominator) * 100) : 0,
    offPlanDoctors: 0,
    ...(shape.phoenix ? { phoenix: { frequency: shape.phoenix, regularNoCheckin: 0 } } : {}),
    ...(shape.notValidated === undefined ? {} : { notValidatedDoctors: shape.notValidated }),
  } as unknown as KpiRepRow;
}

/**
 * Six reps on the original rules, three teams:
 *
 *   Alex-BHR · Mohamed Eleiwa   Momen    20 planned  6 exact  10 below  4 above          30%  behind
 *                               Mostafa  10 planned  0 exact   6 below  1 above  3 rest   0%  behind
 *                               Newbie   15 planned, JUST STARTED — a head, nothing else
 *                               team     30 judged   6 met    16 below  5 above  3 rest  20%
 *   Delta (1) · Nermeen Salah   Hassan   18 planned 12 exact   4 below  2 above          67%  steady
 *                               Nada     12 planned 11 exact   1 below                   92%  elite
 *                               team     30 judged  23 met     5 below  2 above          77%
 *   (no region) · Hany Saad     Floater   0 planned — nobody to judge, "No plan"
 *
 *   board                       60 judged  29 met  21 below  7 above  3 rest  48%
 */
function legacyRows(): KpiRepRow[] {
  return [
    row({ name: "Hassan", region: "Delta (1)", manager: "Nermeen Salah", planned: 18, onPlan: 12, under: 4, over: 2 }),
    row({ name: "Momen", region: "Alex-BHR", manager: "Mohamed Eleiwa", planned: 20, onPlan: 6, under: 10, over: 4 }),
    row({ name: "Nada", region: "Delta (1)", manager: "Nermeen Salah", planned: 12, onPlan: 11, under: 1, over: 0 }),
    row({ name: "Newbie", region: "Alex-BHR", manager: "Mohamed Eleiwa", planned: 15, onPlan: 0, under: 0, over: 0, justStarted: true }),
    row({ name: "Mostafa", region: "Alex-BHR", manager: "Mohamed Eleiwa", planned: 10, onPlan: 0, under: 6, over: 1 }),
    row({ name: "Floater", region: null, manager: "Hany Saad", planned: 0, onPlan: 0, under: 0, over: 0 }),
  ];
}

const byManager = (teams: ReturnType<typeof kpiTeamsWithFrequency>, manager: string) => {
  const entry = teams.find((candidate) => candidate.team.managerName === manager);
  assert.ok(entry, `${manager}'s team is on the board`);
  return entry;
};

// ── 1. A team's frequency is the board's own arithmetic ─────────────────────────────────────────

function checkTeamFrequency() {
  const rows = legacyRows();
  const teams = kpiTeamsWithFrequency(groupKpiRepsByTeam(rows), "legacy");
  assert.deepEqual(
    teams.map((entry) => kpiTeamHeading(entry.team)),
    ["Alex-BHR · Mohamed Eleiwa", "Delta (1) · Nermeen Salah", `${KPI_TEAM_NO_REGION} · Hany Saad`],
    "the same teams, in the same order, as the Coverage page — one grouping for both",
  );

  const alex = byManager(teams, "Mohamed Eleiwa").frequency;
  assert.deepEqual(alex, {
    reps: 3,
    judgedReps: 2,
    justStarted: 1,
    judged: 30,
    met: 6,
    below: 16,
    above: 5,
    ungraded: 0,
    rest: 3,
    frequencyPct: 20,
    band: "behind",
    withPlan: 2,
    topBand: 0,
  }, "Newbie's 15 planned doctors stay out of the team's 30, exactly as they stay out of the tile");

  const delta = byManager(teams, "Nermeen Salah").frequency;
  assert.equal(delta.judged, 30);
  assert.equal(delta.met, 23);
  assert.equal(delta.frequencyPct, 77, "23 of 30, rounded as the tile rounds");
  assert.equal(delta.band, "strong");
  assert.equal(delta.rest, 0);
  assert.deepEqual([delta.withPlan, delta.topBand], [2, 1], "Nada alone reads 90% or more");

  const hany = byManager(teams, "Hany Saad").frequency;
  assert.equal(hany.judged, 0);
  assert.equal(hany.frequencyPct, null, "nobody to judge is no percentage, never 0%");
  assert.equal(hany.band, "noplan");
  assert.equal(kpiFrequencyPctText(hany), "No plan");
  assert.equal(kpiFrequencyPctText(delta), "77%");

  // The teams add up to the tile: the board's frequency is the same arithmetic over every row.
  const board = kpiTeamFrequency(rows, "legacy");
  const tile = kpiTeamFigures(sumKpiTeamTotals(rows), "legacy");
  assert.equal(board.frequencyPct, tile.frequencyPct, "the board's frequency is the tile's own figure");
  assert.equal(board.frequencyPct, 48, "29 of 60");
  for (const key of ["judged", "met", "below", "above", "rest", "reps", "justStarted"] as const) {
    assert.equal(
      teams.reduce((sum, entry) => sum + entry.frequency[key], 0),
      board[key],
      `the teams' ${key} add up to the board's`,
    );
  }
  assert.equal(board.judged, board.met + board.below + board.above + board.rest, "the four slices are the whole planned list");
  assert.deepEqual(
    kpiTeamsWithFrequency(groupKpiRepsByTeam(rows), null).map((entry) => entry.frequency.frequencyPct),
    teams.map((entry) => entry.frequency.frequencyPct),
    "an unscored board reads the original rules, as the board does",
  );

  assert.equal(kpiFrequencyHeadCount(alex), "3 reps · 1 just started");
  assert.equal(kpiFrequencyHeadCount(delta), "2 reps");
  assert.equal(kpiFrequencyHeadCount(hany), "1 rep");
  assert.equal(kpiFrequencyOffTarget(alex), 21, "below and above: both are deviations on the original rules");
}

// ── 2. The Phoenix rules ────────────────────────────────────────────────────────────────────────

function checkPhoenixRules() {
  // P1: 20 planned, 16 graded and 4 ungraded; 8 at norm, 8 below. A stray overDoctors of 3 must not count.
  // P2: 10 planned, all graded; 9 at norm, 1 below.
  const rows = [
    row({ name: "P1", region: "Cairo", manager: "Ahmed", planned: 20, onPlan: 8, under: 8, over: 3, phoenix: { judged: 16, ungraded: 4 } }),
    row({ name: "P2", region: "Cairo", manager: "Ahmed", planned: 10, onPlan: 9, under: 1, over: 0, phoenix: { judged: 10, ungraded: 0 } }),
  ];
  const team = kpiTeamFrequency(rows, "phoenix");
  assert.equal(team.judged, 26, "graded doctors only — rule 7 leaves the ungraded out");
  assert.equal(team.met, 17);
  assert.equal(team.below, 9);
  assert.equal(team.above, 0, "above is never a deviation under the Phoenix rules");
  assert.equal(team.ungraded, 4);
  assert.equal(team.rest, 0, "a graded doctor never seen is already below the norm");
  assert.equal(team.frequencyPct, 65, "17 of 26");
  assert.equal(team.frequencyPct, kpiTeamFigures(sumKpiTeamTotals(rows), "phoenix").frequencyPct, "the tile's own figure");
  assert.equal(kpiFrequencyOffTarget(team), 9, "never the ungraded: nobody is short of a norm the grade does not set");

  assert.deepEqual(
    kpiFrequencyDoctorMix(team, "phoenix").map((slice) => [slice.label, slice.count, slice.pass, slice.outside]),
    [
      ["At norm", 17, true, false],
      ["Below norm", 9, false, false],
      ["Ungraded · left out", 4, false, true],
    ],
    "the Phoenix rules' own words, the ungraded marked as outside the percentage",
  );

  const tiles = kpiFrequencyExtraTiles({ reps: rows, kpiRules: "phoenix" });
  assert.deepEqual(
    tiles.map((tile) => [tile.key, tile.label, tile.value]),
    [
      ["below", "Below norm", "9"],
      ["ungraded", "Ungraded", "4"],
      ["top-band", "Reps at 90% or more", "1 of 2"],
    ],
  );
  assert.equal(tiles[0].caption, "of 26 graded doctors got fewer visits than the grade asks");
}

// ── 3. Where the reps and the doctors stand ─────────────────────────────────────────────────────

function checkMixes() {
  const rows = legacyRows();
  const bands = kpiFrequencyBandMix(rows);
  assert.deepEqual(
    bands.map((slice) => [slice.key, slice.count]),
    [
      ["elite", 1],
      ["strong", 0],
      ["steady", 1],
      ["behind", 2],
      ["just-started", 1],
      ["no-plan", 1],
    ],
    "every rep in exactly one slice, the empty bands kept in their place",
  );
  assert.equal(bands.reduce((sum, slice) => sum + slice.count, 0), rows.length, "the slices add up to the reps tile");
  assert.deepEqual(bands.slice(0, 4).map((slice) => slice.key), [...KPI_FREQUENCY_BAND_ORDER]);
  assert.deepEqual(
    bands.slice(0, 4).map((slice) => slice.label),
    ["90% and above", "75 to 89%", "50 to 74%", "Under 50%"],
    "the cuts every rep's chip already shows — and no floor, because frequency has never been given one",
  );

  const doctors = kpiFrequencyDoctorMix(kpiTeamFrequency(rows, "legacy"), "legacy");
  assert.deepEqual(
    doctors.map((slice) => [slice.key, slice.count, slice.pass]),
    [
      ["met", 29, true],
      ["below", 21, false],
      ["above", 7, false],
      ["rest", 3, false],
    ],
    "Exact is the only pass; Above is a deviation as well (owner, 2026-09-02)",
  );
  assert.equal(doctors.reduce((sum, slice) => sum + slice.count, 0), 60, "the slices add up to the tile's denominator");
  assert.ok(doctors.every((slice) => !slice.outside), "nothing on the original rules sits outside the percentage");
}

// ── 4. The sentence and the extra tiles ─────────────────────────────────────────────────────────

function checkSentenceAndTiles() {
  const rows = legacyRows();
  const teams = kpiTeamsWithFrequency(groupKpiRepsByTeam(rows), "legacy");
  assert.deepEqual(
    kpiFrequencyTeamsByGap(teams).map((entry) => entry.team.managerName),
    ["Mohamed Eleiwa", "Nermeen Salah", "Hany Saad"],
    "most doctors off target first, the team with nobody judged last",
  );
  assert.equal(
    kpiFrequencyTeamsSentence(teams),
    "Mohamed Eleiwa's team has the most doctors off target: 21 of 30. The teams run from 20% to 77%, 57 points apart.",
  );
  assert.equal(
    kpiFrequencyTeamsSentence(teams.filter((entry) => entry.team.managerName !== "Mohamed Eleiwa")),
    null,
    "one judged team is the board itself: the tile already says it",
  );
  const clean = kpiTeamsWithFrequency(
    groupKpiRepsByTeam([
      row({ name: "A", region: "R1", manager: "Ola", planned: 10, onPlan: 10, under: 0, over: 0 }),
      row({ name: "B", region: "R2", manager: "Rana", planned: 10, onPlan: 10, under: 0, over: 0 }),
    ]),
    "legacy",
  );
  assert.equal(kpiFrequencyTeamsSentence(clean), "No team has a doctor off target. Every team reads 100%.");

  // A tie on doctors off target goes to the larger judged list, then to the manager's name, so the same board
  // always names the same team — never whichever team the database happened to return first.
  const tied = kpiTeamsWithFrequency(
    groupKpiRepsByTeam([
      row({ name: "Z1", region: "R1", manager: "Zeinab", planned: 10, onPlan: 6, under: 4, over: 0 }),
      row({ name: "A1", region: "R2", manager: "Amr", planned: 10, onPlan: 6, under: 4, over: 0 }),
      row({ name: "W1", region: "R3", manager: "Walid", planned: 20, onPlan: 16, under: 4, over: 0 }),
    ]),
    "legacy",
  );
  assert.deepEqual(
    kpiFrequencyTeamsByGap(tied).map((entry) => entry.team.managerName),
    ["Walid", "Amr", "Zeinab"],
    "four off target each: Walid's 20 judged first, then Amr before Zeinab by name",
  );
  assert.deepEqual(
    kpiFrequencyTeamsByGap([...tied].reverse()).map((entry) => entry.team.managerName),
    ["Walid", "Amr", "Zeinab"],
    "whatever order the teams arrive in",
  );
  assert.equal(
    kpiFrequencyTeamsSentence(tied),
    "Walid's team has the most doctors off target: 4 of 20. The teams run from 60% to 80%, 20 points apart.",
  );

  const tiles = kpiFrequencyExtraTiles({ reps: rows, kpiRules: "legacy" });
  assert.deepEqual(
    tiles.map((tile) => [tile.key, tile.label, tile.value, tile.band ?? null]),
    [
      ["below", "Below plan", "21", null],
      ["above", "Above plan", "7", null],
      ["top-band", "Reps at 90% or more", "1 of 4", "steady"],
    ],
    "no Not validated tile when the count was never read — never a 0",
  );
  assert.equal(tiles[0].caption, "of 60 planned doctors got fewer visits than have come due");

  const read = rows.map((entry, index) => ({ ...entry, notValidatedDoctors: index === 0 ? 3 : index === 2 ? 2 : 0 }));
  const withCount = kpiFrequencyExtraTiles({ reps: read, kpiRules: "legacy" });
  const notValidated = withCount.find((tile) => tile.key === "not-validated");
  assert.ok(notValidated, "a count that was read is a tile");
  assert.equal(notValidated.value, "5");
  assert.equal(notValidated.caption, "planned doctors with no validated live photo, across 2 reps");

  const empty = kpiFrequencyExtraTiles({ reps: [rows[5]], kpiRules: "legacy" });
  assert.equal(empty.find((tile) => tile.key === "top-band")?.value, "No plan", "no rep with a plan: no fraction of nobody");
  assert.equal(empty.find((tile) => tile.key === "below")?.band, undefined, "nobody judged is never painted a pass");
}

// ── 5. The Frequency export ─────────────────────────────────────────────────────────────────────

function callRate(agentCrmId: number, agentHrId: string, agentName: string): RepCallRate {
  const slice = (target: number) => ({
    attainmentPct: 50,
    campaign: 0,
    target,
    total: target * 5,
    totalRate: target,
    unverified: 0,
    verified: target * 5,
    verifiedRate: target,
  });
  return {
    agentCrmId,
    agentHrId,
    agentName,
    am: slice(2),
    campaignOnlyDays: 0,
    campaignOverLimitDays: [],
    campaignShare: 0,
    pm: slice(10),
    pharmacy: { attainmentPct: null, campaign: 0, target: null, total: 0, totalRate: 0, unverified: 0, verified: 0, verifiedRate: 0 },
    unspecified: 0,
    awaitingValidation: 0,
  } as unknown as RepCallRate;
}

function docList(
  agentCrmId: number,
  agentHrId: string,
  repName: string,
  planned: number,
  onPlan: number,
  under: number,
  over: number,
): RepDoctorListRepRow {
  return {
    actualCalls: onPlan + under + over,
    agentCrmId,
    agentHrId,
    campaignCalls: 0,
    coverageDueDoctors: planned,
    coveragePct: 80,
    frequencyPct: Math.round((onPlan / planned) * 100),
    gradeA: 0,
    gradeB: 0,
    gradeC: 0,
    hasMeasurablePlan: true,
    missedDoctors: 0,
    notDueDoctors: 0,
    offPlanDoctors: 0,
    onPlanDoctors: onPlan,
    overDoctors: over,
    plannedAccounts: 0,
    plannedCalls: planned,
    plannedCallsToDate: planned,
    plannedDoctors: planned,
    plannedUnclassified: 0,
    repKey: String(agentCrmId),
    repName,
    underDoctors: under,
    underPlannedVsGrade: 0,
    unverifiedCalls: 0,
    visitedDoctors: onPlan + under + over,
  } as unknown as RepDoctorListRepRow;
}

function directoryEntry(hrId: string, displayName: string, regionName: string, managerName: string): KpiDirectoryEntry {
  return { hrId, displayName, lineName: "Pedia", regionName, areaName: "Area", managerName, jobTitle: "Medical Representative" };
}

function plan(required: number, dueSoFar: number, actual: number, status: DoctorFrequency["status"]): DoctorFrequency {
  return { basis: "plan", required, dueSoFar, actual, status };
}

function exportDoctor(contactCrmId: number, name: string, frequency: DoctorFrequency): KpiCoverageDoctor {
  return {
    contactCrmId,
    name,
    speciality: "Pediatrics",
    grade: "A",
    visits: frequency.actual,
    lastVisitDate: frequency.actual > 0 ? "2026-11-05" : null,
    planDates: ["2026-11-03"],
    frequency,
    due: frequency.status !== "not-due",
  };
}

function boardOf(reps: KpisBoard["reps"], coverageDetail: KpiCoverageDetail | null = null): KpisBoard {
  return {
    month: "2026-11",
    monthLabel: "November 2026",
    range: { dateFrom: "2026-11-01", dateTo: "2026-11-08", periodKey: "month", periodLabel: "Whole month" },
    workingDays: 6,
    asOf: "2026-11-30",
    scopeLabel: "Regional Manager · own region",
    scopeReason: null,
    reps,
    managers: [],
    scopedReps: reps.length,
    kpiRules: "legacy",
    coverageFloorPct: 95,
    totals: { reps: reps.length, coveragePct: 80, frequencyPct: 48, amAttainmentPct: 77, pmAttainmentPct: 68 },
    kpiIndex: { overallPct: 43, method: "The average of coverage, frequency, AM and PM." },
    holidaysComplete: true,
    amTarget: 2,
    pmTarget: 10,
    filters: { doctor: EMPTY_KPI_DOCTOR_FILTER },
    coverageDetail,
  } as unknown as KpisBoard;
}

function cellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value == null) return "";
  if (typeof value === "object" && "richText" in value) return value.richText.map((part) => part.text).join("");
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function tableOf(sheet: ExcelJS.Worksheet, firstHeader: string) {
  let headerRow = 0;
  sheet.eachRow((sheetRow, number) => {
    if (!headerRow && cellText(sheetRow.getCell(1)) === firstHeader) headerRow = number;
  });
  assert.ok(headerRow > 0, `the "${sheet.name}" table has its header row`);
  const headers = new Map<string, number>();
  sheet.getRow(headerRow).eachCell((cell, column) => headers.set(cellText(cell), column));
  const rows: ExcelJS.Row[] = [];
  for (let number = headerRow + 1; number <= sheet.rowCount; number += 1) {
    const sheetRow = sheet.getRow(number);
    if (cellText(sheetRow.getCell(1))) rows.push(sheetRow);
  }
  const value = (sheetRow: ExcelJS.Row, header: string) => {
    const column = headers.get(header);
    assert.ok(column, `the "${sheet.name}" sheet has a "${header}" column (${[...headers.keys()].join(", ")})`);
    return sheetRow.getCell(column).value;
  };
  return { headers, rows, value };
}

async function load(buffer: Buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  return workbook;
}

async function checkWorkbook() {
  const reps = joinKpiRows({
    callRates: [callRate(1, "P-1", "Hassan"), callRate(2, "P-2", "Momen"), callRate(3, "P-3", "Nada")],
    docLists: [docList(1, "p-1", "Hassan", 18, 12, 4, 2), docList(2, "p-2", "Momen", 20, 6, 10, 4), docList(3, "p-3", "Nada", 12, 11, 1, 0)],
    scope: { basis: "company", kind: "company", label: "Whole company" },
    workingDays: 5,
    directory: [
      directoryEntry("P-1", "Hassan", "Delta (1)", "Nermeen Salah"),
      directoryEntry("P-2", "Momen", "Alex-BHR", "Mohamed Eleiwa"),
      directoryEntry("P-3", "Nada", "Delta (1)", "Nermeen Salah"),
    ],
  });
  assert.equal(reps.length, 3, "the three reps are on the board");

  const frequency = await load(
    await buildKpisBoardWorkbook(boardOf(reps), "2026-11-09T08:00:00.000Z", { doctorLists: true, report: "frequency" }),
  );
  const teamsSheet = frequency.getWorksheet("Teams");
  assert.ok(teamsSheet, `the Frequency export carries a Teams sheet (${frequency.worksheets.map((sheet) => sheet.name).join(", ")})`);
  const teams = tableOf(teamsSheet, "Region");
  assert.deepEqual(
    [...teams.headers.keys()],
    ["Region", "Manager", "Reps", "Just started", "Doctors planned", "Exact", "Below", "Above", "Frequency", "Reps at 90% or more"],
    "the Frequency screen's team headings as columns — never the coverage columns",
  );
  assert.deepEqual(
    teams.rows.map((sheetRow) => `${cellText(sheetRow.getCell(1))} · ${String(teams.value(sheetRow, "Manager"))}`),
    ["Alex-BHR · Mohamed Eleiwa", "Delta (1) · Nermeen Salah"],
    "one line per region and manager, in the screen's own order",
  );
  const delta = teams.rows[1];
  assert.equal(teams.value(delta, "Doctors planned"), 30, "18 + 12");
  assert.equal(teams.value(delta, "Exact"), 23);
  assert.equal(teams.value(delta, "Below"), 5);
  assert.equal(teams.value(delta, "Above"), 2);
  assert.equal(Math.round(Number(teams.value(delta, "Frequency")) * 100), 77, "23 of 30, written as a percentage cell");
  assert.equal(teams.value(delta, "Reps at 90% or more"), "1 of 2");
  const judgedTotal = teams.rows.reduce((sum, sheetRow) => sum + Number(teams.value(sheetRow, "Doctors planned")), 0);
  const metTotal = teams.rows.reduce((sum, sheetRow) => sum + Number(teams.value(sheetRow, "Exact")), 0);
  assert.deepEqual([judgedTotal, metTotal], [50, 29], "the Teams sheet adds up to the board's own 29 of 50");

  const coverage = await load(await buildKpisBoardWorkbook(boardOf(reps), "2026-11-09T08:00:00.000Z", { doctorLists: true }));
  const coverageTeams = tableOf(coverage.getWorksheet("Teams")!, "Region");
  assert.ok(coverageTeams.headers.has("Doctors visited"), "the Coverage export's Teams sheet is untouched");
  assert.ok(!coverageTeams.headers.has("Exact"), "and speaks coverage, not frequency");

  const oneTeam = await load(
    await buildKpisBoardWorkbook(boardOf(reps.filter((rep) => rep.regionName === "Delta (1)")), "2026-11-09T08:00:00.000Z", {
      doctorLists: true,
      report: "frequency",
    }),
  );
  assert.equal(oneTeam.getWorksheet("Teams"), undefined, "one team is the board itself: no Teams sheet");

  // The open rep's doctors: the Frequency file prints what the Frequency table prints.
  const detail: KpiCoverageDetail = {
    repKey: "1",
    repName: "Hassan",
    covered: [exportDoctor(1, "Dr Basma", plan(3, 2, 1, "below")), exportDoctor(2, "Dr Dalia", plan(2, 2, 3, "above"))],
    notCovered: [exportDoctor(3, "Dr Eman", plan(2, 0, 0, "not-due"))],
  };
  const withDoctors = await load(
    await buildKpisBoardWorkbook(boardOf(reps, detail), "2026-11-09T08:00:00.000Z", { doctorLists: true, report: "frequency" }),
  );
  const doctorsSheet = withDoctors.getWorksheet("Doctors");
  assert.ok(doctorsSheet, "the open rep's Doctors sheet");
  const doctorsTable = tableOf(doctorsSheet, "Doctor");
  for (const header of ["Should visit", "Due so far", "Visited", "Gap", "Visits owed"]) {
    assert.ok(doctorsTable.headers.has(header), `the Frequency Doctors sheet has "${header}"`);
  }
  const line = (name: string) => {
    const found = doctorsTable.rows.find((sheetRow) => cellText(sheetRow.getCell(1)) === name);
    assert.ok(found, `${name} is on the Doctors sheet`);
    return (header: string) => doctorsTable.value(found, header);
  };
  const basma = line("Dr Basma");
  assert.deepEqual(
    ["Should visit", "Due so far", "Visited", "Gap", "Visits owed"].map((header) => basma(header)),
    [3, 2, 1, "1 short", 1],
    "short against what has come due, in the screen's own words",
  );
  assert.equal(line("Dr Dalia")("Gap"), "1 extra");
  assert.equal(line("Dr Dalia")("Visits owed"), 0, "an extra visit owes nothing");
  assert.equal(line("Dr Eman")("Visits owed"), 0, "a doctor not due owes nothing");

  const coverageDoctors = await load(
    await buildKpisBoardWorkbook(boardOf(reps, detail), "2026-11-09T08:00:00.000Z", { doctorLists: true }),
  );
  const coverageDoctorTable = tableOf(coverageDoctors.getWorksheet("Doctors")!, "Doctor");
  assert.ok(!coverageDoctorTable.headers.has("Gap"), "the Coverage export's Doctors sheet keeps its own columns");
}

// ── 6. The finish and the wiring, read in the source ────────────────────────────────────────────

function checkSource() {
  const panels = stripComments(read("src/components/crm/kpi-frequency-panels.tsx"));
  assert.ok(!panels.includes('"use client"'), "markup only: the board stays a server component");
  for (const banned of ["gradient", "shadow-", "rounded", "blur", "glow", "min-w-[", "overflow-x-auto", "truncate", "text-ellipsis"]) {
    assert.ok(!panels.includes(banned), `the frequency panels are flat, square and never scroll sideways: no ${banned}`);
  }
  assert.ok(!panels.includes("cn("), "text-phx-* never goes through cn()");
  assert.ok(panels.includes("table-fixed"), "the teams side by side are a fixed-layout table");
  assert.ok(panels.includes("md:hidden"), "with their rows as a list on a phone");

  const library = stripComments(read("src/lib/crm/kpi-frequency-teams.ts"));
  assert.ok(library.includes("sumKpiTeamTotals(rows)") && library.includes("kpiTeamFigures(totals, rules)"), "a team's frequency is the tile's own arithmetic");
  assert.ok(!/floor/i.test(library), "frequency has no floor; nothing here invents one");

  const view = stripComments(read("src/components/crm/kpis-board-view.tsx"));
  assert.ok(view.includes("<KpiFrequencyStanding board={board} />"), "the Frequency page says where the team stands");
  assert.ok(view.includes("<KpiTeamFrequencyRollup phoenix={phoenix} teams={frequencyTeams} />"), "and puts the teams side by side");
  assert.ok(view.includes("kpiFrequencyExtraTiles(board).map((tile) =>"), "the extra tiles come from the library, as plain figures");
  assert.ok(
    view.includes("<KpiFrequencyTeamHeadingRow columns={5} entry={section.entry} phoenix={phoenix} />"),
    "a heading row per team spans the Frequency table's five columns",
  );

  const route = stripComments(read("app/api/crm/kpis-export/route.ts"));
  assert.ok(route.includes("report"), "the export route hands the report to the workbook, so the file speaks the tab's measure");

  assert.deepEqual(
    [...KPI_FLAGS_OFF_REPORT.frequency].sort(),
    ["below-am-target", "below-coverage-floor", "below-pm-target", "campaign-heavy", "campaign-only-days"],
    "the Frequency row leaves the call-rate and coverage flags to their own reports",
  );
}

export async function runKpiFrequencyPremiumTests() {
  checkTeamFrequency();
  checkPhoenixRules();
  checkMixes();
  checkSentenceAndTiles();
  await checkWorkbook();
  checkSource();
}
