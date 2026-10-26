import { compactHrKey } from "@/lib/payroll/copilot/feeders.ts";
import { hrIdForStorage } from "@/lib/hr-id";
import { roundCurrency } from "@/lib/payroll/money";
import type { AccessContext } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { writeAutomatedPayrollAudit } from "./audit.ts";
import { actorId, assertAutomatedPayrollHrActor } from "./permissions.ts";

/**
 * "This held salary was already transferred outside payroll."
 *
 * Owner rule 2026-09-10: a held employee is paid by hand during the month, and until now nothing
 * recorded that it happened — so the next month could work the same amount up again, and nobody
 * could answer "was this settled?" a month later.
 *
 * TWO HALVES, DELIBERATELY FROM DIFFERENT SOURCES, because a single source could not be trusted:
 *
 *   - WHAT WAS WITHHELD comes from the run's own `published` audit row, written at the moment
 *     publish dropped the person. It is a fact about what the system did, produced by the system.
 *   - WHAT WAS PAID comes from this table, typed by a human after a bank transfer. It is an
 *     attestation, and nothing here verifies it against a bank.
 *
 * Keeping them apart is what makes a SHORT payment visible. If a settlement simply overwrote the
 * owed figure, paying 5,000 against 9,800 owed would read as fully settled.
 */

const TABLE = "automated_payroll_held_settlements";
/**
 * What PAYROLL released of a held month (Held Salary Release, owner 2026-10-26) — one row per
 * (paying run, held run, employee). Deliberately NOT the by-hand table above: a by-hand record is an
 * attestation HR can correct or withdraw, and letting that edit overwrite what a payroll run paid
 * would re-open a debt the company had already paid (and the reverse would lose a bank reference).
 */
const RELEASES_TABLE = "automated_payroll_held_releases";

export type HeldSettlement = {
  id: string;
  runId: string;
  employeeHrId: string;
  employeeHrIdCompact: string;
  amount: number;
  paidOn: string;
  method: string | null;
  reference: string | null;
  note: string | null;
  recordedBy: string;
  updatedAt: string;
};

export type HeldSettlementInput = {
  hrId: string;
  amount: number;
  paidOn: string;
  method?: string | null;
  reference?: string | null;
  note?: string | null;
};

/** One month's held person: what the run withheld, and what (if anything) was settled by hand. */
export type HeldBalance = {
  runId: string;
  month: number;
  year: number;
  hrId: string;
  compact: string;
  name: string;
  reason: string | null;
  firstPartAlreadyPaid: number;
  secondPartWithheld: number;
  settled: HeldSettlement | null;
  /**
   * Released against this held month by OTHER payroll runs that are not cancelled — published ones
   * (paid) and ones whose Part 2 is confirmed but not yet published (the bank file can already pay
   * it, so it is reserved). The run asking is never counted against itself.
   */
  releasedByPayroll: number;
  /** Withheld minus settled by hand minus released by payroll, floored at zero. The figure that must not be paid twice. */
  outstanding: number;
};

type Row = Record<string, unknown>;

function mapRow(row: Row): HeldSettlement {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    employeeHrId: String(row.employee_hr_id ?? ""),
    employeeHrIdCompact: String(row.employee_hr_id_compact ?? ""),
    amount: Number(row.amount ?? 0),
    paidOn: String(row.paid_on ?? "").slice(0, 10),
    method: (row.method as string | null) ?? null,
    reference: (row.reference as string | null) ?? null,
    note: (row.note as string | null) ?? null,
    recordedBy: String(row.recorded_by ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

/**
 * True when the table itself has not been migrated into this environment yet. Same add-only
 * tolerance as every other table in this module: a missing settlements table must never take the
 * payroll sheet down with it.
 */
function isMissingTableError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  const message = String((error as { message?: string } | null)?.message ?? error ?? "").toLowerCase();
  return code === "42P01" || code === "PGRST205" || (message.includes("relation") && message.includes("does not exist"));
}

function validate(input: HeldSettlementInput): void {
  if (!input.hrId?.trim()) throw new Error("Validation: an employee is required.");
  if (!Number.isFinite(input.amount) || input.amount < 0) {
    throw new Error("Validation: the amount transferred must be a non-negative number.");
  }
  // A date is mandatory. "It was paid at some point" is the state this whole table exists to
  // replace, so a settlement with no date would recreate the problem inside the fix.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.paidOn ?? ""))) {
    throw new Error("Validation: the transfer date is required, as YYYY-MM-DD.");
  }
}

/** Settlements recorded against one run, keyed by compact HR id. */
export async function getHeldSettlements(runId: string): Promise<Map<string, HeldSettlement>> {
  const byCompact = new Map<string, HeldSettlement>();
  const { data, error } = await getSupabaseAdmin().from(TABLE).select("*").eq("run_id", runId);
  if (error) {
    if (isMissingTableError(error)) return byCompact;
    throw error;
  }
  for (const row of (data ?? []) as Row[]) {
    const settlement = mapRow(row);
    if (settlement.employeeHrIdCompact) byCompact.set(settlement.employeeHrIdCompact, settlement);
  }
  return byCompact;
}

/**
 * Record (or correct) the fact that a held person was paid outside payroll.
 *
 * Upsert on (run_id, employee) rather than insert: paying in two transfers updates the one row and
 * says so in the note. Stacking partial rows would leave every reader to sum them correctly, and
 * the first reader to forget would report a settled person as unpaid.
 */
export async function recordHeldSettlement(
  access: AccessContext,
  runId: string,
  input: HeldSettlementInput,
): Promise<HeldSettlement> {
  assertAutomatedPayrollHrActor(access);
  validate(input);

  const compact = compactHrKey(input.hrId);
  if (!compact) throw new Error("Validation: that employee id is not usable.");

  const payload = {
    run_id: runId,
    // Storage casing for the human-readable column, compact for every join — the mixed-case HR id
    // trap this repo has repaired in six other columns.
    employee_hr_id: hrIdForStorage(input.hrId) ?? input.hrId.trim(),
    employee_hr_id_compact: compact,
    amount: roundCurrency(input.amount),
    paid_on: input.paidOn,
    method: input.method?.trim() || null,
    reference: input.reference?.trim() || null,
    note: input.note?.trim() || null,
    recorded_by: actorId(access),
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .upsert(payload, { onConflict: "run_id,employee_hr_id_compact" })
    .select("*")
    .single();
  if (error) throw error;

  const settlement = mapRow(data as Row);
  await writeAutomatedPayrollAudit({
    runId,
    actorHrId: actorId(access),
    action: "held_settlement_recorded",
    detail: {
      hrId: settlement.employeeHrId,
      amount: settlement.amount,
      paidOn: settlement.paidOn,
      method: settlement.method,
      reference: settlement.reference,
    },
  });
  return settlement;
}

/** Withdraw a settlement that was recorded in error. Audited, because it re-opens a debt. */
export async function deleteHeldSettlement(
  access: AccessContext,
  runId: string,
  hrId: string,
): Promise<void> {
  assertAutomatedPayrollHrActor(access);
  const compact = compactHrKey(hrId);
  if (!compact) throw new Error("Validation: that employee id is not usable.");

  const { error } = await getSupabaseAdmin()
    .from(TABLE)
    .delete()
    .eq("run_id", runId)
    .eq("employee_hr_id_compact", compact);
  if (error) throw error;

  await writeAutomatedPayrollAudit({
    runId,
    actorHrId: actorId(access),
    action: "held_settlement_withdrawn",
    detail: { hrId, compact },
  });
}

type PublishedHeldEntry = {
  hrId?: unknown;
  name?: unknown;
  reason?: unknown;
  firstPartAlreadyPaid?: unknown;
  secondPartWithheld?: unknown;
};

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Every held person from every PUBLISHED run, with what they were withheld and whether it has been
 * settled by hand since.
 *
 * Reads the `published` audit row rather than re-assembling the month. That row is written at the
 * exact moment publish drops the person and is never recomputed, so it cannot drift as salaries
 * change afterwards — and re-assembling an old month would produce today's numbers for a payment
 * decision taken weeks ago.
 *
 * `excludeRunId` drops the run being worked on, so the current month's own holds do not read as a
 * debt against themselves.
 */
export async function loadHeldBalances(options?: { excludeRunId?: string }): Promise<HeldBalance[]> {
  const admin = getSupabaseAdmin();

  const { data: auditRows, error: auditError } = await admin
    .from("automated_payroll_audit")
    .select("run_id,detail,created_at")
    .eq("action", "published")
    .order("created_at", { ascending: false });
  if (auditError) {
    if (isMissingTableError(auditError)) return [];
    throw auditError;
  }

  const runIds = Array.from(
    new Set(((auditRows ?? []) as Row[]).map((row) => String(row.run_id ?? "")).filter(Boolean)),
  );
  if (runIds.length === 0) return [];

  // Chunked: a PostgREST `.in()` carrying several hundred ids returns zero rows and no error.
  // Run counts are small today, and this is the shape that stays correct when they are not.
  const runsById = new Map<string, { month: number; year: number }>();
  for (let index = 0; index < runIds.length; index += 50) {
    const chunk = runIds.slice(index, index + 50);
    const { data, error } = await admin
      .from("automated_payroll_runs")
      .select("id,month,year")
      .in("id", chunk);
    if (error) throw error;
    for (const row of (data ?? []) as Row[]) {
      runsById.set(String(row.id), { month: Number(row.month ?? 0), year: Number(row.year ?? 0) });
    }
  }

  const settlementsByRun = new Map<string, Map<string, HeldSettlement>>();
  for (const runId of runIds) settlementsByRun.set(runId, await getHeldSettlements(runId));
  const releasedByPayroll = payrollReleasedByHeldMonth(await loadPayrollReleases(), options?.excludeRunId);

  const balances: HeldBalance[] = [];
  const seen = new Set<string>();
  for (const row of (auditRows ?? []) as Row[]) {
    const runId = String(row.run_id ?? "");
    if (!runId || runId === options?.excludeRunId) continue;
    // A run can legitimately have more than one `published` audit row (an interrupted publish that
    // was retried). Newest first, so the first one seen is the one that stands.
    if (seen.has(runId)) continue;
    seen.add(runId);

    const period = runsById.get(runId);
    if (!period) continue;
    const detail = (row.detail ?? {}) as { held?: unknown };
    const held = Array.isArray(detail.held) ? (detail.held as PublishedHeldEntry[]) : [];
    const settlements = settlementsByRun.get(runId) ?? new Map<string, HeldSettlement>();

    for (const entry of held) {
      const hrId = String(entry.hrId ?? "");
      const compact = compactHrKey(hrId);
      if (!compact) continue;
      const withheld = roundCurrency(num(entry.secondPartWithheld));
      const settled = settlements.get(compact) ?? null;
      const released = releasedByPayroll.get(releaseKey(runId, compact)) ?? 0;
      balances.push({
        runId,
        month: period.month,
        year: period.year,
        hrId,
        compact,
        name: String(entry.name ?? ""),
        reason: entry.reason == null ? null : String(entry.reason),
        firstPartAlreadyPaid: roundCurrency(num(entry.firstPartAlreadyPaid)),
        secondPartWithheld: withheld,
        settled,
        releasedByPayroll: released,
        outstanding: Math.max(0, roundCurrency(withheld - (settled?.amount ?? 0) - released)),
      });
    }
  }
  return balances;
}

/**
 * Outstanding held money per employee across every earlier published month, keyed by compact HR id.
 *
 * This is what the current run needs in order to answer the owner's question — "the next payroll
 * they should not be added ... I have nothing to say that this is already transferred outside the
 * payroll". A person with an outstanding balance here has money the company still owes; a person
 * with none has either never been held or has been settled by hand and recorded.
 */
export async function outstandingHeldByEmployee(currentRunId: string): Promise<Map<string, HeldBalance[]>> {
  const balances = await loadHeldBalances({ excludeRunId: currentRunId });
  const byEmployee = new Map<string, HeldBalance[]>();
  for (const balance of balances) {
    if (balance.outstanding <= 0) continue;
    const list = byEmployee.get(balance.compact) ?? [];
    list.push(balance);
    byEmployee.set(balance.compact, list);
  }
  return byEmployee;
}

/** One slice of a release: how much of it settles which held month. */
export type ReleaseAllocation = { runId: string; month: number; year: number; amount: number };

/**
 * Split one release across the person's outstanding held months, OLDEST FIRST, never paying any
 * month past what it still owes.
 *
 * Pure, so the rule that decides which debt a payment clears is unit-tested directly. Oldest first
 * because that is the debt that has waited longest, and because it makes a partial release
 * predictable: the held-salary sheet then shows the older month cleared and the newer one still
 * open, rather than both half-paid.
 *
 * Whatever exceeds the total outstanding is DROPPED, not carried — the step and publish both refuse
 * a release above the balance, so a remainder here means the balance moved underneath the run, and
 * recording more than was owed would turn a settled debt into an overpayment on paper.
 */
export function allocateRelease(balances: readonly HeldBalance[], amount: number): ReleaseAllocation[] {
  let remaining = roundCurrency(Math.max(0, Number.isFinite(amount) ? amount : 0));
  const ordered = [...balances]
    .filter((balance) => balance.outstanding > 0)
    .sort((a, b) => a.year - b.year || a.month - b.month || a.runId.localeCompare(b.runId));
  const allocations: ReleaseAllocation[] = [];
  for (const balance of ordered) {
    if (remaining <= 0) break;
    const take = roundCurrency(Math.min(remaining, balance.outstanding));
    if (take <= 0) continue;
    allocations.push({ runId: balance.runId, month: balance.month, year: balance.year, amount: take });
    remaining = roundCurrency(remaining - take);
  }
  return allocations;
}

/** One payroll release row: what a paying run released of one held month, for one person. */
export type PayrollReleaseRow = {
  payingRunId: string;
  /** The paying run's phase. A cancelled run paid nobody, so its rows count for nothing. */
  payingRunPhase: string | null;
  heldRunId: string;
  compact: string;
  amount: number;
};

function releaseKey(heldRunId: string, compact: string): string {
  return `${heldRunId}|${compact}`;
}

/**
 * Sum the payroll releases against each (held month, person), leaving out the asking run's own rows
 * and every cancelled run's. Pure, so the rule that decides what still counts is tested directly.
 *
 * The asking run's own rows are left out ON PURPOSE: they are what that run is about to pay (or has
 * paid), so counting them would make a retried confirm or publish refuse its own release as "no
 * longer owed". Everyone else's count, including a run that is confirmed but not yet published —
 * its bank file can already have paid the money.
 */
export function payrollReleasedByHeldMonth(
  rows: readonly PayrollReleaseRow[],
  excludeRunId?: string,
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (excludeRunId && row.payingRunId === excludeRunId) continue;
    if (row.payingRunPhase === "cancelled") continue;
    const key = releaseKey(row.heldRunId, row.compact);
    totals.set(key, roundCurrency((totals.get(key) ?? 0) + row.amount));
  }
  return totals;
}

/**
 * Every payroll release, with its paying run's phase. A read failure THROWS, missing table included:
 * reading "nothing was released" when the ledger could not be read would offer the same money again.
 */
async function loadPayrollReleases(): Promise<PayrollReleaseRow[]> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from(RELEASES_TABLE)
    .select("paying_run_id,held_run_id,employee_hr_id_compact,amount");
  if (error) throw error;
  const raw = (data ?? []) as Row[];
  if (raw.length === 0) return [];
  const payingIds = Array.from(new Set(raw.map((row) => String(row.paying_run_id ?? "")).filter(Boolean)));
  const phaseById = new Map<string, string>();
  for (let index = 0; index < payingIds.length; index += 50) {
    const { data: runs, error: runError } = await admin
      .from("automated_payroll_runs")
      .select("id,phase")
      .in("id", payingIds.slice(index, index + 50));
    if (runError) throw runError;
    for (const run of (runs ?? []) as Row[]) phaseById.set(String(run.id), String(run.phase ?? ""));
  }
  return raw.map((row) => ({
    payingRunId: String(row.paying_run_id ?? ""),
    // An unknown phase is NOT treated as cancelled: an unreadable run still holds its money back.
    payingRunPhase: phaseById.get(String(row.paying_run_id ?? "")) ?? null,
    heldRunId: String(row.held_run_id ?? ""),
    compact: String(row.employee_hr_id_compact ?? ""),
    amount: Number(row.amount ?? 0),
  }));
}

/** One person's release, split across their held months. */
export type PlannedHeldRelease = { hrId: string; compact: string; amount: number; allocations: ReleaseAllocation[] };

/**
 * Split every release across the person's outstanding held months, and REFUSE one that is not owed in
 * full. Pure. The callers check the balance first (assertHeldReleasesPayable); a shortfall here means
 * it moved in between, and recording less than is paid would leave money paid with no record.
 */
export function planHeldReleases(
  balancesByEmployee: Map<string, HeldBalance[]>,
  releases: readonly { hrId: string; amount: number }[],
): PlannedHeldRelease[] {
  const planned: PlannedHeldRelease[] = [];
  const short: string[] = [];
  for (const release of releases) {
    const amount = roundCurrency(release.amount);
    if (!(amount > 0)) continue;
    const compact = compactHrKey(release.hrId);
    if (!compact) {
      short.push(`${release.hrId}: not a usable employee id`);
      continue;
    }
    const allocations = allocateRelease(balancesByEmployee.get(compact) ?? [], amount);
    const covered = roundCurrency(allocations.reduce((sum, allocation) => sum + allocation.amount, 0));
    if (covered !== amount) {
      short.push(`${release.hrId}: release ${amount.toFixed(2)} but only ${covered.toFixed(2)} is still held`);
      continue;
    }
    planned.push({ hrId: release.hrId, compact, amount, allocations });
  }
  if (short.length > 0) {
    throw new Error(`Validation: re-open Held Salary Release and correct it. ${short.slice(0, 6).join("; ")}`);
  }
  return planned;
}

/**
 * Record what THIS run releases of earlier months' held salary — at Part 2 confirm (the bank files can
 * pay it from then on, so it is reserved against every other run and the held-salary sheet) and again
 * at publish (from the rows actually published).
 *
 * THE RUN'S ROWS ARE REPLACED, NEVER ADDED TO. The balances are read without this run's own rows, the
 * plan is written over them, and anything this run recorded before that is no longer planned is
 * removed. So a confirm re-done after a reopen, or a publish retried after an interruption, leaves
 * exactly one record of what the run pays — never a second allocation against a month the first
 * attempt already cleared. Written upsert-first, prune-second: a failure part-way leaves MORE
 * reserved, never less, so it can hold money back but never offer it twice.
 */
export async function recordHeldReleases(input: {
  runId: string;
  actorHrId: string;
  stage: "part2_confirmed" | "published";
  releases: readonly { hrId: string; amount: number }[];
}): Promise<PlannedHeldRelease[]> {
  const admin = getSupabaseAdmin();
  const planned = planHeldReleases(await outstandingHeldByEmployee(input.runId), input.releases);
  const now = new Date().toISOString();
  const payload = planned.flatMap((release) =>
    release.allocations.map((allocation) => ({
      paying_run_id: input.runId,
      held_run_id: allocation.runId,
      employee_hr_id: hrIdForStorage(release.hrId) ?? release.hrId.trim(),
      employee_hr_id_compact: release.compact,
      amount: allocation.amount,
      recorded_by: input.actorHrId,
      updated_at: now,
    })),
  );
  if (payload.length > 0) {
    const { error } = await admin
      .from(RELEASES_TABLE)
      .upsert(payload, { onConflict: "paying_run_id,held_run_id,employee_hr_id_compact" });
    if (error) throw error;
  }

  const keep = new Set(payload.map((row) => releaseKey(row.held_run_id, row.employee_hr_id_compact)));
  const { data: existing, error: readError } = await admin
    .from(RELEASES_TABLE)
    .select("id,held_run_id,employee_hr_id_compact")
    .eq("paying_run_id", input.runId);
  if (readError) throw readError;
  const stale = ((existing ?? []) as Row[])
    .filter((row) => !keep.has(releaseKey(String(row.held_run_id ?? ""), String(row.employee_hr_id_compact ?? ""))))
    .map((row) => String(row.id));
  if (stale.length > 0) {
    const { error: deleteError } = await admin.from(RELEASES_TABLE).delete().in("id", stale);
    if (deleteError) throw deleteError;
  }

  if (planned.length > 0 || stale.length > 0) {
    await writeAutomatedPayrollAudit({
      runId: input.runId,
      actorHrId: input.actorHrId,
      action: "held_release_recorded",
      detail: { stage: input.stage, released: planned, withdrawn: stale.length },
    });
  }
  return planned;
}
