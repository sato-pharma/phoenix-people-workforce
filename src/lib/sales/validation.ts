import { needsAGuess, normalizeNumberText, twoReadings } from "@/lib/sales/normalizer/number-text";
import type { SalesRecordInput, SalesValidationState } from "@/lib/sales/types";

const salesColumnAliases = {
  employeeHrId: ["HR_ID", "hr_id", "HR ID", "hr id", "Employee HR ID", "employee_hr_id"],
  employeeCrmId: ["CRM_ID", "Employee CRM ID", "employee_crm_id"],
  employeeLookupKey: ["CRM Username", "crm_username", "employee_lookup_key", "D.M."],
  employeeName: ["Employee Name", "employee_name", "D.M."],
  line: ["Line", "line"],
  managerHrId: ["manager hr id", "Manager HR ID", "manager_hr_id", "DSM HR ID", "dsm_hr_id"],
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
  // The forms with ONE meaning are read the way the monthly engine reads them (Arabic-Indic digits,
  // the minus sign, "1.234,56"), and a text with TWO readings is refused: this used to strip every
  // comma, so "12,5" was imported as 125 with nothing said (audit 2026-10-23, the old sales upload).
  const text = normalizeNumberText(String(value));
  if (needsAGuess(text)) return Number.NaN;
  const parsed = Number(text.replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/**
 * The FAIL note for a number cell held as text with two readings, or null when it has at most one.
 * Named by row and column, with both readings, so the person fixing the sheet knows what to type.
 */
export function ambiguousNumberNote(raw: unknown, rowNumber: number, column: string): string | null {
  const unwrapped = raw && typeof raw === "object" && "result" in raw ? (raw as { result?: unknown }).result : raw;
  if (typeof unwrapped !== "string") return null;
  const text = normalizeNumberText(unwrapped);
  if (!needsAGuess(text)) return null;
  const readings = twoReadings(text);
  const meaning = readings ? `, which could be ${readings[0]} or ${readings[1]}` : ", which is not one number";
  return `FAIL: Row ${rowNumber}, column "${column}" reads "${unwrapped.trim()}"${meaning}. Write it as one plain number and upload again.`;
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

export function buildValidationState(messages: string[]) {
  return messages.some((message) => message.startsWith("FAIL:"))
    ? ("failed" as SalesValidationState)
    : messages.length > 0
      ? ("warning" as SalesValidationState)
      : ("valid" as SalesValidationState);
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

export function parseSalesRow(
  row: Record<string, unknown>,
  fallbackLine: string,
  rowNumber: number,
  options?: { skipFactoryPrice?: boolean }
) {
  const validationNotes: string[] = [];
  const requiredFields: readonly (readonly string[])[] = [
    salesColumnAliases.territory,
    salesColumnAliases.salesType,
    salesColumnAliases.family,
    salesColumnAliases.product,
    salesColumnAliases.month,
    salesColumnAliases.year,
    salesColumnAliases.salesUnits,
    salesColumnAliases.salesValue,
    ...(options?.skipFactoryPrice ? [] : [salesColumnAliases.factoryPrice]),
  ];
  requiredFields.forEach((aliases) => requireSheetValue(row, aliases, rowNumber, validationNotes));

  const rawTargetUnits = firstValue(row, salesColumnAliases.targetUnits);
  const rawTargetValue = firstValue(row, salesColumnAliases.targetValue);
  const sheetTargetValue = normalizeNumber(rawTargetValue);
  const targetUnitsHasValue = hasRawValue(rawTargetUnits);
  const targetValueHasValue = hasRawValue(rawTargetValue);
  const parsedTargetUnits = normalizeNumber(rawTargetUnits);

  const record: SalesRecordInput = {
    rowNumber,
    employeeHrId: normalizeString(firstValue(row, salesColumnAliases.employeeHrId)),
    employeeCrmId: normalizeString(firstValue(row, salesColumnAliases.employeeCrmId)),
    employeeLookupKey: normalizeString(firstValue(row, salesColumnAliases.employeeLookupKey)),
    employeeName: normalizeString(firstValue(row, salesColumnAliases.employeeName)),
    line: normalizeString(firstValue(row, salesColumnAliases.line)) || fallbackLine,
    managerHrId: normalizeString(firstValue(row, salesColumnAliases.managerHrId)),
    territory: normalizeString(firstValue(row, salesColumnAliases.territory)) || "Unassigned",
    salesType: normalizeString(firstValue(row, salesColumnAliases.salesType)) || "Unknown",
    family: normalizeString(firstValue(row, salesColumnAliases.family)) || "Unknown",
    product: normalizeString(firstValue(row, salesColumnAliases.product)) || "Unknown",
    factoryPrice: normalizeNumber(firstValue(row, salesColumnAliases.factoryPrice)),
    month: normalizeMonth(firstValue(row, salesColumnAliases.month)),
    year: Number(normalizeString(firstValue(row, salesColumnAliases.year)) || 0),
    salesUnits: normalizeNumber(firstValue(row, salesColumnAliases.salesUnits)),
    salesValue: normalizeNumber(firstValue(row, salesColumnAliases.salesValue)),
    targetUnits: targetUnitsHasValue ? parsedTargetUnits : 0,
    targetValue: 0,
    validationState: "valid",
    validationNotes,
  };

  const hasIdentityKey = Boolean(record.employeeHrId || record.employeeCrmId || record.employeeLookupKey);
  if (!hasIdentityKey && !record.employeeName) {
    validationNotes.push(
      `FAIL: Row ${rowNumber} has no HR ID, CRM ID, lookup key, or employee name, so the system cannot attribute this sales row safely.`
    );
  }

  if (!record.line) validationNotes.push("FAIL: Cannot import this sales row because Line is missing.");
  if (!record.month) validationNotes.push("FAIL: Cannot import this sales row because Month is missing or invalid.");
  if (!record.year || record.year < 2000) validationNotes.push("FAIL: Cannot import this sales row because Year is missing or invalid.");
  // A number written so that it has two readings is named with both, rather than as "not numeric".
  const ambiguous = new Map<string, string>();
  for (const [aliases, label] of [
    [salesColumnAliases.factoryPrice, "Factory Price"],
    [salesColumnAliases.salesUnits, "Sales Units"],
    [salesColumnAliases.salesValue, "Sales Value"],
    [salesColumnAliases.targetUnits, "Target Units"],
    [salesColumnAliases.targetValue, "Target Value"],
  ] as const) {
    const note = ambiguousNumberNote(firstValue(row, aliases), rowNumber, exactColumnLabel(aliases));
    if (note) {
      ambiguous.set(label, note);
      validationNotes.push(note);
    }
  }
  if (!Number.isFinite(record.salesUnits) && !ambiguous.has("Sales Units")) validationNotes.push("FAIL: Cannot import this sales row because Sales Units is not numeric.");
  if (!Number.isFinite(record.salesValue) && !ambiguous.has("Sales Value")) validationNotes.push("FAIL: Cannot import this sales row because Sales Value is not numeric.");
  if (targetUnitsHasValue && !Number.isFinite(record.targetUnits) && !ambiguous.has("Target Units")) validationNotes.push("FAIL: Cannot import this sales row because Target Units is not numeric.");
  if (targetValueHasValue && !Number.isFinite(sheetTargetValue) && !ambiguous.has("Target Value")) validationNotes.push("FAIL: Cannot import this sales row because Target Value is not numeric.");

  // A target the sheet states is kept even when Factory Price is missing — the flat sheet does not
  // require a price. Only the half that would need the price is left at zero, and the note says so.
  // This used to fall through to "both empty": a row with Target Units and no price imported with
  // zero target under a note claiming the sheet gave none.
  const hasFactoryPrice = Number.isFinite(record.factoryPrice) && record.factoryPrice > 0;
  if (targetValueHasValue && Number.isFinite(sheetTargetValue)) {
    record.targetValue = sheetTargetValue;
    if (!targetUnitsHasValue) {
      if (hasFactoryPrice) {
        record.targetUnits = sheetTargetValue / record.factoryPrice;
        validationNotes.push("WARN: Target Units is empty. The system derived it from Target Value and Factory Price.");
      } else {
        record.targetUnits = 0;
        validationNotes.push(
          `WARN: Row ${rowNumber}, Target Units is empty and Factory Price is missing, so Target Units cannot be worked out. The row keeps the sheet's Target Value ${sheetTargetValue} with zero Target Units.`
        );
      }
    }
  } else if (targetUnitsHasValue && Number.isFinite(record.targetUnits)) {
    if (hasFactoryPrice) {
      record.targetValue = record.targetUnits * record.factoryPrice;
      validationNotes.push("WARN: Target Value is empty. The system derived it from Target Units and Factory Price.");
    } else {
      record.targetValue = 0;
      validationNotes.push(
        `WARN: Row ${rowNumber}, Target Value is empty and Factory Price is missing, so Target Value cannot be worked out. The row keeps the sheet's Target Units ${record.targetUnits} with zero Target Value.`
      );
    }
  } else if (!targetUnitsHasValue && !targetValueHasValue) {
    record.targetUnits = 0;
    record.targetValue = 0;
    validationNotes.push("WARN: Target Units and Target Value are empty. The system imported this row with zero target.");
  } else {
    // A target cell that is not a number: it already failed the row above, so no second note.
    record.targetUnits = 0;
    record.targetValue = 0;
  }

  if (!record.employeeHrId && !record.employeeCrmId && !record.employeeLookupKey) {
    validationNotes.push("WARN: This sales row has no employee linkage key, so the system will try to import it but cannot connect it to a People Ops employee yet.");
  }
  if (!record.employeeHrId && record.managerHrId) {
    validationNotes.push(
      "WARN: Area row has no MR HR ID. It will stay unlinked at MR level but remains counted in DSM/manager and territory totals."
    );
  }
  if (record.product === "Unknown") validationNotes.push("WARN: Product is missing in this sales row.");
  if (record.family === "Unknown") validationNotes.push("WARN: Family is missing in this sales row.");
  if (!options?.skipFactoryPrice && (!Number.isFinite(record.factoryPrice) || record.factoryPrice <= 0)) {
    validationNotes.push("WARN: Factory Price is missing or zero in this sales row.");
  }

  if (!options?.skipFactoryPrice && Number.isFinite(record.salesUnits) && Number.isFinite(record.factoryPrice) && record.factoryPrice > 0) {
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

  if (!options?.skipFactoryPrice && Number.isFinite(record.targetUnits) && Number.isFinite(record.factoryPrice) && record.factoryPrice > 0) {
    const expectedTargetValue = record.targetUnits * record.factoryPrice;
    if (Number.isFinite(sheetTargetValue) && targetValueHasValue && hasMaterialValueGap(sheetTargetValue, expectedTargetValue)) {
      validationNotes.push(
        `WARN: Row ${rowNumber}, column "Target Value" differs from Target Units x Factory Price. The dashboard will use the sheet Target Value ${sheetTargetValue}.`
      );
    }
  }

  record.validationState = buildValidationState(validationNotes);
  return record;
}
