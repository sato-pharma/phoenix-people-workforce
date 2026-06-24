import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  excuseErrorMessage,
  isExcusesSchemaMissing,
  isHeadOfficeExcuseEmployee,
  parseExcuseDecision,
  parseExcuseType,
} from "../src/lib/excuses/service.ts";

export async function runExcusesTests() {
  // --- parseExcuseType: only morning/afternoon, case-insensitive, trimmed ---------------
  assert.equal(parseExcuseType("morning"), "morning");
  assert.equal(parseExcuseType("  AFTERNOON "), "afternoon");
  assert.equal(parseExcuseType("Morning"), "morning");
  assert.equal(parseExcuseType("evening"), null, "unknown excuse types must be rejected");
  assert.equal(parseExcuseType(""), null);
  assert.equal(parseExcuseType(null), null);
  assert.equal(parseExcuseType(undefined), null);

  // --- parseExcuseDecision: accepts both imperative and past-tense forms ----------------
  assert.equal(parseExcuseDecision("approve"), "approve");
  assert.equal(parseExcuseDecision("approved"), "approve");
  assert.equal(parseExcuseDecision("reject"), "reject");
  assert.equal(parseExcuseDecision("rejected"), "reject");
  assert.equal(parseExcuseDecision("return"), "return");
  assert.equal(parseExcuseDecision("returned_to_employee"), "return");
  assert.equal(parseExcuseDecision("  Approve "), "approve");
  assert.equal(parseExcuseDecision("maybe"), null, "unknown decisions must be rejected");
  assert.equal(parseExcuseDecision(null), null);

  // --- isHeadOfficeExcuseEmployee: head-office by line or department, fuzzy-normalized ---
  assert.equal(isHeadOfficeExcuseEmployee({ lineName: "Office", departmentName: null }), true);
  assert.equal(isHeadOfficeExcuseEmployee({ lineName: "Head Office", departmentName: null }), true);
  assert.equal(isHeadOfficeExcuseEmployee({ lineName: null, departmentName: "HQ" }), true);
  assert.equal(isHeadOfficeExcuseEmployee({ lineName: "CNS", departmentName: "Sales" }), false,
    "field/sales employees are not head-office excuse-eligible");
  assert.equal(isHeadOfficeExcuseEmployee({ lineName: null, departmentName: null }), false);

  // --- excuseErrorMessage: Error -> message, otherwise stringified safely ----------------
  assert.equal(excuseErrorMessage(new Error("boom")), "boom");
  assert.equal(excuseErrorMessage("raw string"), "raw string");
  assert.equal(excuseErrorMessage(null), "");

  // --- isExcusesSchemaMissing: recognizes a missing-table error ---------------------------
  assert.equal(
    isExcusesSchemaMissing(new Error('relation "v2_excuse_requests" does not exist')),
    true,
    "a missing excuses table must be detected so the workspace degrades gracefully",
  );
  assert.equal(isExcusesSchemaMissing(new Error("some unrelated failure")), false);

  // --- State-machine + authorization invariants (source-asserted) ------------------------
  const serviceSource = readFileSync("src/lib/excuses/service.ts", "utf8");
  // Only a pending request can be decided — guards against double-approval.
  assert.match(
    serviceSource,
    /requestRow\.status !== "pending_manager"/,
    "decideExcuseRequestByToken must reject requests that are not pending_manager",
  );
  // The approval token must be single-use, unexpired, and bound to the request's manager.
  assert.match(serviceSource, /tokenData\.used_at/, "approval token must be rejected once used");
  assert.match(serviceSource, /tokenData\.expires_at|expires_at\).getTime\(\)/, "approval token must honour expiry");
  assert.match(
    serviceSource,
    /normalizeHrId\(tokenData\.manager_hr_id\) !== normalizeHrId\(requestRow\.manager_hr_id\)/,
    "only the request's assigned manager may decide via the token link",
  );
  // After a decision, the token is burned so the link cannot be replayed.
  assert.match(
    serviceSource,
    /v2_excuse_email_tokens[\s\S]*used_at: now/,
    "the approval token must be marked used after a decision",
  );
  // Access is restricted to the eligible roles or head-office employees.
  assert.match(
    serviceSource,
    /National Sales Manager"[\s\S]*isHeadOfficeExcuseEmployee/,
    "excuses must be limited to eligible roles or head-office employees",
  );
  // Product / Group Product / Training Managers are also excuse-eligible.
  assert.match(
    serviceSource,
    /"Product Manager"[\s\S]*"Group Product Manager"[\s\S]*"Training Manager"/,
    "excuses must also be available to PM/GPM/TM",
  );

  // --- Notification workflow: policy channels, HR visibility, and dedicated template ----
  assert.match(
    serviceSource,
    /notifyManagerOfExcuse[\s\S]*channels: \["in_app", "email", "telegram"\]/,
    "submission notifications must use in-app, email, and Telegram for the direct manager",
  );
  assert.match(
    serviceSource,
    /notifyManagerOfExcuse[\s\S]*includeHrInbox: true/,
    "submission emails must include HR through the existing HR inbox configuration",
  );
  assert.match(
    serviceSource,
    /notifyHrVisibilityRecipients[\s\S]*channels: \["in_app", "telegram"\]/,
    "HR visibility recipients resolved from the HR email config must also get in-app and Telegram",
  );
  assert.match(
    serviceSource,
    /notifyDecisionRecipients[\s\S]*channels: \["in_app", "email", "telegram"\]/,
    "manager decision notifications must use in-app, email, and Telegram for the employee",
  );
  assert.match(
    serviceSource,
    /notifyDecisionRecipients[\s\S]*includeHrInbox: true/,
    "manager decision emails must include HR through the existing HR inbox configuration",
  );
  assert.match(
    serviceSource,
    /Manager reply\/reason/,
    "decision notifications must include the manager reply or reason when provided",
  );
  assert.match(
    serviceSource,
    /notifyDecisionRecipients[\s\S]*templateKey: EMAIL_TEMPLATE_KEYS\.EXCUSE_DECISION/,
    "the employee decision email must pin the excuse_decision template",
  );
  assert.match(
    serviceSource,
    /notifyDecisionRecipients[\s\S]*templateContext: \{[\s\S]*excuseDate:[\s\S]*excuseType:[\s\S]*status:/,
    "the employee decision email must supply excuseDate/excuseType/status tokens",
  );
  assert.doesNotMatch(
    serviceSource,
    /void notify(?:ManagerOfExcuse|DecisionRecipients)[\s\S]*?catch\(\(\) => undefined\)/,
    "excuse notifications must be awaited so API responses cannot return before delivery rows are created",
  );
  assert.match(
    serviceSource,
    /await notifyManagerOfExcuse\(\{ directory, employee, manager, request, type: "submitted" \}\)/,
    "new excuse submissions must wait for manager and HR notification fan-out",
  );
  assert.match(
    serviceSource,
    /await notifyDecisionRecipients\(\{/,
    "manager decisions must wait for employee and HR notification fan-out",
  );

  // --- Return and resubmit state machine ------------------------------------------------
  assert.match(serviceSource, /returned_to_employee/, "excuses must support the returned_to_employee status");
  assert.match(
    serviceSource,
    /input\.decision === "return"[\s\S]*manager reply is required/i,
    "returning an excuse must require a manager reply",
  );
  assert.match(
    serviceSource,
    /export async function resubmitExcuseRequest[\s\S]*requestRow\.status !== "returned_to_employee"/,
    "only returned excuses can be resubmitted",
  );
  assert.match(
    serviceSource,
    /resubmitExcuseRequest[\s\S]*status: "pending_manager"/,
    "resubmitting a returned excuse must send it back to pending_manager",
  );
  assert.match(
    serviceSource,
    /resubmitExcuseRequest[\s\S]*writeAuditLog/,
    "resubmission must preserve the prior decision trail through audit logging",
  );
  assert.match(
    serviceSource,
    /occurrenceKey: now/,
    "resubmission notification idempotency must include a fresh occurrence key",
  );
  assert.match(
    serviceSource,
    /await notifyManagerOfExcuse\(\{[\s\S]*occurrenceKey: now[\s\S]*type: "resubmitted"[\s\S]*\}\)/,
    "returned excuse resubmissions must wait for fresh manager and HR notification fan-out",
  );

  // --- Telegram governance: both singular and plural module names must be allowed -------
  const telegramSource = readFileSync("src/lib/notifications/telegram-governance.ts", "utf8");
  assert.match(telegramSource, /module: "excuse"/, "telegram governance must allow the singular excuse module used by notifications");
  assert.match(telegramSource, /module: "excuses"/, "telegram governance must keep the existing plural excuses module allowance");

  // --- Action Center deep-link safety and routing ---------------------------------------
  const hubSource = readFileSync("src/components/action-center/action-center-hub.tsx", "utf8");
  assert.doesNotMatch(
    hubSource,
    /found \? found\.id : initialData\.items\[0\]\?\.id/,
    "Action Center must never fall back to the first item when a deep-linked item is missing",
  );
  assert.match(
    hubSource,
    /request from this notification was not found/i,
    "Action Center must show a clear missing deep-link state",
  );
  assert.match(
    hubSource,
    /handleExcuseAction\(decision: "approve" \| "reject" \| "return"\)/,
    "Action Center must expose approve, reject, and return decisions for excuses",
  );
  assert.match(
    hubSource,
    /Return with reply/,
    "Action Center must render the return-with-reply manager action",
  );
  assert.match(
    hubSource,
    /selected\.readOnlyReason/,
    "HR visibility deep links must be read-only unless the caller is the assigned manager",
  );

  const adminActionPageSource = readFileSync("app/(admin)/admin/action-center/page.tsx", "utf8");
  const portalActionPageSource = readFileSync("app/employee-portals/actions/page.tsx", "utf8");
  assert.match(adminActionPageSource, /preservedQuery/, "admin Action Center redirects must preserve module/id query params");
  assert.match(portalActionPageSource, /preservedQuery/, "portal Action Center redirects must preserve module/id query params");
  assert.match(
    adminActionPageSource,
    /getActionCenterDeepLinkItem/,
    "admin Action Center must hydrate exact HR-visible excuse deep links",
  );
  assert.match(
    portalActionPageSource,
    /linkedMyRequest/,
    "portal Action Center must route employee-owned deep links to My requests",
  );

  const migrationSource = readFileSync("supabase/migrations/20260624154818_excuse_returned_to_employee_status.sql", "utf8");
  assert.match(
    migrationSource,
    /returned_to_employee/,
    "the excuse status migration must allow returned_to_employee",
  );
}
