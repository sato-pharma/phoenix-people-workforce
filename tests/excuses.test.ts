import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { accessRegistry, findAccessRegistryEntry } from "../src/lib/security/access-registry.ts";
import {
  excuseErrorMessage,
  isExcuseExcludedRole,
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
  assert.match(
    serviceSource,
    /import \{ hrIdLookupKeys, resolveStoredHrId \} from "@\/lib\/hr-id"/,
    "excuses must use the shared HR_ID lookup/storage helpers",
  );
  assert.match(
    serviceSource,
    /const employeeHrKeys = hrIdLookupKeys\(employeeHrId\)[\s\S]*\.in\("employee_hr_id", employeeHrKeys\)/,
    "employee excuse history must match A-8/a-8/canonical HR_ID dialects",
  );
  assert.match(
    serviceSource,
    /query = query\.in\("manager_hr_id", hrIdLookupKeys\(actorHrId\)\)/,
    "manager pending excuses must match A-9/a-9/canonical HR_ID dialects",
  );
  assert.match(
    serviceSource,
    /employee_hr_id: employeeHrId/,
    "new excuse requests must store the employee-master HR_ID casing",
  );
  assert.match(
    serviceSource,
    /manager_hr_id: managerHrId/,
    "new excuse requests must store the manager's employee-master HR_ID casing",
  );
  assert.doesNotMatch(
    serviceSource,
    /\.eq\("employee_hr_id", employeeHrId\)/,
    "employee excuse reads must never rely on a single exact HR_ID casing",
  );
  assert.doesNotMatch(
    serviceSource,
    /manager_hr_id: normalizeHrId\(employee\.managerHrId\)/,
    "new excuse requests must not store lower-cased normalized manager HR_IDs",
  );
  assert.doesNotMatch(
    serviceSource,
    /submitted_by_hr_id: normalizeHrId\(access\.hrId\)/,
    "new excuse requests must not store lower-cased normalized submitter HR_IDs",
  );
  // Only a pending request can be decided — guards against double-approval.
  assert.match(
    serviceSource,
    /export async function decideExcuseRequestAsManager[\s\S]{0,1600}requestRow\.status !== "pending_manager"/,
    "decideExcuseRequestAsManager must reject requests that are not pending_manager",
  );
  // NO SESSION-LESS DECISION. These lines used to pin the emailed one-click link's token as
  // single-use, unexpired and bound to the manager. The link is gone (2026-10-26, as the vacation
  // link went in #3274): its raw token was put in no email, so the unauthenticated GET that
  // consumed it could not be reached honestly, and a decision by GET is one a link preview or a
  // mail scanner can take. Inverted rather than deleted: the invariant is stronger now — an excuse
  // is decided signed in, by its assigned manager, or not at all.
  // Matched with a trailing "(" ON PURPOSE, as the vacation guard is, so prose may still name it.
  assert.doesNotMatch(
    serviceSource,
    /decideExcuseRequestByToken\s*\(/,
    "the token decision path must not come back — an excuse is decided signed in, in the Action Center",
  );
  assert.doesNotMatch(
    serviceSource,
    /\.from\("v2_excuse_email_tokens"\)/,
    "no excuse approval token is minted, read or burned any more — the table stays, untouched",
  );
  assert.doesNotMatch(serviceSource, /randomBytes\(/, "a new excuse request mints no token");
  const decisionRouteSource = readFileSync("app/api/excuses/[id]/decision/route.ts", "utf8");
  assert.doesNotMatch(
    decisionRouteSource,
    /export (async )?function GET\b|export const GET\b|export \{[^}]*\bGET\b/,
    "the excuse decision route must answer no GET — a GET that decides is one a link preview can take",
  );
  assert.doesNotMatch(decisionRouteSource, /searchParams\.get\("token"\)/, "the decision route must read no token from the address");
  assert.match(
    decisionRouteSource,
    /export async function POST[\s\S]*assertSameOriginMutation\(request\)[\s\S]*resolveAccessContext\(request\)[\s\S]*decideExcuseRequestAsManager\(access,/,
    "the one decision path is the signed-in, same-origin POST that decides as the assigned manager",
  );
  // The registry describes the route as it is: a session POST, never a public token route.
  const decisionEntries = accessRegistry.filter((entry) => entry.pattern === "/api/excuses/:id/decision");
  assert.equal(decisionEntries.length, 1, "the excuse decision route has one registry entry");
  assert.equal(decisionEntries[0]?.authMode, "session", "the excuse decision route is a session route, not a public-token one");
  assert.deepEqual([...(decisionEntries[0]?.methods ?? [])], ["POST"], "the excuse decision entry declares POST only");
  assert.equal(decisionEntries[0]?.csrf.required, true, "the excuse decision POST is CSRF-checked, as every decision route is");
  assert.notEqual(
    findAccessRegistryEntry("/api/excuses/:id/decision", "GET")?.authMode,
    "public-token",
    "no GET on the excuse decision address may be declared public",
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

  // --- District/Regional Managers are out of the excuse module ENTIRELY -----------------
  // Owner decision 2026-07-30: a DSM or RM neither submits an excuse nor decides one. Excuse is a
  // Head-Office / fingerprint-attendance module and is direct-manager-only, so the field ladder
  // never routes one to them. isExcuseExcludedRole is the single source of truth every gate reads.
  assert.equal(isExcuseExcludedRole("District Manager"), true);
  assert.equal(isExcuseExcludedRole("Regional Manager"), true);
  // The generic Head-Office "Manager" rung is a DIFFERENT role and keeps its excuse authority —
  // it is the people-manager that HO staff actually report to.
  assert.equal(isExcuseExcludedRole("Manager"), false, "the Head-Office Manager rung must keep excuse authority");
  for (const keeps of ["National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager", "Training Manager", "CEO", "Super Admin", "Employee"]) {
    assert.equal(isExcuseExcludedRole(keeps), false, `${keeps} must not be caught by the DSM/RM exclusion`);
  }
  // normalizeRole falls back to "Employee" for junk, so nothing unknown may be excluded either.
  assert.equal(isExcuseExcludedRole(null), false);
  assert.equal(isExcuseExcludedRole(undefined), false);
  assert.equal(isExcuseExcludedRole("not-a-role"), false);

  // Submit side: the exclusion must be checked BEFORE the head-office branch, otherwise an
  // Office-line DSM/RM would slip through isHeadOfficeExcuseEmployee.
  assert.match(
    serviceSource,
    /function canUseExcuses\([\s\S]{0,200}if \(isExcuseExcludedRole\(access\.role\)\) return false;/,
    "canUseExcuses must reject excuse-excluded roles before the head-office branch",
  );
  assert.match(
    serviceSource,
    /async function loadEligibleEmployee[\s\S]{0,700}isExcuseExcludedRole\(access\.role\)/,
    "loadEligibleEmployee must give excuse-excluded roles their own Forbidden message",
  );

  // Approver side: the pending list, the in-app decide path, and the emailed token link.
  assert.match(
    serviceSource,
    /export async function getManagerPendingExcuses[\s\S]{0,900}isExcuseExcludedRole\(access\.role\)\) return \[\]/,
    "getManagerPendingExcuses must return nothing for an excuse-excluded role",
  );
  assert.match(
    serviceSource,
    /export async function decideExcuseRequestAsManager[\s\S]{0,1400}isExcuseExcludedRole\(access\.role\)\) \{[\s\S]{0,200}Forbidden: District and Regional Managers cannot decide excuse requests\./,
    "decideExcuseRequestAsManager must throw a Forbidden for an excuse-excluded role",
  );
  // The emailed approve/reject link resolved the manager's role itself, because it carried no
  // session. The link is gone (see NO SESSION-LESS DECISION above), so the only decision path left
  // is decideExcuseRequestAsManager, whose excluded-role refusal is pinned just above.

  // Never mint a request (or a resubmit) routed to an excluded manager — it would sit at
  // pending_manager forever, recoverable only through reassignExcuseManager.
  assert.match(
    serviceSource,
    /export async function createExcuseRequest[\s\S]{0,1400}await hrIdHoldsExcuseExcludedRole\(managerHrId\)/,
    "createExcuseRequest must refuse to route a new request to an excuse-excluded manager",
  );
  assert.match(
    serviceSource,
    /export async function resubmitExcuseRequest[\s\S]{0,1800}await hrIdHoldsExcuseExcludedRole\(managerHrId\)/,
    "resubmitExcuseRequest must refuse to re-route a returned request to an excuse-excluded manager",
  );

  // The role must come from app_auth_users — a job title is never a permission source — and the
  // lookup must throw rather than fail open, because two callers use it as a gate.
  assert.match(
    serviceSource,
    /async function hrIdHoldsExcuseExcludedRole[\s\S]{0,900}from\("app_auth_users"\)[\s\S]{0,300}\.in\("role", \[\.\.\.EXCUSE_EXCLUDED_ROLES\]\)/,
    "the excluded-role lookup must resolve the access role from app_auth_users",
  );
  assert.match(
    serviceSource,
    /async function hrIdHoldsExcuseExcludedRole[\s\S]{0,900}if \(error\) throw error;/,
    "the excluded-role lookup must throw on a query failure instead of failing open",
  );
  assert.doesNotMatch(
    serviceSource,
    /async function hrIdHoldsExcuseExcludedRole[\s\S]{0,900}\.in\("hr_id"/,
    "the excluded-role lookup must compare HR_IDs via normalizeHrId, not a case-sensitive .in()",
  );

  // Nav config: the Excuse link needs its OWN role list so a future vacation edit can never
  // silently re-grant excuse to a DSM/RM (they were previously sharing one list).
  const navConfigSource = readFileSync("src/config/system-navigation.ts", "utf8");
  assert.match(
    navConfigSource,
    /approvals\/excuse"[^\n]*roles: excuseApproverPortalNavigationRoles/,
    "the portal Excuse Approvals link must use the excuse-specific role list",
  );
  assert.match(
    navConfigSource,
    /approvals\/vacation"[^\n]*roles: vacationApproverPortalNavigationRoles/,
    "Vacation Approvals must keep its own role list, which still includes DSM/RM",
  );
  const excuseNavRoles = navConfigSource.match(/const excuseApproverPortalNavigationRoles = \[([\s\S]*?)\]/);
  assert.ok(excuseNavRoles, "excuseApproverPortalNavigationRoles must exist");
  assert.doesNotMatch(
    excuseNavRoles[1],
    /District Manager|Regional Manager/,
    "the portal Excuse Approvals link must not list District or Regional Manager",
  );

  // Direct URL hits must redirect, not render a permanently empty module.
  for (const pagePath of [
    "app/employee-portals/approvals/excuse/page.tsx",
    "app/employee-portals/approvals/excuse/[id]/page.tsx",
    "app/employee-portals/excuses/page.tsx",
  ]) {
    assert.match(
      readFileSync(pagePath, "utf8"),
      /isExcuseExcludedRole\(access\.role\)/,
      `${pagePath} must redirect an excuse-excluded role instead of rendering the module`,
    );
  }

  // --- Notification workflow: policy channels, HR visibility, and dedicated template ----
  assert.match(
    serviceSource,
    /notifyManagerOfExcuse[\s\S]*channels: \["in_app", "email", "telegram", "push"\]/,
    "submission notifications must use in-app, email, Telegram, and push for the direct manager",
  );
  assert.match(
    serviceSource,
    /notifyManagerOfExcuse[\s\S]*includeHrInbox: true/,
    "submission emails must include HR through the existing HR inbox configuration",
  );
  assert.match(
    serviceSource,
    /notifyHrVisibilityRecipients[\s\S]*channels: \["in_app", "telegram", "push"\]/,
    "HR visibility recipients resolved from the HR email config must also get in-app, Telegram, and push",
  );
  assert.match(
    serviceSource,
    /notifyDecisionRecipients[\s\S]*channels: \["in_app", "email", "telegram", "push"\]/,
    "manager decision notifications must use in-app, email, Telegram, and push for the employee",
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

  // --- Race-condition guards: DB-level compare-and-swap on decision/resubmit updates ----
  // The JS pre-checks above are only a fast-path — the real atomicity guarantee is the
  // status guard on the UPDATE itself, so two concurrent decisions can't both "win".
  assert.match(
    serviceSource,
    /import \{ conflictError \} from "@\/lib\/http\/api-errors"/,
    "excuses service must import conflictError for DB-level conflict detection",
  );
  // (The token decision path had the same two guards; it was removed on 2026-10-26, so the
  // manager path below is the one decision UPDATE left to pin.)
  assert.match(
    serviceSource,
    /export async function decideExcuseRequestAsManager[\s\S]*?\.eq\("id", input\.requestId\)\s*\.eq\("status", "pending_manager"\)/,
    "decideExcuseRequestAsManager status UPDATE must be guarded by a DB-level status compare-and-swap",
  );
  assert.match(
    serviceSource,
    /export async function decideExcuseRequestAsManager[\s\S]*?\.maybeSingle\(\);\s*\n\s*if \(updateError\) throw updateError;\s*\n\s*if \(!updated\) throw conflictError\("This excuse request has already been decided\."\);/,
    "decideExcuseRequestAsManager must reject a lost status race with a conflict error instead of silently overwriting",
  );
  assert.match(
    serviceSource,
    /export async function resubmitExcuseRequest[\s\S]*?\.eq\("id", input\.requestId\)\s*\.eq\("status", "returned_to_employee"\)/,
    "resubmitExcuseRequest status UPDATE must be guarded by a DB-level status compare-and-swap",
  );
  assert.match(
    serviceSource,
    /export async function resubmitExcuseRequest[\s\S]*?\.maybeSingle\(\);\s*\n\s*if \(updateError\) throw updateError;\s*\n\s*if \(!updated\) throw conflictError\("Only returned excuse requests can be resubmitted\."\);/,
    "resubmitExcuseRequest must reject a lost status race with a conflict error instead of silently overwriting",
  );
  assert.doesNotMatch(
    serviceSource,
    /employee_work_email,department_name,line_name,manager_hr_id,manager_name,excuse_date,excuse_type,duration_hours,status,manager_decision,manager_decision_by_hr_id,manager_decision_at,manager_decision_comment,created_at"\)\s*\.single\(\)/,
    "excuse decision/resubmit UPDATEs must use maybeSingle so a lost status race can be detected, not single()",
  );

  // --- reassignExcuseManager: Super-Admin/system re-routes a stuck excuse (never decides it) --
  assert.match(
    serviceSource,
    /export async function reassignExcuseManager/,
    "excuses service must export reassignExcuseManager",
  );
  // Narrowest possible new grant: system-actor OR Super Admin (excuse has no permission-matrix
  // entry and no HR step). Deciding-in-place stays impossible.
  assert.match(
    serviceSource,
    /reassignExcuseManager[\s\S]{0,400}access\.scope === "system" \|\| access\.role === "Super Admin"/,
    "reassignExcuseManager must gate on system-actor OR Super Admin only",
  );
  assert.match(
    serviceSource,
    /reassignExcuseManager[\s\S]{0,800}requestRow\.status !== "pending_manager"/,
    "reassignExcuseManager must only reassign a pending_manager request",
  );
  assert.match(
    serviceSource,
    /reassignExcuseManager[\s\S]{0,1200}isActiveExcuseManager\(newManager\)/,
    "reassignExcuseManager must reject an inactive new manager",
  );
  assert.match(
    serviceSource,
    /reassignExcuseManager[\s\S]{0,1900}manager_hr_id: storedManagerHrId[\s\S]{0,140}manager_name: newManager\.fullName[\s\S]{0,140}manager_work_email: newManager\.workEmail/,
    "reassignExcuseManager must update manager_hr_id/manager_name/manager_work_email",
  );
  assert.doesNotMatch(
    serviceSource,
    /reassignExcuseManager[\s\S]{0,1700}manager_decision:/,
    "reassignExcuseManager must never set manager_decision (reassignment is not deciding-in-place)",
  );
  assert.match(
    serviceSource,
    /reassignExcuseManager[\s\S]{0,2600}writeAuditLog/,
    "reassignExcuseManager must write an audit-log entry with the old→new manager",
  );
  assert.match(
    serviceSource,
    /reassignExcuseManager[\s\S]{0,3300}notifyManagerOfExcuse\(\{[\s\S]{0,200}occurrenceKey: now/,
    "reassignExcuseManager must retarget the manager notification with a fresh occurrence key",
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

  const adminActionPageSource = readFileSync("app/(admin)/admin/approvals-hub/page.tsx", "utf8");
  const portalActionPageSource = readFileSync("app/employee-portals/approvals-hub/page.tsx", "utf8");
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

  const migrationSource = readFileSync("supabase/_migrations_archive/pre-baseline-2026-07-11/20260624154818_excuse_returned_to_employee_status.sql", "utf8");
  assert.match(
    migrationSource,
    /returned_to_employee/,
    "the excuse status migration must allow returned_to_employee",
  );
}
