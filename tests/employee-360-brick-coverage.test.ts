import assert from "node:assert/strict";

import {
  buildEmployee360BrickCoverage,
  resolveBrickSalesMonths,
  type BrickMasterRow,
} from "../src/lib/employee-360/brick-coverage.ts";

// Employee 360 — Bricks: the rep's AREA against the rep's CURRENT LIST (owner, 2026-09-21).
//
// "Show the bricks that are counted for this area's sales, whether they have sales or not, and
// compare them with the bricks holding the doctors on this rep's list — the newest list, not the
// area's whole history."
//
// The pure core is the whole contract: which months feed the bricks' sales, and how the area's
// bricks, the closing's brick sales and the rep's list groups are joined.

export async function runEmployee360BrickCoverageTests() {
  // ── resolveBrickSalesMonths ──
  const landed = new Set(["2026-06", "2026-07", "2026-08", "2026-09"]);
  assert.deepEqual(
    resolveBrickSalesMonths({ window: { from: "2026-08-23", to: "2026-09-21" }, uploadedPeriods: landed, hireMonth: null }),
    { months: ["2026-08", "2026-09"], fallback: false },
    "the period's landed months, oldest first",
  );
  assert.deepEqual(
    resolveBrickSalesMonths({
      window: { from: "2026-09-01", to: "2026-09-30" },
      uploadedPeriods: new Set(["2026-07", "2026-08", "2026-10"]),
      hireMonth: null,
    }),
    { months: ["2026-08"], fallback: true },
    "September has not landed: the latest landed month up to the period's end stands in, flagged — never a later one",
  );
  assert.deepEqual(
    resolveBrickSalesMonths({ window: { from: "2026-08-23", to: "2026-09-21" }, uploadedPeriods: landed, hireMonth: "2026-09" }),
    { months: ["2026-09"], fallback: false },
    "a rep's figures start at the hire month",
  );
  assert.deepEqual(
    resolveBrickSalesMonths({
      window: { from: "2026-09-01", to: "2026-09-30" },
      uploadedPeriods: new Set(["2026-08"]),
      hireMonth: "2026-09",
    }),
    { months: [], fallback: false },
    "the fallback never reaches back before the hire month",
  );
  assert.deepEqual(
    resolveBrickSalesMonths({ window: { from: "2026-05-01", to: "2026-06-30" }, uploadedPeriods: landed, hireMonth: null }),
    { months: [], fallback: false },
    "nothing before July 2026, the closing's brick floor",
  );

  // ── buildEmployee360BrickCoverage ──
  const master: BrickMasterRow[] = [
    { brickId: "B1", brickName: "Fayoum City", areaCode: "FY1", current: true },
    { brickId: "B2", brickName: "Sinnuris", areaCode: "FY1", current: true },
    { brickId: "B3", brickName: "Ibshaway", areaCode: "FY1", current: true },
    { brickId: "B4", brickName: "Tamiya", areaCode: "FY1", current: false },
    { brickId: "B5", brickName: "Beni Suef Center", areaCode: "BS1", current: true },
    { brickId: "B6", brickName: "Itsa", areaCode: "fy1", current: true },
    { brickId: "B8", brickName: "Yousef El Sediq", areaCode: "FY1", current: false },
  ];
  const rows = (...types: string[]) => types.map((listType) => ({ listType }));
  const coverage = buildEmployee360BrickCoverage({
    lineName: "Pedia",
    areas: [{ areaCode: "fy1", areaName: "Fayoum" }],
    brickMaster: master,
    sales: [
      { areaCode: "FY1", brickId: "B1", value: 1_000 },
      { areaCode: "fy1", brickId: "B1", value: 500 },
      { areaCode: "FY1", brickId: "B2", value: 800 },
      { areaCode: "FY1", brickId: "B4", value: 200 },
      { areaCode: "FY1", brickId: "", value: 300 },
      { areaCode: "BS1", brickId: "B5", value: 9_999 },
    ],
    groups: [
      { areaCode: "FY1", areaName: "Fayoum", brickId: "B1", heading: "Fayoum City", mapped: true, rows: rows("AM", "PM", "Pharmacy") },
      { areaCode: "FY1", areaName: "Fayoum", brickId: "B2", heading: "Sinnuris", mapped: true, rows: rows("Pharmacy") },
      { areaCode: "FY1", areaName: "Fayoum", brickId: "B6", heading: "Itsa", mapped: true, rows: rows("PM") },
      { areaCode: "FY1", areaName: "Fayoum", brickId: "B7", heading: "Senouris East", mapped: true, rows: rows("AM") },
      { areaCode: "BS1", areaName: "Beni Suef", brickId: "B5", heading: "Beni Suef Center", mapped: true, rows: rows("AM", "AM", "Pharmacy") },
      { areaCode: "GZ3", areaName: null, brickId: "B9", heading: "Imbaba", mapped: true, rows: rows("PM") },
      { areaCode: null, areaName: null, brickId: null, heading: "Wasta", mapped: false, rows: rows("AM", "Pharmacy") },
      { areaCode: null, areaName: null, brickId: null, heading: "No location yet", mapped: false, rows: rows("PM") },
    ],
    salesMonths: ["2026-09"],
    salesMonthsFallback: false,
  });

  assert.deepEqual(
    coverage.bricks.map((brick) => [brick.brickName, brick.salesValue, brick.doctors, brick.pharmacies, brick.status]),
    [
      ["Fayoum City", 1_500, 2, 1, "covered"],
      ["Sinnuris", 800, 0, 1, "sales-no-doctor"],
      ["Tamiya", 200, 0, 0, "sales-no-doctor"],
      ["Itsa", 0, 1, 0, "doctor-no-sales"],
      ["Senouris East", 0, 1, 0, "doctor-no-sales"],
      ["Ibshaway", 0, 0, 0, "idle"],
    ],
    "every current brick of the area, sold or not; an ended brick that still booked sales; a list brick of the area missing from the master; a pharmacy is never a doctor; area codes match whatever their casing; another area's brick and an ended brick with no sales stay out",
  );
  assert.ok(coverage.bricks.every((brick) => brick.areaName === "Fayoum"), "every area brick carries the area's name, never its code");
  assert.deepEqual(coverage.areaNames, ["Fayoum"]);
  assert.equal(coverage.lineName, "Pedia");

  assert.deepEqual(
    coverage.outside.map((brick) => [brick.brickName, brick.areaName, brick.doctors, brick.pharmacies]),
    [
      ["Beni Suef Center", "Beni Suef", 2, 1],
      ["Imbaba", null, 1, 0],
    ],
    "list doctors in another area's brick, most doctors first; an unnamed area stays null, never a code",
  );
  assert.deepEqual(coverage.unmapped, { doctors: 2, pharmacies: 1, regions: 2 }, "list rows with no brick, one region per group");
  assert.equal(coverage.salesWithoutBrick, 300, "sales booked to the area with no brick are kept apart, not dropped");

  assert.deepEqual(coverage.totals, {
    areaBricks: 6,
    bricksWithSales: 3,
    bricksWithDoctors: 3,
    salesNoDoctor: 2,
    salesNoDoctorShare: 0.4,
    brickSales: 2_500,
    listDoctors: 9,
    listPharmacies: 4,
    doctorsInArea: 4,
    doctorsOutside: 3,
    pharmaciesOutside: 1,
  });
  assert.equal(
    coverage.totals.doctorsInArea + coverage.totals.doctorsOutside + coverage.unmapped.doctors,
    coverage.totals.listDoctors,
    "every listed doctor lands in exactly one place: the area, another area, or no brick",
  );
  assert.equal(
    coverage.bricks.reduce((sum, brick) => sum + brick.salesValue, 0) + coverage.salesWithoutBrick,
    2_800,
    "the area's booked sales are all accounted for; the other area's 9,999 is not among them",
  );

  // Nothing at all: zeros, and no share to divide by.
  const empty = buildEmployee360BrickCoverage({
    lineName: "CNS",
    areas: [{ areaCode: "CA5", areaName: "Down town" }],
    brickMaster: [],
    sales: [],
    groups: [],
    salesMonths: [],
    salesMonthsFallback: false,
  });
  assert.equal(empty.bricks.length, 0);
  assert.equal(empty.totals.salesNoDoctorShare, null, "no brick sales is no share, not 0%");
  assert.equal(empty.totals.listDoctors, 0);
}
