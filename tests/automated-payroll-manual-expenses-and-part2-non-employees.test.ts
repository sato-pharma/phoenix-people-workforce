import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { cibRowsForNonEmployees } from "../src/lib/automated-payroll/exports/cib-sheet.ts";
import { fabRowsForNonEmployees } from "../src/lib/automated-payroll/exports/fab-sheet.ts";
import { buildFullSheetWorkbook, buildPart1SheetWorkbook } from "../src/lib/automated-payroll/exports/sheet.ts";
import { nonEmployeesForPart, sumNonEmployeePayroll } from "../src/lib/automated-payroll/non-employees.ts";
import {
  buildExpenseStepRows,
  type PayoutExpenseTrip,
  type PopulationMember,
} from "../src/lib/automated-payroll/recommend.ts";
import { STEP_DEFINITIONS } from "../src/lib/automated-payroll/step-definitions.ts";
import type {
  DraftRow,
  MonthlySalaryRun,
  NonEmployeePart,
  NonEmployeePayrollRow,
  RowLifecycle,
} from "../src/lib/automated-payroll/types.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";

/**
 * Guards the two additions the owner asked for on 2026-08-03:
 *
 *  1. The Outstation expenses step accepts an employee HR ADDS BY HAND. Someone
 *     whose trip never reached `outstation_expenses` could not be reimbursed at
 *     all, because the step's row list was built purely by iterating trips.
 *
 *     The dangerous half of that fix is persistence, not the button. A hand-typed
 *     amount lands in the SAME `expenses` draft column a recommended one uses, so
 *     assembleRows pays it either way — but if the step doesn't re-render the row
 *     on the next load, the money is on the sheet and not on the screen. That is
 *     the exact shape of the July 2026 expense-resync incident, so it is pinned
 *     here directly.
 *
 *  2. Non-Employees Payroll entries can be paid with the SECOND installment.
 *     The list shipped Part-1-only, and every consumer hardcoded that: the FAB
 *     and CIB part-2 builders returned `[]` outright, which means a second-part
 *     non-employee would have been left out of the real bank transfer file and
 *     simply not paid. `part` is now the single input to all of it.
 */

function member(hrId: string, fullName: string, lifecycle: RowLifecycle = "regular"): PopulationMember {
  return {
    employee: { hrId, fullName, hireDate: "2024-01-01" } as unknown as EmployeeDirectoryRow,
    compact: hrId.toLowerCase().replace(/[^a-z0-9]+/g, ""),
    lifecycle,
    lastWorkingDate: null,
    noticeLastWorkingDate: null,
  };
}

function trip(overrides: Partial<PayoutExpenseTrip> = {}): PayoutExpenseTrip {
  return {
    tripId: "T-1",
    expenseDate: "2026-06-10",
    toDate: "2026-06-10",
    fromLocation: "Cairo",
    toLocation: "Alexandria",
    tripType: "Field",
    transportationType: "Car",
    km: 220,
    travelCost: 400,
    meetingAmount: 0,
    allowance: 100,
    otherAmount: 0,
    total: 500,
    approvedAmount: null,
    hrApproved: true,
    hrStatus: "",
    description: "Cycle meeting",
    ...overrides,
  };
}

function draft(hrId: string, patch: Partial<DraftRow>): DraftRow {
  return {
    runId: "run-1",
    employeeHrId: hrId,
    employeeHrIdCompact: hrId.toLowerCase().replace(/[^a-z0-9]+/g, ""),
    daysWorked: null,
    baseForMonth: null,
    ecolPaid: null,
    fuelPaid: null,
    fingerprintDays: null,
    fingerprintValue: null,
    expenses: null,
    expensesNote: null,
    incentive: null,
    bonus: null,
    overtime: null,
    unpaidVacations: null,
    crm: null,
    manualOtherDeductions: null,
    manualReason: null,
    additionsReason: null,
    resignationCrmDays: null,
    p1odCrmDays: null,
    p1odCrmValue: null,
    p1odCrmReason: null,
    p1odVacationDays: null,
    p1odVacationValue: null,
    p1odVacationReason: null,
    p1odNoRecordDays: null,
    p1odNoRecordValue: null,
    p1odNoRecordReason: null,
    p1odLoanDays: null,
    p1odLoanValue: null,
    p1odLoanReason: null,
    p1odOtherDays: null,
    p1odOtherValue: null,
    p1odOtherReason: null,
    specialDeductionDays: null,
    specialDeductionValue: null,
    specialAdditionDays: null,
    specialAdditionValue: null,
    specialSituationPart: null,
    firstPartFrozen: null,
    // Not frozen: these fixtures stand before Part 1 confirm, so the live rule still answers.
    settledInPart1: null,
    onHold: false,
    holdReason: null,
    excluded: false,
    excludedReason: null,
    source: "inline",
    editedBy: null,
    updatedAt: "",
    ...patch,
  };
}

function drafts(...rows: DraftRow[]): Map<string, DraftRow> {
  return new Map(rows.map((row) => [row.employeeHrIdCompact, row]));
}

function nonEmployee(overrides: {
  fullNameEn?: string;
  totalSalary?: number;
  bankName?: string | null;
  bankAccount?: string | null;
  part?: NonEmployeePart;
}): NonEmployeePayrollRow {
  return {
    id: overrides.fullNameEn ?? "id",
    runId: "run-1",
    part: overrides.part ?? "first",
    fullNameAr: "اسم",
    fullNameEn: overrides.fullNameEn ?? "Person",
    totalSalary: overrides.totalSalary ?? 1000,
    bankName: overrides.bankName === undefined ? "FAB" : overrides.bankName,
    bankAccount: overrides.bankAccount === undefined ? "007111110001" : overrides.bankAccount,
    recurringId: null,
    createdBy: null,
    createdAt: "",
    updatedAt: "",
  };
}

const run: MonthlySalaryRun = {
  id: "run-1",
  month: 7,
  year: 2026,
  monthKey: "2026-07",
  phase: "part2",
  part1ConfirmedAt: "2026-07-25T00:00:00Z",
  part1ConfirmedBy: "admin",
  part2ConfirmedAt: null,
  part2ConfirmedBy: null,
  publishedBatchId: null,
  publishedAt: null,
  publishedBy: null,
  createdBy: null,
  createdAt: "",
  updatedAt: "",
};

export async function runAutomatedPayrollManualExpensesAndPart2NonEmployeesTests() {
  const withTrips = member("B-1", "Has Real Trips");
  const added = member("B-2", "Added By Hand");
  const untouched = member("B-3", "Nothing To Pay");
  const members = [withTrips, added, untouched];
  const tripMap = new Map<string, PayoutExpenseTrip[]>([[withTrips.compact, [trip(), trip({ tripId: "T-2", total: 300 })]]]);

  // ---- the step must offer the hand-added row at all ------------------------
  assert.equal(
    STEP_DEFINITIONS.p2_expenses.allowsManualRows,
    true,
    "the outstation expenses step is the one step HR may add an employee to by hand",
  );
  assert.ok(
    STEP_DEFINITIONS.p2_expenses.fields.some((field) => field.key === "expensesNote" && field.kind === "text"),
    "a manually added amount has no trip behind it, so the step must carry a free-text note column",
  );
  // Held Salary Release is the one other step (owner, 2026-10-26): someone held at Part 1 and released by
  // Part 2 last month is on no held list, so HR adds them to record the Part 1 they were never paid. The
  // figure is not free — it is refused above that person's frozen Part 1 on the earlier run.
  assert.equal(STEP_DEFINITIONS.p2_held_release.allowsManualRows, true);
  const heldSettlements = readFileSync("src/lib/automated-payroll/held-settlements.ts", "utf8");
  const recorder = heldSettlements.slice(heldSettlements.indexOf("export async function recordPart1Corrections"));
  assert.match(
    recorder.slice(0, recorder.indexOf("\nexport ")),
    /\.select\("employee_hr_id_compact,first_part_frozen"\)/,
    "a hand-added Part 1 Not Paid is checked against the frozen Part 1 of the month it is recorded against",
  );
  for (const [key, definition] of Object.entries(STEP_DEFINITIONS)) {
    if (key === "p2_expenses" || key === "p2_held_release") continue;
    assert.notEqual(
      definition.allowsManualRows,
      true,
      `${key} derives its figure from employment facts — a hand-added employee there would be a wrong number nobody could notice`,
    );
  }

  // ---- nothing saved yet: only the feeder's own employee is listed ----------
  const untouchedRows = buildExpenseStepRows(members, tripMap, drafts());
  assert.deepEqual(
    untouchedRows.map((row) => row.hrId),
    ["B-1"],
    "with no manual entries, the step lists exactly who the expense feeder produced — unchanged behaviour",
  );
  assert.equal(untouchedRows[0].values.expenses, 800, "the feeder row still sums its own trips (500 + 300)");
  assert.equal(untouchedRows[0].manual, undefined, "a feeder row is never labelled manual");

  // ---- THE HEADLINE: a hand-typed amount survives the reload ----------------
  const afterAdding = buildExpenseStepRows(
    members,
    tripMap,
    drafts(draft("B-2", { expenses: 450, expensesNote: "Receipt handed to HR, never uploaded" })),
  );
  const manualRow = afterAdding.find((row) => row.hrId === "B-2");
  assert.ok(
    manualRow,
    "an employee with a saved expense and no trips MUST re-render — assembleRows pays that draft column, so a missing row is money on the sheet with nothing on screen",
  );
  assert.equal(manualRow!.values.expenses, 450, "the hand-typed figure is what reloads, not a recomputed one");
  assert.equal(manualRow!.manual, true, "the row is labelled manual so HR can see the figure was typed, not derived");
  assert.equal(
    manualRow!.recommended.expenses,
    0,
    "the system recommended nothing here — presenting the typed figure as a recommendation would make it look verified",
  );
  assert.equal(manualRow!.reasons?.expensesNote, "Receipt handed to HR, never uploaded", "the note reloads with it");
  assert.equal(manualRow!.context.Trips, 0, "a manual row honestly shows zero trips rather than a blank");
  assert.equal(
    afterAdding.map((row) => row.hrId).indexOf("B-2"),
    afterAdding.length - 1,
    "manual rows sort after the feeder's own, so they are easy to pick out",
  );
  assert.ok(
    !afterAdding.some((row) => row.hrId === "B-3"),
    "an employee with no trips and no saved amount is still left off — this must not become a list of everybody",
  );

  // ---- removing = zero. It must stop being listed, not linger at 0 ----------
  const afterRemoving = buildExpenseStepRows(members, tripMap, drafts(draft("B-2", { expenses: 0 })));
  assert.ok(
    !afterRemoving.some((row) => row.hrId === "B-2"),
    "zeroing a manual row is how HR removes it — nothing is left to pay, so nothing is listed",
  );

  // ---- but a zero on a TRIP-BACKED row means something different ------------
  const refusedTrips = buildExpenseStepRows(members, tripMap, drafts(draft("B-1", { expenses: 0 })));
  assert.ok(
    refusedTrips.some((row) => row.hrId === "B-1"),
    "HR refusing real trips must keep the row visible — the trips still exist and the decision has to stay reviewable",
  );

  // ---- a manual row for someone who LATER gets trips isn't duplicated -------
  const bothSources = buildExpenseStepRows(
    members,
    new Map([...tripMap, [added.compact, [trip({ tripId: "T-9", total: 200 })]]]),
    drafts(draft("B-2", { expenses: 450 })),
  );
  assert.equal(
    bothSources.filter((row) => row.hrId === "B-2").length,
    1,
    "once trips arrive for a previously-manual employee, they must appear once — not once per source",
  );
  assert.equal(
    bothSources.find((row) => row.hrId === "B-2")!.values.expenses,
    450,
    "and HR's saved figure still wins over the newly-arrived recommendation, same as every other row",
  );

  // ---- Non-Employees Payroll: the part filter -------------------------------
  const firstPerson = nonEmployee({ fullNameEn: "Paid With Part 1", totalSalary: 1000, part: "first" });
  const secondPerson = nonEmployee({ fullNameEn: "Paid With Part 2", totalSalary: 2000, part: "second" });
  const cibSecondPerson = nonEmployee({
    fullNameEn: "CIB Part 2",
    totalSalary: 750,
    part: "second",
    bankName: "CIB",
    bankAccount: "100222220001",
  });
  const all = [firstPerson, secondPerson, cibSecondPerson];

  assert.deepEqual(
    nonEmployeesForPart(all, "first").map((entry) => entry.fullNameEn),
    ["Paid With Part 1"],
  );
  assert.deepEqual(
    nonEmployeesForPart(all, "second").map((entry) => entry.fullNameEn),
    ["Paid With Part 2", "CIB Part 2"],
  );
  assert.equal(sumNonEmployeePayroll(all), 3750, "the sum is over whatever list it is handed, part-agnostic");

  // ---- THE HEADLINE: the Part 2 BANK FILE must actually pay them ------------
  const fabPart2 = fabRowsForNonEmployees(all, "part2");
  assert.deepEqual(
    fabPart2.map((row) => row.fullName),
    ["Paid With Part 2"],
    "a second-installment non-employee must reach the FAB part-2 transfer file — this returned [] before, so they were never paid",
  );
  assert.equal(fabPart2[0].salary, 2000);
  assert.deepEqual(
    fabRowsForNonEmployees(all, "part1").map((row) => row.fullName),
    ["Paid With Part 1"],
    "and a first-installment one must NOT be paid twice by appearing in both files",
  );
  assert.deepEqual(
    cibRowsForNonEmployees(all, "part2").map((row) => row.fullName),
    ["CIB Part 2"],
    "CIB follows the same rule as FAB",
  );
  assert.deepEqual(cibRowsForNonEmployees(all, "part1"), [], "no CIB-bank first-part non-employee in this fixture");
  assert.deepEqual(
    fabRowsForNonEmployees([nonEmployee({ totalSalary: 0, part: "second" })], "part2"),
    [],
    "a zero amount is still excluded from a bank file, part or no part",
  );

  // ---- the sheets: Part 1 pays first only, the full sheet shows both --------
  const part1Buffer = await buildPart1SheetWorkbook({
    run,
    rows: [],
    nonEmployees: nonEmployeesForPart(all, "first"),
  });
  const part1Text = await sheetText(part1Buffer, "Part 1");
  assert.ok(part1Text.includes("Paid With Part 1"), "the Part 1 sheet lists first-installment non-employees");
  assert.ok(
    !part1Text.includes("Paid With Part 2"),
    "and must not list a Part 2 one — finance executes this sheet for the first installment",
  );

  const fullBuffer = await buildFullSheetWorkbook({ run, rows: [], nonEmployees: all });
  const fullText = await sheetText(fullBuffer, "Payroll");
  assert.ok(
    fullText.includes("Paid With Part 1") && fullText.includes("Paid With Part 2"),
    "the full sheet is the month's complete picture, so it carries both installments' non-employees",
  );
}

/** Every cell of one worksheet flattened to a single string — enough to assert who is and isn't listed. */
async function sheetText(buffer: Buffer, sheetName: string): Promise<string> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.getWorksheet(sheetName);
  assert.ok(sheet, `${sheetName} sheet must exist`);
  const parts: string[] = [];
  sheet!.eachRow((row) => {
    row.eachCell({ includeEmpty: false }, (cell) => parts.push(String(cell.value ?? "")));
  });
  return parts.join("|");
}
