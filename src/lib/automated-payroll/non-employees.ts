import type { AccessContext } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { writeAutomatedPayrollAudit } from "./audit.ts";
import { getRunById } from "./draft-store.ts";
import { actorId, assertAutomatedPayrollHrActor } from "./permissions.ts";
import type { MonthlySalaryRun, NonEmployeePayrollInput, NonEmployeePayrollRow } from "./types.ts";

/**
 * Non-Employees Payroll: a small, standalone CRUD surface for people paid a
 * monthly salary with no employee/HR_ID record (see the NonEmployeePayrollRow
 * doc comment in types.ts). Deliberately independent of the DraftRow/StepKey
 * wizard machinery — there is no population to recommend against, just a
 * free-form list HR adds to and removes from directly.
 */

const TABLE = "automated_payroll_non_employees";

type Row = Record<string, unknown>;

function mapRow(row: Row): NonEmployeePayrollRow {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    fullNameAr: String(row.full_name_ar ?? ""),
    fullNameEn: String(row.full_name_en ?? ""),
    totalSalary: Number(row.total_salary ?? 0),
    bankName: (row.bank_name as string | null) ?? null,
    bankAccount: (row.bank_account as string | null) ?? null,
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

async function requireEditableRun(runId: string): Promise<MonthlySalaryRun> {
  const run = await getRunById(runId);
  if (!run) throw new Error("Not found: payroll run does not exist.");
  if (run.phase === "published") throw new Error("Conflict: this run is already published.");
  if (run.phase === "cancelled") throw new Error("Conflict: this run was cancelled.");
  // Non-Employees Payroll is a Part 1 concern (their whole amount pays with Part
  // 1, per owner rule) — lock it the same moment every other Part 1 tab locks,
  // so an edit can never land after the Part 1 sheet has already been executed.
  if (run.phase !== "part1") {
    throw new Error("Conflict: Non-Employees Payroll can only be edited while Part 1 is open.");
  }
  return run;
}

function validateInput(input: NonEmployeePayrollInput): void {
  if (!input.fullNameAr?.trim()) throw new Error("Validation: Arabic name is required.");
  if (!input.fullNameEn?.trim()) throw new Error("Validation: English name is required.");
  if (!Number.isFinite(input.totalSalary) || input.totalSalary < 0) {
    throw new Error("Validation: Total Salary must be a non-negative number.");
  }
}

/**
 * True when the error means the table itself isn't migrated into this
 * environment yet (Postgres 42P01 / PostgREST's PGRST205 schema-cache miss) —
 * NOT any other query failure. Lets sheet/finance downloads keep working on an
 * environment where this migration hasn't landed yet, same tolerance pattern
 * used throughout this codebase for add-only migrations (see e.g.
 * calendar/service.ts, crm/schema.ts).
 */
function isMissingTableError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  const message = String((error as { message?: string } | null)?.message ?? error ?? "").toLowerCase();
  return code === "42P01" || code === "PGRST205" || (message.includes("relation") && message.includes("does not exist"));
}

/**
 * Raw fetch, no access check — for trusted internal callers that have already
 * gated the caller themselves (e.g. buildFinanceSheet asserts the finance-actor
 * role, which is a different set of roles than the HR-only gate below).
 */
export async function getNonEmployeePayrollRows(runId: string): Promise<NonEmployeePayrollRow[]> {
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .select("*")
    .eq("run_id", runId)
    .order("created_at", { ascending: true });
  if (error) {
    if (isMissingTableError(error)) return [];
    throw error;
  }
  return ((data ?? []) as Row[]).map(mapRow);
}

export async function listNonEmployeePayroll(
  access: AccessContext,
  runId: string,
): Promise<NonEmployeePayrollRow[]> {
  assertAutomatedPayrollHrActor(access);
  const run = await getRunById(runId);
  if (!run) throw new Error("Not found: payroll run does not exist.");
  return getNonEmployeePayrollRows(runId);
}

export async function addNonEmployeePayrollEntry(
  access: AccessContext,
  runId: string,
  input: NonEmployeePayrollInput,
): Promise<NonEmployeePayrollRow> {
  assertAutomatedPayrollHrActor(access);
  await requireEditableRun(runId);
  validateInput(input);

  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .insert({
      run_id: runId,
      full_name_ar: input.fullNameAr.trim(),
      full_name_en: input.fullNameEn.trim(),
      total_salary: input.totalSalary,
      bank_name: input.bankName?.trim() || null,
      bank_account: input.bankAccount?.trim() || null,
      created_by: actorId(access),
    })
    .select("*")
    .single();
  if (error) throw error;
  const row = mapRow(data as Row);
  await writeAutomatedPayrollAudit({
    runId,
    actorHrId: actorId(access),
    action: "non_employee_added",
    detail: { id: row.id, fullNameEn: row.fullNameEn, totalSalary: row.totalSalary },
  });
  return row;
}

export async function updateNonEmployeePayrollEntry(
  access: AccessContext,
  runId: string,
  id: string,
  input: NonEmployeePayrollInput,
): Promise<NonEmployeePayrollRow> {
  assertAutomatedPayrollHrActor(access);
  await requireEditableRun(runId);
  validateInput(input);

  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .update({
      full_name_ar: input.fullNameAr.trim(),
      full_name_en: input.fullNameEn.trim(),
      total_salary: input.totalSalary,
      bank_name: input.bankName?.trim() || null,
      bank_account: input.bankAccount?.trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("run_id", runId)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Not found: non-employee entry does not exist on this run.");
  return mapRow(data as Row);
}

export async function deleteNonEmployeePayrollEntry(
  access: AccessContext,
  runId: string,
  id: string,
): Promise<void> {
  assertAutomatedPayrollHrActor(access);
  await requireEditableRun(runId);

  const { error } = await getSupabaseAdmin().from(TABLE).delete().eq("id", id).eq("run_id", runId);
  if (error) throw error;
  await writeAutomatedPayrollAudit({
    runId,
    actorHrId: actorId(access),
    action: "non_employee_removed",
    detail: { id },
  });
}

/** Sum of every non-employee's Total Salary for a run — the amount added to the Part 1 sheet's grand total. */
export function sumNonEmployeePayroll(rows: NonEmployeePayrollRow[]): number {
  return Math.round(rows.reduce((sum, row) => sum + row.totalSalary, 0) * 100) / 100;
}
