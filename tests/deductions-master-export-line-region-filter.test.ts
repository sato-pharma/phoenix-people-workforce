// The Master deductions export can be narrowed to one line and/or one region,
// and the download then contains ONLY the deductions inside that selection.
//
// What this pins, and why each one is here rather than left to inspection:
//
//  1. A blank or "all" filter parameter means the WHOLE company. A stray
//     `?line=` reaching the route as the literal empty string would otherwise
//     match nobody and hand back an empty workbook that looks like "this line
//     has no deductions".
//  2. Filtering is by the employee's line and region NAME, case-insensitively,
//     and an employee the directory does not know is Unassigned on both axes —
//     never a silent match, which would put a stranger's deduction into a
//     line's sheet.
//  3. The workbook a filter produced SAYS SO — on its Cover, in its sheet
//     titles and in its filename. A filtered payroll total is otherwise
//     indistinguishable from the month's company total, and nobody catches that
//     by reading the number.
//  4. The screen's own "N of M deductions" is computed from the same (line,
//     region) grouping the server filters on, so the count promised beside the
//     button and the rows in the file cannot drift apart.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { buildDeductionsMasterWorkbook, type EmployeeOrgInfo } from "../src/lib/deductions/exports/master-workbook.ts";
import {
  buildDeductionsOrgGroups,
  DEDUCTIONS_ORG_UNASSIGNED,
  deductionsOrgFilterSlug,
  describeDeductionsOrgFilter,
  filterCandidatesByOrg,
  orgFilterFromSearchParams,
  parseOrgFilterValue,
} from "../src/lib/deductions/org-filter.ts";
import type {
  DeductionsCandidateWithDecision,
  DeductionsCategory,
  DeductionsDecisionStatus,
} from "../src/lib/deductions/types.ts";

function candidate(input: {
  id: string;
  employeeHrId: string;
  employeeHrIdCompact: string;
  employeeName: string;
  category?: DeductionsCategory;
  rawValue?: number;
  estimatedAmount?: number;
  decisionStatus?: DeductionsDecisionStatus;
}): DeductionsCandidateWithDecision {
  const status = input.decisionStatus ?? "Approved for Payroll";
  return {
    id: input.id,
    category: input.category ?? "fingerprint",
    sourceSystem: "fingerprint_report",
    sourceRecordId: `rec-${input.id}`,
    candidateKey: `key-${input.id}`,
    employeeHrId: input.employeeHrId,
    employeeHrIdCompact: input.employeeHrIdCompact,
    employeeName: input.employeeName,
    monthKey: "2026-08",
    month: 8,
    year: 2026,
    unit: "days",
    rawValue: input.rawValue ?? 1,
    estimatedAmount: input.estimatedAmount ?? 1000,
    calculationStatus: "calculated",
    severity: null,
    reason: null,
    evidence: {},
    dates: ["2026-08-12"],
    hierarchySnapshot: {},
    createdBy: "system",
    createdAt: "2026-08-01T00:00:00Z",
    refreshedAt: null,
    lockedAt: null,
    supersededAt: null,
    supersededByCandidateId: null,
    decision: {
      id: `d-${input.id}`,
      candidateId: input.id,
      decisionStatus: status,
      decisionReason: "reason",
      hrNote: "",
      appliedValue: null,
      appliedAmount: null,
      appliedDates: null,
      decidedBy: null,
      decidedAt: null,
      actorRoleAtDecision: null,
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-08-01T00:00:00Z",
    },
  };
}

/** Every cell value in a sheet, flattened — used to prove the Cover states the filter. */
function sheetText(workbook: ReturnType<typeof buildDeductionsMasterWorkbook>, name: string): string {
  const sheet = workbook.getWorksheet(name);
  if (!sheet) throw new Error(`sheet "${name}" not found`);
  const parts: string[] = [];
  sheet.eachRow((row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      const value = cell.value;
      if (value != null) parts.push(typeof value === "object" ? JSON.stringify(value) : String(value));
    });
  });
  return parts.join(" | ");
}

/** The [row, col] of the header cell whose value is exactly `label`. */
function headerCell(sheet: import("exceljs").Worksheet, label: string): { row: number; col: number } {
  for (let r = 1; r <= sheet.rowCount; r += 1) {
    for (let c = 1; c <= sheet.columnCount; c += 1) {
      if (sheet.getRow(r).getCell(c).value === label) return { row: r, col: c };
    }
  }
  throw new Error(`header "${label}" not found in sheet "${sheet.name}"`);
}

function cellFor(sheet: import("exceljs").Worksheet, hrId: string, columnLabel: string): unknown {
  const idHeader = headerCell(sheet, "HR ID");
  const target = headerCell(sheet, columnLabel);
  for (let r = idHeader.row + 1; r <= sheet.rowCount; r += 1) {
    if (sheet.getRow(r).getCell(idHeader.col).value === hrId) {
      return sheet.getRow(r).getCell(target.col).value;
    }
  }
  throw new Error(`no data row for HR ID "${hrId}" in sheet "${sheet.name}"`);
}

/** Every HR ID on a sheet's data rows. Matched on the HR-ID SHAPE, not on
 *  "any string": writeTable puts a TOTAL row and a free-text note in the same
 *  column, and counting those made this read three employees where there are
 *  two. */
function hrIdsIn(sheet: import("exceljs").Worksheet): string[] {
  const idHeader = headerCell(sheet, "HR ID");
  const ids: string[] = [];
  for (let r = idHeader.row + 1; r <= sheet.rowCount; r += 1) {
    const value = sheet.getRow(r).getCell(idHeader.col).value;
    if (typeof value === "string" && /^[A-Za-z]+-\d+$/.test(value)) ids.push(value);
  }
  return ids;
}

export async function runDeductionsMasterExportLineRegionFilterTests(): Promise<void> {
  // Four people, deliberately spanning both axes: two share the CNS line but
  // sit in different regions, and one shares Delta (2) with a different line.
  // Nothing here can pass by filtering on the wrong axis.
  const cnsCairo = candidate({
    id: "c1",
    employeeHrId: "B-207",
    employeeHrIdCompact: "b207",
    employeeName: "Alpha Employee",
    rawValue: 4,
    estimatedAmount: 4000,
  });
  const cnsDelta = candidate({
    id: "c2",
    employeeHrId: "B-208",
    employeeHrIdCompact: "b208",
    employeeName: "Beta Employee",
    rawValue: 1,
    estimatedAmount: 1000,
  });
  const pediaDelta = candidate({
    id: "c3",
    employeeHrId: "B-500",
    employeeHrIdCompact: "b500",
    employeeName: "Gamma Employee",
    rawValue: 2,
    estimatedAmount: 2000,
  });
  // Known to the deductions ledger, absent from the employee directory.
  const stranger = candidate({
    id: "c4",
    employeeHrId: "B-999",
    employeeHrIdCompact: "b999",
    employeeName: "Delta Employee",
    rawValue: 1,
    estimatedAmount: 500,
  });
  const all = [cnsCairo, cnsDelta, pediaDelta, stranger];

  const org = new Map<string, EmployeeOrgInfo>([
    ["b207", { lineName: "CNS", regionName: "Cairo", managerName: "Manager One" }],
    ["b208", { lineName: "CNS", regionName: "Delta (2)", managerName: "Manager Two" }],
    ["b500", { lineName: "Pedia", regionName: "Delta (2)", managerName: "Manager Three" }],
  ]);

  // ── 1. An absent / blank / "all" parameter means the whole company ──────────
  assert.equal(parseOrgFilterValue(null), null, "an absent parameter is not a filter");
  assert.equal(parseOrgFilterValue(""), null, "a blank parameter is not a filter — it must not match nobody");
  assert.equal(parseOrgFilterValue("   "), null, "a whitespace-only parameter is not a filter");
  assert.equal(parseOrgFilterValue("all"), null, "the explicit 'all' sentinel is not a filter");
  assert.equal(parseOrgFilterValue("CNS"), "CNS", "a real value is kept verbatim");

  const noFilter = orgFilterFromSearchParams(new URLSearchParams("monthKey=2026-08&line=&region="));
  assert.deepEqual(noFilter, { line: null, region: null }, "empty query values must not narrow anything");
  assert.equal(
    filterCandidatesByOrg(all, org, noFilter).length,
    4,
    "an unfiltered export is still the whole month, stranger included",
  );

  // ── 2. Each axis narrows on its own, and together ───────────────────────────
  const byLine = filterCandidatesByOrg(all, org, { line: "CNS", region: null });
  assert.deepEqual(
    byLine.map((row) => row.employeeHrId).sort(),
    ["B-207", "B-208"],
    "a line filter keeps every region inside that line",
  );

  const byRegion = filterCandidatesByOrg(all, org, { line: null, region: "Delta (2)" });
  assert.deepEqual(
    byRegion.map((row) => row.employeeHrId).sort(),
    ["B-208", "B-500"],
    "a region filter crosses lines — it is not a line filter in disguise",
  );

  const byBoth = filterCandidatesByOrg(all, org, { line: "CNS", region: "Delta (2)" });
  assert.deepEqual(
    byBoth.map((row) => row.employeeHrId),
    ["B-208"],
    "both axes together are an AND, not an OR",
  );

  // Case and spacing must not decide who gets deducted.
  assert.equal(
    filterCandidatesByOrg(all, org, { line: "cns", region: null }).length,
    2,
    "the line match is case-insensitive",
  );

  // ── 3. An employee the directory does not know is Unassigned, never a match ─
  assert.equal(
    filterCandidatesByOrg(all, org, { line: "CNS", region: null }).some((row) => row.employeeHrId === "B-999"),
    false,
    "an employee with no directory row must NOT fall into a named line",
  );
  assert.deepEqual(
    filterCandidatesByOrg(all, org, { line: DEDUCTIONS_ORG_UNASSIGNED, region: null }).map((row) => row.employeeHrId),
    ["B-999"],
    "the Unassigned bucket is reachable, so a person with no line can still be exported",
  );

  // ── 4. The facets the screen's dropdowns and its live count are built from ──
  const groups = buildDeductionsOrgGroups(all, org);
  assert.deepEqual(
    groups.map((group) => `${group.line}/${group.region}=${group.candidates}`).sort(),
    ["CNS/Cairo=1", "CNS/Delta (2)=1", "Pedia/Delta (2)=1", "Unassigned/Unassigned=1"],
    "every (line, region) bucket present in the month is offered, including Unassigned",
  );
  // The count the button promises is a sum over these groups — the same arithmetic
  // the screen does — and it must equal what the filter actually returns.
  const promised = groups
    .filter((group) => group.line === "CNS")
    .reduce((sum, group) => sum + group.candidates, 0);
  assert.equal(promised, byLine.length, "the screen's promised count and the filtered rows must be the same number");

  // ── 5. The workbook contains only the selection, and says that it is filtered ─
  const meta = {
    monthKey: "2026-08",
    generatedAtIso: "2026-09-01T00:00:00Z",
    generatedByName: "Tester",
    generatedByHrId: "T-1",
  };
  const filtered = buildDeductionsMasterWorkbook({
    meta: { ...meta, filter: { line: "CNS", region: null } },
    candidates: byLine,
    orgByCompactHrId: org,
  });

  const summary = filtered.getWorksheet("Summary")!;
  assert.deepEqual(hrIdsIn(summary).sort(), ["B-207", "B-208"], "the Summary sheet holds only the filtered employees");
  assert.equal(cellFor(summary, "B-207", "Region"), "Cairo", "the Summary sheet carries the employee's region");
  assert.equal(cellFor(summary, "B-207", "Line"), "CNS", "the Line column survived the Region column being added");
  assert.equal(
    cellFor(summary, "B-207", "Direct Manager"),
    "Manager One",
    "Direct Manager did not shift a column when Region was inserted before it",
  );
  assert.equal(
    cellFor(summary, "B-207", "Final Deduction (EGP)"),
    4000,
    "the money columns still line up after the new column — a shifted total is the failure this catches",
  );

  const detailed = filtered.getWorksheet("Detailed")!;
  assert.deepEqual(hrIdsIn(detailed).sort(), ["B-207", "B-208"], "the Detailed sheet holds only the filtered rows");
  assert.equal(cellFor(detailed, "B-208", "Region"), "Delta (2)", "the Detailed sheet carries the region too");

  // The headline safety assertion: a filtered workbook must announce it.
  const cover = sheetText(filtered, "Cover");
  assert.match(cover, /Line filter/, "the Cover must state which line filter produced this file");
  assert.match(cover, /CNS/, "the Cover must name the line that was selected");
  assert.match(
    cover,
    /FILTERED EXTRACT/,
    "a filtered workbook must say on its face that its totals are not the company's totals",
  );

  // And an unfiltered one must NOT claim to be filtered.
  const whole = buildDeductionsMasterWorkbook({ meta, candidates: all, orgByCompactHrId: org });
  const wholeCover = sheetText(whole, "Cover");
  assert.doesNotMatch(wholeCover, /FILTERED EXTRACT/, "the whole-company workbook must not be labelled an extract");
  assert.match(wholeCover, /All lines/, "the whole-company workbook states its scope rather than leaving it implied");
  assert.equal(
    cellFor(whole.getWorksheet("Detailed")!, "B-999", "Line"),
    DEDUCTIONS_ORG_UNASSIGNED,
    "an employee with no directory row prints Unassigned, matching the bucket the filter files them under",
  );

  // ── 6. Provenance helpers ───────────────────────────────────────────────────
  assert.equal(describeDeductionsOrgFilter({ line: null, region: null }), null, "no filter describes as nothing");
  assert.equal(
    describeDeductionsOrgFilter({ line: "CNS", region: "Delta (2)" }),
    "Line: CNS · Region: Delta (2)",
    "both axes are named in the description the sheets carry",
  );
  assert.equal(deductionsOrgFilterSlug({ line: null, region: null }), "", "an unfiltered download keeps its plain name");
  assert.equal(
    deductionsOrgFilterSlug({ line: "CNS", region: "Delta (2)" }),
    "-cns-delta-2",
    "a filtered download carries the filter in its filename so it cannot overwrite the full month's file",
  );

  // ── 7. The route and the screen are actually wired to this ──────────────────
  const route = readFileSync("app/api/admin/deductions/export/master/route.ts", "utf8");
  assert.match(
    route,
    /filterCandidatesByOrg\(/,
    "the master export route must narrow the candidates through the shared filter, not its own copy of the rule",
  );
  assert.match(
    route,
    /orgFilterFromSearchParams\(/,
    "the master export route must read the line/region parameters",
  );
  assert.match(
    route,
    /regionName: row\.regionName/,
    "the route must resolve each employee's region, or every region filter matches nobody",
  );

  const workspace = readFileSync("src/components/admin/deductions-workspace.tsx", "utf8");
  assert.match(workspace, /&line=\$\{encodeURIComponent\(line\)\}/, "the screen must pass the line to the download");
  assert.match(workspace, /&region=\$\{encodeURIComponent\(region\)\}/, "the screen must pass the region to the download");
  assert.match(
    workspace,
    /\/api\/admin\/deductions\/filters\?monthKey=/,
    "the screen must load its dropdown options from the month's real buckets",
  );
}
