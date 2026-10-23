import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ts from "typescript";

import { afterResponse } from "../src/lib/http/after-response.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A BUTTON'S ANSWER NEVER WAITS FOR THE NOTICES IT RAISES (2026-10-23 slow-buttons audit).
//
// Measured on production from Sentry's traces over seven days, before the change: a vacation
// Approve took 6.1 s, an excuse decision 8.0 s, a direct-order decision 7.8 s (22 s at the 95th
// percentile), a marketing decision 10.7 s — while Phoenix CRM's decide, which already sent its
// notices after the reply, took 0.4 s. In the one vacation trace read span by span the decision
// itself was finished at 0.8 s; the other 5.3 s were the notices to HR and the next approver
// (profiles, preferences, event and audit rows, Telegram, the phone push, the templated email),
// awaited one wave after another before the answer left.
//
// What this file pins is the SHAPE: in each listed interactive function, every call that raises a
// notice sits inside `afterResponse(...)` (or the vacation module's `deferVacationNotice(...)`,
// which is `afterResponse` plus the "notification_failed" timeline row). It parses the file with
// the TypeScript compiler, so a comment that quotes the call cannot satisfy it, and each pin is
// handed a broken copy and must fire. It also demands a NON-ZERO count of the calls it checked, so
// a rename that makes it look at nothing cannot pass.
// ─────────────────────────────────────────────────────────────────────────────

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** The wrappers that mean "after the reply" — anything inside one of these is safe. */
const DEFERRING_CALLEES = new Set(["afterResponse", "deferVacationNotice", "deferPlanNotice"]);

export type NoticePinSpec = {
  /** The function whose body is checked. */
  fn: string;
  /** Calls that raise a notice and must therefore run after the reply. */
  calls?: string[];
  /** A thin notice helper: its whole body is one deferred task, so it must still call this wrapper. */
  wraps?: string;
};

function calleeName(node: ts.CallExpression): string | null {
  const expression = node.expression;
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

/** What is wrong with the file: a notice call outside a deferring wrapper, or a call never found. */
export function noticePinsMissing(source: string, specs: NoticePinSpec[]): string[] {
  const file = ts.createSourceFile("subject.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = new Map<string, ts.FunctionDeclaration>();
  file.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) declarations.set(node.name.text, node);
  });

  const missing: string[] = [];
  for (const spec of specs) {
    const declaration = declarations.get(spec.fn);
    if (!declaration?.body) {
      missing.push(`${spec.fn} is not a top-level function of the file`);
      continue;
    }
    const calls = spec.calls ?? [];
    let checked = 0;
    let wrapped = 0;
    const visit = (node: ts.Node, deferred: boolean) => {
      if (ts.isCallExpression(node)) {
        const name = calleeName(node);
        if (name && spec.wraps && name === spec.wraps) wrapped += 1;
        if (name && calls.includes(name)) {
          checked += 1;
          if (!deferred) missing.push(`${spec.fn}: ${name}() runs before the reply is sent`);
        }
        const nextDeferred = deferred || (name !== null && DEFERRING_CALLEES.has(name));
        node.forEachChild((child) => visit(child, nextDeferred));
        return;
      }
      node.forEachChild((child) => visit(child, deferred));
    };
    visit(declaration.body, false);
    if (spec.wraps && wrapped === 0) missing.push(`${spec.fn}: no longer calls ${spec.wraps}(), so its notice runs before the reply`);
    if (calls.length > 0 && checked === 0) missing.push(`${spec.fn}: none of ${calls.join(", ")} was found, so nothing was checked`);
  }
  return missing;
}

function breakCopy(source: string, from: string | RegExp, to: string): string {
  const broken = source.replace(from, to);
  assert.notEqual(broken, source, `the broken copy must actually change the source: ${String(from)}`);
  return broken;
}

function assertFires(missing: string[], expected: string, label: string) {
  assert.ok(
    missing.some((entry) => entry.startsWith(expected)),
    `${label}: expected the pin "${expected}" to fire, got ${JSON.stringify(missing)}`,
  );
}

/** Every file this change reaches, with the interactive functions whose notices must follow the reply. */
export const NOTICE_PINS: Array<{ file: string; specs: NoticePinSpec[] }> = [
  {
    file: "../src/lib/vacation/service.ts",
    specs: [
      { fn: "applyVacationDecisionSequential", calls: ["dispatchVacationManagerReview", "dispatchVacationNextManagerStep"] },
      { fn: "applyVacationDecisionLegacy", calls: ["dispatchVacationManagerReview"] },
    ],
  },
  {
    file: "../src/lib/excuses/service.ts",
    specs: [
      { fn: "notifyManagerOfExcuse", calls: ["deliverManagerOfExcuseNotice"] },
      { fn: "notifyDecisionRecipients", calls: ["deliverDecisionNotices"] },
    ],
  },
  {
    file: "../src/lib/direct-orders/service.ts",
    specs: [
      { fn: "submitDirectOrder", calls: ["notifyDirectOrder"] },
      { fn: "decideDirectOrder", calls: ["notifyDirectOrder"] },
      { fn: "reviseDirectOrder", calls: ["notifyDirectOrder"] },
      { fn: "reverseDirectOrder", calls: ["notifyDirectOrder"] },
      { fn: "cancelHeldDirectOrder", calls: ["notifyDirectOrder"] },
      { fn: "postDirectOrderConversationComment", calls: ["notifyDirectOrderConversation"] },
      { fn: "moveHeldDirectOrdersIntoChain", calls: ["notifyDirectOrder"] },
      { fn: "closeOrphanedDirectOrder", calls: ["notifyDirectOrder"] },
      { fn: "repairDirectOrderApprovalRung", calls: ["notifyDirectOrder"] },
    ],
  },
  {
    file: "../src/lib/marketing-requests/service.ts",
    specs: [
      { fn: "decideMarketingRequestWorkflow", calls: ["notifyMarketingWorkflow"] },
      { fn: "createMarketingRequestDraft", calls: ["notifyMarketingWorkflow", "createSystemNotification"] },
      { fn: "resubmitReturnedMarketingRequest", calls: ["notifyMarketingWorkflow"] },
      { fn: "postMarketingAdvisoryComment", calls: ["notifyAdvisoryComment"] },
      { fn: "postMarketingRequestConversationComment", calls: ["notifyMarketingRequestConversation"] },
    ],
  },
  {
    // The weekly and monthly plan notices are thin helpers whose whole body is one deferred task.
    file: "../src/lib/weekly-planning/service.ts",
    specs: [
      ...[
        "notifyManagerPlanCancelled",
        "notifyPlanSubmitted",
        "notifyMonthlyResynced",
        "notifyCeo",
        "notifySecondApprover",
        "notifyHr",
        "notifyEmployeeReturnedOrRejected",
        "notifyEmployeeManagerApproved",
        "notifyPlanComment",
        "notifyEmployeeAcknowledged",
        "notifyVisitDetailsRequested",
        "notifyManagerEditRequested",
        "notifyEmployeeEditRequestDecision",
      ].map((fn) => ({ fn, wraps: "deferPlanNotice" })),
      { fn: "reassignWeeklyPlanManager", calls: ["notifyManager"] },
      { fn: "submitVisitDetails", calls: ["notifyManager"] },
      { fn: "bulkDecideEmployeePlans", wraps: "afterResponse" },
    ],
  },
  {
    file: "../src/lib/outstation/service.ts",
    specs: [
      { fn: "submitOutstationRequest", calls: ["notifyOutstationSubmitted", "sendOutstationDeparturePhotoReminder"] },
      { fn: "submitMedicalRepSimpleExpenseRequest", calls: ["notifyOutstationSubmitted"] },
      { fn: "createManagerExpenseAsAdmin", calls: ["notifyOutstationSubmitted"] },
      { fn: "approveOutstationRequestForPayroll", calls: ["notifyOutstationSubmitted"] },
      { fn: "rejectOutstationRequestAsAdmin", calls: ["notifyOutstationDecision"] },
    ],
  },
  {
    file: "../app/api/employees/route.ts",
    specs: [{ fn: "POST", calls: ["openAndAnnounceCrmAccountSetup", "openAndAnnounceNewHireMailboxes"] }],
  },
  { file: "../src/lib/business-cards/request-service.ts", specs: [{ fn: "notifyBusinessCardRecipients", wraps: "afterResponse" }] },
  {
    file: "../src/lib/recruitment/interview-requests.ts",
    specs: [
      { fn: "createInterviewRequest", calls: ["notifyInterviewRequestCreated"] },
      { fn: "scheduleInterviewRequestItem", calls: ["notifyInterviewRequestScheduled"] },
    ],
  },
  {
    file: "../src/lib/recruitment/interviews.ts",
    specs: [
      { fn: "createInterview", calls: ["notifyInterview"] },
      { fn: "recordInterviewOutcome", calls: ["notifyInterview", "notifyInterviewFeedback"] },
    ],
  },
  {
    file: "../src/lib/resignations/service.ts",
    specs: [
      { fn: "createResignationForEmployee", calls: ["notifyResignationWorkflow"] },
      { fn: "runResignationWorkflow", calls: ["notifyResignationWorkflow"] },
    ],
  },
  {
    file: "../src/lib/probation/service.ts",
    specs: [
      { fn: "createProbationEvaluation", calls: ["notifyProbationWorkflow"] },
      { fn: "runProbationWorkflow", calls: ["notifyProbationWorkflow"] },
    ],
  },
  {
    file: "../src/lib/contracts/service.ts",
    specs: [
      { fn: "createContractRenewalRequest", calls: ["notifyContractWorkflow"] },
      { fn: "runContractRenewalWorkflow", calls: ["notifyContractWorkflow"] },
    ],
  },
  {
    file: "../src/lib/private-calendar/disputes.ts",
    specs: [
      { fn: "submitPrivateCalendarDataDispute", calls: ["createSystemNotification"] },
      { fn: "decidePrivateCalendarDataDispute", calls: ["createSystemNotification"] },
    ],
  },
  { file: "../src/lib/notifications/settings.ts", specs: [{ fn: "linkTelegramConnection", calls: ["notifyTelegramConnectionLinked"] }] },
];

export async function runNoticesAfterTheReplyTests() {
  // ── The helper itself: outside a request it awaits the task, and it never throws.
  let ran = false;
  await afterResponse("notices-after-the-reply test", async () => {
    ran = true;
    throw new Error("a notice that fails must not reach the caller");
  });
  assert.equal(ran, true, "outside a request scope the task is awaited, exactly as every caller did before");

  // ── Every listed function keeps its notices behind the reply, and each pin fires on a broken copy.
  for (const { file, specs } of NOTICE_PINS) {
    const source = read(file);
    assert.deepEqual(noticePinsMissing(source, specs), [], `${file}: every notice follows the reply`);
  }

  const vacation = read("../src/lib/vacation/service.ts");
  assertFires(
    noticePinsMissing(
      breakCopy(vacation, /await deferVacationNotice\(\{\n(\s+)actorHrId: input\.actorHrId,\n(\s+)actorLoginId: input\.actorLoginId,\n(\s+)label: "next_manager_step"/, 'await Promise.resolve({\n$1actorHrId: input.actorHrId,\n$2actorLoginId: input.actorLoginId,\n$3label: "next_manager_step"'),
      NOTICE_PINS[0].specs,
    ),
    "applyVacationDecisionSequential: dispatchVacationNextManagerStep() runs before the reply",
    "a vacation approval that waits for the next approver's notice again",
  );

  const excuses = read("../src/lib/excuses/service.ts");
  assertFires(
    noticePinsMissing(
      breakCopy(excuses, 'afterResponse("excuse_notice:decision", () => deliverDecisionNotices(input))', "deliverDecisionNotices(input)"),
      NOTICE_PINS[1].specs,
    ),
    "notifyDecisionRecipients: deliverDecisionNotices() runs before the reply",
    "an excuse decision that waits for its notices again",
  );

  const directOrders = read("../src/lib/direct-orders/service.ts");
  assertFires(
    noticePinsMissing(
      breakCopy(directOrders, 'afterResponse("direct_order_notice:decision"', 'Promise.resolve("direct_order_notice:decision"'),
      NOTICE_PINS[2].specs,
    ),
    "decideDirectOrder: notifyDirectOrder() runs before the reply",
    "a direct-order decision that waits for its notices again",
  );
  assertFires(
    noticePinsMissing(
      breakCopy(directOrders, 'afterResponse("direct_order_notice:submitted"', 'Promise.resolve("direct_order_notice:submitted"'),
      NOTICE_PINS[2].specs,
    ),
    "submitDirectOrder: notifyDirectOrder() runs before the reply",
    "a direct-order submit that waits for its notices again",
  );
  assertFires(
    noticePinsMissing(
      breakCopy(directOrders, 'afterResponse("direct_order_notice:held_released"', 'Promise.resolve("direct_order_notice:held_released"'),
      NOTICE_PINS[2].specs,
    ),
    "moveHeldDirectOrdersIntoChain: notifyDirectOrder() runs before the reply",
    "a Held Desk release that waits for its notices again",
  );
  assertFires(
    noticePinsMissing(
      breakCopy(directOrders, 'afterResponse("direct_order_notice:rung_repaired"', 'Promise.resolve("direct_order_notice:rung_repaired"'),
      NOTICE_PINS[2].specs,
    ),
    "repairDirectOrderApprovalRung: notifyDirectOrder() runs before the reply",
    "a repaired rung that waits for its notices again",
  );
  const marketing = read("../src/lib/marketing-requests/service.ts");
  assertFires(
    noticePinsMissing(
      breakCopy(marketing, 'afterResponse("marketing_notice:request_approved"', 'Promise.resolve("marketing_notice:request_approved"'),
      NOTICE_PINS[3].specs,
    ),
    "decideMarketingRequestWorkflow: notifyMarketingWorkflow() runs before the reply",
    "a marketing decision that waits for its notices again",
  );
  assertFires(
    noticePinsMissing(
      breakCopy(marketing, 'afterResponse("marketing_notice:request_submitted"', 'Promise.resolve("marketing_notice:request_submitted"'),
      NOTICE_PINS[3].specs,
    ),
    "createMarketingRequestDraft: createSystemNotification() runs before the reply",
    "a marketing submit that waits for its notices again",
  );
  const weekly = read("../src/lib/weekly-planning/service.ts");
  assertFires(
    noticePinsMissing(
      breakCopy(weekly, 'await deferPlanNotice("manager_approved_employee"', 'await Promise.resolve("manager_approved_employee"'),
      NOTICE_PINS[4].specs,
    ),
    "notifyEmployeeManagerApproved: no longer calls deferPlanNotice()",
    "a plan approval that waits for its notice again",
  );
  assertFires(
    noticePinsMissing(
      breakCopy(weekly, 'await deferPlanNotice("reassigned"', 'await Promise.resolve("reassigned"'),
      NOTICE_PINS[4].specs,
    ),
    "reassignWeeklyPlanManager: notifyManager() runs before the reply",
    "a plan reassignment that waits for its notice again",
  );
  assertFires(
    noticePinsMissing(
      breakCopy(weekly, 'await afterResponse("weekly_plan_notice:batch_decision"', 'await Promise.resolve("weekly_plan_notice:batch_decision"'),
      NOTICE_PINS[4].specs,
    ),
    "bulkDecideEmployeePlans: no longer calls afterResponse()",
    "a batch approval that waits for its notices again",
  );
  const pinsFor = (path: string) => NOTICE_PINS.find((entry) => entry.file === path)!.specs;
  const outstation = read("../src/lib/outstation/service.ts");
  assertFires(
    noticePinsMissing(
      breakCopy(outstation, 'afterResponse("outstation_notice:submitted", async', 'Promise.resolve("outstation_notice:submitted", async'),
      pinsFor("../src/lib/outstation/service.ts"),
    ),
    "submitOutstationRequest: notifyOutstationSubmitted() runs before the reply",
    "an expense submit that waits for its notices again",
  );
  const employeesRoute = read("../app/api/employees/route.ts");
  assertFires(
    noticePinsMissing(
      breakCopy(employeesRoute, 'afterResponse("employee_notice:new_hire_followups"', 'Promise.resolve("employee_notice:new_hire_followups"'),
      pinsFor("../app/api/employees/route.ts"),
    ),
    "POST: openAndAnnounceCrmAccountSetup() runs before the reply",
    "adding an employee that waits for the follow-ups again",
  );
  const resignations = read("../src/lib/resignations/service.ts");
  assertFires(
    noticePinsMissing(
      breakCopy(resignations, 'afterResponse("resignation_notice:workflow"', 'Promise.resolve("resignation_notice:workflow"'),
      pinsFor("../src/lib/resignations/service.ts"),
    ),
    "runResignationWorkflow: notifyResignationWorkflow() runs before the reply",
    "a resignation decision that waits for its notices again",
  );
  const businessCards = read("../src/lib/business-cards/request-service.ts");
  assertFires(
    noticePinsMissing(
      breakCopy(businessCards, 'afterResponse("business_card_notice:created"', 'Promise.resolve("business_card_notice:created"'),
      pinsFor("../src/lib/business-cards/request-service.ts"),
    ),
    "notifyBusinessCardRecipients: no longer calls afterResponse()",
    "a business-card request that waits for its notices again",
  );
  assertFires(
    noticePinsMissing(directOrders, [{ fn: "decideDirectOrder", calls: ["aCallThatDoesNotExist"] }]),
    "decideDirectOrder: none of aCallThatDoesNotExist was found",
    "a pin that looks at nothing",
  );
}
