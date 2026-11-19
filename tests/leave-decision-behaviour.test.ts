import assert from "node:assert/strict";

import { createAccessContext } from "../src/lib/auth/permissions.ts";
import { ApiError } from "../src/lib/http/api-errors.ts";
import { POST as decisionRoutePost } from "../app/api/vacations/requests/[id]/decision/route.ts";
import { decideVacationRequest } from "../src/lib/vacation/service.ts";
import {
  DEV_AUTH_ENV,
  RATE_LIMIT_ALLOWS,
  devAuthRequest,
  registryModuleRow,
  rpcCalls,
  withPostgrestStandIn,
  writesTo,
  type Row,
  type StandIn,
} from "./support/postgrest-stand-in.ts";

// REC-078 (phase 2): the leave approval decision, run — not read.
//
// decideVacationRequest is called the way the decision route calls it, against the shared in-memory
// PostgREST (tests/support/postgrest-stand-in.ts). The database function the decision writes through
// is played by the stand-in, so what is asserted is what the code SENDS and what it does with the
// answer:
//
//   1. An approver's step is decided and the request moved by ONE call (#333, F-HR-010): the step id,
//      the status the approver read, and the request's whole patch travel together to
//      phx_apply_vacation_step_decision, and no step row or request row is written on its own.
//   2. Sick leave's older parallel flow writes through the same single call.
//   3. A lost race answers 409, never a 500 and never "saved": the request moved since the approver
//      read it (40001), the approver's step was already decided (55000), or the function found no row.
//      Nothing else is written after a refusal — no event, no audit row, no notice.
//   4. The stalled-approver override decides the STALLED manager step, in that same single call, and
//      stores the System Administrator who answered (canonical HR id) on the step — never as if the
//      assigned approver had answered — with the transfer sentence and no approver's name.
//   5. Sick leave's final HR approval is final: its finality reads the step as it will be once the
//      call commits, so the request moves to approved with its balance in that call.
//   6. The decision ROUTE answers a lost race 409 with the conflict's own code, and a decision 200.

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const MANAGER_STEP = "22222222-2222-4222-8222-222222222222";
const HR_STEP = "33333333-3333-4333-8333-333333333333";
const SECOND_HR_STEP = "44444444-4444-4444-8444-444444444444";

const MANAGER = createAccessContext({ hrId: "DM-7", loginId: "dm.seven", role: "District Manager", source: "session" });

function requestRow(overrides: Row = {}): Row {
  return {
    balance_after_days: null,
    balance_before_days: null,
    created_at: "2026-11-10T08:00:00+00:00",
    day_part: "full_day",
    department_name: "Sales",
    duration_days: 2,
    employee_hire_date: "2024-01-15",
    employee_hr_id: "MR-41",
    employee_name: "Stand-in Rep",
    employee_work_email: "stand.in.rep@example.invalid",
    end_date: "2026-12-02",
    entitlement_days: 21,
    id: REQUEST_ID,
    line_name: "CNS",
    manager_decision: null,
    manager_decision_at: null,
    manager_decision_by_hr_id: null,
    manager_decision_comment: null,
    manager_hr_id: "DM-7",
    manager_name: "Stand-in Manager",
    manager_of_manager_hr_id: null,
    manager_of_manager_name: null,
    payment_status: "pending",
    period_end: null,
    period_start: null,
    request_code: "VAC-9001",
    start_date: "2026-12-01",
    status: "pending_manager",
    submitted_by_hr_id: "MR-41",
    unpaid_reason: null,
    updated_at: "2026-11-10T08:00:00+00:00",
    used_paid_days: null,
    vacation_type: "annual",
    ...overrides,
  };
}

function stepRow(id: string, stepKey: string, order: number, approver: string): Row {
  return {
    approver_hr_id: approver,
    approver_user_id: null,
    created_at: "2026-11-10T08:00:00+00:00",
    decided_at: null,
    decision_comment: null,
    id,
    overridden_at: null,
    overridden_by_hr_id: null,
    request_id: REQUEST_ID,
    status: "pending",
    step_key: stepKey,
    step_order: order,
  };
}

const APPROVERS = ["District Manager", "Regional Manager", "National Sales Manager", "Super Admin"];

function tables(request: Row = requestRow()): Record<string, Row[]> {
  return {
    // The vacation engine's registry module (legacy key `leave_requests`), as much of it as these
    // decisions pass through. It fails closed on a missing row, so it is seeded, never assumed.
    workflow_registry_modules: [
      registryModuleRow("leave_requests", [
        { from: ["pending_manager"], key: "manager_approve", roles: APPROVERS, to: "pending_hr" },
        { from: ["pending_manager"], key: "manager_reject", roles: APPROVERS, to: "rejected" },
        { from: ["pending_hr"], key: "hr_approve", roles: ["Super Admin"], to: "approved" },
        { from: ["pending_hr"], key: "hr_reject", roles: ["Super Admin"], to: "rejected" },
      ]),
    ],
    v2_vacation_approval_steps: [
      stepRow(MANAGER_STEP, "direct_manager", 1, "DM-7"),
      stepRow(HR_STEP, "hr", 4, "B-10"),
      stepRow(SECOND_HR_STEP, "hr", 4, "B-11"),
    ],
    v2_vacation_requests: [request],
  };
}

/** The database function, played faithfully: lock, compare the status, decide the step, close the HR siblings, patch. */
function applyStepDecision(standIn: StandIn, args: Record<string, unknown>) {
  const request = standIn.tables.v2_vacation_requests.find((row) => row.id === args.p_request_id);
  if (!request || request.status !== args.p_expected_status) {
    return { body: { code: "40001", details: null, hint: null, message: "Vacation request was updated by another user. Refresh and try again." }, status: 400 };
  }
  const step = standIn.tables.v2_vacation_approval_steps.find((row) => row.id === args.p_step_id);
  if (!step || step.status !== "pending") {
    return { body: { code: "55000", details: null, hint: null, message: "This vacation approval step was already decided." }, status: 400 };
  }
  Object.assign(step, { decided_at: args.p_now, decision_comment: args.p_decision_comment, status: args.p_step_status });
  if (step.step_key === "hr") {
    for (const sibling of standIn.tables.v2_vacation_approval_steps) {
      if (sibling.step_key === "hr" && sibling.status === "pending" && sibling.id !== step.id) sibling.status = args.p_step_status;
    }
  }
  Object.assign(request, args.p_request_patch as Row);
  return structuredClone(request);
}

const refusal = (code: string, message: string) => () => ({ body: { code, details: null, hint: null, message }, status: 400 });

const isConflict = (error: unknown) => error instanceof ApiError && error.status === 409 && error.code === "vacation_decision_conflict";

export async function runLeaveDecisionBehaviourTests(): Promise<void> {
  // ── 1. The manager's approval: the step and the request move in ONE call ───────────────────────
  {
    const standIn: StandIn = { rpc: { phx_apply_vacation_step_decision: (args, self) => applyStepDecision(self, args) }, tables: tables() };
    await withPostgrestStandIn(standIn, async (seen) => {
      // The writes are judged before the answer: a step written on its own first is exactly what makes
      // the faithful function above refuse, and the assertion should name the write, not the refusal.
      const outcome = await decideVacationRequest(MANAGER, { decision: "approve", requestId: REQUEST_ID }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      assert.equal(writesTo(seen, "v2_vacation_approval_steps").length, 0, "HEADLINE (#333): no step row is ever written on its own");
      assert.equal(writesTo(seen, "v2_vacation_requests").length, 0, "and the request is never moved by a separate update");
      if ("error" in outcome) throw outcome.error;
      const decided = outcome.value;
      assert.equal(decided.status, "pending_hr", "all management steps approved: the request now waits on HR");

      const calls = rpcCalls(seen, "phx_apply_vacation_step_decision");
      assert.equal(calls.length, 1, "HEADLINE (#333): one database call decides the step and moves the request");
      const args = calls[0].body as Record<string, unknown>;
      assert.equal(args.p_request_id, REQUEST_ID);
      assert.equal(args.p_step_id, MANAGER_STEP, "the approver's OWN step, never the HR one");
      assert.equal(args.p_expected_status, "pending_manager", "the status the approver read — the function's compare-and-set");
      assert.equal(args.p_step_status, "approved");
      const patch = args.p_request_patch as Row;
      assert.equal(patch.status, "pending_hr", "the request's move rides in the same call");
      assert.equal(patch.manager_decision, "approved");
      assert.equal(patch.manager_decision_by_hr_id, "DM-7", "the decider stored upper-case");
      assert.equal(rpcCalls(seen, "phx_apply_vacation_paid_approval").length, 0);
    });
    assert.equal(standIn.tables.v2_vacation_approval_steps.find((row) => row.id === MANAGER_STEP)?.status, "approved");
    assert.equal(standIn.tables.v2_vacation_requests[0].status, "pending_hr");
  }

  // ── 2. A lost race answers 409 and writes nothing after the refusal ────────────────────────────
  const races: Array<[string, StandIn["rpc"]]> = [
    ["the request moved since the approver read it (40001)", { phx_apply_vacation_step_decision: refusal("40001", "Vacation request was updated by another user. Refresh and try again.") }],
    ["the approver's step was already decided (55000)", { phx_apply_vacation_step_decision: refusal("55000", "This vacation approval step was already decided.") }],
    ["the function found no row to move", { phx_apply_vacation_step_decision: () => null }],
  ];
  for (const vacationType of ["annual", "sick"] as const) {
    for (const [why, rpc] of races) {
      const standIn: StandIn = { rpc, tables: tables(requestRow({ vacation_type: vacationType })) };
      const before = structuredClone(standIn.tables);
      await withPostgrestStandIn(standIn, async (seen) => {
        await assert.rejects(
          decideVacationRequest(MANAGER, { decision: "approve", requestId: REQUEST_ID }),
          (error: unknown) => isConflict(error),
          `HEADLINE (#333): ${vacationType} — ${why} — is a 409 the screen reloads on, never a 500 and never "saved"`,
        );
        assert.equal(rpcCalls(seen, "phx_apply_vacation_step_decision").length, 1, "the one refused call, and no retry");
        assert.equal(writesTo(seen, "v2_vacation_approval_steps").length, 0, "no step decided around the refusal");
        assert.equal(writesTo(seen, "v2_vacation_requests").length, 0, "no request moved around the refusal");
        assert.equal(writesTo(seen, "v2_vacation_request_events").length, 0, "no event claims a decision the database refused");
        assert.equal(writesTo(seen, "audit_logs").length, 0, "and no audit row either");
      });
      assert.deepEqual(standIn.tables, before, `${vacationType}: nothing changed`);
    }
  }

  // ── 3. Sick leave's parallel flow decides through the same single call ─────────────────────────
  {
    const standIn: StandIn = {
      rpc: { phx_apply_vacation_step_decision: (args, self) => applyStepDecision(self, args) },
      tables: tables(requestRow({ vacation_type: "sick" })),
    };
    await withPostgrestStandIn(standIn, async (seen) => {
      await decideVacationRequest(MANAGER, { decision: "approve", requestId: REQUEST_ID });
      const calls = rpcCalls(seen, "phx_apply_vacation_step_decision");
      assert.equal(calls.length, 1, "Sick leave too: one call decides the step and moves the request");
      const args = calls[0].body as Record<string, unknown>;
      assert.equal(args.p_step_id, MANAGER_STEP);
      assert.equal(args.p_step_status, "approved");
      assert.equal(args.p_expected_status, "pending_manager");
      assert.equal(args.p_decision_comment, null, "no comment is stored as null, as the old step writer stored it");
      assert.equal(args.p_overridden_by_hr_id, null, "Sick leave has no override");
      assert.equal(args.p_actor_hr_id, "DM-7");
      assert.equal(typeof (args.p_request_patch as Row).status, "string", "the request's move rides in the call");
      assert.equal(writesTo(seen, "v2_vacation_approval_steps").length, 0, "Sick leave writes no step row on its own either");
      assert.equal(writesTo(seen, "v2_vacation_requests").length, 0);
    });
    assert.equal(standIn.tables.v2_vacation_approval_steps.find((row) => row.id === MANAGER_STEP)?.status, "approved");
  }

  // ── 4. A rejection carries its reason in the same call, and is refused without one ─────────────
  {
    const standIn: StandIn = { rpc: { phx_apply_vacation_step_decision: (args, self) => applyStepDecision(self, args) }, tables: tables() };
    await withPostgrestStandIn(standIn, async (seen) => {
      await assert.rejects(
        decideVacationRequest(MANAGER, { decision: "reject", requestId: REQUEST_ID }),
        /A rejection reason is required\./,
        "a rejection with no reason is refused",
      );
      assert.equal(rpcCalls(seen, "phx_apply_vacation_step_decision").length, 0, "before anything is written");
      const decided = await decideVacationRequest(MANAGER, { decision: "reject", decisionComment: "Team is short that week.", requestId: REQUEST_ID });
      assert.equal(decided.status, "rejected");
      const [call] = rpcCalls(seen, "phx_apply_vacation_step_decision");
      const args = call.body as Record<string, unknown>;
      assert.equal(args.p_step_status, "rejected");
      assert.equal(args.p_decision_comment, "Team is short that week.", "the reason is stored on the step in the same transaction");
      assert.equal((args.p_request_patch as Row).manager_decision_comment, "Team is short that week.", "and on the request");
    });
  }

  // ── 5. HR's acknowledgement of a paid request: the step rides inside the paid approval ─────────
  {
    const steps = tables(requestRow({ manager_decision: "approved", status: "pending_hr" }));
    steps.v2_vacation_approval_steps[0].status = "approved";
    const standIn: StandIn = {
      rpc: {
        phx_apply_vacation_paid_approval_with_step: (args, self) => {
          const request = self.tables.v2_vacation_requests[0];
          request.status = args.p_next_status;
          return structuredClone(request);
        },
      },
      tables: steps,
    };
    const owner = createAccessContext({ hrId: "B-10", loginId: "b-10", role: "Super Admin", source: "session" });
    await withPostgrestStandIn(standIn, async (seen) => {
      const decided = await decideVacationRequest(owner, { decision: "approve", requestId: REQUEST_ID });
      assert.equal(decided.status, "approved");
      const calls = rpcCalls(seen, "phx_apply_vacation_paid_approval_with_step");
      assert.equal(calls.length, 1, "the paid approval and HR's step are one call");
      const args = calls[0].body as Record<string, unknown>;
      assert.equal(args.p_step_id, HR_STEP, "the HR step travels with the paid approval");
      assert.equal(args.p_step, "hr");
      assert.equal(args.p_expected_status, "pending_hr");
      assert.equal(args.p_overridden_by_hr_id, null, "an ordinary acknowledgement is not an override");
      assert.equal(rpcCalls(seen, "phx_apply_vacation_step_decision").length, 0, "not decided twice");
      assert.equal(rpcCalls(seen, "phx_apply_vacation_paid_approval").length, 0, "the inner paid approval is never called around the step");
      assert.equal(writesTo(seen, "v2_vacation_approval_steps").length, 0, "no step row written on its own");
      assert.equal(writesTo(seen, "v2_vacation_requests").length, 0);
    });

    // …and its lost race is a 409 as well.
    const raced = tables(requestRow({ manager_decision: "approved", status: "pending_hr" }));
    raced.v2_vacation_approval_steps[0].status = "approved";
    await withPostgrestStandIn(
      { rpc: { phx_apply_vacation_paid_approval_with_step: refusal("40001", "Vacation request was updated by another user. Refresh and try again.") }, tables: raced },
      async (seen) => {
        await assert.rejects(decideVacationRequest(owner, { decision: "approve", requestId: REQUEST_ID }), (error: unknown) => isConflict(error), "a paid approval that lost the race is a 409");
        assert.equal(writesTo(seen, "v2_vacation_request_events").length, 0);
      },
    );
  }

  // ── 6. The stalled-approver override: the stalled step, in one call, the answerer recorded ────────
  {
    // The manager step has waited since 10 Nov, past the two-day stall, so the approval transfers.
    const standIn: StandIn = { rpc: { phx_apply_vacation_step_decision: (args, self) => applyStepDecision(self, args) }, tables: tables() };
    const owner = createAccessContext({ hrId: "B-10", loginId: "b-10", role: "Super Admin", source: "session" });
    await withPostgrestStandIn(standIn, async (seen) => {
      await assert.rejects(
        decideVacationRequest(MANAGER, { decision: "approve", override: true, requestId: REQUEST_ID }),
        /^Error: Forbidden: only the System Administrator can respond on an unanswered request\.$/,
        "only the System Administrator can answer in a stalled approver's place",
      );
      await assert.rejects(
        decideVacationRequest(owner, { decision: "return", override: true, requestId: REQUEST_ID }),
        /a transferred approval can approve or reject, not return/,
        "a transferred approval cannot send the request back",
      );
      assert.equal(rpcCalls(seen, "phx_apply_vacation_step_decision").length, 0, "neither refusal wrote anything");

      await decideVacationRequest(owner, { decision: "approve", override: true, requestId: REQUEST_ID });
      const calls = rpcCalls(seen, "phx_apply_vacation_step_decision");
      assert.equal(calls.length, 1, "the override decides the step and moves the request in one call too");
      const args = calls[0].body as Record<string, unknown>;
      assert.equal(args.p_step_id, MANAGER_STEP, "the STALLED manager step, never the System Administrator's own HR step");
      assert.equal(
        args.p_overridden_by_hr_id,
        "B-10",
        "HEADLINE: the step records who answered in the stalled approver's place, by canonical HR id",
      );
      assert.match(String(args.p_decision_comment), /transferred to the System Administrator/, "the comment says the approval transferred");
      assert.doesNotMatch(String(args.p_decision_comment), /DM-7|Stand-in Manager/, "and never names the approver who did not reply");
      assert.equal(writesTo(seen, "v2_vacation_approval_steps").length, 0, "no step row written on its own");
      assert.ok(
        writesTo(seen, "v2_vacation_request_events").some((write) => (Array.isArray(write.body) ? write.body : [write.body]).some((row) => (row as Row)?.event_type === "approval_admin_override")),
        "the override leaves its own event, findable by type",
      );
    });
    assert.equal(standIn.tables.v2_vacation_approval_steps.find((row) => row.id === MANAGER_STEP)?.status, "approved");
  }

  // ── 7. Sick leave's final HR approval is final ─────────────────────────────────────────────────────
  {
    const sick = tables(requestRow({ manager_decision: "approved", vacation_type: "sick" }));
    sick.v2_vacation_approval_steps[0].status = "approved";
    // Sick leave needs its evidence accepted, by somebody other than the acknowledging HR account.
    sick.v2_vacation_evidence_reviews = [
      { created_at: "2026-11-11T08:00:00+00:00", evidence_type: "sick", id: "review-1", request_id: REQUEST_ID, review_note: null, reviewed_at: "2026-11-11T08:00:00+00:00", reviewed_by_hr_id: "HR-3", status: "accepted", updated_at: "2026-11-11T08:00:00+00:00" },
    ];
    const standIn: StandIn = { rpc: { phx_apply_vacation_step_decision: (args, self) => applyStepDecision(self, args) }, tables: sick };
    const owner = createAccessContext({ hrId: "B-10", loginId: "b-10", role: "Super Admin", source: "session" });
    await withPostgrestStandIn(standIn, async (seen) => {
      const decided = await decideVacationRequest(owner, { decision: "approve", requestId: REQUEST_ID });
      const [call] = rpcCalls(seen, "phx_apply_vacation_step_decision");
      const args = call.body as Record<string, unknown>;
      assert.equal(args.p_step_id, HR_STEP, "HR's own step is the one decided");
      const patch = args.p_request_patch as Row;
      assert.equal(
        patch.status,
        "approved",
        "HEADLINE: HR's approval of a Sick request whose manager already approved is FINAL — finality reads the step as it will be once the call commits",
      );
      assert.ok("payment_status" in patch, "a final approval carries the balance in the same call");
      assert.equal(decided.status, "approved");
    });
    assert.equal(standIn.tables.v2_vacation_approval_steps.find((row) => row.id === SECOND_HR_STEP)?.status, "approved", "the other HR account's step is closed with it");
  }

  // ── 8. The decision route: a lost race is 409 with its own code, a decision is 200 ─────────────────
  {
    const route = (id: string) => ({ params: Promise.resolve({ id }) });
    const raced: StandIn = {
      rpc: { ...RATE_LIMIT_ALLOWS, phx_apply_vacation_step_decision: refusal("40001", "Vacation request was updated by another user. Refresh and try again.") },
      tables: tables(),
    };
    await withPostgrestStandIn(raced, async (seen) => {
      const response = await decisionRoutePost(
        devAuthRequest("POST", `/api/vacations/requests/${REQUEST_ID}/decision`, { hrId: "DM-7", role: "District Manager" }, { decision: "approve" }),
        route(REQUEST_ID),
      );
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(response.status, 409, `HEADLINE: the route answers a lost race 409, never a 500 — got ${response.status} ${JSON.stringify(body)}`);
      assert.equal(body.error, "vacation_decision_conflict", "with the conflict's own code, so the screen reloads");
      assert.equal(body.success, false);
      assert.equal(writesTo(seen, "v2_vacation_request_events").length, 0, "and nothing was written after the refusal");
    }, { env: DEV_AUTH_ENV });

    const decided: StandIn = { rpc: { ...RATE_LIMIT_ALLOWS, phx_apply_vacation_step_decision: (args, self) => applyStepDecision(self, args) }, tables: tables() };
    await withPostgrestStandIn(decided, async () => {
      const response = await decisionRoutePost(
        devAuthRequest("POST", `/api/vacations/requests/${REQUEST_ID}/decision`, { hrId: "DM-7", role: "District Manager" }, { decision: "approve" }),
        route(REQUEST_ID),
      );
      const body = (await response.json()) as { success?: boolean; request?: { status?: string } };
      assert.equal(response.status, 200, `the same decision with no race is saved — got ${response.status} ${JSON.stringify(body)}`);
      assert.equal(body.request?.status, "pending_hr");
    }, { env: DEV_AUTH_ENV });
  }
}
