import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ExcelJS from "exceljs";

import { buildFinanceSheetWorkbook } from "../src/lib/automated-payroll/exports/finance-sheet.ts";
import type { AssembledRow } from "../src/lib/automated-payroll/assemble.ts";
import type { MonthlySalaryRun, NonEmployeePayrollRow } from "../src/lib/automated-payroll/types.ts";

/**
 * The standing Non-Employees Payroll roster (owner request 2026-08-30: "add them
 * to be fixed every month without me adding them manual"), plus the bank-details
 * half of the same request.
 *
 * Three things are pinned here, and each one failed in production before it
 * existed:
 *
 *  1. A new run seeds itself from the roster. `startOrResumeRun` must actually
 *     call the seeder — the July 2026 run's seven entries, EGP 381,535.00, were
 *     all hand-typed, and the August run opened on 2026-08-01 with none of them.
 *     A register nothing reads is worse than no register: it looks handled.
 *
 *  2. Seeding must never block a month from opening. It is wrapped in try/catch
 *     on purpose — a roster read that fails must cost a button press, not a
 *     payroll run.
 *
 *  3. The FULL finance sheet carries bank details. It was the one download
 *     finance executes a whole month from, and the only one of the four with no
 *     account numbers on it.
 *
 * 1 and 2 are asserted against the SOURCE, not by calling the function: the seed
 * path needs a live Supabase client, and a test that mocks it would pin the mock.
 * The source assertions are written against the call itself, so deleting the call
 * fails the test even though the wiring never runs here.
 */

const RUN_SERVICE_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/automated-payroll/run-service.ts", import.meta.url)),
  "utf8",
);

const RECURRING_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/automated-payroll/non-employee-recurring.ts", import.meta.url)),
  "utf8",
);

const run: MonthlySalaryRun = {
  id: "run-recurring-1",
  month: 8,
  year: 2026,
  monthKey: "2026-08",
  phase: "part1",
  part1ConfirmedAt: null,
  part1ConfirmedBy: null,
  part2ConfirmedAt: null,
  part2ConfirmedBy: null,
  publishedBatchId: null,
  publishedAt: null,
  publishedBy: null,
  createdBy: null,
  createdAt: "",
  updatedAt: "",
};

function nonEmployee(overrides: Partial<NonEmployeePayrollRow> = {}): NonEmployeePayrollRow {
  return {
    id: "ne-1",
    runId: run.id,
    part: "first",
    fullNameAr: "شخص خارج الكشوف",
    fullNameEn: "Standing Roster Person",
    totalSalary: 158487,
    bankName: "CIB",
    bankAccount: "100000000009",
    recurringId: null,
    createdBy: null,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

/** A minimal AssembledRow — only the fields the sheet writer actually reads. */
function assembledRow(): AssembledRow {
  return {
    row: {
      hrId: "B-1",
      fullName: "Real Employee",
      nameAr: "موظف",
      jobTitle: "Medical Representative",
      line: "CNS",
      area: "GZ1",
      hireDate: "2025-01-01",
      baseSalary: 10000,
      grossSalary: 12000,
      netSalary: 9000,
      monthSalary: 9000,
      firstPart: 4500,
      secondPart: 4500,
      totalDeductions: 0,
      totalAdditions: 0,
      extraCostOfLiving: 0,
      fuelAllowance: 0,
      fingerPrint: 0,
      medicalInsurance: 0,
      socialInsurance: 0,
      employmentIncomeTax: 0,
      crm: 0,
      unpaidVacations: 0,
      loans: 0,
      otherDeductions: 0,
      otherAdditions: 0,
      expenses: 0,
      incentive: 0,
      overtime: 0,
      bonus: 0,
      governmentalDeductions: 0,
      comment: null,
      paymentMode: null,
    },
    bankName: "FAB",
    bankAccount: "007111110009",
    carriedForwardApplied: 0,
    overpaidResidual: 0,
    onHold: false,
    holdReason: null,
  } as unknown as AssembledRow;
}

/** Reads a sheet's header row and body as {header: value} maps. */
async function readSheetRows(
  buffer: Buffer,
  sheetName: string,
): Promise<{ headers: string[]; rows: Record<string, ExcelJS.CellValue>[] }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.getWorksheet(sheetName);
  assert.ok(sheet, `${sheetName} sheet must exist`);

  let headerRowNumber = -1;
  let headers: string[] = [];
  sheet!.eachRow((row, rowNumber) => {
    if (headerRowNumber >= 0) return;
    const texts = Array.from(row.values as unknown[]);
    if (texts.some((value) => value === "Full Name")) {
      headerRowNumber = rowNumber;
      headers = texts.map((value) => String(value ?? ""));
    }
  });
  assert.ok(headerRowNumber > 0, "a header row containing Full Name must exist");

  const rows: Record<string, ExcelJS.CellValue>[] = [];
  sheet!.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRowNumber) return;
    const values = Array.from(row.values as unknown[]);
    const entry: Record<string, ExcelJS.CellValue> = {};
    headers.forEach((header, index) => {
      if (header) entry[header] = values[index] as ExcelJS.CellValue;
    });
    rows.push(entry);
  });
  return { headers, rows };
}

export async function runAutomatedPayrollRecurringNonEmployeesTests() {
  // ── 1. A new run seeds itself from the standing roster ─────────────────────
  assert.ok(
    RUN_SERVICE_SOURCE.includes("seedRunFromRecurring"),
    "startOrResumeRun must seed the standing roster — without this call the register exists but nothing reads it, which is exactly the state that left the August 2026 run with zero non-employees",
  );

  const createIndex = RUN_SERVICE_SOURCE.indexOf("run = await createRun({");
  const seedIndex = RUN_SERVICE_SOURCE.indexOf("seedRunFromRecurring({ runId: run.id");
  assert.ok(createIndex > 0, "startOrResumeRun must still create the run");
  assert.ok(seedIndex > createIndex, "the seed must happen AFTER the run exists, not before");

  // ── 2. Seeding must never take a payroll month down with it ────────────────
  const seedCall = RUN_SERVICE_SOURCE.slice(createIndex, seedIndex + 400);
  assert.ok(
    /try\s*\{[\s\S]*seedRunFromRecurring[\s\S]*\}\s*catch/.test(seedCall),
    "the seed must be wrapped in try/catch — a roster that cannot be read must never stop a month from opening",
  );

  // ── 3. Seeding is idempotent per (run, roster entry) ───────────────────────
  assert.ok(
    RECURRING_SOURCE.includes("alreadySeeded"),
    "seedRunFromRecurring must skip entries already on the run, so a re-sync never overwrites an amount adjusted for this month",
  );
  assert.ok(
    RECURRING_SOURCE.includes('.eq("active", true)'),
    "only ACTIVE roster entries are copied — deactivating someone is how they stop being paid, and it must actually work",
  );

  // A published or cancelled run must be refused: that money is already gone.
  assert.ok(
    RECURRING_SOURCE.includes('run.phase === "published"') &&
      RECURRING_SOURCE.includes('run.phase === "cancelled"'),
    "syncRunFromRecurring must refuse a published or cancelled run",
  );

  // ── 4. The FULL finance sheet carries bank name AND bank account ───────────
  // Owner request 2026-08-30. This scope used to pass an empty array where the
  // part1 scope passed bankExtraColumns(), so the one download finance executes
  // a whole month from was the only one with no account numbers on it.
  const fullBuffer = await buildFinanceSheetWorkbook({
    run,
    rows: [assembledRow()],
    scope: "full",
    nonEmployees: [nonEmployee({ recurringId: "roster-1" })],
  });
  const full = await readSheetRows(fullBuffer, "Payroll (Finance)");

  assert.ok(full.headers.includes("Bank Name"), "the full finance sheet must have a Bank Name column");
  assert.ok(full.headers.includes("Bank Account"), "the full finance sheet must have a Bank Account column");

  const employeeRow = full.rows.find((row) => row["Full Name"] === "Real Employee");
  assert.ok(employeeRow, "the employee must appear on the full finance sheet");
  assert.equal(employeeRow!["Bank Name"], "FAB", "an employee's bank name must reach the full finance sheet");
  assert.equal(
    employeeRow!["Bank Account"],
    "007111110009",
    "an employee's bank account must reach the full finance sheet — this is what finance wires against",
  );

  const rosterRow = full.rows.find((row) => row["Full Name"] === "Standing Roster Person");
  assert.ok(rosterRow, "a seeded non-employee must appear on the full finance sheet as a normal row");
  assert.equal(rosterRow!["Bank Name"], "CIB", "a non-employee's bank name must reach the full finance sheet too");
  assert.equal(rosterRow!["Bank Account"], "100000000009", "a non-employee's bank account must reach it as well");

  // ── 5. The Part 1 finance sheet keeps its bank columns ─────────────────────
  // It already had them; this asserts the change above widened the behaviour
  // rather than moving it.
  const part1Buffer = await buildFinanceSheetWorkbook({
    run,
    rows: [assembledRow()],
    scope: "part1",
    nonEmployees: [nonEmployee()],
  });
  const part1 = await readSheetRows(part1Buffer, "Part 1 (Finance)");
  assert.ok(part1.headers.includes("Bank Name"), "the Part 1 finance sheet must still have a Bank Name column");
  assert.ok(part1.headers.includes("Bank Account"), "the Part 1 finance sheet must still have a Bank Account column");
  assert.equal(
    part1.rows.find((row) => row["Full Name"] === "Real Employee")?.["Bank Account"],
    "007111110009",
    "the Part 1 finance sheet must still carry the account number",
  );

  // ── 6. Locked means locked: only the two Finance Edit columns open ─────────
  // Audit finding 40. The cover says "All cells locked except Finance Edit / Finance Edit Reason",
  // yet every appended column was unlocked, the bank details included, because they are appended in
  // the same list. So the account number finance wires money to was editable on a protected sheet.
  // Read back from the written file, on an employee row AND a non-employee row, because the two are
  // written by separate loops and each carried its own copy of the unlock.
  for (const [scope, buffer, sheetName] of [
    ["full", fullBuffer, "Payroll (Finance)"],
    ["part1", part1Buffer, "Part 1 (Finance)"],
  ] as const) {
    const locks = await readCellLocks(buffer, sheetName);
    assert.equal(locks.protectedSheet, true, `the ${scope} finance sheet must actually be protected`);
    for (const who of ["Real Employee", "Standing Roster Person"]) {
      // The positive control: if the reader could not see protection at all, these fail rather
      // than every "locked" assertion below passing on an absent value.
      assert.equal(locks.locked(who, "Finance Edit"), false, `${scope}: Finance Edit must stay editable for ${who}`);
      assert.equal(locks.locked(who, "Finance Edit Reason"), false, `${scope}: Finance Edit Reason must stay editable for ${who}`);
      assert.equal(locks.locked(who, "Bank Name"), true, `${scope}: Bank Name must be locked for ${who}`);
      assert.equal(
        locks.locked(who, "Bank Account"),
        true,
        `${scope}: Bank Account must be locked for ${who}, it is the number the money is wired to`,
      );
      assert.equal(locks.locked(who, "Full Name"), true, `${scope}: an ordinary payroll cell must stay locked for ${who}`);
    }
  }
}

/**
 * Reads back, from the written file, whether the sheet is protected and whether a given person's
 * cell under a given header is locked. A cell carrying no protection of its own is LOCKED in Excel,
 * so only an explicit `locked: false` reads as editable.
 */
async function readCellLocks(buffer: Buffer, sheetName: string) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.getWorksheet(sheetName);
  assert.ok(sheet, `${sheetName} sheet must exist`);

  let headerRowNumber = -1;
  const columnOf = new Map<string, number>();
  for (let rowNumber = 1; rowNumber <= sheet!.rowCount && headerRowNumber < 0; rowNumber += 1) {
    const texts = Array.from(sheet!.getRow(rowNumber).values as unknown[]);
    if (!texts.some((value) => value === "Full Name")) continue;
    headerRowNumber = rowNumber;
    texts.forEach((value, index) => {
      if (value) columnOf.set(String(value), index);
    });
  }
  assert.ok(headerRowNumber > 0, "a header row containing Full Name must exist");
  const fullNameColumn = columnOf.get("Full Name")!;

  return {
    protectedSheet: Boolean((sheet as unknown as { sheetProtection?: { sheet?: boolean } }).sheetProtection?.sheet),
    locked(fullName: string, header: string): boolean {
      const column = columnOf.get(header);
      assert.ok(column, `${sheetName} must have a ${header} column`);
      for (let rowNumber = headerRowNumber + 1; rowNumber <= sheet!.rowCount; rowNumber += 1) {
        const row = sheet!.getRow(rowNumber);
        if (row.getCell(fullNameColumn).value !== fullName) continue;
        return row.getCell(column!).protection?.locked !== false;
      }
      assert.fail(`${fullName} must have a row on ${sheetName}`);
    },
  };
}
