import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { AccessContext } from "../src/lib/auth/permissions.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import {
  assertLateExpensesNotCarriedElsewhere,
  getCarryLateExpensesSetting,
  LATE_EXPENSE_CARRY_FLOOR,
  lateExpensesAlreadyCarried,
  lateExpensesPaidAtPublish,
  loadLateApprovedExpenses,
  parseLateExpensesCarried,
  planLateApprovedExpenses,
  planLateExpenseCoverage,
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
 *   1. the plan — floor September 2026, held people out, already-carried out, stamped / pending /
 *      rejected out, and only payout months strictly before the run's;
 *   2. every read FAILS CLOSED — a failed read throws, never an empty list;
 *   3. the switch is refused while a run is in Part 2 or ready;
 *   4. OFF leaves the Expenses step rows exactly as they were;
 *   5. Part 2 confirm records a carried trip only when the confirmed figure covers it;
 *   6. publish pays only published, non-held people with expenses, and never a trip another
 *      published run already carried.
 * Nothing here can reach a database: every read goes through the fake below.
 */

// ---- A fake client: applies eq / in / is filters and range, and can fail a table on purpose ----

type TableSpec = {
  rows?: Array<Record<string, unknown>>;
  error?: { message: string };
  writeError?: { message: string };
};

function fakeDb(tables: Record<string, TableSpec>, writes: Array<{ table: string; op: string; payload: unknown }> = []): LateExpenseDb {
  return {
    from(table: string) {
      const spec = tables[table] ?? { rows: [] };
      const filters: Array<(row: Record<string, unknown>) => boolean> = [];
      let range: [number, number] | null = null;
      let single = false;
      let op: "select" | "insert" | "upsert" = "select";
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
        insert: (payload: unknown) => {
          op = "insert";
          writes.push({ table, op, payload });
          return builder;
        },
        upsert: (payload: unknown) => {
          op = "upsert";
          writes.push({ table, op, payload });
          return builder;
        },
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
          try {
            if (op !== "select") return Promise.resolve(resolve({ data: null, error: spec.writeError ?? null }));
            if (spec.error) return Promise.resolve(resolve({ data: null, error: spec.error }));
            let rows = (spec.rows ?? []).filter((row) => filters.every((filter) => filter(row)));
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
    expenseRow({ id: "sep-stamped", imported_payroll_batch_id: "batch-9" }),
    expenseRow({ id: "sep-stamped-at", imported_to_payroll_at: "2026-10-01T00:00:00Z" }),
    expenseRow({ id: "sep-pending", hr_approved: false, status: "Pending" }),
    expenseRow({ id: "sep-rejected", hr_approved: false, status: "Rejected" }),
    expenseRow({ id: "oct-ok", payout_month: 10, hr_id: "B-77", specialist: "Omar" }),
    expenseRow({ id: "nov-current", payout_month: 11 }),
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

  // ---- 2. The reads fail closed ----------------------------------------------------------------
  const publishedDetail = (held: string[], carried: string[] = []) => ({
    held: held.map((hrId) => ({ hrId, name: hrId })),
    heldExcluded: held.length,
    lateExpensesCarried: carried.map((id) => ({ id, compact: "b12", payoutMonth: 9, payoutYear: 2026, amount: 400 })),
  });
  const healthy: Record<string, TableSpec> = {
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
  };
  const loaded = await loadLateApprovedExpenses(NOVEMBER, fakeDb(healthy));
  assert.deepEqual(loaded.map((entry) => entry.id), ["sep-ok", "sep-hr-reduced", "oct-ok"], "the loader applies the plan to what it read");
  assert.deepEqual(
    [...new Set(loaded.map((entry) => entry.name))],
    ["Dina Hamdy Fadel", "Omar Gawish"],
    "the list carries names from the employee record, never codes",
  );

  await rejects(
    () => loadLateApprovedExpenses(NOVEMBER, fakeDb({ ...healthy, outstation_expenses: { error: { message: "boom" } } })),
    /^Conflict: .*could not be read/,
    "HEADLINE: a failed expense read THROWS — never an empty list that reads as nothing owed",
  );
  await rejects(
    () => loadLateApprovedExpenses(NOVEMBER, fakeDb({ ...healthy, automated_payroll_runs: { error: { message: "boom" } } })),
    /^Conflict:/,
    "a failed read of the published runs throws",
  );
  await rejects(
    () => loadLateApprovedExpenses(NOVEMBER, fakeDb({ ...healthy, automated_payroll_audit: { rows: [] } })),
    /^Conflict: .*record of who was held is missing/,
    "a published run with no record of who was held throws — a held person's trip would otherwise be listed",
  );
  await rejects(
    () => loadLateApprovedExpenses(NOVEMBER, fakeDb({ ...healthy, employees: { error: { message: "boom" } } })),
    /^Conflict:/,
    "a failed name read throws rather than showing codes",
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
    const writes: Array<{ table: string; op: string; payload: unknown }> = [];
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
        ),
      /^Conflict: the switch cannot change while a payroll run is in Part 2 or confirmed/,
      `HEADLINE: the switch is refused while a run is ${phase}`,
    );
    assert.equal(writes.length, 0, `nothing is written while a run is ${phase}`);
  }
  {
    const writes: Array<{ table: string; op: string; payload: unknown }> = [];
    const result = await setCarryLateExpenses(
      superAdmin,
      true,
      fakeDb(
        {
          automated_payroll_runs: { rows: [{ id: "run-nov", month: 11, year: 2026, phase: "part1" }] },
          automated_payroll_settings: { rows: [{ id: 1, carry_late_expenses: false }] },
        },
        writes,
      ),
    );
    assert.deepEqual(result, { carryLateExpenses: true }, "a run in Part 1 does not block the switch");
    assert.deepEqual(writes.map((write) => `${write.op} ${write.table}`), ["upsert automated_payroll_settings", "insert automated_payroll_audit"]);
    assert.deepEqual((writes[1].payload as { detail: unknown }).detail, { from: false, to: true }, "the change is audited from → to");
  }
  {
    const writes: Array<{ table: string; op: string; payload: unknown }> = [];
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
      /could not record the change/i,
      "the audit row is required",
    );
    assert.equal((writes.at(-1)?.payload as { carry_late_expenses: boolean }).carry_late_expenses, false, "and the old value is put back");
  }
  await rejects(
    () => setCarryLateExpenses({ ...superAdmin, role: "CEO" } as AccessContext, true, fakeDb({})),
    /^Forbidden:/,
    "only the payroll HR actor may flip it",
  );

  // ---- 4. OFF leaves the Expenses step exactly as it was ------------------------------------------
  const dina = member("B-12", "Dina Hamdy Fadel");
  const members = [dina, member("B-77", "Omar Gawish")];
  const own = new Map<string, PayoutExpenseTrip[]>([["b12", [trip()]]]);
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

  // ---- 5. Part 2 confirm records only what the confirmed figure covers ------------------------
  const merged = mergeCarriedLateTrips(own, carriedSep, new Set(["b12"]));
  const covered = planLateExpenseCoverage({ tripsByCompact: merged, expensesByCompact: new Map([["b12", 1150]]) });
  assert.deepEqual(
    covered.carried.map((entry) => [entry.id, entry.amount, entry.payoutMonth]),
    [["sep-ok", 400, 9], ["sep-hr-reduced", 250, 9]],
    "HEADLINE: a figure that covers the own month (500) plus the carried trips (650) records them",
  );
  assert.equal(covered.notCovered.length, 0);
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
  assert.match(atConfirm, /if \(!\(await getCarryLateExpensesSetting\(\)\)\) return \{ carried: \[\], notCovered: \[\] \};/, "OFF records nothing");
  assert.match(atConfirm, /planLateExpenseCoverage\(/, "and ON goes through the coverage rule");

  // ---- 6. Publish ------------------------------------------------------------------------------------
  const stamped = parseLateExpensesCarried({
    lateExpensesCarried: [
      { id: "paid", compact: "b12", payoutMonth: 9, payoutYear: 2026, amount: 400 },
      { id: "held", compact: "b50", payoutMonth: 9, payoutYear: 2026, amount: 300 },
      { id: "zero", compact: "b77", payoutMonth: 10, payoutYear: 2026, amount: 200 },
      { id: "gone", compact: "b99", payoutMonth: 10, payoutYear: 2026, amount: 100 },
    ],
  });
  assert.deepEqual(
    lateExpensesPaidAtPublish(stamped, [
      { compact: "b12", onHold: false, row: { expenses: 900 } },
      { compact: "b50", onHold: true, row: { expenses: 300 } },
      { compact: "b77", onHold: false, row: { expenses: 0 } },
    ]).map((entry) => entry.id),
    ["paid"],
    "HEADLINE: publish carries only published, non-held people whose expenses are above zero",
  );
  assert.deepEqual(parseLateExpensesCarried({ heldExcluded: 0 }), [], "an older stamp carries nothing");
  assert.deepEqual(
    lateExpensesAlreadyCarried(["paid", "new"], [{ runId: "run-oct", month: 10, year: 2026, carriedTripIds: ["paid"] }]),
    [{ id: "paid", month: 10, year: 2026 }],
  );
  await rejects(
    () => assertLateExpensesNotCarriedElsewhere("run-nov", [{ id: "sep-carried", compact: "b12", payoutMonth: 9, payoutYear: 2026, amount: 400 }], fakeDb(healthy)),
    /^Conflict: 1 late-approved outstation trip .*already paid by the October 2026 run/,
    "HEADLINE: publish refuses a trip another published run already carried",
  );
  await assertLateExpensesNotCarriedElsewhere(
    "run-oct",
    [{ id: "sep-carried", compact: "b12", payoutMonth: 9, payoutYear: 2026, amount: 400 }],
    fakeDb(healthy),
  );

  const publish = bodyOf(service, "export async function publishToPayslips(");
  assert.match(
    publish,
    /const lateExpensesCarried = lateExpensesPaidAtPublish\(\(await readPart2ConfirmedStamp\(runId\)\)\.lateExpensesCarried, rows\);/,
    "publish reads the carried trips from the Part 2 stamp and keeps only the paid ones",
  );
  const claimAt = publish.indexOf("const published = await whileClaimed(runId, transition");
  const guardAt = publish.indexOf("await assertLateExpensesNotCarriedElsewhere(runId, lateExpensesCarried)");
  assert.ok(claimAt > 0 && guardAt > claimAt, "the two-runs guard runs under the publish claim");
  assert.ok(guardAt < publish.indexOf("await createSalaryBatch("), "before anything is written");
  assert.ok(guardAt < publish.indexOf("await markRunPublished("), "and before the phase write");
  const markCall = publish.slice(publish.indexOf("await markRunPublished("), publish.indexOf("{ transitionToken: transition }", publish.indexOf("await markRunPublished(")));
  assert.match(markCall, /\[LATE_EXPENSES_CARRIED_KEY\]: lateExpensesCarried/, "the carried list is written with the phase, atomically");
  assert.match(publish, /carriedRowIds: lateExpensesCarried\.map\(\(entry\) => entry\.id\)/, "and the carried rows are stamped after publish");

  const stampSource = stripComments(readFileSync("src/lib/automated-payroll/expense-stamp.ts", "utf8"));
  const stampFn = bodyOf(stampSource, "export async function stampPaidExpenseTrips(");
  assert.match(stampFn, /carriedStamped \+= await stampChunk\(carriedIds\.slice/, "the carried rows are marked by id");
  assert.match(stampFn, /\.is\("imported_payroll_batch_id", null\)\s*\.is\("imported_to_payroll_at", null\)/, "with the same never-twice guards");
}
