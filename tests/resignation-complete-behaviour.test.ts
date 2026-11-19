import assert from "node:assert/strict";

import { createAccessContext } from "../src/lib/auth/permissions.ts";
import { ApiError } from "../src/lib/http/api-errors.ts";
import { runResignationWorkflow } from "../src/lib/resignations/service.ts";
import { registryModuleRow, rpcCalls, withPostgrestStandIn, writesTo, writtenRow, type Row, type Seen, type StandIn } from "./support/postgrest-stand-in.ts";

// REC-078 (phase 2): completing a resignation, run end to end — not read.
//
// tests/resignation-complete-order.test.ts proves completeResignationInOrder with injected steps.
// This drives the REAL entry the Resignations screen calls, runResignationWorkflow(…, "complete"),
// against the shared in-memory PostgREST, so the order is read off the requests the code actually
// makes (#356, REC-028):
//
//   1. The employee is ended FIRST — the employees row (status, payroll, organogram, CRM slot), the
//      sign-in, the vacancy link, the organogram seat — and the resignation is stamped "completed"
//      LAST: no employee-side write ever follows the stamp.
//   2. A step that fails leaves the resignation Approved, answers 409 naming the step, and pressing
//      Complete again once the fault is gone finishes it — every step is a re-assertion.
//   3. A resignation whose employee row matches nobody is refused at step 1, before anyone's login,
//      seat or resignation is touched.

const RESIGNATION_ID = "55555555-5555-4555-8555-555555555555";
const READ_AT = "2026-11-10T08:00:00.000000+00:00";
const OWNER = createAccessContext({ hrId: "B-10", loginId: "b-10", role: "Super Admin", source: "session" });

function world(overrides: { employees?: Row[] } = {}): Record<string, Row[]> {
  return {
    app_auth_users: [{ hr_id: "MR-55", is_active: true, login_id: "mr.fifty.five", name: "Stand-in Leaver", role: "Medical Rep" }],
    employee_resignations: [
      {
        approved_at: "2026-11-05T09:00:00+00:00",
        approved_by: "B-10",
        create_vacancy: false,
        created_at: "2026-11-01T09:00:00+00:00",
        effective_date: "2026-11-15",
        employee_hr_id: "MR-55",
        employee_name: "Stand-in Leaver",
        exit_status: "approved",
        id: RESIGNATION_ID,
        last_working_date: "2026-11-15",
        reason: "Moving abroad",
        resignation_date: "2026-11-01",
        status: "approved",
        submitted_date: "2026-11-01",
        updated_at: READ_AT,
        vacancy_id: null,
        workflow_notes: null,
      },
    ],
    employees: overrides.employees ?? [
      {
        crm_id: "1399",
        employment_status: "active",
        full_name: "Stand-in Leaver",
        hr_id: "MR-55",
        organogram_visible: true,
        payroll_eligible: true,
      },
    ],
    // The terminal-vacancy guard trigger has already opened (or adopted) the seat's vacancy.
    position_vacancies: [{ created_at: "2026-11-01T09:00:00+00:00", id: 501, replacement_for_hr_id: "MR-55", status: "open" }],
    user_access_profiles: [{ hr_id: "MR-55", is_active: true }],
    workflow_registry_modules: [
      registryModuleRow("resignations", [
        { from: ["resignation_approved"], key: "resignation_complete", roles: ["Super Admin"], to: "resignation_completed" },
      ]),
    ],
  };
}

const vacated = () => [{ vacated_count: 1 }];
const seatFault = () => ({ body: { code: "P0001", details: null, hint: null, message: "phx_vacate_au_seats_for_employee: seat history is locked" }, status: 400 });

/** Where in the request log a write lands, by table (and, for the resignation, by what it wrote). */
function positionOf(seen: Seen[], predicate: (entry: Seen) => boolean): number {
  return seen.findIndex((entry) => (entry.kind === "write" || entry.kind === "rpc") && predicate(entry));
}

const isStamp = (entry: Seen) => entry.table === "employee_resignations" && writtenRow(entry)?.status === "completed";

export async function runResignationCompleteBehaviourTests(): Promise<void> {
  // ── 1. Ended first, stamped last ──────────────────────────────────────────────────────────────
  {
    const standIn: StandIn = { rpc: { phx_vacate_au_seats_for_employee: vacated }, tables: world() };
    await withPostgrestStandIn(standIn, async (seen) => {
      const record = await runResignationWorkflow(RESIGNATION_ID, "complete", "B-10", null, null, OWNER);
      assert.equal(record?.status, "completed");

      const employee = positionOf(seen, (entry) => entry.table === "employees");
      const login = positionOf(seen, (entry) => entry.table === "app_auth_users");
      const link = positionOf(seen, (entry) => entry.table === "employee_resignations" && writtenRow(entry)?.vacancy_id === 501);
      const seat = positionOf(seen, (entry) => entry.rpc === "phx_vacate_au_seats_for_employee");
      const stamp = positionOf(seen, isStamp);
      assert.ok(employee !== -1 && login !== -1 && link !== -1 && seat !== -1 && stamp !== -1, "all four steps and the stamp ran");
      assert.ok(
        employee < login && login < link && link < seat,
        "the steps run in their order: lifecycle, sign-in, vacancy link, seat",
      );
      assert.ok(seat < stamp, "HEADLINE (#356): the resignation is stamped completed only after every employee-side step");
      const after = seen.slice(stamp + 1).filter((entry) => entry.kind === "write" && ["employees", "app_auth_users", "user_access_profiles"].includes(entry.table ?? ""));
      assert.deepEqual(after, [], "no employee-side write follows the stamp");
      assert.equal(writesTo(seen, "employee_resignations").filter(isStamp).length, 1, "stamped once");

      assert.equal(writtenRow(seen[stamp]).exit_status, "completed");
      assert.equal(seen[stamp].params.get("updated_at"), `eq.${READ_AT}`, "the stamp is locked on the version read at the start");
      assert.equal(writtenRow(seen[link]).updated_at, undefined, "the vacancy link never moves updated_at — it would break the stamp's own lock");
      const seatArgs = seen[seat].body as Record<string, unknown>;
      assert.equal(seatArgs.p_employee_hr_id, "MR-55");
      assert.equal(seatArgs.p_effective_date, "2026-11-15", "the seat is freed from the resignation's own date");
    });
    const employee = standIn.tables.employees[0];
    assert.equal(employee.employment_status, "resigned");
    assert.equal(employee.payroll_eligible, false, "off payroll");
    assert.equal(employee.organogram_visible, false);
    assert.equal(employee.crm_id, null, "the CRM slot is released for the replacement");
    assert.equal(standIn.tables.employee_resignations[0].vacancy_id, 501, "the record points at the seat's vacancy");
    assert.equal(standIn.tables.employee_resignations[0].status, "completed");
  }

  // ── 2. A failed step leaves it Approved and says which; pressing again finishes it ─────────────
  {
    const standIn: StandIn = { rpc: { phx_vacate_au_seats_for_employee: seatFault }, tables: world() };
    await withPostgrestStandIn(standIn, async (seen) => {
      await assert.rejects(
        runResignationWorkflow(RESIGNATION_ID, "complete", "B-10", null, null, OWNER),
        (error: unknown) =>
          error instanceof ApiError &&
          error.status === 409 &&
          error.code === "resignation_complete_step_failed" &&
          error.message.includes('step 4 of 4, "Free the organogram seat"') &&
          error.message.includes("It is still Approved"),
        "HEADLINE (#356): a failed seat step is a 409 naming the step, never a completed resignation",
      );
      assert.equal(writesTo(seen, "employee_resignations").filter(isStamp).length, 0, "nothing was stamped completed");
    });
    assert.equal(standIn.tables.employee_resignations[0].status, "approved", "the resignation is still Approved");
    assert.equal(standIn.tables.employee_resignations[0].updated_at, READ_AT, "and its version is unmoved, so Complete can be pressed again");

    // The fault clears; the same button, the same row — every step re-asserts and the stamp lands.
    standIn.rpc = { phx_vacate_au_seats_for_employee: vacated };
    await withPostgrestStandIn(standIn, async (seen) => {
      const record = await runResignationWorkflow(RESIGNATION_ID, "complete", "B-10", null, null, OWNER);
      assert.equal(record?.status, "completed", "pressing Complete again after a failed step is safe and finishes it");
      assert.equal(rpcCalls(seen, "phx_vacate_au_seats_for_employee").length, 1);
    });
    assert.equal(standIn.tables.employee_resignations[0].status, "completed");
    assert.equal(standIn.tables.position_vacancies.length, 1, "the retry opened no second vacancy");
  }

  // ── 3. No employee row matched: refused at step 1, before anything else is touched ─────────────
  {
    const standIn: StandIn = { rpc: { phx_vacate_au_seats_for_employee: vacated }, tables: world({ employees: [] }) };
    await withPostgrestStandIn(standIn, async (seen) => {
      await assert.rejects(
        runResignationWorkflow(RESIGNATION_ID, "complete", "B-10", null, null, OWNER),
        (error: unknown) => error instanceof ApiError && error.status === 409 && error.message.includes('step 1 of 4, "End the employment record'),
        "an exit that ends nobody is refused at step 1",
      );
      assert.equal(writesTo(seen, "app_auth_users").length, 0, "no login is switched off for an exit that ended nobody");
      assert.equal(rpcCalls(seen, "phx_vacate_au_seats_for_employee").length, 0, "no seat is freed");
      assert.equal(writesTo(seen, "employee_resignations").length, 0, "and the resignation is not touched");
    });
    assert.equal(standIn.tables.employee_resignations[0].status, "approved");
  }
}
