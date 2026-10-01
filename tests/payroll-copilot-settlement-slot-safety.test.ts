import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { recordHolidayBridgingDecision } from "../src/lib/payroll/copilot/holiday-bridging.ts";
import {
  describeSlotHolder,
  HOLIDAY_BRIDGE_EXCLUDED_METHOD,
  isLiveSettlementCollision,
  readLiveSettlementSlotHolder,
  SETTLEMENT_PAYMENT_METHODS,
} from "../src/lib/payroll/copilot/settlement-slot.ts";
import { stripComments } from "./support/comment-strip.ts";
import {
  recordVacationSettlementDecision,
  type UnpaidVacationCandidate,
} from "../src/lib/payroll/copilot/vacation-settlement.ts";

/**
 * NEITHER COPILOT WRITER RETIRES A LEAVE SETTLEMENT IT CANNOT REPLACE, AND NEITHER TOUCHES A ROW IT
 * DID NOT WRITE.
 *
 * THE LEDGER. public.payroll_copilot_vacation_settlements is summed into every employee's leave
 * balance by `balanceSettledDaysInPeriod` (src/lib/vacation/service.ts), over the three
 * balance-bearing methods. `payroll_copilot_vacation_settlements_live_idx` is a UNIQUE index over
 * (employee_hr_id_compact, start_date) WHERE superseded_at IS NULL, so ONE employee+date has ONE
 * live row across every writer: the Copilot's unpaid-vacation decision, the Copilot's
 * holiday-bridging exclusion, an automated payroll run, and one-off system corrections all compete
 * for the same slot.
 *
 * THE DEFECT, MEASURED ON PRODUCTION 2026-10-01. Both Copilot writers superseded FIRST and inserted
 * SECOND, and threw on the insert with nothing rolled back — the shape removed from the
 * automated-payroll writer in #5032, where it destroyed Khaled Mohamed Ali Bedair's 1.00-day balance
 * settlement of 2026-07-12 on 2026-08-04 and replaced it with nothing.
 *
 *   - `recordVacationSettlementDecision` scoped its supersede to employee_hr_id_compact + start_date
 *     AND NOTHING ELSE, and discarded its error. Production still carries a row that scope would
 *     retire: B-185's 2.00-day `balance` settlement of 2026-07-09, decided by
 *     `system:crm-correction-2026-07-21`, vacation_request_ids [].
 *   - `recordHolidayBridgingDecision` could not insert AT ALL. It writes
 *     settlement_method='holiday_bridge_excluded' with neither figure set, and
 *     `payroll_copilot_vacation_settlements_method_values_check` carried only four branches — the
 *     2026-07-11 baseline re-pinned four of the five the archived migrations had built — so every
 *     insert was refused `23514` (proved on staging, rolled back) and no such row has ever existed
 *     on production. Migration 20261001054326 adds the branch, which is exactly why the ordering had
 *     to be fixed in the same change: the destructive path was unreachable only by accident.
 *
 * Postgres raises the unique violation BEFORE a foreign-key one, so the fake below does too. That
 * ordering is why "stop at a non-collision error" is not sufficient on its own and the holder of the
 * slot has to be identified before anything is retired.
 */

type Row = Record<string, unknown>;

const SLOT = { compact: "b185", startDate: "2026-07-09" };
const REQUEST = "request-under-decision";
const OTHER_REQUEST = "a-different-request";

/** B-185's row as production holds it: a system correction, no request id, nobody's re-decision. */
function foreignCorrection(): Row {
  return {
    id: "row-system-correction",
    employee_hr_id: "B-185",
    employee_hr_id_compact: SLOT.compact,
    start_date: SLOT.startDate,
    unpaid_days: 2,
    settlement_method: "balance",
    balance_days_consumed: 2,
    salary_deduction_amount: null,
    run_id: null,
    decided_by: "system:crm-correction-2026-07-21",
    vacation_request_ids: [],
    superseded_at: null,
  };
}

/** The same slot held by THIS request's own earlier answer — the legitimate re-decision case. */
function ownEarlierDecision(): Row {
  return {
    ...foreignCorrection(),
    id: "row-own-earlier",
    settlement_method: "salary",
    balance_days_consumed: null,
    salary_deduction_amount: 500,
    decided_by: "B-10",
    vacation_request_ids: [REQUEST],
  };
}

/** The same slot held by HR's holiday-bridging exclusion — neither figure, not a payment decision. */
function bridgingExclusion(): Row {
  return {
    ...foreignCorrection(),
    id: "row-bridging-exclusion",
    settlement_method: HOLIDAY_BRIDGE_EXCLUDED_METHOD,
    balance_days_consumed: null,
    salary_deduction_amount: null,
    unpaid_days: 1,
    decided_by: "HR-009",
    // A bridging exclusion stores the vacation request id too, so the request id ALONE cannot tell
    // it apart from a payment decision — the method has to be checked as well.
    vacation_request_ids: [REQUEST],
  };
}

function candidate(): UnpaidVacationCandidate {
  return {
    requestId: REQUEST,
    employeeHrId: "B-185",
    employeeName: "Test Employee",
    vacationType: "annual",
    startDate: SLOT.startDate,
    endDate: SLOT.startDate,
    unpaidDays: 2,
    salaryDeductionAmount: 500,
    balanceAvailable: false,
    balanceDaysAvailable: 0,
    balanceDaysToConsume: 0,
    remainingSalaryDays: 2,
    remainingSalaryDeductionAmount: 500,
    existingSettlement: null,
  } as UnpaidVacationCandidate;
}

/**
 * A tiny ledger enforcing the three things that decide this behaviour: the partial unique index, the
 * five-branch method CHECK constraint, and real error CODES. Purpose-built rather than reusing
 * fixtures/fake-supabase-table.ts, which models predicates but neither codes nor indexes.
 */
function ledger(
  options: {
    rows?: Row[];
    supersedeFails?: boolean;
    methodCheckBranches?: 4 | 5;
    /**
     * Drops the partial unique index. The writers must NOT need it to notice an occupied slot: if
     * the supersede is triggered only by the `23505` it raises, then losing the index turns a
     * re-decision into a SECOND live row for one employee+date — and
     * `balanceSettledDaysInPeriod` sums across methods, so that double-counts somebody's consumed
     * leave with nothing erroring. CI caught exactly this against
     * `tests/payroll-copilot-vacation-settlement.test.ts`, whose `fakeSupabaseClient` has no index.
     */
    noUniqueIndex?: boolean;
  } = {},
) {
  const rows: Row[] = (options.rows ?? []).map((row) => ({ ...row }));
  const branches = options.methodCheckBranches ?? 5;
  let inserted = 0;
  const live = () => rows.filter((row) => row.superseded_at === null);

  function doInsert(payload: Row): { data: Row | null; error: { code: string; message: string } | null } {
    // The unique index first, exactly as Postgres orders it.
    const collides =
      !options.noUniqueIndex
      && live().some(
        (row) => row.employee_hr_id_compact === payload.employee_hr_id_compact && row.start_date === payload.start_date,
      );
    if (collides) {
      return {
        data: null,
        error: {
          code: "23505",
          message: 'duplicate key value violates unique constraint "payroll_copilot_vacation_settlements_live_idx"',
        },
      };
    }
    // `payroll_copilot_vacation_settlements_unpaid_days_check CHECK (unpaid_days > 0)`, live on
    // production — a real reason an insert can never land whatever the slot holds.
    if (Number(payload.unpaid_days ?? 0) <= 0) {
      return {
        data: null,
        error: {
          code: "23514",
          message:
            'new row for relation "payroll_copilot_vacation_settlements" violates check constraint '
            + '"payroll_copilot_vacation_settlements_unpaid_days_check"',
        },
      };
    }
    // Then the method CHECK. `methodCheckBranches: 4` reproduces production before migration
    // 20261001054326, where the bridging branch did not exist.
    const method = String(payload.settlement_method ?? "");
    const salary = payload.salary_deduction_amount ?? null;
    const balance = payload.balance_days_consumed ?? null;
    const satisfied =
      (method === "salary" && salary !== null && balance === null)
      || (method === "balance" && balance !== null && salary === null)
      || (method === "partial_balance" && balance !== null && salary !== null)
      || (method === "defer_to_balance" && balance !== null && salary === null)
      || (branches === 5 && method === HOLIDAY_BRIDGE_EXCLUDED_METHOD && salary === null && balance === null);
    if (!satisfied) {
      return {
        data: null,
        error: {
          code: "23514",
          message:
            'new row for relation "payroll_copilot_vacation_settlements" violates check constraint '
            + '"payroll_copilot_vacation_settlements_method_values_check"',
        },
      };
    }
    inserted += 1;
    const stored = { ...payload, id: `row-inserted-${inserted}`, superseded_at: null };
    rows.push(stored);
    return { data: stored, error: null };
  }

  function builder() {
    const filters: Array<(row: Row) => boolean> = [];
    let mode: "select" | "insert" | "update" = "select";
    let payload: Row = {};
    let columns: string[] | null = null;

    const settleRead = () => {
      const matched = rows.filter((row) => filters.every((keep) => keep(row)));
      if (matched.length === 0) return { data: null, error: null };
      const row = matched[0];
      const projected = columns ? Object.fromEntries(columns.map((name) => [name, row[name] ?? null])) : row;
      return { data: projected, error: null };
    };

    const api: Record<string, unknown> = {
      select(cols?: string) {
        columns = cols ? cols.split(",").map((name) => name.trim()) : null;
        return api;
      },
      insert(value: Row) {
        mode = "insert";
        payload = value;
        return api;
      },
      update(value: Row) {
        mode = "update";
        payload = value;
        return api;
      },
      eq(column: string, value: unknown) {
        filters.push((row) => row[column] === value);
        return api;
      },
      is(column: string, value: unknown) {
        filters.push((row) => (row[column] ?? null) === value);
        return api;
      },
      maybeSingle: () => Promise.resolve(settleRead()),
      single() {
        if (mode === "insert") {
          const result = doInsert(payload);
          return Promise.resolve(
            result.error
              ? { data: null, error: result.error }
              : { data: { id: String(result.data?.id ?? "") }, error: null },
          );
        }
        return Promise.resolve(settleRead());
      },
      then(resolve: (value: { data: unknown; error: unknown }) => unknown) {
        if (mode === "insert") return resolve(doInsert(payload));
        if (mode === "update") {
          if (options.supersedeFails) {
            return resolve({ data: null, error: { code: "XX000", message: "supersede refused" } });
          }
          for (const row of rows) {
            if (filters.every((keep) => keep(row))) Object.assign(row, payload);
          }
          return resolve({ data: null, error: null });
        }
        const matched = rows.filter((row) => filters.every((keep) => keep(row)));
        return resolve({ data: matched, error: null });
      },
    };
    return api;
  }

  return {
    client: { from: () => builder() } as never,
    liveRows: live,
    rows: () => rows,
    findById: (id: string) => rows.find((row) => row.id === id),
  };
}

async function rejects(run: () => Promise<unknown>, message: string): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  assert.fail(message);
}

export async function runPayrollCopilotSettlementSlotSafetyTests() {
  // ---- The shared rule, stated once ---------------------------------------------------------
  assert.ok(
    isLiveSettlementCollision({ code: "23505" }),
    "23505 on the live index is the ONE insert failure a supersede may clear",
  );
  assert.equal(
    isLiveSettlementCollision({ code: "23514" }),
    false,
    "a CHECK violation is not a slot collision — the row was never going to land, so nothing may be retired for it",
  );
  assert.equal(
    isLiveSettlementCollision({ code: "23503" }),
    false,
    "a foreign-key violation is not a slot collision either — this is the #5032 case",
  );
  assert.equal(isLiveSettlementCollision(null), false, "a missing error is not a collision");
  assert.equal(
    SETTLEMENT_PAYMENT_METHODS.includes(HOLIDAY_BRIDGE_EXCLUDED_METHOD as never),
    false,
    "a bridging exclusion is NOT a payment method, so balanceSettledDaysInPeriod can never sum it into a leave balance",
  );

  // ---- HEADLINE 1: the bridging exclusion the constraint used to refuse -----------------------
  // Before migration 20261001054326 this insert was refused 23514 on production and the old code
  // had already run its supersede. With four branches the insert must still fail AND still retire
  // nothing.
  const preMigration = ledger({ rows: [bridgingExclusion()], methodCheckBranches: 4 });
  const refused = await rejects(
    () =>
      recordHolidayBridgingDecision(
        {
          runId: "copilot-run",
          requestId: REQUEST,
          employeeHrId: "B-185",
          bridgingDate: SLOT.startDate,
          action: "exclude",
          decidedBy: "HR-009",
        },
        preMigration.client,
      ),
    "a bridging exclusion the CHECK constraint refuses must throw, not be swallowed",
  );
  assert.equal(
    (refused as unknown as { code?: string }).code,
    "23514",
    "the refusal HR's Exclude button hit is surfaced, not hidden — the route turns it into a 500",
  );
  assert.equal(
    preMigration.findById("row-bridging-exclusion")?.superseded_at,
    null,
    "HEADLINE: the earlier exclusion still stands. The old order retired it and then failed to replace it, "
      + "handing the employee back a mandatory holiday-bridging deduction HR had excused",
  );
  assert.equal(preMigration.liveRows().length, 1, "exactly one live row, the one that was already there");

  // With the branch in place the same exclusion lands, and the superseded predecessor is its own.
  const reExclude = ledger({ rows: [bridgingExclusion()] });
  await recordHolidayBridgingDecision(
    {
      runId: "copilot-run",
      requestId: REQUEST,
      employeeHrId: "B-185",
      bridgingDate: SLOT.startDate,
      action: "exclude",
      decidedBy: "HR-009",
    },
    reExclude.client,
  );
  assert.notEqual(
    reExclude.findById("row-bridging-exclusion")?.superseded_at,
    null,
    "a re-exclusion supersedes this writer's OWN earlier exclusion — the one case a supersede is justified",
  );
  assert.equal(reExclude.liveRows().length, 1, "a re-decision never leaves two live rows in one slot");
  assert.equal(
    reExclude.liveRows()[0]?.settlement_method,
    HOLIDAY_BRIDGE_EXCLUDED_METHOD,
    "and the surviving live row is the new exclusion",
  );

  // ---- HEADLINE 2: a bridging exclusion never clears a payment decision ----------------------
  const heldByPayment = ledger({ rows: [foreignCorrection()] });
  const blocked = await rejects(
    () =>
      recordHolidayBridgingDecision(
        {
          runId: "copilot-run",
          requestId: REQUEST,
          employeeHrId: "B-185",
          bridgingDate: SLOT.startDate,
          action: "exclude",
          decidedBy: "HR-009",
        },
        heldByPayment.client,
      ),
    "an exclusion cannot be recorded over somebody else's live settlement",
  );
  assert.match(
    blocked.message,
    /automated correction/,
    "the error says WHO holds the slot in words a person reads, never the raw decided_by code (owner rule: names, never codes)",
  );
  assert.equal(
    blocked.message.includes("system:"),
    false,
    "and the raw system token never reaches the screen",
  );
  assert.equal(
    heldByPayment.findById("row-system-correction")?.superseded_at,
    null,
    "HEADLINE: B-185's real balance settlement is untouched — clearing it would have silently returned 2.00 "
      + "days to a leave balance that had already spent them",
  );
  assert.equal(
    heldByPayment.findById("row-system-correction")?.balance_days_consumed,
    2,
    "and its consumed days are unchanged",
  );

  // ---- "include" is scoped to this writer's own marker and its error is read ------------------
  const includeOverPayment = ledger({ rows: [foreignCorrection()] });
  await recordHolidayBridgingDecision(
    {
      runId: "copilot-run",
      requestId: REQUEST,
      employeeHrId: "B-185",
      bridgingDate: SLOT.startDate,
      action: "include",
      decidedBy: "HR-009",
    },
    includeOverPayment.client,
  );
  assert.equal(
    includeOverPayment.findById("row-system-correction")?.superseded_at,
    null,
    "lifting an exclusion filters on settlement_method, so it cannot retire a payment decision sharing the slot",
  );

  const includeFails = ledger({ rows: [bridgingExclusion()], supersedeFails: true });
  await rejects(
    () =>
      recordHolidayBridgingDecision(
        {
          runId: "copilot-run",
          requestId: REQUEST,
          employeeHrId: "B-185",
          bridgingDate: SLOT.startDate,
          action: "include",
          decidedBy: "HR-009",
        },
        includeFails.client,
      ),
    "an include whose write failed must throw — silence left HR believing the deduction was off while it was on",
  );

  // ---- HEADLINE 3: a CEO settlement never clears a row this request did not record -----------
  const ceoOverCorrection = ledger({ rows: [foreignCorrection()] });
  const ceoBlocked = await rejects(
    () =>
      recordVacationSettlementDecision(
        { runId: "copilot-run", candidate: candidate(), method: "salary", decidedBy: "B-10" },
        ceoOverCorrection.client,
      ),
    "a settlement decision cannot overwrite a slot held by another decider",
  );
  assert.match(
    ceoBlocked.message,
    /automated correction/,
    "the CEO is told which decision holds the day, in words rather than a code",
  );
  assert.equal(
    ceoOverCorrection.findById("row-system-correction")?.superseded_at,
    null,
    "HEADLINE: the unscoped supersede is gone — this is the exact row and the exact scope that destroyed "
      + "Khaled's settlement on 2026-08-04",
  );
  assert.equal(ceoOverCorrection.liveRows().length, 1, "and the ledger is exactly as it was");

  // A settlement whose insert fails for a reason that is NOT a collision retires nothing — the
  // free-slot case, where there is nothing to retire and nothing must be invented.
  const impossibleInsert = ledger({ rows: [] });
  await rejects(
    () =>
      recordVacationSettlementDecision(
        // unpaid_days 0 violates payroll_copilot_vacation_settlements_unpaid_days_check, so this row
        // can never land whatever the slot holds.
        { runId: "copilot-run", candidate: { ...candidate(), unpaidDays: 0 }, method: "salary", decidedBy: "B-10" },
        impossibleInsert.client,
      ),
    "an insert the constraint refuses must throw",
  );
  assert.equal(impossibleInsert.liveRows().length, 0, "nothing was written, and nothing was retired to make room");

  // HEADLINE: the same impossible row against an OCCUPIED slot. Postgres reports the unique
  // violation FIRST, so this reaches the supersede, discovers on retry that the row can never land,
  // and must put the earlier settlement back. Insert-first ordering alone does NOT cover this.
  const impossibleOverOwn = ledger({ rows: [ownEarlierDecision()] });
  await rejects(
    () =>
      recordVacationSettlementDecision(
        { runId: "copilot-run", candidate: { ...candidate(), unpaidDays: 0 }, method: "salary", decidedBy: "B-10" },
        impossibleOverOwn.client,
      ),
    "a re-decision whose replacement cannot land must throw",
  );
  assert.equal(
    impossibleOverOwn.findById("row-own-earlier")?.superseded_at,
    null,
    "HEADLINE: the earlier settlement is PUT BACK. Without the restore, the collision-then-failed-retry path "
      + "reaches the same 'destroy a row, write nothing' outcome insert-first was adopted to prevent",
  );
  assert.equal(impossibleOverOwn.liveRows().length, 1, "and the slot still holds exactly one live row");
  assert.equal(
    impossibleOverOwn.liveRows()[0]?.salary_deduction_amount,
    500,
    "with its figure intact — nobody's leave day silently changed value",
  );

  // The legitimate re-decision: salary -> balance on the SAME request.
  const reDecision = ledger({ rows: [ownEarlierDecision()] });
  await recordVacationSettlementDecision(
    { runId: "copilot-run", candidate: { ...candidate(), balanceDaysToConsume: 2 }, method: "defer_to_balance", decidedBy: "B-10" },
    reDecision.client,
  );
  assert.notEqual(
    reDecision.findById("row-own-earlier")?.superseded_at,
    null,
    "this request's OWN earlier answer is the one row a re-decision may supersede",
  );
  assert.equal(reDecision.liveRows().length, 1, "and one live row remains");
  assert.equal(
    reDecision.liveRows()[0]?.settlement_method,
    "defer_to_balance",
    "the new decision is the live one",
  );

  // A settlement never retires a bridging exclusion, even though it carries the same request id.
  const overBridging = ledger({ rows: [bridgingExclusion()] });
  await rejects(
    () =>
      recordVacationSettlementDecision(
        { runId: "copilot-run", candidate: candidate(), method: "salary", decidedBy: "B-10" },
        overBridging.client,
      ),
    "a payment decision must not clear HR's bridging exclusion to take its slot",
  );
  assert.equal(
    overBridging.findById("row-bridging-exclusion")?.superseded_at,
    null,
    "the request id alone matches, so ONLY the method check stops this — a bridging exclusion stores the "
      + "request id exactly as a payment decision does",
  );

  // ---- HEADLINE 4: the supersede does not depend on the unique index existing ------------------
  // The holder is READ before the insert, not inferred from a collision. Leaning on `23505` alone
  // made correctness the index's rather than the code's: drop the index and a re-decision inserts a
  // SECOND live row, which balanceSettledDaysInPeriod would sum on top of the first.
  const noIndex = ledger({ rows: [ownEarlierDecision()], noUniqueIndex: true });
  await recordVacationSettlementDecision(
    { runId: "copilot-run", candidate: { ...candidate(), balanceDaysToConsume: 2 }, method: "defer_to_balance", decidedBy: "B-10" },
    noIndex.client,
  );
  assert.equal(
    noIndex.liveRows().length,
    1,
    "HEADLINE: one live row per employee+date even with no unique index to force the issue — two would "
      + "double-count the employee's consumed leave balance, and nothing would have errored",
  );
  assert.notEqual(
    noIndex.findById("row-own-earlier")?.superseded_at,
    null,
    "the predecessor is superseded because the holder was READ, not because an insert collided",
  );

  // And with no index, a slot held by somebody else is still left alone rather than overwritten.
  const noIndexForeign = ledger({ rows: [foreignCorrection()], noUniqueIndex: true });
  await rejects(
    () =>
      recordVacationSettlementDecision(
        { runId: "copilot-run", candidate: candidate(), method: "salary", decidedBy: "B-10" },
        noIndexForeign.client,
      ),
    "with no index, another decider's row must still block rather than be silently joined by a second live row",
  );
  assert.equal(noIndexForeign.liveRows().length, 1, "and no second live row was written beside it");

  // ---- 'reject' is scoped the same way -------------------------------------------------------
  const rejectForeign = ledger({ rows: [foreignCorrection()] });
  await rejects(
    () =>
      recordVacationSettlementDecision(
        { runId: "copilot-run", candidate: candidate(), method: "reject", decidedBy: "B-10" },
        rejectForeign.client,
      ),
    "rejecting must not retire a settlement this request did not record",
  );
  assert.equal(
    rejectForeign.findById("row-system-correction")?.superseded_at,
    null,
    "reject used to clear whatever held the slot — it now refuses rather than destroy",
  );

  const rejectOwn = ledger({ rows: [ownEarlierDecision()] });
  await recordVacationSettlementDecision(
    { runId: "copilot-run", candidate: candidate(), method: "reject", decidedBy: "B-10" },
    rejectOwn.client,
  );
  assert.notEqual(
    rejectOwn.findById("row-own-earlier")?.superseded_at,
    null,
    "rejecting this request's own settlement still works — that is the whole point of the button",
  );
  assert.equal(rejectOwn.liveRows().length, 0, "and the slot is free again");

  const rejectFree = ledger({ rows: [] });
  await recordVacationSettlementDecision(
    { runId: "copilot-run", candidate: candidate(), method: "reject", decidedBy: "B-10" },
    rejectFree.client,
  );
  assert.equal(rejectFree.liveRows().length, 0, "rejecting a day with no settlement is a no-op, not an error");

  // ---- HEADLINE 5: a bridging exclusion is never read back as a salary settlement ---------------
  // The money-bearing one. `loadExistingSettlements` had no settlement_method filter and coerced
  // every unrecognised method with `: "salary"`, so once the fifth CHECK branch made
  // 'holiday_bridge_excluded' storable, a bridging exclusion sharing the slot read back as a RECORDED
  // SALARY DEDUCTION: the Unpaid Vacation row rendered as already decided, it stopped counting as
  // pending so it no longer blocked sheet generation, and the workbook printed "From salary" with the
  // FULL deduction in its total — while the payroll row deducted nothing, because
  // buildSettledSalaryDeductionTotals filters to salary/partial_balance. Two HR-facing artifacts
  // overstating a deduction the sheet does not take.
  assert.equal(
    SETTLEMENT_PAYMENT_METHODS.length,
    4,
    "the payment methods are exactly salary/balance/partial_balance/defer_to_balance — the set the Unpaid "
      + "Vacation tab filters on, and the set its method coercion accepts",
  );
  for (const method of SETTLEMENT_PAYMENT_METHODS) {
    assert.notEqual(
      method,
      HOLIDAY_BRIDGE_EXCLUDED_METHOD,
      "HEADLINE: the bridging marker must never be inside the payment-method set, or it is read back as a "
        + "settlement decision and priced as one",
    );
  }
  const settlementSource = readFileSync(
    new URL("../src/lib/payroll/copilot/vacation-settlement.ts", import.meta.url),
    "utf8",
  );
  const settlementCode = stripComments(settlementSource);
  assert.ok(
    settlementCode.includes('.in("settlement_method", SETTLEMENT_PAYMENT_METHODS)'),
    "loadExistingSettlements must filter to the payment methods — a bridging exclusion holding the same slot "
      + "is not an answer to 'how was this unpaid leave settled'",
  );
  assert.equal(
    settlementCode.includes(': "salary";'),
    false,
    "HEADLINE: no method coercion may default to 'salary'. An unrecognised method means NO decision was "
      + "recorded here, which leaves the candidate pending and the sheet blocked — failing closed, not into money",
  );

  // ---- The slot reader and its message -------------------------------------------------------
  const readable = ledger({ rows: [foreignCorrection()] });
  const { holder } = await readLiveSettlementSlotHolder(readable.client, SLOT.compact, SLOT.startDate);
  assert.equal(holder?.decidedBy, "system:crm-correction-2026-07-21", "the holder's decider is read, not guessed");
  assert.deepEqual(holder?.vacationRequestIds, [], "a CRM-sourced correction carries no request id — that is the discriminator");
  assert.match(
    await describeSlotHolder(holder!),
    /automated correction \(crm-correction-2026-07-21\)/,
    "a system token is rendered as what it is — an automated correction — never as the raw decided_by code",
  );
  const { holder: none } = await readLiveSettlementSlotHolder(readable.client, "nobody", SLOT.startDate);
  assert.equal(none, null, "a free slot reads as null, never as an error");

  // A row for a DIFFERENT request on the same day is somebody else's too.
  const otherRequest = ledger({ rows: [{ ...ownEarlierDecision(), vacation_request_ids: [OTHER_REQUEST] }] });
  await rejects(
    () =>
      recordVacationSettlementDecision(
        { runId: "copilot-run", candidate: candidate(), method: "salary", decidedBy: "B-10" },
        otherRequest.client,
      ),
    "another request's settlement on the same day is not this request's to retire",
  );
  assert.equal(
    otherRequest.findById("row-own-earlier")?.superseded_at,
    null,
    "the scope is the REQUEST, not merely the employee and the date",
  );
}
