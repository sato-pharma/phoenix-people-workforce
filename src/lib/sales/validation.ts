import type { SalesRecordInput, SalesValidationState, TargetRecord } from "@/lib/sales/types";

const salesColumnAliases = {
  employeeHrId: ["HR_ID", "hr_id", "Employee HR ID", "employee_hr_id"],
  employeeCrmId: ["CRM_ID", "Employee CRM ID", "employee_crm_id"],
  employeeLookupKey: ["CRM Username", "crm_username", "employee_lookup_key", "D.M."],
  employeeName: ["Employee Name", "employee_name", "D.M."],
  line: ["Line", "line"],
  territory: ["Sys", "Territory", "territory"],
  salesType: ["Type of Sales", "sales_type"],
  family: ["Family", "family"],
  product: ["PRODUCT", "Product", "product"],
  factoryPrice: ["Factory Price", "factory_price"],
  month: ["Month", "month"],
  year: ["Year", "year"],
  salesUnits: ["Sales Units", "sales_units"],
  salesValue: ["Sales Value", "sales_value"],
  targetUnits: ["Target Units", "target_units"],
  targetValue: ["Target Value", "target_value"],
} as const;

const targetColumnAliases = {
  employeeHrId: ["HR_ID", "hr_id", "Employee HR ID", "employee_hr_id"],
  employeeCrmId: ["CRM_ID", "Employee CRM ID", "employee_crm_id"],
  employeeLookupKey: ["CRM Username", "crm_username", "employee_lookup_key"],
  employeeName: ["Employee Name", "employee_name", "Full Name"],
  line: ["Line", "line"],
  month: ["Month", "month"],
  year: ["Year", "year"],
  targetUnits: ["Target Units", "target_units"],
  targetValue: ["Target Value", "target_value"],
} as const;

const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const VALUE_MISMATCH_RATIO = 0.03;
const VALUE_MISMATCH_FLOOR = 1;

function firstValue(row: Record<string, unknown>, aliases: readonly string[]) {
  for (const alias of aliases) {
    if (alias in row) return row[alias];
  }
  return null;
}

export function normalizeNumber(value: unknown) {
  if (value && typeof value === "object" && "result" in value) {
    return normalizeNumber((value as { result?: unknown }).result);
  }
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  const parsed = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function normalizeString(value: unknown) {
  const text = String(value ?? "").trim();
  return text || null;
}

export function normalizeMonth(value: unknown) {
  if (typeof value === "number") {
    return value >= 1 && value <= 12 ? value : 0;
  }

  const text = String(value ?? "").trim();
  if (!text) return 0;
  const numeric = Number(text);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 12) return numeric;
  const monthIndex = monthNames.findIndex((month) => month === text.slice(0, 3).toLowerCase());
  return monthIndex >= 0 ? monthIndex + 1 : 0;
}

function buildValidationState(messages: string[]) {
  return messages.some((message) => message.startsWith("FAIL:"))
    ? ("failed" as SalesValidationState)
    : messages.length > 0
      ? ("warning" as SalesValidationState)
      : ("valid" as SalesValidationState);
}

function hasRowData(values: unknown[]) {
  return values.some((value) => String(value ?? "").trim() !== "");
}

function hasMaterialValueGap(actual: number, expected: number) {
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false;
  const tolerance = Math.max(Math.abs(expected) * VALUE_MISMATCH_RATIO, VALUE_MISMATCH_FLOOR);
  return Math.abs(actual - expected) > tolerance;
}

function hasRawValue(value: unknown) {
  if (value && typeof value === "object" && "result" in value) {
    return hasRawValue((value as { result?: unknown }).result);
  }
  return String(value ?? "").trim() !== "";
}

function exactColumnLabel(aliases: readonly string[]) {
  return aliases[0];
}

function requireSheetValue(
  row: Record<string, unknown>,
  aliases: readonly string[],
  rowNumber: number,
  validationNotes: string[]
) {
  const value = firstValue(row, aliases);
  if (!hasRawValue(value)) {
    validationNotes.push(
      `FAIL: Row ${rowNumber}, column "${exactColumnLabel(aliases)}" is empty or missing, so the system would import a lower total than the sheet.`
    );
  }
}

export function parseSalesRow(row: Record<string, unknown>, fallbackLine: string, rowNumber: number) {
  const validationNotes: string[] = [];
  [
    salesColumnAliases.employeeLookupKey,
    salesColumnAliases.territory,
    salesColumnAliases.salesType,
    salesColumnAliases.family,
    salesColumnAliases.product,
    salesColumnAliases.factoryPrice,
    salesColumnAliases.month,
    salesColumnAliases.year,
    salesColumnAliases.salesUnits,
    salesColumnAliases.salesValue,
    salesColumnAliases.targetUnits,
  ].forEach((aliases) => requireSheetValue(row, aliases, rowNumber, validationNotes));

  const record: SalesRecordInput = {
    rowNumber,
    employeeHrId: normalizeString(firstValue(row, salesColumnAliases.employeeHrId)),
    employeeCrmId: normalizeString(firstValue(row, salesColumnAliases.employeeCrmId)),
    employeeLookupKey: normalizeString(firstValue(row, salesColumnAliases.employeeLookupKey)),
    employeeName: normalizeString(firstValue(row, salesColumnAliases.employeeName)),
    line: normalizeString(firstValue(row, salesColumnAliases.line)) || fallbackLine,
    territory: normalizeString(firstValue(row, salesColumnAliases.territory)) || "Unassigned",
    salesType: normalizeString(firstValue(row, salesColumnAliases.salesType)) || "Unknown",
    family: normalizeString(firstValue(row, salesColumnAliases.family)) || "Unknown",
    product: normalizeString(firstValue(row, salesColumnAliases.product)) || "Unknown",
    factoryPrice: normalizeNumber(firstValue(row, salesColumnAliases.factoryPrice)),
    month: normalizeMonth(firstValue(row, salesColumnAliases.month)),
    year: Number(normalizeString(firstValue(row, salesColumnAliases.year)) || 0),
    salesUnits: normalizeNumber(firstValue(row, salesColumnAliases.salesUnits)),
    salesValue: normalizeNumber(firstValue(row, salesColumnAliases.salesValue)),
    targetUnits: normalizeNumber(firstValue(row, salesColumnAliases.targetUnits)),
    targetValue: 0,
    validationState: "valid",
    validationNotes,
  };

  if (!record.line) validationNotes.push("FAIL: Cannot import this sales row because Line is missing.");
  if (!record.month) validationNotes.push("FAIL: Cannot import this sales row because Month is missing or invalid.");
  if (!record.year || record.year < 2000) validationNotes.push("FAIL: Cannot import this sales row because Year is missing or invalid.");
  if (!Number.isFinite(record.salesUnits)) validationNotes.push("FAIL: Cannot import this sales row because Sales Units is not numeric.");
  if (!Number.isFinite(record.salesValue)) validationNotes.push("FAIL: Cannot import this sales row because Sales Value is not numeric.");
  if (!Number.isFinite(record.targetUnits)) validationNotes.push("FAIL: Cannot import this sales row because Target Units is not numeric.");

  record.targetValue =
    Number.isFinite(record.targetUnits) && Number.isFinite(record.factoryPrice)
      ? record.targetUnits * record.factoryPrice
      : Number.NaN;

  if (!record.employeeHrId && !record.employeeCrmId && !record.employeeLookupKey) {
    validationNotes.push("WARN: This sales row has no employee linkage key, so the system will try to import it but cannot connect it to a People Ops employee yet.");
  }
  if (record.product === "Unknown") validationNotes.push("WARN: Product is missing in this sales row.");
  if (record.family === "Unknown") validationNotes.push("WARN: Family is missing in this sales row.");
  if (!Number.isFinite(record.factoryPrice) || record.factoryPrice <= 0) validationNotes.push("WARN: Factory Price is missing or zero in this sales row.");

  if (Number.isFinite(record.salesUnits) && Number.isFinite(record.factoryPrice) && record.factoryPrice > 0) {
    const expectedSalesValue = record.salesUnits * record.factoryPrice;
    if (hasMaterialValueGap(record.salesValue, expectedSalesValue)) {
      validationNotes.push(
        `FAIL: Row ${rowNumber}, column "Sales Value" does not reconcile with Sales Units x Factory Price. Sheet value ${record.salesValue} vs expected ${expectedSalesValue}.`
      );
    }
    if (record.salesValue + VALUE_MISMATCH_FLOOR < expectedSalesValue) {
      validationNotes.push(
        `FAIL: Row ${rowNumber}, column "Sales Value" would make system sales lower than the sheet math. Sheet value ${record.salesValue}, expected at least ${expectedSalesValue}.`
      );
    }
  }

  if (Number.isFinite(record.targetUnits) && Number.isFinite(record.factoryPrice) && record.factoryPrice > 0) {
    const expectedTargetValue = record.targetUnits * record.factoryPrice;
    const sheetTargetValue = normalizeNumber(firstValue(row, salesColumnAliases.targetValue));
    if (Number.isFinite(sheetTargetValue) && hasRawValue(firstValue(row, salesColumnAliases.targetValue))) {
      if (hasMaterialValueGap(sheetTargetValue, expectedTargetValue)) {
        validationNotes.push(
          `WARN: Row ${rowNumber}, column "Target Value" differs from Target Units x Factory Price. The dashboard will use ${expectedTargetValue}.`
        );
      }
    }
  }

  record.validationState = buildValidationState(validationNotes);
  return record;
}

export function parseTargetRow(row: Record<string, unknown>) {
  const validationNotes: string[] = [];
  const month = normalizeMonth(firstValue(row, targetColumnAliases.month));
  const year = Number(normalizeString(firstValue(row, targetColumnAliases.year)) || 0);
  const targetUnits = normalizeNumber(firstValue(row, targetColumnAliases.targetUnits));
  const targetValue = normalizeNumber(firstValue(row, targetColumnAliases.targetValue));
  const status = buildValidationState(validationNotes);

  const record: TargetRecord = {
    id: crypto.randomUUID(),
    batchId: "",
    employeeHrId: normalizeString(firstValue(row, targetColumnAliases.employeeHrId)),
    employeeCrmId: normalizeString(firstValue(row, targetColumnAliases.employeeCrmId)),
    employeeLookupKey: normalizeString(firstValue(row, targetColumnAliases.employeeLookupKey)),
    employeeName: normalizeString(firstValue(row, targetColumnAliases.employeeName)),
    line: normalizeString(firstValue(row, targetColumnAliases.line)) || "Unassigned",
    month,
    year,
    targetUnits,
    targetValue,
    status,
    validationNotes,
    createdAt: new Date().toISOString(),
  };

  const targetRowHasAnyBusinessData = hasRowData([
    firstValue(row, targetColumnAliases.employeeHrId),
    firstValue(row, targetColumnAliases.employeeCrmId),
    firstValue(row, targetColumnAliases.employeeLookupKey),
    firstValue(row, targetColumnAliases.employeeName),
    firstValue(row, targetColumnAliases.line),
    firstValue(row, targetColumnAliases.month),
    firstValue(row, targetColumnAliases.year),
    firstValue(row, targetColumnAliases.targetUnits),
    firstValue(row, targetColumnAliases.targetValue),
  ]);

  if (!targetRowHasAnyBusinessData) {
    validationNotes.push("FAIL: Cannot import this target row because it is empty.");
  }
  if (!record.employeeHrId && !record.employeeCrmId && !record.employeeLookupKey) {
    validationNotes.push("FAIL: Cannot import this target row because employee_hr_id, employee_crm_id, and employee_lookup_key are all empty.");
  }
  if (!month) validationNotes.push("FAIL: Cannot import this target row because Month is missing or invalid.");
  if (!year || year < 2000) validationNotes.push("FAIL: Cannot import this target row because Year is missing or invalid.");
  if (!Number.isFinite(targetUnits)) validationNotes.push("FAIL: Cannot import this target row because Target Units is not numeric.");
  if (!Number.isFinite(targetValue)) validationNotes.push("FAIL: Cannot import this target row because Target Value is not numeric.");

  record.status = buildValidationState(validationNotes);
  return record;
}
