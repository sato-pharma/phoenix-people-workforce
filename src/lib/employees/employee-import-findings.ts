/**
 * The dry run's findings, flattened into something a person can work through.
 *
 * PURE — no ExcelJS, no renderer. Two things consume this: the "What To Fix" workbook, and the
 * import review in the browser, which shows the same findings before anyone confirms. Keeping it
 * here is what lets the client have them without pulling a spreadsheet writer into the bundle.
 */

import { columns as masterColumns } from "@/lib/employees/employee-master-columns";
import { createEmployeeColumnLookup, employeeColumnDefinitions } from "@/lib/imports/employee-column-map";
import { normalizeHeaderName } from "@/lib/imports/employee-normalizers";
import type {
  EmployeeImportIssue,
  EmployeeImportRecord,
  EmployeeImportValidationResult,
} from "@/lib/imports/employee-import-types";

/**
 * Field -> the header the TEMPLATE actually prints for it.
 *
 * Built by resolving each of the template's own column headers back through the import alias table,
 * so the two cannot drift: whatever the Employee Master sheet calls a column is what this report
 * calls it. A hand-written second map would be a third place to keep in step, and picking the
 * field's first alias — the obvious shortcut — is wrong for most of the money columns, whose first
 * alias is the snake_case database spelling: it would have told the reader to look at a column
 * called "net_salary" or "social_insurance", neither of which appears anywhere in their file.
 */
const templateHeaderByField = (() => {
  const lookup = createEmployeeColumnLookup();
  const byField = new Map<string, string>();
  for (const column of masterColumns) {
    if (!column.imported) continue;
    const field = lookup.get(normalizeHeaderName(column.header));
    if (field && !byField.has(field)) byField.set(field, column.header);
  }
  return byField;
})();

/**
 * The most readable alias for a field the template does not carry a column for.
 *
 * Prefers a spelling with a capital and no underscore — a human one — and among those the longest,
 * since "Employee Code" beats "Code" and "Net Salary" beats "Net" for someone hunting a header.
 */
function readableAlias(aliases: readonly string[]): string | null {
  const human = aliases.filter((alias) => /[A-Z]/.test(alias) && !alias.includes("_"));
  if (human.length === 0) return null;
  return human.reduce((longest, alias) => (alias.length > longest.length ? alias : longest));
}

/**
 * The column header a person will actually see for a given import field.
 *
 * An unknown field degrades to the field name rather than to a blank cell — a blank would read as
 * "no particular column", which is a different and wrong statement.
 */
export function importFieldColumnHeader(field: string | undefined): string {
  if (!field) return "—";
  const fromTemplate = templateHeaderByField.get(field);
  if (fromTemplate) return fromTemplate;
  const definition = employeeColumnDefinitions.find((candidate) => candidate.field === field);
  return (definition ? readableAlias(definition.aliases) : null) ?? field;
}

export type FixListSeverity = "Blocks the row" | "Review";

export type FixListEntry = {
  severity: FixListSeverity;
  /** Row number in the uploaded file, so it can be typed straight into Excel's name box. */
  rowNumber: number | null;
  hrId: string;
  fullName: string;
  column: string;
  code: string;
  message: string;
};

/**
 * Flattens the validation result into one row per finding.
 *
 * Errors sort above warnings and then by row, because that is the order someone works in: clear
 * what blocks the upload, then decide about the rest. A finding with no row number — a missing
 * column, say — sorts to the top of its group, since it is about the whole file rather than a row.
 */
export function buildFixListEntries(result: EmployeeImportValidationResult): FixListEntry[] {
  const byRow = new Map<number, EmployeeImportRecord>();
  const records: EmployeeImportRecord[] = [
    ...result.rowsToInsert,
    ...result.rowsToUpdate,
    ...result.vacantPositionsToCreate,
  ];
  for (const record of records) {
    if (typeof record.rowNumber === "number") byRow.set(record.rowNumber, record);
  }

  const toEntry = (issue: EmployeeImportIssue, severity: FixListSeverity): FixListEntry => {
    const record = typeof issue.rowNumber === "number" ? byRow.get(issue.rowNumber) : undefined;
    return {
      code: issue.code,
      column: importFieldColumnHeader(issue.field),
      fullName: record?.fullName ?? "—",
      hrId: record?.hrId ?? "—",
      message: issue.message,
      rowNumber: typeof issue.rowNumber === "number" ? issue.rowNumber : null,
      severity,
    };
  };

  const entries = [
    ...result.validationErrors.map((issue) => toEntry(issue, "Blocks the row")),
    ...result.validationWarnings.map((issue) => toEntry(issue, "Review")),
  ];

  return entries.sort((left, right) => {
    if (left.severity !== right.severity) return left.severity === "Blocks the row" ? -1 : 1;
    return (left.rowNumber ?? -1) - (right.rowNumber ?? -1);
  });
}
