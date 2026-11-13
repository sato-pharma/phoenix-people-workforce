import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { AccessContext } from "../src/lib/auth/permissions.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import {
  expenseDecisionsThatChanged,
  resyncCarriedLateTrips,
} from "../src/lib/automated-payroll/expense-resync.ts";
import {
  assertLateExpensesNotCarriedElsewhere,
  assertLateExpensesShownMatchesSwitch,
  assertLateExpensesUnchanged,
  describeLateExpensePartialCoverage,
  findOpenRunsShowingLateTrips,
  flagLateExpenseDuplicates,
  getCarryLateExpensesSetting,
  LATE_EXPENSE_CARRY_FLOOR,
  lateExpensesAlreadyCarried,
  lateExpensesAtPublish,
  lateExpensesPaidAtPublish,
  lateExpensesShownFrom,
  loadLateApprovedExpenses,
  parseLateExpensesCarried,
  parseLateExpensesShown,
  planLateApprovedExpenses,
  planLateExpenseCoverage,
  releaseLateExpenseReservations,
  reserveLateExpenses,
  setCarryLateExpenses,
  type LateExpenseDb,
  type LateExpenseRow,
  type PublishedRunForLateExpenses,
} from "../src/lib/automated-payroll/late-expenses.ts";
import {
  buildExpenseStepRows,
  mergeCarriedLateTrips,
  type PayoutExpenseTrip,
  type PopulationMember,
} from "../src/lib/automated-payroll/recommend.ts";
import type { DraftRow } from "../src/lib/automated-payroll/types.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * TRIPS APPROVED AFTER THEIR PAYOUT MONTH WAS PAID (REC-029 / F-PAY-012).
 *
 * The Expenses step reads trips by their own payout month, so a trip approved after that month's run
 * was published was read by no run and paid nobody. The owner chose "Switch, starts OFF": OFF lists
 * such trips only; ON carries them into the next open run's Expenses step. This file pins:
 *   1. the plan — floor September 2026, held people out, already-carried (paid OR held) out, stamped /
 *      pending / rejected out, reserved by another month's run out, likely duplicates flagged;
 *   2. every read FAILS CLOSED — a failed read throws, never an empty list;
 *   3. the switch is refused while a run is in Part 2 or ready, reopens every open run's Expenses step
 *      first, and never claims "not changed" when it was;
 *   4. OFF leaves the Expenses step rows exactly as they were;
 *   5. Part 2 confirm refuses a moved switch, a changed trip and a part-paying figure, records only what
 *      the figure covers, and reserves it (one run per trip);
 *   6. publish re-reads the trips, records held people's trips as carried, and never pays a trip another
 *      published run already carried;
 *   7. a changed carried trip reopens the Expenses step of the run carrying it.
 * Nothing here can reach a database: every read goes through the fake below.
 */

// ---- A fake client: applies eq / in / is filters and range, keeps writes, and can fail on purpose ----

type TableSpec = {
  rows?: Array<Record<string, unknown>>;
  error?: { message: string };
  /** Every write to this table fails with this. */
  writeError?: { message: string; code?: string };
  /** One result per write, in order; `null` succeeds. Overrides `writeError` while it lasts. */
  writeResults?: Array<{ message: string; code?: string } | null>;
  /** Inserting a row whose value in this column already exists fails like a unique violation. */
  primaryKey?: string;
};

type Write = { table: string; op: string; payload: unknown };

function fakeDb(tables: Record<string, TableSpec>, writes: Write[] = []): LateExpenseDb {
  return {
    from(table: string) {
      const spec = (tables[table] ??= { rows: [] });
      spec.rows ??= [];
      const filters: Array<(row: Record<string, unknown>) => boolean> = [];
      let range: [number, number] | null = null;
      let single = false;
      let op: "select" | "insert" | "upsert" | "delete" = "select";
      let payload: unknown = null;
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          filters.push((row) => row[column] === value);
          return builder;
        },
        in: (column: string, values: unknown[]) => {
          filters.push((row) => values.includes(row[column]));
          return builder;
        },
        is: (column: string, value: unknown) => {
          filters.push((row) => (row[column] ?? null) === value);
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        range: (from: number, to: number) => {
          range = [from, to];
          return builder;
        },
        maybeSingle: () => {
          single = true;
          return builder;
        },
        insert: (value: unknown) => {
          op = "insert";
          payload = value;
          return builder;
        },
        upsert: (value: unknown) => {
          op = "upsert";
          payload = value;
          return builder;
        },
        delete: () => {
          op = "delete";
          return builder;
        },
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
          try {
            if (op !== "select") {
              writes.push({ table, op, payload });
              const scripted = spec.writeResults?.length ? spec.writeResults.shift() : undefined;
              const failure = scripted !== undefined ? scripted : spec.writeError ?? null;
              if (failure) return Promise.resolve(resolve({ data: null, error: failure }));
              if (op === "delete") {
                spec.rows = spec.rows!.filter((row) => !filters.every((filter) => filter(row)));
              } else if (op === "insert") {
                const added = (Array.isArray(payload) ? payload : [payload]) as Array<Record<string, unknown>>;
                const key = spec.primaryKey;
                if (key && added.some((row) => spec.rows!.some((existing) => existing[key] === row[key]))) {
                  return Promise.resolve(resolve({ data: null, error: { message: "duplicate key", code: "23505" } }));
                }
                spec.rows!.push(...added);
              }
              return Promise.resolve(resolve({ data: null, error: null }));
            }
            if (spec.error) return Promise.resolve(resolve({ data: null, error: spec.error }));
            let rows = spec.rows!.filter((row) => filters.every((filter) => filter(row)));
            if (range) rows = rows.slice(range[0], range[1] + 1);
            return Promise.resolve(resolve({ data: single ? (rows[0] ?? null) : rows, error: null }));
          } catch (error) {
            return Promise.resolve(reject(error));
          }
        },
      };
      return builder;
    },
  } as unknown as LateExpenseDb;
}

function expenseRow(overrides: Partial<LateExpenseRow> & { id: string }): LateExpenseRow {
  return {
    hr_id: "B-12",
    payout_month: 9,
    payout_year: 2026,
    trip_id: `T-${overrides.id}`,
    expense_date: "2026-09-10",
    to_date: "2026-09-10",
    from_location: "Cairo",
    to_location: "Tanta",
    location: null,
    trip_type: "traveling",
    transportation_type: "Car",
    km: 90,
    travel_cost: 300,
    meeting_amount: 0,
    allowance: 100,
    other_amount: 0,
    total: 400,
    approved_amount: null,
    hr_approved: true,
    hr_status: "",
    status: "Approved",
    description: "",
    specialist: "Dina Hamdy",
    imported_payroll_batch_id: null,
    imported_to_payroll_at: null,
    ...overrides,
  };
}

const NOVEMBER = { month: 11, year: 2026 };

function member(hrId: string, fullName: string): PopulationMember {
  return {
    employee: { hrId, fullName, hireDate: "2024-01-01" } as unknown as EmployeeDirectoryRow,
    compact: hrId.toLowerCase().replace(/[^a-z0-9]+/g, ""),
    lifecycle: "regular",
    lastWorkingDate: null,
    noticeLastWorkingDate: null,
  };
}

function trip(overrides: Partial<PayoutExpenseTrip> = {}): PayoutExpenseTrip {
  return {
    tripId: "T-own",
    expenseDate: "2026-11-05",
    toDate: "2026-11-05",
    fromLocation: "Cairo",
    toLocation: "Alexandria",
    tripType: "traveling",
    transportationType: "Car",
    km: 220,
    travelCost: 400,
    meetingAmount: 0,
    allowance: 100,
    otherAmount: 0,
    total: 500,
    approvedAmount: null,
    hrApproved: true,
    hrStatus: "",
    description: "",
    ...overrides,
  };
}

const superAdmin = { hrId: "b10", role: "Super Admin", scope: "all", source: "session" } as unknown as AccessContext;
const NAMES = new Map([["b12", "Dina Hamdy Fadel"], ["b77", "Omar Gawish"]]);

async function rejects(work: () => Promise<unknown>, pattern: RegExp, message: string): Promise<void> {
  let returned: unknown = "(nothing thrown)";
  try {
    returned = await work();
  } catch (error) {
    assert.match(error instanceof Error ? error.message : String(error), pattern, message);
    return;
  }
  assert.fail(`${message} — it returned ${JSON.stringify(returned)} instead of throwing`);
}

function bodyOf(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `could not find the end of ${signature}`);
  return source.slice(start, end);
}

export async function runAutomatedPayrollLateExpensesTests() {
  // ---- 1. The plan ---------------------------------------------------------------------------
  assert.deepEqual({ ...LATE_EXPENSE_CARRY_FLOOR }, { month: 9, year: 2026 }, "the floor is payout September 2026");

  const publishedRuns: PublishedRunForLateExpenses[] = [
    { runId: "run-aug", month: 8, year: 2026, heldCompacts: [], carriedTripIds: [] },
    { runId: "run-sep", month: 9, year: 2026, heldCompacts: ["b50"], carriedTripIds: [] },
    { runId: "run-oct", month: 10, year: 2026, heldCompacts: [], carriedTripIds: ["sep-carried"] },
  ];
  const rows: LateExpenseRow[] = [
    expenseRow({ id: "sep-ok" }),
    expenseRow({ id: "sep-hr-reduced", approved_amount: 250, expense_date: "2026-09-12", to_date: "2026-09-12" }),
    expenseRow({ id: "aug-below-floor", payout_month: 8, expense_date: "2026-08-10" }),
    expenseRow({ id: "sep-held", hr_id: "B-50" }),
    expenseRow({ id: "sep-carried" }),
    expenseRow({ id: "sep-stamped", imported_payroll_batch_id: "batch-9", expense_date: "2026-09-02" }),
    expenseRow({ id: "sep-stamped-at", imported_to_payroll_at: "2026-10-01T00:00:00Z", expense_date: "2026-09-03" }),
    expenseRow({ id: "sep-pending", hr_approved: false, status: "Pending" }),
    expenseRow({ id: "sep-rejected", hr_approved: false, status: "Rejected" }),
    expenseRow({ id: "oct-ok", payout_month: 10, hr_id: "B-77", specialist: "Omar" }),
    expenseRow({ id: "nov-current", payout_month: 11, expense_date: "2026-11-02", to_date: "2026-11-02" }),
    expenseRow({ id: "jun-no-run", payout_month: 12, payout_year: 2025 }),
  ];
  const listed = planLateApprovedExpenses({ currentPeriod: NOVEMBER, publishedRuns, rows });
  assert.deepEqual(
    listed.map((entry) => entry.id),
    ["sep-ok", "sep-hr-reduced", "oct-ok"],
    "HEADLINE: only approved, unstamped trips of a published month from September 2026, strictly before the run, not held and not already carried, are listed",
  );
  assert.equal(listed[1].amount, 250, "HR's reduced figure is the amount owed");
  assert.equal(listed[0].publishedRunId, "run-sep");
  assert.equal(listed[0].payoutLabel.includes("September"), true);
  assert.deepEqual(
    planLateApprovedExpenses({ currentPeriod: { month: 10, year: 2026 }, publishedRuns, rows }).map((entry) => entry.id),
    ["sep-ok", "sep-hr-reduced"],
    "a run of October 2026 never lists October's own trips — strictly earlier periods only",
  );
  assert.deepEqual(
    planLateApprovedExpenses({ currentPeriod: { month: 9, year: 2026 }, publishedRuns, rows }),
    [],
    "a run of the floor month itself lists nothing",
  );
  assert.ok(
    !planLateApprovedExpenses({ currentPeriod: NOVEMBER, publishedRuns: [], rows }).length,
    "a payout month with no published run is never listed",
  );

  // LIKELY DUPLICATES (fix 7): a copy of a trip already paid in its own month, or already in the carrying
  // run, is flagged and never proposed.
  const paidTwin = expenseRow({ id: "sep-paid-twin", imported_payroll_batch_id: "batch-9" });
  const flagged = flagLateExpenseDuplicates(listed, [...rows, paidTwin], NOVEMBER);
  assert.match(
    String(flagged.find((entry) => entry.id === "sep-ok")?.duplicateOf),
    /Likely a duplicate of a trip already paid in September 2026, T-sep-paid-twin/,
    "HEADLINE: a late trip identical to one already paid in its payout month is flagged as a likely duplicate",
  );
  assert.equal(flagged.find((entry) => entry.id === "sep-hr-reduced")?.duplicateOf, null, "a different day is not a duplicate");
  const inRunTwin = expenseRow({ id: "nov-twin", payout_month: 11, hr_id: "B-77", specialist: "Omar" });
  assert.match(
    String(flagLateExpenseDuplicates(listed, [...rows, inRunTwin], NOVEMBER).find((entry) => entry.id === "oct-ok")?.duplicateOf),
    /already in this run's own month \(November 2026\)/,
    "and so is one identical to a trip already in the carrying run",
  );
  assert.equal(
    flagLateExpenseDuplicates(listed, [...rows, expenseRow({ id: "pending-twin", hr_approved: false, status: "Pending" })], NOVEMBER)
      .find((entry) => entry.id === "sep-ok")?.duplicateOf,
    null,
    "an unapproved copy is not something already paid",
  );
  const own = new Map<string, PayoutExpenseTrip[]>([["b12", [trip()]]]);
  assert.deepEqual(
    mergeCarriedLateTrips(own, flagged.filter((entry) => entry.compact === "b12"), new Set(["b12"])).get("b12")?.map((entry) => entry.carriedFrom?.rowId ?? "own"),
    ["own", "sep-hr-reduced"],
    "HEADLINE: a flagged duplicate is never proposed in the Expenses step",
  );

  // ---- 2. The reads fail closed ----------------------------------------------------------------
  const publishedDetail = (held: string[], carried: string[] = [], carriedHeld: string[] = []) => ({
    held: held.map((hrId) => ({ hrId, name: hrId })),
    heldExcluded: held.length,
    lateExpensesCarried: carried.map((id) => ({ id, compact: "b12", payoutMonth: 9, payoutYear: 2026, amount: 400 })),
    lateExpensesCarriedHeld: carriedHeld.map((id) => ({ id, compact: "b12", payoutMonth: 9, payoutYear: 2026, amount: 250 })),
  });
  const healthy = (): Record<string, TableSpec> => ({
    automated_payroll_runs: {
      rows: [
        { id: "run-aug", month: 8, year: 2026, phase: "published" },
        { id: "run-sep", month: 9, year: 2026, phase: "published" },
        { id: "run-oct", month: 10, year: 2026, phase: "published" },
      ],
    },
    automated_payroll_audit: {
      rows: [
        { run_id: "run-sep", action: "published", created_at: "2026-10-05T10:00:00Z", detail: publishedDetail(["B-50"]) },
        { run_id: "run-oct", action: "published", created_at: "2026-11-05T10:00:00Z", detail: publishedDetail([], ["sep-carried"]) },
      ],
    },
    outstation_expenses: { rows: rows as unknown as Array<Record<string, unknown>> },
    employees: { rows: [{ hr_id: "B-12", full_name: "Dina Hamdy Fadel" }, { hr_id: "B-77", full_name: "Omar Gawish" }] },
    automated_payroll_carried_expenses: { rows: [], primaryKey: "expense_id" },
  });
  const loaded = await loadLateApprovedExpenses(NOVEMBER, fakeDb(healthy()));
  assert.deepEqual(loaded.map((entry) => entry.id), ["sep-ok", "sep-hr-reduced", "oct-ok"], "the loader applies the plan to what it read");
  assert.deepEqual(
    [...new Set(loaded.map((entry) => entry.name))],
    ["Dina Hamdy Fadel", "Omar Gawish"],
    "the list carries names from the employee record, never codes",
  );

  // HELD IN THE CARRYING RUN (fix 1): the October run held Dina, so her carried trip sits in her held
  // balance. It is carried, and must never be listed again.
  {
    const tables = healthy();
    tables.automated_payroll_audit.rows![1] = {
      run_id: "run-oct",
      action: "published",
      created_at: "2026-11-05T10:00:00Z",
      detail: publishedDetail(["B-12"], ["sep-carried"], ["sep-hr-reduced"]),
    };
    assert.deepEqual(
      (await loadLateApprovedExpenses(NOVEMBER, fakeDb(tables))).map((entry) => entry.id),
      ["sep-ok", "oct-ok"],
      "HEADLINE: a trip carried for someone HELD in the carrying run counts as carried — never listed again for Held Salary Release to pay twice",
    );
  }

  // RESERVED BY ANOTHER MONTH'S RUN (fix 4): left off this run's list; its own month's reservation is not.
  {
    const tables = healthy();
    tables.automated_payroll_runs.rows!.push({ id: "run-dec", month: 12, year: 2026, phase: "ready" });
    tables.automated_payroll_runs.rows!.push({ id: "run-nov", month: 11, year: 2026, phase: "part2" });
    tables.automated_payroll_carried_expenses.rows = [
      { expense_id: "sep-ok", run_id: "run-dec" },
      { expense_id: "oct-ok", run_id: "run-nov" },
    ];
    assert.deepEqual(
      (await loadLateApprovedExpenses(NOVEMBER, fakeDb(tables))).map((entry) => entry.id),
      ["sep-hr-reduced", "oct-ok"],
      "HEADLINE: a trip another month's run reserved at its Part 2 confirm is not offered to this run",
    );
  }

  await rejects(
    () => loadLateApprovedExpenses(NOVEMBER, fakeDb({ ...healthy(), outstation_expenses: { error: { message: "boom" } } })),
    /^Conflict: .*could not be read/,
    "HEADLINE: a failed expense read THROWS — never an empty list that reads as nothing owed",
  );
  await rejects(
    () => loadLateApprovedExpenses(NOVEMBER, fakeDb({ ...healthy(), automated_payroll_runs: { error: { message: "boom" } } })),
    /^Conflict:/,
    "a failed read of the published runs throws",
  );
  await rejects(
    () => loadLateApprovedExpenses(NOVEMBER, fakeDb({ ...healthy(), automated_payroll_audit: { rows: [] } })),
    /^Conflict: .*record of who was held is missing/,
    "a published run with no record of who was held throws — a held person's trip would otherwise be listed",
  );
  await rejects(
    () => loadLateApprovedExpenses(NOVEMBER, fakeDb({ ...healthy(), employees: { error: { message: "boom" } } })),
    /^Conflict:/,
    "a failed name read throws rather than showing codes",
  );
  await rejects(
    () => loadLateApprovedExpenses(NOVEMBER, fakeDb({ ...healthy(), automated_payroll_carried_expenses: { error: { message: "boom" } } })),
    /^Conflict:/,
    "a failed read of the reservations throws rather than offering a trip another run is paying",
  );

  // ---- 3. The switch -------------------------------------------------------------------------------
  assert.equal(await getCarryLateExpensesSetting(fakeDb({ automated_payroll_settings: { rows: [] } })), false, "a missing row is OFF");
  assert.equal(
    await getCarryLateExpensesSetting(fakeDb({ automated_payroll_settings: { rows: [{ id: 1, carry_late_expenses: true }] } })),
    true,
  );
  await rejects(
    () => getCarryLateExpensesSetting(fakeDb({ automated_payroll_settings: { error: { message: "relation does not exist" } } })),
    /^Conflict: the payroll switch/,
    "HEADLINE: a failed read of the switch THROWS — it is never read as OFF",
  );

  for (const phase of ["part2", "ready"]) {
    const writes: Write[] = [];
    const reopened: string[] = [];
    await rejects(
      () =>
        setCarryLateExpenses(
          superAdmin,
          true,
          fakeDb(
            {
              automated_payroll_runs: { rows: [{ id: "run-nov", month: 11, year: 2026, phase }] },
              automated_payroll_settings: { rows: [{ id: 1, carry_late_expenses: false }] },
            },
            writes,
          ),
          { reopenExpensesStep: async (runId) => reopened.push(runId) },
        ),
      /^Conflict: the switch cannot change while a payroll run is in Part 2 or confirmed/,
      `HEADLINE: the switch is refused while a run is ${phase}`,
    );
    assert.equal(writes.length + reopened.length, 0, `nothing is written while a run is ${phase}`);
  }
  {
    const writes: Write[] = [];
    const steps: string[] = [];
    const result = await setCarryLateExpenses(
      superAdmin,
      true,
      fakeDb(
        {
          automated_payroll_runs: {
            rows: [
              { id: "run-nov", month: 11, year: 2026, phase: "part1" },
              { id: "run-oct", month: 10, year: 2026, phase: "published" },
            ],
          },
          automated_payroll_settings: { rows: [{ id: 1, carry_late_expenses: false }] },
        },
        writes,
      ),
      {
        reopenExpensesStep: async (runId) => {
          steps.push(`reopen ${runId} (writes so far: ${writes.length})`);
        },
      },
    );
    assert.deepEqual(result, { carryLateExpenses: true }, "a run in Part 1 does not block the switch");
    assert.deepEqual(
      steps,
      ["reopen run-nov (writes so far: 0)"],
      "HEADLINE: flipping the switch clears and reopens the Expenses step of every open run, BEFORE the switch moves — never a published one",
    );
    assert.deepEqual(writes.map((write) => `${write.op} ${write.table}`), ["upsert automated_payroll_settings", "insert automated_payroll_audit"]);
    assert.deepEqual(
      (writes[1].payload as { detail: unknown }).detail,
      { from: false, to: true, expensesStepsReopened: ["run-nov"] },
      "the change is audited from → to, with the runs reopened",
    );
  }
  {
    const writes: Write[] = [];
    await rejects(
      () =>
        setCarryLateExpenses(
          superAdmin,
          true,
          fakeDb(
            {
              automated_payroll_runs: { rows: [] },
              automated_payroll_settings: { rows: [{ id: 1, carry_late_expenses: false }] },
              automated_payroll_audit: { writeError: { message: "audit down" } },
            },
            writes,
          ),
        ),
      /could not record the change.*so it was not changed/i,
      "the audit row is required",
    );
    assert.equal((writes.at(-1)?.payload as { carry_late_expenses: boolean }).carry_late_expenses, false, "and the old value is put back");
  }
  await rejects(
    () =>
      setCarryLateExpenses(
        superAdmin,
        true,
        fakeDb({
          automated_payroll_runs: { rows: [] },
          automated_payroll_settings: { rows: [{ id: 1, carry_late_expenses: false }], writeResults: [null, { message: "settings down" }] },
          automated_payroll_audit: { writeError: { message: "audit down" } },
        }),
      ),
    /^Conflict: the payroll switch WAS changed to ON, but no record of the change could be written/,
    "HEADLINE: when the record AND the put-back both fail, the error says the switch WAS changed — never that it was not",
  );
  await rejects(
    () => setCarryLateExpenses({ ...superAdmin, role: "CEO" } as AccessContext, true, fakeDb({})),
    /^Forbidden:/,
    "only the payroll HR actor may flip it",
  );

  // ---- 4. OFF leaves the Expenses step exactly as it was ------------------------------------------
  const dina = member("B-12", "Dina Hamdy Fadel");
  const members = [dina, member("B-77", "Omar Gawish")];
  const drafts = new Map<string, DraftRow>();
  const before = buildExpenseStepRows(members, own, drafts);
  assert.deepEqual(
    buildExpenseStepRows(members, mergeCarriedLateTrips(own, [], new Set(["b12", "b77"])), drafts),
    before,
    "HEADLINE: with nothing carried (the switch OFF) the Expenses step rows are identical",
  );
  const stranger = loaded.find((entry) => entry.id === "oct-ok");
  assert.ok(stranger);
  assert.deepEqual(
    buildExpenseStepRows([dina], mergeCarriedLateTrips(own, [stranger], new Set(["b12"])), drafts),
    buildExpenseStepRows([dina], own, drafts),
    "a late trip of someone outside the run is never proposed — it stays on the list",
  );
  const recommendSource = stripComments(readFileSync("src/lib/automated-payroll/recommend.ts", "utf8"));
  const loadTrips = bodyOf(recommendSource, "export async function loadExpenseStepTrips(");
  assert.match(loadTrips, /if \(!carryOn\) return \{ carryOn, tripsByCompact: own \};/, "OFF returns the month's own trips untouched");
  assert.ok(
    loadTrips.indexOf("getCarryLateExpensesSetting()") < loadTrips.indexOf("loadLateApprovedExpenses("),
    "the late trips are read only after the switch says ON",
  );
  assert.match(bodyOf(recommendSource, "async function recommendExpenses("), /loadExpenseStepTrips\(period, memberCompacts\)/);

  // ON: the carried trips count, and say where they came from.
  const carriedSep = loaded.filter((entry) => entry.compact === "b12");
  const onRows = buildExpenseStepRows(members, mergeCarriedLateTrips(own, carriedSep, new Set(["b12", "b77"])), drafts);
  assert.equal(onRows[0].recommended.expenses, 500 + 400 + 250, "ON: the carried trips count in the proposed figure");
  assert.match(String(onRows[0].details?.[1].Dates), /carried from September 2026/, "and each is labelled with its payout month");
  assert.equal(onRows[0].details?.[0].Dates, "2026-11-05", "the month's own trip reads as before");

  // ---- 5. Part 2 confirm --------------------------------------------------------------------------
  const merged = mergeCarriedLateTrips(own, carriedSep, new Set(["b12"]));

  // What the confirmed Expenses step showed, and the switch it was confirmed under (fixes 2 and 5).
  const shown = lateExpensesShownFrom(true, merged);
  assert.deepEqual(
    shown.trips.map((entry) => [entry.rowId, entry.tripId, entry.amount, entry.hrId]),
    [["sep-ok", "T-sep-ok", 400, "B-12"], ["sep-hr-reduced", "T-sep-hr-reduced", 250, "B-12"]],
    "the confirmed step keeps each carried trip's row, trip id, amount and person",
  );
  assert.deepEqual(parseLateExpensesShown({ lateExpensesShown: shown }), shown, "and reads it back");
  assert.equal(parseLateExpensesShown({}), null, "a step confirmed before the record existed has none");
  assertLateExpensesShownMatchesSwitch(true, shown);
  assertLateExpensesShownMatchesSwitch(false, null);
  assert.throws(
    () => assertLateExpensesShownMatchesSwitch(true, lateExpensesShownFrom(false, own)),
    /^Error: Conflict: the switch for expenses approved after their month was paid is ON now, but the Expenses step was confirmed while it was OFF/,
    "HEADLINE: Part 2 confirm refuses when the switch moved since the Expenses step was confirmed",
  );
  assert.throws(() => assertLateExpensesShownMatchesSwitch(true, null), /confirmed while it was OFF/, "a step with no record reads as confirmed OFF");

  // A carried trip whose approval changed after the step was confirmed (fix 2).
  const expected = shown.trips.map((entry) => ({ ...entry, id: entry.rowId }));
  const live = (overrides: Record<string, Partial<LateExpenseRow>> = {}) =>
    fakeDb({
      outstation_expenses: {
        rows: rows.map((row) => ({ ...row, ...(overrides[row.id] ?? {}) })) as unknown as Array<Record<string, unknown>>,
      },
    });
  assert.equal((await assertLateExpensesUnchanged(expected, NAMES, "confirm", live())).length, 2, "unchanged trips pass");
  await rejects(
    () => assertLateExpensesUnchanged(expected, NAMES, "confirm", live({ "sep-hr-reduced": { approved_amount: 150 } })),
    /^Conflict: Dina Hamdy Fadel's trip of 2026-09-12 \(carried from September 2026\) now pays 150\.00, not 250\.00 since the Expenses step was confirmed\. Nothing was confirmed\. Reload the Expenses step/,
    "HEADLINE: a carried trip cut after the Expenses step was confirmed refuses Part 2 confirm, naming the person and trip",
  );
  await rejects(
    () => assertLateExpensesUnchanged(expected, NAMES, "confirm", live({ "sep-ok": { hr_approved: false, status: "Rejected" } })),
    /Dina Hamdy Fadel's trip of 2026-09-10 \(carried from September 2026\) is no longer approved/,
    "HEADLINE: a carried trip rejected after the Expenses step was confirmed refuses Part 2 confirm",
  );
  await rejects(
    () => assertLateExpensesUnchanged(expected, NAMES, "publish", live({ "sep-ok": { total: 900 } })),
    /now pays 900\.00, not 400\.00 .*Nothing was published\. Reopen Part 2/,
    "a raised trip refuses publish too",
  );
  await rejects(
    () => assertLateExpensesUnchanged(expected, NAMES, "confirm", live({ "sep-ok": { imported_payroll_batch_id: "batch-x" } })),
    /was already marked paid/,
    "a trip paid elsewhere in the meantime refuses",
  );
  await rejects(
    () => assertLateExpensesUnchanged(expected, NAMES, "confirm", fakeDb({ outstation_expenses: { rows: [] } })),
    /no longer exists/,
    "a deleted trip refuses",
  );

  // Coverage.
  const covered = planLateExpenseCoverage({ tripsByCompact: merged, expensesByCompact: new Map([["b12", 1150]]) });
  assert.deepEqual(
    covered.carried.map((entry) => [entry.id, entry.amount, entry.payoutMonth, entry.expenseDate]),
    [["sep-ok", 400, 9, "2026-09-10"], ["sep-hr-reduced", 250, 9, "2026-09-12"]],
    "HEADLINE: a figure that covers the own month (500) plus the carried trips (650) records them",
  );
  assert.equal(covered.notCovered.length + covered.partial.length, 0);
  assert.equal(
    planLateExpenseCoverage({ tripsByCompact: merged, expensesByCompact: new Map([["b12", 1149.6]]) }).carried.length,
    2,
    "half a pound of rounding is tolerated",
  );
  const under = planLateExpenseCoverage({ tripsByCompact: merged, expensesByCompact: new Map([["b12", 500]]) });
  assert.deepEqual(under.carried, [], "HEADLINE: an under-covering figure records nothing as carried");
  assert.deepEqual(
    under.notCovered.map((entry) => [entry.id, entry.paid, entry.needed, entry.reason]),
    [["sep-ok", 500, 1150, "not_covered"], ["sep-hr-reduced", 500, 1150, "not_covered"]],
    "and names the trips left on the list",
  );
  const part = planLateExpenseCoverage({ tripsByCompact: merged, expensesByCompact: new Map([["b12", 900]]) });
  assert.deepEqual(
    part.partial.map((entry) => [entry.compact, entry.paid, entry.own, entry.needed, entry.trips.map((one) => one.id)]),
    [["b12", 900, 500, 1150, ["sep-ok", "sep-hr-reduced"]]],
    "HEADLINE: a figure above the own trips but short of own plus carried is a PARTIAL payment, never silently 'not covered'",
  );
  assert.deepEqual([part.carried, part.notCovered], [[], []], "and records nothing either way");
  assert.match(
    describeLateExpensePartialCoverage(part.partial, NAMES),
    /^Conflict: Dina Hamdy Fadel's Expenses figure 900\.00 is above their own trips this month \(500\.00\) but short of those plus the carried trip of 2026-09-10 \(carried from September 2026\), trip of 2026-09-12 \(carried from September 2026\) \(1,150\.00\)\. .*either pay every carried trip in full or take them out/,
    "the refusal names the person, their figure and each carried trip",
  );
  assert.equal(
    planLateExpenseCoverage({ tripsByCompact: merged, expensesByCompact: new Map([["b12", 500.4]]) }).partial.length,
    0,
    "a figure within rounding of the own trips takes the carried trips out — not partial",
  );
  assert.deepEqual(
    planLateExpenseCoverage({ tripsByCompact: merged, expensesByCompact: new Map() }).carried,
    [],
    "no confirmed figure at all records nothing",
  );
  const duplicate = mergeCarriedLateTrips(
    new Map([["b12", [trip({ tripId: "T-dup", expenseDate: "2026-09-10", toLocation: "Tanta", total: 400 })]]]),
    [carriedSep[0]],
    new Set(["b12"]),
  );
  const dupPlan = planLateExpenseCoverage({ tripsByCompact: duplicate, expensesByCompact: new Map([["b12", 800]]) });
  assert.deepEqual(dupPlan.carried, [], "a carried copy of a trip already in the run is never recorded as paid");
  assert.equal(dupPlan.notCovered[0]?.reason, "duplicate_held");

  // One run per trip (fix 4).
  {
    const tables: Record<string, TableSpec> = {
      automated_payroll_carried_expenses: {
        rows: [{ expense_id: "sep-ok", run_id: "run-dec" }, { expense_id: "stale", run_id: "run-nov" }],
        primaryKey: "expense_id",
      },
      automated_payroll_runs: { rows: [{ id: "run-dec", month: 12, year: 2026 }] },
    };
    await rejects(
      () => reserveLateExpenses("run-nov", covered.carried, NAMES, fakeDb(tables)),
      /^Conflict: Dina Hamdy Fadel's trip of 2026-09-10 \(carried from September 2026\) is already being paid by the December 2026 payroll run\. Nothing was confirmed/,
      "HEADLINE: a trip another run reserved at its Part 2 confirm refuses this run's confirm, naming the trip and that run's month",
    );
    tables.automated_payroll_carried_expenses.rows = [{ expense_id: "stale", run_id: "run-nov" }];
    await reserveLateExpenses("run-nov", covered.carried, NAMES, fakeDb(tables));
    assert.deepEqual(
      tables.automated_payroll_carried_expenses.rows.map((row) => `${row.expense_id}@${row.run_id}`),
      ["sep-ok@run-nov", "sep-hr-reduced@run-nov"],
      "a confirm replaces its own earlier reservations with exactly what it records",
    );
    await releaseLateExpenseReservations("run-nov", fakeDb(tables));
    assert.deepEqual(tables.automated_payroll_carried_expenses.rows, [], "a reopen or cancel releases them");
    await rejects(
      () => releaseLateExpenseReservations("run-nov", fakeDb({ automated_payroll_carried_expenses: { writeError: { message: "down" } } })),
      /^Conflict: the late-approved trips this run had set aside could not be released/,
      "a failed release refuses the reopen rather than leaving the trips hidden",
    );
    await rejects(
      () =>
        reserveLateExpenses(
          "run-nov",
          covered.carried,
          NAMES,
          fakeDb({ automated_payroll_carried_expenses: { rows: [], writeResults: [null, { message: "boom" }] } }),
        ),
      /^Conflict: the carried outstation trips could not be reserved/,
      "a failed reservation refuses the confirm",
    );
  }

  const service = stripComments(readFileSync("src/lib/automated-payroll/run-service.ts", "utf8"));
  const confirm = bodyOf(service, "export async function confirmPart2(");
  const lateAt = confirm.indexOf("await lateExpenseCarryAtConfirm(run, rowsUnderClaim)");
  assert.ok(lateAt > confirm.indexOf("whileClaimed(runId, transition"), "the carried trips are decided under the confirm's claim");
  const stampAt = confirm.indexOf("action: PART2_TOTALS_STAMP_ACTION");
  assert.ok(lateAt > 0 && lateAt < stampAt, "before the required stamp is written");
  const stampCall = confirm.slice(stampAt, confirm.indexOf("});", stampAt));
  assert.match(stampCall, /\[LATE_EXPENSES_CARRIED_KEY\]: lateExpenses\.carried/, "the required stamp records them");
  const confirmedRow = confirm.slice(confirm.indexOf('action: "part2_confirmed"'));
  assert.match(confirmedRow, /\[LATE_EXPENSES_CARRIED_KEY\]: lateExpenses\.carried/, "and so does the newer part2_confirmed row publish may read");
  assert.match(confirmedRow, /\[LATE_EXPENSES_NOT_COVERED_KEY\]: lateExpenses\.notCovered/, "with the trips not covered");
  const atConfirm = bodyOf(service, "async function lateExpenseCarryAtConfirm(");
  const order = [
    "assertLateExpensesShownMatchesSwitch(carryOn, shown)",
    "if (!carryOn || !shown) {",
    "await assertLateExpensesUnchanged(",
    "planLateExpenseCoverage(",
    "if (coverage.partial.length > 0) throw new Error(describeLateExpensePartialCoverage(",
    "await reserveLateExpenses(run.id, coverage.carried, names)",
  ].map((needle) => atConfirm.indexOf(needle));
  assert.ok(order.every((at) => at > 0), "the switch, the re-read, the coverage, the partial refusal and the reservation are all at confirm");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "in that order: nothing is reserved before every check passed");
  assert.match(
    bodyOf(service, "export async function confirmStep("),
    /if \(stepKey === "p2_expenses"\) summary\[LATE_EXPENSES_SHOWN_KEY\] = await lateExpensesShownAtStepConfirm\(period, members\);/,
    "confirming the Expenses step records what it showed",
  );
  for (const signature of ["export async function unconfirmPart1(", "export async function unconfirmPart2(", "export async function cancelRun("]) {
    const body = bodyOf(service, signature);
    const claimed = body.indexOf("whileClaimed(runId, transition");
    const releaseAt = body.indexOf("await releaseLateExpenseReservations(runId);");
    assert.ok(claimed > 0 && releaseAt > claimed, `${signature} releases the run's reservations under its claim`);
    assert.ok(releaseAt < body.indexOf("updateRun(", claimed), `${signature} releases them before the phase moves`);
  }

  // ---- 6. Publish ------------------------------------------------------------------------------------
  const stamped = parseLateExpensesCarried({
    lateExpensesCarried: [
      { id: "paid", compact: "b12", payoutMonth: 9, payoutYear: 2026, amount: 400 },
      { id: "held", compact: "b50", payoutMonth: 9, payoutYear: 2026, amount: 300 },
      { id: "zero", compact: "b77", payoutMonth: 10, payoutYear: 2026, amount: 200 },
      { id: "gone", compact: "b99", payoutMonth: 10, payoutYear: 2026, amount: 100 },
    ],
  });
  const publishEntries = [
    { compact: "b12", onHold: false, row: { expenses: 900 } },
    { compact: "b50", onHold: true, row: { expenses: 300 } },
    { compact: "b77", onHold: false, row: { expenses: 0 } },
  ];
  const split = lateExpensesAtPublish(stamped, publishEntries);
  assert.deepEqual(
    [split.paid, split.held, split.dropped].map((list) => list.map((entry) => entry.id)),
    [["paid"], ["held"], ["zero", "gone"]],
    "HEADLINE: publish pays the published people's carried trips, keeps a HELD person's as carried in their held balance, and drops the rest",
  );
  assert.deepEqual(lateExpensesPaidAtPublish(stamped, publishEntries).map((entry) => entry.id), ["paid"]);
  assert.deepEqual(parseLateExpensesCarried({ heldExcluded: 0 }), [], "an older stamp carries nothing");
  assert.deepEqual(
    lateExpensesAlreadyCarried(["paid", "new"], [{ runId: "run-oct", month: 10, year: 2026, carriedTripIds: ["paid"] }]),
    [{ id: "paid", month: 10, year: 2026 }],
  );
  await rejects(
    () => assertLateExpensesNotCarriedElsewhere("run-nov", [{ id: "sep-carried", compact: "b12", payoutMonth: 9, payoutYear: 2026, amount: 400 }], fakeDb(healthy())),
    /^Conflict: 1 late-approved outstation trip .*already paid by the October 2026 run/,
    "HEADLINE: publish refuses a trip another published run already carried",
  );
  await assertLateExpensesNotCarriedElsewhere(
    "run-oct",
    [{ id: "sep-carried", compact: "b12", payoutMonth: 9, payoutYear: 2026, amount: 400 }],
    fakeDb(healthy()),
  );

  const lateSource = stripComments(readFileSync("src/lib/automated-payroll/late-expenses.ts", "utf8"));
  const publishable = bodyOf(lateSource, "export async function assertLateExpensesPublishable(");
  assert.match(publishable, /const carried = \[\.\.\.late\.paid, \.\.\.late\.held\];/, "publish checks the held people's carried trips too");
  assert.match(publishable, /await assertLateExpensesNotCarriedElsewhere\(runId, carried, client\);/);
  assert.match(publishable, /await assertLateExpensesUnchanged\(carried, names, "publish", client\);/, "HEADLINE: publish re-reads every carried trip");

  const publish = bodyOf(service, "export async function publishToPayslips(");
  assert.match(
    publish,
    /const lateAtPublish = lateExpensesAtPublish\(\(await readPart2ConfirmedStamp\(runId\)\)\.lateExpensesCarried, rows\);/,
    "publish reads the carried trips from the Part 2 stamp and splits them",
  );
  const claimAt = publish.indexOf("const published = await whileClaimed(runId, transition");
  const guardAt = publish.indexOf("await assertLateExpensesPublishable(runId, lateAtPublish, lateExpenseNames(rows))");
  assert.ok(claimAt > 0 && guardAt > claimAt, "the publish checks run under the publish claim");
  assert.ok(guardAt < publish.indexOf("await createSalaryBatch("), "before anything is written");
  assert.ok(guardAt < publish.indexOf("await markRunPublished("), "and before the phase write");
  const markCall = publish.slice(publish.indexOf("await markRunPublished("), publish.indexOf("{ transitionToken: transition }", publish.indexOf("await markRunPublished(")));
  assert.match(markCall, /\[LATE_EXPENSES_CARRIED_KEY\]: lateExpensesCarried/, "the carried list is written with the phase, atomically");
  assert.match(
    markCall,
    /\[LATE_EXPENSES_CARRIED_HELD_KEY\]: lateAtPublish\.held/,
    "HEADLINE: a held person's carried trips are written with the phase too, so they are never carried again",
  );
  assert.match(publish, /carried: lateExpensesCarried,/, "and the paid carried rows are stamped after publish");

  const stampSource = stripComments(readFileSync("src/lib/automated-payroll/expense-stamp.ts", "utf8"));
  const stampFn = bodyOf(stampSource, "export async function stampPaidExpenseTrips(");
  assert.match(stampFn, /const changed = new Set\(lateExpenseChanges\(carried, current\)/, "a carried row is re-read before it is marked");
  assert.match(stampFn, /if \(!row \|\| changed\.has\(entry\.id\)\) \{/, "and one that changed is not marked");
  assert.match(
    stampFn,
    /\.eq\("id", entry\.id\)\s*\.eq\("hr_approved", true\)\s*\.is\("imported_payroll_batch_id", null\)\s*\.is\("imported_to_payroll_at", null\)/,
    "the mark itself requires the row still approved and unmarked",
  );
  assert.match(stampFn, /update\.eq\("total", row\.total\)/, "at the amount it was read with");
  assert.match(stampFn, /update\.eq\("approved_amount", row\.approved_amount\)/);

  // ---- 7. A changed carried trip reaches the run carrying it ----------------------------------------
  const snap = (tripId: string, approvedAmount: number | null) => ({
    tripId,
    hrId: "B-12",
    total: 400,
    approvedAmount,
    hrApproved: true,
    status: "Approved",
    payoutMonth: 9,
    payoutYear: 2026,
  });
  assert.deepEqual(
    expenseDecisionsThatChanged([snap("T-sep-ok", null)], [snap("T-sep-ok", 300)]).tripIds,
    ["T-sep-ok"],
    "the resync target names the trips whose decision moved",
  );
  const openRuns = fakeDb({
    automated_payroll_runs: {
      rows: [
        { id: "run-nov", month: 11, year: 2026, phase: "part2" },
        { id: "run-oct", month: 10, year: 2026, phase: "published" },
      ],
    },
    automated_payroll_step_state: {
      rows: [
        { run_id: "run-nov", step_key: "p2_expenses", summary: { lateExpensesShown: shown } },
        { run_id: "run-oct", step_key: "p2_expenses", summary: { lateExpensesShown: shown } },
      ],
    },
  });
  assert.deepEqual(
    await findOpenRunsShowingLateTrips(["T-sep-ok"], openRuns),
    [{ run: { id: "run-nov", month: 11, year: 2026, phase: "part2" }, hrIds: ["B-12"] }],
    "HEADLINE: a changed carried trip finds the open run whose Expenses step showed it — its own payout month is published",
  );
  assert.deepEqual(await findOpenRunsShowingLateTrips(["T-other"], openRuns), [], "a trip no run carries finds none");
  const reopenedRuns: string[] = [];
  const outcomes = await resyncCarriedLateTrips(["T-sep-ok"], {
    findRuns: async () => [
      { run: { id: "run-nov", month: 11, year: 2026, phase: "part2" }, hrIds: ["B-12"] },
      { run: { id: "run-dec", month: 12, year: 2026, phase: "ready" }, hrIds: ["B-12"] },
    ],
    reopen: async (runId, hrIds) => {
      reopenedRuns.push(`${runId}:${[...(hrIds as string[])].join(",")}`);
      return { clearedHrIds: ["B-12"], reopenedStep: true };
    },
  });
  assert.deepEqual(reopenedRuns, ["run-nov:B-12"], "HEADLINE: the carrying run's Expenses figure is cleared and its step reopened");
  assert.deepEqual(
    outcomes.map((outcome) => `${outcome.action}:${outcome.month}`),
    ["resync:11", "skip:12"],
    "a run already confirmed at Part 2 is reported as a skip (its publish re-reads the trip and refuses)",
  );
  const resyncSource = stripComments(readFileSync("src/lib/automated-payroll/expense-resync.ts", "utf8"));
  assert.match(
    bodyOf(resyncSource, "export async function resyncPayrollExpenseStep("),
    /await resyncCarriedLateTrips\(target\.tripIds \?\? \[\]\)/,
    "every expense resync also reaches the runs carrying the trip",
  );
}
