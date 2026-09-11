import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ExcelJS from "exceljs";

import {
  parseInsuranceWageWorkbook,
  wageHrKey,
} from "../src/lib/payroll/statutory/insurance-wage-import.ts";
import { DEFAULT_STATUTORY_CONFIG } from "../src/lib/payroll/statutory/defaults.ts";

const ROUTE_SOURCE = readFileSync(
  fileURLToPath(new URL("../app/api/payroll/statutory/insurance-wages/import/route.ts", import.meta.url)),
  "utf8",
);

export async function runPayrollInsuranceWageImportTests() {
  // key normalization (hyphen/case/underscore insensitive)
  assert.equal(wageHrKey("B-100"), "b100");
  assert.equal(wageHrKey("b_100"), "b100");
  assert.equal(wageHrKey(" B 100 "), "b100");

  // The band comes from the statutory config, never from this test's own idea of the law, so the
  // rows below are written relative to it and survive the yearly change in the figures.
  const band = DEFAULT_STATUTORY_CONFIG;
  const floor = band.siMinMonthlyWage;
  const ceiling = band.siMaxMonthlyWage;

  // build an in-memory workbook and round-trip it through the parser
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow(["HR_ID", "Insurance Wage"]);
  sheet.addRow(["B-100", 8000]);
  sheet.addRow(["B-142", "12,000"]); // comma-formatted → 12000
  sheet.addRow(["B-999", -5]); // negative → issue
  sheet.addRow(["", 500]); // missing HR_ID → issue
  sheet.addRow(["B-100", 9000]); // duplicate → issue
  sheet.addRow(["B-201", floor / 2]); // a part-timer's figure, below the legal minimum → issue
  sheet.addRow(["B-202", ceiling * 10]); // a stray extra zero, above the legal maximum → issue
  sheet.addRow(["B-203", 0]); // zero reads as "no wage on file" once stored → issue
  sheet.addRow(["B-204", floor]); // exactly the minimum is legal
  sheet.addRow(["B-205", ceiling]); // exactly the maximum is legal
  const buffer = (await workbook.xlsx.writeBuffer()) as unknown as ArrayBuffer;

  const result = await parseInsuranceWageWorkbook(buffer, band);

  assert.deepEqual(
    result.rows.map((row) => row.hrId),
    ["B-100", "B-142", "B-204", "B-205"],
    "only wages inside the legal band may be imported, and both edges of the band are legal",
  );
  assert.equal(result.rows[0].wage, 8000);
  assert.equal(result.rows[1].wage, 12000);
  assert.equal(result.rows[2].wage, floor);
  assert.equal(result.rows[3].wage, ceiling);

  assert.ok(result.issues.some((issue) => /negative/i.test(issue.message)), "negative wage flagged");
  assert.ok(result.issues.some((issue) => /missing hr_id/i.test(issue.message)), "missing hr_id flagged");
  assert.ok(result.issues.some((issue) => /duplicate/i.test(issue.message)), "duplicate flagged");

  // Audit finding 41: an out-of-band wage is a row issue that names the band, never a quiet write.
  const bandText = [floor, ceiling].map((value) => value.toLocaleString("en-US"));
  for (const [hrId, side] of [
    ["B-201", /below the legal minimum/],
    ["B-202", /above the legal maximum/],
    ["B-203", /below the legal minimum/],
  ] as const) {
    const issue = result.issues.find((entry) => entry.message.includes(`for ${hrId} `));
    assert.ok(issue, `${hrId} is outside the legal band and must be reported, not written to the column that decides the filing`);
    assert.match(issue!.message, side, `${hrId} must say which side of the band it is on`);
    assert.ok(
      bandText.every((text) => issue!.message.includes(text)),
      `${hrId}'s issue must name the band (${bandText.join(" to ")}) so HR can correct the row without looking it up`,
    );
  }

  // The parser checks the band it is handed, not a figure of its own: widen the band and the same
  // two rows go through. Without this, a hard-coded 2,700 / 16,700 would pass every assertion above
  // and silently stop tracking the statutory config the day the law changes.
  const widened = await parseInsuranceWageWorkbook(buffer, { ...band, siMinMonthlyWage: 1, siMaxMonthlyWage: ceiling * 100 });
  assert.ok(
    widened.rows.some((row) => row.hrId === "B-201") && widened.rows.some((row) => row.hrId === "B-202"),
    "the band must be the one passed in, so the import follows payroll_statutory_config rather than a constant",
  );

  // And the route hands it the band in force, the same row the statutory engine reads.
  assert.ok(
    ROUTE_SOURCE.includes("getStatutoryConfigForPeriod("),
    "the import route must read the band from the statutory config in force",
  );
  assert.match(
    ROUTE_SOURCE,
    /parseInsuranceWageWorkbook\(buffer,\s*band\)/,
    "the import route must pass that band to the parser",
  );

  // a file without the required columns reports a clear issue, no rows
  const badWorkbook = new ExcelJS.Workbook();
  const badSheet = badWorkbook.addWorksheet("Sheet1");
  badSheet.addRow(["Name", "Something"]);
  badSheet.addRow(["Ahmed", 1]);
  const badBuffer = (await badWorkbook.xlsx.writeBuffer()) as unknown as ArrayBuffer;
  const badResult = await parseInsuranceWageWorkbook(badBuffer, band);
  assert.equal(badResult.rows.length, 0);
  assert.ok(badResult.issues.length > 0);
}
