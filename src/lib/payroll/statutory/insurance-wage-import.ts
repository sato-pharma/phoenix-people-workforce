import ExcelJS from "exceljs";

import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Bulk import for employees.social_insurance_wage (the per-employee insurance /
 * subject wage the statutory engine uses). Parses an xlsx of HR_ID + wage, then
 * previews (matched / unmatched / invalid) and applies. Only ever writes the
 * single social_insurance_wage column — nothing else on the employee row.
 */

export type ParsedWageRow = { hrId: string; wage: number; row: number };
export type WageImportIssue = { row: number; message: string };

export type WageParseResult = {
  rows: ParsedWageRow[];
  issues: WageImportIssue[];
  detected: { hrIdColumn: string | null; wageColumn: string | null };
};

const HR_ID_ALIASES = ["hr_id", "hr id", "hrid", "employee code", "employee_code", "code", "id"];
const WAGE_ALIASES = [
  "insurance wage",
  "social insurance wage",
  "social_insurance_wage",
  "subject wage",
  "insurance salary",
  "insurance subject wage",
  "wage",
];

function normalizeHeader(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Compact key for matching HR ids regardless of hyphen/case. */
export function wageHrKey(hrId: string | null | undefined): string {
  return String(hrId ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function cellText(cell: ExcelJS.Cell | undefined): string {
  if (!cell) return "";
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && "text" in value) return String((value as { text: unknown }).text ?? "").trim();
  return String(value).trim();
}

function parseAmount(text: string): number | null {
  if (!text) return null;
  const cleaned = text.replace(/,/g, "").replace(/[^\d.-]/g, "");
  if (!cleaned) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

export async function parseInsuranceWageWorkbook(buffer: ArrayBuffer): Promise<WageParseResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  const issues: WageImportIssue[] = [];
  const rows: ParsedWageRow[] = [];

  if (!sheet) {
    return { rows, issues: [{ row: 0, message: "The file has no worksheet." }], detected: { hrIdColumn: null, wageColumn: null } };
  }

  // Find the header row (within the first 12 rows) that has both an HR_ID and a wage column.
  let headerRowNumber = 0;
  let hrIdCol = 0;
  let wageCol = 0;
  const maxScan = Math.min(sheet.rowCount, 12);
  for (let r = 1; r <= maxScan; r += 1) {
    const row = sheet.getRow(r);
    let foundHr = 0;
    let foundWage = 0;
    row.eachCell((cell, col) => {
      const header = normalizeHeader(cellText(cell));
      if (!header) return;
      if (!foundHr && HR_ID_ALIASES.includes(header)) foundHr = col;
      if (!foundWage && WAGE_ALIASES.includes(header)) foundWage = col;
    });
    if (foundHr && foundWage) {
      headerRowNumber = r;
      hrIdCol = foundHr;
      wageCol = foundWage;
      break;
    }
  }

  const detected = {
    hrIdColumn: hrIdCol ? String(hrIdCol) : null,
    wageColumn: wageCol ? String(wageCol) : null,
  };

  if (!headerRowNumber) {
    issues.push({
      row: 0,
      message: "Could not find a header row with an HR_ID column and an Insurance Wage column.",
    });
    return { rows, issues, detected };
  }

  const seen = new Set<string>();
  for (let r = headerRowNumber + 1; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    const hrId = cellText(row.getCell(hrIdCol));
    const wageText = cellText(row.getCell(wageCol));
    if (!hrId && !wageText) continue; // blank row
    if (!hrId) {
      issues.push({ row: r, message: "Missing HR_ID." });
      continue;
    }
    const key = wageHrKey(hrId);
    if (seen.has(key)) {
      issues.push({ row: r, message: `Duplicate HR_ID ${hrId}.` });
      continue;
    }
    const wage = parseAmount(wageText);
    if (wage === null) {
      issues.push({ row: r, message: `Invalid insurance wage for ${hrId}.` });
      continue;
    }
    if (wage < 0) {
      issues.push({ row: r, message: `Insurance wage cannot be negative for ${hrId}.` });
      continue;
    }
    seen.add(key);
    rows.push({ hrId: hrId.trim(), wage: Math.round(wage * 100) / 100, row: r });
  }

  return { rows, issues, detected };
}

export type WagePreview = {
  matched: Array<{ hrId: string; employeeHrId: string; wage: number }>;
  unmatched: Array<{ hrId: string; wage: number }>;
};

/** Match parsed rows against live employees (by compact HR id). */
export async function previewInsuranceWages(rows: ParsedWageRow[]): Promise<WagePreview> {
  const supabase = getSupabaseAdmin();
  const byKey = new Map<string, string>();
  const { data, error } = await supabase.from("employees").select("hr_id");
  if (error) throw error;
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const hrId = String(row.hr_id ?? "");
    const key = wageHrKey(hrId);
    if (key) byKey.set(key, hrId);
  }

  const matched: WagePreview["matched"] = [];
  const unmatched: WagePreview["unmatched"] = [];
  for (const row of rows) {
    const employeeHrId = byKey.get(wageHrKey(row.hrId));
    if (employeeHrId) matched.push({ hrId: row.hrId, employeeHrId, wage: row.wage });
    else unmatched.push({ hrId: row.hrId, wage: row.wage });
  }
  return { matched, unmatched };
}

/** Apply matched wages to employees.social_insurance_wage (only that column). */
export async function applyInsuranceWages(
  matched: WagePreview["matched"],
): Promise<{ updated: number; failed: Array<{ employeeHrId: string; message: string }> }> {
  const supabase = getSupabaseAdmin();
  let updated = 0;
  const failed: Array<{ employeeHrId: string; message: string }> = [];
  for (const item of matched) {
    try {
      const { error } = await supabase
        .from("employees")
        .update({ social_insurance_wage: item.wage })
        .eq("hr_id", item.employeeHrId);
      if (error) {
        failed.push({ employeeHrId: item.employeeHrId, message: error.message });
        continue;
      }
      updated += 1;
    } catch (error) {
      failed.push({ employeeHrId: item.employeeHrId, message: error instanceof Error ? error.message : "update failed" });
    }
  }
  return { updated, failed };
}
