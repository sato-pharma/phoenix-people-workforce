import type { AccessContext } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { writeAutomatedPayrollAudit } from "./audit.ts";
import { getRunById } from "./draft-store.ts";
import { actorId, assertAutomatedPayrollHrActor } from "./permissions.ts";
import type {
  NonEmployeePart,
  RecurringNonEmployeeInput,
  RecurringNonEmployeeRow,
  RecurringSeedResult,
} from "./types.ts";
import { isNonEmployeePart } from "./types.ts";

/**
 * The STANDING Non-Employees Payroll roster (owner request 2026-08-30: "add them
 * to be fixed every month without me adding them manual").
 *
 * Until now the per-run list in `non-employees.ts` was retyped from scratch every
 * month — same people, same amounts, same bank accounts, by hand. This module is
 * the register those entries are copied FROM.
 *
 * The one rule that governs everything here: a run's rows are COPIES. `seedRun`
 * writes real rows into `automated_payroll_non_employees` and nothing downstream
 * changes — sheets, totals, FAB/CIB files and the edit locks all keep reading
 * that per-run table exactly as before. Editing an amount on the register
 * therefore affects only months seeded AFTER the edit, which is what makes it
 * safe to leave a published month alone.
 */

const TABLE = "automated_payroll_non_employee_recurring";
const RUN_TABLE = "automated_payroll_non_employees";

type Row = Record<string, unknown>;

function mapRow(row: Row): RecurringNonEmployeeRow {
  return {
    id: String(row.id),
    part: isNonEmployeePart(row.part) ? row.part : "first",
    fullNameAr: String(row.full_name_ar ?? ""),
    fullNameEn: String(row.full_name_en ?? ""),
    totalSalary: Number(row.total_salary ?? 0),
    bankName: (row.bank_name as string | null) ?? null,
    bankAccount: (row.bank_account as string | null) ?? null,
    active: row.active !== false,
    note: (row.note as string | null) ?? null,
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

/**
 * True when the error means this table isn't migrated into the environment yet
 * (Postgres 42P01 / PostgREST's PGRST205 schema-cache miss) — NOT any other
 * failure. Same add-only tolerance the rest of this module uses, and it is what
 * lets `seedRun` be called unconditionally from run creation: an environment
 * without the migration simply seeds nothing instead of failing to start a run.
 */
function isMissingTableError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  const message = String((error as { message?: string } | null)?.message ?? error ?? "").toLowerCase();
  return code === "42P01" || code === "PGRST205" || (message.includes("relation") && message.includes("does not exist"));
}

/** True when `recurring_id` isn't in this environment yet — one column narrower. */
function isMissingRecurringColumnError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  const message = String((error as { message?: string } | null)?.message ?? error ?? "").toLowerCase();
  return code === "42703" || code === "PGRST204" || (message.includes("recurring_id") && message.includes("column"));
}

function validateInput(input: RecurringNonEmployeeInput): void {
  if (!input.fullNameAr?.trim()) throw new Error("Validation: Arabic name is required.");
  if (!input.fullNameEn?.trim()) throw new Error("Validation: English name is required.");
  if (!Number.isFinite(input.totalSalary) || input.totalSalary < 0) {
    throw new Error("Validation: Total Salary must be a non-negative number.");
  }
  if (input.part !== undefined && !isNonEmployeePart(input.part)) {
    throw new Error("Validation: part must be either first or second.");
  }
}

/**
 * A duplicate is the (name, part) unique index firing — the same person entered
 * twice for the same installment. Reported as a plain conflict rather than a raw
 * Postgres error, because the admin's fix is to edit the existing row.
 */
function rethrowDuplicate(error: unknown, fullNameEn: string, part: NonEmployeePart): never {
  const code = (error as { code?: string } | null)?.code;
  if (code === "23505") {
    const label = part === "first" ? "Part 1" : "Part 2";
    throw new Error(
      `Conflict: ${fullNameEn.trim()} is already on the standing roster for ${label}. Edit that entry instead of adding a second one.`,
    );
  }
  throw error;
}

// ---- Register CRUD ----------------------------------------------------------

/** Every roster entry, active first then alphabetical. Empty if not migrated yet. */
export async function listRecurringNonEmployees(
  access: AccessContext,
): Promise<RecurringNonEmployeeRow[]> {
  assertAutomatedPayrollHrActor(access);
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .select("*")
    .order("active", { ascending: false })
    .order("full_name_en", { ascending: true });
  if (error) {
    if (isMissingTableError(error)) return [];
    throw error;
  }
  return ((data ?? []) as Row[]).map(mapRow);
}

export async function addRecurringNonEmployee(
  access: AccessContext,
  input: RecurringNonEmployeeInput,
): Promise<RecurringNonEmployeeRow> {
  assertAutomatedPayrollHrActor(access);
  validateInput(input);
  const part: NonEmployeePart = isNonEmployeePart(input.part) ? input.part : "first";

  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .insert({
      full_name_ar: input.fullNameAr.trim(),
      full_name_en: input.fullNameEn.trim(),
      total_salary: input.totalSalary,
      bank_name: input.bankName?.trim() || null,
      bank_account: input.bankAccount?.trim() || null,
      part,
      active: input.active !== false,
      note: input.note?.trim() || null,
      created_by: actorId(access),
    })
    .select("*")
    .single();
  if (error) rethrowDuplicate(error, input.fullNameEn, part);

  // No automated_payroll_audit row here on purpose: that table's run_id is a NOT
  // NULL foreign key to a payroll run, and a register edit belongs to no run. The
  // audit trail for the register is its own created_by/updated_at plus the
  // `non_employee_recurring_seeded` row written the moment it first reaches a run.
  return mapRow(data as Row);
}

export async function updateRecurringNonEmployee(
  access: AccessContext,
  id: string,
  input: RecurringNonEmployeeInput,
): Promise<RecurringNonEmployeeRow> {
  assertAutomatedPayrollHrActor(access);
  validateInput(input);

  const payload: Record<string, unknown> = {
    full_name_ar: input.fullNameAr.trim(),
    full_name_en: input.fullNameEn.trim(),
    total_salary: input.totalSalary,
    bank_name: input.bankName?.trim() || null,
    bank_account: input.bankAccount?.trim() || null,
    note: input.note?.trim() || null,
    updated_at: new Date().toISOString(),
  };
  // Omitted keeps the entry where it is: an edit form that doesn't know about
  // parts must never silently move someone to the other installment.
  if (input.part !== undefined) payload.part = input.part;
  if (input.active !== undefined) payload.active = input.active;

  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .update(payload)
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) {
    rethrowDuplicate(error, input.fullNameEn, isNonEmployeePart(input.part) ? input.part : "first");
  }
  if (!data) throw new Error("Not found: standing roster entry does not exist.");
  return mapRow(data as Row);
}

/**
 * Remove a roster entry outright. Rows already copied into runs survive — the FK
 * is `on delete set null` — so a published month keeps showing what it paid.
 * Deactivating is still the better move; this exists for entries added in error.
 */
export async function deleteRecurringNonEmployee(access: AccessContext, id: string): Promise<void> {
  assertAutomatedPayrollHrActor(access);
  const { error } = await getSupabaseAdmin().from(TABLE).delete().eq("id", id);
  if (error) throw error;
}

// ---- Seeding a run ----------------------------------------------------------

/** Active roster entries, unfiltered by part. Empty (never throws) if not migrated. */
async function activeRecurringRows(): Promise<RecurringNonEmployeeRow[]> {
  const { data, error } = await getSupabaseAdmin().from(TABLE).select("*").eq("active", true);
  if (error) {
    if (isMissingTableError(error)) return [];
    throw error;
  }
  return ((data ?? []) as Row[]).map(mapRow);
}

/**
 * Copy the active standing roster into one run's Non-Employees Payroll list.
 *
 * Idempotent by `(run_id, recurring_id)`: an entry already copied into this run
 * is left exactly as it is, amount included, so a re-sync never overwrites an
 * amount HR adjusted for this particular month.
 *
 * Deliberately NOT gated on the run phase. It writes through the admin client
 * rather than `addNonEmployeePayrollEntry` precisely so that a Part-2 entry can
 * be placed while the run is still in Part 1 — the entry then simply isn't
 * editable until Part 2 opens, which is the existing rule and the correct one.
 * A published or cancelled run is refused, because that money is already gone.
 */
export async function seedRunFromRecurring(input: {
  runId: string;
  actorHrId: string;
}): Promise<RecurringSeedResult> {
  const roster = await activeRecurringRows();
  if (roster.length === 0) return { inserted: 0, skipped: 0 };

  const admin = getSupabaseAdmin();
  const { data: existing, error: existingError } = await admin
    .from(RUN_TABLE)
    .select("recurring_id")
    .eq("run_id", input.runId)
    .not("recurring_id", "is", null);
  if (existingError) {
    // No provenance column yet => nothing was ever seeded, so seed everything.
    if (!isMissingRecurringColumnError(existingError) && !isMissingTableError(existingError)) {
      throw existingError;
    }
    return { inserted: 0, skipped: 0 };
  }

  const alreadySeeded = new Set(
    ((existing ?? []) as Row[]).map((row) => String(row.recurring_id ?? "")).filter(Boolean),
  );
  const pending = roster.filter((entry) => !alreadySeeded.has(entry.id));
  if (pending.length === 0) return { inserted: 0, skipped: roster.length };

  const { error } = await admin.from(RUN_TABLE).insert(
    pending.map((entry) => ({
      run_id: input.runId,
      recurring_id: entry.id,
      full_name_ar: entry.fullNameAr,
      full_name_en: entry.fullNameEn,
      total_salary: entry.totalSalary,
      bank_name: entry.bankName,
      bank_account: entry.bankAccount,
      part: entry.part,
      created_by: input.actorHrId,
    })),
  );
  if (error) throw error;

  await writeAutomatedPayrollAudit({
    runId: input.runId,
    actorHrId: input.actorHrId,
    action: "non_employee_recurring_seeded",
    detail: {
      inserted: pending.length,
      skipped: roster.length - pending.length,
      names: pending.map((entry) => `${entry.fullNameEn} (${entry.part})`),
      total: Math.round(pending.reduce((sum, entry) => sum + entry.totalSalary, 0) * 100) / 100,
    },
  });

  return { inserted: pending.length, skipped: roster.length - pending.length };
}

/**
 * The HR-facing "pull the standing list into this run" action, for a run that
 * already existed before the roster did (August 2026 is exactly this case: it was
 * opened on 2026-08-01 and carried no non-employees at all) or one where someone
 * has since been added to the register.
 */
export async function syncRunFromRecurring(
  access: AccessContext,
  runId: string,
): Promise<RecurringSeedResult> {
  assertAutomatedPayrollHrActor(access);
  const run = await getRunById(runId);
  if (!run) throw new Error("Not found: payroll run does not exist.");
  if (run.phase === "published") throw new Error("Conflict: this run is already published.");
  if (run.phase === "cancelled") throw new Error("Conflict: this run was cancelled.");
  return seedRunFromRecurring({ runId, actorHrId: actorId(access) });
}
