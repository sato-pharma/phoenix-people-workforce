import type { AccessContext } from "@/lib/auth/permissions";
import { assertRealSessionForDecision } from "@/lib/auth/preview-session-guard";
import { expenseApprovalState } from "@/lib/outstation/approval-state";
import { payableExpenseAmount } from "@/lib/outstation/payable";
import { compactHrKey } from "@/lib/payroll/copilot/feeders.ts";
import { roundCurrency } from "@/lib/payroll/money";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { clearDraftExpenses, listDraftRows, listStepStates, upsertStepState } from "./draft-store.ts";
import { findDuplicateExpenseHolds } from "./duplicate-expense-hold.ts";
import { actorId, assertAutomatedPayrollHrActor } from "./permissions.ts";
import { parsePublishedHoldDetail } from "./published-holds.ts";
import type { PayoutExpenseTrip } from "./recommend.ts";
import { holdRun } from "./run-hold.ts";
import { monthNameAndYear } from "./step-definitions.ts";
import { RUN_HOLD_ACTIONS } from "./transition-claim.ts";
import type { PayrollPeriod, RunPhase } from "./types.ts";

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
 *   1. Confirming the Expenses step records what it showed (`lateExpensesShown` in the step's summary),
 *      from the SAME trip list that built the figure: the switch, each carried trip's row, trip id,
 *      person and amount, and each person's own-month approved trips (row ids and total).
 *   2. Part 2 confirm refuses when the switch moved since, or when any shown trip is no longer approved,
 *      changed amount, moved month or was paid. Coverage is the snapshot's own trips plus the carried
 *      ones — never a live re-read — and a figure that pays the carried trips only in part, or holds
 *      money beyond its trips (typed by hand, or an undecided trip), is refused. It RESERVES every trip it
 *      records (`automated_payroll_carried_expenses`, one row per trip, so a second run's confirm is
 *      refused). A reopen or cancel of the run releases them.
 *   3. Publish re-reads the trips again, refuses another published run that carried one, and writes the
 *      paid ones (`lateExpensesCarried`), the ones of people held in this run (`lateExpensesCarriedHeld`
 *      — their money is in the held balance Held Salary Release pays) AND the own-month trips each paid
 *      person's figure covered (`expensesCovered`) into the `published` record atomically with the phase.
 *   4. After publish the paid rows are stamped, each only while still approved at the recorded amount.
 *   5. The list leaves out any trip in a published run's carried or covered lists and any trip reserved
 *      by a run of another month. UNSTAMPED IS NOT UNPAID: a trip of a month with no covered list (every
 *      month published before it was kept), of a month whose stamp failed or never ran, or of a person
 *      whose published figure differed from their approved trips is listed as NEEDS CHECKING BY HAND and
 *      never proposed. A likely duplicate of a trip already paid in any loaded month is flagged, never
 *      proposed.
 *   A refusal about a carried trip at Part 2 confirm clears THAT person's saved Expenses figure in the
 *   run and reopens the step; at publish it clears nothing, because the run is Part 2-confirmed and its
 *   files may already be at the bank (REC-035). An approval change to a carried trip clears the person in
 *   every open run that shows or reserves THAT trip (expense-resync.ts); flipping the switch reopens every
 *   open run.
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
/** Carried trips of people HELD in the carrying run: unpaid by it, owed through the held balance. */
export const LATE_EXPENSES_CARRIED_HELD_KEY = "lateExpensesCarriedHeld";
/** What a confirmed Expenses step showed: the switch and each carried trip (step state summary). */
export const LATE_EXPENSES_SHOWN_KEY = "lateExpensesShown";
/** The own-month trips each published person's figure paid (the `published` record). */
export const LATE_EXPENSES_COVERED_KEY = "expensesCovered";
/** The audit action of the record written after publish, which says whether the paid trips were marked. */
const PUBLISHED_FOLLOW_UP_ACTION = "published_follow_up";

const SETTINGS_TABLE = "automated_payroll_settings";
const RESERVATIONS_TABLE = "automated_payroll_carried_expenses";
const PAGE_SIZE = 1000;
const ID_CHUNK = 200;
/** A currency figure round-trips through a number input and rounding. */
const AMOUNT_EPSILON = 0.005;
/** Rounding the coverage rule forgives. */
const COVERAGE_TOLERANCE = 0.5;

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

export const LATE_EXPENSE_COLUMNS =
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
  /** Outstation row ids that run carried from an earlier payout month — paid, or held in its held balance. */
  carriedTripIds: ReadonlyArray<string>;
  /**
   * The month's own trip row ids its published figures paid (`expensesCovered`). NULL when the record has
   * none — every month published before it was kept — and then nothing of that month is listed as owed.
   */
  coveredTripIds: ReadonlyArray<string> | null;
  /** People whose published figure differed from their approved trips (the record's and the stamp's lists). */
  differing: ReadonlyArray<LateExpenseDiffering>;
  /** True only when the stamp after publish ran and reported no failure. */
  stampSettled: boolean;
};

/** One published person whose Expenses figure was not the total of their approved trips. */
export type LateExpenseDiffering = { compact: string; paid: number; tripsTotal: number };

/** What publish records of the own-month trips its figures paid. */
export type LateExpensesCovered = { tripIds: string[]; differing: LateExpenseDiffering[] };

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
  /**
   * Set when the trip looks like a copy of one already paid in its payout month or already in the
   * carrying run (same person, day, destination and amount). Such a trip is LISTED with these words
   * and never proposed or carried — HR decides it on Expense Approvals.
   */
  duplicateOf: string | null;
  /**
   * Set when nothing on record can say whether the trip was already paid — its month kept no list of the
   * trips its figures paid, its stamp failed or never ran, or the person's figure differed from their
   * approved trips. Listed with these words, never proposed or carried: HR checks it by hand.
   */
  needsChecking: string | null;
  row: LateExpenseRow;
};

/** What Part 2 confirm and publish record for one carried trip. */
export type LateExpenseCarriedEntry = {
  id: string;
  compact: string;
  payoutMonth: number;
  payoutYear: number;
  amount: number;
  /** The trip's day, for the sentences that name it. Absent on a stamp written before it was kept. */
  expenseDate?: string;
};

export type LateExpenseNotCoveredEntry = LateExpenseCarriedEntry & {
  /** The employee's confirmed Expenses figure. */
  paid: number;
  /** What it had to reach to cover their own month's approved trips and the carried ones. */
  needed: number;
  reason: "not_covered" | "duplicate_held";
};

/**
 * One employee whose figure pays the carried trips only in part, or holds money beyond their own trips
 * plus the carried ones — Part 2 confirm refuses both.
 */
export type LateExpensePartialCoverage = {
  compact: string;
  paid: number;
  own: number;
  needed: number;
  trips: LateExpenseCarriedEntry[];
};

/** One carried trip a confirmed Expenses step showed. */
export type LateExpenseShownTrip = {
  rowId: string;
  tripId: string;
  hrId: string;
  compact: string;
  payoutMonth: number;
  payoutYear: number;
  amount: number;
  expenseDate: string;
  /** A copy of a trip beside it in the step: held out of the figure, never recorded as paid. */
  heldDuplicate?: boolean;
};

/** One person's own-month trips a confirmed Expenses step counted: approved, not held as a duplicate. */
export type LateExpenseShownOwn = { compact: string; hrId: string; total: number; tripIds: string[] };

export type LateExpensesShown = {
  carryOn: boolean;
  trips: LateExpenseShownTrip[];
  /** NULL on a record written before the own trips were kept. */
  own: LateExpenseShownOwn[] | null;
};

/**
 * A refusal about carried trips. Its `compacts` are the people whose saved Expenses figure must be
 * cleared (clearAfterLateExpenseRefusal): a save writes every row, so a figure built on the trip as it was
 * would otherwise survive the refusal and be confirmed again.
 */
export class LateExpenseRefusal extends Error {
  readonly compacts: string[];
  constructor(message: string, compacts: ReadonlyArray<string>) {
    super(message);
    this.name = "LateExpenseRefusal";
    this.compacts = [...new Set(compacts.map((compact) => compactHrKey(compact)).filter(Boolean))];
  }
}

function periodIndex(period: { month: number; year: number }): number {
  return period.year * 12 + (period.month - 1);
}

function text(value: string | null | undefined): string {
  return (value ?? "").toString().trim();
}

function money(value: number): string {
  return roundCurrency(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function conflict(what: string, error?: { message?: string } | null): Error {
  return new Error(
    `Conflict: ${what}, so the approved expenses not yet in a run cannot be shown. Nothing was changed; ` +
      `try again in a moment.${error?.message ? ` (${error.message})` : ""}`,
  );
}

function isApproved(row: Pick<LateExpenseRow, "hr_approved" | "status">): boolean {
  return expenseApprovalState({ hrApproved: row.hr_approved, status: row.status }) === "approved";
}

function isStamped(row: Pick<LateExpenseRow, "imported_payroll_batch_id" | "imported_to_payroll_at">): boolean {
  return Boolean(row.imported_payroll_batch_id || row.imported_to_payroll_at);
}

function rowPayable(row: Pick<LateExpenseRow, "approved_amount" | "total">): number {
  return roundCurrency(payableExpenseAmount(row.approved_amount, row.total));
}

/** "Dina Hamdy Fadel's trip of 2026-09-10 (carried from September 2026)". */
function tripWords(
  entry: { compact: string; payoutMonth: number; payoutYear: number; expenseDate?: string },
  names: ReadonlyMap<string, string>,
): string {
  const name = names.get(compactHrKey(entry.compact)) || "An employee";
  const day = text(entry.expenseDate) ? ` of ${text(entry.expenseDate).slice(0, 10)}` : "";
  return `${name}'s trip${day} (carried from ${monthNameAndYear(entry.payoutMonth, entry.payoutYear)})`;
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

/** Clears the Expenses figure of a run (the people named, or everyone) and reopens a confirmed step. */
export type ReopenExpensesStep = (runId: string) => Promise<unknown>;

/**
 * Flip the switch. Refused while any run is in Part 2 or ready, so a run's Expenses step, its Part 2
 * confirm and its publish always see the same setting. Every open run's Expenses figure is cleared and
 * its step reopened FIRST, so no figure saved under the old setting survives the change. The change is
 * audited, and the audit row is REQUIRED: if it cannot be written the previous value is put back and
 * the change is refused — and if that put-back fails too, the error says the switch WAS changed.
 */
export async function setCarryLateExpenses(
  access: AccessContext,
  on: boolean,
  client?: LateExpenseDb,
  deps: { reopenExpensesStep?: ReopenExpensesStep } = {},
): Promise<{ carryLateExpenses: boolean }> {
  assertRealSessionForDecision(access, "change whether late-approved expenses are added to payroll");
  assertAutomatedPayrollHrActor(access);
  if (typeof on !== "boolean") throw new Error("Validation: say whether the switch is on or off.");
  const db = client ?? getSupabaseAdmin();
  const reopen = deps.reopenExpensesStep ?? ((runId: string) => reopenExpensesStepForRun(runId, "all", ["part1"]));

  const { data: openRuns, error: busyError } = await db
    .from("automated_payroll_runs")
    .select("id,month,year,phase")
    .in("phase", ["part1", "part2", "ready"]);
  if (busyError) {
    throw new Error(
      "Conflict: could not check whether a payroll run is in Part 2, so the switch was not changed. " +
        `Try again in a moment. (${busyError.message})`,
    );
  }
  const open = (openRuns ?? []) as Array<{ id?: string; month?: number; year?: number; phase?: string }>;
  const busy = open.filter((run) => run.phase === "part2" || run.phase === "ready");
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
  if (previous === on) return { carryLateExpenses: on };
  // A figure saved under the old setting would pay (or leave out) the carried trips by the old rule.
  for (const run of open) {
    if (run.id) await reopen(String(run.id));
  }

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
    detail: { from: previous, to: on, expensesStepsReopened: open.map((run) => String(run.id ?? "")) },
  });
  if (auditError) {
    // Put the old value back: a change nobody can trace is the state this audit row exists to prevent.
    const { error: restoreError } = await write(previous);
    if (restoreError) {
      throw new Error(
        `Conflict: the payroll switch WAS changed to ${on ? "ON" : "OFF"}, but no record of the change could be ` +
          "written and putting the old setting back also failed. Set it back by hand and tell the payroll " +
          `administrator. (record: ${auditError.message}; put back: ${restoreError.message})`,
      );
    }
    throw new Error(
      `Could not record the change to the payroll switch, so it was not changed. Try again in a moment. ` +
        `(${auditError.message})`,
    );
  }
  return { carryLateExpenses: on };
}

/**
 * Clears a run's saved Expenses figure — for the people named, or for everyone — and reopens the step if
 * it was confirmed, under the run's hold. The same mechanism expense-resync.ts uses for a month's own
 * trips. Throws when the run left `expected` or the hold cannot be taken.
 */
export async function reopenExpensesStepForRun(
  runId: string,
  hrIds: ReadonlyArray<string> | "all",
  expected: RunPhase[],
): Promise<{ clearedHrIds: string[]; reopenedStep: boolean }> {
  return holdRun({ runId, expected, action: RUN_HOLD_ACTIONS.expenseResync, waitMs: 5_000 }, async () => {
    const people = hrIds === "all" ? (await listDraftRows(runId)).map((row) => row.employeeHrId) : [...hrIds];
    const clearedHrIds = await clearDraftExpenses(runId, people);
    const expensesStep = (await listStepStates(runId)).find((state) => state.stepKey === "p2_expenses");
    const reopenedStep = expensesStep?.status === "confirmed";
    if (reopenedStep) {
      await upsertStepState({ runId, stepKey: "p2_expenses", status: "pending", confirmedAt: null, confirmedBy: null });
    }
    return { clearedHrIds, reopenedStep };
  });
}

function joinNames(names: ReadonlyArray<string>): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * After a carried-trip refusal at Part 2 confirm: clears the saved Expenses figure of the people it
 * names in this run and reopens the Expenses step, exactly as the own-month resync does, so the figure
 * built on the trip as it was cannot be confirmed again. Returns the error to throw, which says what was
 * cleared — or that clearing failed too, so HR does it by hand. Never throws itself.
 */
export async function clearAfterLateExpenseRefusal(
  runId: string,
  refusal: LateExpenseRefusal,
  expected: RunPhase[],
  names: ReadonlyMap<string, string>,
  reopen: typeof reopenExpensesStepForRun = reopenExpensesStepForRun,
): Promise<Error> {
  const who = joinNames(refusal.compacts.map((compact) => names.get(compact) || "An employee"));
  try {
    await reopen(runId, refusal.compacts, expected);
  } catch (error) {
    return new Error(
      `${refusal.message} Clearing ${who ? `${who}'s` : "the"} saved Expenses figure and reopening the Expenses step ` +
        `also failed (${error instanceof Error ? error.message : String(error)}): reopen the Expenses step and enter ` +
        "the figure again by hand before confirming.",
    );
  }
  return new Error(
    `${refusal.message} ${who ? `${who}'s saved Expenses figure in this run was cleared and the` : "The"} Expenses ` +
      "step was reopened, so it shows the trips as they stand now.",
  );
}

/**
 * A carried-trip refusal at PUBLISH (REC-035). The run is Part 2-confirmed, so its bank files may already
 * be at the bank: no figure is written. Skipping the changed trip and publishing is not an option either —
 * the confirmed figure would pay the trip as it was while the trip went back on the list to be paid again.
 * So the refusal stands and nothing is cleared; reopening Part 2 (which asks why once a file has left) and
 * confirming it again clears the figure there. Pure: returns the error to throw.
 */
export function refusalKeepingConfirmedFigures(refusal: LateExpenseRefusal): Error {
  return new Error(
    `${refusal.message} No figure was cleared: Part 2 is confirmed and its bank files may already have been ` +
      "downloaded, so this run keeps the figures it confirmed until Part 2 is reopened.",
  );
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
 *   - no published run has already carried it (paid, or held in that run's held balance);
 *   - its month's published figures did not pay it (the month's `expensesCovered` list).
 *
 * UNSTAMPED IS NOT UNPAID. A trip can be paid with no stamp: a pending trip whose amount HR typed and
 * that was approved later, a person paid 0.00 because HR refused their trips (the stamp skips them), or
 * a stamp that failed or was cut short. So a listed trip is marked `needsChecking` — shown, never
 * proposed or carried — when its month has no covered list, when its month's stamp did not report
 * success, or when the person's published figure differed from their approved trips — in the trip's own
 * month, or in ANY later published month (REC-035): a trip listed while the switch was OFF may have been
 * paid by a typed amount in a later month, and carrying it once the switch is ON would pay it again.
 * The same when the person was HELD in any later published month (REC-035): publish never compares a
 * held person's figure with their trips (expensesCoveredAtPublish skips them), so a typed amount in the
 * held figure cannot show as differing, and Held Salary Release would pay the trip a second time.
 */
export function planLateApprovedExpenses(input: {
  currentPeriod: PayrollPeriod;
  publishedRuns: ReadonlyArray<PublishedRunForLateExpenses>;
  rows: ReadonlyArray<LateExpenseRow>;
}): LateApprovedExpense[] {
  const floor = periodIndex(LATE_EXPENSE_CARRY_FLOOR);
  const current = periodIndex(input.currentPeriod);

  const carried = new Set<string>();
  const byPeriod = new Map<
    number,
    {
      runId: string;
      held: Set<string>;
      covered: Set<string> | null;
      differing: Map<string, LateExpenseDiffering>;
      stampSettled: boolean;
    }
  >();
  for (const run of input.publishedRuns) {
    for (const id of run.carriedTripIds) carried.add(String(id));
    const index = periodIndex(run);
    const entry = byPeriod.get(index) ?? {
      runId: run.runId,
      held: new Set<string>(),
      covered: run.coveredTripIds ? new Set(run.coveredTripIds.map(String)) : null,
      differing: new Map<string, LateExpenseDiffering>(),
      stampSettled: run.stampSettled,
    };
    for (const compact of run.heldCompacts) entry.held.add(compactHrKey(compact));
    for (const person of run.differing) entry.differing.set(compactHrKey(person.compact), person);
    byPeriod.set(index, entry);
  }
  // A published month in which this person's figure was not their approved trips, latest first — so a trip
  // of an earlier month can be checked against every month after its own.
  const differingMonths = [...byPeriod.entries()].sort((left, right) => right[0] - left[0]);
  const laterDiffering = (compact: string, ownIndex: number) => {
    for (const [index, entry] of differingMonths) {
      if (index <= ownIndex) break;
      const person = entry.differing.get(compact);
      if (person) return { index, person };
    }
    return null;
  };
  // A later published month that HELD this person: their figure there was never checked against their trips.
  const laterHeld = (compact: string, ownIndex: number): number | null => {
    for (const [index, entry] of differingMonths) {
      if (index <= ownIndex) break;
      if (entry.held.has(compact)) return index;
    }
    return null;
  };
  const periodLabel = (index: number) => monthNameAndYear((index % 12) + 1, Math.floor(index / 12));

  const listed: LateApprovedExpense[] = [];
  for (const row of input.rows) {
    if (!isApproved(row)) continue;
    if (isStamped(row)) continue;
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
    // Paid by its own month's published figure, stamp or no stamp.
    if (run.covered?.has(id)) continue;
    const label = monthNameAndYear(payoutMonth, payoutYear);
    const differs = run.differing.get(compact);
    const later = differs ? null : laterDiffering(compact, index);
    const laterLabel = later ? periodLabel(later.index) : "";
    const heldIndex = differs || later ? null : laterHeld(compact, index);
    const heldLabel = heldIndex === null ? "" : periodLabel(heldIndex);
    const needsChecking = !run.covered
      ? `${label} was published before payroll kept a list of the trips each figure paid, so whether this ` +
        "trip was paid cannot be told from the record. Check it by hand; it is not added to a run."
      : !run.stampSettled
        ? `Marking ${label}'s paid trips failed or never finished, so whether this trip was paid cannot be ` +
          "told from the record. Check it by hand; it is not added to a run."
        : differs
          ? `This person's ${label} Expenses figure (${money(differs.paid)}) was not the total of their approved ` +
            `trips (${money(differs.tripsTotal)}), so this trip may already have been paid by a typed amount. ` +
            "Check it by hand; it is not added to a run."
          : later
            ? `This person's ${laterLabel} Expenses figure (${money(later.person.paid)}) was not the total of their ` +
              `approved trips (${money(later.person.tripsTotal)}), so this ${label} trip may have been paid by hand in ` +
              `${laterLabel}. Check it by hand; it is not added to a run.`
            : heldIndex !== null
              ? `This person was held in ${heldLabel}, so their ${heldLabel} Expenses figure was never compared with ` +
                `their approved trips, and this ${label} trip may have been paid by hand in that held figure. Check it ` +
                "by hand; it is not added to a run."
              : null;
    listed.push({
      id,
      hrId: text(row.hr_id),
      compact,
      name: "",
      payoutMonth,
      payoutYear,
      payoutLabel: label,
      publishedRunId: run.runId,
      amount: rowPayable(row),
      expenseDate: text(row.expense_date).slice(0, 10),
      toDate: text(row.to_date).slice(0, 10),
      fromLocation: text(row.from_location),
      toLocation: text(row.to_location) || text(row.location),
      duplicateOf: null,
      needsChecking,
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

/**
 * Flags a listed trip that looks like a copy of one ALREADY PAID in ANY loaded month — stamped, or in a
 * published run's covered or carried list (`paidIds`) — or already IN the carrying run (an approved trip
 * of `currentPeriod`), using the payroll duplicate rule (same person, day, destination and amount). A
 * copy is often filed under another payout month than its twin, so no month is left out. A flagged trip
 * stays on the list, says why, and is never proposed or carried. Pure.
 */
export function flagLateExpenseDuplicates(
  listed: ReadonlyArray<LateApprovedExpense>,
  rows: ReadonlyArray<LateExpenseRow>,
  currentPeriod: PayrollPeriod,
  paidIds: ReadonlySet<string> = new Set(),
): LateApprovedExpense[] {
  const current = periodIndex(currentPeriod);
  const asCandidate = (row: LateExpenseRow) => ({
    tripId: String(row.id ?? ""),
    expenseDate: text(row.expense_date),
    toLocation: text(row.to_location) || text(row.location),
    total: Number(row.total ?? 0),
    approvedAmount: row.approved_amount,
  });
  return listed.map((trip) => {
    const others = rows.filter((row) => {
      const id = String(row.id ?? "");
      if (id === trip.id || !isApproved(row)) return false;
      if (compactHrKey(row.hr_id ?? "") !== trip.compact) return false;
      const index = periodIndex({ month: Number(row.payout_month), year: Number(row.payout_year) });
      return isStamped(row) || paidIds.has(id) || index === current;
    });
    if (others.length === 0) return trip;
    const holds = findDuplicateExpenseHolds([...others.map(asCandidate), asCandidate(trip.row)]);
    const hold = holds.get(trip.id);
    if (!hold) return trip;
    const kept = others.find((row) => String(row.id ?? "") === hold.duplicateOfTripId);
    const keptIndex = kept ? periodIndex({ month: Number(kept.payout_month), year: Number(kept.payout_year) }) : -1;
    const where =
      keptIndex === current
        ? `a trip already in this run's own month (${monthNameAndYear(currentPeriod.month, currentPeriod.year)})`
        : `a trip already paid in ${kept ? monthNameAndYear(Number(kept.payout_month), Number(kept.payout_year)) : trip.payoutLabel}`;
    return {
      ...trip,
      duplicateOf:
        `Likely a duplicate of ${where}${kept?.trip_id ? `, ${text(kept.trip_id)}` : ""} — same day, destination ` +
        "and amount. Not added to a run; decide it on Expense Approvals.",
    };
  });
}

/** The carried entries inside one Part 2 stamp or `published` record. Tolerant of an older detail. */
export function parseLateExpensesCarried(detail: unknown, key: string = LATE_EXPENSES_CARRIED_KEY): LateExpenseCarriedEntry[] {
  const list = (detail as Record<string, unknown> | null | undefined)?.[key];
  if (!Array.isArray(list)) return [];
  return (list as Array<Record<string, unknown>>)
    .map((entry) => ({
      id: String(entry?.id ?? "").trim(),
      compact: compactHrKey(String(entry?.compact ?? "")),
      payoutMonth: Number(entry?.payoutMonth ?? 0),
      payoutYear: Number(entry?.payoutYear ?? 0),
      amount: roundCurrency(Number(entry?.amount ?? 0) || 0),
      ...(entry?.expenseDate ? { expenseDate: String(entry.expenseDate) } : {}),
    }))
    .filter((entry) => entry.id && entry.compact);
}

/**
 * Which carried trips Part 2 confirm records as paid, from what the confirmed Expenses step SHOWED — its
 * own-month trips as snapshotted plus the carried ones, never a live re-read of the month. Pure.
 *
 * An employee's carried trips are recorded ONLY when their confirmed Expenses figure equals their own
 * month's approved total plus the carried total (within 0.50 for rounding). A figure at or below the own
 * trips pays none of them: they are left OUT (`notCovered`) and stay on the list. A figure ABOVE the own
 * trips but short of own plus carried pays them in part — `partial`. A figure ABOVE own plus carried holds
 * money no trip on the step explains (an amount typed by hand, or an undecided trip) — `handAdded`: it
 * cannot show the carried trips were paid rather than the typed money. Part 2 confirm refuses both. A
 * carried trip held as a duplicate is never recorded either.
 */
export function planLateExpenseCoverage(input: {
  shown: Pick<LateExpensesShown, "trips" | "own">;
  expensesByCompact: ReadonlyMap<string, number | null | undefined>;
}): {
  carried: LateExpenseCarriedEntry[];
  notCovered: LateExpenseNotCoveredEntry[];
  partial: LateExpensePartialCoverage[];
  handAdded: LateExpensePartialCoverage[];
} {
  const carried: LateExpenseCarriedEntry[] = [];
  const notCovered: LateExpenseNotCoveredEntry[] = [];
  const partial: LateExpensePartialCoverage[] = [];
  const handAdded: LateExpensePartialCoverage[] = [];
  const ownByCompact = new Map((input.shown.own ?? []).map((person) => [compactHrKey(person.compact), roundCurrency(person.total)]));
  const tripsByCompact = new Map<string, LateExpenseShownTrip[]>();
  for (const trip of input.shown.trips) {
    const compact = compactHrKey(trip.compact);
    tripsByCompact.set(compact, [...(tripsByCompact.get(compact) ?? []), trip]);
  }
  for (const [compact, trips] of tripsByCompact) {
    const own = ownByCompact.get(compact) ?? 0;
    let carriedTotal = 0;
    const counted: LateExpenseCarriedEntry[] = [];
    const held: LateExpenseCarriedEntry[] = [];
    for (const trip of trips) {
      const entry: LateExpenseCarriedEntry = {
        id: trip.rowId,
        compact,
        payoutMonth: trip.payoutMonth,
        payoutYear: trip.payoutYear,
        amount: roundCurrency(trip.amount),
        expenseDate: trip.expenseDate,
      };
      if (trip.heldDuplicate) {
        held.push(entry);
        continue;
      }
      carriedTotal = roundCurrency(carriedTotal + entry.amount);
      counted.push(entry);
    }
    const paid = roundCurrency(Number(input.expensesByCompact.get(compact) ?? 0) || 0);
    const needed = roundCurrency(own + carriedTotal);
    if (counted.length > 0 && paid > needed + COVERAGE_TOLERANCE) handAdded.push({ compact, paid, own, needed, trips: counted });
    else if (counted.length > 0 && paid >= needed - COVERAGE_TOLERANCE) carried.push(...counted);
    else if (counted.length > 0 && paid > own + COVERAGE_TOLERANCE) partial.push({ compact, paid, own, needed, trips: counted });
    else for (const entry of counted) notCovered.push({ ...entry, paid, needed, reason: "not_covered" });
    for (const entry of held) notCovered.push({ ...entry, paid, needed, reason: "duplicate_held" });
  }
  return { carried, notCovered, partial, handAdded };
}

/** The refusal for a figure holding money beyond its own and carried trips, naming each person and trip. */
export function describeLateExpenseHandAdded(
  handAdded: ReadonlyArray<LateExpensePartialCoverage>,
  names: ReadonlyMap<string, string>,
): string {
  const people = handAdded.map((person) => {
    const name = names.get(compactHrKey(person.compact)) || "An employee";
    const trips = person.trips.map((trip) => tripWords(trip, names).replace(/^.*?'s /, "")).join(", ");
    return (
      `${name}'s Expenses figure ${money(person.paid)} is more than their own approved trips this month ` +
      `(${money(person.own)}) plus the carried ${trips} (${money(person.needed)})`
    );
  });
  return (
    `Conflict: ${people.join("; ")}. The extra was typed by hand or is an undecided trip, so the figure cannot ` +
    "show the carried trips were paid. Nothing was confirmed. Decide every undecided trip on Expense Approvals, " +
    "make the figure exactly their trips — or only their own trips to leave the carried ones on the list — confirm " +
    "the Expenses step, then confirm Part 2 again."
  );
}

/** The refusal for a figure that pays carried trips in part, naming each person and trip. */
export function describeLateExpensePartialCoverage(
  partial: ReadonlyArray<LateExpensePartialCoverage>,
  names: ReadonlyMap<string, string>,
): string {
  const people = partial.map((person) => {
    const name = names.get(compactHrKey(person.compact)) || "An employee";
    const trips = person.trips.map((trip) => tripWords(trip, names).replace(/^.*?'s /, "")).join(", ");
    return (
      `${name}'s Expenses figure ${money(person.paid)} is above their own trips this month (${money(person.own)}) ` +
      `but short of those plus the carried ${trips} (${money(person.needed)})`
    );
  });
  return (
    `Conflict: ${people.join("; ")}. The carried trips would be paid only in part. Nothing was confirmed. On ` +
    "the Expenses step either pay every carried trip in full or take them out, confirm the step, then confirm Part 2 again."
  );
}

/**
 * Splits what Part 2 confirm recorded, at publish. Pure.
 *   - `paid`: people published (not held) with expenses above zero — this run pays them;
 *   - `held`: people this run HOLDS — their figure, carried trips included, is in their held balance
 *     (secondPartWithheld) and Held Salary Release pays it, so the trips are still carried and must never
 *     be listed again;
 *   - `dropped`: anyone else (no row, or nothing paid) — not carried, their reservation is released.
 */
export function lateExpensesAtPublish(
  carried: ReadonlyArray<LateExpenseCarriedEntry>,
  entries: ReadonlyArray<{ compact: string; onHold: boolean; row: { expenses: number } }>,
): { paid: LateExpenseCarriedEntry[]; held: LateExpenseCarriedEntry[]; dropped: LateExpenseCarriedEntry[] } {
  const paidPeople = new Set<string>();
  const heldPeople = new Set<string>();
  for (const entry of entries) {
    const compact = compactHrKey(entry.compact);
    if (entry.onHold) heldPeople.add(compact);
    else if ((Number(entry.row.expenses) || 0) > 0) paidPeople.add(compact);
  }
  const paid: LateExpenseCarriedEntry[] = [];
  const held: LateExpenseCarriedEntry[] = [];
  const dropped: LateExpenseCarriedEntry[] = [];
  for (const entry of carried) {
    const compact = compactHrKey(entry.compact);
    if (heldPeople.has(compact)) held.push(entry);
    else if (paidPeople.has(compact)) paid.push(entry);
    else dropped.push(entry);
  }
  return { paid, held, dropped };
}

/** The carried trips publish pays itself (`lateExpensesAtPublish(...).paid`). Pure. */
export function lateExpensesPaidAtPublish(
  carried: ReadonlyArray<LateExpenseCarriedEntry>,
  entries: ReadonlyArray<{ compact: string; onHold: boolean; row: { expenses: number } }>,
): LateExpenseCarriedEntry[] {
  return lateExpensesAtPublish(carried, entries).paid;
}

/**
 * The own-month trips this month's published figures PAID, written with the phase (`expensesCovered`).
 * Pure. Read from what the confirmed Expenses step showed (its own trips as snapshotted), so a trip
 * approved after the step was confirmed is never counted as paid by a figure that did not include it.
 *
 * For each published (not held) person: when the figure equals their snapshotted approved trips plus the
 * carried trips this run pays them (within 0.50), those own trips are covered. Otherwise — a typed amount,
 * a 0.00 figure that refused their trips, money with no trip behind it — they are `differing`, and their
 * later-approved trips of this month are listed as needing a check by hand, never carried. A held person
 * is in neither list; planLateApprovedExpenses marks their earlier months' listed trips instead (REC-035).
 * NULL when the step kept no snapshot of its own trips: the month is then checked by hand entirely.
 */
export function expensesCoveredAtPublish(input: {
  shown: Pick<LateExpensesShown, "own"> | null;
  entries: ReadonlyArray<{ compact: string; onHold: boolean; row: { expenses: number } }>;
  carriedPaid: ReadonlyArray<LateExpenseCarriedEntry>;
}): LateExpensesCovered | null {
  if (!input.shown?.own) return null;
  const ownByCompact = new Map(input.shown.own.map((person) => [compactHrKey(person.compact), person]));
  const carriedByCompact = new Map<string, number>();
  for (const entry of input.carriedPaid) {
    const compact = compactHrKey(entry.compact);
    carriedByCompact.set(compact, roundCurrency((carriedByCompact.get(compact) ?? 0) + entry.amount));
  }
  const tripIds: string[] = [];
  const differing: LateExpenseDiffering[] = [];
  for (const entry of input.entries) {
    if (entry.onHold) continue;
    const compact = compactHrKey(entry.compact);
    if (!compact) continue;
    const own = ownByCompact.get(compact);
    const tripsTotal = roundCurrency((own?.total ?? 0) + (carriedByCompact.get(compact) ?? 0));
    const paid = roundCurrency(Number(entry.row.expenses) || 0);
    if (!own?.tripIds.length && tripsTotal === 0 && Math.abs(paid) <= COVERAGE_TOLERANCE) continue;
    if (Math.abs(paid - tripsTotal) <= COVERAGE_TOLERANCE) tripIds.push(...(own?.tripIds ?? []));
    else differing.push({ compact, paid, tripsTotal });
  }
  return { tripIds: [...new Set(tripIds)], differing };
}

/** The covered list in a `published` record; null when the record has none. */
export function parseExpensesCovered(detail: unknown): LateExpensesCovered | null {
  const value = (detail as Record<string, unknown> | null | undefined)?.[LATE_EXPENSES_COVERED_KEY] as
    | { tripIds?: unknown; differing?: unknown }
    | null
    | undefined;
  if (!value || typeof value !== "object" || !Array.isArray(value.tripIds)) return null;
  return {
    tripIds: (value.tripIds as unknown[]).map((id) => String(id ?? "").trim()).filter(Boolean),
    differing: parseDiffering(value.differing),
  };
}

function parseDiffering(list: unknown): LateExpenseDiffering[] {
  if (!Array.isArray(list)) return [];
  return (list as Array<Record<string, unknown>>)
    .map((person) => ({
      compact: compactHrKey(String(person?.compact ?? "")),
      paid: roundCurrency(Number(person?.paid ?? 0) || 0),
      tripsTotal: roundCurrency(Number(person?.tripsTotal ?? 0) || 0),
    }))
    .filter((person) => person.compact);
}

/**
 * What the record written after publish says of the stamp: settled only when it ran and reported no
 * failure. A missing record (the follow-up never ran) or one carrying an error is NOT settled. Pure.
 */
export function parseStampFollowUp(detail: unknown): { settled: boolean; differing: LateExpenseDiffering[] } {
  const stamp = (detail as Record<string, unknown> | null | undefined)?.expenseStamp as Record<string, unknown> | null | undefined;
  if (!stamp || typeof stamp !== "object" || "error" in stamp) return { settled: false, differing: [] };
  return { settled: true, differing: parseDiffering(stamp.differing) };
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

// ---- What the Expenses step showed (pure) ------------------------------------------------------

/**
 * The record a confirmed Expenses step keeps: its carried trips, and each run member's own-month trips
 * that count in the proposed figure (approved, not held as a duplicate) — built from the SAME trip map the
 * step's figure was built from, never a second read. Pure.
 */
export function lateExpensesShownFrom(
  carryOn: boolean,
  tripsByCompact: ReadonlyMap<string, ReadonlyArray<PayoutExpenseTrip>>,
  memberCompacts?: ReadonlySet<string>,
): LateExpensesShown {
  const trips: LateExpenseShownTrip[] = [];
  const own: LateExpenseShownOwn[] = [];
  for (const [compact, list] of tripsByCompact) {
    if (memberCompacts && !memberCompacts.has(compact)) continue;
    const holds = findDuplicateExpenseHolds([...list]);
    let ownTotal = 0;
    const ownIds: string[] = [];
    for (const trip of list) {
      const amount = roundCurrency(payableExpenseAmount(trip.approvedAmount, trip.total));
      if (!trip.carriedFrom) {
        if (trip.hrApproved && !holds.has(trip.tripId)) {
          ownTotal = roundCurrency(ownTotal + amount);
          if (trip.rowId) ownIds.push(trip.rowId);
        }
        continue;
      }
      trips.push({
        rowId: trip.carriedFrom.rowId,
        tripId: trip.tripId,
        hrId: text(trip.hrId),
        compact,
        payoutMonth: trip.carriedFrom.month,
        payoutYear: trip.carriedFrom.year,
        amount,
        expenseDate: trip.expenseDate,
        ...(holds.has(trip.tripId) ? { heldDuplicate: true } : {}),
      });
    }
    if (ownIds.length > 0 || ownTotal > 0) {
      own.push({ compact, hrId: text(list[0]?.hrId) || compact, total: ownTotal, tripIds: ownIds });
    }
  }
  return { carryOn, trips, own };
}

/** The record in a step state's summary; null when the step was confirmed before it was kept. */
export function parseLateExpensesShown(summary: unknown): LateExpensesShown | null {
  const value = (summary as Record<string, unknown> | null | undefined)?.[LATE_EXPENSES_SHOWN_KEY] as
    | { carryOn?: unknown; trips?: unknown; own?: unknown }
    | undefined;
  if (!value || typeof value !== "object") return null;
  const trips = Array.isArray(value.trips) ? (value.trips as Array<Record<string, unknown>>) : [];
  const own = Array.isArray(value.own)
    ? (value.own as Array<Record<string, unknown>>)
        .map((person) => ({
          compact: compactHrKey(String(person?.compact ?? "")),
          hrId: String(person?.hrId ?? "").trim(),
          total: roundCurrency(Number(person?.total ?? 0) || 0),
          tripIds: Array.isArray(person?.tripIds) ? (person.tripIds as unknown[]).map((id) => String(id ?? "").trim()).filter(Boolean) : [],
        }))
        .filter((person) => person.compact)
    : null;
  return {
    carryOn: value.carryOn === true,
    trips: trips
      .map((trip) => ({
        rowId: String(trip?.rowId ?? "").trim(),
        tripId: String(trip?.tripId ?? "").trim(),
        hrId: String(trip?.hrId ?? "").trim(),
        compact: compactHrKey(String(trip?.compact ?? "")),
        payoutMonth: Number(trip?.payoutMonth ?? 0),
        payoutYear: Number(trip?.payoutYear ?? 0),
        amount: roundCurrency(Number(trip?.amount ?? 0) || 0),
        expenseDate: String(trip?.expenseDate ?? ""),
        ...(trip?.heldDuplicate === true ? { heldDuplicate: true } : {}),
      }))
      .filter((trip) => trip.rowId && trip.compact),
    own,
  };
}

/**
 * Part 2 confirm refuses when the switch is not what the Expenses step was confirmed under: the figure
 * would pay (or leave out) the carried trips by the other rule. A step confirmed before this record
 * existed reads as confirmed with the switch OFF.
 */
export function assertLateExpensesShownMatchesSwitch(carryOn: boolean, shown: LateExpensesShown | null): void {
  const shownOn = shown?.carryOn === true;
  if (shownOn === carryOn) return;
  // The people whose figure counted carried trips under the old setting.
  throw new LateExpenseRefusal(
    `Conflict: the switch for expenses approved after their month was paid is ${carryOn ? "ON" : "OFF"} now, but ` +
      `the Expenses step was confirmed while it was ${shownOn ? "ON" : "OFF"}. Nothing was confirmed. Reload the ` +
      "Expenses step, confirm it again, then confirm Part 2.",
    (shown?.trips ?? []).map((trip) => trip.compact),
  );
}

export type LateExpenseChange = {
  entry: { id: string; compact: string; payoutMonth: number; payoutYear: number; amount: number; expenseDate?: string };
  reason: "missing" | "not_approved" | "amount_changed" | "already_paid" | "moved";
  /** The amount the trip pays now, for `amount_changed`. */
  now?: number;
};

/**
 * Which recorded carried trips no longer stand as recorded: gone, no longer approved, paid, moved to
 * another payout month, or a different amount. Pure.
 */
export function lateExpenseChanges(
  expected: ReadonlyArray<LateExpenseChange["entry"]>,
  current: ReadonlyArray<LateExpenseRow>,
): LateExpenseChange[] {
  const byId = new Map(current.map((row) => [String(row.id ?? ""), row]));
  const changes: LateExpenseChange[] = [];
  for (const entry of expected) {
    const row = byId.get(entry.id);
    if (!row) changes.push({ entry, reason: "missing" });
    else if (!isApproved(row)) changes.push({ entry, reason: "not_approved" });
    else if (isStamped(row)) changes.push({ entry, reason: "already_paid" });
    else if (Number(row.payout_month) !== entry.payoutMonth || Number(row.payout_year) !== entry.payoutYear) {
      changes.push({ entry, reason: "moved" });
    } else if (Math.abs(rowPayable(row) - roundCurrency(entry.amount)) > AMOUNT_EPSILON) {
      changes.push({ entry, reason: "amount_changed", now: rowPayable(row) });
    }
  }
  return changes;
}

/** The refusal for carried trips that changed since they were recorded, naming each person and trip. */
export function describeLateExpenseChanges(
  changes: ReadonlyArray<LateExpenseChange>,
  names: ReadonlyMap<string, string>,
  stage: "confirm" | "publish",
): string {
  const lines = changes.map((change) => {
    const what = tripWords(change.entry, names);
    switch (change.reason) {
      case "missing":
        return `${what} no longer exists`;
      case "not_approved":
        return `${what} is no longer approved`;
      case "already_paid":
        return `${what} was already marked paid`;
      case "moved":
        return `${what} was moved to another payout month`;
      default:
        return `${what} now pays ${money(change.now ?? 0)}, not ${money(change.entry.amount)}`;
    }
  });
  const remedy =
    stage === "confirm"
      ? "Nothing was confirmed. Reload the Expenses step, confirm it again, then confirm Part 2."
      : "Nothing was published. Reopen Part 2, reload the Expenses step, confirm it again, then confirm Part 2 and publish.";
  return `Conflict: ${lines.join("; ")} since the Expenses step was confirmed. ${remedy}`;
}

// ---- The reads --------------------------------------------------------------------------------

type PageResult = { data: unknown; error: { message?: string; code?: string } | null };

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

/** Reads `ids` in chunks. Throws on any failed read. */
async function readByIds<T>(
  ids: ReadonlyArray<string>,
  page: (chunk: string[], from: number, to: number) => PromiseLike<PageResult>,
  what: string,
): Promise<T[]> {
  const unique = [...new Set(ids.map(String).filter(Boolean))];
  const rows: T[] = [];
  for (let index = 0; index < unique.length; index += ID_CHUNK) {
    const chunk = unique.slice(index, index + ID_CHUNK);
    rows.push(...(await readAllPages<T>((from, to) => page(chunk, from, to), what)));
  }
  return rows;
}

/** The outstation rows with these ids, as they stand now. Throws on a failed read. */
export async function loadLateExpenseRowsById(ids: ReadonlyArray<string>, client?: LateExpenseDb): Promise<LateExpenseRow[]> {
  const db = client ?? getSupabaseAdmin();
  return readByIds<LateExpenseRow>(
    ids,
    (chunk, from, to) =>
      db.from("outstation_expenses").select(LATE_EXPENSE_COLUMNS).in("id", chunk).order("id", { ascending: true }).range(from, to),
    "the carried outstation trips",
  );
}

/**
 * Refuses when any recorded carried trip no longer stands as recorded (lateExpenseChanges). Called by
 * Part 2 confirm against what the Expenses step showed, and by publish against what Part 2 recorded.
 */
export async function assertLateExpensesUnchanged(
  expected: ReadonlyArray<LateExpenseChange["entry"]>,
  names: ReadonlyMap<string, string>,
  stage: "confirm" | "publish",
  client?: LateExpenseDb,
): Promise<LateExpenseRow[]> {
  if (expected.length === 0) return [];
  const current = await loadLateExpenseRowsById(
    expected.map((entry) => entry.id),
    client,
  );
  const changes = lateExpenseChanges(expected, current);
  if (changes.length > 0) {
    throw new LateExpenseRefusal(
      describeLateExpenseChanges(changes, names, stage),
      changes.map((change) => change.entry.compact),
    );
  }
  return current;
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

  const audit = await readAllPages<{ run_id: string; action: string; detail: unknown; created_at: string }>(
    (from, to) =>
      db
        .from("automated_payroll_audit")
        .select("run_id,action,detail,created_at")
        .in("action", ["published", PUBLISHED_FOLLOW_UP_ACTION])
        .in("run_id", recent.map((run) => run.runId))
        .order("created_at", { ascending: false })
        .range(from, to),
    "the published payroll records",
  );
  const newest = new Map<string, { detail: unknown; createdAt: string }>();
  const newestFollowUp = new Map<string, { detail: unknown; createdAt: string }>();
  for (const row of audit) {
    const runId = String(row.run_id ?? "");
    const createdAt = String(row.created_at ?? "");
    const into = row.action === PUBLISHED_FOLLOW_UP_ACTION ? newestFollowUp : newest;
    const seen = into.get(runId);
    if (!seen || createdAt > seen.createdAt) into.set(runId, { detail: row.detail, createdAt });
  }

  return recent.map((run) => {
    const record = newest.get(run.runId);
    const label = monthNameAndYear(run.month, run.year);
    if (!record) throw conflict(`the ${label} payroll run is published but its record of who was held is missing`);
    const held = parsePublishedHoldDetail(record.detail).held;
    if (!held) throw conflict(`the ${label} payroll run's record does not say who was held`);
    const covered = parseExpensesCovered(record.detail);
    // No follow-up record, or one whose stamp failed: whether the month's trips were marked is unknown.
    const followUp = parseStampFollowUp(newestFollowUp.get(run.runId)?.detail);
    return {
      ...run,
      heldCompacts: held.map((person) => person.compact),
      // A held person's carried trip is in that run's held balance: carried, never listed again.
      carriedTripIds: [
        ...parseLateExpensesCarried(record.detail),
        ...parseLateExpensesCarried(record.detail, LATE_EXPENSES_CARRIED_HELD_KEY),
      ].map((entry) => entry.id),
      coveredTripIds: covered?.tripIds ?? null,
      differing: [...(covered?.differing ?? []), ...followUp.differing],
      stampSettled: followUp.settled,
    };
  });
}

/** Trip ids reserved by a run of ANOTHER month (a Part 2 confirm took them). Throws on a failed read. */
async function loadReservedElsewhere(
  ids: ReadonlyArray<string>,
  currentPeriod: PayrollPeriod,
  db: LateExpenseDb,
): Promise<Set<string>> {
  const reserved = await readByIds<{ expense_id: string; run_id: string }>(
    ids,
    (chunk, from, to) =>
      db.from(RESERVATIONS_TABLE).select("expense_id,run_id").in("expense_id", chunk).order("expense_id", { ascending: true }).range(from, to),
    "the trips other payroll runs are paying",
  );
  if (reserved.length === 0) return new Set();
  const runs = await readByIds<{ id: string; month: number; year: number }>(
    reserved.map((row) => String(row.run_id)),
    (chunk, from, to) =>
      db.from("automated_payroll_runs").select("id,month,year").in("id", chunk).order("id", { ascending: true }).range(from, to),
    "the payroll runs paying those trips",
  );
  const periodOf = new Map(runs.map((run) => [String(run.id), periodIndex({ month: Number(run.month), year: Number(run.year) })]));
  const current = periodIndex(currentPeriod);
  return new Set(
    reserved.filter((row) => periodOf.get(String(row.run_id)) !== current).map((row) => String(row.expense_id)),
  );
}

/**
 * The approved trips owed from a payout month that was already published, for a run of
 * `currentPeriod`, with each employee's name. A trip reserved by a run of another month is left out; a
 * likely duplicate is flagged. Any failed read throws — never an empty list.
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

  // Every row of each published month (paid ones too: the duplicate check compares against them).
  const readMonth = (period: PayrollPeriod) =>
    readAllPages<LateExpenseRow>(
      (from, to) =>
        db
          .from("outstation_expenses")
          .select(LATE_EXPENSE_COLUMNS)
          .eq("payout_month", period.month)
          .eq("payout_year", period.year)
          .order("id", { ascending: true })
          .range(from, to),
      `the outstation expenses for ${monthNameAndYear(period.month, period.year)}`,
    );
  const rows: LateExpenseRow[] = [];
  const seenPeriods = new Set<number>();
  for (const period of periods) {
    if (seenPeriods.has(periodIndex(period))) continue;
    seenPeriods.add(periodIndex(period));
    rows.push(...(await readMonth(period)));
  }

  const planned = planLateApprovedExpenses({ currentPeriod, publishedRuns, rows });
  if (planned.length === 0) return planned;
  const reservedElsewhere = await loadReservedElsewhere(planned.map((trip) => trip.id), currentPeriod, db);
  const open = planned.filter((trip) => !reservedElsewhere.has(trip.id));
  if (open.length === 0) return open;
  // Every trip any published run paid, stamped or not: a copy is compared against all of them.
  const paidIds = new Set(publishedRuns.flatMap((run) => [...run.carriedTripIds, ...(run.coveredTripIds ?? [])]));
  const listed = flagLateExpenseDuplicates(open, [...rows, ...(await readMonth(currentPeriod))], currentPeriod, paidIds);

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

/** What another published run carried (paid or held), for the publish guard. Throws on a failed read. */
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
  const clashing = new Set(clashes.map((clash) => clash.id));
  throw new LateExpenseRefusal(
    `Conflict: ${clashes.length} late-approved outstation trip${clashes.length === 1 ? "" : "s"} this run would pay ` +
      `${clashes.length === 1 ? "was" : "were"} already paid by the ${months} run. Nothing was published. Reopen ` +
      "Part 2, take the trip out of the Expenses figure, and confirm again.",
    carried.filter((entry) => clashing.has(entry.id)).map((entry) => entry.compact),
  );
}

/**
 * Publish's checks on the carried trips, under its claim and before anything is written: no other
 * published run carried any of them, and every one is still approved, unpaid, in its month, at the
 * amount Part 2 recorded. A trip neither paid nor held (`dropped`) has its reservation released.
 */
export async function assertLateExpensesPublishable(
  runId: string,
  late: { paid: ReadonlyArray<LateExpenseCarriedEntry>; held: ReadonlyArray<LateExpenseCarriedEntry>; dropped: ReadonlyArray<LateExpenseCarriedEntry> },
  names: ReadonlyMap<string, string>,
  client?: LateExpenseDb,
): Promise<void> {
  const carried = [...late.paid, ...late.held];
  await assertLateExpensesNotCarriedElsewhere(runId, carried, client);
  await assertLateExpensesUnchanged(carried, names, "publish", client);
  if (late.dropped.length > 0) {
    await releaseLateExpenseReservations(runId, client, late.dropped.map((entry) => entry.id));
  }
}

// ---- Reservations -----------------------------------------------------------------------------

/**
 * Reserves the carried trips a Part 2 confirm records, one row per trip (`expense_id` is the primary
 * key), so a second run's confirm cannot record the same trip. This run's earlier reservations are
 * replaced. A trip another run holds refuses the confirm, naming the trip and that run's month.
 */
export async function reserveLateExpenses(
  runId: string,
  carried: ReadonlyArray<LateExpenseCarriedEntry>,
  names: ReadonlyMap<string, string>,
  client?: LateExpenseDb,
): Promise<void> {
  const db = client ?? getSupabaseAdmin();
  await releaseLateExpenseReservations(runId, db);
  const ids = [...new Set(carried.map((entry) => entry.id))];
  if (ids.length === 0) return;

  const refuseHeldElsewhere = async () => {
    const holders = (
      await readByIds<{ expense_id: string; run_id: string }>(
        ids,
        (chunk, from, to) =>
          db.from(RESERVATIONS_TABLE).select("expense_id,run_id").in("expense_id", chunk).order("expense_id", { ascending: true }).range(from, to),
        "the trips other payroll runs are paying",
      )
    ).filter((row) => String(row.run_id) !== runId);
    if (holders.length === 0) return;
    const runs = await readByIds<{ id: string; month: number; year: number }>(
      holders.map((row) => String(row.run_id)),
      (chunk, from, to) =>
        db.from("automated_payroll_runs").select("id,month,year").in("id", chunk).order("id", { ascending: true }).range(from, to),
      "the payroll runs paying those trips",
    );
    const monthOf = new Map(runs.map((run) => [String(run.id), monthNameAndYear(Number(run.month), Number(run.year))]));
    const byId = new Map(carried.map((entry) => [entry.id, entry]));
    const lines = holders.map((row) => {
      const entry = byId.get(String(row.expense_id));
      const what = entry ? tripWords(entry, names) : "A carried trip";
      return `${what} is already being paid by the ${monthOf.get(String(row.run_id)) ?? "another"} payroll run`;
    });
    throw new LateExpenseRefusal(
      `Conflict: ${lines.join("; ")}. Nothing was confirmed. Reload the Expenses step — the trip is no longer ` +
        "offered here — confirm it again, then confirm Part 2.",
      holders.map((row) => byId.get(String(row.expense_id))?.compact ?? ""),
    );
  };

  await refuseHeldElsewhere();
  const { error } = await db.from(RESERVATIONS_TABLE).insert(ids.map((id) => ({ expense_id: id, run_id: runId })));
  if (error) {
    // Another run's confirm took one in the moment between: say which.
    if ((error as { code?: string }).code === "23505") {
      await refuseHeldElsewhere();
      // The holder released it again in the meantime: still a clash over a carried trip, so the figure
      // built on it is cleared like any other.
      throw new LateExpenseRefusal(
        "Conflict: another payroll run set aside one of the carried trips at the same moment, so nothing was " +
          "confirmed. Reload the Expenses step, confirm it again, then confirm Part 2.",
        carried.map((entry) => entry.compact),
      );
    }
    throw new Error(
      "Conflict: the carried outstation trips could not be reserved for this run, so nothing was confirmed. " +
        `Confirm Part 2 again in a moment. (${error.message})`,
    );
  }
}

/**
 * Releases this run's reservations — all of them, or the ids named. Called when its Part 1 or Part 2 is
 * reopened or it is cancelled: a run that is no longer confirmed pays no carried trip. Throws on a
 * failed write, so the reopen is refused rather than leaving the trips hidden from every other run.
 */
export async function releaseLateExpenseReservations(
  runId: string,
  client?: LateExpenseDb,
  ids?: ReadonlyArray<string>,
): Promise<void> {
  const db = client ?? getSupabaseAdmin();
  let query = db.from(RESERVATIONS_TABLE).delete().eq("run_id", runId);
  if (ids) {
    if (ids.length === 0) return;
    query = query.in("expense_id", [...ids]);
  }
  const { error } = await query;
  if (error) {
    throw new Error(
      "Conflict: the late-approved trips this run had set aside could not be released, so nothing was changed. " +
        `Try again in a moment. (${error.message})`,
    );
  }
}

/** A trip whose decision moved, as the resync knows it: its trip id, and its person and payout month when known. */
export type LateTripRef = { tripId: string; hrId?: string | null; month?: number | null; year?: number | null };

/**
 * Every open run (Part 1, Part 2 or ready — not published or cancelled) that LISTS or RESERVES any of these
 * trips as carried, with the people whose figure to clear. expense-resync.ts clears them when a trip's
 * decision moves: the trip's own payout month is published, so the ordinary resync never reaches them.
 *
 * A run lists the trip when its confirmed Expenses step showed it. A CONFIRMED step's record of what it
 * showed is the whole answer (REC-035): a decision on another trip of the same published month clears
 * nobody there. Only a step with no confirmed record — whose saved figure may hold a proposed trip that
 * nothing wrote down — falls back to: the switch is ON and the trip's payout month is an earlier,
 * published month at or after the floor. A run reserves it when its Part 2 confirm took it. Throws on any
 * failed read.
 */
export async function findOpenRunsShowingLateTrips(
  trips: ReadonlyArray<string | LateTripRef>,
  client?: LateExpenseDb,
): Promise<Array<{ run: { id: string; month: number; year: number; phase: RunPhase }; hrIds: string[] }>> {
  const refs = trips
    .map((trip) => (typeof trip === "string" ? { tripId: trip } : trip))
    .map((trip) => ({ ...trip, tripId: String(trip.tripId ?? "").trim() }))
    .filter((trip) => trip.tripId);
  const wanted = new Set(refs.map((trip) => trip.tripId));
  if (wanted.size === 0) return [];
  const db = client ?? getSupabaseAdmin();
  const runs = await readAllPages<{ id: string; month: number; year: number; phase: RunPhase }>(
    (from, to) =>
      db
        .from("automated_payroll_runs")
        .select("id,month,year,phase")
        .in("phase", ["part1", "part2", "ready", "published"])
        .order("id", { ascending: true })
        .range(from, to),
    "the open payroll runs",
  );
  const open = runs.filter((run) => run.phase !== "published");
  if (open.length === 0) return [];
  const publishedPeriods = new Set(
    runs.filter((run) => run.phase === "published").map((run) => periodIndex({ month: Number(run.month), year: Number(run.year) })),
  );
  const openIds = open.map((run) => String(run.id));
  const states = await readAllPages<{ run_id: string; summary: unknown; status?: unknown }>(
    (from, to) =>
      db
        .from("automated_payroll_step_state")
        .select("run_id,summary,status")
        .eq("step_key", "p2_expenses")
        .in("run_id", openIds)
        .order("run_id", { ascending: true })
        .range(from, to),
    "the open runs' Expenses steps",
  );
  const reserved = await readAllPages<{ expense_id: string; run_id: string }>(
    (from, to) =>
      db.from(RESERVATIONS_TABLE).select("expense_id,run_id").in("run_id", openIds).order("expense_id", { ascending: true }).range(from, to),
    "the trips the open payroll runs set aside",
  );
  const reservedRows = reserved.length
    ? await loadLateExpenseRowsById(reserved.map((row) => String(row.expense_id)), db)
    : [];
  const reservedRowById = new Map(reservedRows.map((row) => [String(row.id), row]));
  const carryOn = await getCarryLateExpensesSetting(db);
  const floor = periodIndex(LATE_EXPENSE_CARRY_FLOOR);

  const hits: Array<{ run: { id: string; month: number; year: number; phase: RunPhase }; hrIds: string[] }> = [];
  for (const run of open) {
    const runIndex = periodIndex({ month: Number(run.month), year: Number(run.year) });
    const people = new Set<string>();
    const state = states.find((entry) => String(entry.run_id) === String(run.id));
    const shown = parseLateExpensesShown(state?.summary);
    for (const trip of shown?.trips ?? []) if (wanted.has(trip.tripId)) people.add(trip.hrId || trip.compact);
    // What a confirmed step showed is the record; the switch-wide reading is only for a step without one.
    const confirmedRecord = Boolean(shown) && state?.status === "confirmed";
    for (const row of reserved) {
      if (String(row.run_id) !== String(run.id)) continue;
      const trip = reservedRowById.get(String(row.expense_id));
      if (trip && wanted.has(text(trip.trip_id)) && text(trip.hr_id)) people.add(text(trip.hr_id));
    }
    if (carryOn && !confirmedRecord) {
      for (const trip of refs) {
        const hrId = text(trip.hrId);
        if (!hrId || !Number.isInteger(Number(trip.month)) || !Number.isInteger(Number(trip.year))) continue;
        const index = periodIndex({ month: Number(trip.month), year: Number(trip.year) });
        if (index >= floor && index < runIndex && publishedPeriods.has(index)) people.add(hrId);
      }
    }
    if (people.size > 0) {
      hits.push({ run: { id: String(run.id), month: Number(run.month), year: Number(run.year), phase: run.phase }, hrIds: [...people] });
    }
  }
  return hits;
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
      duplicateOf: trip.duplicateOf,
      needsChecking: trip.needsChecking,
    })),
  };
}
