import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { createAccessContext } from "../src/lib/auth/permissions.ts";
import {
  getFinanceCommandCenterData,
  marketingSpendToPay,
  netPayrollTile,
  pickFinanceManagerSeat,
  type FinanceCommandCenterData,
} from "../src/lib/finance/command-center.ts";
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";
import { rpcCalls, withPostgrestStandIn, type StandIn } from "./support/postgrest-stand-in.ts";

// The Super Admin's /admin overview borrows the Finance Manager's "Money in motion" and
// "Workforce" bands. Owner, 27 Nov 2026: every number counts only what is truly that person's own
// turn. Measured on production that day, five figures did not:
//
//   A. "In the finance queue 178 — waiting on the Finance Manager" was counted for the SUPER ADMIN
//      (his 9 leave decisions in, the Finance Manager's 16 Finance Execution steps out).
//   B. "Payroll-eligible 144" / "Cost to company EGP 3.65M" counted the bare payroll_eligible flag,
//      which is also true on 15 historical payroll records and 2 system placeholders (the app's own
//      v_payroll_eligible_employees: 127, EGP 3.29M).
//   C. "Marketing spend to pay EGP 5,500" was one deliberate finance_hold; 16 requests, EGP 88,700,
//      sat at the Finance Execution step with status still pending_approval.
//   D. "Direct orders unbooked — oldest 94 days" was clocked on decided_at; the owner rule is
//      collection_date (85 days).
//   E. "Net payroll EGP 2.67M · 144 payroll-eligible" paired October's net (116 paid) with today's
//      headcount.

const MIGRATIONS_DIR = "supabase/migrations";

/** The live definition of phx_finance_command_center: the newest migration that creates it. */
function latestFinanceCommandCenterMigration(): { name: string; sql: string } {
  const files = readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith(".sql")).sort();
  for (let index = files.length - 1; index >= 0; index -= 1) {
    const sql = readFileSync(`${MIGRATIONS_DIR}/${files[index]}`, "utf8");
    if (/create\s+or\s+replace\s+function\s+public\.phx_finance_command_center\s*\(/i.test(sql)) {
      return { name: files[index]!, sql: stripSqlComments(sql).replace(/\s+/g, " ") };
    }
  }
  throw new Error("no migration defines phx_finance_command_center");
}

function testQueueIsTheFinanceManagersSeatNotTheViewers() {
  assert.equal(pickFinanceManagerSeat([]), null, "nobody in the seat is null, never somebody else's queue");
  assert.equal(pickFinanceManagerSeat(["  ", ""]), null, "blank ids are nobody");
  assert.equal(pickFinanceManagerSeat(["FM-9"]), "FM-9", "the one current holder is the seat");
  assert.equal(
    pickFinanceManagerSeat(["Z-1", "B-185"]),
    "B-185",
    "with two holders, the one who also holds Finance's direct-order duty wins (finance-authority.ts)",
  );
  assert.equal(pickFinanceManagerSeat(["Z-2", "Z-1", "Z-2"]), "Z-1", "otherwise the first by HR id, so the answer is stable");

  const overview = stripComments(readFileSync("src/lib/admin/system-overview.ts", "utf8"));
  assert.match(
    overview,
    /getFinanceCommandCenterData\(access,\s*\{\s*queueOwner:\s*"finance-manager"\s*\}\)/,
    "HEADLINE A: the Super Admin's overview asks for the Finance Manager's own queue, never its viewer's",
  );
}

async function testQueueOwnerReachesTheAggregate() {
  const SUPER_ADMIN = createAccessContext({ hrId: "B-10", loginId: "owner", role: "Super Admin", source: "session" });
  const PAYLOAD = { generatedAt: "2026-11-27T10:00:00.000Z" };

  {
    const standIn: StandIn = {
      rpc: { phx_finance_command_center: () => PAYLOAD },
      tables: {
        app_auth_users: [
          { hr_id: "B-10", is_active: true, role: "Super Admin" },
          { hr_id: "FM-9", is_active: true, role: "Finance Manager" },
          { hr_id: "FM-OLD", is_active: false, role: "Finance Manager" },
        ],
        automated_payroll_runs: [],
        employees: [{ employment_status: "active", hr_id: "FM-9" }],
      },
    };
    await withPostgrestStandIn(standIn, async (seen) => {
      const view = await getFinanceCommandCenterData(SUPER_ADMIN, { queueOwner: "finance-manager" });
      const [call] = rpcCalls(seen, "phx_finance_command_center");
      assert.equal(
        (call?.body as Record<string, unknown>).p_actor_hr_id,
        "FM-9",
        "HEADLINE A: the band is computed for the Finance Manager holding the seat, not the Super Admin reading it",
      );
      assert.deepEqual(view.unavailable, [], "the seat was read: nothing to name");

      await getFinanceCommandCenterData(SUPER_ADMIN);
      assert.equal(
        (rpcCalls(seen, "phx_finance_command_center")[1]?.body as Record<string, unknown>).p_actor_hr_id,
        SUPER_ADMIN.hrId,
        "without the option a page still counts its own viewer's queue (the Finance Manager's own page)",
      );
    });
  }

  {
    const standIn: StandIn = {
      rpc: { phx_finance_command_center: () => PAYLOAD },
      tables: { app_auth_users: [{ hr_id: "B-10", is_active: true, role: "Super Admin" }], automated_payroll_runs: [], employees: [] },
    };
    await withPostgrestStandIn(standIn, async (seen) => {
      const view = await getFinanceCommandCenterData(SUPER_ADMIN, { queueOwner: "finance-manager" });
      assert.equal(
        (rpcCalls(seen, "phx_finance_command_center")[0]?.body as Record<string, unknown>).p_actor_hr_id,
        null,
        "an empty seat never falls back to the viewer's own queues under the Finance Manager's name",
      );
      assert.ok(
        view.unavailable.some((source) => /Finance Manager's own queues/.test(source)),
        "and the page names the seat it could not read instead of printing a confident count",
      );
    });
  }
}

function testPayrollPopulationIsTheAppsOwnView() {
  const { name, sql } = latestFinanceCommandCenterMigration();
  const eligible = "hr_id in \\(select v\\.hr_id from public\\.v_payroll_eligible_employees v\\)";
  for (const [key, expr] of [
    ["payrollEligible", "count\\(\\*\\)"],
    ["standingNet", "round\\(coalesce\\(sum\\(net_salary\\)"],
    ["standingGross", "round\\(coalesce\\(sum\\(gross_salary\\)"],
  ] as const) {
    assert.match(
      sql,
      new RegExp(`'${key}', ${expr} filter \\(where ${eligible}\\)`),
      `HEADLINE B (${name}): ${key} counts v_payroll_eligible_employees' population, never the bare flag`,
    );
  }
  assert.equal(
    (sql.match(new RegExp(`from public\\.employees where ${eligible};`, "g")) ?? []).length,
    2,
    `${name}: the first/second-payment and FAB/CIB/Treasury splits read the same population, so they still reconcile to the standing net`,
  );
  assert.doesNotMatch(sql, /filter \(where payroll_eligible\)|where payroll_eligible;/, "no figure reads the bare payroll_eligible flag");
}

function testUnbookedAgeIsClockedOnCollection() {
  const { name, sql } = latestFinanceCommandCenterMigration();
  assert.match(
    sql,
    /'awaitingOldest', min\(collection_date\) filter \(where lower\(coalesce\(status, ''\)\) = 'approved' and sales_month is null\)/,
    `HEADLINE D (${name}): the oldest unbooked order is clocked on collection_date (direct-order-sales-month-is-finance-owned)`,
  );
  assert.doesNotMatch(sql, /'awaitingOldest', min\(decided_at\)/, "never on the approval date");
}

function testSpendToPayIsWhatWaitsOnFinance() {
  const { name, sql } = latestFinanceCommandCenterMigration();
  assert.ok(sql.includes("'dueUnexecutedCount'") && sql.includes("'inApprovalCount'"), `${name}: the marketing figures are defined`);
  assert.doesNotMatch(
    sql.slice(sql.indexOf("'dueUnexecutedCount'"), sql.indexOf("'inApprovalCount'")),
    /finance_hold/,
    "HEADLINE C: a finance_hold is the Super Admin's deliberate pause, so it is in no 'to pay' figure",
  );
  for (const key of ["toPayCount", "toPayValue"]) {
    const at = sql.indexOf(`'${key}'`);
    assert.ok(at >= 0, `${name}: ${key} is returned`);
    const clause = sql.slice(at, sql.indexOf("'inApprovalCount'"));
    assert.match(
      clause,
      /lower\(coalesce\(status, ''\)\) = 'pending_approval' and exists \( select 1 from public\.marketing_request_approval_steps x where x\.request_id = marketing_requests\.id and x\.step_code = 'finance_execution' and lower\(coalesce\(x\.status, ''\)\) = 'current' and coalesce\(x\.is_cc, false\) = false\)/,
      `HEADLINE C: ${key} counts the requests standing at the Finance Execution step`,
    );
    assert.match(
      clause,
      /\(lower\(coalesce\(status, ''\)\) in \('approved', 'active'\) and pay_date is not null\)/,
      `${key} also counts the approved-not-executed queue`,
    );
  }

  assert.deepEqual(
    marketingSpendToPay({ dueUnexecutedCount: 0, dueUnexecutedValue: 0, toPayCount: 16, toPayValue: 88_700 }),
    { count: 16, value: 88_700 },
    "the tile reads the spend waiting on Finance, not the approved-only queue",
  );
  assert.deepEqual(
    marketingSpendToPay({ dueUnexecutedCount: 1, dueUnexecutedValue: 5_500 }),
    { count: 1, value: 5_500 },
    "a payload from the function before the fix still shows its own figure, never a dash",
  );
}

function testNetPayrollNamesThePeopleItWasPaidTo() {
  const data = {
    headcount: { payrollEligible: 144, standingNet: 3_237_000 },
    payroll: {
      committed: [
        { employees: 118, gross: 0, net: 2_600_000, period: "2026-09", status: "locked" },
        { employees: 116, gross: 0, net: 2_666_000, period: "2026-10", status: "approved" },
      ],
    },
  } as unknown as Pick<FinanceCommandCenterData, "headcount" | "payroll">;
  const tile = netPayrollTile(data);
  assert.equal(tile.net, 2_666_000, "the latest committed month's net");
  assert.equal(tile.sub, "116 paid · 10/2026", "HEADLINE E: the subline is the people that net was paid to, from the same batch");
  assert.doesNotMatch(tile.sub, /144/, "never today's headcount beside last month's net");

  const none = netPayrollTile({ ...data, payroll: { ...data.payroll, committed: [] } });
  assert.equal(none.net, 3_237_000, "no committed month yet: the standing roster's net");
  assert.match(none.sub, /not yet paid/, "and it says so");
}

export async function runFinanceOverviewOwnTurnTests(): Promise<void> {
  testQueueIsTheFinanceManagersSeatNotTheViewers();
  await testQueueOwnerReachesTheAggregate();
  testPayrollPopulationIsTheAppsOwnView();
  testUnbookedAgeIsClockedOnCollection();
  testSpendToPayIsWhatWaitsOnFinance();
  testNetPayrollNamesThePeopleItWasPaidTo();
}
