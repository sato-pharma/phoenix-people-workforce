import assert from "node:assert/strict";

import {
  settleCrmLeaveBalanceForPeriod,
  type CrmLeaveBalanceSettlement,
} from "../src/lib/automated-payroll/recommend.ts";

/**
 * A PAYROLL RUN NEVER RETIRES A LEAVE SETTLEMENT IT CANNOT REPLACE, AND NEVER ONE IT DID NOT WRITE.
 *
 * THE RULE (owner, 2026-07-21). A vacation day, CRM-sourced or from a formal Phoenix request,
 * subtracts from the leave balance first; salary covers only what the balance cannot. Confirming
 * the Part 2 vacation step is the moment CRM-only leave becomes real: it writes a row into
 * payroll_copilot_vacation_settlements, which every later balance check sums.
 *
 * THE DEFECT, BOTH HALVES OF IT, MEASURED ON PRODUCTION 2026-10-01.
 *
 * `settleCrmLeaveBalanceForPeriod` superseded FIRST and inserted SECOND. The supersede was scoped
 * to employee_hr_id_compact + start_date and nothing else — so it retired whatever live row held
 * that slot, whoever had written it — and its error was never read. The insert that was supposed
 * to replace it has never once succeeded: it sets `run_id` to an automated_payroll_runs id while
 * the column is a foreign key onto payroll_copilot_runs (all three automated run ids fail it), so
 * every insert is refused `23503`, logged, and skipped with `continue`.
 *
 * Net effect of a confirm: destroy a row, write nothing. It fired. On 2026-08-04 07:49:03 Cairo the
 * July run's first confirm retired Khaled Mohamed Ali Bedair's 1.00-day balance settlement of
 * 2026-07-12 — written by `system:crm-correction-2026-07-21`, not by any payroll run — and nothing
 * replaced it. All 8 p2_vacation confirms on production recorded `crmLeaveBalanceSettled` null.
 *
 * THE FIX. The insert is attempted first with nothing retired. A failure that is not the live-row
 * collision (`23505` on payroll_copilot_vacation_settlements_live_idx) leaves the ledger untouched.
 * Only that collision justifies a supersede, only this run's OWN earlier row may be superseded by
 * it, and the supersede's error is read.
 *
 * Postgres raises the unique violation BEFORE the foreign-key one — the index insertion happens
 * inside the row insert, the FK is an AFTER-ROW trigger — so the fake below does the same. That
 * ordering is the whole reason "stop at a non-collision error" is not sufficient on its own and the
 * holder has to be identified: with the FK broken AND a slot held, the run sees `23505` first and
 * would walk straight into retiring somebody else's decision.
 */

type Row = Record<string, unknown>;

const SLOT = { compact: "a2", startDate: "2026-07-12" };
const THIS_RUN = "automated-run-july";
/** The id the broken foreign key cannot satisfy — stands in for an automated_payroll_runs id. */
const UNKNOWN_TO_FK = "automated-run-july";

/** The row `system:crm-correction-2026-07-21` wrote for Khaled, as production held it. */
function foreignDecision(): Row {
  return {
    id: "row-system-correction",
    employee_hr_id: "A-2",
    employee_hr_id_compact: SLOT.compact,
    start_date: SLOT.startDate,
    unpaid_days: 1,
    settlement_method: "balance",
    balance_days_consumed: 1,
    salary_deduction_amount: null,
    run_id: null,
    decided_by: "system:crm-correction-2026-07-21",
    superseded_at: null,
  };
}

/** The same slot, but held by this run's own earlier confirm — the legitimate re-confirm case. */
function ownEarlierDecision(): Row {
  return { ...foreignDecision(), id: "row-own-earlier", run_id: THIS_RUN, decided_by: "B-10", balance_days_consumed: 1 };
}

function settlementInput(): CrmLeaveBalanceSettlement {
  return {
    balanceDaysConsumed: 2,
    compact: SLOT.compact,
    employeeHrId: "A-2",
    salaryDeductionAmount: 0,
    startDate: SLOT.startDate,
    totalDays: 2,
    unpaidDays: 0,
  };
}

/**
 * A tiny ledger that enforces the two constraints that actually decide this behaviour: the partial
 * unique index over (employee_hr_id_compact, start_date) WHERE superseded_at IS NULL, and the
 * run_id foreign key. Purpose-built rather than reusing fixtures/fake-supabase-table.ts, which
 * models predicates but not error CODES or indexes — and the codes are the whole mechanism here.
 */
function ledger(options: { rows?: Row[]; fkAccepts?: string[]; supersedeFails?: boolean } = {}) {
  const rows: Row[] = (options.rows ?? []).map((row) => ({ ...row }));
  const fkAccepts = new Set(options.fkAccepts ?? []);
  let inserted = 0;

  const live = () => rows.filter((row) => row.superseded_at === null);

  function doInsert(payload: Row): { error: { code: string; message: string } | null } {
    // Unique index first, exactly as Postgres orders it.
    const collides = live().some(
      (row) => row.employee_hr_id_compact === payload.employee_hr_id_compact && row.start_date === payload.start_date,
    );
    if (collides) {
      return {
        error: {
          code: "23505",
          message: 'duplicate key value violates unique constraint "payroll_copilot_vacation_settlements_live_idx"',
        },
      };
    }
    const runId = payload.run_id === null || payload.run_id === undefined ? null : String(payload.run_id);
    if (runId !== null && !fkAccepts.has(runId)) {
      return {
        error: {
          code: "23503",
          message:
            'insert or update on table "payroll_copilot_vacation_settlements" violates foreign key constraint '
            + '"payroll_copilot_vacation_settlements_run_id_fkey"',
        },
      };
    }
    inserted += 1;
    rows.push({ ...payload, id: `row-inserted-${inserted}`, superseded_at: null });
    return { error: null };
  }

  function builder() {
    const filters: Array<(row: Row) => boolean> = [];
    let mode: "select" | "insert" | "update" = "select";
    let payload: Row = {};
    let columns: string[] | null = null;

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
      maybeSingle() {
        const matched = rows.filter((row) => filters.every((keep) => keep(row)));
        if (matched.length === 0) return Promise.resolve({ data: null, error: null });
        const row = matched[0];
        const projected = columns
          ? Object.fromEntries(columns.map((name) => [name, row[name] ?? null]))
          : row;
        return Promise.resolve({ data: projected, error: null });
      },
      then(resolve: (value: { data: unknown; error: unknown }) => unknown) {
        if (mode === "insert") return resolve({ data: null, ...doInsert(payload) });
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
  };
}

export async function runAutomatedPayrollCrmLeaveSettlementSlotTests() {
  // ---- HEADLINE: the Khaled case. Broken FK, slot held by a system correction. ---------------
  // This is production as it stood on 2026-08-04. The old code superseded the system correction
  // and then failed its insert, leaving the day counting against nobody's balance.
  const khaled = ledger({ rows: [foreignDecision()], fkAccepts: [] });
  const broken = await settleCrmLeaveBalanceForPeriod(
    { actorHrId: "B-10", crmLeaveSettlements: [settlementInput()], runId: UNKNOWN_TO_FK },
    khaled.client,
  );
  assert.equal(
    broken.settled,
    0,
    "the insert cannot satisfy the run_id foreign key, so nothing is settled — that part was always true",
  );
  const khaledLive = khaled.liveRows();
  assert.equal(
    khaledLive.length,
    1,
    "the slot must still hold exactly one live settlement. Superseding it and then failing to insert "
      + "is what took Khaled Mohamed Ali Bedair's 2026-07-12 leave day off his balance on 2026-08-04",
  );
  assert.equal(
    khaledLive[0].decided_by,
    "system:crm-correction-2026-07-21",
    "and it must still be the SYSTEM CORRECTION's own row — a payroll run may not retire a decision it did not make",
  );
  assert.equal(khaledLive[0].superseded_at, null, "the system correction's row must not carry a superseded stamp");

  // ---- A working FK does not entitle the run to the slot either -------------------------------
  // The FK fix alone is not enough: with the slot held by somebody else, an unscoped supersede
  // would still retire their decision — now successfully replacing it with the run's own figures,
  // which is worse, because it looks like it worked.
  const foreignHeld = ledger({ rows: [foreignDecision()], fkAccepts: [THIS_RUN] });
  const skipped = await settleCrmLeaveBalanceForPeriod(
    { actorHrId: "B-10", crmLeaveSettlements: [settlementInput()], runId: THIS_RUN },
    foreignHeld.client,
  );
  assert.equal(skipped.settled, 0, "a slot held by another decider is reported, not taken");
  assert.equal(foreignHeld.liveRows().length, 1, "still one live row");
  assert.equal(
    foreignHeld.liveRows()[0].decided_by,
    "system:crm-correction-2026-07-21",
    "the other decider's row survives a run whose insert would otherwise have succeeded",
  );

  // ---- THE RE-CONFIRM CASE STILL WORKS -------------------------------------------------------
  // HR correcting a row and confirming the step again is the normal way the wizard is used. This
  // run's OWN earlier answer is its to replace, and the replacement must actually land.
  const reconfirm = ledger({ rows: [ownEarlierDecision()], fkAccepts: [THIS_RUN] });
  const again = await settleCrmLeaveBalanceForPeriod(
    { actorHrId: "B-10", crmLeaveSettlements: [settlementInput()], runId: THIS_RUN },
    reconfirm.client,
  );
  assert.equal(again.settled, 1, "a re-confirm replaces this run's own earlier settlement");
  const reconfirmLive = reconfirm.liveRows();
  assert.equal(reconfirmLive.length, 1, "exactly one live row survives a re-confirm — never two");
  assert.equal(
    Number(reconfirmLive[0].balance_days_consumed),
    2,
    "and it carries the NEW figure, not the superseded one",
  );
  assert.equal(
    reconfirm.rows().find((row) => row.id === "row-own-earlier")?.superseded_at === null,
    false,
    "the run's own earlier row must be stamped superseded, or the unique index would hold two live rows",
  );

  // ---- An empty slot needs no supersede at all ------------------------------------------------
  const empty = ledger({ rows: [], fkAccepts: [THIS_RUN] });
  const fresh = await settleCrmLeaveBalanceForPeriod(
    { actorHrId: "B-10", crmLeaveSettlements: [settlementInput()], runId: THIS_RUN },
    empty.client,
  );
  assert.equal(fresh.settled, 1, "a clean slot settles on the first insert");
  assert.equal(empty.liveRows().length, 1, "one live row");

  // ---- A FAILED SUPERSEDE IS READ, NOT DROPPED -----------------------------------------------
  // The old code discarded this error entirely. If the supersede fails the earlier row still
  // stands, so the replacement cannot be inserted and the run must not claim it settled anything.
  const stuck = ledger({ rows: [ownEarlierDecision()], fkAccepts: [THIS_RUN], supersedeFails: true });
  const refused = await settleCrmLeaveBalanceForPeriod(
    { actorHrId: "B-10", crmLeaveSettlements: [settlementInput()], runId: THIS_RUN },
    stuck.client,
  );
  assert.equal(refused.settled, 0, "a failed supersede must not be counted as a settlement");
  assert.equal(stuck.liveRows().length, 1, "the earlier row still stands");
  assert.equal(
    Number(stuck.liveRows()[0].balance_days_consumed),
    1,
    "and it still carries its own figure — the run wrote nothing",
  );

  // ---- A zero-day settlement is not written at all -------------------------------------------
  const zero = ledger({ rows: [], fkAccepts: [THIS_RUN] });
  const none = await settleCrmLeaveBalanceForPeriod(
    {
      actorHrId: "B-10",
      crmLeaveSettlements: [{ ...settlementInput(), totalDays: 0 }],
      runId: THIS_RUN,
    },
    zero.client,
  );
  assert.equal(none.settled, 0, "nothing to settle");
  assert.equal(zero.liveRows().length, 0, "and nothing written — unpaid_days > 0 is a table constraint");

  console.log("  automated payroll CRM leave settlement slot: 16 assertions passed");
}
