import assert from "node:assert/strict";

import {
  compareDateOnly,
  getCompletedVacationPeriodEntitlementDays,
  getVacationBalancePeriod,
} from "../src/lib/vacation/calculations.ts";
import { getEgyptianNationalHolidays } from "../src/lib/vacation/national-holidays.ts";
import {
  approvedPaidDaysInPeriod,
  getDeferredDebtFromPreviousPeriods,
} from "../src/lib/vacation/service.ts";

/**
 * THE VACATION BALANCE READS NOW START TOGETHER — AND MUST STILL ADD UP TO THE SAME DAY.
 *
 * Owner, 2026-10-01: "the employee portal, specially the medical rep role, is slow to transfer
 * between page and page". The Vacation Request page walked every past balance period one at a
 * time, three reads per period (approved requests, the Payroll Copilot ledger, attendance charges),
 * each waiting for the one before it. Those reads now start together. This is money-adjacent code —
 * the same functions price a request paid or unpaid and feed payroll — so the rewrite is only
 * acceptable if it is OUTPUT-IDENTICAL, and that is what this file pins:
 *
 *   1. the carried debt equals, to the last digit, the one-at-a-time walk as it was written before
 *      the change (copied below as the definition), for a hire-anniversary employee, the
 *      calendar-year exception and an employee long enough in service to hit the 50-period cap;
 *   2. the SAME periods are read — no more, no fewer;
 *   3. a failure throws the SAME error the one-at-a-time walk met first: the earliest failing
 *      period, and inside a period the request read, then a fail-closed ledger read, then the
 *      attendance read;
 *   4. and the reads really do overlap now, within a bound.
 *
 * It also pins the holiday feed now being downloaded once for many months (national-holidays.ts),
 * with a stubbed `fetch` always getting its own answer.
 *
 * Nothing here reaches a database: the client is a small in-memory query engine, like
 * tests/fixtures/fake-supabase-table.ts, extended with `ilike`, `or`, a per-read failure hook and a
 * count of reads in flight. The suite runs with production credentials, so these functions can never
 * be exercised against a real client from a test.
 */

type Row = Record<string, unknown>;
type FilterOp = "eq" | "neq" | "in" | "is" | "gte" | "lt" | "ilike" | "or";
type Filter = { column: string; op: FilterOp; value: unknown };
type ReadRecord = { filters: Filter[]; table: string };
type ReadFailure = { kind: "error" | "reject"; message: string };
type ReadResult = { data: Row[] | null; error: { message: string } | null };

function ilikeToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "\\" && index + 1 < pattern.length) {
      index += 1;
      source += pattern[index].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (char === "%") {
      source += ".*";
    } else if (char === "_") {
      source += ".";
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, "i");
}

function rowMatches(row: Row, filter: Filter): boolean {
  const value = row[filter.column];
  switch (filter.op) {
    case "eq":
      return value === filter.value;
    // PostgREST's `neq` is SQL `<>`: a NULL column is never "not equal" to anything.
    case "neq":
      return value !== null && value !== undefined && value !== filter.value;
    case "in":
      return (filter.value as unknown[]).includes(value);
    case "is":
      return (value ?? null) === filter.value;
    case "gte":
      return String(value ?? "") >= String(filter.value);
    case "lt":
      return String(value ?? "") < String(filter.value);
    case "ilike":
      return ilikeToRegExp(String(filter.value)).test(String(value ?? ""));
    // PostgREST's `or=(...)`: any one term admits the row, each read the same SQL way — so
    // `run_id.is.null` keeps the NULL row that `run_id.neq.x` on its own would drop.
    case "or":
      return (filter.value as Filter[]).some((term) => rowMatches(row, term));
  }
}

/**
 * The terms of an `or=(...)` filter. Only what balanceSettledDaysInPeriod sends is read —
 * `column.eq|neq.value` and `column.is.null`; anything else throws rather than matching rows it
 * should not.
 */
function parseOrTerms(filters: string): Filter[] {
  return filters.split(",").map((term) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\.(eq|neq|is)\.([^,()"]+)$/.exec(term.trim());
    if (!match || (match[2] === "is" && match[3] !== "null")) {
      throw new Error(`the stub cannot read the or() term "${term}"`);
    }
    const op = match[2] as FilterOp;
    return { column: match[1], op, value: op === "is" ? null : match[3] };
  });
}

// Plain fields, not constructor parameter properties: the runner strips types and cannot transform
// that TypeScript-only syntax.
class StubEngine {
  readonly reads: ReadRecord[] = [];
  inFlight = 0;
  maxInFlight = 0;
  private readonly tables: Record<string, Row[]>;
  private readonly failWhen: (read: ReadRecord) => ReadFailure | null;
  private readonly delayFor: (read: ReadRecord) => number;

  constructor(
    tables: Record<string, Row[]>,
    failWhen: (read: ReadRecord) => ReadFailure | null = () => null,
    // How long each read stays open. One tick by default; a case can make an EARLIER period answer
    // LATER than a later one, which is the only way to tell "first in period order" from "first in time".
    delayFor: (read: ReadRecord) => number = () => 1,
  ) {
    this.tables = tables;
    this.failWhen = failWhen;
    this.delayFor = delayFor;
  }

  from(table: string) {
    return new StubQuery(table, this.tables[table] ?? [], this);
  }

  async answer(read: ReadRecord, rows: Row[]): Promise<ReadResult> {
    this.reads.push(read);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    // A real read takes time; holding each one open for a tick is what lets overlapping reads be
    // counted at all.
    await new Promise((resolve) => setTimeout(resolve, this.delayFor(read)));
    this.inFlight -= 1;
    const failure = this.failWhen(read);
    if (failure?.kind === "reject") throw new Error(failure.message);
    if (failure?.kind === "error") return { data: null, error: { message: failure.message } };
    return { data: rows.filter((row) => read.filters.every((filter) => rowMatches(row, filter))), error: null };
  }
}

class StubQuery implements PromiseLike<ReadResult> {
  private readonly filters: Filter[] = [];
  private readonly table: string;
  private readonly rows: Row[];
  private readonly engine: StubEngine;

  constructor(table: string, rows: Row[], engine: StubEngine) {
    this.table = table;
    this.rows = rows;
    this.engine = engine;
  }

  private add(op: FilterOp, column: string, value: unknown) {
    this.filters.push({ column, op, value });
    return this;
  }

  select(_columns?: string) {
    return this;
  }
  eq(column: string, value: unknown) {
    return this.add("eq", column, value);
  }
  neq(column: string, value: unknown) {
    return this.add("neq", column, value);
  }
  in(column: string, values: unknown[]) {
    return this.add("in", column, values);
  }
  is(column: string, value: unknown) {
    return this.add("is", column, value);
  }
  gte(column: string, value: unknown) {
    return this.add("gte", column, value);
  }
  lt(column: string, value: unknown) {
    return this.add("lt", column, value);
  }
  ilike(column: string, pattern: string) {
    return this.add("ilike", column, pattern);
  }
  or(filters: string) {
    return this.add("or", "", parseOrTerms(filters));
  }

  then<TResult1 = ReadResult, TResult2 = never>(
    onfulfilled?: ((value: ReadResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.engine.answer({ filters: [...this.filters], table: this.table }, this.rows).then(onfulfilled, onrejected);
  }
}

/** The lower bound of a read's date window — which balance period it belongs to. */
function readPeriodStart(read: ReadRecord): string {
  return String(read.filters.find((filter) => filter.op === "gte")?.value ?? "");
}

function readPeriodKey(read: ReadRecord): string {
  const upper = String(read.filters.find((filter) => filter.op === "lt")?.value ?? "");
  return `${read.table}|${readPeriodStart(read)}|${upper}`;
}

// ── The data ──────────────────────────────────────────────────────────────────────────────────

type RequestRow = {
  duration_days: number;
  employee_hr_id: string;
  id: string;
  paid_duration_days: number | null;
  payment_status: string;
  start_date: string;
  status: string;
  vacation_type: string;
};
type SettlementRow = {
  balance_days_consumed: number;
  employee_hr_id_compact: string;
  run_id: string | null;
  settlement_method: string;
  start_date: string;
  superseded_at: string | null;
};
type ChargeRow = { days: number; employee_hr_id: string; work_date: string };
type Tables = { charges: ChargeRow[]; requests: RequestRow[]; settlements: SettlementRow[] };

function request(id: string, employeeHrId: string, startDate: string, paid: number | null, extra: Partial<RequestRow> = {}): RequestRow {
  return {
    duration_days: paid ?? 0,
    employee_hr_id: employeeHrId,
    id,
    paid_duration_days: paid,
    payment_status: "paid",
    start_date: startDate,
    status: "approved",
    vacation_type: "annual",
    ...extra,
  };
}

// Run ids are uuids: `run_id` is a uuid column, and the exclusion refuses to place anything else
// inside its filter.
const RUN_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const RUN_OTHER = "cccccccc-0000-4000-8000-00000000000c";

function settlement(compact: string, startDate: string, days: number, extra: Partial<SettlementRow> = {}): SettlementRow {
  return {
    balance_days_consumed: days,
    employee_hr_id_compact: compact,
    run_id: RUN_OTHER,
    settlement_method: "balance",
    start_date: startDate,
    superseded_at: null,
    ...extra,
  };
}

// B-7, hired 2019-03-15, current period from 2026-03-15: seven past periods, the first a first-year
// one (15 days earned), the rest 21. Used per period — 18, 10, 25.5, 21, 30, 0, 23.25 — so the debt
// runs 3, 0, 4.5, 4.5, 13.5, 0, 2.25: it rises, is cleared, and returns, which is what makes the
// fold's order and its max(0, …) floor both matter.
const TABLES: Tables = {
  requests: [
    // Period 1 — 2019-03-15 .. 2020-03-15
    request("r1", "B-7", "2019-05-01", 10),
    request("r2", "B-7", "2019-08-10", null, { duration_days: 3, vacation_type: "emergency" }),
    request("r3", "B-7", "2019-11-01", null, { duration_days: 5, payment_status: "unpaid" }),
    request("r4", "B-7", "2019-06-01", 4, { status: "pending_hr" }),
    request("r5", "B-7", "2019-07-01", 2, { vacation_type: "sick" }),
    // Period 2 — starts ON its first day, which is inside it
    request("r6", "B-7", "2020-03-15", 6),
    // Period 3 — the next period's first day belongs to the NEXT period, never the one ending
    request("r7", "B-7", "2021-03-15", 1),
    request("r8", "B-7", "2021-06-01", null, { duration_days: 20, vacation_type: "emergency" }),
    // Period 4
    request("r9", "B-7", "2022-04-01", 21),
    // Period 5
    request("r10", "B-7", "2023-05-05", 15),
    // Period 6 — only somebody else's leave
    request("r11", "B-8", "2024-05-05", 30),
    // Period 7
    request("r12", "B-7", "2025-04-04", 20.25),
    request("r13", "B-7", "2026-03-14", 2),
    // The current period is not a PAST period and is never walked
    request("r14", "B-7", "2026-04-01", 5),
    // A-7: the calendar-year exception
    request("a1", "A-7", "2021-08-01", 25),
    request("a2", "A-7", "2022-02-02", 10),
    request("a3", "A-7", "2023-03-03", 30),
    request("a4", "A-7", "2024-04-04", 21),
    request("a5", "A-7", "2025-05-05", 25),
    // C-1: hired 1950 — the 50th period is the last one walked, the 51st never is
    request("c1", "C-1", "1999-06-01", 30),
    request("c2", "C-1", "2000-06-01", 40),
  ],
  settlements: [
    settlement("b7", "2019-12-01", 2, { run_id: RUN_A }),
    settlement("b7", "2020-09-01", 3, { settlement_method: "partial_balance" }),
    settlement("b7", "2020-10-01", 5, { superseded_at: "2020-10-02T00:00:00Z" }),
    settlement("b7", "2020-11-01", 4, { settlement_method: "salary" }),
    settlement("b7", "2023-07-07", 10, { settlement_method: "defer_to_balance" }),
    settlement("b8", "2024-06-06", 9),
    settlement("b7", "2025-10-10", 1),
    settlement("a7", "2024-02-02", 3),
  ],
  charges: [
    { days: 3, employee_hr_id: "b-7", work_date: "2020-01-20" },
    { days: 1, employee_hr_id: "B-7", work_date: "2020-12-01" },
    { days: 0.5, employee_hr_id: "B-7", work_date: "2021-09-09" },
    { days: 4, employee_hr_id: "B-7", work_date: "2022-03-14" },
    { days: 5, employee_hr_id: "B-7", work_date: "2023-09-09" },
    { days: 7, employee_hr_id: "B-8", work_date: "2024-07-07" },
  ],
};

function engineFor(
  tables: Tables,
  failWhen?: (read: ReadRecord) => ReadFailure | null,
  delayFor?: (read: ReadRecord) => number,
) {
  return new StubEngine(
    {
      attendance_annual_balance_charges: tables.charges,
      payroll_copilot_vacation_settlements: tables.settlements,
      v2_vacation_requests: tables.requests,
    },
    failWhen,
    delayFor,
  );
}

// ── The definition: what the one-at-a-time code returned ──────────────────────────────────────

type PeriodReadInput = {
  employeeHrId: string;
  excludeRequestId?: string;
  excludeSettlementRunId?: string;
  periodEnd: string;
  periodStart: string;
  vacationType: string;
};

/** approvedPaidDaysInPeriod's sum, computed straight from the rows, in its own order. */
function usedPaidDaysByDefinition(input: PeriodReadInput, tables: Tables): number {
  const pooled = input.vacationType === "annual" || input.vacationType === "emergency";
  const inPeriod = (date: string) => date >= input.periodStart && date < input.periodEnd;
  const requestDays = tables.requests
    .filter((row) =>
      row.employee_hr_id === input.employeeHrId.toUpperCase()
      && row.status === "approved"
      && inPeriod(row.start_date)
      && (pooled ? row.vacation_type === "annual" || row.vacation_type === "emergency" : row.vacation_type === input.vacationType)
      && row.id !== input.excludeRequestId)
    .reduce((sum, row) => {
      if (row.paid_duration_days != null) return sum + row.paid_duration_days;
      return row.payment_status === "paid" ? sum + row.duration_days : sum;
    }, 0);
  if (!pooled) return requestDays;
  const compact = input.employeeHrId.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const settledDays = tables.settlements
    .filter((row) =>
      row.employee_hr_id_compact === compact
      && ["balance", "partial_balance", "defer_to_balance"].includes(row.settlement_method)
      && row.superseded_at === null
      && inPeriod(row.start_date)
      // Corrected 2026-10-01: a settlement written outside any payroll run (run_id NULL) is somebody
      // else's spending and counts. The one-at-a-time code dropped it — `neq` is SQL `<>` — and this
      // definition had copied that faithfully.
      && (!input.excludeSettlementRunId || row.run_id === null || row.run_id !== input.excludeSettlementRunId))
    .reduce((sum, row) => sum + row.balance_days_consumed, 0);
  const attendanceDays = tables.charges
    .filter((row) => row.employee_hr_id.toLowerCase() === input.employeeHrId.trim().toLowerCase() && inPeriod(row.work_date))
    .reduce((sum, row) => sum + row.days, 0);
  return requestDays + settledDays + attendanceDays;
}

/**
 * getDeferredDebtFromPreviousPeriods exactly as it read before 2026-10-01 — one period at a time —
 * with the period's read answered by the definition above.
 */
function deferredDebtByDefinition(
  input: { currentPeriodStart: string; employeeHrId: string; hireDate: string },
  tables: Tables,
): { debt: number; periods: string[] } {
  const periods: string[] = [];
  if (compareDateOnly(input.currentPeriodStart, input.hireDate) <= 0) return { debt: 0, periods };

  let currentDebt = 0;
  let periodStart = input.hireDate;

  let iterations = 0;
  while (compareDateOnly(periodStart, input.currentPeriodStart) < 0 && iterations < 50) {
    iterations++;
    const period = getVacationBalancePeriod({ employeeHrId: input.employeeHrId, hireDate: input.hireDate, referenceDate: periodStart });
    if (!period) break;
    periods.push(`${period.periodStart}|${period.periodEnd}`);

    const usedPaidDays = usedPaidDaysByDefinition({
      employeeHrId: input.employeeHrId,
      periodEnd: period.periodEnd,
      periodStart: period.periodStart,
      vacationType: "annual",
    }, tables);

    const entitlementDays = getCompletedVacationPeriodEntitlementDays({
      employeeHrId: input.employeeHrId,
      hireDate: input.hireDate,
      period,
    });
    currentDebt = Math.max(0, currentDebt + usedPaidDays - entitlementDays);
    periodStart = period.periodEnd;
  }

  return { debt: currentDebt, periods };
}

function currentPeriodStartFor(employeeHrId: string, hireDate: string, referenceDate: string): string {
  const period = getVacationBalancePeriod({ employeeHrId, hireDate, referenceDate });
  assert.ok(period, `a balance period must resolve for ${employeeHrId}`);
  return period.periodStart;
}

/** Every (table, period) pair the walk is expected to read: the definition's periods × three ledgers. */
function expectedWalkReads(periods: string[]): string[] {
  return periods
    .flatMap((period) => [
      `v2_vacation_requests|${period}`,
      `payroll_copilot_vacation_settlements|${period}`,
      `attendance_annual_balance_charges|${period}`,
    ])
    .sort();
}

async function withQuietErrorLog<T>(run: () => Promise<T>): Promise<T> {
  // balanceSettledDaysInPeriod logs a failed ledger read before reading it as 0 or rethrowing it.
  // Those lines are expected here; keep them out of the suite's output.
  const savedError = console.error;
  console.error = () => undefined;
  try {
    return await run();
  } finally {
    console.error = savedError;
  }
}

function hasMessage(expected: string) {
  return (error: unknown) => {
    assert.equal((error as { message?: unknown })?.message, expected);
    return true;
  };
}

async function runDeferredDebtParity() {
  const cases = [
    { employeeHrId: "B-7", hireDate: "2019-03-15", periods: 7, debt: 2.25 },
    // The calendar-year exception resets on 1 January, so its first period starts BEFORE the hire.
    { employeeHrId: "A-7", hireDate: "2021-06-01", periods: 5, debt: 16 },
    // 76 past periods; the walk stops at 50 — [1999-01-01, 2000-01-01) — as it always did.
    { employeeHrId: "C-1", hireDate: "1950-01-01", periods: 50, debt: 9 },
  ];

  for (const testCase of cases) {
    const currentPeriodStart = currentPeriodStartFor(testCase.employeeHrId, testCase.hireDate, "2026-10-02");
    const definition = deferredDebtByDefinition({ currentPeriodStart, employeeHrId: testCase.employeeHrId, hireDate: testCase.hireDate }, TABLES);
    assert.equal(definition.periods.length, testCase.periods, `${testCase.employeeHrId}: the definition walks ${testCase.periods} periods`);
    assert.equal(definition.debt, testCase.debt, `${testCase.employeeHrId}: the hand-computed carried debt`);

    const engine = engineFor(TABLES);
    const debt = await getDeferredDebtFromPreviousPeriods(
      { currentPeriodStart, employeeHrId: testCase.employeeHrId, hireDate: testCase.hireDate },
      engine as never,
    );
    assert.equal(
      debt,
      definition.debt,
      `${testCase.employeeHrId}: the carried debt must be the one-at-a-time walk's, to the last digit`,
    );
    assert.deepEqual(
      engine.reads.map(readPeriodKey).sort(),
      expectedWalkReads(definition.periods),
      `${testCase.employeeHrId}: exactly the same periods are read — same loop, same 50-period cap`,
    );
    // The point of the change, and its bound: several periods' reads overlap, never more than six
    // periods (three reads each) at once.
    assert.ok(engine.maxInFlight > 3, `${testCase.employeeHrId}: reads of different periods must overlap (saw ${engine.maxInFlight})`);
    assert.ok(engine.maxInFlight <= 18, `${testCase.employeeHrId}: at most six periods are read at once (saw ${engine.maxInFlight})`);
  }

  // The 51st period's leave is outside the cap and must never be read at all.
  {
    const engine = engineFor(TABLES);
    await getDeferredDebtFromPreviousPeriods(
      { currentPeriodStart: currentPeriodStartFor("C-1", "1950-01-01", "2026-10-02"), employeeHrId: "C-1", hireDate: "1950-01-01" },
      engine as never,
    );
    assert.ok(
      !engine.reads.some((read) => readPeriodStart(read) === "2000-01-01"),
      "the period after the 50th is never read",
    );
  }

  // Hired on or after the current period's start: nothing to carry, and nothing is read.
  {
    const engine = engineFor(TABLES);
    const debt = await getDeferredDebtFromPreviousPeriods(
      { currentPeriodStart: "2026-03-15", employeeHrId: "B-7", hireDate: "2026-03-15" },
      engine as never,
    );
    assert.equal(debt, 0);
    assert.equal(engine.reads.length, 0, "no past period means no read");
  }

  // A ledger read that fails OPEN (not fail-closed) still reads as 0 days — only for its period.
  {
    const currentPeriodStart = currentPeriodStartFor("B-7", "2019-03-15", "2026-10-02");
    const engine = engineFor(TABLES, (read) =>
      read.table === "payroll_copilot_vacation_settlements" && readPeriodStart(read) === "2025-03-15"
        ? { kind: "error", message: "ledger down P7" }
        : null);
    const debt = await withQuietErrorLog(() =>
      getDeferredDebtFromPreviousPeriods({ currentPeriodStart, employeeHrId: "B-7", hireDate: "2019-03-15" }, engine as never));
    assert.equal(debt, 1.25, "period 7 loses its one settled day, and nothing else moves");
  }
}

async function runDeferredDebtErrorOrder() {
  const currentPeriodStart = currentPeriodStartFor("B-7", "2019-03-15", "2026-10-02");
  const walk = (engine: StubEngine, failClosedLedgerRead?: boolean) =>
    withQuietErrorLog(() =>
      getDeferredDebtFromPreviousPeriods(
        { currentPeriodStart, employeeHrId: "B-7", failClosedLedgerRead, hireDate: "2019-03-15" },
        engine as never,
      ));
  const failing = (failures: Record<string, ReadFailure>) => (read: ReadRecord) =>
    failures[`${read.table}|${readPeriodStart(read)}`] ?? null;

  // The earliest failing PERIOD wins, however the reads interleave.
  {
    const engine = engineFor(TABLES, failing({
      "v2_vacation_requests|2020-03-15": { kind: "error", message: "requests down P2" },
      "v2_vacation_requests|2023-03-15": { kind: "error", message: "requests down P5" },
    }));
    await assert.rejects(walk(engine), hasMessage("requests down P2"), "the first failing period in order is the one thrown");
    // Once a batch of periods holds a failure no later batch starts: the seventh period, in the
    // second batch, is never read — the one-at-a-time walk never reached it either.
    assert.ok(!engine.reads.some((read) => readPeriodStart(read) === "2025-03-15"), "no batch after a failure is started");
  }

  // ...even when the LATER period's failure lands FIRST in time. Both reads reject, and the earlier
  // period's is held open twenty times longer, so a walk that surfaced the first rejection to ARRIVE
  // (a Promise.all over the batch) would throw P5's. Only a fold in period order throws P2's — what
  // the one-at-a-time walk threw, because it never reached period 5 at all.
  {
    const engine = engineFor(
      TABLES,
      failing({
        "v2_vacation_requests|2020-03-15": { kind: "reject", message: "requests rejected P2" },
        "v2_vacation_requests|2023-03-15": { kind: "reject", message: "requests rejected P5" },
      }),
      (read) => (readPeriodStart(read) === "2020-03-15" ? 20 : 1),
    );
    await assert.rejects(walk(engine), hasMessage("requests rejected P2"), "the first failing PERIOD wins, not the first failure to arrive");
  }

  // A read that REJECTS counts the same as one that answers with an error.
  {
    const engine = engineFor(TABLES, failing({
      "v2_vacation_requests|2022-03-15": { kind: "reject", message: "requests rejected P4" },
      "v2_vacation_requests|2024-03-15": { kind: "error", message: "requests down P6" },
    }));
    await assert.rejects(walk(engine), hasMessage("requests rejected P4"));
  }

  // Fail-closed: an earlier period's ledger failure beats a later period's request failure.
  {
    const engine = engineFor(TABLES, failing({
      "payroll_copilot_vacation_settlements|2021-03-15": { kind: "error", message: "ledger down P3" },
      "v2_vacation_requests|2022-03-15": { kind: "error", message: "requests down P4" },
    }));
    await assert.rejects(walk(engine, true), hasMessage("ledger down P3"));
  }

  // Inside one period: the request read first, then the fail-closed ledger, then attendance.
  {
    const engine = engineFor(TABLES, failing({
      "attendance_annual_balance_charges|2020-03-15": { kind: "error", message: "charges down P2" },
      "payroll_copilot_vacation_settlements|2020-03-15": { kind: "error", message: "ledger down P2" },
      "v2_vacation_requests|2020-03-15": { kind: "error", message: "requests down P2" },
    }));
    await assert.rejects(walk(engine, true), hasMessage("requests down P2"), "the request read's failure is thrown first");
  }
  {
    const engine = engineFor(TABLES, failing({
      "attendance_annual_balance_charges|2020-03-15": { kind: "error", message: "charges down P2" },
      "payroll_copilot_vacation_settlements|2020-03-15": { kind: "error", message: "ledger down P2" },
    }));
    await assert.rejects(walk(engine, true), hasMessage("ledger down P2"), "then a fail-closed ledger read's");
  }
  {
    const engine = engineFor(TABLES, failing({
      "attendance_annual_balance_charges|2024-03-15": { kind: "error", message: "charges down P6" },
    }));
    // The attendance read never fails open, fail-closed or not.
    await assert.rejects(walk(engine), hasMessage("charges down P6"), "then the attendance read's");
  }
}

async function runApprovedPaidDaysInPeriod() {
  const period1 = { periodEnd: "2020-03-15", periodStart: "2019-03-15" };

  // The annual/emergency pool: the three reads start together, and add up as before.
  for (const vacationType of ["annual", "emergency"] as const) {
    const engine = engineFor(TABLES);
    const used = await approvedPaidDaysInPeriod({ employeeHrId: "B-7", ...period1, vacationType }, engine as never);
    assert.equal(used, usedPaidDaysByDefinition({ employeeHrId: "B-7", ...period1, vacationType }, TABLES));
    assert.equal(used, 18, `${vacationType}: 10 + 3 + 0 requested, 2 settled, 3 charged`);
    assert.deepEqual(
      engine.reads.map((read) => read.table).sort(),
      ["attendance_annual_balance_charges", "payroll_copilot_vacation_settlements", "v2_vacation_requests"],
    );
    assert.equal(engine.maxInFlight, 3, "the request read and both ledger reads are in flight together");
  }

  // Outside the pool nothing but the request read happens — exactly as before.
  {
    const engine = engineFor(TABLES);
    const used = await approvedPaidDaysInPeriod({ employeeHrId: "B-7", ...period1, vacationType: "sick" }, engine as never);
    assert.equal(used, 2);
    assert.deepEqual(engine.reads.map((read) => read.table), ["v2_vacation_requests"], "a sick balance never reads the ledgers");
  }

  // No period, no read.
  {
    const engine = engineFor(TABLES);
    const used = await approvedPaidDaysInPeriod(
      { employeeHrId: "B-7", periodEnd: null, periodStart: null, vacationType: "annual" },
      engine as never,
    );
    assert.equal(used, 0);
    assert.equal(engine.reads.length, 0);
  }

  // The request being re-priced, and a payroll run's own settlements, are still left out.
  {
    const engine = engineFor(TABLES);
    const used = await approvedPaidDaysInPeriod(
      { employeeHrId: "B-7", excludeRequestId: "r1", excludeSettlementRunId: RUN_A, ...period1, vacationType: "annual" },
      engine as never,
    );
    assert.equal(
      used,
      usedPaidDaysByDefinition({ employeeHrId: "B-7", excludeRequestId: "r1", excludeSettlementRunId: RUN_A, ...period1, vacationType: "annual" }, TABLES),
    );
    assert.equal(used, 6, "18 less request r1's 10 days and run A's 2 settled days");
  }

  // ...while a settlement written outside any payroll run (run_id NULL) still counts. A bare `neq`
  // is SQL `<>` and dropped it, so the run read more balance left than there was.
  {
    const withOutsideRun: Tables = {
      ...TABLES,
      settlements: [...TABLES.settlements, settlement("b7", "2019-10-01", 1.5, { run_id: null })],
    };
    const used = await approvedPaidDaysInPeriod(
      { employeeHrId: "B-7", excludeRequestId: "r1", excludeSettlementRunId: RUN_A, ...period1, vacationType: "annual" },
      engineFor(withOutsideRun) as never,
    );
    assert.equal(
      used,
      usedPaidDaysByDefinition({ employeeHrId: "B-7", excludeRequestId: "r1", excludeSettlementRunId: RUN_A, ...period1, vacationType: "annual" }, withOutsideRun),
    );
    assert.equal(used, 7.5, "the same 6, plus the 1.5 days settled outside any run");
  }

  // A fail-closed ledger read still throws, and a fail-open one still reads as 0.
  {
    const failLedger = (read: ReadRecord): ReadFailure | null =>
      read.table === "payroll_copilot_vacation_settlements" ? { kind: "error", message: "ledger down" } : null;
    await assert.rejects(
      withQuietErrorLog(() => approvedPaidDaysInPeriod(
        { employeeHrId: "B-7", failClosedLedgerRead: true, ...period1, vacationType: "annual" },
        engineFor(TABLES, failLedger) as never,
      )),
      hasMessage("ledger down"),
    );
    const failOpen = await withQuietErrorLog(() => approvedPaidDaysInPeriod(
      { employeeHrId: "B-7", ...period1, vacationType: "annual" },
      engineFor(TABLES, failLedger) as never,
    ));
    assert.equal(failOpen, 16, "the 2 settled days read as 0; requests and charges still count");
  }
}

// ── The holiday feed: one download for many months ────────────────────────────────────────────

function holidayIcs(events: Array<{ date: string; name: string }>): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    ...events.flatMap((event) => [
      "BEGIN:VEVENT",
      `DTSTART;VALUE=DATE:${event.date}`,
      `UID:${event.date}@test`,
      `SUMMARY:${event.name}`,
      "DESCRIPTION:Public holiday",
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
  ].join("\r\n");
}

async function runHolidayFeedDownloadedOnce() {
  // Year 2098 keeps every month here clear of the months other holiday tests cache (2099) and of
  // any real month; each block asks for months no earlier block asked for.
  const savedFetch = globalThis.fetch;
  try {
    let feedDownloads = 0;
    const firstFeed = holidayIcs([
      { date: "20980107", name: "January holiday" },
      { date: "20980210", name: "February holiday" },
      { date: "20980315", name: "March holiday" },
      { date: "20980425", name: "April holiday" },
    ]);
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input instanceof Request ? input.url : input).includes("/public/basic.ics")) feedDownloads += 1;
      return new Response(firstFeed, { status: 200 });
    }) as typeof fetch;

    const [january, february, march] = await Promise.all(
      [1, 2, 3].map((month) => getEgyptianNationalHolidays({ month, year: 2098 })),
    );
    assert.equal(feedDownloads, 1, "three months asked for at once share ONE download of the whole feed");
    assert.ok(january.holidays.some((holiday) => holiday.startDate === "2098-01-07"), "January still reads its own month");
    assert.ok(february.holidays.some((holiday) => holiday.startDate === "2098-02-10"), "February still reads its own month");
    assert.ok(march.holidays.some((holiday) => holiday.startDate === "2098-03-15"), "March still reads its own month");
    assert.ok(!january.holidays.some((holiday) => holiday.startDate === "2098-02-10"), "a month never takes another month's holiday");
    assert.equal(january.calendarReachable, true);

    const april = await getEgyptianNationalHolidays({ month: 4, year: 2098 });
    assert.equal(feedDownloads, 1, "a later month inside the ten minutes reads the kept feed");
    assert.ok(april.holidays.some((holiday) => holiday.startDate === "2098-04-25"));

    // A different `fetch` never gets a body another `fetch` downloaded — every holiday test stubs it.
    let otherDownloads = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input instanceof Request ? input.url : input).includes("/public/basic.ics")) otherDownloads += 1;
      return new Response(holidayIcs([{ date: "20980501", name: "May holiday" }]), { status: 200 });
    }) as typeof fetch;
    const may = await getEgyptianNationalHolidays({ month: 5, year: 2098 });
    assert.equal(otherDownloads, 1, "a swapped fetch downloads its own feed");
    assert.ok(may.holidays.some((holiday) => holiday.startDate === "2098-05-01"), "and reads its own answer");

    // An unreachable feed is never kept: the next month asks again, exactly as before.
    let feedAttempts = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input instanceof Request ? input.url : input).includes("/public/basic.ics")) feedAttempts += 1;
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const june = await getEgyptianNationalHolidays({ month: 6, year: 2098 });
    const attemptsForJune = feedAttempts;
    await getEgyptianNationalHolidays({ month: 7, year: 2098 });
    assert.equal(june.calendarReachable, false);
    assert.ok(attemptsForJune >= 1, "the feed was tried for June");
    assert.equal(feedAttempts, attemptsForJune * 2, "and tried again for July — a failure is not kept");
  } finally {
    globalThis.fetch = savedFetch;
  }
}

export async function runVacationReadsStartedTogetherTests() {
  await runDeferredDebtParity();
  await runDeferredDebtErrorOrder();
  await runApprovedPaidDaysInPeriod();
  await runHolidayFeedDownloadedOnce();
}
