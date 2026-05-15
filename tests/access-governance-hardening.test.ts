import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const validationSource = readFileSync(
  new URL("../src/lib/admin/access-validation.ts", import.meta.url),
  "utf8",
);
const accessControlSource = readFileSync(
  new URL("../src/lib/admin/access-control.ts", import.meta.url),
  "utf8",
);
const passwordSetupSource = readFileSync(
  new URL("../src/lib/auth/password-setup.ts", import.meta.url),
  "utf8",
);
const identitySource = readFileSync(
  new URL("../src/lib/auth/supabase-identity.ts", import.meta.url),
  "utf8",
);
const auditSource = readFileSync(
  new URL("../src/lib/admin/audit.ts", import.meta.url),
  "utf8",
);
const accessManagerSource = readFileSync(
  new URL("../src/components/admin/access-control-manager.tsx", import.meta.url),
  "utf8",
);
const bulkRouteSource = readFileSync(
  new URL("../app/api/admin/users/bulk/route.ts", import.meta.url),
  "utf8",
);
const resignationSource = readFileSync(
  new URL("../src/lib/resignations/service.ts", import.meta.url),
  "utf8",
);

function assertContains(source: string, pattern: RegExp, message: string) {
  assert.match(source, pattern, message);
}

function assertNotContains(source: string, pattern: RegExp, message: string) {
  assert.doesNotMatch(source, pattern, message);
}

export function runAccessGovernanceHardeningTests() {
  assertContains(validationSource, /export function parseAccessUserRequest/, "user mutations must use a dedicated parser");
  assertContains(validationSource, /export function parseAccessUserStatusRequest/, "status mutations must use a dedicated parser");
  assertContains(validationSource, /export function parsePermissionOverrideRequest/, "permission mutations must use a dedicated parser");
  assertContains(validationSource, /export function parsePasswordSetupRequest/, "password setup/reset mutations must use a dedicated parser");
  assertContains(validationSource, /isAllowed must be a boolean/, "permission overrides must require boolean isAllowed");
  assertContains(validationSource, /isActive must be a boolean/, "status changes must require boolean isActive");
  assertContains(validationSource, /line must be one of/, "user line input must be strictly enumerated");
  assertContains(validationSource, /salesScopeOverride is invalid/, "scope overrides must be strictly enumerated");
  assertContains(validationSource, /governanceReason must be 500 characters or fewer/, "governance reasons must be bounded");
  assertContains(validationSource, /deliveryMode must be 'copy' or 'email'/, "password link delivery must be strictly enumerated");
  assertContains(validationSource, /purpose must be 'setup' or 'reset'/, "password link purpose must be strictly enumerated");

  assertContains(accessControlSource, /export function assertActorMayManageUser/, "role governance checks must remain directly testable");
  assertContains(accessControlSource, /You cannot deactivate your own active account/, "self-deactivation must be blocked");
  assertContains(accessControlSource, /You cannot downgrade your own role/, "self-downgrade must be blocked");
  assertContains(accessControlSource, /Only Super Admin can manage Super Admin accounts/, "Super Admin management must be Super Admin-only");
  assertContains(accessControlSource, /You cannot modify peer or higher-privilege accounts/, "peer and higher-privilege edits must be blocked");
  assertContains(accessControlSource, /You cannot assign peer or higher-privilege roles/, "role promotion above actor authority must be blocked");
  assertContains(accessControlSource, /You cannot elevate your own role/, "self-promotion must be blocked");
  assertContains(accessControlSource, /Cannot remove or deactivate the last active Super Admin/, "last Super Admin protection must remain enforced");

  assertContains(accessControlSource, /writeRequiredAuditLog/, "critical access-control mutations must require audit persistence");
  assertContains(auditSource, /const \{ error \} = await supabase\.from\("audit_logs"\)\.insert/, "audit writes must inspect Supabase insert errors");
  assertContains(auditSource, /if \(error\) throw error/, "required audit persistence must fail when Supabase returns insert errors");
  assertContains(accessControlSource, /permissionOverrides: await listPermissionOverrides\(\)/, "dashboard must expose permission override provenance");
  assertContains(accessControlSource, /access_control_compensation_failed/, "multi-step mutation compensation failures must be logged");
  assertContains(accessControlSource, /deleteSupabaseAuthIdentity/, "failed new-user mutations must remove orphan Supabase auth identities");
  assertContains(accessControlSource, /setSupabaseAuthIdentityAccess/, "deactivation must update Supabase Auth access state");
  assertContains(accessControlSource, /auth_identity_access: isActive \? "unbanned" : "banned"/, "status audits must record auth access revocation metadata");

  const passwordSetupAuditBlock = passwordSetupSource.match(/await writeRequiredAuditLog\(\{[\s\S]*?summary:/)?.[0] ?? "";
  assertContains(passwordSetupAuditBlock, /token:\s*"\[redacted\]"/, "password setup audit must redact token values");
  assertContains(passwordSetupAuditBlock, /url:\s*"\[redacted\]"/, "password setup audit must redact setup/reset URLs");
  assertNotContains(passwordSetupAuditBlock, /setupUrl/, "password setup audit must not store live setup URLs");
  assertContains(passwordSetupSource, /\.\.\.\(deliveryMode === "copy" \? \{ setupUrl \} : \{\}\)/, "setup URLs should only be returned for explicit copy workflows");
  assertContains(passwordSetupSource, /password_setup_token_compensation_failed/, "setup/reset tokens must be invalidated or visibly logged if post-token governance fails");

  assertContains(identitySource, /ban_duration:\s*input\.isActive \? "none" : longBanDuration/, "inactive identities must be banned in Supabase Auth");
  assertContains(identitySource, /export async function deleteSupabaseAuthIdentity/, "Supabase auth cleanup must be available for compensation rollback");

  assertContains(accessManagerSource, /const permissionDomains/, "permission matrix must be grouped into enterprise domains");
  assertContains(accessManagerSource, /Full admin/, "page must distinguish full-admin access mode");
  assertContains(accessManagerSource, /Read only/, "page must distinguish read-only access mode");
  assertContains(accessManagerSource, /Read-only governance view/, "read-only users must not see an editable user form");
  assertContains(accessManagerSource, /Not provisioned/, "active employees without access accounts must be visible as not provisioned");
  assertContains(accessManagerSource, /Editing locked/, "permission UI must explain locked override editing");
  assertContains(accessManagerSource, /aria-modal="true"/, "governance confirmation modal must expose dialog semantics");
  assertContains(accessManagerSource, /aria-label=\{`Edit \$\{user\.name\}`\}/, "user mutation controls must include accessible labels");
  assertContains(accessManagerSource, /lg:hidden/, "mobile users experience must include a non-table layout");

  assertContains(accessControlSource, /directoryEmployeeToUser/, "Users & Access must surface active employees that are not provisioned yet");
  assertContains(accessControlSource, /accessState: "directory_only"/, "directory-only employees must be tagged distinctly from provisioned accounts");
  assertContains(accessControlSource, /deactivateAccessForEmployeeLifecycle/, "employee lifecycle workflows must use hardened access deactivation");
  assertContains(resignationSource, /completeEmployeeLifecycleForResignation/, "completed resignations must finalize employee lifecycle state");
  assertContains(resignationSource, /restoreResignationWorkflowAfterLifecycleFailure/, "completed resignation workflow must compensate if lifecycle access deprovisioning fails");
  assertContains(resignationSource, /resignation_lifecycle_compensation_failed/, "resignation lifecycle compensation failures must be visibly logged");
  assertContains(resignationSource, /employment_status: "resigned"/, "completed resignations must mark the employee as resigned");
  assertContains(resignationSource, /deactivateAccessForEmployeeLifecycle/, "completed resignations must revoke app and Supabase access");
  assertNotContains(resignationSource, /deactivateEmployeeAccessIfSupported/, "resignation fallback must not bypass hardened access deprovisioning");
  assertContains(bulkRouteSource, /assertAuthenticated\(access\)/, "bulk upload route must reject unauthenticated direct requests");
  assertContains(bulkRouteSource, /invalid_workbook/, "bulk upload route must map invalid workbooks to validation errors");
  assertContains(bulkRouteSource, /dashboard: created > 0 \|\| updated > 0/, "partial bulk successes must return a refreshed dashboard snapshot");
}
