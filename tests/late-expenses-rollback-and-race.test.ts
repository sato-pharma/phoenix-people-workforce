import assert from "node:assert/strict";

import type { AccessContext } from "../src/lib/auth/permissions.ts";
import {
  getCarryLateExpensesSetting,
  LateExpenseRefusal,
  reserveLateExpenses,
  setCarryLateExpenses,
  type LateExpenseCarriedEntry,
  type LateExpenseDb,
} from "../src/lib/automated-payroll/late-expenses.ts";
// Loaded up front so the error row a refusal logs resolves its module from the cache and lands inside
// the stand-in below, never after it has been taken down.
import "../src/lib/error-monitor/service.ts";
import { withStandIn } from "./support/postgrest-transaction-stand-in.ts";

/**
 * LATE-APPROVED EXPENSE CARRY — WHAT A FAILURE LEAVES BEHIND, AND WHO WINS A RACE (REC-029 / F-PAY-012).
 *
 * An outstation trip approved after its payout month was paid can be carried into the next run, but only
 * while the owner's switch is on (it starts OFF; nothing here turns it on for real — every call goes to
 * the in-memory database below). The earlier tests mostly pinned the refusal a losing caller reads. These
 * call the REAL functions in src/lib/automated-payroll/late-expenses.ts through their `client` seam and
 * check what is STORED afterwards:
 *
 *   1. Two payroll runs reserving the SAME trip at once: exactly one reserves it, the other is refused
 *      with a LateExpenseRefusal naming the run that holds it, and one reservation row is left.
 *   2. A reservation whose insert fails after the run's earlier reservations were released: the caller is
 *      refused, nothing else is written, and the stored reservations are what they were (a run being
 *      confirmed normally holds none, and another run's reservation is never touched).
 *   3. The switch: when its required audit row cannot be written after the setting was saved, the stored
 *      setting is put back — checked in the TABLE, not only in the write log — and the caller is told it
 *      was not changed; when the put-back fails too, the table still reads the new value and the caller
 *      is told it WAS changed.
 *
 * Every function is handed the in-memory client below. Around all of it the shared stand-in
 * (tests/support/postgrest-transaction-stand-in.ts) holds the real admin client, so the only thing that may reach it
 * is the error row a refusal logs — any other request means a write bypassed the client it was handed —
 * and nothing can reach a real host.
 *
 * The in-memory database answers every request on the next turn of the event loop, in the order the
 * requests were made, so two callers started together interleave exactly as two server requests do: each
 * moves one database call at a time. Inserts honour a primary key, upserts change the stored row, deletes
 * remove rows, and any one write can be made to fail.
 */

type Row = Record<string, unknown>;
type Op = "select" | "insert" | "upsert" | "delete";
type DbError = { message: string; code?: string };
type TableSpec = { rows: Row[]; primaryKey?: string };
type Failure = { table: string; op: Op; nth: number; error: DbError };
type Step = { table: string; op: Op; payload: unknown; error: DbError | null };

/** The tables' rows, deep-copied, for "the stored state afterwards equals the state before". */
function rowsOf(tables: Record<string, TableSpec>): Record<string, Row[]> {
  return JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(tables).map(([name, spec]) => [name, spec.rows])))) as Record<string, Row[]>;
}

/**
 * A client over shared tables. Every request — read or write — is logged in `steps` when it is answered;
 * `failures` makes the nth write of one kind to one table fail.
 */
function memoryDb(tables: Record<string, TableSpec>, steps: Step[], failures: Failure[] = []): LateExpenseDb {
  const counts = new Map<string, number>();
  return {
    from(table: string) {
      const spec = (tables[table] ??= { rows: [] });
      const filters: Array<(row: Row) => boolean> = [];
      let range: [number, number] | null = null;
      let single = false;
      let op: Op = "select";
      let payload: unknown = null;
      let conflictColumns: string[] = [];

      const answer = (): { data: unknown; error: DbError | null } => {
        if (op === "select") {
          let rows = spec.rows.filter((row) => filters.every((filter) => filter(row)));
          if (range) rows = rows.slice(range[0], range[1] + 1);
          const data = JSON.parse(JSON.stringify(single ? (rows[0] ?? null) : rows)) as unknown;
          steps.push({ error: null, op, payload: null, table });
          return { data, error: null };
        }
        const key = `${table}|${op}`;
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        const failure = failures.find((candidate) => candidate.table === table && candidate.op === op && candidate.nth === count);
        if (failure) {
          steps.push({ error: failure.error, op, payload, table });
          return { data: null, error: failure.error };
        }
        const incoming = (Array.isArray(payload) ? payload : [payload]) as Row[];
        if (op === "delete") {
          spec.rows = spec.rows.filter((row) => !filters.every((filter) => filter(row)));
        } else if (op === "insert") {
          const pk = spec.primaryKey;
          if (pk && incoming.some((row) => spec.rows.some((existing) => existing[pk] === row[pk]))) {
            const duplicate = { code: "23505", message: `duplicate key value violates unique constraint "${table}_pkey"` };
            steps.push({ error: duplicate, op, payload, table });
            return { data: null, error: duplicate };
          }
          spec.rows.push(...incoming.map((row) => ({ ...row })));
        } else {
          for (const row of incoming) {
            const existing = spec.rows.find((current) => conflictColumns.every((column) => current[column] === row[column]));
            if (existing) Object.assign(existing, row);
            else spec.rows.push({ ...row });
          }
        }
        steps.push({ error: null, op, payload, table });
        return { data: null, error: null };
      };

      const builder: Record<string, unknown> = {
        delete: () => {
          op = "delete";
          return builder;
        },
        eq: (column: string, value: unknown) => {
          filters.push((row) => row[column] === value);
          return builder;
        },
        in: (column: string, values: unknown[]) => {
          filters.push((row) => values.includes(row[column]));
          return builder;
        },
        insert: (value: unknown) => {
          op = "insert";
          payload = value;
          return builder;
        },
        is: (column: string, value: unknown) => {
          filters.push((row) => (row[column] ?? null) === value);
          return builder;
        },
        limit: () => builder,
        maybeSingle: () => {
          single = true;
          return builder;
        },
        order: () => builder,
        range: (from: number, to: number) => {
          range = [from, to];
          return builder;
        },
        select: () => builder,
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          new Promise((settled) => {
            setImmediate(() => {
              try {
                settled(resolve(answer()));
              } catch (error) {
                settled(reject(error));
              }
            });
          }),
        upsert: (value: unknown, options?: { onConflict?: string }) => {
          op = "upsert";
          payload = value;
          conflictColumns = (options?.onConflict ?? "id").split(",").map((part) => part.trim());
          return builder;
        },
      };
      return builder;
    },
  } as unknown as LateExpenseDb;
}

const NAMES = new Map([["b12", "Dina Hamdy Fadel"]]);
const SEPTEMBER_TRIP: LateExpenseCarriedEntry = { amount: 400, compact: "b12", expenseDate: "2026-09-10", id: "sep-trip-1", payoutMonth: 9, payoutYear: 2026 };
const superAdmin = { hrId: "b10", role: "Super Admin", scope: "all", source: "session" } as unknown as AccessContext;

const RESERVATIONS = "automated_payroll_carried_expenses";

function runs(): TableSpec {
  return {
    rows: [
      { id: "run-nov", month: 11, phase: "part2", year: 2026 },
      { id: "run-dec", month: 12, phase: "part2", year: 2026 },
    ],
  };
}

async function twoRunsReserveTheSameTripAtOnce(): Promise<void> {
  const tables: Record<string, TableSpec> = { [RESERVATIONS]: { primaryKey: "expense_id", rows: [] }, automated_payroll_runs: runs() };
  const steps: Step[] = [];
  const results = await Promise.allSettled([
    reserveLateExpenses("run-nov", [SEPTEMBER_TRIP], NAMES, memoryDb(tables, steps)),
    reserveLateExpenses("run-dec", [SEPTEMBER_TRIP], NAMES, memoryDb(tables, steps)),
  ]);

  const reservationSteps = steps.filter((step) => step.table === RESERVATIONS);
  const firstInsert = reservationSteps.findIndex((step) => step.op === "insert");
  const readsBeforeInsert = reservationSteps.slice(0, firstInsert).filter((step) => step.op === "select").length;
  assert.ok(readsBeforeInsert >= 2, "RACE: both runs looked for another holder before either wrote — a real race, not one after the other");
  const inserts = reservationSteps.filter((step) => step.op === "insert");
  assert.equal(inserts.length, 2, "RACE: both runs attempted the reservation");
  assert.equal(inserts.filter((step) => step.error?.code === "23505").length, 1, "RACE: the trip's key refused the second insert");

  const won = results.filter((result) => result.status === "fulfilled");
  const lost = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.equal(won.length, 1, "RACE: exactly one of the two runs reserves the trip");
  assert.equal(lost.length, 1, "RACE: and exactly one is refused");
  assert.equal(tables[RESERVATIONS].rows.length, 1, "RACE: one reservation row is left");
  const [reservation] = tables[RESERVATIONS].rows;
  assert.equal(reservation.expense_id, "sep-trip-1", "RACE: for the trip");
  const winner = reservation.run_id;
  assert.ok(winner === "run-nov" || winner === "run-dec", "RACE: held by one of the two runs");
  const refusal = lost[0].reason as unknown;
  assert.ok(refusal instanceof LateExpenseRefusal, "RACE: the loser is told with a LateExpenseRefusal, so its Expenses figure is cleared");
  assert.match(
    refusal.message,
    new RegExp(`^Conflict: Dina Hamdy Fadel's trip of 2026-09-10 \\(carried from September 2026\\) is already being paid by the ${winner === "run-nov" ? "November" : "December"} 2026 payroll run\\. Nothing was confirmed`),
    "RACE: the refusal names the trip and the run that holds it",
  );
  assert.deepEqual(refusal.compacts, ["b12"], "RACE: and the person whose figure must be cleared");
}

async function aFailedReservationLeavesTheReservationsAsTheyWere(): Promise<void> {
  // Another run already holds a different trip; the run being confirmed holds none, as a run arriving
  // at its Part 2 confirm normally does (a reopen or a cancel releases them).
  const tables: Record<string, TableSpec> = {
    [RESERVATIONS]: { primaryKey: "expense_id", rows: [{ expense_id: "aug-trip-7", run_id: "run-dec" }] },
    automated_payroll_runs: runs(),
  };
  const before = rowsOf(tables);
  const steps: Step[] = [];
  let outcome: unknown = "reserved";
  try {
    await reserveLateExpenses(
      "run-nov",
      [SEPTEMBER_TRIP],
      NAMES,
      memoryDb(tables, steps, [{ error: { code: "57014", message: "canceling statement due to statement timeout" }, nth: 1, op: "insert", table: RESERVATIONS }]),
    );
  } catch (error) {
    outcome = error;
  }
  assert.ok(outcome instanceof Error, "RESERVE FAILS: the caller is refused — a reservation that did not land is never answered as reserved");
  assert.match(
    outcome.message,
    /^Conflict: the carried outstation trips could not be reserved for this run, so nothing was confirmed\. Confirm Part 2 again in a moment\./,
    "RESERVE FAILS: and is told nothing was confirmed",
  );
  const writes = steps.filter((step) => step.op !== "select");
  assert.deepEqual(
    writes.map((step) => `${step.op} ${step.table}${step.error ? " (failed)" : ""}`),
    [`delete ${RESERVATIONS}`, `insert ${RESERVATIONS} (failed)`],
    "RESERVE FAILS: the release of its own reservations, then the refused insert — and no write after it",
  );
  assert.deepEqual(rowsOf(tables), before, "RESERVE FAILS: the stored reservations are exactly as they were — still none for this run, the other run's untouched");
}

async function theSwitchIsPutBackWhenItsAuditRowFails(): Promise<void> {
  const settingsBefore = { carry_late_expenses: false, id: 1, updated_at: "2026-11-01T08:00:00+00:00", updated_by_hr_id: "b10" };
  const auditDown: Failure = { error: { code: "57014", message: "canceling statement due to statement timeout" }, nth: 1, op: "insert", table: "automated_payroll_audit" };

  // The audit row fails, the put-back works: the setting the TABLE holds is the old one again.
  {
    const tables: Record<string, TableSpec> = {
      automated_payroll_audit: { rows: [] },
      automated_payroll_runs: { rows: [{ id: "run-oct", month: 10, phase: "published", year: 2026 }] },
      automated_payroll_settings: { rows: [{ ...settingsBefore }] },
    };
    const steps: Step[] = [];
    const reopened: string[] = [];
    const db = memoryDb(tables, steps, [auditDown]);
    let outcome: unknown = "changed";
    try {
      await setCarryLateExpenses(superAdmin, true, db, { reopenExpensesStep: async (runId) => reopened.push(runId) });
    } catch (error) {
      outcome = error;
    }
    assert.ok(outcome instanceof Error, "SWITCH AUDIT FAILS: the caller is refused — a switch change nobody can trace is never answered as changed");
    assert.match(outcome.message, /^Conflict: Could not record the change to the payroll switch, so it was not changed\./, "SWITCH AUDIT FAILS: and is told it was not changed");
    assert.equal(tables.automated_payroll_settings.rows.length, 1, "SWITCH AUDIT FAILS: still one settings row");
    assert.equal(tables.automated_payroll_settings.rows[0].carry_late_expenses, false, "SWITCH AUDIT FAILS: the stored switch is back to what it was (OFF)");
    assert.equal(await getCarryLateExpensesSetting(memoryDb(tables, [])), false, "SWITCH AUDIT FAILS: and the switch reads OFF through the domain's own reader");
    assert.deepEqual(tables.automated_payroll_audit.rows, [], "SWITCH AUDIT FAILS: no audit row was stored");
    assert.deepEqual(reopened, [], "SWITCH AUDIT FAILS: no open run's Expenses step was reopened — a published run is not open");
    assert.deepEqual(
      steps.filter((step) => step.op !== "select").map((step) => `${step.op} ${step.table}${step.error ? " (failed)" : ""}`),
      ["upsert automated_payroll_settings", "insert automated_payroll_audit (failed)", "upsert automated_payroll_settings"],
      "SWITCH AUDIT FAILS: the setting, the refused audit row, the put-back — and nothing else",
    );
  }

  // The audit row fails AND the put-back fails: the table really holds ON, and the caller is told so.
  {
    const tables: Record<string, TableSpec> = {
      automated_payroll_audit: { rows: [] },
      automated_payroll_runs: { rows: [] },
      automated_payroll_settings: { rows: [{ ...settingsBefore }] },
    };
    const db = memoryDb(tables, [], [auditDown, { error: { code: "57014", message: "canceling statement due to statement timeout" }, nth: 2, op: "upsert", table: "automated_payroll_settings" }]);
    let outcome: unknown = "changed";
    try {
      await setCarryLateExpenses(superAdmin, true, db, { reopenExpensesStep: async () => undefined });
    } catch (error) {
      outcome = error;
    }
    assert.equal(tables.automated_payroll_settings.rows[0].carry_late_expenses, true, "SWITCH PUT-BACK FAILS: the table holds ON");
    assert.ok(outcome instanceof Error, "SWITCH PUT-BACK FAILS: the caller is still refused");
    assert.match(
      outcome.message,
      /^Conflict: the payroll switch WAS changed to ON, but no record of the change could be written/,
      "SWITCH PUT-BACK FAILS: and is told the truth about the table — it WAS changed, never that it was not",
    );
  }
}

export async function runLateExpensesRollbackAndRaceTests(): Promise<void> {
  await withStandIn({ tables: {} }, async (seen) => {
    await twoRunsReserveTheSameTripAtOnce();
    await aFailedReservationLeavesTheReservationsAsTheyWere();
    await theSwitchIsPutBackWhenItsAuditRowFails();
    for (let turn = 0; turn < 40; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(
      seen.filter((request) => request.table !== "app_error_events").map((request) => `${request.method} ${request.table ?? request.rpc}`),
      [],
      "every database call went through the client each function was handed — none reached the shared admin client",
    );
  });
}
