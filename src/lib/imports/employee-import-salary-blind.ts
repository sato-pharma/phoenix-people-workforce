import { createEmployeeColumnLookup } from "@/lib/imports/employee-column-map";
import type {
  EmployeeImportField,
  EmployeeImportRecord,
  RawEmployeeImportRow,
} from "@/lib/imports/employee-import-types";
import { normalizeHeaderName, normalizeTextValue } from "@/lib/imports/employee-normalizers";

/**
 * THE EMPLOYEE IMPORT FOR A SEAT THAT NEVER SEES A SALARY — the HR Operations Specialist
 * (isSalaryBlindRole in src/lib/auth/hr-functions.ts).
 *
 * The owner gave that seat "Employee Master import and export, all with no salary" (2026-10-20).
 * Her export arrives with every money column hidden and empty, so a round trip of her own file
 * carries no figure at all — and that is the only shape this import accepts from her:
 *
 *   1. A FILLED MONEY CELL REFUSES THE WHOLE FILE, naming the columns. Never a per-row skip: a file
 *      with salaries in it did not come from her export, and quietly importing the rest of it would
 *      teach her that a figure she typed was taken.
 *   2. NO MONEY IS COMPUTED, WRITTEN OR REPORTED. The validator skips its position-policy step for
 *      her (it forces fuel and cost of living onto EVERY row, blank or not, and prints the amounts in
 *      its warnings), and the plan she gets back carries no figure.
 *
 *   3. PAYMENT MODE, PAYROLL ELIGIBLE AND EMPLOYMENT STATUS ARE NEVER CHANGED BY HER (owner,
 *      2026-10-20: "can change bank account but never a paymode"; payroll eligible decides whether
 *      the person is paid at all, and an inactive status turns it off, so both are held the same
 *      way). A cell equal to the master's value is ignored, a cell that differs blocks its row in
 *      plain words (src/lib/employees/salary-blind-pay-flags.ts), and none of the three is ever
 *      written from her file (withoutPayFlags, at the plan and again at the write).
 *
 * All three are decided from the SERVER's access context, never from anything the browser sends.
 * Bank name, bank account and has-bank-account are not money and import as they always have.
 *
 * A separate rule rides beside these, keyed on `employees:create` rather than on this seat: an
 * importer who may not add an employee gets a row-level refusal for every Employee ID that is not
 * already in the master (NEW_EMPLOYEE_NOT_ALLOWED_CODE), instead of an insert.
 */

/** The nine money fields the importer reads. "Social Insurance Wage" is never read, so it is not here. */
export const MONEY_IMPORT_FIELDS = [
  "basicSalary",
  "baseSalary",
  "grossSalary",
  "netSalary",
  "fuelAllowance",
  "extraCostOfLiving",
  "medicalInsurance",
  "socialInsurance",
  "taxes",
] as const satisfies readonly EmployeeImportField[];

const MONEY_IMPORT_FIELD_SET: ReadonlySet<EmployeeImportField> = new Set<EmployeeImportField>(MONEY_IMPORT_FIELDS);

/** The code both the refusal and the workbook's Upload Rules sheet print. */
export const SALARY_BLIND_MONEY_COLUMNS_CODE = "salary_columns_not_allowed";

/** A row whose Employee ID is not in the master, from an importer without `employees:create`. */
export const NEW_EMPLOYEE_NOT_ALLOWED_CODE = "new_employee_not_allowed";

/**
 * Every header in the file that the importer would read as a money field and that holds a value in
 * at least one row — in the order the file has them.
 *
 * EVERY matching header, not just the first: the validator keeps only the first header per field,
 * so a second "Base Salary" column would be ignored by the write — and must still not slip past
 * this check, because the point of it is that no figure travels with her file at all.
 */
export function filledMoneyColumnHeaders(rows: RawEmployeeImportRow[]): string[] {
  const lookup = createEmployeeColumnLookup();
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const header of Object.keys(row)) {
      if (seen.has(header)) continue;
      seen.add(header);
      const field = lookup.get(normalizeHeaderName(header));
      if (field && MONEY_IMPORT_FIELD_SET.has(field)) headers.push(header);
    }
  }
  return headers.filter((header) => rows.some((row) => normalizeTextValue(row[header]) !== null));
}

/**
 * The whole-file refusal for the salary-blind seat, or null when her file carries no figure.
 * Each of the three import routes (dry run, fix list, confirm) answers with this before planning.
 */
export function salaryBlindImportRefusal(
  rows: RawEmployeeImportRow[],
): { error: typeof SALARY_BLIND_MONEY_COLUMNS_CODE; filledColumns: string[]; message: string } | null {
  const filledColumns = filledMoneyColumnHeaders(rows);
  if (filledColumns.length === 0) return null;
  return {
    error: SALARY_BLIND_MONEY_COLUMNS_CODE,
    filledColumns,
    message: `This seat cannot import salary figures — clear these columns: ${filledColumns.join(", ")}.`,
  };
}

/**
 * True when this raw row carries a value in a money column. The validator's row-level backstop for
 * the same rule, so a row with a figure is blocked even if a caller skipped the file-level refusal.
 */
export function rowHasMoneyValue(row: RawEmployeeImportRow): boolean {
  const lookup = createEmployeeColumnLookup();
  return Object.keys(row).some((header) => {
    const field = lookup.get(normalizeHeaderName(header));
    return Boolean(field && MONEY_IMPORT_FIELD_SET.has(field) && normalizeTextValue(row[header]) !== null);
  });
}

/**
 * Blank payment mode and payroll eligible on a planned row, so nothing her file holds in either
 * column is written. Null is "the cell was left blank" to every writer: the confirm route writes
 * payment_mode only for a non-null mode and payroll_eligible only for a recognised word (or a new
 * hire, which she cannot add), and the change preview shows no line for a blank.
 */
export function withoutPayFlags(
  record: Pick<EmployeeImportRecord, "compensation" | "employmentStatus" | "payrollEligible">,
): void {
  record.compensation = { ...record.compensation, paymentMode: null };
  record.payrollEligible = null;
  // A blank status is "keep what the master holds": the write sets employment_status only when the
  // row carries one (imports/employees/confirm). An inactive status would turn pay off with it.
  record.employmentStatus = null;
}

/** Blank every money figure on a planned row. Payment mode is not money; withoutPayFlags holds it. */
export function withoutMoney<T extends Pick<EmployeeImportRecord, "compensation">>(record: T): T {
  record.compensation = {
    ...record.compensation,
    baseSalary: null,
    basicSalary: null,
    extraCostOfLiving: null,
    fuelAllowance: null,
    grossSalary: null,
    medicalInsurance: null,
    netSalary: null,
    socialInsurance: null,
    taxes: null,
  };
  return record;
}
