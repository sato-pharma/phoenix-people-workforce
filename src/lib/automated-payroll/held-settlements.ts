import { compactHrKey } from "@/lib/payroll/copilot/feeders.ts";
import { hrIdForStorage } from "@/lib/hr-id";
import { roundCurrency } from "@/lib/payroll/money";
import type { AccessContext } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { writeAutomatedPayrollAudit } from "./audit.ts";
import { actorId, assertAutomatedPayrollHrActor } from "./permissions.ts";
import { monthNameAndYear } from "./step-definitions.ts";

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
/**
 * HR's record that an EARLIER published month's Part 1 was never paid (owner, 2026-10-26: "they will
 * hold it in the previous salary, first and second"). The Part 1 bank files leave a held person out,
 * but the runs published before `part1_withheld` existed recorded every held person's Part 1 as paid,
 * and recorded nothing at all for someone held at Part 1 and released by Part 2. One row per (held
 * run, person); it adds to what is still held, never above that person's frozen Part 1 on that run.
 */
const PART1_UNPAID_TABLE = "automated_payroll_held_part1_unpaid";

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
  /**
   * The first instalment this month did NOT pay: frozen at Part 1 confirm (the person was on hold, so
   * the Part 1 bank files left them out), or entered by HR as "Part 1 Not Paid" for a month published
   * before that was recorded — the larger of the two, since both describe the same unpaid money.
   */
  firstPartWithheld: number;
  /** What HR entered as "Part 1 Not Paid" against this month (0 when nothing was entered). */
  part1Correction: number;
  /** Taken off this month's Part 2 by Defer Pay and owed again later. */
  deferred: number;
  /** When the deferred amount falls due, "YYYY-MM"; null when nothing was deferred. */
  deferredTo: string | null;
  settled: HeldSettlement | null;
  /**
   * Released against this held month by OTHER payroll runs that are not cancelled — published ones
   * (paid) and ones whose Part 2 is confirmed but not yet published (the bank file can already pay
   * it, so it is reserved). The run asking is never counted against itself.
   */
  releasedByPayroll: number;
  /**
   * Part 2 withheld + Part 1 withheld + deferred, minus settled by hand minus released by payroll,
   * floored at zero. The figure that must not be paid twice.
   */
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
  /** Absent on a run published before Part 1 holds were frozen — read as 0 (the old "already paid"). */
  firstPartWithheld?: unknown;
  secondPartWithheld?: unknown;
};

/** Someone paid this month's Part 2 whose Part 1 was withheld (held at Part 1, released by Part 2). */
type PublishedPart1UnpaidEntry = { hrId?: unknown; name?: unknown; amount?: unknown };

/** Pay taken off this month's Part 2 by Defer Pay, and when it falls due. */
type PublishedDeferredEntry = { hrId?: unknown; name?: unknown; amount?: unknown; releaseIn?: unknown };

/** One "Part 1 Not Paid" row HR entered against an earlier published run. */
export type Part1Correction = { heldRunId: string; hrId: string; compact: string; name: string; amount: number };

/** The `published` audit row's money lists that make up what is still held. */
export type PublishedHoldDetail = { held?: unknown; part1Unpaid?: unknown; deferred?: unknown };

/**
 * One published run's held balances: every person the run withheld any money from — Part 2 on hold,
 * Part 1 withheld, pay deferred, or a Part 1 HR recorded as not paid — merged into ONE balance per
 * person, so a person is never listed twice for one month and no figure is counted twice.
 *
 * Pure, so the rule that decides what is owed is unit-tested directly; loadHeldBalances does the reads.
 */
export function heldBalancesForRun(input: {
  runId: string;
  month: number;
  year: number;
  detail: PublishedHoldDetail;
  settlements: Map<string, HeldSettlement>;
  /** Payroll releases, keyed by held run and compact HR id (payrollReleasedByHeldMonth). */
  releasedByPayroll: Map<string, number>;
  corrections: readonly Part1Correction[];
  /**
   * Held amounts HR typed for a month published before the payroll kept each held person (July and
   * August 2026). Counted ONLY when this run's `published` row has no held list; see below.
   */
  entered?: readonly EnteredHeld[];
}): HeldBalance[] {
  type Acc = {
    hrId: string;
    name: string;
    reason: string | null;
    firstPartAlreadyPaid: number;
    recordedFirstWithheld: number;
    secondPartWithheld: number;
    correction: number;
    deferred: number;
    deferredTo: string | null;
  };
  const byCompact = new Map<string, Acc>();
  const accFor = (hrIdValue: unknown, nameValue: unknown): Acc | null => {
    const hrId = String(hrIdValue ?? "");
    const compact = compactHrKey(hrId);
    if (!compact) return null;
    let acc = byCompact.get(compact);
    if (!acc) {
      acc = {
        hrId,
        name: String(nameValue ?? ""),
        reason: null,
        firstPartAlreadyPaid: 0,
        recordedFirstWithheld: 0,
        secondPartWithheld: 0,
        correction: 0,
        deferred: 0,
        deferredTo: null,
      };
      byCompact.set(compact, acc);
    }
    if (!acc.name && nameValue) acc.name = String(nameValue);
    return acc;
  };
  const list = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

  for (const entry of list<PublishedHeldEntry>(input.detail.held)) {
    const acc = accFor(entry.hrId, entry.name);
    if (!acc) continue;
    acc.reason = entry.reason == null ? null : String(entry.reason);
    acc.firstPartAlreadyPaid = roundCurrency(acc.firstPartAlreadyPaid + num(entry.firstPartAlreadyPaid));
    acc.recordedFirstWithheld = roundCurrency(acc.recordedFirstWithheld + num(entry.firstPartWithheld));
    acc.secondPartWithheld = roundCurrency(acc.secondPartWithheld + num(entry.secondPartWithheld));
  }
  // A run that kept only the COUNT of who it held (July and August 2026 were published before the held
  // list existed) names nobody, so what HR typed on the Held Salary Release step stands in for it. A run
  // that HAS a held list recorded each person itself, and an entry against it is ignored — so a typed
  // figure can never double one the system recorded.
  if (!Array.isArray(input.detail.held)) {
    for (const entry of input.entered ?? []) {
      if (entry.heldRunId !== input.runId) continue;
      const acc = accFor(entry.hrId, entry.name);
      if (!acc) continue;
      acc.secondPartWithheld = roundCurrency(acc.secondPartWithheld + num(entry.amount));
      if (!acc.reason && entry.note) acc.reason = entry.note;
    }
  }
  for (const entry of list<PublishedPart1UnpaidEntry>(input.detail.part1Unpaid)) {
    const acc = accFor(entry.hrId, entry.name);
    if (acc) acc.recordedFirstWithheld = roundCurrency(acc.recordedFirstWithheld + num(entry.amount));
  }
  for (const entry of list<PublishedDeferredEntry>(input.detail.deferred)) {
    const acc = accFor(entry.hrId, entry.name);
    if (!acc) continue;
    acc.deferred = roundCurrency(acc.deferred + num(entry.amount));
    const releaseIn = String(entry.releaseIn ?? "");
    // Part 1 and Part 2 can each defer to a different month; the later one stands, so nothing is paid early.
    if (/^\d{4}-\d{2}$/.test(releaseIn) && (!acc.deferredTo || releaseIn > acc.deferredTo)) acc.deferredTo = releaseIn;
  }
  for (const correction of input.corrections) {
    if (correction.heldRunId !== input.runId) continue;
    const acc = accFor(correction.hrId, correction.name);
    if (acc) acc.correction = roundCurrency(acc.correction + correction.amount);
  }

  const balances: HeldBalance[] = [];
  for (const [compact, acc] of byCompact) {
    // Two reports of the same unpaid Part 1 — what the run froze and what HR entered — so the larger
    // stands, never the sum. What HR adds beyond the frozen figure comes off "already paid".
    const firstPartWithheld = roundCurrency(Math.max(acc.recordedFirstWithheld, acc.correction));
    const firstPartAlreadyPaid = Math.max(
      0,
      roundCurrency(acc.firstPartAlreadyPaid - (firstPartWithheld - acc.recordedFirstWithheld)),
    );
    const settled = input.settlements.get(compact) ?? null;
    const released = input.releasedByPayroll.get(releaseKey(input.runId, compact)) ?? 0;
    const withheld = roundCurrency(acc.secondPartWithheld + firstPartWithheld + acc.deferred);
    balances.push({
      runId: input.runId,
      month: input.month,
      year: input.year,
      hrId: acc.hrId,
      compact,
      name: acc.name,
      reason: acc.reason,
      firstPartAlreadyPaid,
      secondPartWithheld: acc.secondPartWithheld,
      firstPartWithheld,
      part1Correction: acc.correction,
      deferred: acc.deferred,
      deferredTo: acc.deferred > 0 ? acc.deferredTo : null,
      settled,
      releasedByPayroll: released,
      outstanding: Math.max(0, roundCurrency(withheld - (settled?.amount ?? 0) - released)),
    });
  }
  return balances;
}

/**
 * How much of a person's outstanding balance is deferred pay that is not due yet in `period`. Pure.
 * Capped at each month's outstanding, so a balance already part-paid never reads as more not-due than
 * is owed.
 */
export function notYetDue(balances: readonly HeldBalance[], period: { month: number; year: number }): number {
  const now = monthKeyAfter(period.month, period.year, 0);
  return roundCurrency(
    balances.reduce((sum, balance) => {
      if (!(balance.deferred > 0) || !balance.deferredTo || balance.deferredTo <= now) return sum;
      return sum + Math.min(balance.deferred, balance.outstanding);
    }, 0),
  );
}

/** "YYYY-MM" of the month `offset` months after (month, year). */
export function monthKeyAfter(month: number, year: number, offset: number): string {
  const index = year * 12 + (month - 1) + offset;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

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
  const published = await newestPublishedDetailByRun();
  if (!published || published.size === 0) return [];
  const runIds = [...published.keys()];
  const runsById = await runPeriodsById(runIds);

  const settlementsByRun = new Map<string, Map<string, HeldSettlement>>();
  for (const runId of runIds) settlementsByRun.set(runId, await getHeldSettlements(runId));
  const releasedByPayroll = payrollReleasedByHeldMonth(await loadPayrollReleases(), options?.excludeRunId);
  const corrections = await loadPart1Corrections();
  const entered = await loadEnteredHeld();

  const balances: HeldBalance[] = [];
  for (const [runId, detail] of published) {
    if (runId === options?.excludeRunId) continue;
    const period = runsById.get(runId);
    if (!period) continue;
    balances.push(
      ...heldBalancesForRun({
        runId,
        month: period.month,
        year: period.year,
        detail,
        settlements: settlementsByRun.get(runId) ?? new Map<string, HeldSettlement>(),
        releasedByPayroll,
        corrections,
        entered,
      }),
    );
  }
  return balances;
}

/**
 * Each published run's NEWEST `published` audit detail, keyed by run id. Null when the audit table is
 * missing in this environment. A run can legitimately have more than one `published` audit row (an
 * interrupted publish that was retried); read newest first, so the first one seen is the one that stands.
 */
async function newestPublishedDetailByRun(): Promise<Map<string, PublishedHoldDetail> | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("automated_payroll_audit")
    .select("run_id,detail,created_at")
    .eq("action", "published")
    .order("created_at", { ascending: false });
  if (error) {
    if (isMissingTableError(error)) return null;
    throw error;
  }
  const byRun = new Map<string, PublishedHoldDetail>();
  for (const row of (data ?? []) as Row[]) {
    const runId = String(row.run_id ?? "");
    if (!runId || byRun.has(runId)) continue;
    byRun.set(runId, (row.detail ?? {}) as PublishedHoldDetail);
  }
  return byRun;
}

/**
 * Month and year of each run. Chunked: a PostgREST `.in()` carrying several hundred ids returns zero
 * rows and no error. Run counts are small today, and this is the shape that stays correct when they are not.
 */
async function runPeriodsById(runIds: readonly string[]): Promise<Map<string, { month: number; year: number }>> {
  const runsById = new Map<string, { month: number; year: number }>();
  const ids = runIds.filter(Boolean);
  for (let index = 0; index < ids.length; index += 50) {
    const { data, error } = await getSupabaseAdmin()
      .from("automated_payroll_runs")
      .select("id,month,year")
      .in("id", ids.slice(index, index + 50));
    if (error) throw error;
    for (const row of (data ?? []) as Row[]) {
      runsById.set(String(row.id), { month: Number(row.month ?? 0), year: Number(row.year ?? 0) });
    }
  }
  return runsById;
}

/**
 * Every "Part 1 Not Paid" row. A read failure THROWS, missing table included, for the same reason as
 * the payroll releases: a silent empty read would show a saved figure as gone and the money as not
 * owed.
 */
async function loadPart1Corrections(): Promise<Part1Correction[]> {
  const { data, error } = await getSupabaseAdmin()
    .from(PART1_UNPAID_TABLE)
    .select("held_run_id,employee_hr_id,employee_hr_id_compact,employee_name,amount");
  if (error) throw error;
  return ((data ?? []) as Row[]).map((row) => ({
    heldRunId: String(row.held_run_id ?? ""),
    hrId: String(row.employee_hr_id ?? ""),
    compact: String(row.employee_hr_id_compact ?? ""),
    name: String(row.employee_name ?? ""),
    amount: num(row.amount),
  }));
}

/** The latest PUBLISHED run before (month, year) — the month a "Part 1 Not Paid" entry is recorded against. */
export async function previousPublishedRun(period: {
  month: number;
  year: number;
}): Promise<{ id: string; month: number; year: number } | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("automated_payroll_runs")
    .select("id,month,year")
    .eq("phase", "published")
    .order("year", { ascending: false })
    .order("month", { ascending: false });
  if (error) throw error;
  const target = period.year * 12 + period.month;
  for (const row of (data ?? []) as Row[]) {
    const month = Number(row.month ?? 0);
    const year = Number(row.year ?? 0);
    if (year * 12 + month < target) return { id: String(row.id), month, year };
  }
  return null;
}

/** The Part 1 one run confirmed per person (first_part_frozen above 0), by compact HR id. */
export async function frozenPart1ForRun(runId: string): Promise<Map<string, number>> {
  const { data, error } = await getSupabaseAdmin()
    .from("automated_payroll_draft_rows")
    .select("employee_hr_id_compact,first_part_frozen")
    .eq("run_id", runId)
    .gt("first_part_frozen", 0);
  if (error) throw error;
  return new Map(
    ((data ?? []) as Row[]).map((row) => [String(row.employee_hr_id_compact ?? ""), roundCurrency(num(row.first_part_frozen))]),
  );
}

/** What HR has entered as "Part 1 Not Paid" against one run, by compact HR id. */
export async function part1CorrectionsForRun(heldRunId: string): Promise<Map<string, number>> {
  const byCompact = new Map<string, number>();
  for (const correction of await loadPart1Corrections()) {
    if (correction.heldRunId !== heldRunId || !correction.compact) continue;
    byCompact.set(correction.compact, roundCurrency((byCompact.get(correction.compact) ?? 0) + correction.amount));
  }
  return byCompact;
}

/**
 * Record what HR says an earlier published run's Part 1 did NOT pay, from the Held Salary Release step.
 *
 * Never above the person's frozen Part 1 on that run — the most that run could have paid them at all.
 * Zero withdraws the entry. Audited, because it changes what the company owes.
 */
export async function recordPart1Corrections(input: {
  heldRunId: string;
  recordedInRunId: string;
  actorHrId: string;
  entries: readonly { hrId: string; name: string; amount: number }[];
}): Promise<void> {
  if (input.entries.length === 0) return;
  const admin = getSupabaseAdmin();
  const compacts = input.entries.map((entry) => compactHrKey(entry.hrId)).filter(Boolean);
  const { data: drafts, error: draftError } = await admin
    .from("automated_payroll_draft_rows")
    .select("employee_hr_id_compact,first_part_frozen")
    .eq("run_id", input.heldRunId)
    .in("employee_hr_id_compact", compacts);
  if (draftError) throw draftError;
  const frozenByCompact = new Map(
    ((drafts ?? []) as Row[]).map((row) => [String(row.employee_hr_id_compact ?? ""), num(row.first_part_frozen)]),
  );
  const problems: string[] = [];
  const upserts: Record<string, unknown>[] = [];
  const withdrawals: string[] = [];
  const now = new Date().toISOString();
  for (const entry of input.entries) {
    const compact = compactHrKey(entry.hrId);
    const amount = roundCurrency(Number(entry.amount));
    if (!compact || !Number.isFinite(amount) || amount < 0) {
      problems.push(`${entry.name || entry.hrId}: not a usable amount`);
      continue;
    }
    if (amount === 0) {
      withdrawals.push(compact);
      continue;
    }
    const frozen = roundCurrency(frozenByCompact.get(compact) ?? 0);
    if (amount > frozen) {
      problems.push(
        frozen === 0
          ? `${entry.name || entry.hrId} was not paid a Part 1 last month, so there is no Part 1 to mark unpaid — remove the row and add them again with For set to the month the pay was held`
          : `${entry.name || entry.hrId}: ${amount.toFixed(2)} is more than the ${frozen.toFixed(2)} Part 1 that month confirmed`,
      );
      continue;
    }
    upserts.push({
      held_run_id: input.heldRunId,
      employee_hr_id: hrIdForStorage(entry.hrId) ?? entry.hrId.trim(),
      employee_hr_id_compact: compact,
      employee_name: entry.name || null,
      amount,
      recorded_in_run_id: input.recordedInRunId,
      recorded_by: input.actorHrId,
      updated_at: now,
    });
  }
  if (problems.length > 0) {
    throw new Error(`Validation: Part 1 Not Paid can never be more than that month's Part 1. ${problems.slice(0, 6).join("; ")}`);
  }
  if (upserts.length > 0) {
    const { error } = await admin
      .from(PART1_UNPAID_TABLE)
      .upsert(upserts, { onConflict: "held_run_id,employee_hr_id_compact" });
    if (error) throw error;
  }
  if (withdrawals.length > 0) {
    const { error } = await admin
      .from(PART1_UNPAID_TABLE)
      .delete()
      .eq("held_run_id", input.heldRunId)
      .in("employee_hr_id_compact", withdrawals);
    if (error) throw error;
  }
  await writeAutomatedPayrollAudit({
    runId: input.recordedInRunId,
    actorHrId: input.actorHrId,
    action: "held_part1_unpaid_recorded",
    detail: {
      heldRunId: input.heldRunId,
      recorded: upserts.map((row) => ({ hrId: row.employee_hr_id, amount: row.amount })),
      withdrawn: withdrawals,
    },
  });
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
  stage: "part1_confirmed" | "part1_reopened" | "part2_confirmed" | "published";
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

// ─── Held amounts HR enters for a month that did not record names ──────────────────────────────────

/**
 * The amount an EARLIER published month withheld from one person, typed by HR on the Held Salary
 * Release step (owner decision, 2026-11-09: HR types the held amount on the step).
 *
 * July and August 2026 were published before the payroll kept each held person's amounts: their
 * `published` audit row carries the COUNT only ({batchId, heldExcluded, publishedCount}), so a person
 * held in either month had no balance, never appeared on the step, and no release could be saved for
 * them. One row per (held run, person). It counts ONLY for a run that kept the count alone
 * (heldBalancesForRun), so it can never double a figure the system recorded.
 */
const ENTERED_TABLE = "automated_payroll_held_entered";
const ENTERED_SELECT =
  "held_run_id,employee_hr_id,employee_hr_id_compact,employee_name,amount,note,recorded_in_run_id,recorded_by,updated_at";

export type EnteredHeld = {
  heldRunId: string;
  hrId: string;
  compact: string;
  name: string;
  amount: number;
  note: string;
  /** The payroll run HR was working in when they entered it — the run whose Held Salary Release pre-fills it. */
  recordedInRunId: string;
  recordedBy: string;
  updatedAt: string;
};

export type EnteredHeldInput = { heldRunId: string; hrId: string; amount: number; note: string };

/** A published month that kept only the count of who it held. */
export type HeldMonthWithoutRoster = { runId: string; month: number; year: number; label: string };

/** Someone the picker offers: every employee record, resigned included (a leaver is who gets held). */
export type HeldEntryEmployee = { hrId: string; compact: string; name: string; status: string | null };

/** One entered amount as the panel lists it: named, with its month and who recorded it. */
export type EnteredHeldListed = EnteredHeld & { month: number; year: number; monthLabel: string; recordedByName: string };

/** The panel's whole read: the months it can enter against, what was entered, and who can be picked. */
export type EnteredHeldOverview = {
  months: HeldMonthWithoutRoster[];
  entries: EnteredHeldListed[];
  employees: HeldEntryEmployee[];
};

function mapEnteredRow(row: Row): EnteredHeld {
  return {
    heldRunId: String(row.held_run_id ?? ""),
    hrId: String(row.employee_hr_id ?? ""),
    compact: String(row.employee_hr_id_compact ?? ""),
    name: String(row.employee_name ?? ""),
    amount: num(row.amount),
    note: String(row.note ?? ""),
    recordedInRunId: String(row.recorded_in_run_id ?? ""),
    recordedBy: String(row.recorded_by ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

/**
 * Every held amount HR has entered. A missing table reads as nothing entered — the same add-only
 * tolerance as the settlements table, and the state every environment was in before it existed. Any
 * other read failure throws.
 */
export async function loadEnteredHeld(): Promise<EnteredHeld[]> {
  const { data, error } = await getSupabaseAdmin().from(ENTERED_TABLE).select(ENTERED_SELECT);
  if (error) {
    if (isMissingTableError(error)) return [];
    throw error;
  }
  return ((data ?? []) as Row[]).map(mapEnteredRow).filter((entry) => entry.heldRunId && entry.compact);
}

/**
 * What HR added while working in this run, by compact HR id — the held amounts they entered here
 * (owner, 2026-11-09: "at least what I add only"). Held Salary Release pre-fills these and nothing else.
 */
export function enteredHeldAddedInRun(entries: readonly EnteredHeld[], runId: string): Map<string, number> {
  const byCompact = new Map<string, number>();
  for (const entry of entries) {
    if (entry.recordedInRunId !== runId || !(entry.amount > 0)) continue;
    byCompact.set(entry.compact, roundCurrency((byCompact.get(entry.compact) ?? 0) + entry.amount));
  }
  return byCompact;
}

/**
 * Published runs EARLIER than the current run's month whose newest `published` audit row has no held
 * list — the months a held amount can be entered against (on production: July and August 2026).
 * Oldest first.
 */
export async function heldMonthsWithoutRoster(currentRunId: string): Promise<HeldMonthWithoutRoster[]> {
  const current = (await runPeriodsById([currentRunId])).get(currentRunId);
  if (!current) throw new Error("Not found: that payroll run.");
  const published = await newestPublishedDetailByRun();
  if (!published) return [];
  const countOnly = [...published.entries()]
    .filter(([runId, detail]) => runId !== currentRunId && !Array.isArray(detail.held))
    .map(([runId]) => runId);
  const periods = await runPeriodsById(countOnly);
  const target = current.year * 12 + current.month;
  return countOnly
    .flatMap((runId) => {
      const period = periods.get(runId);
      if (!period || period.year * 12 + period.month >= target) return [];
      return [{ runId, month: period.month, year: period.year, label: monthNameAndYear(period.month, period.year) }];
    })
    .sort((a, b) => a.year - b.year || a.month - b.month);
}

/** Every employee record, any status, named — for the picker and to check the person exists. */
async function loadHeldEntryEmployees(): Promise<HeldEntryEmployee[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("employees")
    .select("hr_id,full_name,employment_status")
    .order("full_name", { ascending: true });
  if (error) throw error;
  const employees: HeldEntryEmployee[] = [];
  for (const row of (data ?? []) as Row[]) {
    const hrId = String(row.hr_id ?? "").trim();
    const compact = compactHrKey(hrId);
    const name = String(row.full_name ?? "").trim();
    if (!compact || !name) continue;
    employees.push({ hrId, compact, name, status: (row.employment_status as string | null) ?? null });
  }
  return employees;
}

/** What payroll runs that are not cancelled have released against one (held run, person). */
async function releasedAgainst(heldRunId: string, compact: string): Promise<number> {
  return roundCurrency(
    (await loadPayrollReleases())
      .filter((row) => row.heldRunId === heldRunId && row.compact === compact && row.payingRunPhase !== "cancelled")
      .reduce((sum, row) => sum + row.amount, 0),
  );
}

/** The panel's read, behind the same gate as the wizard: it names people and salary figures. */
export async function getEnteredHeldOverview(access: AccessContext, currentRunId: string): Promise<EnteredHeldOverview> {
  assertAutomatedPayrollHrActor(access);
  const [months, entered, employees] = await Promise.all([
    heldMonthsWithoutRoster(currentRunId),
    loadEnteredHeld(),
    loadHeldEntryEmployees(),
  ]);
  const nameByCompact = new Map(employees.map((employee) => [employee.compact, employee.name]));
  const periods = await runPeriodsById([...new Set(entered.map((entry) => entry.heldRunId))]);
  const entries = entered
    .map((entry): EnteredHeldListed => {
      const period = periods.get(entry.heldRunId) ?? { month: 0, year: 0 };
      return {
        ...entry,
        name: nameByCompact.get(entry.compact) ?? entry.name,
        month: period.month,
        year: period.year,
        monthLabel: period.month ? monthNameAndYear(period.month, period.year) : "",
        recordedByName: nameByCompact.get(compactHrKey(entry.recordedBy)) ?? entry.recordedBy,
      };
    })
    .sort((a, b) => a.year - b.year || a.month - b.month || a.name.localeCompare(b.name));
  return { months, entries, employees };
}

/**
 * Record (or correct) the amount an earlier month withheld from one person. Upsert on (held run,
 * person), like the by-hand settlements: a correction updates the one row. Refused for a month that
 * recorded each held person itself, for an amount below what payroll has already released of it, and
 * for anyone with no employee record. Audited, because it creates money the company owes.
 */
export async function recordEnteredHeld(
  access: AccessContext,
  currentRunId: string,
  input: EnteredHeldInput,
): Promise<EnteredHeld> {
  assertAutomatedPayrollHrActor(access);
  const amount = roundCurrency(Number(input.amount));
  if (!Number.isFinite(amount) || !(amount > 0)) {
    throw new Error("Validation: the amount held must be a number above zero.");
  }
  const note = String(input.note ?? "").trim();
  if (!note) throw new Error("Validation: a note is required — say where the held amount comes from.");
  const compact = compactHrKey(input.hrId);
  if (!compact) throw new Error("Validation: choose the employee.");

  const months = await heldMonthsWithoutRoster(currentRunId);
  const month = months.find((candidate) => candidate.runId === input.heldRunId);
  if (!month) {
    throw new Error(
      "Validation: that month recorded each held person itself — use Part 1 Not Paid or the figure it recorded instead.",
    );
  }
  const employee = (await loadHeldEntryEmployees()).find((candidate) => candidate.compact === compact);
  if (!employee) throw new Error("Validation: there is no employee record for that person.");

  const released = await releasedAgainst(month.runId, compact);
  if (amount < released) {
    throw new Error(
      `Validation: payroll has already released ${released.toFixed(2)} of the ${month.label} amount held from ${employee.name}, so it cannot be lowered to ${amount.toFixed(2)}.`,
    );
  }

  const { data, error } = await getSupabaseAdmin()
    .from(ENTERED_TABLE)
    .upsert(
      {
        held_run_id: month.runId,
        // Storage casing for the human-readable column, compact for every join.
        employee_hr_id: hrIdForStorage(employee.hrId) ?? employee.hrId,
        employee_hr_id_compact: compact,
        employee_name: employee.name,
        amount,
        note,
        recorded_in_run_id: currentRunId,
        recorded_by: actorId(access),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "held_run_id,employee_hr_id_compact" },
    )
    .select(ENTERED_SELECT)
    .single();
  if (error) throw error;

  const entry = mapEnteredRow(data as Row);
  await writeAutomatedPayrollAudit({
    runId: currentRunId,
    actorHrId: actorId(access),
    action: "held_entered_recorded",
    detail: {
      heldRunId: month.runId,
      heldMonth: month.label,
      hrId: entry.hrId,
      name: entry.name,
      amount: entry.amount,
      note: entry.note,
    },
  });
  return entry;
}

/**
 * Withdraw an entered held amount typed in error. Refused once a payroll run that is not cancelled has
 * released any of it — removing it then would leave money paid against a debt that no longer exists.
 * Audited, because it changes what the company owes.
 */
export async function deleteEnteredHeld(
  access: AccessContext,
  currentRunId: string,
  heldRunId: string,
  hrId: string,
): Promise<void> {
  assertAutomatedPayrollHrActor(access);
  const compact = compactHrKey(hrId);
  if (!compact || !heldRunId) throw new Error("Validation: choose the entry to remove.");

  const released = await releasedAgainst(heldRunId, compact);
  if (released > 0) {
    throw new Error(
      `Conflict: payroll has already released ${released.toFixed(2)} of this held amount, so it cannot be removed. Take the release off first.`,
    );
  }

  const { error } = await getSupabaseAdmin()
    .from(ENTERED_TABLE)
    .delete()
    .eq("held_run_id", heldRunId)
    .eq("employee_hr_id_compact", compact);
  if (error) throw error;

  await writeAutomatedPayrollAudit({
    runId: currentRunId,
    actorHrId: actorId(access),
    action: "held_entered_withdrawn",
    detail: { heldRunId, hrId, compact },
  });
}
