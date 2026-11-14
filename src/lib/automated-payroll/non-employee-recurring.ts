import type { AccessContext } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { writeAutomatedPayrollAudit } from "./audit.ts";
import { getRunById } from "./draft-store.ts";
import { validateNonEmployeePayrollInput } from "./non-employees.ts";
import { actorId, assertAutomatedPayrollHrActor } from "./permissions.ts";
import type {
  MonthlySalaryRun,
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

/** Only `.from` is ever reached here, which is what makes the fixture in the tests sufficient. */
type SeedClient = Pick<ReturnType<typeof getSupabaseAdmin>, "from">;

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

/**
 * The per-run entry's own rule (payroll audit 2026-11-14, finding 11). The standing list kept its own copy
 * without the bank check, so a paid entry with no bank or account was accepted here and copied into every
 * new run, where the sheet counted the person as paid and no bank file carried them.
 */
function validateInput(input: RecurringNonEmployeeInput): void {
  validateNonEmployeePayrollInput(input);
}

/** True when an entry would be refused by the per-run rule — a paid entry with nowhere to send the money. */
function paidWithNoBank(entry: { totalSalary: number; bankName: string | null; bankAccount: string | null }): boolean {
  return entry.totalSalary > 0 && (!entry.bankName?.trim() || !entry.bankAccount?.trim());
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
async function activeRecurringRows(client: SeedClient = getSupabaseAdmin()): Promise<RecurringNonEmployeeRow[]> {
  const { data, error } = await client.from(TABLE).select("*").eq("active", true);
  if (error) {
    if (isMissingTableError(error)) return [];
    throw error;
  }
  return ((data ?? []) as Row[]).map(mapRow);
}

/**
 * Copy the active standing roster into one run's Non-Employees Payroll list.
 *
 * Idempotent by `(run_id, recurring_id)`: an entry already copied into this run is left exactly as
 * it is, amount included, so a re-sync never overwrites an amount HR adjusted for this month.
 *
 * IT IS GATED ON THE RUN PHASE, per part. This comment used to say the opposite — "deliberately
 * NOT gated on the run phase" — and that was the whole of finding 17: pressing Sync during Part 2
 * inserted a first-instalment row onto a Part 1 finance had already executed, and the per-part
 * edit lock in non-employees.ts then made that row impossible to change or remove. The half the
 * old comment got right survives: a `second` entry may still be placed while the run is in Part 1,
 * because that money has not gone out yet. See partStillOpen.
 *
 * It also refuses to seed somebody the run ALREADY carries for that part under a different
 * provenance. The old guard matched only on `recurring_id`, so a person typed in by hand was
 * invisible to it and could be seeded on top of themselves — two rows, both reaching the bank
 * file. See identityOf.
 *
 * A published or cancelled run is refused by the caller, because that money is already gone.
 */
/**
 * Whose money for this part has NOT yet been executed, and may therefore still be added to.
 *
 * A `first` entry is money in the first instalment, which finance executes at Confirm Part 1 —
 * after that the figure has left the company and the run must not grow it. A `second` entry is
 * money in the residual, which is fixed at Confirm Part 2.
 *
 * This is deliberately NOT the same question as `EDITABLE_PHASE` in non-employees.ts, which asks
 * when a row may be CHANGED. Seeding a `second` entry while the run is still in `part1` is
 * perfectly safe and is how every normal month works — production's August run seeded all seven
 * three hours before Part 1 was confirmed. What must never happen is the reverse: adding to a part
 * whose money is already out.
 */
function partStillOpen(part: NonEmployeePart, phase: MonthlySalaryRun["phase"]): boolean {
  return part === "first" ? phase === "part1" : phase === "part1" || phase === "part2";
}

/**
 * How a non-employee is recognised as the same person across two rows.
 *
 * They have no HR record and no employee id — that is what makes them non-employees — so the only
 * durable identity is what the money is actually sent to. The bank account is the strongest
 * signal and is used whenever it is present; a name is the fallback, normalised so that spacing
 * and casing cannot make one person look like two.
 *
 * Returns null when a row carries nothing usable, and a null identity matches nothing. An entry
 * with no account and no name cannot be proven a duplicate, and refusing to seed on that basis
 * would drop a real payment on a guess.
 */
function identityOf(entry: {
  bankAccount?: string | null;
  fullNameEn?: string | null;
  fullNameAr?: string | null;
}): string | null {
  const account = String(entry.bankAccount ?? "").replace(/\s+/g, "").toLowerCase();
  if (account) return `account:${account}`;
  const english = String(entry.fullNameEn ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  if (english) return `name:${english}`;
  const arabic = String(entry.fullNameAr ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  if (arabic) return `name:${arabic}`;
  return null;
}

export async function seedRunFromRecurring(input: {
  runId: string;
  actorHrId: string;
  /**
   * The run's phase, so a part whose money is already executed cannot be added to. Optional only
   * so an older caller keeps compiling; every caller in this module passes it.
   */
  phase?: MonthlySalaryRun["phase"];
  /** Injected only by the test — production always uses the admin client. */
  client?: SeedClient;
}): Promise<RecurringSeedResult> {
  const client = input.client ?? getSupabaseAdmin();
  const empty: RecurringSeedResult = { inserted: 0, skipped: 0, skippedAsDuplicate: [], heldBackPartClosed: [], heldBackNoBank: [] };
  const roster = await activeRecurringRows(client);
  if (roster.length === 0) return empty;

  const admin = client;
  // Read the run's OWN entries, not just the seeded ones: a hand-typed row has no recurring_id and
  // was therefore invisible to the old guard, which is exactly how the same person could be seeded
  // on top of themselves and paid twice.
  const { data: existing, error: existingError } = await admin
    .from(RUN_TABLE)
    .select("recurring_id,part,bank_account,full_name_en,full_name_ar")
    .eq("run_id", input.runId);
  if (existingError) {
    // No provenance column yet => nothing was ever seeded, so seed everything.
    if (!isMissingRecurringColumnError(existingError) && !isMissingTableError(existingError)) {
      throw existingError;
    }
    return empty;
  }

  const rows = (existing ?? []) as Row[];
  const alreadySeeded = new Set(
    rows.map((row) => String(row.recurring_id ?? "")).filter(Boolean),
  );
  // Keyed by part, because one person legitimately appears once in each instalment when their
  // salary is split — production carries that case today.
  const alreadyOnTheRun = new Set(
    rows
      .map((row) => {
        const identity = identityOf({
          bankAccount: row.bank_account as string | null,
          fullNameEn: row.full_name_en as string | null,
          fullNameAr: row.full_name_ar as string | null,
        });
        return identity ? `${String(row.part ?? "")}\u0000${identity}` : "";
      })
      .filter(Boolean),
  );

  const skippedAsDuplicate: string[] = [];
  const heldBackPartClosed: string[] = [];
  const heldBackNoBank: string[] = [];
  const pending = roster.filter((entry) => {
    if (alreadySeeded.has(entry.id)) return false;
    // An entry saved before the bank check (finding 11) is not copied in: the sheet would count the
    // person as paid while no bank file carried them. Named, so somebody adds the bank.
    if (paidWithNoBank(entry)) {
      heldBackNoBank.push(entry.fullNameEn || entry.fullNameAr || entry.id);
      return false;
    }
    if (input.phase && !partStillOpen(entry.part, input.phase)) {
      heldBackPartClosed.push(entry.fullNameEn || entry.fullNameAr || entry.id);
      return false;
    }
    const identity = identityOf(entry);
    if (identity && alreadyOnTheRun.has(`${entry.part}\u0000${identity}`)) {
      skippedAsDuplicate.push(entry.fullNameEn || entry.fullNameAr || entry.id);
      return false;
    }
    return true;
  });

  const skipped =
    roster.length - pending.length - skippedAsDuplicate.length - heldBackPartClosed.length - heldBackNoBank.length;
  if (pending.length === 0) {
    return { inserted: 0, skipped, skippedAsDuplicate, heldBackPartClosed, heldBackNoBank };
  }

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

  // To the same client as every other write here. Left to its default, a test that injected a fake
  // still sent this row to the real database. `input.client` is unset in production, so the audit
  // writer resolves the admin client exactly as it always did.
  await writeAutomatedPayrollAudit({
    runId: input.runId,
    actorHrId: input.actorHrId,
    action: "non_employee_recurring_seeded",
    detail: {
      inserted: pending.length,
      skipped,
      names: pending.map((entry) => `${entry.fullNameEn} (${entry.part})`),
      total: Math.round(pending.reduce((sum, entry) => sum + entry.totalSalary, 0) * 100) / 100,
      // Named, not just counted: somebody the sync refused is a person who does not get paid this
      // month unless a human looks. A count alone reads as housekeeping.
      skippedAsDuplicate,
      heldBackPartClosed,
      heldBackNoBank,
    },
  }, input.client);

  return { inserted: pending.length, skipped, skippedAsDuplicate, heldBackPartClosed, heldBackNoBank };
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
  // The phase is what stops this adding money to an instalment finance has already executed —
  // see partStillOpen. Without it, pressing Sync during Part 2 put a first-instalment row on a
  // paid Part 1, and the per-part edit lock then made that row impossible to remove.
  return seedRunFromRecurring({ runId, actorHrId: actorId(access), phase: run.phase });
}
