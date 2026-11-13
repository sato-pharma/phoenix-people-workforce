import type { AccessContext } from "@/lib/auth/permissions";
import { assertRealSessionForDecision } from "@/lib/auth/preview-session-guard";
import { expenseApprovalState } from "@/lib/outstation/approval-state";
import { payableExpenseAmount } from "@/lib/outstation/payable";
import { compactHrKey } from "@/lib/payroll/copilot/feeders.ts";
import { roundCurrency } from "@/lib/payroll/money";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { findDuplicateExpenseHolds } from "./duplicate-expense-hold.ts";
import { actorId, assertAutomatedPayrollHrActor } from "./permissions.ts";
import { parsePublishedHoldDetail } from "./published-holds.ts";
import type { PayoutExpenseTrip } from "./recommend.ts";
import { monthNameAndYear } from "./step-definitions.ts";
import type { PayrollPeriod } from "./types.ts";

/**
 * OUTSTATION TRIPS APPROVED AFTER THEIR PAYOUT MONTH WAS PAID (REC-029 / F-PAY-012).
 *
 * The Expenses step reads trips by the trip's OWN `payout_month/payout_year` (recommend.ts,
 * loadPayoutExpenseTrips). A trip approved after that month's run was published is never read again:
 * no later run looks at an earlier payout month, so it pays nobody and nothing says so.
 *
 * Owner's decision, chosen answer: "Switch, starts OFF". One switch on the payroll screen
 * (`automated_payroll_settings.carry_late_expenses`):
 *   - OFF (the default): such trips are only LISTED on the Expenses step, "Approved, not yet in a run".
 *   - ON: they are added to the next open run's Expenses step for anyone in that run, labelled as
 *     carried from their payout month, and count in the proposed figure.
 *
 * HOW A CARRIED TRIP IS PAID EXACTLY ONCE.
 *   1. Part 2 confirm records the carried trips in its required stamp (`lateExpensesCarried`), but only
 *      for an employee whose confirmed Expenses figure covers them (planLateExpenseCoverage). A trip
 *      whose money is not in the confirmed figure is never recorded as paid; it stays on the list.
 *   2. Publish keeps only the entries of people actually published (not held) with expenses above zero,
 *      refuses if another published run already carried any of them, and writes the list into the
 *      `published` record atomically with the phase (markRunPublished).
 *   3. After publish the carried rows are stamped like the month's own trips (expense-stamp.ts).
 *   4. The list leaves out any trip in ANY published run's carried list, stamped or not.
 *
 * THE FLOOR IS PAYOUT PERIOD SEPTEMBER 2026, and nothing older is ever listed or carried. Measured on
 * production read-only on 2026-11-13: the July 2026 and August 2026 publishes stamped NO trips, and 82
 * approved trips with those payout months are unstamped although they were paid by hand — carrying
 * them would pay twice. September 2026 is the first run whose publish stamped its trips (44 stamped).
 *
 * HELD PEOPLE ARE LEFT OUT. The only 5 approved-unstamped September trips on that day all belonged to
 * one employee who was HELD in the September run; his money is paid through the Held Salary Release
 * step. So a trip of anyone held in its payout period's run is never listed or carried: the held list
 * is that run's own `published` record (parsePublishedHoldDetail).
 *
 * Every read here FAILS CLOSED: a failed read throws a "Conflict:" error whose words reach the screen,
 * never an empty list that reads as "nothing is owed".
 */

export const LATE_EXPENSE_CARRY_FLOOR: Readonly<PayrollPeriod> = Object.freeze({ month: 9, year: 2026 });

/** Where the Part 2 stamp and the `published` record keep the carried trips. */
export const LATE_EXPENSES_CARRIED_KEY = "lateExpensesCarried";
export const LATE_EXPENSES_NOT_COVERED_KEY = "lateExpensesNotCovered";

const SETTINGS_TABLE = "automated_payroll_settings";
const PAGE_SIZE = 1000;

/** The only thing this file asks of a database client. A test hands in a fake. */
export type LateExpenseDb = Pick<ReturnType<typeof getSupabaseAdmin>, "from">;

export type LateExpenseRow = {
  id: string;
  hr_id: string | null;
  payout_month: number | null;
  payout_year: number | null;
  trip_id: string | null;
  expense_date: string | null;
  to_date: string | null;
  from_location: string | null;
  to_location: string | null;
  location: string | null;
  trip_type: string | null;
  transportation_type: string | null;
  km: number | null;
  travel_cost: number | null;
  meeting_amount: number | null;
  allowance: number | null;
  other_amount: number | null;
  total: number | null;
  approved_amount: number | null;
  hr_approved: boolean | null;
  hr_status: string | null;
  status: string | null;
  description: string | null;
  specialist?: string | null;
  imported_payroll_batch_id: string | null;
  imported_to_payroll_at: string | null;
};

const LATE_EXPENSE_COLUMNS =
  "id,hr_id,payout_month,payout_year,trip_id,expense_date,to_date,from_location,to_location,location,trip_type," +
  "transportation_type,km,travel_cost,meeting_amount,allowance,other_amount,total,approved_amount,hr_approved," +
  "hr_status,status,description,specialist,imported_payroll_batch_id,imported_to_payroll_at";

/** A published run, as the plan needs it. */
export type PublishedRunForLateExpenses = {
  runId: string;
  month: number;
  year: number;
  /** Compact HR keys of everyone that run held (its `published` record). */
  heldCompacts: ReadonlyArray<string>;
  /** Outstation row ids that run carried from an earlier payout month. */
  carriedTripIds: ReadonlyArray<string>;
};

/** One approved trip whose payout month was published without it. */
export type LateApprovedExpense = {
  id: string;
  hrId: string;
  compact: string;
  /** The employee's name; filled by the loader (the plan has no directory). */
  name: string;
  payoutMonth: number;
  payoutYear: number;
  payoutLabel: string;
  /** The published run of the payout month that did not pay it. */
  publishedRunId: string;
  amount: number;
  expenseDate: string;
  toDate: string;
  fromLocation: string;
  toLocation: string;
  row: LateExpenseRow;
};

/** What Part 2 confirm and publish record for one carried trip. */
export type LateExpenseCarriedEntry = {
  id: string;
  compact: string;
  payoutMonth: number;
  payoutYear: number;
  amount: number;
};

export type LateExpenseNotCoveredEntry = LateExpenseCarriedEntry & {
  /** The employee's confirmed Expenses figure. */
  paid: number;
  /** What it had to reach to cover their own month's approved trips and the carried ones. */
  needed: number;
  reason: "not_covered" | "duplicate_held";
};

function periodIndex(period: { month: number; year: number }): number {
  return period.year * 12 + (period.month - 1);
}

function text(value: string | null | undefined): string {
  return (value ?? "").toString().trim();
}

function conflict(what: string, error?: { message?: string } | null): Error {
  return new Error(
    `Conflict: ${what}, so the approved expenses not yet in a run cannot be shown. Nothing was changed; ` +
      `try again in a moment.${error?.message ? ` (${error.message})` : ""}`,
  );
}

// ---- The switch -------------------------------------------------------------------------------

/**
 * The switch. A failed read THROWS: reading it as OFF would silently drop carried trips from a run
 * that HR saw them in, and reading it as ON would carry money nobody chose to. A missing row is OFF.
 */
export async function getCarryLateExpensesSetting(client?: LateExpenseDb): Promise<boolean> {
  const { data, error } = await (client ?? getSupabaseAdmin())
    .from(SETTINGS_TABLE)
    .select("carry_late_expenses")
    .eq("id", 1)
    .maybeSingle();
  if (error) {
    throw new Error(
      "Conflict: the payroll switch for expenses approved after their month was paid could not be read. " +
        `Nothing was changed; try again in a moment. (${error.message})`,
    );
  }
  return (data as { carry_late_expenses?: boolean } | null)?.carry_late_expenses === true;
}

/**
 * Flip the switch. Refused while any run is in Part 2 or ready, so a run's Expenses step, its Part 2
 * confirm and its publish always see the same setting. The change is audited, and the audit row is
 * REQUIRED: if it cannot be written the previous value is put back and the change is refused.
 */
export async function setCarryLateExpenses(
  access: AccessContext,
  on: boolean,
  client?: LateExpenseDb,
): Promise<{ carryLateExpenses: boolean }> {
  assertRealSessionForDecision(access, "change whether late-approved expenses are added to payroll");
  assertAutomatedPayrollHrActor(access);
  if (typeof on !== "boolean") throw new Error("Validation: say whether the switch is on or off.");
  const db = client ?? getSupabaseAdmin();

  const { data: busyRuns, error: busyError } = await db
    .from("automated_payroll_runs")
    .select("id,month,year,phase")
    .in("phase", ["part2", "ready"]);
  if (busyError) {
    throw new Error(
      "Conflict: could not check whether a payroll run is in Part 2, so the switch was not changed. " +
        `Try again in a moment. (${busyError.message})`,
    );
  }
  const busy = (busyRuns ?? []) as Array<{ month?: number; year?: number; phase?: string }>;
  if (busy.length > 0) {
    const months = busy
      .map((run) => `${monthNameAndYear(Number(run.month), Number(run.year))} (${run.phase === "ready" ? "Part 2 confirmed" : "in Part 2"})`)
      .join(", ");
    throw new Error(
      `Conflict: the switch cannot change while a payroll run is in Part 2 or confirmed — ${months}. ` +
        "Its Expenses step, its Part 2 confirm and its publish must all see the same setting. Publish or " +
        "reopen that run first.",
    );
  }

  const previous = await getCarryLateExpensesSetting(db);
  const actor = actorId(access);
  const write = async (value: boolean) =>
    db
      .from(SETTINGS_TABLE)
      .upsert(
        { id: 1, carry_late_expenses: value, updated_at: new Date().toISOString(), updated_by_hr_id: actor },
        { onConflict: "id" },
      );
  const { error: writeError } = await write(on);
  if (writeError) {
    throw new Error(`Could not save the payroll switch, so nothing was changed. (${writeError.message})`);
  }

  const { error: auditError } = await db.from("automated_payroll_audit").insert({
    run_id: null,
    actor_hr_id: actor,
    action: "carry_late_expenses_set",
    step_key: "p2_expenses",
    detail: { from: previous, to: on },
  });
  if (auditError) {
    // Put the old value back: a change nobody can trace is the state this audit row exists to prevent.
    await write(previous);
    throw new Error(
      `Could not record the change to the payroll switch, so it was not changed. Try again in a moment. ` +
        `(${auditError.message})`,
    );
  }
  return { carryLateExpenses: on };
}

// ---- The plan (pure) --------------------------------------------------------------------------

/**
 * Which trips are approved, unpaid and owed from a payout month that was already published. Pure.
 *
 * A row is listed when ALL hold:
 *   - it is APPROVED (expenseApprovalState) — pending and rejected trips are not owed yet or at all;
 *   - it carries no paid stamp (`imported_payroll_batch_id` and `imported_to_payroll_at` both empty);
 *   - its payout period has a PUBLISHED run, at or after the floor and strictly before `currentPeriod`;
 *   - its employee was not held in that run (held money is paid through Held Salary Release);
 *   - no published run has already carried it.
 */
export function planLateApprovedExpenses(input: {
  currentPeriod: PayrollPeriod;
  publishedRuns: ReadonlyArray<PublishedRunForLateExpenses>;
  rows: ReadonlyArray<LateExpenseRow>;
}): LateApprovedExpense[] {
  const floor = periodIndex(LATE_EXPENSE_CARRY_FLOOR);
  const current = periodIndex(input.currentPeriod);

  const carried = new Set<string>();
  const byPeriod = new Map<number, { runId: string; held: Set<string> }>();
  for (const run of input.publishedRuns) {
    for (const id of run.carriedTripIds) carried.add(String(id));
    const index = periodIndex(run);
    const entry = byPeriod.get(index) ?? { runId: run.runId, held: new Set<string>() };
    for (const compact of run.heldCompacts) entry.held.add(compactHrKey(compact));
    byPeriod.set(index, entry);
  }

  const listed: LateApprovedExpense[] = [];
  for (const row of input.rows) {
    if (expenseApprovalState({ hrApproved: row.hr_approved, status: row.status }) !== "approved") continue;
    if (row.imported_payroll_batch_id || row.imported_to_payroll_at) continue;
    const payoutMonth = Number(row.payout_month);
    const payoutYear = Number(row.payout_year);
    if (!Number.isInteger(payoutMonth) || !Number.isInteger(payoutYear)) continue;
    const index = periodIndex({ month: payoutMonth, year: payoutYear });
    if (index < floor || index >= current) continue;
    const run = byPeriod.get(index);
    if (!run) continue;
    const compact = compactHrKey(row.hr_id ?? "");
    if (!compact || run.held.has(compact)) continue;
    const id = String(row.id ?? "");
    if (!id || carried.has(id)) continue;
    listed.push({
      id,
      hrId: text(row.hr_id),
      compact,
      name: "",
      payoutMonth,
      payoutYear,
      payoutLabel: monthNameAndYear(payoutMonth, payoutYear),
      publishedRunId: run.runId,
      amount: roundCurrency(payableExpenseAmount(row.approved_amount, row.total)),
      expenseDate: text(row.expense_date).slice(0, 10),
      toDate: text(row.to_date).slice(0, 10),
      fromLocation: text(row.from_location),
      toLocation: text(row.to_location) || text(row.location),
      row,
    });
  }
  listed.sort(
    (left, right) =>
      periodIndex({ month: left.payoutMonth, year: left.payoutYear }) -
        periodIndex({ month: right.payoutMonth, year: right.payoutYear }) ||
      left.compact.localeCompare(right.compact) ||
      left.expenseDate.localeCompare(right.expenseDate) ||
      left.id.localeCompare(right.id),
  );
  return listed;
}

/** The carried entries inside one Part 2 stamp or `published` record. Tolerant of an older detail. */
export function parseLateExpensesCarried(detail: unknown): LateExpenseCarriedEntry[] {
  const list = (detail as Record<string, unknown> | null | undefined)?.[LATE_EXPENSES_CARRIED_KEY];
  if (!Array.isArray(list)) return [];
  return (list as Array<Record<string, unknown>>)
    .map((entry) => ({
      id: String(entry?.id ?? "").trim(),
      compact: compactHrKey(String(entry?.compact ?? "")),
      payoutMonth: Number(entry?.payoutMonth ?? 0),
      payoutYear: Number(entry?.payoutYear ?? 0),
      amount: roundCurrency(Number(entry?.amount ?? 0) || 0),
    }))
    .filter((entry) => entry.id && entry.compact);
}

/**
 * Which carried trips Part 2 confirm records as paid. Pure.
 *
 * Conservative on purpose: an employee's carried trips are recorded ONLY when their confirmed Expenses
 * figure is at least their own month's approved payable total plus the carried total (less 0.50 for
 * rounding). Anything else — HR typed a lower figure, the step was confirmed before the trip was
 * approved — leaves those trips OUT of the record, so they stay on the list and are never marked paid
 * with money that did not go with them. A carried trip held as a duplicate is never recorded either.
 */
export function planLateExpenseCoverage(input: {
  tripsByCompact: ReadonlyMap<string, ReadonlyArray<PayoutExpenseTrip>>;
  expensesByCompact: ReadonlyMap<string, number | null | undefined>;
}): { carried: LateExpenseCarriedEntry[]; notCovered: LateExpenseNotCoveredEntry[] } {
  const carried: LateExpenseCarriedEntry[] = [];
  const notCovered: LateExpenseNotCoveredEntry[] = [];
  for (const [compact, trips] of input.tripsByCompact) {
    if (!trips.some((trip) => trip.carriedFrom)) continue;
    const holds = findDuplicateExpenseHolds([...trips]);
    let own = 0;
    let carriedTotal = 0;
    const counted: LateExpenseCarriedEntry[] = [];
    const held: LateExpenseCarriedEntry[] = [];
    for (const trip of trips) {
      const payable = roundCurrency(payableExpenseAmount(trip.approvedAmount, trip.total));
      if (!trip.carriedFrom) {
        if (!holds.has(trip.tripId) && trip.hrApproved) own = roundCurrency(own + payable);
        continue;
      }
      const entry: LateExpenseCarriedEntry = {
        id: trip.carriedFrom.rowId,
        compact,
        payoutMonth: trip.carriedFrom.month,
        payoutYear: trip.carriedFrom.year,
        amount: payable,
      };
      if (holds.has(trip.tripId)) {
        held.push(entry);
        continue;
      }
      carriedTotal = roundCurrency(carriedTotal + payable);
      counted.push(entry);
    }
    const paid = roundCurrency(Number(input.expensesByCompact.get(compact) ?? 0) || 0);
    const needed = roundCurrency(own + carriedTotal);
    if (counted.length > 0 && paid >= needed - 0.5) carried.push(...counted);
    else for (const entry of counted) notCovered.push({ ...entry, paid, needed, reason: "not_covered" });
    for (const entry of held) notCovered.push({ ...entry, paid, needed, reason: "duplicate_held" });
  }
  return { carried, notCovered };
}

/**
 * What publish keeps of the carried trips its Part 2 stamp recorded: only the people actually
 * published (not held) with expenses above zero. A held person was not paid, so their carried trip is
 * not either. Pure.
 */
export function lateExpensesPaidAtPublish(
  carried: ReadonlyArray<LateExpenseCarriedEntry>,
  entries: ReadonlyArray<{ compact: string; onHold: boolean; row: { expenses: number } }>,
): LateExpenseCarriedEntry[] {
  const paid = new Set(
    entries
      .filter((entry) => !entry.onHold && (Number(entry.row.expenses) || 0) > 0)
      .map((entry) => compactHrKey(entry.compact)),
  );
  return carried.filter((entry) => paid.has(compactHrKey(entry.compact)));
}

/** The ids another published run already carried. Two runs must never pay the same late trip. Pure. */
export function lateExpensesAlreadyCarried(
  ids: ReadonlyArray<string>,
  otherRuns: ReadonlyArray<{ runId: string; month: number; year: number; carriedTripIds: ReadonlyArray<string> }>,
): Array<{ id: string; month: number; year: number }> {
  const wanted = new Set(ids);
  const clashes: Array<{ id: string; month: number; year: number }> = [];
  for (const run of otherRuns) {
    for (const id of run.carriedTripIds) {
      if (wanted.has(id)) clashes.push({ id, month: run.month, year: run.year });
    }
  }
  return clashes;
}

// ---- The reads --------------------------------------------------------------------------------

type PageResult = { data: unknown; error: { message?: string } | null };

async function readAllPages<T>(page: (from: number, to: number) => PromiseLike<PageResult>, what: string): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let result: PageResult;
    try {
      result = await page(from, from + PAGE_SIZE - 1);
    } catch (error) {
      throw conflict(`${what} could not be read`, error instanceof Error ? error : null);
    }
    if (result.error) throw conflict(`${what} could not be read`, result.error);
    const batch = (result.data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return rows;
}

/**
 * Every published run at or after the floor, with who it held and what it carried, from each run's
 * newest `published` record. A published run with no record, or whose record has no held list, THROWS:
 * without it nobody can say who was held, and listing a held person's trip would pay them twice.
 */
export async function loadPublishedRunsForLateExpenses(client?: LateExpenseDb): Promise<PublishedRunForLateExpenses[]> {
  const db = client ?? getSupabaseAdmin();
  const runs = await readAllPages<{ id: string; month: number; year: number }>(
    (from, to) => db.from("automated_payroll_runs").select("id,month,year").eq("phase", "published").order("id", { ascending: true }).range(from, to),
    "the published payroll runs",
  );
  const floor = periodIndex(LATE_EXPENSE_CARRY_FLOOR);
  const recent = runs
    .map((run) => ({ runId: String(run.id ?? ""), month: Number(run.month), year: Number(run.year) }))
    .filter((run) => run.runId && periodIndex(run) >= floor);
  if (recent.length === 0) return [];

  const audit = await readAllPages<{ run_id: string; detail: unknown; created_at: string }>(
    (from, to) =>
      db
        .from("automated_payroll_audit")
        .select("run_id,detail,created_at")
        .eq("action", "published")
        .in("run_id", recent.map((run) => run.runId))
        .order("created_at", { ascending: false })
        .range(from, to),
    "the published payroll records",
  );
  const newest = new Map<string, { detail: unknown; createdAt: string }>();
  for (const row of audit) {
    const runId = String(row.run_id ?? "");
    const createdAt = String(row.created_at ?? "");
    const seen = newest.get(runId);
    if (!seen || createdAt > seen.createdAt) newest.set(runId, { detail: row.detail, createdAt });
  }

  return recent.map((run) => {
    const record = newest.get(run.runId);
    const label = monthNameAndYear(run.month, run.year);
    if (!record) throw conflict(`the ${label} payroll run is published but its record of who was held is missing`);
    const held = parsePublishedHoldDetail(record.detail).held;
    if (!held) throw conflict(`the ${label} payroll run's record does not say who was held`);
    return {
      ...run,
      heldCompacts: held.map((person) => person.compact),
      carriedTripIds: parseLateExpensesCarried(record.detail).map((entry) => entry.id),
    };
  });
}

/**
 * The approved trips owed from a payout month that was already published, for a run of
 * `currentPeriod`, with each employee's name. Any failed read throws — never an empty list.
 */
export async function loadLateApprovedExpenses(
  currentPeriod: PayrollPeriod,
  client?: LateExpenseDb,
): Promise<LateApprovedExpense[]> {
  const db = client ?? getSupabaseAdmin();
  const publishedRuns = await loadPublishedRunsForLateExpenses(db);
  const current = periodIndex(currentPeriod);
  const periods = publishedRuns.filter((run) => periodIndex(run) < current);
  if (periods.length === 0) return [];

  const rows: LateExpenseRow[] = [];
  const seenPeriods = new Set<number>();
  for (const period of periods) {
    if (seenPeriods.has(periodIndex(period))) continue;
    seenPeriods.add(periodIndex(period));
    rows.push(
      ...(await readAllPages<LateExpenseRow>(
        (from, to) =>
          db
            .from("outstation_expenses")
            .select(LATE_EXPENSE_COLUMNS)
            .eq("payout_month", period.month)
            .eq("payout_year", period.year)
            .is("imported_payroll_batch_id", null)
            .order("id", { ascending: true })
            .range(from, to),
        `the outstation expenses for ${monthNameAndYear(period.month, period.year)}`,
      )),
    );
  }

  const listed = planLateApprovedExpenses({ currentPeriod, publishedRuns, rows });
  if (listed.length === 0) return listed;

  const employees = await readAllPages<{ hr_id: string | null; full_name: string | null }>(
    (from, to) => db.from("employees").select("hr_id,full_name").order("hr_id", { ascending: true }).range(from, to),
    "the employee names",
  );
  const names = new Map(employees.map((row) => [compactHrKey(row.hr_id ?? ""), text(row.full_name)]));
  // The claimant's own name on the trip is the fallback, and the code only after that.
  return listed.map((trip) => ({
    ...trip,
    name: names.get(trip.compact) || text(trip.row.specialist) || trip.hrId,
  }));
}

/** What another published run carried, for the publish guard. Throws on a failed read. */
export async function loadOtherRunsCarriedTrips(
  runId: string,
  client?: LateExpenseDb,
): Promise<Array<{ runId: string; month: number; year: number; carriedTripIds: string[] }>> {
  const runs = await loadPublishedRunsForLateExpenses(client);
  return runs
    .filter((run) => run.runId !== runId)
    .map((run) => ({ runId: run.runId, month: run.month, year: run.year, carriedTripIds: [...run.carriedTripIds] }));
}

/**
 * Refuses a publish that would pay a late trip another published run already carried. Called under the
 * publish claim, before anything is written.
 */
export async function assertLateExpensesNotCarriedElsewhere(
  runId: string,
  carried: ReadonlyArray<LateExpenseCarriedEntry>,
  client?: LateExpenseDb,
): Promise<void> {
  if (carried.length === 0) return;
  const clashes = lateExpensesAlreadyCarried(
    carried.map((entry) => entry.id),
    await loadOtherRunsCarriedTrips(runId, client),
  );
  if (clashes.length === 0) return;
  const months = [...new Set(clashes.map((clash) => monthNameAndYear(clash.month, clash.year)))].join(", ");
  throw new Error(
    `Conflict: ${clashes.length} late-approved outstation trip${clashes.length === 1 ? "" : "s"} this run would pay ` +
      `${clashes.length === 1 ? "was" : "were"} already paid by the ${months} run. Nothing was published. Reopen ` +
      "Part 2, take the trip out of the Expenses figure, and confirm again.",
  );
}

/** The panel on the Expenses step: the switch and the list. */
export type LateExpensesOverview = {
  setting: { carryLateExpenses: boolean };
  trips: Array<Omit<LateApprovedExpense, "row">>;
};

export async function getLateExpensesOverview(
  access: AccessContext,
  period: PayrollPeriod,
): Promise<LateExpensesOverview> {
  assertAutomatedPayrollHrActor(access);
  const [carryLateExpenses, trips] = await Promise.all([
    getCarryLateExpensesSetting(),
    loadLateApprovedExpenses(period),
  ]);
  return {
    setting: { carryLateExpenses },
    trips: trips.map((trip) => ({
      id: trip.id,
      hrId: trip.hrId,
      compact: trip.compact,
      name: trip.name,
      payoutMonth: trip.payoutMonth,
      payoutYear: trip.payoutYear,
      payoutLabel: trip.payoutLabel,
      publishedRunId: trip.publishedRunId,
      amount: trip.amount,
      expenseDate: trip.expenseDate,
      toDate: trip.toDate,
      fromLocation: trip.fromLocation,
      toLocation: trip.toLocation,
    })),
  };
}
