import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ApiError } from "../src/lib/http/api-errors.ts";
import {
  RESIGNATION_COMPLETION_STEPS,
  completeResignationInOrder,
  isMissingColumnOfTable,
  isMissingFunctionError,
  isMissingTableError,
  resignationCompletionSteps,
  type ResignationCompletionStepKey,
  type ResignationCompletionSteps,
} from "../src/lib/resignations/service.ts";

// REC-028 — completing a resignation in the right order.
//
// Complete used to stamp employee_resignations "completed" FIRST and only then end the employee
// (lifecycle, sign-in, vacancy link, organogram seat). Any failure after the stamp left a
// resignation reading "completed" over a person still active, on payroll, logged in or seated.
// Now the four employee-side steps run first and the stamp runs last: a failed step leaves the
// resignation Approved, names the step, and pressing Complete again is safe.
//
// Nothing here reaches a database: every step and the stamp are fakes over an in-memory world, and
// the real helpers are driven through a fake Supabase client. The sign-in step is never run for
// real here — it reaches the mailbox and Telegram through the shared admin client.

type LogCall = { message: string; labels: Record<string, unknown> | undefined; error: unknown };

type World = {
  resignation: { status: string; updatedAt: string; vacancyId: number | null };
  employee: { status: string; payrollEligible: boolean; loginActive: boolean; seatOpen: boolean };
  vacanciesOpened: number;
  events: string[];
  stamps: number;
};

function newWorld(): World {
  return {
    resignation: { status: "approved", updatedAt: "2026-11-10T08:00:00.000Z", vacancyId: null },
    employee: { status: "active", payrollEligible: true, loginActive: true, seatOpen: true },
    vacanciesOpened: 0,
    events: [],
    stamps: 0,
  };
}

const READ_AT = "2026-11-10T08:00:00.000Z";

/** Fake steps that behave like the real ones: idempotent re-assertions, none touching updated_at. */
function worldSteps(world: World, failing: Set<ResignationCompletionStepKey>): ResignationCompletionSteps {
  const step = (key: ResignationCompletionStepKey, effect: () => void) => async () => {
    world.events.push(key);
    if (failing.has(key)) throw new Error(`forced failure in ${key}`);
    effect();
  };
  return {
    recheck: async () => {
      world.events.push("recheck");
      if (world.resignation.status !== "approved" || world.resignation.updatedAt !== READ_AT) {
        throw new Error("Resignation workflow was updated by another user. Refresh and try again.");
      }
    },
    endEmployment: step("endEmployment", () => {
      world.employee.status = "resigned";
      world.employee.payrollEligible = false;
      // The terminal-vacancy guard adopts the seat's open vacancy before it would open one.
      if (world.vacanciesOpened === 0) world.vacanciesOpened = 1;
    }),
    revokeAccess: step("revokeAccess", () => {
      world.employee.loginActive = false;
    }),
    linkVacancy: step("linkVacancy", () => {
      if (world.resignation.vacancyId) return;
      world.resignation.vacancyId = 77;
    }),
    vacateSeat: step("vacateSeat", () => {
      world.employee.seatOpen = false;
    }),
  };
}

/** The stamp: the optimistic-locked "completed" write. */
function worldStamp(world: World) {
  return async () => {
    world.events.push("stamp");
    if (world.resignation.status !== "approved" || world.resignation.updatedAt !== READ_AT) {
      throw new Error("Resignation workflow was updated by another user. Refresh and try again.");
    }
    world.resignation.status = "completed";
    world.resignation.updatedAt = "2026-11-13T10:00:00.000Z";
    world.stamps += 1;
    return { status: world.resignation.status };
  };
}

function capturingLog() {
  const calls: LogCall[] = [];
  const log = (message: string, options?: { labels?: Record<string, unknown>; error?: unknown }) => {
    calls.push({ message, labels: options?.labels, error: options?.error });
  };
  return { calls, log };
}

// ── A fake Supabase client, enough for the real lifecycle, vacancy-link and seat steps ──────────

type FakeOp = {
  table: string;
  kind: "select" | "update" | "insert" | "rpc";
  payload?: Record<string, unknown>;
  filters: Record<string, unknown>;
  returning?: string;
};
type FakeResult = { data?: unknown; error?: unknown };
type StepsClient = Parameters<typeof resignationCompletionSteps>[0];
type FakeResponse = { data: unknown; error: unknown };
interface FakeBuilder extends PromiseLike<FakeResponse> {
  select(columns: string): FakeBuilder;
  update(payload: Record<string, unknown>): FakeBuilder;
  insert(payload: Record<string, unknown>): FakeBuilder;
  eq(column: string, value: unknown): FakeBuilder;
  in(column: string, values: unknown): FakeBuilder;
  order(): FakeBuilder;
  limit(): FakeBuilder;
  maybeSingle(): Promise<FakeResponse>;
  single(): Promise<FakeResponse>;
}

function fakeClient(respond: (op: FakeOp) => FakeResult) {
  const ops: FakeOp[] = [];
  const settle = (op: FakeOp): Promise<FakeResponse> => {
    ops.push(op);
    const result = respond(op);
    return Promise.resolve({ data: result.data ?? null, error: result.error ?? null });
  };
  const from = (table: string): FakeBuilder => {
    const op: FakeOp = { table, kind: "select", filters: {} };
    const builder: FakeBuilder = {
      select(columns: string) {
        if (op.kind !== "select") op.returning = columns;
        return builder;
      },
      update(payload: Record<string, unknown>) {
        op.kind = "update";
        op.payload = payload;
        return builder;
      },
      insert(payload: Record<string, unknown>) {
        op.kind = "insert";
        op.payload = payload;
        return builder;
      },
      eq(column: string, value: unknown) {
        op.filters[column] = value;
        return builder;
      },
      in(column: string, values: unknown) {
        op.filters[column] = values;
        return builder;
      },
      order() {
        return builder;
      },
      limit() {
        return builder;
      },
      maybeSingle() {
        return settle(op);
      },
      single() {
        return settle(op);
      },
      then(onFulfilled, onRejected) {
        return settle(op).then(onFulfilled, onRejected);
      },
    };
    return builder;
  };
  const client = {
    from,
    rpc(fn: string, args: Record<string, unknown>) {
      return settle({ table: fn, kind: "rpc", payload: args, filters: {} });
    },
  } as unknown as StepsClient;
  return { client, ops };
}

const approvedRow = {
  id: "res-1",
  employee_hr_id: "AI-0009",
  employee_name: "Test Leaver",
  job_title: null,
  line_name: null,
  created_at: "2026-11-01T08:00:00.000Z",
  created_by: null,
  updated_at: READ_AT,
  status: "approved",
  exit_status: "approved",
  submitted_date: "2026-11-01",
  effective_date: "2026-11-30",
  reason: "personal",
  vacancy_id: null,
} as unknown as Parameters<typeof resignationCompletionSteps>[1]["row"];

/** A healthy database: every read and write succeeds. `override` replaces one answer. */
function healthy(override?: (op: FakeOp) => FakeResult | null) {
  return (op: FakeOp): FakeResult => {
    const special = override?.(op);
    if (special) return special;
    if (op.table === "employee_resignations" && op.kind === "select") {
      return { data: { status: "approved", exit_status: "approved", updated_at: READ_AT } };
    }
    if (op.table === "employees" && op.kind === "update") return { data: [{ hr_id: "AI-0009" }] };
    if (op.table === "position_vacancies" && op.kind === "select") return { data: [{ id: 77, status: "open" }] };
    if (op.kind === "rpc") return { data: { vacated_count: 1 } };
    return { data: null };
  };
}

/** The real steps over a fake client, with the sign-in step stubbed (it reaches shared clients). */
function realSteps(client: StepsClient): ResignationCompletionSteps {
  const steps = resignationCompletionSteps(client, { actorHrId: "B-10", directoryEmployee: null, row: approvedRow });
  return { ...steps, revokeAccess: async () => {} };
}

async function expectStepFailure(promise: Promise<unknown>, key: ResignationCompletionStepKey, why: string) {
  const index = RESIGNATION_COMPLETION_STEPS.findIndex((step) => step.key === key);
  await assert.rejects(
    promise,
    (error: unknown) => {
      assert.ok(error instanceof ApiError, `${why}: the failure is an ApiError the route answers as a non-500`);
      assert.equal(error.status, 409);
      assert.equal(error.code, "resignation_complete_step_failed");
      assert.ok(
        error.message.includes(`step ${index + 1} of 4`) && error.message.includes(RESIGNATION_COMPLETION_STEPS[index].label),
        `${why}: the message names the step that failed (got: ${error.message})`,
      );
      assert.ok(error.message.includes("still Approved"), `${why}: HR is told the resignation is still Approved`);
      assert.ok(error.message.includes("Pressing Complete again is safe"), `${why}: HR is told a retry is safe`);
      return true;
    },
  );
}

export async function runResignationCompleteOrderTests() {
  // ── 1. Success: every employee-side step, in today's order, and the stamp LAST ───────────────
  {
    const world = newWorld();
    const { calls, log } = capturingLog();
    await completeResignationInOrder("res-1", worldSteps(world, new Set()), worldStamp(world), log);
    assert.deepEqual(
      world.events,
      ["recheck", "endEmployment", "revokeAccess", "linkVacancy", "vacateSeat", "stamp"],
      "the completed write happens after all four employee-side steps, never before",
    );
    assert.equal(world.resignation.status, "completed");
    assert.equal(world.stamps, 1);
    assert.equal(calls.length, 0, "a clean completion logs no failure");
  }

  // ── 2. Each step forced to fail: the row is never written completed, and the error names it ──
  for (const [index, { key }] of RESIGNATION_COMPLETION_STEPS.entries()) {
    const world = newWorld();
    const { calls, log } = capturingLog();
    await expectStepFailure(
      completeResignationInOrder("res-1", worldSteps(world, new Set([key])), worldStamp(world), log),
      key,
      `forced failure in ${key}`,
    );
    assert.equal(world.resignation.status, "approved", `a failure in ${key} leaves the resignation Approved, never completed`);
    assert.equal(world.stamps, 0, `a failure in ${key} never reaches the completed write`);
    assert.ok(!world.events.includes("stamp"), `a failure in ${key} never attempts the completed write`);
    assert.deepEqual(
      world.events.slice(1),
      RESIGNATION_COMPLETION_STEPS.slice(0, index + 1).map((step) => step.key),
      `the steps after ${key} do not run once it fails`,
    );
    assert.equal(calls.length, 1, `a failure in ${key} is logged once`);
    assert.deepEqual(
      calls[0].labels,
      { event: "resignation_complete_step_failed", resignationId: "res-1", step: key },
      "the log carries the event, the resignation id and the step — no name, no salary",
    );
    assert.equal((calls[0].error as Error).message, `forced failure in ${key}`, "the real cause is logged");

    // ── 3. Retry after the partial failure completes cleanly ──────────────────────────────────
    world.events = [];
    await completeResignationInOrder("res-1", worldSteps(world, new Set()), worldStamp(world), log);
    assert.equal(world.resignation.status, "completed", `pressing Complete again after a ${key} failure completes`);
    assert.equal(world.stamps, 1, "the completed write happens exactly once across both attempts");
    assert.equal(world.events.at(-1), "stamp", "on the retry too, the stamp runs last");
    assert.deepEqual(
      world.employee,
      { status: "resigned", payrollEligible: false, loginActive: false, seatOpen: false },
      "after the retry the person is fully ended",
    );
    assert.equal(world.vacanciesOpened, 1, "re-running the lifecycle step never opens a second vacancy");
    assert.equal(world.resignation.vacancyId, 77);
  }

  // ── 4. A concurrent edit is caught BEFORE anyone is ended ───────────────────────────────────
  {
    const world = newWorld();
    world.resignation.status = "cancelled";
    await assert.rejects(
      completeResignationInOrder("res-1", worldSteps(world, new Set()), worldStamp(world), capturingLog().log),
      /updated by another user/,
    );
    assert.deepEqual(world.events, ["recheck"], "a resignation changed meanwhile ends nobody");
  }

  // ── 5. The REAL steps over a fake database: a real failure stops Complete before the stamp ───
  const stamped: string[] = [];
  const stamp = async () => {
    stamped.push("stamp");
    return { status: "completed" };
  };
  const quiet = capturingLog().log;

  // 5a. Healthy: the stamp runs, and the vacancy link does not bump updated_at (the stamp's lock).
  {
    const { client, ops } = fakeClient(healthy());
    await completeResignationInOrder("res-1", realSteps(client), stamp, quiet);
    assert.deepEqual(stamped, ["stamp"]);
    const link = ops.find((op) => op.table === "employee_resignations" && op.kind === "update");
    assert.ok(link, "the vacancy is linked onto the resignation");
    assert.equal(link.payload?.vacancy_id, 77);
    assert.ok(
      !("updated_at" in (link.payload ?? {})),
      "the pre-stamp link must not bump updated_at, or Complete would fail its own optimistic lock",
    );
    const vacate = ops.find((op) => op.kind === "rpc");
    assert.equal(vacate?.table, "phx_vacate_au_seats_for_employee");
    assert.equal(vacate?.payload?.p_effective_date, "2026-11-30");
    stamped.length = 0;
  }

  // 5b. Lifecycle: a trigger refusal that merely MENTIONS an optional column used to drop that
  // column and retry — leaving the person payroll-eligible. Strict: it stops Complete.
  {
    const { client, ops } = fakeClient(
      healthy((op) =>
        op.table === "employees" && op.kind === "update"
          ? { error: { code: "P0001", message: "payroll_eligible cannot be cleared while a payroll batch is open" } }
          : null,
      ),
    );
    await expectStepFailure(completeResignationInOrder("res-1", realSteps(client), stamp, quiet), "endEmployment", "trigger refusal");
    assert.deepEqual(stamped, [], "nothing is stamped completed");
    assert.equal(ops.filter((op) => op.table === "employees").length, 1, "the payroll column is never dropped and retried");
  }

  // 5c. Lifecycle: an update that matched no employee row is a failure, not a success.
  {
    const { client } = fakeClient(healthy((op) => (op.table === "employees" && op.kind === "update" ? { data: [] } : null)));
    await expectStepFailure(completeResignationInOrder("res-1", realSteps(client), stamp, quiet), "endEmployment", "no employee row");
    assert.deepEqual(stamped, []);
  }

  // 5d. Lifecycle: a genuinely absent optional column is still tolerated (dropped and retried).
  {
    let first = true;
    const { client, ops } = fakeClient(
      healthy((op) => {
        if (op.table !== "employees" || op.kind !== "update" || !first) return null;
        first = false;
        return { error: { code: "PGRST204", message: "Could not find the 'organogram_visible' column of 'employees' in the schema cache" } };
      }),
    );
    await completeResignationInOrder("res-1", realSteps(client), stamp, quiet);
    const writes = ops.filter((op) => op.table === "employees");
    assert.equal(writes.length, 2);
    assert.ok(!("organogram_visible" in (writes[1].payload ?? {})), "only the absent column is dropped");
    assert.equal(writes[1].payload?.payroll_eligible, false, "payroll eligibility is still switched off");
    assert.deepEqual(stamped, ["stamp"]);
    stamped.length = 0;
  }

  // 5e. Vacancy link: a foreign-key violation on vacancy_id used to be swallowed (the message
  // mentions the column). Strict: it stops Complete.
  {
    const { client } = fakeClient(
      healthy((op) =>
        op.table === "employee_resignations" && op.kind === "update"
          ? {
              error: {
                code: "23503",
                message: 'insert or update on table "employee_resignations" violates foreign key constraint "employee_resignations_vacancy_id_fkey"',
              },
            }
          : null,
      ),
    );
    await expectStepFailure(completeResignationInOrder("res-1", realSteps(client), stamp, quiet), "linkVacancy", "vacancy FK violation");
    assert.deepEqual(stamped, []);
  }

  // 5f. Vacancy link: a failed vacancy read (not an absent table) stops Complete.
  {
    const { client } = fakeClient(
      healthy((op) =>
        op.table === "position_vacancies" && op.kind === "select"
          ? { error: { code: "57014", message: "canceling statement due to statement timeout" } }
          : null,
      ),
    );
    await expectStepFailure(completeResignationInOrder("res-1", realSteps(client), stamp, quiet), "linkVacancy", "vacancy read failed");
    assert.deepEqual(stamped, []);
  }

  // 5g. Seat: a 42703 raised INSIDE the wrapper used to read as "schema missing" and be swallowed,
  // leaving the person in the seat. Strict: it stops Complete.
  {
    const { client } = fakeClient(
      healthy((op) => (op.kind === "rpc" ? { error: { code: "42703", message: 'column "area_name" does not exist' } } : null)),
    );
    await expectStepFailure(completeResignationInOrder("res-1", realSteps(client), stamp, quiet), "vacateSeat", "failure inside the seat RPC");
    assert.deepEqual(stamped, []);
  }

  // 5h. Seat: the wrapper itself absent (an environment without the migration) is still tolerated.
  {
    const { client } = fakeClient(
      healthy((op) =>
        op.kind === "rpc"
          ? {
              error: {
                code: "PGRST202",
                message:
                  "Could not find the function public.phx_vacate_au_seats_for_employee(p_actor, p_effective_date, p_employee_hr_id, p_reason) in the schema cache",
              },
            }
          : null,
      ),
    );
    await completeResignationInOrder("res-1", realSteps(client), stamp, quiet);
    assert.deepEqual(stamped, ["stamp"]);
    stamped.length = 0;
  }

  // 5i. The re-check: a row reopened or completed meanwhile ends nobody.
  {
    const { client, ops } = fakeClient(
      healthy((op) =>
        op.table === "employee_resignations" && op.kind === "select"
          ? { data: { status: "approved", exit_status: "approved", updated_at: "2026-11-12T09:00:00.000Z" } }
          : null,
      ),
    );
    await assert.rejects(completeResignationInOrder("res-1", realSteps(client), stamp, quiet), /updated by another user/);
    assert.equal(ops.filter((op) => op.table === "employees").length, 0, "nobody is ended when the row changed underneath");
    assert.deepEqual(stamped, []);
  }

  // ── 6. The strict predicates: absent object only, never a failure that mentions one ──────────
  assert.equal(isMissingTableError({ code: "PGRST205", message: "Could not find the table 'public.app_auth_users' in the schema cache" }, "app_auth_users"), true);
  assert.equal(isMissingTableError({ code: "42P01", message: 'relation "user_access_profiles" does not exist' }, "user_access_profiles"), true);
  assert.equal(
    isMissingTableError({ code: "42P01", message: 'relation "audit_shadow" does not exist' }, "app_auth_users"),
    false,
    "a trigger reaching a missing OTHER table is a real failure",
  );
  assert.equal(isMissingTableError({ code: "23505", message: "duplicate key value violates unique constraint \"app_auth_users_pkey\"" }, "app_auth_users"), false);
  assert.equal(isMissingColumnOfTable({ message: 'column "crm_id" of relation "employees" does not exist' }, "employees", "crm_id"), true);
  assert.equal(isMissingColumnOfTable({ message: 'column "crm_id" does not exist' }, "employees", "crm_id"), false, "an unqualified 42703 comes from inside a function");
  assert.equal(isMissingFunctionError({ code: "42883", message: "function public.phx_vacate_au_seats_for_employee(text, date, text, text) does not exist" }, "phx_vacate_au_seats_for_employee"), true);
  assert.equal(
    isMissingFunctionError({ code: "42883", message: "function au.resign_occupant(text, date, text, text) does not exist" }, "phx_vacate_au_seats_for_employee"),
    false,
    "a function the wrapper CALLS being absent is a real failure",
  );
  assert.equal(
    isMissingFunctionError({ code: "P0001", message: "phx_vacate_au_seats_for_employee: employee hr_id is required" }, "phx_vacate_au_seats_for_employee"),
    false,
  );

  // ── 7. The wiring: runResignationWorkflow's Complete goes through the ordered path ───────────
  const source = readFileSync("src/lib/resignations/service.ts", "utf8").replace(/\r\n/g, "\n");
  const workflow = source.slice(
    source.indexOf("export async function runResignationWorkflow("),
    source.indexOf("async function stampResignationWorkflowRow("),
  );
  assert.ok(workflow.length > 0, "runResignationWorkflow precedes stampResignationWorkflowRow");
  assert.match(
    workflow,
    /if \(action === "complete"\) \{\s*updated = await completeResignationInOrder\(\s*row\.id,\s*resignationCompletionSteps\(supabase, \{ actorHrId, directoryEmployee, row \}\),\s*\(\) => stampResignationWorkflowRow\(/,
    "Complete runs the employee-side steps through completeResignationInOrder, with the stamp handed in as the LAST step",
  );
  assert.ok(!workflow.includes(".update(updates)"), "runResignationWorkflow never stamps the row inline — only stampResignationWorkflowRow does");
  for (const helper of ["updateEmployeeLifecycleFallback(", "deactivateEmployeeAccessIfSupported(", "linkCompletedResignationVacancy(", "vacateAuSeatsIfSupported("]) {
    assert.ok(!workflow.includes(helper), `${helper} runs only inside resignationCompletionSteps, never inline after the stamp`);
  }
  const route = readFileSync("app/api/resignations/[id]/workflow/route.ts", "utf8");
  assert.match(
    route,
    /if \(error instanceof ApiError\) \{\s*return NextResponse\.json\(\{ success: false, error: error\.message, code: error\.code \}, \{ status: error\.status \}\);/,
    "the workflow route answers a step failure with its own status and sentence, never a 500",
  );
}
