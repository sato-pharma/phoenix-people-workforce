import type { AccessContext } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { writeAutomatedPayrollAudit } from "./audit.ts";
import { getRunById } from "./draft-store.ts";
import { actorId, assertAutomatedPayrollHrActor } from "./permissions.ts";
import type {
  MonthlySalaryRun,
  NonEmployeePart,
  NonEmployeePayrollInput,
  NonEmployeePayrollRow,
} from "./types.ts";
import { isNonEmployeePart } from "./types.ts";

/**
 * Non-Employees Payroll: a small, standalone CRUD surface for people paid a
 * monthly salary with no employee/HR_ID record (see the NonEmployeePayrollRow
 * doc comment in types.ts). Deliberately independent of the DraftRow/StepKey
 * wizard machinery — there is no population to recommend against, just a
 * free-form list HR adds to and removes from directly.
 *
 * Each entry belongs to ONE installment (owner request 2026-08-03). The list
 * shipped as Part-1-only; some of these people are paid with the second
 * installment instead, and `part` is what says so. It is the single input to
 * every rule that used to be hardcoded to "first" — the edit window, the sheet,
 * and the bank file.
 */

const TABLE = "automated_payroll_non_employees";

type Row = Record<string, unknown>;

function mapRow(row: Row): NonEmployeePayrollRow {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    // Defaulted rather than asserted: an environment where the `part` migration
    // hasn't landed yet returns rows without the column, and every one of those
    // rows means "first" — the only behaviour that existed before it.
    part: isNonEmployeePart(row.part) ? row.part : "first",
    fullNameAr: String(row.full_name_ar ?? ""),
    fullNameEn: String(row.full_name_en ?? ""),
    totalSalary: Number(row.total_salary ?? 0),
    bankName: (row.bank_name as string | null) ?? null,
    bankAccount: (row.bank_account as string | null) ?? null,
    // Null on an environment where the provenance column hasn't landed, which
    // reads identically to "HR typed this one in by hand" — the safe default,
    // since it only ever drives a UI badge and never an amount.
    recurringId: (row.recurring_id as string | null) ?? null,
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

/** The run phase in which a given part's entries may still be edited. */
const EDITABLE_PHASE: Record<NonEmployeePart, MonthlySalaryRun["phase"]> = {
  first: "part1",
  second: "part2",
};

/**
 * A part's entries lock the same moment that part's own wizard tabs lock, so an
 * edit can never land after that installment's sheet has already been executed:
 * Part 1 entries close when Part 1 is confirmed, Part 2 entries when Part 2 is.
 */
async function requireEditableRun(runId: string, part: NonEmployeePart): Promise<MonthlySalaryRun> {
  const run = await getRunById(runId);
  if (!run) throw new Error("Not found: payroll run does not exist.");
  if (run.phase === "published") throw new Error("Conflict: this run is already published.");
  if (run.phase === "cancelled") throw new Error("Conflict: this run was cancelled.");
  if (run.phase !== EDITABLE_PHASE[part]) {
    const label = part === "first" ? "Part 1" : "Part 2";
    throw new Error(`Conflict: ${label} Non-Employees Payroll can only be edited while ${label} is open.`);
  }
  return run;
}

function resolvePart(value: NonEmployeePart | undefined | null): NonEmployeePart {
  return isNonEmployeePart(value) ? value : "first";
}

/**
 * Exported so the rule that decides whether a payable row can reach a bank file is assertable
 * without a database — the same reasoning as expense-gate.ts, which keeps every money gate pure.
 */
export function validateNonEmployeePayrollInput(input: NonEmployeePayrollInput): void {
  if (!input.fullNameAr?.trim()) throw new Error("Validation: Arabic name is required.");
  if (!input.fullNameEn?.trim()) throw new Error("Validation: English name is required.");
  if (!Number.isFinite(input.totalSalary) || input.totalSalary < 0) {
    throw new Error("Validation: Total Salary must be a non-negative number.");
  }
  if (input.part !== undefined && !isNonEmployeePart(input.part)) {
    throw new Error("Validation: part must be either first or second.");
  }
  // A payable entry must say WHERE the money goes. Neither field was required before, and the
  // bank files match on the exact words "FAB" and "CIB" — so a blank bank or a blank account
  // produced a row that every screen and every total counted as paid while no file carried it.
  //
  // Deliberately NOT restricted to FAB and CIB. Three people on the live standing roster are paid
  // every month through routes this system does not model ("QNB", "Instapay"), and rejecting their
  // bank name would break entries for people who are genuinely owed money. They are named instead,
  // by the coverage report in exports/bank-coverage.ts, which is the honest answer: the money is
  // real, the bank file cannot carry it, and somebody has to know that.
  if (input.totalSalary > 0) {
    if (!input.bankName?.trim()) {
      throw new Error("Validation: a bank is required for a paid entry — it decides which transfer file carries them.");
    }
    if (!input.bankAccount?.trim()) {
      throw new Error("Validation: an account number is required for a paid entry.");
    }
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
 * True when the error means the `part` COLUMN isn't in this environment yet
 * (Postgres 42703 / PostgREST's PGRST204 schema-cache miss) — the code shipping
 * ahead of its own migration. Same add-only tolerance as isMissingTableError,
 * one column narrower.
 */
function isMissingPartColumnError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  const message = String((error as { message?: string } | null)?.message ?? error ?? "").toLowerCase();
  return code === "42703" || code === "PGRST204" || (message.includes("part") && message.includes("column"));
}

/**
 * Raw fetch, no access check — for trusted internal callers that have already
 * gated the caller themselves (e.g. buildFinanceSheet asserts the finance-actor
 * role, which is a different set of roles than the HR-only gate below).
 *
 * `part` filters in memory rather than in SQL on purpose: `select("*")` still
 * succeeds on an environment where the column hasn't landed, where mapRow reads
 * every row as "first" — a `.eq("part", …)` would error out instead and take the
 * Part 1 sheet down with it.
 */
export async function getNonEmployeePayrollRows(
  runId: string,
  part?: NonEmployeePart,
): Promise<NonEmployeePayrollRow[]> {
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .select("*")
    .eq("run_id", runId)
    .order("created_at", { ascending: true });
  if (error) {
    if (isMissingTableError(error)) return [];
    throw error;
  }
  const rows = ((data ?? []) as Row[]).map(mapRow);
  return part ? nonEmployeesForPart(rows, part) : rows;
}

/** The entries paid with one installment. Pure — the one filter every export shares. */
export function nonEmployeesForPart(
  rows: NonEmployeePayrollRow[],
  part: NonEmployeePart,
): NonEmployeePayrollRow[] {
  return rows.filter((row) => row.part === part);
}

export async function listNonEmployeePayroll(
  access: AccessContext,
  runId: string,
  part?: NonEmployeePart,
): Promise<NonEmployeePayrollRow[]> {
  assertAutomatedPayrollHrActor(access);
  const run = await getRunById(runId);
  if (!run) throw new Error("Not found: payroll run does not exist.");
  return getNonEmployeePayrollRows(runId, part);
}

/** The stored entry, so update/delete can gate on the part it ACTUALLY belongs to. */
async function requireEntry(runId: string, id: string): Promise<NonEmployeePayrollRow> {
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .select("*")
    .eq("id", id)
    .eq("run_id", runId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Not found: non-employee entry does not exist on this run.");
  return mapRow(data as Row);
}

/**
 * Writes the `part` column, retrying once without it if this environment hasn't
 * had the migration applied yet. A "first" entry is unaffected by the retry —
 * that is the column default and the module's original behaviour — but a
 * "second" entry silently becoming a Part 1 one would move real money to the
 * wrong installment, so that case fails loudly instead.
 */
async function writeWithPart<T>(
  part: NonEmployeePart,
  payload: Record<string, unknown>,
  // PromiseLike, not Promise: a PostgREST builder is a thenable without
  // .catch/.finally, so `Promise` would not accept it.
  write: (body: Record<string, unknown>) => PromiseLike<{ data: T | null; error: unknown }>,
): Promise<{ data: T | null; error: unknown }> {
  const first = await write({ ...payload, part });
  if (!first.error || !isMissingPartColumnError(first.error)) return first;
  if (part === "second") {
    throw new Error(
      "Conflict: Part 2 Non-Employees Payroll needs a database migration that hasn't been applied to this environment yet.",
    );
  }
  return write(payload);
}

export async function addNonEmployeePayrollEntry(
  access: AccessContext,
  runId: string,
  input: NonEmployeePayrollInput,
): Promise<NonEmployeePayrollRow> {
  assertAutomatedPayrollHrActor(access);
  validateNonEmployeePayrollInput(input);
  const part = resolvePart(input.part);
  await requireEditableRun(runId, part);

  const { data, error } = await writeWithPart<Row>(
    part,
    {
      run_id: runId,
      full_name_ar: input.fullNameAr.trim(),
      full_name_en: input.fullNameEn.trim(),
      total_salary: input.totalSalary,
      bank_name: input.bankName?.trim() || null,
      bank_account: input.bankAccount?.trim() || null,
      created_by: actorId(access),
    },
    (body) => getSupabaseAdmin().from(TABLE).insert(body).select("*").single(),
  );
  if (error) throw error;
  const row = mapRow(data as Row);
  await writeAutomatedPayrollAudit({
    runId,
    actorHrId: actorId(access),
    action: "non_employee_added",
    detail: { id: row.id, part: row.part, fullNameEn: row.fullNameEn, totalSalary: row.totalSalary },
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
  validateNonEmployeePayrollInput(input);

  // Gate on the part it is stored under AND the part it would become, so an edit
  // can never move an entry into an installment that is already closed, nor out
  // of one that is.
  const existing = await requireEntry(runId, id);
  const part = input.part === undefined ? existing.part : resolvePart(input.part);
  await requireEditableRun(runId, existing.part);
  if (part !== existing.part) await requireEditableRun(runId, part);

  const { data, error } = await writeWithPart<Row>(
    part,
    {
      full_name_ar: input.fullNameAr.trim(),
      full_name_en: input.fullNameEn.trim(),
      total_salary: input.totalSalary,
      bank_name: input.bankName?.trim() || null,
      bank_account: input.bankAccount?.trim() || null,
      updated_at: new Date().toISOString(),
    },
    (body) => getSupabaseAdmin().from(TABLE).update(body).eq("id", id).eq("run_id", runId).select("*").maybeSingle(),
  );
  if (error) throw error;
  if (!data) throw new Error("Not found: non-employee entry does not exist on this run.");
  const row = mapRow(data as Row);
  // Audited like add and remove (payroll audit 2026-11-14, finding 12): a changed salary or bank account
  // left only `updated_at` and the 72-hour recovery log behind it.
  const fields = ["fullNameAr", "fullNameEn", "totalSalary", "bankName", "bankAccount", "part"] as const;
  const changed = fields.filter((field) => existing[field] !== row[field]);
  if (changed.length > 0) {
    await writeAutomatedPayrollAudit({
      runId,
      actorHrId: actorId(access),
      action: "non_employee_updated",
      detail: {
        id,
        fullNameEn: row.fullNameEn,
        before: Object.fromEntries(changed.map((field) => [field, existing[field]])),
        after: Object.fromEntries(changed.map((field) => [field, row[field]])),
      },
    });
  }
  return row;
}

export async function deleteNonEmployeePayrollEntry(
  access: AccessContext,
  runId: string,
  id: string,
): Promise<void> {
  assertAutomatedPayrollHrActor(access);
  const existing = await requireEntry(runId, id);
  await requireEditableRun(runId, existing.part);

  const { error } = await getSupabaseAdmin().from(TABLE).delete().eq("id", id).eq("run_id", runId);
  if (error) throw error;
  await writeAutomatedPayrollAudit({
    runId,
    actorHrId: actorId(access),
    action: "non_employee_removed",
    detail: { id, part: existing.part },
  });
}

/** Sum of every non-employee's Total Salary in the list handed in — the amount folded into that sheet's total. */
export function sumNonEmployeePayroll(rows: NonEmployeePayrollRow[]): number {
  return Math.round(rows.reduce((sum, row) => sum + row.totalSalary, 0) * 100) / 100;
}
