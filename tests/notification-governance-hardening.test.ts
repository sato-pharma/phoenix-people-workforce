import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function assertContains(text: string, pattern: RegExp, message: string) {
  assert.match(text, pattern, message);
}

function assertNotContains(text: string, pattern: RegExp, message: string) {
  assert.doesNotMatch(text, pattern, message);
}

export function runNotificationGovernanceHardeningTests() {
  const policySource = source("src/lib/notifications/policy.ts");
  const systemSource = source("src/lib/notifications/system.ts");
  const emailSource = source("src/lib/notifications/email.ts");
  const auditScriptSource = source("scripts/audit-notification-email-identity.ts");
  const outstationSource = source("src/lib/outstation/service.ts");
  const vacationSource = source("src/lib/vacation/service.ts");
  const accessRegistrySource = source("src/lib/security/access-registry.ts");
  const internalMessagesSource = source("src/lib/internal-messages/service.ts");

  // Finding #39: explicit-recipient resolution must batch the employees/app_auth_users
  // lookups with a single .in("hr_id", ...) query per table instead of issuing one
  // Supabase round trip per HR_ID (N+1).
  assertContains(
    policySource,
    /async function candidatesByHrIds\(hrIds: string\[\]\)/,
    "resolver must expose a batched multi-HR_ID candidate lookup",
  );
  assertContains(
    policySource,
    /\.from\("employees"\)\s*\n?\s*\.select\("hr_id,full_name,nickname,work_email,manager_hr_id,department_id,line_id,area_id,team_id,employment_status"\)\s*\n?\s*\.in\("hr_id",\s*normalized\)/,
    "batched candidate lookup must fetch employees via a single .in() query",
  );
  assertContains(
    policySource,
    /\.from\("app_auth_users"\)\s*\n?\s*\.select\("login_id,hr_id,name,auth_email,role,is_active,line,manager_hr_id"\)\s*\n?\s*\.in\("hr_id",\s*normalized\)/,
    "batched candidate lookup must fetch app_auth_users via a single .in() query",
  );
  assertContains(
    policySource,
    /const candidateMap = await candidatesByHrIds\(hrIds\);/,
    "explicit recipient resolution must use the batched lookup, not per-ID Promise.all",
  );
  assertNotContains(
    policySource,
    /const candidates = await Promise\.all\(hrIds\.map\(\(hrId\) => candidateByHrId\(hrId\)\)\);/,
    "explicit recipient resolution must not issue one Supabase query pair per HR_ID (N+1)",
  );

  // Finding #40: fire-and-forget notification sends must never swallow their failure
  // silently — every guarded send logs (console + Sentry) via the shared helper.
  assertContains(
    systemSource,
    /export function logNotificationSendFailure\(context: string, error: unknown\)/,
    "system module must expose a shared logger for best-effort notification-send failures",
  );
  assertContains(
    systemSource,
    /logError\(`\[notifications\] \$\{context\} failed`,\s*\{\s*labels:\s*\{\s*event:\s*"notification_send_failed",\s*context\s*\},\s*error,?\s*\}\)/,
    "shared failure logger must report to Sentry, not just console",
  );
  assertContains(
    systemSource,
    /logNotificationSendFailure\("system\.telegramRetryExhaustionFallback",\s*error\)/,
    "telegram retry-exhaustion fallback must log its swallowed failure",
  );
  assertContains(
    internalMessagesSource,
    /logNotificationSendFailure\("internalMessages\.sendInternalMessage",\s*error\)/,
    "internal-message-sent notification must log its swallowed failure",
  );
  assertNotContains(internalMessagesSource, /\.catch\(\(\) => undefined\)/, "internal message notification send must not swallow errors without logging");

  assertContains(
    policySource,
    /notification_governance_fail_closed/,
    "recipient resolver must explicitly mark unresolved recipient cases as fail-closed",
  );
  assertContains(
    systemSource,
    /createGovernanceSkippedNotification/,
    "engine must create a governed skipped notification when no exact recipient resolves",
  );
  assertContains(
    systemSource,
    /notification governance fail-closed/,
    "engine must create an audit event for governed skips",
  );
  assertContains(
    systemSource,
    /status:\s*"skipped"/,
    "governance skips must create skipped delivery records",
  );
  assertContains(
    systemSource,
    /resolvedEmailIdentity\(input,\s*recipient\)/,
    "email payloads must resolve subject identity through the centralized identity contract",
  );
  assertContains(
    systemSource,
    /employeeHrId:\s*identity\.employeeHrId/,
    "email payloads must use the resolved subject employee HR ID",
  );
  assertContains(
    systemSource,
    /source:\s*"email\.employeeHrId"[\s\S]*source:\s*"subjectHrId"[\s\S]*source:\s*"metadata\.employeeHrId"[\s\S]*source:\s*"metadata\.subjectHrId"[\s\S]*source:\s*"metadata\.requestOwnerHrId"[\s\S]*source:\s*"metrics\.Employee"/,
    "email payload HR ID precedence must be explicit email subject, notification subject, metadata subject, then Employee metric",
  );
  assertContains(
    systemSource,
    /validateNotificationEmailIdentity\(emailInput\)/,
    "system notification email sends and deferred drains must validate identity before delivery",
  );
  assertContains(
    systemSource,
    /Object\.assign\(deferredMetadata,\s*emailDeliveryMetadata\(identity,\s*emailInput\)\)[\s\S]*status:\s*"skipped"/,
    "quiet-hours deferral must skip unsafe email identity instead of persisting a bad emailInput",
  );
  assertContains(
    systemSource,
    /emailEnvelope:\s*envelope[\s\S]*emailIdentity:\s*identity\.metadata/,
    "email delivery metadata must retain both identity proof and the TO/CC envelope",
  );
  assertContains(
    emailSource,
    /export function validateNotificationEmailIdentity/,
    "email layer must expose a reusable identity validator for immediate sends, outbox retry, and audits",
  );
  assertContains(
    emailSource,
    /employee HR ID \$\{employeeHrId\} conflicts with Employee metric HR ID/,
    "email identity validator must catch historical recipient/subject HR ID mismatches using the Employee metric",
  );
  assertContains(
    emailSource,
    /markNotificationOutboxSkipped\(claimed,\s*identity\.reason,\s*"unsafe_identity"\)/,
    "unsafe queued email payloads must be terminally skipped before retry delivery",
  );
  assertContains(
    auditScriptSource,
    /notification_outbox/,
    "production audit must inspect notification_outbox payloads",
  );
  assertContains(
    auditScriptSource,
    /notification_deliveries/,
    "production audit must inspect deferred delivery emailInput payloads",
  );
  assertContains(
    auditScriptSource,
    /notification_events/,
    "production audit must inspect notification event metadata",
  );
  assertContains(
    auditScriptSource,
    /--allow-production-readonly/,
    "production audit must require an explicit read-only production flag",
  );
  assertContains(
    auditScriptSource,
    /ozucdzovmcqvepbozvqf/,
    "production audit must refuse non-Phoenix-production Supabase targets",
  );
  assertContains(
    outstationSource,
    /subjectHrId:\s*r\.employeeHrId/,
    "outstation approval fan-out must explicitly carry the submitting employee as subject",
  );
  assertContains(
    vacationSource,
    /subjectHrId:\s*input\.request\.employeeHrId/,
    "vacation approval fan-out must explicitly carry the requesting employee as subject",
  );

  // Deeper audit finding B: 9 previously-silent vacation notification-send failures now log an
  // auditable notification_failed vacation_event, matching the pattern already used by sibling
  // call sites (e.g. dispatchVacationNextManagerStep) instead of a bare .catch(() => undefined).
  assertNotContains(
    vacationSource,
    /reviewUrl:\s*absoluteReviewUrl,\s*\}\)\.catch\(\(\) => undefined\)/,
    "the submit-time manager decision email must not swallow its failure silently",
  );
  // The optional `.then(...)` is the skip recorder added 2026-09-05: sendPhoenixEmail can RETURN
  // `{ skipped: true }` instead of throwing, and a skip left no trace anywhere (these sends bypassed
  // notification_outbox then; since REC-048, 13 Nov 2026, each writes its outbox row first through
  // sendDurableEmail, and tests/durable-approval-emails.test.ts pins that). The recorder sits between the send and this `.catch`, so the adjacency
  // this regex used to require is gone — but the assertion's intent is unchanged and still
  // enforced: the failure path must log via insertVacationEvent rather than be swallowed. The
  // `.then` alternative is length-bounded so this cannot silently match some distant `.catch`.
  assertContains(
    vacationSource,
    /reviewUrl:\s*absoluteReviewUrl,\s*\}\)(?:\.then\(async \(result\) => \{[\s\S]{0,400}?\}\))?\.catch\(async \(error\) => \{\s*await insertVacationEvent\(\{\s*actorHrId:\s*input\.request\.employeeHrId,/,
    "the submit-time manager decision email failure must be logged via insertVacationEvent",
  );
  assertContains(
    vacationSource,
    /sendVacationManagerStepResultEmail\(\{[\s\S]*?\}\)\.catch\(async \(error\) => \{/,
    "the manager step-result email failure must be logged, not silently swallowed",
  );
  assertContains(
    vacationSource,
    /title:\s*"Vacation request returned for revision",\s*type:\s*"return",\s*\}\)\.catch\(async \(error\) => \{/,
    "the employee return notification failure must be logged, not silently swallowed",
  );
  assertContains(
    vacationSource,
    /title:\s*`\$\{returned\.employeeName\}'s vacation request was returned for revision`,\s*type:\s*"return_hr_notice",\s*\}\)\.catch\(async \(error\) => \{/,
    "the HR return notification failure must be logged, not silently swallowed",
  );
  assertContains(
    vacationSource,
    /sendVacationReturnedEmail\(\{[\s\S]*?\}\)\.catch\(async \(error\) => \{/,
    "the return email failure must be logged, not silently swallowed",
  );
  assertContains(
    vacationSource,
    /title:\s*"Vacation request resubmitted",\s*type:\s*"resubmit",\s*\}\)\.catch\(async \(error\) => \{/,
    "the manager resubmit notification failure must be logged, not silently swallowed",
  );
  assertContains(
    vacationSource,
    /title:\s*"Your vacation request has been resubmitted",\s*type:\s*"employee_resubmit_confirm",\s*\}\)\.catch\(async \(error\) => \{/,
    "the employee resubmit-confirmation notification failure must be logged, not silently swallowed",
  );
  assertNotContains(
    systemSource,
    /employeeHrId:\s*recipient\.hrId\s*\?\?\s*input\.email\?\.employeeHrId/,
    "governed manager/HR emails must not label the recipient HR ID as the employee HR ID",
  );
  assertNotContains(
    policySource,
    /authUsersByRole\(\["manager",\s*"hr"\]\)/,
    "wrong manager/HR fallback must not be used for missing assigned approvers",
  );
  assertNotContains(
    policySource,
    /else\s*\{\s*recipients\.push\(\.\.\.await authUsersByRole/,
    "resolver must not broaden unresolved workflows to role recipients",
  );

  assertContains(policySource, /"line_manager"/, "resolver must support line manager strategy");
  assertContains(policySource, /"department_head"/, "resolver must support department head strategy");
  assertContains(policySource, /"area_manager"/, "resolver must support area manager strategy");
  assertContains(policySource, /"team_manager"/, "resolver must support team manager strategy");
  assertContains(policySource, /permission_based/, "resolver must support permission-based recipients");
  assertNotContains(
    policySource,
    /normalizeRole/,
    "notification governance must not normalize descriptive job titles into Phoenix permission roles",
  );
  assertContains(
    policySource,
    /parseRoleStrict/,
    "notification governance must parse explicit app roles strictly",
  );
  assertContains(policySource, /canAccess\(context,\s*policy\.permissionResource,\s*policy\.permissionAction\)/, "permission-based recipients must use Phoenix permission checks");
  // Regression guard (generalized from the probation cross-line leak, PR #1199): permission
  // recipients must match the subject's own manager chain (or an explicit company/system-scope
  // role), never a same-department/area/team/line coworker via a coarse org-unit lookup —
  // department_id alone can span 90+ employees across every product line in this org.
  assertNotContains(
    policySource,
    /hasOrgScope/,
    "permission recipients must not fall back to department/area/team/line org-unit matching",
  );
  assertContains(policySource, /inManagerChain\(candidate,\s*subject,\s*employeesByHrId\)/, "permission recipients must be limited to the subject's manager chain");
  assertContains(
    policySource,
    /context\.scope === "company" \|\|\s*\n?\s*context\.scope === "system"/,
    "permission recipients outside the manager chain must be limited to explicit company/system-scope roles",
  );

  assertContains(
    policySource,
    /"payroll\.\*":[\s\S]*recipientStrategy:\s*\["permission_based"\]/,
    "payroll notifications must not use broad HR/admin fallback",
  );
  assertContains(
    policySource,
    /"probation\.\*":[\s\S]*recipientStrategy:\s*\["direct_manager",\s*"permission_based"\]/,
    "probation notifications must be direct manager plus scoped permission recipients only",
  );
  assertContains(
    policySource,
    /"probation\.reminder_due":[\s\S]*permissionResource:\s*null[\s\S]*recipientStrategy:\s*\["direct_manager",\s*"workflow_step_approver"\]/,
    "probation reminders must use exact direct manager plus explicit workflow approvers only",
  );
  assertContains(
    policySource,
    /"resignations\.\*":[\s\S]*recipientStrategy:\s*\["manager_chain",\s*"permission_based"\]/,
    "resignation notifications must be manager chain plus scoped permission recipients only",
  );
  assertContains(
    policySource,
    /"contract_renewal\.\*":[\s\S]*recipientStrategy:\s*\["manager_chain",\s*"permission_based"\]/,
    "contract renewal notifications must be manager chain plus scoped permission recipients only",
  );
  assertContains(
    policySource,
    /"contract_renewal\.renewal_reminder":[\s\S]*permissionResource:\s*null[\s\S]*recipientStrategy:\s*\["direct_manager",\s*"workflow_step_approver"\]/,
    "contract renewal reminders must use exact direct manager plus explicit workflow approvers only",
  );
  assertContains(
    policySource,
    /"vacation\.request_submitted":[\s\S]*recipientStrategy:\s*\[\]/,
    "vacation request submitted pilot must fail closed unless the vacation approval-step resolver supplies exact recipients",
  );

  assertContains(
    policySource,
    /"marketing_requests\.request_assigned":[\s\S]*recipientStrategy:\s*\["assigned_approver",\s*"cc"\]/,
    "marketing request_assigned must notify the assigned approver plus the explicit line CC (PM/GPM) only",
  );
  assertContains(
    policySource,
    /"marketing_requests\.request_returned":[\s\S]*recipientStrategy:\s*\["request_owner"\]/,
    "marketing request_returned must notify request owner only",
  );
  assertContains(
    policySource,
    /"marketing_requests\.request_rejected":[\s\S]*recipientStrategy:\s*\["request_owner"\]/,
    "marketing request_rejected must notify request owner only",
  );

  assertContains(
    accessRegistrySource,
    /pattern:\s*"\/api\/vacations\/\*\*"[\s\S]*guard:\s*"domain-helper"/,
    "vacation action URLs must remain behind domain helper access control",
  );
  assertContains(
    accessRegistrySource,
    /pattern:\s*"\/api\/payroll\/\*\*"[\s\S]*permission:\s*\{\s*resource:\s*"payroll"/,
    "payroll action URLs must remain behind payroll permissions",
  );
  assertContains(
    accessRegistrySource,
    /pattern:\s*"\/api\/marketing-requests\/\*\*"[\s\S]*guard:\s*"domain-helper"/,
    "marketing action URLs must remain behind domain helper access control",
  );
  assertContains(
    accessRegistrySource,
    /pattern:\s*"\/api\/employees\/\*\*"[\s\S]*permission:\s*\{\s*resource:\s*"employees"/,
    "employee profile action URLs must remain behind employee permissions",
  );
}
