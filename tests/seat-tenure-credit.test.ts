import assert from "node:assert/strict";

import { repBoardRows, repMembersFromRows } from "../src/lib/employee-portal/sos-team-performance.ts";
import { reconcileUnattributed } from "../src/lib/employee-portal/performance-reconciliation.ts";
import type { AchievementRow } from "../src/lib/sales/monthly-targets.ts";
import { indexSalesSeats } from "../src/lib/sales/seat-hierarchy.ts";
import { creditRepRowsByTenure, seatHolderOn, type SeatTenure } from "../src/lib/sales/seat-tenure-credit.ts";
import { totalRows } from "../src/lib/sales/vs-target.ts";

/**
 * Owner, 26 Oct 2026 (multiple-choice answer, "Person who made them"): a seat's past sales rank the
 * PERSON WHO MADE THEM. The National Sales Manager's Top Reps board ranked Jonia Wageh, Ganat Ragab
 * and Aya Mamdouh — all hired in October 2026 — on July–September sales, because the engine credits
 * every past month of an occupied seat to today's holder. The fixture is the live Pedia seat history.
 */
export function runSeatTenureCreditTests() {
  const tenure: SeatTenure = {
    stretches: [
      // Pedia UE1: Sherouk Wael to 29 Aug, vacant, then Jonia Wageh SEATED 20 Sep — eleven days
      // before her hire date. Occupancy alone would still give her September.
      { seatId: "SEAT-PED-REP-UE1", occupantHrId: "B-34", effectiveFrom: "2026-01-01", effectiveTo: "2026-08-29" },
      { seatId: "SEAT-PED-REP-UE1", occupantHrId: "PD-0016", effectiveFrom: "2026-09-20", effectiveTo: null },
      // Pedia UE5: Gerges Sameh to 6 Aug, vacant, then Ganat Ragab from 5 Oct.
      { seatId: "SEAT-PED-REP-UE5", occupantHrId: "B-112", effectiveFrom: "2026-01-01", effectiveTo: "2026-08-06" },
      { seatId: "SEAT-PED-REP-UE5", occupantHrId: "PD-0024", effectiveFrom: "2026-10-05", effectiveTo: null },
      // Pedia GZ4: Hana Abdelaziz through 31 Oct, Aya Mamdouh seated alongside her from 19 Oct.
      { seatId: "SEAT-PED-REP-GZ4", occupantHrId: "B-110", effectiveFrom: "2026-01-17", effectiveTo: "2026-11-01" },
      { seatId: "SEAT-PED-REP-GZ4", occupantHrId: "PD-0029", effectiveFrom: "2026-10-19", effectiveTo: null },
      // A rep with no hire date on file is never blocked by it.
      { seatId: "SEAT-PED-REP-AB1", occupantHrId: "B-50", effectiveFrom: "2026-01-01", effectiveTo: null },
    ],
    employment: new Map([
      ["b-34", { hireDate: "2024-03-01", lastWorkingDate: "2026-08-28" }],
      ["pd-0016", { hireDate: "2026-10-01", lastWorkingDate: null }],
      ["b-112", { hireDate: "2023-05-01", lastWorkingDate: "2026-08-05" }],
      ["pd-0024", { hireDate: "2026-10-11", lastWorkingDate: null }],
      ["b-110", { hireDate: "2026-01-17", lastWorkingDate: "2026-10-31" }],
      ["pd-0029", { hireDate: "2026-10-24", lastWorkingDate: null }],
      ["b-50", { hireDate: null, lastWorkingDate: null }],
    ]),
  };

  // ── Who held the seat on the month's last day, and was employed that day ──
  assert.equal(seatHolderOn(tenure, "SEAT-PED-REP-UE1", "2026-07-31"), "B-34", "July is Sherouk's");
  assert.equal(seatHolderOn(tenure, "SEAT-PED-REP-UE1", "2026-08-31"), null, "the seat was vacant at August's end");
  assert.equal(
    seatHolderOn(tenure, "SEAT-PED-REP-UE1", "2026-09-30"),
    null,
    "Jonia was seated on 20 September but hired on 1 October — September is nobody's",
  );
  assert.equal(seatHolderOn(tenure, "SEAT-PED-REP-UE1", "2026-10-31"), "PD-0016", "October is Jonia's");
  assert.equal(seatHolderOn(tenure, "SEAT-PED-REP-GZ4", "2026-09-30"), "B-110", "Hana keeps her September");
  assert.equal(seatHolderOn(tenure, "SEAT-PED-REP-AB1", "2026-09-30"), "B-50", "a missing hire date blocks nothing");
  const notYetHired: SeatTenure = {
    stretches: tenure.stretches,
    employment: new Map([...tenure.employment, ["pd-0029", { hireDate: "2026-11-03", lastWorkingDate: null }]]),
  };
  assert.equal(
    seatHolderOn(notYetHired, "SEAT-PED-REP-GZ4", "2026-10-31"),
    "B-110",
    "a successor seated before his hire date never pushes out the rep still working the seat",
  );

  // ── The engine's rows: every month of an occupied seat credited to today's holder ──
  const engineRow = (period: string, repSeatId: string, repHrId: string, value: number, target: number): AchievementRow => ({
    period,
    lineCode: "pedia",
    regionCode: "UE",
    areaCode: repSeatId.slice(-3),
    areaState: null,
    isOther: false,
    repSeatId,
    repHrId,
    dmSeatId: "DM-UE",
    dmHrId: "D-1",
    productCode: "P1",
    actualUnits: 10,
    actualValue: value,
    targetUnits: 10,
    targetValue: target,
    achievementValue: null,
    achievementUnits: null,
    hasTarget: true,
    hasActual: true,
  });
  const rows: AchievementRow[] = [];
  for (const period of ["2026-07", "2026-08", "2026-09"]) {
    rows.push(engineRow(period, "SEAT-PED-REP-UE1", "PD-0016", 1000, 1200));
    rows.push(engineRow(period, "SEAT-PED-REP-UE5", "PD-0024", 800, 1000));
    rows.push(engineRow(period, "SEAT-PED-REP-GZ4", "PD-0029", 600, 500));
    rows.push(engineRow(period, "SEAT-PED-REP-AB1", "B-50", 400, 400));
  }
  rows.push({ ...engineRow("2026-08", "", "", 250, 0), repSeatId: null, repHrId: null, hasTarget: false });

  const credited = creditRepRowsByTenure(rows, tenure);
  assert.equal(credited.length, rows.length, "no row is added or dropped");
  assert.deepEqual(
    credited.map((row) => [row.actualValue, row.targetValue, row.productCode, row.period, row.repSeatId]),
    rows.map((row) => [row.actualValue, row.targetValue, row.productCode, row.period, row.repSeatId]),
    "only WHO a row is credited to changes — never a number",
  );

  // ── The Top Reps board: no October hire ranks on July–September ──
  const seats = indexSalesSeats([
    { seat_id: "DM-UE", parent_seat_id: null, seat_tier: "DM", line_code: "pedia", region_name: "Upper Egypt", occupant_hr_id: "D-1", is_other_pseudo_dm: false },
  ]);
  const names = new Map([
    ["B-34", "Sherouk Wael"],
    ["B-112", "Gerges Sameh"],
    ["B-110", "Hana Abdelaziz"],
    ["B-50", "Basma Rep"],
    ["PD-0016", "Jonia Wageh"],
    ["PD-0024", "Ganat Ragab"],
    ["PD-0029", "Aya Mamdouh"],
    ["D-1", "Dina District"],
  ]);
  const board = repMembersFromRows(repBoardRows(rows, tenure), names, new Map(), seats);
  const ranked = new Map(board.map((member) => [member.hrId, member]));
  for (const hire of ["PD-0016", "PD-0024", "PD-0029"]) {
    assert.equal(ranked.has(hire), false, `${names.get(hire)} was hired in October and must not rank for July–September`);
  }
  assert.equal(ranked.get("B-34")?.totalSales, 1000, "Sherouk keeps the July she made on UE1");
  assert.equal(ranked.get("B-112")?.totalSales, 800, "Gerges keeps the July he made on UE5");
  assert.equal(ranked.get("B-110")?.totalSales, 1800, "Hana keeps July to September on GZ4");
  assert.equal(ranked.get("B-50")?.totalSales, 1200, "an unchanged seat keeps every month");

  // ── Every total stays the published one; the months nobody held are "not attributed to a rep" ──
  const totals = totalRows(rows);
  const { unattributedSales } = reconcileUnattributed(
    { sales: totals.actualValue, target: totals.targetValue },
    board,
  );
  assert.equal(
    unattributedSales,
    250 + 2 * 1000 + 2 * 800,
    "the vacant-seat months and the row with no seat land in the unattributed figure, never out of the total",
  );

  // ── Off (the expense forms' rep list): today's holders, exactly as before ──
  assert.equal(repBoardRows(rows, null), rows, "with no seat history the rows are returned untouched");
}
