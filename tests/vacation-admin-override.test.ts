import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  ADMIN_OVERRIDE_STALL_DAYS,
  evaluateAdminOverride,
  resolveActionAvailability,
  resolveStepActivatedAt,
  type VacationOverrideStep,
} from "../src/lib/vacation/approval-flow.ts";

// THE STALLED-APPROVER OVERRIDE (owner instruction, 2026-09-10): a Super Admin may decide a
// management approval step once its approver has sat on it for two days with no response.
//
// The owner chose BOTH of the rules this pins, from two offered alternatives:
//   - one step at a time (the chain carries on; the next approver starts a fresh clock), and
//   - FLAT CALENDAR days, weekends included, not the business days the SLA reminder counts.
//
// Three things here are load-bearing and each fails silently if it regresses:
//   1. the clock starts when the step became ITS approver's to answer, not when the request was
//      created, or clearing step 1 hands step 2 an already-expired timer;
//   2. the override never reaches the HR step or the actor's own request;
//   3. both override keys exist on EVERY branch of resolveActionAvailability. next.config sets
//      ignoreBuildErrors, so an exhaustive Record does NOT gate the build (AGENTS.md, Validation)
//      and a branch that forgot a key would ship with the button quietly missing.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const T0 = Date.parse("2026-09-08T08:00:00Z");
const at = (ms: number) => new Date(T0 + ms);
const iso = (ms: number) => new Date(T0 + ms).toISOString();

function steps(
  overrides: Partial<Record<1 | 2 | 3, Partial<VacationOverrideStep>>> = {},
): VacationOverrideStep[] {
  const base: VacationOverrideStep[] = [
    { createdAt: iso(0), decidedAt: null, order: 1, status: "pending", stepKey: "direct_manager" },
    { createdAt: iso(0), decidedAt: null, order: 2, status: "pending", stepKey: "manager_of_manager" },
    { createdAt: iso(0), decidedAt: null, order: 3, status: "pending", stepKey: "hr" },
  ];
  return base.map((step) => ({ ...step, ...(overrides[step.order as 1 | 2 | 3] ?? {}) }));
}

function evaluate(input: {
  now: Date;
  isAdminActor?: boolean;
  isOwnRequest?: boolean;
  status?: "pending_manager" | "pending_hr" | "approved" | "rejected" | "returned" | "needs_assignment";
  steps?: VacationOverrideStep[];
}) {
  return evaluateAdminOverride({
    isAdminActor: input.isAdminActor ?? true,
    isOwnRequest: input.isOwnRequest ?? false,
    now: input.now,
    status: input.status ?? "pending_manager",
    steps: input.steps ?? steps(),
  });
}

export function runVacationAdminOverrideTests() {
  // The threshold the owner named.
  assert.equal(ADMIN_OVERRIDE_STALL_DAYS, 2, "the owner said two days");

  // Flat calendar days, and the boundary is exact.
  assert.equal(evaluate({ now: at(47 * HOUR) }).available, false, "an hour short of two days is not stalled");
  assert.equal(evaluate({ now: at(2 * DAY - 1) }).available, false, "one millisecond short is still not stalled");
  assert.equal(evaluate({ now: at(2 * DAY) }).available, true, "exactly two days unlocks the override");
  assert.equal(evaluate({ now: at(9 * DAY) }).available, true, "and it stays unlocked");

  // Calendar, NOT business days. A request filed Thursday unlocks on SATURDAY, inside the
  // Egyptian weekend. That is the owner's explicit choice over the business-day alternative he
  // was offered, so it is pinned here rather than treated as a bug to fix later.
  const thursday = Date.parse("2026-09-10T08:00:00Z");
  assert.equal(new Date(thursday).getUTCDay(), 4, "the fixture really is a Thursday");
  const filedThursday = steps({ 1: { createdAt: new Date(thursday).toISOString() } });
  const saturday = new Date(thursday + 2 * DAY);
  assert.equal(saturday.getUTCDay(), 6, "two calendar days later really is a Saturday");
  assert.equal(
    evaluate({ now: saturday, steps: filedThursday }).available,
    true,
    "the clock does not skip the weekend, because the owner chose calendar days",
  );

  // The clock starts when the step became THAT approver's to answer. Step 1 approved five days
  // in; step 2 has held it for one hour. Keying the clock off the request would call that
  // stalled, offering an override against someone who has just been handed the request.
  const secondApproverJustStarted = steps({
    1: { decidedAt: iso(5 * DAY), status: "approved" },
  });
  const justStarted = evaluate({ now: at(5 * DAY + HOUR), steps: secondApproverJustStarted });
  assert.equal(justStarted.available, false, "the second approver's clock starts at the first approval");
  assert.equal(justStarted.step?.order, 2, "and it is step 2 that is waiting");
  assert.ok(
    justStarted.daysPending < 1,
    `the second approver has waited hours, not days (got ${justStarted.daysPending})`,
  );
  assert.equal(
    evaluate({ now: at(7 * DAY + HOUR), steps: secondApproverJustStarted }).available,
    true,
    "two days after the handover, step 2 is overridable in its turn",
  );

  assert.equal(
    resolveStepActivatedAt({
      activeStep: { createdAt: iso(0), order: 2 },
      steps: secondApproverJustStarted,
    }),
    iso(5 * DAY),
    "activation is the latest prior decision, not the step's own creation",
  );

  // Who it is never offered to.
  assert.equal(evaluate({ now: at(9 * DAY), isAdminActor: false }).available, false, "not for a non-admin");
  assert.equal(evaluate({ now: at(9 * DAY), isOwnRequest: true }).available, false, "never on your own request");

  // Which steps it never reaches. The HR step is the Super Admin's own, so an override there
  // would be a self-override, and the sequencing already holds it until management is done.
  const managementDone = steps({
    1: { decidedAt: iso(HOUR), status: "approved" },
    2: { decidedAt: iso(2 * HOUR), status: "approved" },
  });
  const atHr = evaluate({ now: at(30 * DAY), status: "pending_hr", steps: managementDone });
  assert.equal(atHr.available, false, "the HR step is never overridable, however long it has waited");
  assert.match(String(atHr.reason), /HR acknowledgement/i, "and it says why");

  for (const status of ["approved", "rejected", "returned", "needs_assignment"] as const) {
    assert.equal(
      evaluate({ now: at(30 * DAY), status }).available,
      false,
      `a ${status} request has no stalled management approver`,
    );
  }

  // Only the ACTIVE step is offered, never a later one whose turn has not come.
  const active = evaluate({ now: at(9 * DAY) });
  assert.equal(active.step?.order, 1, "the lowest-order pending management step is the one offered");
  assert.equal(active.step?.stepKey, "direct_manager");

  // Fails CLOSED on a wait it cannot measure.
  const unreadable = evaluate({ now: at(30 * DAY), steps: steps({ 1: { createdAt: null } }) });
  assert.equal(unreadable.available, false, "an unreadable start time refuses rather than assumes");
  assert.match(String(unreadable.reason), /unreadable/i);

  // It tells HR when the button will appear, before it appears.
  const waiting = evaluate({ now: at(HOUR) });
  assert.equal(waiting.availableAt, iso(2 * DAY), "the unlock instant is exposed before it arrives");
  assert.ok(waiting.reason && waiting.reason.includes("2"), "and the reason names the threshold");

  // Both override keys exist on EVERY branch: the ignoreBuildErrors guard.
  const branches: Array<{ name: string; input: Parameters<typeof resolveActionAvailability>[0] }> = [
    { name: "terminal", input: { status: "approved", steps: [], actorStep: null, isHrActor: true } },
    { name: "returned", input: { status: "returned", steps: [], actorStep: null, isHrActor: true } },
    {
      name: "needs_assignment",
      input: { status: "needs_assignment", steps: [], actorStep: null, isHrActor: true },
    },
    {
      name: "no actor step",
      input: { status: "pending_manager", steps: [], actorStep: null, isHrActor: false },
    },
    {
      name: "hr actor",
      input: {
        status: "pending_manager",
        steps: [{ order: 3, status: "pending", stepKey: "hr" }],
        actorStep: { stepKey: "hr", order: 3 },
        isHrActor: true,
      },
    },
    {
      name: "management actor",
      input: {
        status: "pending_manager",
        steps: [{ order: 1, status: "pending", stepKey: "direct_manager" }],
        actorStep: { stepKey: "direct_manager", order: 1 },
        isHrActor: false,
      },
    },
  ];

  for (const branch of branches) {
    const withoutOverride = resolveActionAvailability(branch.input);
    assert.ok(
      Object.hasOwn(withoutOverride, "overrideApprove") && Object.hasOwn(withoutOverride, "overrideReject"),
      `${branch.name}: both override keys must be present`,
    );
    assert.equal(withoutOverride.overrideApprove.enabled, false, `${branch.name}: no override unless offered`);
    assert.equal(withoutOverride.overrideReject.enabled, false, `${branch.name}: no override unless offered`);

    const offered = resolveActionAvailability({
      ...branch.input,
      override: { available: true, availableAt: iso(2 * DAY), daysPending: 3, reason: null, step: null },
    });
    assert.equal(offered.overrideApprove.enabled, true, `${branch.name}: an offered override reaches the UI`);
    assert.equal(offered.overrideReject.enabled, true, `${branch.name}: an offered override reaches the UI`);
    assert.equal(
      offered.approve.enabled,
      withoutOverride.approve.enabled,
      `${branch.name}: the override must not disturb the ordinary approve button`,
    );
  }

  // ── The four buttons, as one set (owner, 2026-09-10) ──────────────────────
  // On a request still waiting on a manager, the HR viewer sees all four: Reject as HR live,
  // Acknowledge as HR greyed with its reason, and both System Administrator buttons live.
  // The greyed one is the point — it must carry a reason, or it is just a dead control.
  const hrOnStalled = resolveActionAvailability({
    status: "pending_manager",
    steps: [
      { order: 1, status: "pending", stepKey: "direct_manager" },
      { order: 2, status: "pending", stepKey: "manager_of_manager" },
      { order: 3, status: "pending", stepKey: "hr" },
    ],
    actorStep: { stepKey: "hr", order: 3 },
    isHrActor: true,
    override: { available: true, availableAt: iso(2 * DAY), daysPending: 2.5, reason: null, step: null },
  });
  assert.equal(hrOnStalled.reject.enabled, true, "HR may reject at any stage");
  assert.equal(hrOnStalled.acknowledge.enabled, false, "HR acknowledgement still waits for management");
  assert.ok(
    hrOnStalled.acknowledge.disabledReason && hrOnStalled.acknowledge.disabledReason.length > 0,
    "the greyed Acknowledge button must say why it is off",
  );
  assert.equal(hrOnStalled.overrideApprove.enabled, true);
  assert.equal(hrOnStalled.overrideReject.enabled, true);

  // Acknowledging becomes live the moment management is done, and the transfer then retires.
  const hrAfterManagement = resolveActionAvailability({
    status: "pending_hr",
    steps: [
      { order: 1, status: "approved", stepKey: "direct_manager" },
      { order: 2, status: "approved", stepKey: "manager_of_manager" },
      { order: 3, status: "pending", stepKey: "hr" },
    ],
    actorStep: { stepKey: "hr", order: 3 },
    isHrActor: true,
    override: evaluate({ now: at(30 * DAY), status: "pending_hr", steps: managementDone }),
  });
  assert.equal(hrAfterManagement.acknowledge.enabled, true, "Acknowledge as HR goes live at HR's turn");
  assert.equal(hrAfterManagement.overrideApprove.enabled, false, "and the transfer is no longer offered");

  const DETAIL = readFileSync(
    fileURLToPath(new URL("../src/components/approvals-hub/vacation-request-detail.tsx", import.meta.url)),
    "utf8",
  );
  assert.ok(
    DETAIL.includes('acknowledge: "Acknowledge as HR"') && DETAIL.includes('reject: "Reject as HR"'),
    "the HR buttons name the HR seat, so the four read as one set",
  );
  // A manager deciding a vacation is NOT HR — the naming must never leak to their screen.
  assert.ok(
    DETAIL.includes('detail.viewerStepKind === "hr"'),
    "the \"as HR\" naming and the greyed set are gated on the viewer actually being HR",
  );

  // The server, not the button, is the boundary.
  const SERVICE = readFileSync(
    fileURLToPath(new URL("../src/lib/vacation/service.ts", import.meta.url)),
    "utf8",
  );
  const ROUTE = readFileSync(
    fileURLToPath(new URL("../app/api/vacations/requests/[id]/decision/route.ts", import.meta.url)),
    "utf8",
  );

  assert.ok(
    ROUTE.includes("override: body.override === true"),
    "the route must pass the override intent through, strictly",
  );
  assert.ok(
    SERVICE.includes("only the System Administrator can respond on an unanswered request"),
    "the service re-checks Super Admin: the button is UX, the service is the boundary",
  );
  assert.ok(
    SERVICE.includes("a transferred approval can approve or reject, not return the request"),
    "a transferred approval cannot return the request to the employee",
  );
  // Since 13 Nov 2026 (F-HR-010) the step is decided inside phx_apply_vacation_step_decision /
  // phx_apply_vacation_paid_approval_with_step; both are handed the overriding admin.
  assert.ok(
    SERVICE.includes("const stepOverriddenByHrId = overrideContext ? hrIdForStorage(input.actorHrId) || null : null;") &&
      SERVICE.split("p_overridden_by_hr_id: stepOverriddenByHrId,").length === 3,
    "the decided step must record WHO overrode it, or it reads as the approver's own decision",
  );
  assert.ok(
    SERVICE.includes('eventType: "approval_admin_override"'),
    "an override must be findable by event type, not by parsing a comment",
  );
  // ── The owner's wording, 2026-09-10 ───────────────────────────────────────
  // He rejected the first draft ("X overrode Rasha Sabry"): no blame, no naming the approver who
  // did not reply, and the System Administrator must be shown as the one who responded.
  assert.ok(
    SERVICE.includes("so its approval was transferred to the System Administrator"),
    "the stored comment states the transfer, politely",
  );
  assert.ok(
    SERVICE.includes("by ${adminName}, System Administrator."),
    "and names the System Administrator as the responder",
  );
  for (const blunt of ["[OVERRIDE]", "overrode", "in place of", "in your place", "was overridden"]) {
    assert.ok(
      !SERVICE.includes(blunt),
      `no user-facing string may say "${blunt}" — the owner asked for courteous wording`,
    );
  }
  // The approver who did not reply is named ONCE, in the audit metadata, and never in prose.
  assert.equal(
    SERVICE.split("overrideContext.approverName").length - 1,
    1,
    "the unresponsive approver is recorded for audit but never named in a message",
  );

  const BUTTONS = readFileSync(
    fileURLToPath(new URL("../src/components/approvals-hub/decision-actions.tsx", import.meta.url)),
    "utf8",
  );
  assert.ok(
    BUTTONS.includes('overrideApprove: "Approve as System Administrator"') &&
      BUTTONS.includes('overrideReject: "Reject as System Administrator"'),
    "the buttons read as the System Administrator responding, not as an override",
  );
  assert.ok(
    !/Override & (approve|reject)/.test(BUTTONS),
    "no button says Override",
  );

  // The notice to the overridden approver must never become an email. This is an internal
  // workflow correction, and explicit channels only ever remove (AGENTS.md, never-fire-bulk).
  const noticeStart = SERVICE.indexOf('title: "Approval transferred to the System Administrator"');
  assert.ok(noticeStart > 0, "the assigned approver is still told where the request went");
  assert.ok(
    SERVICE.slice(Math.max(0, noticeStart - 1400), noticeStart).includes(
      'channels: ["in_app", "telegram", "push"]',
    ),
    "the assigned approver is told in-app, never by email",
  );
}
