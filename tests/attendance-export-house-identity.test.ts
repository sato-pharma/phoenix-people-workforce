import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type ExcelJS from "exceljs";
import JSZip from "jszip";

import { checkWorkbook } from "../scripts/check-workbook-integrity.mjs";
import { attendanceSeverityFont } from "../src/lib/attendance/attendance-sheet-style.ts";
import { generateDeviceMappingTemplateWorkbook } from "../src/lib/attendance/device-user-mapping-template.ts";
import { generateFingerprintReportWorkbook } from "../src/lib/attendance/fingerprint-report-export.ts";
import { generateMonthlyAttendanceSummaryWorkbook } from "../src/lib/attendance/monthly-summary-export.ts";

// Three attendance workbooks, three private palettes, and two of them graded a cell by tinting it
// green / orange / pink. Moving them onto the house identity means those grades have to be carried
// by type instead, and two things must survive that:
//
//   1. THE DEVICE MAPPING TEMPLATE IS UPLOADED BACK. Its parser scans rows 1-10 for the row
//      carrying every template header. The old layout put the headers on row 4 by arithmetic —
//      title, subtitle, an EMPTY row from `addRow([])`, then headers — and the masthead occupies
//      three rows on its own. Leaving that empty row in would have pushed the headers to 5, taking
//      the autofilter and the sample rows with them.
//   2. THE MONTHLY SUMMARY'S INCOMPLETE WARNING. Days the device never reported are excluded from
//      Expected and Absent upstream, so without a visible warning a month with missing data reads
//      as a well-behaved one. It was bold red text; it must still be unmissable.
//
// This file deliberately does NOT touch `importDeviceMappingsFromWorkbook`: that writes to the
// database, and the suite runs with production credentials.

/** The headers the mapping parser looks for. Kept verbatim — this list IS the contract. */
const TEMPLATE_HEADERS = ["device_id", "device_user_id", "employee_hr_id", "is_active", "notes"];

/** Retired palettes: Phoenix orange, the navy header, the green/orange/pink grade fills. */
const RETIRED_COLOURS = ["F97316", "0F172A", "D1FAE5", "FFEDD5", "FFE4E6", "E2E8F0"];

function summaryFixture(missingDataDates: string[]) {
  const row = (hrId: string, absent: number) => ({
    absentDays: absent,
    department: "Sales",
    earlyLeaveCount: 0,
    employeeHrId: hrId,
    employeeName: "Mohamed Mohamed ElMenshawy Abdelmatty Mohamed Ismail",
    exceptionDays: 0,
    expectedWorkingDays: 26,
    holidayDays: 1,
    jobTitle: "Medical Rep",
    lateCount: 2,
    leaveDays: 0,
    noDataDays: 0,
    presentDays: 26 - absent,
    totalDeductionDays: absent,
    totalDeductionValue: absent * 480,
  });
  return {
    dateFrom: "2026-07-01",
    dateTo: "2026-07-31",
    generatedAt: "2026-08-01T00:00:00Z",
    holidayCalendarReachable: true,
    holidaySourceConnected: true,
    missingDataDates,
    month: "July 2026",
    rows: [row("A-12", 0), row("A-13", 2), row("B-7", 5)],
    totals: {
      absenceRate: 8.9,
      absentDays: 7,
      employees: 3,
      expectedWorkingDays: 78,
      lateCount: 6,
      noDataDays: missingDataDates.length,
      presentDays: 71,
      totalDeductionDays: 7,
    },
  };
}

const FINGERPRINT_FIXTURE = {
  columns: [
    { key: "employeeHrId", label: "Employee ID" },
    { key: "employeeName", label: "Name" },
    { key: "date", label: "Date" },
    { key: "status", label: "Status" },
  ],
  filters: { dateFrom: "2026-07-01", dateTo: "2026-07-31" },
  policyDetails: [],
  rows: [
    { date: "2026-07-12", employeeHrId: "A-12", employeeName: "One", status: "Complete" },
    { date: "2026-07-12", employeeHrId: "A-13", employeeName: "Two", status: "Short day" },
    { date: "2026-07-12", employeeHrId: "B-7", employeeName: "Three", status: "Absent" },
  ],
  summary: { deductions: 2, rows: 3 },
};

function rowText(sheet: ExcelJS.Worksheet, rowNumber: number): string {
  const parts: string[] = [];
  const row = sheet.getRow(rowNumber);
  for (let column = 1; column <= Math.max(sheet.columnCount, 5); column += 1) {
    const value = String(row.getCell(column).value ?? "").trim();
    if (value && !parts.includes(value)) parts.push(value);
  }
  return parts.join(" ");
}

export async function runAttendanceExportHouseIdentityTests() {
  // ── 1. severity is TYPE, never a fill, and the three steps are distinguishable ──
  const fonts = (["normal", "watch", "alert"] as const).map((level) => attendanceSeverityFont(level));
  const colours = fonts.map((font) => String(font.color?.argb ?? ""));
  assert.equal(new Set(colours).size, 3, "the three grades must be visually distinct");
  assert.equal(fonts[0].bold ?? false, false, "an unremarkable row should not shout");
  assert.equal(fonts[2].bold, true, "the top grade must carry weight as well as colour");

  // ── 2. the mapping template's header row is where the parser looks ──────────
  const mapping = await generateDeviceMappingTemplateWorkbook();
  const mappingSheet = mapping.worksheets[0];
  assert.ok(mappingSheet, "the mapping template must have a sheet");

  const headerCells = TEMPLATE_HEADERS.map((_, index) =>
    String(mappingSheet.getRow(4).getCell(index + 1).value ?? "").trim(),
  );
  assert.deepEqual(
    headerCells,
    TEMPLATE_HEADERS,
    "the mapping headers must stay on row 4 — the masthead takes three rows, so the empty spacer " +
      "row the old layout relied on had to go, and leaving it would push the headers to 5",
  );
  // The parser's own test: rows 1-10 must contain a row carrying every header, and it must be 4.
  let parserWouldFind = -1;
  for (let rowNumber = 1; rowNumber <= 10; rowNumber += 1) {
    const values = Array.from({ length: mappingSheet.columnCount }, (_, index) =>
      String(mappingSheet.getRow(rowNumber).getCell(index + 1).value ?? "").trim().toLowerCase(),
    );
    if (TEMPLATE_HEADERS.every((header) => values.includes(header))) {
      parserWouldFind = rowNumber;
      break;
    }
  }
  assert.equal(parserWouldFind, 4, "the parser must resolve the header row to 4");
  assert.equal(
    String(mappingSheet.getRow(5).getCell(1).value ?? "").trim().length > 0,
    true,
    "the sample rows must still start immediately under the header",
  );

  // ── 3. the INCOMPLETE warning survives, and only appears when it should ─────
  const withMissing = await generateMonthlyAttendanceSummaryWorkbook(
    summaryFixture(["2026-07-14", "2026-07-15"]) as never,
  );
  const withMissingSheet = withMissing.worksheets[0];
  const noteText = rowText(withMissingSheet, 4);
  assert.match(
    noteText,
    /INCOMPLETE/,
    "a month the device did not fully report must say so, or it reads as a well-behaved one",
  );
  const noteFont = withMissingSheet.getRow(4).getCell(1).font;
  assert.equal(noteFont?.bold, true, "the warning must carry weight");
  assert.notEqual(
    String(noteFont?.color?.argb ?? ""),
    "",
    "and a colour of its own, not the ordinary muted note styling",
  );

  const clean = await generateMonthlyAttendanceSummaryWorkbook(summaryFixture([]) as never);
  assert.ok(
    !rowText(clean.worksheets[0], 4).includes("INCOMPLETE"),
    "a complete month must NOT be warned about — a warning that is always there is wallpaper",
  );

  // ── 4. the header row and its autofilter agree ─────────────────────────────
  const summarySheet = clean.worksheets[0];
  assert.equal(
    String(summarySheet.getRow(6).getCell(1).value ?? "").trim(),
    "Employee ID",
    "the summary's header row must be 6 — masthead 1-3, totals note 4, cycle note 5",
  );
  assert.equal(
    summarySheet.autoFilter && typeof summarySheet.autoFilter === "object"
      ? (summarySheet.autoFilter as { from: { row: number } }).from.row
      : -1,
    6,
    "the autofilter must sit on the header row, not on the merged note above it",
  );

  // ── 5. every artifact is clean, and carries none of the retired palettes ────
  const fingerprint = await generateFingerprintReportWorkbook(FINGERPRINT_FIXTURE as never);

  for (const [label, workbook] of [
    ["device mapping template", mapping],
    ["monthly summary", clean],
    ["fingerprint report", fingerprint],
  ] as Array<[string, ExcelJS.Workbook]>) {
    const bytes = Buffer.from((await workbook.xlsx.writeBuffer()) as ArrayBuffer);

    const problems = await checkWorkbook(bytes, { quiet: true });
    assert.deepEqual(problems, [], `${label} must be structurally clean: ${problems.join("; ")}`);

    const zip = await JSZip.loadAsync(bytes);
    const styles = ((await zip.file("xl/styles.xml")?.async("string")) ?? "").toUpperCase();
    assert.ok(styles.length > 0, `${label} must have a styles part`);
    for (const colour of RETIRED_COLOURS) {
      assert.ok(
        !styles.includes(colour),
        `${label}: ${colour} belongs to a palette these exports no longer wear`,
      );
    }
  }

  // ── 6. THE TITLE IS THE COMPANY'S NAME FOR THE DOCUMENT, NOT THE APP'S ──────
  //
  // The ink was converted first and the NAME was left behind: both of these printed
  // "Phoenix Workforce - ..." as their headline for months afterwards, which is the app introducing
  // itself on a document the company issues. A workbook can be perfectly on-palette and still say
  // the wrong thing in the largest type on the page.
  //
  // Asserted on the TITLE CELL, not on the file as a whole, because the mapping template's
  // instruction line legitimately names the system a filler is entering data into — "employee_hr_id
  // must exist in Phoenix employees" tells them where the id comes from, and blanking it would make
  // the sheet harder to fill, not more correct. Identity is the headline; this is guidance.
  // COLUMN 3, which is where `writeHouseMasthead` merges the title from — columns 1-2 are left
  // clear for the floating mark and column 4 onward carries the provenance block. Reading column 4
  // instead makes this whole check pass against the document id, which contains no app name and
  // never will: written that way it stayed green with "Phoenix Workforce" restored to the headline.
  const titles: Array<[string, string]> = [
    ["mapping template", String(mapping.worksheets[0].getRow(1).getCell(3).value ?? "")],
    ["fingerprint report", String(fingerprint.worksheets[0].getRow(1).getCell(3).value ?? "")],
  ];
  for (const [label, title] of titles) {
    assert.ok(title.length > 0, `${label}: the title cell must not be empty`);
    assert.ok(
      !/phoenix/i.test(title),
      `${label}: the headline is the COMPANY's name for this document, never the app's. Found "${title}"`,
    );
  }

  // ── 7. AN EMPLOYEE'S EXPORT LISTS THE DAYS WITH NO PUNCH, AS THE PAGE DOES (2026-10-29) ──────────
  //
  // The portal's Fingerprint Analytics page merges in the working days with no punch as "No record";
  // the export it offers did not, so a field rep who never punches downloaded a header and no rows
  // beside a page full of days. The days go in date order among the punched ones, carry who and when,
  // and nothing else — no punch, no minutes, no deduction, never a measured-looking zero.
  {
    const oneRep = {
      ...FINGERPRINT_FIXTURE,
      columns: [...FINGERPRINT_FIXTURE.columns, { key: "deductionDays", label: "Deduction Days" }],
      hasDateRange: true,
      policyDetails: [{ department: "Sales", employeeHrId: "A-12", employeeName: "One", jobTitle: "Medical Rep" }],
      rows: [
        { date: "07/12/2026", deductionDays: "0", employeeHrId: "A-12", employeeName: "One", sortKey: "2026-07-12|A-12", status: "Complete" },
      ],
      summary: { deductions: 0, rows: 1 },
    };
    const withDays = await generateFingerprintReportWorkbook(oneRep as never, {
      noRecordDates: ["2026-07-13", "2026-07-12", "2026-07-11"],
    });
    const sheet = withDays.worksheets[0];
    const body = [6, 7, 8, 9].map((rowNumber) =>
      [1, 2, 3, 4, 5].map((column) => String(sheet.getRow(rowNumber).getCell(column).value ?? "")),
    );
    assert.deepEqual(
      body.slice(0, 3),
      [
        ["A-12", "One", "07/11/2026", "No record", ""],
        ["A-12", "One", "07/12/2026", "Complete", "0"],
        ["A-12", "One", "07/13/2026", "No record", ""],
      ],
      "a day with no punch is a row of its own, in date order, saying No record — and a recorded day is never doubled",
    );
    assert.deepEqual(body[3], ["", "", "", "", ""], "nothing after the last day");
    assert.match(rowText(sheet, 4), /No record: 2 working days/, "the note says how many days had no record");
    assert.equal(
      sheet.getRow(6).getCell(4).font?.bold ?? false,
      false,
      "a day with no punch is neutral, never graded like an absence",
    );

    const none = await generateFingerprintReportWorkbook({ ...oneRep, rows: [], summary: { deductions: 0, rows: 0 } } as never, {
      noRecordDates: ["2026-07-11"],
    });
    assert.equal(
      String(none.worksheets[0].getRow(6).getCell(4).value ?? ""),
      "No record",
      "a rep with no punch at all gets his days, never an empty sheet",
    );

    const route = readFileSync(new URL("../app/api/attendance/employee-fingerprint-export/route.ts", import.meta.url), "utf8");
    assert.ok(
      route.includes("generateFingerprintReportWorkbook(data, { noRecordDates })"),
      "the employee export passes the days with no record to the workbook",
    );
  }
}
