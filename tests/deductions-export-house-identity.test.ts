import assert from "node:assert/strict";
import type ExcelJS from "exceljs";
import JSZip from "jszip";

import { checkWorkbook } from "../scripts/check-workbook-integrity.mjs";
import { isEligibleForPublish } from "../src/lib/deductions/calculations.ts";
import { buildDeductionsCategoryWorkbook } from "../src/lib/deductions/exports/category-workbook.ts";
import { buildDeductionsMasterWorkbook } from "../src/lib/deductions/exports/master-workbook.ts";
import {
  deductionsCategories,
  deductionsDecisionStatuses,
  type DeductionsCandidateWithDecision,
  type DeductionsCategory,
  type DeductionsDecisionStatus,
} from "../src/lib/deductions/types.ts";

// A deductions export is a list of money that may come out of people's pay, and the single fact a
// reader needs per row is whether THIS one actually will. That was never stated: it had to be
// inferred from a decision status plus a zero in Applied Amount — on every row, on a sheet whose
// whole subject is somebody's salary.
//
// It is not a trivial inference either. The eligible status is "Approved for Payroll", not
// "Approved"; the mandatory categories publish unless explicitly cleared, so their Pending rows DO
// deduct while everyone else's do not; and one source system always requires approval regardless of
// category, after a 131,741.94 EGP incident. Three different rules, none visible on the row.
//
// So the sheets now carry a "Will Be Deducted" column, sourced from `isEligibleForPublish` — the
// same function `publishMonth` uses. This test pins that they agree across every category and
// every decision status, because a column that says "No" against money that is in fact taken is
// worse than no column at all.

function candidate(input: {
  category: DeductionsCategory;
  status: DeductionsDecisionStatus | null;
  sourceSystem?: string;
}): DeductionsCandidateWithDecision {
  const id = `${input.category}-${input.status ?? "none"}`;
  return {
    calculationStatus: "calculated",
    candidateKey: `key-${id}`,
    category: input.category,
    createdAt: "2026-07-01T00:00:00Z",
    createdBy: "system",
    dates: ["2026-07-12"],
    decision:
      input.status === null
        ? null
        : {
            actorRoleAtDecision: null,
            appliedAmount: null,
            appliedDates: null,
            appliedValue: null,
            candidateId: id,
            createdAt: "2026-07-01T00:00:00Z",
            decidedAt: null,
            decidedBy: null,
            decisionReason: "reason",
            decisionStatus: input.status,
            hrNote: "",
            id: `d-${id}`,
            updatedAt: "2026-07-01T00:00:00Z",
          },
    employeeHrId: "A-12",
    employeeHrIdCompact: "a-12",
    employeeName: "Mohamed Mohamed ElMenshawy Abdelmatty Mohamed Ismail",
    estimatedAmount: 1450.5,
    evidence: {},
    hierarchySnapshot: {},
    id,
    lockedAt: null,
    month: 7,
    monthKey: "2026-07",
    rawValue: 2,
    reason: "Late arrival beyond grace on two days",
    refreshedAt: null,
    severity: null,
    sourceRecordId: `rec-${id}`,
    sourceSystem: input.sourceSystem ?? "fingerprint_report",
    supersededAt: null,
    supersededByCandidateId: null,
    unit: "days",
    year: 2026,
  } as unknown as DeductionsCandidateWithDecision;
}

const META = {
  generatedAtIso: "2026-08-01T00:00:00Z",
  generatedByHrId: "AA-1",
  generatedByName: "Omar Gawish",
  monthKey: "2026-07",
};

/** Header row of a sheet, found by its first cell rather than by a fixed row number. */
function headerRowOf(sheet: ExcelJS.Worksheet, firstLabel: string): number {
  let found = -1;
  sheet.eachRow((row, rowNumber) => {
    if (found < 0 && String(row.getCell(1).value ?? "").trim() === firstLabel) found = rowNumber;
  });
  assert.ok(found > 0, `a header row starting "${firstLabel}" must exist`);
  return found;
}

function columnsOf(sheet: ExcelJS.Worksheet, headerRow: number): string[] {
  return Array.from({ length: sheet.columnCount }, (_, index) =>
    String(sheet.getRow(headerRow).getCell(index + 1).value ?? "").trim(),
  );
}

/** Retired palettes — the Phoenix kit's black/orange/amber. */
const RETIRED_COLOURS = ["F97316", "FB923C", "FFEDD5", "111827"];

export async function runDeductionsExportHouseIdentityTests() {
  // ── 1. "Will Be Deducted" agrees with publish, for every category and status ──
  const statuses: Array<DeductionsDecisionStatus | null> = [null, ...deductionsDecisionStatuses];
  let sawYes = false;
  let sawNo = false;

  for (const category of deductionsCategories) {
    const candidates = statuses.map((status) => candidate({ category, status }));
    const workbook = buildDeductionsCategoryWorkbook({
      candidates,
      meta: { ...META, category } as never,
    });
    const sheet = workbook.worksheets[1];
    assert.ok(sheet, `the ${category} workbook must have a data sheet`);

    const headerRow = headerRowOf(sheet, "HR ID");
    const columns = columnsOf(sheet, headerRow);
    const deductedColumn = columns.indexOf("Will Be Deducted") + 1;
    const statusColumn = columns.indexOf("Decision Status") + 1;
    assert.ok(deductedColumn > 0, `${category}: the sheet must carry a "Will Be Deducted" column`);
    assert.ok(
      deductedColumn > statusColumn,
      "it belongs beside the decision it explains, not adrift from it",
    );

    candidates.forEach((entry, index) => {
      const row = sheet.getRow(headerRow + 1 + index);
      const printed = String(row.getCell(deductedColumn).value ?? "");
      const expected = isEligibleForPublish(entry) ? "Yes" : "No";
      assert.equal(
        printed,
        expected,
        `${category} / ${entry.decision?.decisionStatus ?? "no decision"}: the sheet says ` +
          `"${printed}" but publish would ${expected === "Yes" ? "take" : "not take"} this money`,
      );
      if (expected === "Yes") sawYes = true;
      else sawNo = true;
    });
  }

  // A check that only ever saw one answer would pass on a column hardcoded to it.
  assert.ok(sawYes, "some row must read Yes, or this proves nothing");
  assert.ok(sawNo, "some row must read No, or this proves nothing");

  // ── 2. the distinction the column exists to make ─────────────────────────────
  // "Approved" is not a real status here; the eligible one is "Approved for Payroll". Reading a
  // status string and guessing is exactly what the column removes.
  assert.equal(
    isEligibleForPublish(candidate({ category: "fingerprint", status: "Approved for Payroll" })),
    true,
  );
  assert.equal(
    isEligibleForPublish(candidate({ category: "fingerprint", status: "Pending" })),
    false,
    "a discretionary category does not deduct until someone approves it",
  );
  assert.equal(
    isEligibleForPublish(candidate({ category: "crm", status: "Pending" })),
    true,
    "a mandatory category DOES deduct while Pending — the opposite answer for the same word, " +
      "which is why the row has to say so rather than leaving it to be read off the status",
  );

  // ── 3. the master workbook carries it too, and both are clean ────────────────
  const masterWorkbook = buildDeductionsMasterWorkbook({
    candidates: deductionsCategories.map((category) =>
      candidate({ category, status: "Approved for Payroll" }),
    ),
    meta: META as never,
    orgByCompactHrId: new Map([
      ["a-12", { lineName: "CNS", managerName: "Manager One", regionName: "Cairo" }],
    ]) as never,
  });
  const detailed = masterWorkbook.getWorksheet("Detailed");
  assert.ok(detailed, "the master workbook must have a Detailed sheet");
  const detailHeader = headerRowOf(detailed, "Category");
  assert.ok(
    columnsOf(detailed, detailHeader).includes("Will Be Deducted"),
    "the master detail sheet must answer the same question as the per-category one",
  );

  const categoryBuffer = (await buildDeductionsCategoryWorkbook({
    candidates: [candidate({ category: "fingerprint", status: "Approved for Payroll" })],
    meta: { ...META, category: "fingerprint" } as never,
  }).xlsx.writeBuffer()) as ArrayBuffer;
  const masterBuffer = (await masterWorkbook.xlsx.writeBuffer()) as ArrayBuffer;

  for (const [label, buffer] of [
    ["category", categoryBuffer],
    ["master", masterBuffer],
  ] as Array<[string, ArrayBuffer]>) {
    const bytes = Buffer.from(buffer);

    const problems = await checkWorkbook(bytes, { quiet: true });
    assert.deepEqual(problems, [], `the ${label} workbook must be clean: ${problems.join("; ")}`);

    // ── 4. the retired palette is gone from the artifact, not just from the source
    const zip = await JSZip.loadAsync(bytes);
    const styles = ((await zip.file("xl/styles.xml")?.async("string")) ?? "").toUpperCase();
    assert.ok(styles.length > 0, `the ${label} workbook must have a styles part`);
    for (const colour of RETIRED_COLOURS) {
      assert.ok(
        !styles.includes(colour),
        `${label}: ${colour} is from the Phoenix kit this export no longer wears`,
      );
    }
  }
}
