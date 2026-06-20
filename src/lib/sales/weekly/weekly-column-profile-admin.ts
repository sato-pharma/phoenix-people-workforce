// Governed write path for the WEEKLY distributor column-profile override
// (weekly_sales_distributor_column_profile). Service-role writes only (RLS bypassed by the admin client),
// so permission MUST be enforced upstream in the route. Validates BEFORE save against the CODE contract so
// only safe edits land: an admin may move a column index or change a header row, but may NOT add/remove/
// rename fields, change a field's semantic/role, change a sheet's role/formField/identity, or edit the PS
// matrix blocks — those stay code-driven. Writes an audit trail and invalidates the read cache.

import { writeAuditLog } from "@/lib/admin/audit";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { writeMappingAudit } from "@/lib/sales/mapping-audit";
import { weeklyContractByCode, type WeeklyContractSheet, type WeeklyDistributorContract } from "@/lib/sales/weekly/column-contract";
import { invalidateWeeklyColumnProfileCache } from "@/lib/sales/weekly/weekly-column-profile-store";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const PROFILE_TABLE = "weekly_sales_distributor_column_profile";

export type WeeklyColumnProfileInput = {
  distributorCode: string;
  distributorName: string;
  splitFiles: boolean;
  sheets: WeeklyContractSheet[];
};

function codeKey(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase();
}

function sortedIndices(sheet: WeeklyContractSheet): number[] {
  return sheet.fields.map((f) => f.columnIndex).sort((a, b) => a - b);
}

// PURE validation (unit-tested): the edit must keep the EXACT structure of the code contract for that
// distributor — same sheets/roles/formFields and the same field set per sheet — and only adjust column
// indices and header rows. Anything else is rejected so the parser's semantics can never be repurposed.
export function validateWeeklyColumnProfileInput(input: WeeklyColumnProfileInput): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const code = codeKey(input.distributorCode);
  if (!code) errors.push("Distributor code is required.");
  if (!String(input.distributorName ?? "").trim()) errors.push("Distributor name is required.");

  const codeContract = code ? weeklyContractByCode(code) : undefined;
  if (!codeContract) {
    errors.push(`"${input.distributorCode}" is not a known weekly distributor. The weekly editor can only adjust the six built-in distributors (a new one needs an import adapter).`);
    return { ok: false, errors };
  }

  const sheets = Array.isArray(input.sheets) ? input.sheets : [];
  if (sheets.length !== codeContract.sheets.length) {
    errors.push(`Expected ${codeContract.sheets.length} sheet block(s) for ${code}, got ${sheets.length}. Sheets cannot be added or removed.`);
    return { ok: false, errors };
  }

  for (let i = 0; i < codeContract.sheets.length; i += 1) {
    const expected = codeContract.sheets[i];
    const got = sheets[i];
    const where = `sheet "${expected.role}"`;
    if (!got) {
      errors.push(`${where} is missing.`);
      continue;
    }
    // Locked structural attributes — must match the code contract exactly.
    if (got.role !== expected.role) errors.push(`${where}: role cannot change (got "${got.role}").`);
    if (got.formField !== expected.formField) errors.push(`${where}: file slot cannot change (got "${got.formField}").`);
    if (Boolean(got.matrix) !== Boolean(expected.matrix)) errors.push(`${where}: matrix block presence cannot change.`);
    if (got.matrix && expected.matrix) {
      if (got.matrix.kind !== expected.matrix.kind || got.matrix.firstColumn !== expected.matrix.firstColumn || (got.matrix.lastColumn ?? null) !== (expected.matrix.lastColumn ?? null) || (got.matrix.stopAtHeaderPattern ?? "") !== (expected.matrix.stopAtHeaderPattern ?? "")) {
        errors.push(`${where}: the matrix block (branch/location columns) is fixed in code and cannot be edited here.`);
      }
    }
    // Editable: header row (must be 1 or 2, matching how weekly sheets are laid out).
    if (got.headerRowNumber !== 1 && got.headerRowNumber !== 2) {
      errors.push(`${where}: header row must be 1 or 2 (got ${got.headerRowNumber}).`);
    }
    // Field set must be identical (same field keys, same semantics/roles, no add/remove/rename).
    const expectedFields = new Map(expected.fields.map((f) => [f.field, f]));
    const gotFields = new Map(got.fields.map((f) => [f.field, f]));
    if (gotFields.size !== got.fields.length) errors.push(`${where}: duplicate field keys are not allowed.`);
    for (const key of expectedFields.keys()) {
      if (!gotFields.has(key)) errors.push(`${where}: field "${key}" is missing (fields cannot be removed).`);
    }
    for (const [key, gotField] of gotFields) {
      const expectedField = expectedFields.get(key);
      if (!expectedField) {
        errors.push(`${where}: unknown field "${key}" (fields cannot be added).`);
        continue;
      }
      if (gotField.role !== expectedField.role) errors.push(`${where}, field "${key}": its role/semantic is fixed and cannot change.`);
      if (!Number.isInteger(gotField.columnIndex) || gotField.columnIndex < 1) {
        errors.push(`${where}, field "${key}": column must be a whole number ≥ 1 (got ${gotField.columnIndex}).`);
      }
      if (gotField.columnIndex > 1000) {
        errors.push(`${where}, field "${key}": column ${gotField.columnIndex} is out of range.`);
      }
    }
    // No two fields in the same sheet may point at the same column.
    const indices = sortedIndices(got);
    for (let j = 1; j < indices.length; j += 1) {
      if (indices[j] === indices[j - 1]) {
        errors.push(`${where}: two fields share column ${indices[j]} — each field needs its own column.`);
        break;
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Normalize the input sheets to the stored jsonb shape (drop any unexpected keys). */
function toStoredSheets(input: WeeklyColumnProfileInput, codeContract: WeeklyDistributorContract): WeeklyContractSheet[] {
  // Persist the code contract's structure with the operator's edited indices/header rows applied, so a
  // hand-tampered payload can never smuggle extra structure past validation into storage.
  return codeContract.sheets.map((expected, i) => {
    const got = input.sheets[i];
    const fieldByKey = new Map((got?.fields ?? []).map((f) => [f.field, f]));
    return {
      ...expected,
      headerRowNumber: got?.headerRowNumber === 1 || got?.headerRowNumber === 2 ? got.headerRowNumber : expected.headerRowNumber,
      fields: expected.fields.map((ef) => ({ ...ef, columnIndex: fieldByKey.get(ef.field)?.columnIndex ?? ef.columnIndex })),
    };
  });
}

// Upsert (whole-profile override) for one distributor. Throws SalesWorkflowError(400) on invalid input.
export async function saveWeeklyColumnProfile(input: WeeklyColumnProfileInput, actor: string): Promise<{ distributorCode: string }> {
  const code = codeKey(input.distributorCode);
  const check = validateWeeklyColumnProfileInput(input);
  if (!check.ok) throw new SalesWorkflowError("invalid_weekly_column_profile", check.errors.join(" "), 400);

  const codeContract = weeklyContractByCode(code)!; // validated above
  const sheets = toStoredSheets(input, codeContract);
  const row: Record<string, unknown> = {
    distributor_code: code,
    distributor_name: String(input.distributorName).trim() || codeContract.name,
    split_files: Boolean(codeContract.splitFiles),
    sheets,
    active: true,
    updated_by: actor,
    updated_at: new Date().toISOString(),
  };

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from(PROFILE_TABLE).upsert(row, { onConflict: "distributor_code" });
  if (error) throw new SalesWorkflowError("weekly_column_profile_save_failed", `Could not save the weekly mapping: ${error.message}`, 500);

  await writeAuditLog({
    actorLoginId: actor,
    entityId: PROFILE_TABLE,
    entityType: "sales_import_batch",
    newValues: { distributor_code: code, distributor_name: row.distributor_name, source: "weekly_column_profile_save" },
    summary: `Weekly column mapping saved — ${code} (${row.distributor_name}).`,
  });
  await writeMappingAudit({ entityType: "weekly_distributor_profile", distributorCode: code, entityKey: code, action: "edit", after: row, actor });
  invalidateWeeklyColumnProfileCache();
  return { distributorCode: code };
}

// Deactivate the override (revert this distributor to its built-in code contract).
export async function deactivateWeeklyColumnProfile(distributorCode: string, actor: string): Promise<{ distributorCode: string }> {
  const code = codeKey(distributorCode);
  if (!code) throw new SalesWorkflowError("invalid_weekly_column_profile", "Distributor code is required.", 400);
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from(PROFILE_TABLE).update({ active: false, updated_by: actor, updated_at: new Date().toISOString() }).eq("distributor_code", code);
  if (error) throw new SalesWorkflowError("weekly_column_profile_save_failed", `Could not reset the weekly mapping: ${error.message}`, 500);
  await writeAuditLog({
    actorLoginId: actor,
    entityId: PROFILE_TABLE,
    entityType: "sales_import_batch",
    newValues: { distributor_code: code, source: "weekly_column_profile_reset" },
    summary: `Weekly column mapping reset to built-in — ${code}.`,
  });
  await writeMappingAudit({ entityType: "weekly_distributor_profile", distributorCode: code, entityKey: code, action: "delete", actor });
  invalidateWeeklyColumnProfileCache();
  return { distributorCode: code };
}
