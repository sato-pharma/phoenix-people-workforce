import { strict as assert } from "node:assert";

import {
  buildFieldWorkforceCompliancePreview,
} from "../src/lib/field-workforce-compliance/classifier.ts";
import {
  fieldWorkforceArchiveRowsFromPreview,
  fieldWorkforceMonthKey,
  fieldWorkforcePreviewFromArchiveRows,
  findFieldWorkforceArchiveDuplicate,
} from "../src/lib/field-workforce-compliance/archive.ts";
import {
  parseFieldWorkforceComplianceMatrix,
} from "../src/lib/field-workforce-compliance/parser.ts";

function collectObjectKeys(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectObjectKeys(item));
  return Object.entries(value).flatMap(([key, nested]) => [key, ...collectObjectKeys(nested)]);
}

export function runFieldWorkforceComplianceTests() {
  const parsed = parseFieldWorkforceComplianceMatrix({
    fileName: "Jan 2026 team calendar.xlsx",
    matrix: [
      ["TM", "HR ID", "Hiring Date", "Month", "Year", "1-Jan-26", "2-Jan-26", "3-Jan-2026", "4-Jan-2026", "5-Jan-2026", "6-Jan-2026", "7-Jan-2026"],
      ["Ahmed", "A-1", "3-Jan-2026", "Jan", 2026, 9, "F", "N", "N", "CP", "AV", 5, null],
      ["Unknown Person", "ZZ-9", "1-Jan-2026", "Jan", 2026, "X", "F", "N", null, null, null, null, null],
    ],
    sheetName: "iReport",
  });

  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.month, 1);
  assert.equal(parsed.year, 2026);
  assert.equal(parsed.dateColumns.length, 7);

  const febParsed = parseFieldWorkforceComplianceMatrix({
    fileName: "Feb 2026 team calendar.xlsx",
    matrix: [
      ["TM", "HR ID", "Hiring Date", "Month", "Year", "1-Feb-2026", "28-Feb-2026", "31-Feb-2026"],
      ["Ahmed", "A-1", "1-Feb-2026", "Feb", 2026, "N", 3, null],
    ],
    sheetName: "iReport",
  });
  assert.equal(febParsed.errors.length, 0);
  assert.equal(febParsed.ignoredColumns.length, 1);

  const preview = buildFieldWorkforceCompliancePreview({
    employeeReferences: [
      {
        fullName: "Ahmed Official",
        hireDate: "2026-01-03",
        hrId: "A-1",
      },
    ],
    holidayConnected: true,
    holidaySourceLabel: "Egypt public holidays",
    holidays: [
      {
        name: "Coptic Christmas Day",
        startDate: "2026-01-07",
      },
    ],
    parsed,
  });

  assert.equal(preview.metadata.employeeCount, 2);
  assert.equal(preview.metadata.matchedEmployees, 1);
  assert.equal(preview.metadata.unmatchedEmployees, 1);

  const ahmed = preview.employees.find((employee) => employee.hrId === "A-1");
  assert.ok(ahmed);
  assert.equal(ahmed.employeeName, "Ahmed Official");
  assert.equal(ahmed.eligibleWorkingDays, 25);
  assert.equal(ahmed.fridays, 4);
  assert.equal(ahmed.workedDays, 2);
  assert.equal(ahmed.campaignDays, 1);
  assert.equal(ahmed.totalVisits, 5);
  assert.equal(ahmed.noActivityCandidates, 2);
  assert.equal(ahmed.vacationSignalDays, 1);
  assert.equal(ahmed.preHireIgnoredValues, 2);

  const jan1 = ahmed.timeline.find((cell) => cell.dateIso === "2026-01-01");
  assert.ok(jan1);
  assert.equal(jan1.isPreHire, true);
  assert.equal(jan1.ignored, true);
  assert.equal(jan1.countedAsVisitTotal, false);
  assert.equal(jan1.severity, "High");
  assert.match(jan1.explanation, /before hiring date/);

  const jan2 = ahmed.timeline.find((cell) => cell.dateIso === "2026-01-02");
  assert.ok(jan2);
  assert.equal(jan2.isFriday, true);
  assert.equal(jan2.ignored, true);
  assert.equal(jan2.countedAsWorkedDay, false);
  assert.equal(jan2.severity, undefined);

  const jan3 = ahmed.timeline.find((cell) => cell.dateIso === "2026-01-03");
  const jan4 = ahmed.timeline.find((cell) => cell.dateIso === "2026-01-04");
  assert.equal(jan3?.severity, "Medium");
  assert.equal(jan4?.severity, "Medium");

  const jan5 = ahmed.timeline.find((cell) => cell.dateIso === "2026-01-05");
  assert.equal(jan5?.status, "CP");
  assert.equal(jan5?.countedAsWorkedDay, true);
  assert.equal(jan5?.countedAsVisitTotal, false);

  const jan7 = ahmed.timeline.find((cell) => cell.dateIso === "2026-01-07");
  assert.ok(jan7);
  assert.equal(jan7.isPublicHoliday, true);
  assert.equal(jan7.severity, "Review");
  assert.match(jan7.explanation, /public holiday/);
  assert.equal(jan7.countedAsVisitTotal, true);

  const unknownEmployee = preview.employees.find((employee) => employee.hrId === "ZZ-9");
  assert.ok(unknownEmployee);
  assert.equal(unknownEmployee.matchStatus, "unmatched");
  assert.equal(unknownEmployee.unknownValues, 1);

  assert.ok(preview.reviewCandidates.some((candidate) =>
    candidate.type === "employee_match" &&
    candidate.severity === "High" &&
    candidate.hrId === "ZZ-9"
  ));
  assert.ok(preview.reviewCandidates.some((candidate) =>
    candidate.type === "pre_hire_activity" &&
    candidate.severity === "High" &&
    candidate.dateIso === "2026-01-01"
  ));
  assert.ok(!preview.reviewCandidates.some((candidate) =>
    candidate.type === "pre_hire_activity" &&
    candidate.dateIso === "2026-01-02"
  ));
  assert.ok(preview.reviewCandidates.some((candidate) =>
    candidate.type === "public_holiday_overlap" &&
    candidate.severity === "Review" &&
    candidate.dateIso === "2026-01-07"
  ));
  assert.ok(preview.reviewCandidates.every((candidate) =>
    !candidate.explanation.toLowerCase().includes("deduct automatically") &&
    !candidate.explanation.toLowerCase().includes("leave balance updated")
  ));

  const archiveRows = fieldWorkforceArchiveRowsFromPreview(preview, "test-admin");
  assert.equal(fieldWorkforceMonthKey(2026, 1), "2026-01");
  assert.equal(archiveRows.importRow.month_key, "2026-01");
  assert.equal(archiveRows.importRow.employee_count, 2);
  assert.equal(archiveRows.importRow.review_candidate_count, preview.reviewCandidates.length);
  assert.equal(archiveRows.importRow.high_severity_count, preview.severityCounts.High);
  assert.equal(archiveRows.dayRows.length, preview.employees.length * 31);
  assert.equal(archiveRows.summaryRows.length, preview.employees.length);

  const duplicate = findFieldWorkforceArchiveDuplicate([
    {
      employeeCount: 2,
      highSeverityCount: preview.severityCounts.High,
      id: "archive-1",
      month: 1,
      monthKey: "2026-01",
      reviewCandidateCount: preview.reviewCandidates.length,
      sheetName: "iReport",
      sourceFilename: "Jan 2026 team calendar.xlsx",
      status: "archived",
      uploadedAt: "2026-01-31T00:00:00Z",
      uploadedBy: "test-admin",
      year: 2026,
    },
  ], "2026-01");
  assert.equal(duplicate?.id, "archive-1");

  const restored = fieldWorkforcePreviewFromArchiveRows({
    dayRows: archiveRows.dayRows,
    importRow: {
      ...archiveRows.importRow,
      id: "archive-1",
      uploaded_at: "2026-01-31T00:00:00Z",
    },
    summaryRows: archiveRows.summaryRows,
  });
  assert.equal(restored.archive.monthKey, "2026-01");
  assert.equal(restored.preview.metadata.employeeCount, preview.metadata.employeeCount);
  assert.equal(restored.preview.reviewCandidates.length, preview.reviewCandidates.length);
  assert.equal(restored.preview.employees.find((employee) => employee.hrId === "A-1")?.timeline.length, 31);

  const archiveKeys = collectObjectKeys(archiveRows).map((key) => key.toLowerCase());
  assert.ok(archiveKeys.every((key) =>
    !key.includes("payroll") &&
    !key.includes("leave_balance") &&
    !key.includes("approval")
  ));
}
