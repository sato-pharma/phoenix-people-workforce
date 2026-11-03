import assert from "node:assert/strict";
import fs from "node:fs";

import {
  boardTotals,
  closingAreaCodesFor,
  closingForSeat,
  countVisitsSinceEmpty,
  emptySinceFor,
  rankEmptySeats,
  seatInBound,
  type EmptySeatClosing,
  type EmptySeatRow,
} from "../src/lib/reports/empty-seats.ts";
import type { AchievementRow } from "../src/lib/sales/monthly-targets.ts";

/**
 * The Empty Seats board ranks real hiring decisions by real sales, so what it must never do is draw an
 * unknown as a zero, count one area's sales twice, or show a seat past the viewer's own sales bound.
 */
function achievementRow(overrides: Partial<AchievementRow>): AchievementRow {
  return {
    achievementUnits: null,
    achievementValue: null,
    actualUnits: 10,
    actualValue: 1000,
    areaCode: "UE7",
    areaState: null,
    dmHrId: null,
    dmSeatId: null,
    hasActual: true,
    hasTarget: true,
    isOther: false,
    lineCode: "cns",
    period: "2026-09",
    productCode: "P1",
    regionCode: "UE",
    repHrId: null,
    repSeatId: null,
    targetUnits: 20,
    targetValue: 2000,
    ...overrides,
  };
}

const figures = (salesValue: number, targetValue: number | null = 100): EmptySeatClosing => ({
  achievement: null,
  periodLabel: "September 2026",
  salesValue,
  state: "figures",
  targetValue,
});

function seatRow(overrides: Partial<EmptySeatRow> & { areaName: string }): EmptySeatRow {
  return {
    closing: figures(0),
    closingKey: `CNS|${overrides.areaName}`,
    contactCount: 0,
    emptySince: null,
    key: overrides.areaName,
    lastRepName: null,
    lineName: "CNS",
    managerVisits: 0,
    parked: false,
    pharmacyCount: 0,
    regionName: "Upper Egypt",
    seatId: overrides.areaName,
    seatVisits: 0,
    ...overrides,
  };
}

export async function runVacanciesEmptySeatsTests() {
  // ── No row is not zero, and a failed read is not zero ──
  const twoProducts = [
    achievementRow({ actualValue: 1000, productCode: "P1", targetValue: 2000 }),
    achievementRow({ actualValue: 500, productCode: "P2", targetValue: 500 }),
  ];
  const summed = closingForSeat({ areaCode: "ue7", lineCode: "CNS", period: "2026-09", rows: twoProducts });
  assert.equal(summed.state, "figures", "the area's rows are found whatever the spelling of the codes");
  if (summed.state === "figures") {
    assert.equal(summed.salesValue, 1500, "the area's VALUE adds across its products");
    assert.equal(summed.targetValue, 2500);
    assert.equal(summed.achievement, 0.6, "the % comes from totalRows, the Sales vs Target figure");
  }
  assert.equal(
    closingForSeat({ areaCode: "UE9", lineCode: "cns", period: "2026-09", rows: twoProducts }).state,
    "no_row",
    "a published month with no row for the area is unknown, never a zero",
  );
  assert.equal(
    closingForSeat({ areaCode: "UE7", lineCode: "cns", period: null, rows: twoProducts }).state,
    "no_published_month",
  );
  assert.equal(
    closingForSeat({ areaCode: "UE7", lineCode: "cns", period: "2026-09", rows: null }).state,
    "unavailable",
    "a failed read says so, and is not 'no row'",
  );
  assert.equal(
    closingForSeat({ areaCode: "UE7", lineCode: "pedia", period: "2026-09", rows: twoProducts }).state,
    "no_row",
    "another line's row with the same area code is not this seat's",
  );
  assert.equal(
    closingForSeat({ areaCode: "UE7", lineCode: "cns", period: "2026-08", rows: twoProducts }).state,
    "no_row",
    "only the line's own published month counts",
  );
  const noTarget = closingForSeat({
    areaCode: "UE7",
    lineCode: "cns",
    period: "2026-09",
    rows: [achievementRow({ hasTarget: false, targetValue: null })],
  });
  assert.ok(noTarget.state === "figures" && noTarget.targetValue === null && noTarget.achievement === null, "no target is not a zero target");

  // ── The merges are dated: the published month can stand on the other side of one ──
  // Anti Infective folds Suez (OT2) + Ismailia (OT9) from 2026-09, so an August row is still two areas.
  const beforeMerge = closingForSeat({
    areaCode: "OT2",
    lineCode: "anti_infective",
    period: "2026-08",
    rows: [
      achievementRow({ actualValue: 300, areaCode: "OT2", lineCode: "anti_infective", period: "2026-08", targetValue: 400 }),
      achievementRow({ actualValue: 700, areaCode: "OT9", lineCode: "anti_infective", period: "2026-08", targetValue: 600 }),
    ],
  });
  assert.ok(
    beforeMerge.state === "figures" && beforeMerge.salesValue === 1000 && beforeMerge.targetValue === 1000,
    "a seat folded today adds both areas of a month from before the merge, never half under the whole name",
  );
  // Pedia's Fayoum (GZ6) + Beni Suef (UE9) merge stopped after 2026-08: both seats share August's one row.
  const afterMerge = [achievementRow({ actualValue: 900, areaCode: "GZ6", lineCode: "pedia", period: "2026-08", targetValue: 900 })];
  for (const areaCode of ["GZ6", "UE9"]) {
    assert.equal(
      closingForSeat({ areaCode, lineCode: "pedia", period: "2026-08", rows: afterMerge }).state,
      "figures",
      `${areaCode} finds the row its month folded it under`,
    );
  }
  assert.deepEqual(closingAreaCodesFor("pedia", "GZ6", "2026-08"), closingAreaCodesFor("pedia", "UE9", "2026-08"), "one row, one area for the totals");
  assert.deepEqual(closingAreaCodesFor("pedia", "UE9", "2026-09"), ["UE9"], "from September they are two areas again");

  // ── The ranking: every step is a figure on the row ──
  const ranked = rankEmptySeats([
    seatRow({ areaName: "No row", closing: { periodLabel: "September 2026", state: "no_row" }, emptySince: { date: "2026-01-01", days: 300, source: "last_rep" } }),
    seatRow({ areaName: "Small", closing: figures(10) }),
    seatRow({ areaName: "Big", closing: figures(1000) }),
    seatRow({ areaName: "Zero sold", closing: figures(0) }),
    seatRow({ areaName: "Same sales, larger target", closing: figures(10, 900) }),
    seatRow({ areaName: "Same all, longer empty", closing: figures(0), emptySince: { date: "2026-05-01", days: 180, source: "last_rep" } }),
    seatRow({ areaName: "Unreadable", closing: { state: "unavailable" } }),
  ]).map((row) => row.areaName);
  assert.deepEqual(ranked, [
    "Big",
    "Same sales, larger target",
    "Small",
    "Same all, longer empty",
    "Zero sold",
    "No row",
    "Unreadable",
  ]);

  // ── Totals count an area once ──
  const shared = figures(1000, 2000);
  const totals = boardTotals([
    seatRow({ areaName: "Seat one", closing: shared, closingKey: "CNS|UE7", seatId: "seat-1" }),
    seatRow({ areaName: "Seat two", closing: shared, closingKey: "CNS|UE7", seatId: "seat-2" }),
    seatRow({ areaName: "Same seat, other area", closing: figures(5, 5), closingKey: "CNS|UE8", seatId: "seat-2" }),
    seatRow({ areaName: "Unknown", closing: { state: "unavailable" }, closingKey: "CNS|UE9", seatId: "seat-3" }),
  ]);
  assert.equal(totals.salesTotal, 1005, "two empty seats on one area do not double its sales");
  assert.equal(totals.targetTotal, 2005);
  assert.equal(totals.seatCount, 3, "one seat on two rows is one seat");
  assert.equal(totals.areasWithoutFigures, 1, "an area the sum left out is counted, so the page can say so");

  // ── Who sees what ──
  const cairoCns = { areaCode: "UE7", lineCode: "cns" };
  assert.equal(seatInBound(cairoCns, { kind: "company" }), true);
  assert.equal(seatInBound(cairoCns, { hrId: "B-10", kind: "self" }), false, "a rep's own bound reaches no empty seat");
  assert.equal(seatInBound(cairoCns, { kind: "none" }), false, "an unresolved bound must never mean more");
  assert.equal(seatInBound(cairoCns, { kind: "line", lineCodes: new Set(["cns"]) }), true);
  assert.equal(seatInBound(cairoCns, { kind: "line", lineCodes: new Set(["pedia"]) }), false);
  assert.equal(seatInBound(cairoCns, { areaCodes: new Set(["UE7"]), kind: "areas", lineCodes: null }), true);
  assert.equal(seatInBound(cairoCns, { areaCodes: new Set(["UE1"]), kind: "areas", lineCodes: null }), false);
  assert.equal(
    seatInBound(cairoCns, { areaCodes: new Set(["UE7"]), kind: "areas", lineCodes: new Set(["pedia"]) }),
    false,
    "the area alone is not enough when the bound also names a line",
  );
  // CNS folds Qena 2 (UE8) into Qena 1 (UE7): a manager bound to the kept code reaches the folded seat.
  assert.equal(seatInBound({ areaCode: "UE8", lineCode: "cns" }, { areaCodes: new Set(["UE7"]), kind: "areas", lineCodes: null }), true);
  assert.equal(
    seatInBound({ areaCode: "UE8", lineCode: "anti_infective" }, { areaCodes: new Set(["UE7"]), kind: "areas", lineCodes: null }),
    false,
    "the fold is CNS's own: Anti Infective has two real Qena seats",
  );

  // ── How long it has been empty ──
  const today = "2026-11-03";
  assert.deepEqual(emptySinceFor({ heldUntil: "2026-10-04", openedDates: ["2026-10-20"], today }), {
    date: "2026-10-04",
    days: 30,
    source: "last_rep",
  });
  assert.deepEqual(
    emptySinceFor({ heldUntil: "2026-12-01", openedDates: ["2026-10-24", "2026-10-13"], today }),
    { date: "2026-10-13", days: 21, source: "vacancy_opened" },
    "a notice still running says nothing about today, and the seat's earliest open row wins",
  );
  assert.equal(emptySinceFor({ heldUntil: null, openedDates: [], today }), null, "not recorded, and never 0 days");

  // ── Visits since it emptied ──
  const counted = countVisitsSinceEmpty(
    [
      { seatId: "seat-1", visitDate: "2026-10-03" },
      { seatId: "seat-1", visitDate: "2026-10-04" },
      { seatId: "seat-1", visitDate: "2026-10-05" },
      { seatId: "seat-2", visitDate: "2026-10-05" },
      { seatId: null, visitDate: "2026-10-05" },
    ],
    new Map([["seat-1", "2026-10-04"]]),
  );
  assert.equal(counted.get("seat-1"), 2, "a visit before the seat emptied was its last rep's own work");
  assert.equal(counted.has("seat-2"), false, "a seat outside the viewer's board counts nothing");

  // ── The gate and the wording, on the emitted source ──
  const source = (file: string) => fs.readFileSync(file, "utf8");
  const service = source("src/lib/reports/empty-seats.ts");
  assert.match(
    service,
    /canAccess\(access, "vacancies", "read"\), canAccess\(access, "sales", "read"\)/,
    "the board asks for both grants",
  );
  assert.match(service, /else entry\.contacts \+= 1/, "a pharmacy is never added into the contacts");
  assert.match(service, /filterRowsForBound\(applyAchievementAreaMerges\(/, "rows are merged first, then cut by the bound");
  for (const page of ["app/(admin)/reports/vacancies/empty-seats/page.tsx", "app/employee-portals/vacancies/empty-seats/page.tsx"]) {
    const text = source(page);
    assert.ok(
      text.indexOf("canViewEmptySeatsBoard(access)") > -1 &&
        text.indexOf("canViewEmptySeatsBoard(access)") < text.indexOf("getEmptySeatsBoard(access)"),
      `${page} asks the gate before it loads anything`,
    );
  }
  const board = source("src/components/reports/empty-seats-board.tsx");
  assert.ok(!/overflow-x-auto|min-w-\[|rounded-|truncate/.test(board), "the board wears the fits-the-screen and square-edge rules");
  assert.match(board, /table-fixed/);
  assert.match(board, /<colgroup>/);
}
