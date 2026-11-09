import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ExcelJS from "exceljs";

import type { RepCallRate } from "../src/lib/crm/call-rate.ts";
import {
  groupKpiRepsByTeam,
  isKpiSentinelBrick,
  KPI_TEAM_NO_MANAGER,
  KPI_TEAM_NO_REGION,
  kpiBrickBandMix,
  kpiBrickCoveragePct,
  kpiBricksMostLeft,
  kpiBricksNotReached,
  kpiBrickTotals,
  kpiCoverageBandMix,
  kpiCoverageFloorCount,
  kpiMeterWidth,
  kpiNotValidatedTotal,
  kpiSharePercents,
  kpiTeamCoverage,
  kpiTeamHeading,
  kpiTeamIdentityOf,
} from "../src/lib/crm/kpi-coverage-teams.ts";
import { joinKpiRows, sumKpiTeamTotals, type KpiDirectoryEntry, type KpiRepRow, type KpisBoard } from "../src/lib/crm/kpis-board.ts";
import { buildKpisBoardWorkbook } from "../src/lib/crm/kpis-board-workbook.ts";
import type { KpiBrickRow } from "../src/lib/crm/kpis-brick-table.ts";
import { KPI_DOCTOR_BRICK_NONE, KPI_DOCTOR_NOT_VALIDATED } from "../src/lib/crm/kpis-doctor-filters.ts";
import type { RepDoctorListRepRow } from "../src/lib/crm/rep-doctor-lists.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * THE COVERAGE REPORT'S PREMIUM PASS (owner, 9 Nov 2026: "eyeball every report in My Team's Reports,
 * premium polish big work, every single component", then "group reps by district manager").
 *
 * What would go wrong, each without an error anyone could see:
 *
 *   1. a team heading whose figures do not add up to the Coverage tile — a regional manager adds the
 *      teams in his head, gets a different number from the tile, and stops trusting both;
 *   2. a rep filed under nobody, or under two teams, so the headings no longer account for the board;
 *   3. a rank disc that restarts at 1 under every heading, crowning a rep who is fifth on the board;
 *   4. a "Not validated yet" total of 0 after a failed brick read, which would call every doctor
 *      validated — the exact rule `notValidatedDoctors` already keeps;
 *   5. "Not validated yet" listed among the bricks nobody has reached, though no rep can walk into it;
 *   6. the gloss finish (gradients, glow, drop shadows) creeping back into the KPIs kit after the owner
 *      retired it on 22 Oct 2026.
 *
 * The arithmetic is checked on fixed rows, the workbook is read back cell by cell, and the finish is
 * checked in the source with its comments stripped, so a comment that names a gradient is not a gradient.
 */

const root = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const read = (path: string) => readFileSync(root(path), "utf8");

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────

type RowShape = {
  name: string;
  region: string | null;
  manager: string | null;
  planned: number;
  visited: number;
  justStarted?: boolean;
  offPlan?: number;
  notValidated?: number | null;
};

/** A rep row with only what the Coverage arithmetic and `sumKpiTeamTotals` read. */
function row(shape: RowShape): KpiRepRow {
  const measurable = shape.planned > 0;
  const coveragePct = measurable ? Math.round((shape.visited / shape.planned) * 100) : 0;
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
    visitedDoctors: shape.visited,
    missedDoctors: shape.planned - shape.visited,
    coveragePct,
    meetsCoverageFloor: measurable ? coveragePct >= 95 : null,
    hasMeasurablePlan: measurable,
    onPlanDoctors: 0,
    underDoctors: 0,
    overDoctors: 0,
    frequencyPct: 0,
    offPlanDoctors: shape.offPlan ?? 0,
    ...(shape.notValidated === undefined ? {} : { notValidatedDoctors: shape.notValidated }),
  } as unknown as KpiRepRow;
}

function brick(brickKey: string, planned: number, covered: number, label = brickKey): KpiBrickRow {
  return { brick: brickKey, label, reps: 1, planned, covered, judged: covered, onPlan: 0, below: covered, above: 0, notVisited: planned - covered, ungraded: 0 };
}

// ── 1. Every rep under his region and manager, once ─────────────────────────────────────────────

function checkGrouping() {
  // The board's own order (here, as if sorted by coverage): the teams must not reorder the reps inside them.
  const rows = [
    row({ name: "Hassan", region: "Delta (1)", manager: "Nermeen Salah", planned: 113, visited: 74 }),
    row({ name: "Momen", region: "Alex-BHR", manager: "Mohamed Eleiwa", planned: 105, visited: 30 }),
    row({ name: "Nada", region: "Delta (1)", manager: "Nermeen Salah", planned: 96, visited: 55 }),
    row({ name: "Floater", region: null, manager: "Hany Saad", planned: 10, visited: 5 }),
    row({ name: "Mostafa", region: "alex-bhr", manager: "mohamed eleiwa", planned: 115, visited: 44 }),
    row({ name: "Orphan", region: "Alex-BHR", manager: null, planned: 20, visited: 10 }),
  ];
  const teams = groupKpiRepsByTeam(rows);

  assert.deepEqual(
    teams.map((team) => kpiTeamHeading(team)),
    ["Alex-BHR · Mohamed Eleiwa", `Alex-BHR · ${KPI_TEAM_NO_MANAGER}`, "Delta (1) · Nermeen Salah", `${KPI_TEAM_NO_REGION} · Hany Saad`],
    "teams read by region then manager, a missing manager last in its region and a missing region last of all",
  );
  assert.deepEqual(
    teams[0].members.map((member) => member.row.repName),
    ["Momen", "Mostafa"],
    "the same region and manager in another case is the SAME team, and the board's order is kept inside it",
  );
  assert.deepEqual(
    teams.flatMap((team) => team.members.map((member) => member.boardIndex)).sort((a, b) => a - b),
    [0, 1, 2, 3, 4, 5],
    "every rep lands in exactly one team, so the team sizes add up to the reps tile",
  );
  assert.deepEqual(
    teams[2].members.map((member) => member.boardIndex),
    [0, 2],
    "each rep keeps his place on the WHOLE board, so a rank disc never restarts at 1 under a heading",
  );
  assert.equal(teams[1].managerMissing, true);
  assert.equal(teams[3].regionMissing, true);
  assert.equal(kpiTeamIdentityOf({ regionName: "  ", managerName: "" }).regionName, KPI_TEAM_NO_REGION, "a blank region is a missing one");
  assert.deepEqual(groupKpiRepsByTeam([]), [], "no rows, no teams");
}

// ── 2. A team's coverage is the board's own arithmetic, and the teams add up to the tile ────────

function checkTeamCoverage() {
  const rows = [
    row({ name: "A", region: "R1", manager: "M1", planned: 100, visited: 96, offPlan: 3 }),
    row({ name: "B", region: "R1", manager: "M1", planned: 50, visited: 20, offPlan: 1 }),
    row({ name: "New", region: "R1", manager: "M1", planned: 40, visited: 2, justStarted: true, offPlan: 9 }),
    row({ name: "C", region: "R2", manager: "M2", planned: 60, visited: 30 }),
    row({ name: "No plan", region: "R2", manager: "M2", planned: 0, visited: 0 }),
  ];
  const teams = groupKpiRepsByTeam(rows);
  const coverages = teams.map((team) =>
    kpiTeamCoverage(
      team.members.map((member) => member.row),
      "legacy",
    ),
  );
  const whole = sumKpiTeamTotals(rows);
  assert.equal(
    coverages.reduce((sum, coverage) => sum + coverage.planned, 0),
    whole.plannedDoctors,
    "the teams' planned doctors add up to the Coverage tile's own denominator",
  );
  assert.equal(
    coverages.reduce((sum, coverage) => sum + coverage.covered, 0),
    whole.visitedDoctors,
    "the teams' covered doctors add up to the Coverage tile's own numerator",
  );

  const [first, second] = coverages;
  assert.equal(first.reps, 3, "a rep who has just started is still a head in his team");
  assert.equal(first.justStarted, 1);
  assert.equal(first.judgedReps, 2);
  assert.equal(first.planned, 150, "…and nothing else: his 40 planned doctors stay out of the team's list, as they do in the tile");
  assert.equal(first.covered, 116);
  assert.equal(first.notReached, 34);
  assert.equal(first.coveragePct, 77, "116 of 150, rounded as the tile rounds");
  assert.equal(first.band, "strong");
  assert.deepEqual([first.atFloor, first.withPlan], [1, 2], "one of the two judged reps with a plan clears the 95% floor");
  assert.equal(first.offPlan, 4, "off-plan doctors are counted for judged reps only");

  assert.equal(second.withPlan, 1, "a rep with no plan is in neither floor count");
  assert.equal(second.coveragePct, 50);

  const noPlan = kpiTeamCoverage([row({ name: "Z", region: "R", manager: "M", planned: 0, visited: 0 })], "legacy");
  assert.equal(noPlan.coveragePct, null, "a team with nothing planned reads No plan, never 0%");
  assert.equal(noPlan.band, "noplan");
}

// ── 3. The reps by band, the floor and the not-validated total ──────────────────────────────────

function checkStanding() {
  const rows = [
    row({ name: "Elite", region: "R", manager: "M", planned: 100, visited: 95 }),
    row({ name: "Strong", region: "R", manager: "M", planned: 100, visited: 80 }),
    row({ name: "Steady", region: "R", manager: "M", planned: 100, visited: 60 }),
    row({ name: "Behind", region: "R", manager: "M", planned: 100, visited: 10 }),
    row({ name: "Never", region: "R", manager: "M", planned: 59, visited: 0 }),
    row({ name: "New", region: "R", manager: "M", planned: 27, visited: 11, justStarted: true }),
    row({ name: "Empty", region: "R", manager: "M", planned: 0, visited: 0 }),
  ];
  const mix = kpiCoverageBandMix(rows);
  assert.deepEqual(
    mix.map((slice) => [slice.key, slice.count]),
    [
      ["elite", 1],
      ["strong", 1],
      ["steady", 1],
      ["behind", 2],
      ["just-started", 1],
      ["no-plan", 1],
    ],
    "each rep in exactly one slice: his chip's band, Just started, or No plan",
  );
  assert.equal(
    mix.reduce((sum, slice) => sum + slice.count, 0),
    rows.length,
    "the slices add up to the Medical reps in reach tile",
  );
  assert.deepEqual(kpiCoverageFloorCount(rows), { atFloor: 1, belowFloor: 4 }, "the floor judges reps with a plan who are not just started");

  assert.equal(kpiNotValidatedTotal(rows), null, "not one count read prints nothing, never a 0");
  const read = [
    row({ name: "A", region: "R", manager: "M", planned: 10, visited: 5, notValidated: 23 }),
    row({ name: "B", region: "R", manager: "M", planned: 10, visited: 5, notValidated: 0 }),
    row({ name: "C", region: "R", manager: "M", planned: 10, visited: 5, notValidated: null }),
    row({ name: "D", region: "R", manager: "M", planned: 10, visited: 5, notValidated: 1 }),
  ];
  assert.deepEqual(kpiNotValidatedTotal(read), { doctors: 24, reps: 2 }, "the read counts add up; an unread one is skipped, not a 0");
}

// ── 4. The bricks at a glance ───────────────────────────────────────────────────────────────────

function checkBricks() {
  const rows = [
    brick("Mahalla", 47, 33),
    brick("Samanoud", 18, 18),
    brick("Tanta", 32, 17),
    brick("Sidi Talha", 13, 0),
    brick("Bella", 12, 0),
    brick("Tukh", 12, 11),
    brick("Ezbet", 10, 1),
    brick(KPI_DOCTOR_BRICK_NONE, 4, 0, "Validated · no brick on record"),
    brick(KPI_DOCTOR_NOT_VALIDATED, 206, 23, "Not validated yet"),
  ];
  assert.equal(isKpiSentinelBrick(rows[8]), true);
  assert.equal(isKpiSentinelBrick(rows[0]), false);

  const mix = kpiBrickBandMix(rows);
  assert.deepEqual(
    mix.map((slice) => [slice.key, slice.count]),
    [
      ["full", 1],
      ["elite", 1],
      ["strong", 0],
      ["steady", 2],
      ["behind", 1],
      ["untouched", 2],
    ],
    "Samanoud fully covered, Tukh 92%, Mahalla 70% and Tanta 53%, Ezbet 10%, and two bricks nobody has reached",
  );
  assert.equal(
    mix.reduce((sum, slice) => sum + slice.count, 0),
    kpiBrickTotals(rows).bricks,
    "the slices add up to the real bricks — the two sentinel lines are not places",
  );
  assert.deepEqual(kpiBrickTotals(rows), { bricks: 7, planned: 144, covered: 80 });

  assert.deepEqual(
    kpiBricksNotReached(rows).map((entry) => entry.label),
    ["Sidi Talha", "Bella"],
    "the bricks nobody has reached, the largest first; 'no brick on record' is never listed though it is at 0",
  );
  assert.deepEqual(
    kpiBricksMostLeft(rows, 3).map((entry) => [entry.label, entry.left]),
    [
      ["Tanta", 15],
      ["Mahalla", 14],
      ["Ezbet", 9],
    ],
    "most left to see: reached bricks only, by planned doctors not seen yet, capped for the chart",
  );
  assert.ok(
    !kpiBricksMostLeft(rows, 20).some((entry) => entry.brick === KPI_DOCTOR_NOT_VALIDATED),
    "'Not validated yet' never appears among the bricks with most left: no rep can walk into it",
  );
  assert.equal(kpiBrickCoveragePct(rows[0]), 70, "a brick's coverage is the brick table's own covered ÷ planned");
  assert.equal(kpiBrickCoveragePct(brick("X", 0, 0)), null);
  assert.deepEqual(kpiBrickBandMix([]).map((slice) => slice.count), [0, 0, 0, 0, 0, 0]);
}

// ── 5. The bar's arithmetic ─────────────────────────────────────────────────────────────────────

function checkShares() {
  assert.deepEqual(kpiSharePercents([1, 1, 1]), [34, 33, 33], "thirds add up to 100, the first remainder taking the rounding");
  assert.deepEqual(kpiSharePercents([353, 416]), [46, 54], "the planned list's two slices, as the tile reads 46%");
  assert.deepEqual(kpiSharePercents([0, 0]), [0, 0], "an all-zero bar is zeros, never NaN");
  assert.deepEqual(kpiSharePercents([0, 5]), [0, 100], "an empty slice never takes the rounding");
  for (const counts of [[3, 7, 11], [1, 2, 3, 4, 5, 6], [999, 1], [2, 2, 2, 2, 2, 2, 2]]) {
    assert.equal(kpiSharePercents(counts).reduce((sum, value) => sum + value, 0), 100, `${counts.join("/")} adds up to 100`);
  }
  assert.equal(kpiMeterWidth(15, 15), 100);
  assert.equal(kpiMeterWidth(7, 14), 50);
  assert.equal(kpiMeterWidth(5, 0), 0, "a largest of 0 is an empty track, never a full one");
  assert.equal(kpiMeterWidth(0, 10), 0);
}

// ── 6. The workbook: a Teams sheet, and Region beside Manager ───────────────────────────────────

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
    workingDays: 5,
  };
}

function docList(agentCrmId: number, agentHrId: string, repName: string, planned: number, visited: number): RepDoctorListRepRow {
  return {
    actualCalls: visited,
    agentCrmId,
    agentHrId,
    campaignCalls: 0,
    coverageDueDoctors: planned,
    coveragePct: Math.round((visited / planned) * 100),
    frequencyPct: 0,
    gradeA: 0,
    gradeB: 0,
    gradeC: 0,
    hasMeasurablePlan: true,
    missedDoctors: planned - visited,
    notDueDoctors: 0,
    offPlanDoctors: 2,
    onPlanDoctors: 0,
    overDoctors: 0,
    plannedAccounts: 0,
    plannedCalls: planned,
    plannedCallsToDate: planned,
    plannedDoctors: planned,
    plannedUnclassified: 0,
    repKey: String(agentCrmId),
    repName,
    underDoctors: 0,
    underPlannedVsGrade: 0,
    unverifiedCalls: 0,
    visitedDoctors: visited,
  };
}

function directoryEntry(hrId: string, displayName: string, regionName: string, managerName: string): KpiDirectoryEntry {
  return { hrId, displayName, lineName: "Pedia", regionName, areaName: "Area", managerName, jobTitle: "Medical Representative" };
}

function boardOf(reps: KpisBoard["reps"]): KpisBoard {
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
    totals: { reps: reps.length, coveragePct: 46, frequencyPct: 6, amAttainmentPct: 77, pmAttainmentPct: 68 },
    kpiIndex: { overallPct: 43, method: "The average of coverage, frequency, AM and PM." },
    holidaysComplete: true,
    amTarget: 2,
    pmTarget: 10,
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

async function checkWorkbook() {
  const reps = joinKpiRows({
    callRates: [callRate(1, "P-1", "Hassan"), callRate(2, "P-2", "Momen"), callRate(3, "P-3", "Nada")],
    docLists: [docList(1, "p-1", "Hassan", 113, 74), docList(2, "p-2", "Momen", 105, 30), docList(3, "p-3", "Nada", 96, 55)],
    scope: { basis: "company", kind: "company", label: "Whole company" },
    workingDays: 5,
    directory: [
      directoryEntry("P-1", "Hassan", "Delta (1)", "Nermeen Salah"),
      directoryEntry("P-2", "Momen", "Alex-BHR", "Mohamed Eleiwa"),
      directoryEntry("P-3", "Nada", "Delta (1)", "Nermeen Salah"),
    ],
  });
  assert.equal(reps.length, 3, "the three reps are on the board");

  const load = async (buffer: Buffer) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    return workbook;
  };

  const coverage = await load(await buildKpisBoardWorkbook(boardOf(reps), "2026-11-09T08:00:00.000Z", { doctorLists: true }));
  const teamsSheet = coverage.getWorksheet("Teams");
  assert.ok(teamsSheet, `the Coverage export carries a Teams sheet (${coverage.worksheets.map((sheet) => sheet.name).join(", ")})`);
  const teams = tableOf(teamsSheet, "Region");
  assert.deepEqual(
    teams.rows.map((sheetRow) => `${cellText(sheetRow.getCell(1))} · ${String(teams.value(sheetRow, "Manager"))}`),
    ["Alex-BHR · Mohamed Eleiwa", "Delta (1) · Nermeen Salah"],
    "one line per region and manager, in the screen's own order",
  );
  const delta = teams.rows[1];
  assert.equal(teams.value(delta, "Reps"), 2);
  assert.equal(teams.value(delta, "Doctors planned"), 209, "113 + 96: the team's list is its reps' lists added");
  assert.equal(teams.value(delta, "Doctors visited"), 129);
  assert.equal(teams.value(delta, "Not reached"), 80);
  const plannedTotal = teams.rows.reduce((sum, sheetRow) => sum + Number(teams.value(sheetRow, "Doctors planned")), 0);
  assert.equal(plannedTotal, 314, "the Teams sheet's planned doctors add up to the whole board's");

  const repsSheet = coverage.getWorksheet("Medical reps");
  assert.ok(repsSheet, "the Medical reps sheet");
  const repsTable = tableOf(repsSheet, "Medical rep");
  assert.ok(repsTable.headers.has("Region"), "Region sits on the reps sheet beside Manager, so the file groups like the screen");
  assert.equal(
    (repsTable.headers.get("Region") ?? 0) + 1,
    repsTable.headers.get("Manager"),
    "Region is the column right before Manager",
  );

  const plain = await load(await buildKpisBoardWorkbook(boardOf(reps), "2026-11-09T08:00:00.000Z"));
  assert.equal(plain.getWorksheet("Teams"), undefined, "the Summary and Call Rate exports carry no Teams sheet");

  const oneTeam = await load(
    await buildKpisBoardWorkbook(boardOf(reps.filter((rep) => rep.regionName === "Delta (1)")), "2026-11-09T08:00:00.000Z", {
      doctorLists: true,
    }),
  );
  assert.equal(oneTeam.getWorksheet("Teams"), undefined, "one team is the board itself: no Teams sheet");
}

// ── 7. The finish and the wiring, read in the source ────────────────────────────────────────────

function checkSource() {
  const panels = stripComments(read("src/components/crm/kpi-coverage-panels.tsx"));
  const chrome = stripComments(read("src/components/crm/kpis-chrome.tsx"));
  const view = stripComments(read("src/components/crm/kpis-board-view.tsx"));
  const trend = stripComments(read("src/components/crm/kpis-trend-view.tsx"));

  assert.ok(!/^\s*["']use client["']/m.test(read("src/components/crm/kpi-coverage-panels.tsx")), "the panels stay a server component");

  // The flat finish (owner, 22 Oct 2026). A gradient, an arbitrary shadow or a glow in any of the KPIs files is the gloss coming back.
  const gloss = /bg-gradient-|linear-gradient|shadow-\[|drop-shadow|\.grad\b|backdrop-blur/;
  for (const [name, source] of [
    ["kpi-coverage-panels.tsx", panels],
    ["kpis-chrome.tsx", chrome],
    ["kpis-board-view.tsx", view],
    ["kpis-trend-view.tsx", trend],
  ] as const) {
    const hit = gloss.exec(source);
    assert.equal(hit, null, `${name}: "${hit?.[0]}" — the KPIs board is flat colour, no gradient, glow or drop shadow`);
  }

  // The house rules every new part keeps: square corners, no sideways scroll, no width floor, no ellipsis.
  const banned = /\brounded(?:-[a-z0-9]+)?\b|overflow-x-(?:auto|scroll)|min-w-\[|\btruncate\b|text-ellipsis|line-clamp-/;
  const bannedHit = banned.exec(panels);
  assert.equal(bannedHit, null, `kpi-coverage-panels.tsx: "${bannedHit?.[0]}" breaks a house rule`);

  // Every colgroup in the panels totals 100%.
  for (const colgroup of panels.matchAll(/<colgroup>([\s\S]*?)<\/colgroup>/g)) {
    const widths = [...colgroup[1].matchAll(/width: "(\d+(?:\.\d+)?)%"/g)].map((match) => Number(match[1]));
    assert.equal(widths.reduce((sum, width) => sum + width, 0), 100, `a colgroup in the panels totals ${widths.join(" + ")}`);
  }

  // The wiring: the teams are built once, from the board's rows, on the Coverage tab only.
  assert.match(
    view,
    /tab === "coverage" && board\.reps\.length > 1\s*\?\s*kpiTeamsWithCoverage\(groupKpiRepsByTeam\(board\.reps\), board\.kpiRules\)/,
    "the teams come from the board's own rows, on the Coverage tab, for a board of more than one rep",
  );
  assert.match(view, /<CoverageTable context=\{context\} rows=\{board\.reps\} teams=\{coverageTeams\} \/>/, "the desktop table is handed the teams");
  assert.match(view, /cardSlots\(coverageTeams, board\.reps\)/, "the phone cards are filed under the same teams");
  assert.match(view, /<KpiTeamHeadingRow columns=\{6\} entry=\{section\.entry\} \/>/, "a team's heading spans the table's six columns");
  assert.match(
    view,
    /section\.members\.map\(\(\{ boardIndex: index, row \}\)/,
    "a row's rank comes from its place on the whole board, never its place in the team",
  );
  assert.match(view, /context\.tab === "coverage" \? <KpiBrickGlance rows=\{rows\} \/> : null/, "the bricks at a glance sit on the Coverage tab only");
  assert.match(
    view,
    /reportPage && tab === "coverage" && !solo\s*\?\s*kpiCoverageExtraTiles\(board\)/,
    "the extra tiles fill the Coverage report page's row, never a rep's own board or the admin tab",
  );
  assert.match(view, /<KpiCoverageStanding board=\{board\} \/>/, "where the team stands is drawn");
  assert.match(view, /<KpiTeamCoverageRollup floorPct=\{board\.coverageFloorPct\} teams=\{coverageTeams\} \/>/, "the teams at a glance are drawn");

  // The three surfaces read the same teams, so a fourth list that might disagree cannot be added quietly.
  assert.equal((view.match(/\bcoverageTeams\b/g) ?? []).length, 5, "coverageTeams: one definition, one guard and three reads — the roll-up, the phone cards, the table");
}

export async function runKpiCoveragePremiumTests() {
  checkGrouping();
  checkTeamCoverage();
  checkStanding();
  checkBricks();
  checkShares();
  await checkWorkbook();
  checkSource();
}
