import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function runPhase21SecurityHardeningTests() {
  const phase21Smoke = readFileSync("scripts/phase21-security-readiness-smoke.ts", "utf8");
  const bulkActionRoute = readFileSync("app/api/admin/users/bulk-action/route.ts", "utf8");
  const notificationTestRoute = readFileSync("app/api/notifications/test/route.ts", "utf8");
  const emailReplyRoute = readFileSync("app/api/admin/email-reply/send/route.ts", "utf8");
  const probationRoute = readFileSync("app/api/probation/route.ts", "utf8");
  const probationWorkflowRoute = readFileSync("app/api/probation/[id]/workflow/route.ts", "utf8");
  const publicViewsMigration = readFileSync("supabase/migrations/20260527150831_secure_public_views_security_invoker.sql", "utf8");
  const criticalRlsMigration = readFileSync("supabase/migrations/20260527152621_critical_public_rls_closure.sql", "utf8");
  const triggerExecuteMigration = readFileSync("supabase/migrations/20260527153731_revoke_terminal_vacancy_trigger_execute.sql", "utf8");
  const remainingAdvisorMigration = readFileSync("supabase/migrations/20260527154608_harden_remaining_supabase_advisors.sql", "utf8");
  const performanceAdvisorMigration = readFileSync("supabase/migrations/20260527155803_cleanup_supabase_performance_advisors.sql", "utf8");
  const seedFile = readFileSync("supabase/seed.sql", "utf8");
  const gitignore = readFileSync(".gitignore", "utf8");
  const githubSecretsExample = readFileSync(".env.github-secrets.example", "utf8");
  const proxySource = readFileSync("proxy.ts", "utf8");
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

  assert.match(proxySource, /PHOENIX_PREVIEW_READ_ONLY/);
  assert.match(proxySource, /VERCEL_ENV === "preview"/);
  assert.match(proxySource, /preview_read_only/);
  assert.match(proxySource, /\/api\/auth\/login/);
  assert.match(proxySource, /\/api\/auth\/logout/);
  assert.match(proxySource, /\/api\/auth\/heartbeat/);

  assert.match(phase21Smoke, /critical public tables have RLS enabled/);
  assert.match(phase21Smoke, /critical tables do not grant direct anon privileges/);
  assert.match(phase21Smoke, /sensitive SECURITY DEFINER functions are not executable by public\/authenticated roles/);
  assert.match(phase21Smoke, /service-role key is not imported into client components/);
  assert.match(phase21Smoke, /methodIsExplicitlyUnsupported/);
  assert.match(phase21Smoke, /unsupported_method\|status/);
  assert.doesNotMatch(phase21Smoke, /\.delete\(/);
  assert.doesNotMatch(phase21Smoke, /\.update\(/);
  assert.doesNotMatch(phase21Smoke, /\.insert\(/);

  assert.match(publicViewsMigration, /security_invoker = true/);
  assert.match(publicViewsMigration, /v_active_organogram/);
  assert.match(publicViewsMigration, /v_employee_portal_sales/);
  assert.match(publicViewsMigration, /coaching_reports_summary/);
  assert.match(criticalRlsMigration, /alter table public\.position_vacancies enable row level security/);
  assert.match(criticalRlsMigration, /revoke all on table public\.role_permission_overrides from anon, authenticated/);
  assert.match(criticalRlsMigration, /v2_vacation_request_events_service_role_all/);
  assert.match(triggerExecuteMigration, /revoke all on function public\.phx_terminal_employee_vacancy_guard_trigger\(\)/);
  assert.match(triggerExecuteMigration, /from public, anon, authenticated/);
  assert.match(remainingAdvisorMigration, /set search_path = public, pg_temp/);
  assert.match(remainingAdvisorMigration, /public\.fn_get_employee_directory_paginated\(text, bigint, bigint, bigint, bigint, text, integer, integer, text, text, text\)/);
  assert.match(remainingAdvisorMigration, /drop policy if exists public_customers on public\.customers/);
  assert.match(remainingAdvisorMigration, /revoke all on table public\.upload_batches from anon, authenticated/);
  assert.doesNotMatch(remainingAdvisorMigration, /drop table/i);
  assert.doesNotMatch(remainingAdvisorMigration, /delete from/i);
  assert.match(performanceAdvisorMigration, /drop index if exists public\.idx_areas_line_id/);
  assert.match(performanceAdvisorMigration, /drop policy if exists position_vacancies_service_role_all on public\.position_vacancies/);
  assert.doesNotMatch(performanceAdvisorMigration, /idx_salary_structure_effective/);
  assert.doesNotMatch(performanceAdvisorMigration, /drop table/i);
  assert.doesNotMatch(performanceAdvisorMigration, /delete from/i);
  assert.match(seedFile, /Intentionally empty/);
  assert.match(gitignore, /\.env\.github-secrets/);
  assert.match(githubSecretsExample, /SUPABASE_SERVICE_ROLE_KEY=/);

  assert.match(scorecard, /Phase 21 Completion Update/);
  assert.match(scorecard, /Security, RLS, Auth, and Access Governance/);
}
