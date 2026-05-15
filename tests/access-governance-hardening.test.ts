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

  assertContains(identitySource, /ban_duration:\s*input\.isActive \? "none" : longBanDuration/, "inactive identities must be banned in Supabase Auth");
  assertContains(identitySource, /export async function deleteSupabaseAuthIdentity/, "Supabase auth cleanup must be available for compensation rollback");
}
