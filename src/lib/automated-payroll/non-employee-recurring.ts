import type { AccessContext } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { writeAutomatedPayrollAudit } from "./audit.ts";
import { getRunById } from "./draft-store.ts";
import { getNonEmployeePayrollRows, validateNonEmployeePayrollInput } from "./non-employees.ts";
import { actorId, assertAutomatedPayrollHrActor } from "./permissions.ts";
import { holdRun } from "./run-hold.ts";
import { RUN_HOLD_ACTIONS } from "./transition-claim.ts";
import type {
  MonthlySalaryRun,
  NonEmployeePayrollRow,
  NonEmployeePart,
  PreviousNonEmployeeCandidate,
  PreviousNonEmployeeList,
  PreviousRunCopyResult,
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

  const row = mapRow(data as Row);
  await auditRosterChange(access, "non_employee_recurring_added", row);
  return row;
}

/**
 * EVERY CHANGE TO THE STANDING LIST IS RECORDED (owner, 2026-11-24, after November's Part 1 opened with
 * no non-employees). This file used to say a register edit could not be audited because the audit
 * table's run_id was NOT NULL — it never was. So the list wrote nothing, all seven standing entries
 * were removed between 6 October and 13 November 2026, and nothing anywhere said who removed them.
 * The row carries no run (a register change belongs to none); best-effort like every audit row.
 */
async function auditRosterChange(
  access: AccessContext,
  action: "non_employee_recurring_added" | "non_employee_recurring_updated" | "non_employee_recurring_deleted",
  row: RecurringNonEmployeeRow,
  before?: RecurringNonEmployeeRow,
): Promise<void> {
  await writeAutomatedPayrollAudit({
    runId: null,
    actorHrId: actorId(access),
    action,
    detail: {
      recurringId: row.id,
      part: row.part,
      fullNameEn: row.fullNameEn,
      fullNameAr: row.fullNameAr,
      totalSalary: row.totalSalary,
      bankName: row.bankName,
      active: row.active,
      ...(before
        ? { before: { part: before.part, totalSalary: before.totalSalary, bankName: before.bankName, active: before.active } }
        : {}),
    },
  });
}

async function readRosterEntry(id: string): Promise<RecurringNonEmployeeRow | null> {
  const { data, error } = await getSupabaseAdmin().from(TABLE).select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? mapRow(data as Row) : null;
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

  const before = await readRosterEntry(id);
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
  const row = mapRow(data as Row);
  await auditRosterChange(access, "non_employee_recurring_updated", row, before ?? undefined);
  return row;
}

/**
 * Remove a roster entry outright. Rows already copied into runs survive — the FK
 * is `on delete set null` — so a published month keeps showing what it paid.
 * Deactivating is still the better move; this exists for entries added in error.
 */
export async function deleteRecurringNonEmployee(access: AccessContext, id: string): Promise<void> {
  assertAutomatedPayrollHrActor(access);
  // Read first, so the record names who was removed and what they were paid.
  const before = await readRosterEntry(id);
  const { error } = await getSupabaseAdmin().from(TABLE).delete().eq("id", id);
  if (error) throw error;
  if (before) await auditRosterChange(access, "non_employee_recurring_deleted", before);
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
  //
  // Under the run's hold (payroll audit 2026-11-14, S1): the phase above was read once, and a sync that
  // passed it while Part 2 was being confirmed inserted rows after the confirm. The hold re-checks that
  // the run is still in this phase, and Confirm waits for the sync to finish.
  const phase = run.phase;
  return holdRun({ runId, expected: [phase], action: RUN_HOLD_ACTIONS.nonEmployeeSync }, () =>
    seedRunFromRecurring({ runId, actorHrId: actorId(access), phase }),
  );
}

// ---- Copying last month's list ----------------------------------------------

/**
 * BRINGING BACK LAST MONTH'S NON-EMPLOYEES (owner, 2026-11-24: "in automated salary the non employees in
 * part 1 disappeared"). All seven standing entries were removed between 6 October and 13 November 2026,
 * so the November run opened on 22 November with nobody to copy. The earlier months still hold every
 * person, amount and bank — so the screen shows the latest PUBLISHED month's list, HR ticks who comes
 * back, and only then is anything written.
 *
 * Each person copied is put on this month's list at LAST MONTH'S amount (what HR was shown), and back on
 * the standing list when they are not on it, so the month after seeds itself again. Nobody already on
 * this month's list for that part is copied twice, and a part whose money is out is never added to.
 */
type IdentityFields = {
  bankAccount?: string | null;
  fullNameEn?: string | null;
  fullNameAr?: string | null;
};

/**
 * Every key a person can be recognised by — the account and both names. Matching on ANY shared key is
 * the side that never pays twice: the standing list's unique index is on the name, and a row typed by
 * hand may carry the account under a differently spelt name.
 */
function identityKeys(entry: IdentityFields): string[] {
  const keys: string[] = [];
  // Spaces, dashes and dots are how an account is typed, not part of it.
  const account = String(entry.bankAccount ?? "").replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
  if (account) keys.push(`account:${account}`);
  for (const name of [entry.fullNameEn, entry.fullNameAr]) {
    const normal = String(name ?? "").trim().replace(/\s+/g, " ").toLowerCase();
    if (normal) keys.push(`name:${normal}`);
  }
  return keys;
}

function partLabel(part: NonEmployeePart): string {
  return part === "first" ? "Part 1" : "Part 2";
}

/** Pure — the whole decision of who may be copied, so it is assertable without a database. */
export function planPreviousRunCopy(input: {
  previous: NonEmployeePayrollRow[];
  roster: RecurringNonEmployeeRow[];
  current: Array<IdentityFields & { part: NonEmployeePart }>;
  phase: MonthlySalaryRun["phase"];
}): PreviousNonEmployeeCandidate[] {
  const onThisRun = new Set(
    input.current.flatMap((row) => identityKeys(row).map((key) => `${row.part}\u0000${key}`)),
  );
  const standing = new Map<string, string>();
  for (const entry of input.roster) {
    for (const key of identityKeys(entry)) {
      const slot = `${entry.part}\u0000${key}`;
      if (!standing.has(slot)) standing.set(slot, entry.id);
    }
  }

  return input.previous.map((row) => {
    const keys = identityKeys(row).map((key) => `${row.part}\u0000${key}`);
    let blockedReason: string | null = null;
    if (!partStillOpen(row.part, input.phase)) {
      blockedReason = `${partLabel(row.part)} is already confirmed, so nobody can be added to it.`;
    } else {
      try {
        validateNonEmployeePayrollInput({
          fullNameAr: row.fullNameAr,
          fullNameEn: row.fullNameEn,
          totalSalary: row.totalSalary,
          bankName: row.bankName,
          bankAccount: row.bankAccount,
          part: row.part,
        });
      } catch (error) {
        blockedReason = String(error instanceof Error ? error.message : error).replace(/^Validation:\s*/, "");
      }
    }
    return {
      id: row.id,
      part: row.part,
      fullNameEn: row.fullNameEn,
      fullNameAr: row.fullNameAr,
      totalSalary: row.totalSalary,
      bankName: row.bankName,
      bankAccount: row.bankAccount,
      blockedReason,
      alreadyOnThisRun: keys.some((key) => onThisRun.has(key)),
      standingEntryId: keys.map((key) => standing.get(key)).find(Boolean) ?? null,
    };
  });
}

/** "2026-10" → "October 2026". */
function monthName(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  if (!year || !month) return monthKey;
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** The latest PUBLISHED run before this one — the last list that was actually paid. */
async function previousPublishedRun(run: MonthlySalaryRun): Promise<{ id: string; monthKey: string } | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("automated_payroll_runs")
    .select("id,month_key")
    .eq("phase", "published")
    .lt("month_key", run.monthKey)
    .order("month_key", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? { id: String((data as Row).id), monthKey: String((data as Row).month_key) } : null;
}

/** Every standing entry, switched-off ones too — a switched-off entry is still that person's entry. */
async function allRosterRows(): Promise<RecurringNonEmployeeRow[]> {
  const { data, error } = await getSupabaseAdmin().from(TABLE).select("*");
  if (error) {
    if (isMissingTableError(error)) return [];
    throw error;
  }
  return ((data ?? []) as Row[]).map(mapRow);
}

async function requireOpenRun(runId: string): Promise<MonthlySalaryRun> {
  const run = await getRunById(runId);
  if (!run) throw new Error("Not found: payroll run does not exist.");
  if (run.phase === "published") throw new Error("Conflict: this run is already published.");
  if (run.phase === "cancelled") throw new Error("Conflict: this run was cancelled.");
  return run;
}

async function loadPreviousRunPlan(run: MonthlySalaryRun): Promise<PreviousNonEmployeeList> {
  const previous = await previousPublishedRun(run);
  if (!previous) return { fromRunId: null, fromMonthKey: null, candidates: [] };
  const [previousRows, roster, current] = await Promise.all([
    getNonEmployeePayrollRows(previous.id),
    allRosterRows(),
    getNonEmployeePayrollRows(run.id),
  ]);
  return {
    fromRunId: previous.id,
    fromMonthKey: previous.monthKey,
    candidates: planPreviousRunCopy({ previous: previousRows, roster, current, phase: run.phase }),
  };
}

/** What the screen shows before anything is copied. Reads only. */
export async function previewPreviousRunNonEmployees(
  access: AccessContext,
  runId: string,
): Promise<PreviousNonEmployeeList> {
  assertAutomatedPayrollHrActor(access);
  const run = await requireOpenRun(runId);
  return loadPreviousRunPlan(run);
}

/**
 * Copy the ticked people from last month's list. Under the run's hold, and the plan is worked out again
 * inside it, so a person added or a part confirmed since the screen loaded is honoured.
 */
export async function copyPreviousRunNonEmployees(
  access: AccessContext,
  runId: string,
  selectedIds: string[],
): Promise<PreviousRunCopyResult> {
  assertAutomatedPayrollHrActor(access);
  if (selectedIds.length === 0) throw new Error("Validation: tick at least one person to copy.");
  const run = await requireOpenRun(runId);
  const actorHrId = actorId(access);

  return holdRun({ runId, expected: [run.phase], action: RUN_HOLD_ACTIONS.nonEmployeeCopy }, async () => {
    const fresh = await requireOpenRun(runId);
    const plan = await loadPreviousRunPlan(fresh);
    if (!plan.fromRunId || !plan.fromMonthKey) {
      throw new Error("Not found: there is no earlier published month to copy from.");
    }
    const fromMonthKey = plan.fromMonthKey;
    const byId = new Map(plan.candidates.map((candidate) => [candidate.id, candidate]));
    if (selectedIds.some((id) => !byId.has(id))) {
      throw new Error("Conflict: last month's list changed since this screen opened. Reload and tick again.");
    }

    const notCopied: PreviousRunCopyResult["notCopied"] = [];
    const toCopy: PreviousNonEmployeeCandidate[] = [];
    for (const id of new Set(selectedIds)) {
      const candidate = byId.get(id);
      if (!candidate) continue;
      const name = candidate.fullNameEn || candidate.fullNameAr;
      if (candidate.blockedReason) {
        notCopied.push({ name, reason: candidate.blockedReason });
      } else if (candidate.alreadyOnThisRun) {
        notCopied.push({ name, reason: `already on this month's ${partLabel(candidate.part)} list.` });
      } else {
        toCopy.push(candidate);
      }
    }

    const addedToStandingList: string[] = [];
    const runRows: Row[] = [];
    for (const candidate of toCopy) {
      let recurringId = candidate.standingEntryId;
      if (!recurringId) {
        const { data, error } = await getSupabaseAdmin()
          .from(TABLE)
          .insert({
            full_name_ar: candidate.fullNameAr.trim(),
            full_name_en: candidate.fullNameEn.trim(),
            total_salary: candidate.totalSalary,
            bank_name: candidate.bankName?.trim() || null,
            bank_account: candidate.bankAccount?.trim() || null,
            part: candidate.part,
            active: true,
            note: `Brought back from the ${monthName(fromMonthKey)} list.`,
            created_by: actorHrId,
          })
          .select("*")
          .single();
        if (error) rethrowDuplicate(error, candidate.fullNameEn, candidate.part);
        const entry = mapRow(data as Row);
        recurringId = entry.id;
        addedToStandingList.push(`${entry.fullNameEn || entry.fullNameAr} (${partLabel(entry.part)})`);
        await auditRosterChange(access, "non_employee_recurring_added", entry);
      }
      runRows.push({
        run_id: runId,
        recurring_id: recurringId,
        full_name_ar: candidate.fullNameAr,
        full_name_en: candidate.fullNameEn,
        total_salary: candidate.totalSalary,
        bank_name: candidate.bankName,
        bank_account: candidate.bankAccount,
        part: candidate.part,
        created_by: actorHrId,
      });
    }

    if (runRows.length > 0) {
      const { error } = await getSupabaseAdmin().from(RUN_TABLE).insert(runRows);
      if (error) throw error;
    }

    const copied = toCopy.map(
      (candidate) => `${candidate.fullNameEn || candidate.fullNameAr} (${partLabel(candidate.part)})`,
    );
    await writeAutomatedPayrollAudit({
      runId,
      actorHrId,
      action: "non_employee_copied_from_previous_run",
      detail: {
        fromRunId: plan.fromRunId,
        fromMonthKey,
        copied,
        total: Math.round(toCopy.reduce((sum, candidate) => sum + candidate.totalSalary, 0) * 100) / 100,
        addedToStandingList,
        notCopied,
      },
    });

    return { fromMonthKey, copied, addedToStandingList, notCopied };
  });
}
