import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import {
  validateDistributorSalesWorkbookBuffer,
  type DistributorSalesValidationIssue,
  type SalesReferenceData,
} from "../src/lib/sales/monthly-distributor-import.ts";

// A single distributor customer code should belong to ONE territory. When one code's rows resolve to
// more than one REAL area — split within a single upload, OR drifting from the area the code is
// already pinned to in the customer map — the code is being shared by pharmacies in different areas,
// and one side's sales are credited to the wrong territory. That mis-credit was found in production
// (2026-09-22) but only ever surfaces AFTER a month is published and locked, when it can no longer be
// corrected. This flag surfaces it at import as a non-blocking WARNING so a human resolves it first.
//
// Fixture: B-1 lives in area A1 (Cairo), B-2 in area A2 (Alex). Both are real territories that own a
// brick, so both count toward the divergence.

const references: SalesReferenceData = {
  distributors: [{ code: "PS", name: "overseas" }],
  products: [
    { factoryPrice: 10, family: "CNS Family", familyCode: "CNS", line: "CNS", productCode: "P-A", productName: "Product A", source: "Phoenix" },
  ],
  regions: [
    { areaCode: "A1", areaName: "Area One", regionCode: "CA", regionName: "Cairo" },
    { areaCode: "A2", areaName: "Area Two", regionCode: "AB", regionName: "Alex" },
  ],
  areas: [
    { areaCode: "A1", areaName: "Area One", regionCode: "CA", regionName: "Cairo" },
    { areaCode: "A2", areaName: "Area Two", regionCode: "AB", regionName: "Alex" },
  ],
  blocks: [
    { areaCode: "A1", areaName: "Area One", blockCode: "BL-1", blockName: "Block One", regionCode: "CA", regionName: "Cairo" },
    { areaCode: "A2", areaName: "Area Two", blockCode: "BL-2", blockName: "Block Two", regionCode: "AB", regionName: "Alex" },
  ],
  bricks: [
    { areaCode: "A1", areaName: "Area One", blockCode: "BL-1", blockName: "Block One", brickId: "B-1", brickName: "Brick One", regionCode: "CA", regionName: "Cairo" },
    { areaCode: "A2", areaName: "Area Two", blockCode: "BL-2", blockName: "Block Two", brickId: "B-2", brickName: "Brick Two", regionCode: "AB", regionName: "Alex" },
  ],
  customerBricks: [],
};

async function buildPsBuffer(rows: unknown[][]) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Data");
  sheet.addRow(["Branch", "Branch Name", "Invoice Date", "Qty", "B. Qty", "Value", "Product ID", "Brick ID", "Area ID", "Region ID", "Distrub ID", "Customer"]);
  rows.forEach((r) => sheet.addRow(r));
  return workbook.xlsx.writeBuffer();
}

const reusedCodeIssues = (issues: DistributorSalesValidationIssue[]) =>
  issues.filter((i) => i.field === "Customer Code");

export async function runSosReusedCodeCrossAreaFlagTests() {
  // ── Split within one upload: code C-DUP typed in A1 (brick B-1) on one row and A2 (brick B-2) on
  //    another. Both bricks are valid in their typed areas, so nothing else is wrong — but the code
  //    now spans two territories and every one of its rows must carry the warning.
  const splitBuffer = await buildPsBuffer([
    ["B1", "Branch", new Date("2026-04-01T00:00:00Z"), 10, 0, 100, "P-A", "B-1", "A1", "CA", "PS", "C-DUP"],
    ["B1", "Branch", new Date("2026-04-01T00:00:00Z"), 5, 0, 50, "P-A", "B-2", "A2", "AB", "PS", "C-DUP"],
  ]);
  const split = await validateDistributorSalesWorkbookBuffer({
    buffer: splitBuffer as unknown as ArrayBuffer,
    distributorCode: "PS",
    fileName: "split.xlsx",
    references,
  });
  const splitWarnings = reusedCodeIssues(split.issues);
  assert.equal(
    splitWarnings.length,
    2,
    "a code split across two areas in one upload must flag BOTH of its rows",
  );
  assert.ok(
    splitWarnings.every((i) => i.severity === "warning"),
    "the reused-code flag is advisory — it must be a warning, never a blocking failure",
  );
  assert.ok(
    splitWarnings.every((i) => i.message.includes("A1") && i.message.includes("A2")),
    "the warning must name both areas the code spans so a human can resolve it",
  );

  // ── Drift from the customer map: code C-DRIFT is typed in A1 (brick B-1, a valid in-area brick, so
  //    the auto-fill guard never fires) but the customer map already pins C-DRIFT to B-2 in area A2.
  //    Folding the map area in must catch the cross-MONTH drift, not only a within-sheet split.
  const driftRefs: SalesReferenceData = { ...references, customerBricks: [{ brickId: "B-2", customerCode: "C-DRIFT", distributorCode: "PS" }] };
  const driftBuffer = await buildPsBuffer([
    ["B1", "Branch", new Date("2026-04-01T00:00:00Z"), 10, 0, 100, "P-A", "B-1", "A1", "CA", "PS", "C-DRIFT"],
  ]);
  const drift = await validateDistributorSalesWorkbookBuffer({
    buffer: driftBuffer as unknown as ArrayBuffer,
    distributorCode: "PS",
    fileName: "drift.xlsx",
    references: driftRefs,
  });
  assert.equal(
    reusedCodeIssues(drift.issues).length,
    1,
    "a code whose upload area differs from the area it is pinned to in the customer map must flag",
  );

  // ── Clean: a code that stays in ONE area (and whose map area agrees) must NOT be flagged. This is
  //    the overwhelming majority — the flag must be near-silent, not fire on every ordinary code.
  const cleanRefs: SalesReferenceData = { ...references, customerBricks: [{ brickId: "B-1", customerCode: "C-OK", distributorCode: "PS" }] };
  const cleanBuffer = await buildPsBuffer([
    ["B1", "Branch", new Date("2026-04-01T00:00:00Z"), 10, 0, 100, "P-A", "B-1", "A1", "CA", "PS", "C-OK"],
    ["B1", "Branch", new Date("2026-04-01T00:00:00Z"), 3, 0, 30, "P-A", "B-1", "A1", "CA", "PS", "C-OK"],
  ]);
  const clean = await validateDistributorSalesWorkbookBuffer({
    buffer: cleanBuffer as unknown as ArrayBuffer,
    distributorCode: "PS",
    fileName: "clean.xlsx",
    references: cleanRefs,
  });
  assert.equal(
    reusedCodeIssues(clean.issues).length,
    0,
    "a code that stays in one territory must not be flagged — the guard must not fire on ordinary codes",
  );
}
