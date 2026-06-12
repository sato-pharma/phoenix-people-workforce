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
  assertContains(policySource, /hasOrgScope\(candidate,\s*subject,\s*"line"\)/, "permission recipients must consider line scope");
  assertContains(policySource, /hasOrgScope\(candidate,\s*subject,\s*"department"\)/, "permission recipients must consider department scope");
  assertContains(policySource, /hasOrgScope\(candidate,\s*subject,\s*"area"\)/, "permission recipients must consider area scope");
  assertContains(policySource, /hasOrgScope\(candidate,\s*subject,\s*"team"\)/, "permission recipients must consider team scope");

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
    policySource,
    /"marketing_requests\.escalation":[\s\S]*recipientStrategy:\s*\["workflow_step_approver"\]/,
    "marketing escalation must use explicit workflow approver only",
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
    /pattern:\s*"\/api\/offers\/\*\*"[\s\S]*permission:\s*\{\s*resource:\s*"offers"/,
    "offer lifecycle URLs must remain behind offer permissions",
  );
  assertContains(
    accessRegistrySource,
    /pattern:\s*"\/api\/employees\/\*\*"[\s\S]*permission:\s*\{\s*resource:\s*"employees"/,
    "employee profile action URLs must remain behind employee permissions",
  );
}
