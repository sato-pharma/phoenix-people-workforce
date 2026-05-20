import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function runPhase21SecurityHardeningTests() {
  const phase21Smoke = readFileSync("scripts/phase21-security-readiness-smoke.ts", "utf8");
  const bulkActionRoute = readFileSync("app/api/admin/users/bulk-action/route.ts", "utf8");
  const notificationTestRoute = readFileSync("app/api/notifications/test/route.ts", "utf8");
  const emailReplyRoute = readFileSync("app/api/admin/email-reply/send/route.ts", "utf8");
  const probationRoute = readFileSync("app/api/probation/route.ts", "utf8");
  const probationWorkflowRoute = readFileSync("app/api/probation/[id]/workflow/route.ts", "utf8");
  const scorecard = readFileSync("docs/system-production-build-scorecard.md", "utf8");

  assert.match(bulkActionRoute, /Authentication is required/);
  assert.match(bulkActionRoute, /assertPermission\(access, "user_admin", "update"\)/);
  assert.match(bulkActionRoute, /loginIds must contain non-empty strings only/);
  assert.doesNotMatch(bulkActionRoute, /assertPermission\(access, "admin_access", "update"\)/);

  assert.match(notificationTestRoute, /assertPermission\(access, "admin", "update"\)/);
  assert.doesNotMatch(notificationTestRoute, /assertPermission\(access, "admin_access", "read"\)/);
  assert.match(emailReplyRoute, /assertPermission\(access, "communication", "update"\)/);
  assert.doesNotMatch(emailReplyRoute, /assertPermission\(access, "admin", "read"\)/);

  assert.match(probationRoute, /assertPermission\(access, "probation", "update"\)/);
  assert.match(probationWorkflowRoute, /assertPermission\(access, "probation", action === "pass" \|\| action === "terminate" \? "approve" : "update"\)/);

  assert.match(phase21Smoke, /critical public tables have RLS enabled/);
  assert.match(phase21Smoke, /critical tables do not grant direct anon privileges/);
  assert.match(phase21Smoke, /sensitive SECURITY DEFINER functions are not executable by public\/authenticated roles/);
  assert.match(phase21Smoke, /service-role key is not imported into client components/);
  assert.doesNotMatch(phase21Smoke, /\.delete\(/);
  assert.doesNotMatch(phase21Smoke, /\.update\(/);
  assert.doesNotMatch(phase21Smoke, /\.insert\(/);

  assert.match(scorecard, /Phase 21 Completion Update/);
  assert.match(scorecard, /Security, RLS, Auth, and Access Governance/);
}
