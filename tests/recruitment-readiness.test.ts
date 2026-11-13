import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { accessRegistry, findAccessRegistryEntry } from "../src/lib/security/access-registry.ts";
import { permissionMatrix, permissionResources } from "../src/lib/auth/permissions.ts";
import {
  applicationStages,
  recruitmentActionKeys,
  requisitionStatuses,
} from "../src/lib/recruitment/types.ts";

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

export function runRecruitmentReadinessTests() {
  // --- Schema migration --------------------------------------------------
  const schema = read("supabase/_migrations_archive/pre-baseline-2026-07-11/20260605014225_recruitment_phase1_schema.sql");
  for (const table of [
    "recruitment_requisitions",
    "recruitment_candidates",
    "recruitment_applications",
    "recruitment_application_events",
    "recruitment_interviews",
    "recruitment_files",
  ]) {
    assert.match(schema, new RegExp(`create table if not exists public\\.${table}`), `missing table ${table}`);
    assert.match(schema, new RegExp(`alter table public\\.${table} enable row level security`), `${table} RLS`);
    assert.match(schema, new RegExp(`revoke all on public\\.${table} from anon, authenticated`), `${table} revoke`);
  }
  assert.match(schema, /recruitment_candidates_national_id_norm_uidx/);
  assert.match(schema, /recruitment_applications_active_uidx/);
  assert.match(schema, /notify pgrst, 'reload schema'/);
  // PII tables must NOT be granted to browser roles.
  assert.doesNotMatch(schema, /grant[^;]*to authenticated/i, "recruitment tables must not grant to authenticated");

  // --- Workflow registry seed (original + Rules 5/6 + Rules 8/9 updates) --
  const seed =
    read("supabase/_migrations_archive/pre-baseline-2026-07-11/20260605014350_recruitment_workflow_registry_module.sql") +
    "\n" +
    read("supabase/_migrations_archive/pre-baseline-2026-07-11/20260605041754_recruitment_workflow_registry_rules.sql") +
    "\n" +
    read("supabase/_migrations_archive/pre-baseline-2026-07-11/20260605063834_20260605180000_recruitment_interview_registry.sql") +
    "\n" +
    read("supabase/_migrations_archive/pre-baseline-2026-07-11/20260605093925_20260606091500_recruitment_offer_pipeline_stages.sql");
  assert.match(seed, /'recruitment'/);
  assert.match(seed, /on conflict \(module_key\) do update/);
  for (const stage of [...applicationStages, ...requisitionStatuses]) {
    assert.ok(seed.includes(`"${stage}"`), `seed missing status ${stage}`);
  }
  for (const action of recruitmentActionKeys) {
    assert.ok(seed.includes(`"${action}"`), `seed missing action ${action}`);
  }

  // --- Workflow Rules 4/5/6 schema migration ----------------------------
  const rulesSchema = read("supabase/_migrations_archive/pre-baseline-2026-07-11/20260605041621_recruitment_workflow_rules.sql");
  assert.match(rulesSchema, /add column if not exists status text not null default 'Candidate Created'/);
  for (const stage of ["shortlisted", "on_hold", "no_response", "call_back"]) {
    assert.ok(rulesSchema.includes(`'${stage}'`), `rules schema missing stage ${stage}`);
  }
  assert.match(rulesSchema, /interview_type in \('phone', 'hr', 'hiring_manager', 'cv'\)/);
  assert.match(rulesSchema, /notify pgrst, 'reload schema'/);

  // --- Workflow Rules 8/9 migrations (interview completion + final selection)
  const interviewStages = read("supabase/_migrations_archive/pre-baseline-2026-07-11/20260605055231_20260605170000_recruitment_interview_stages.sql");
  for (const stage of ["manager_interview_completed", "backup_candidate"]) {
    assert.ok(interviewStages.includes(`'${stage}'`), `interview stages migration missing ${stage}`);
  }
  const interviewRegistry = read("supabase/_migrations_archive/pre-baseline-2026-07-11/20260605063834_20260605180000_recruitment_interview_registry.sql");
  assert.match(
    interviewRegistry,
    /"app_record_hm_interview"[\s\S]*?"to":"manager_interview_completed"/,
    "HM record action must target manager_interview_completed",
  );
  for (const action of ["app_mgr_completed_to_final", "app_to_backup", "app_backup_to_offer", "app_resume_from_hold_to_hm"]) {
    assert.ok(interviewRegistry.includes(`"${action}"`), `interview registry missing action ${action}`);
  }

  // --- Permissions -------------------------------------------------------
  assert.ok(permissionResources.includes("recruitment"), "recruitment resource registered");
  assert.ok(permissionResources.includes("candidates"), "candidates resource registered");

  assert.ok(permissionMatrix["Super Admin"].recruitment?.includes("approve"));
  assert.ok(permissionMatrix["Super Admin"].candidates?.includes("import"));
  // The recruiting seat is the Talent Acquisition seat since "move recruiting off the HR Business Partner" (owner, 2026-10-08).
  assert.ok(permissionMatrix["HR Resourcing"].recruitment?.includes("create"));
  assert.ok(permissionMatrix["HR Resourcing"].candidates?.includes("read"));
  // HR Advisory gave recruiting up on 2026-10-08 and the owner retired the seat the same evening:
  // the dormant key holds no recruitment, no hiring documents and no leave administration.
  assert.ok(!permissionMatrix["HR Advisory"].recruitment?.includes("create"), "the retired HR Business Partner key holds recruitment");
  assert.equal(permissionMatrix["HR Advisory"].employee_documents, undefined, "the retired HR Business Partner key holds hiring documents");
  // APPROVING leave is HR Operations' — it moved there with the time_attendance function when the
  // single Talent Acquisition seat was split on 2026-08-28 — and not the recruiting seat's. This pair
  // is the assertion that fires if a future change collapses the HR bundles back into one HR role.
  assert.ok(!permissionMatrix["HR Resourcing"].leave?.includes("update"), "approving leave is HR Operations' function, not the Talent Acquisition seat's");
  assert.ok(permissionMatrix["HR Operations"].leave?.includes("update"));
  // Self-service payslip access (own payslip only, matching Financial Advisor) — without this,
  // an HR seat hits an uncaught Forbidden error on /payslips. It comes from HR_SEAT_SELF_SERVICE,
  // not from any HR function, so it must hold for BOTH bundles: composing a role purely from HR
  // functions produced a seat that could administer everyone's payslip except her own.
  assert.ok(permissionMatrix["HR Resourcing"].payslips?.includes("read"));
  assert.ok(permissionMatrix["HR Operations"].payslips?.includes("read"));
  assert.ok(permissionMatrix["HR Resourcing"].leave?.includes("create"), "she must be able to request her own vacation");
  assert.deepEqual(permissionMatrix.CEO.recruitment, undefined);
  assert.deepEqual(permissionMatrix.CEO.candidates, undefined);
  assert.deepEqual(permissionMatrix["District Manager"].recruitment, undefined);
  assert.equal(permissionMatrix["District Manager"].candidates, undefined, "managers get no candidate PII");
  assert.equal(permissionMatrix["Marketing Manager"].recruitment, undefined, "Marketing Manager gets no recruitment access");
  assert.equal(permissionMatrix.Employee.recruitment, undefined, "employees get no recruitment access");

  // --- Access registry ---------------------------------------------------
  assert.ok(accessRegistry.length > 0);
  const requisitionEntry = findAccessRegistryEntry("/api/recruitment/requisitions", "POST");
  assert.ok(requisitionEntry, "requisitions route must be registered");
  const applicationEntry = findAccessRegistryEntry("/api/recruitment/applications/abc/workflow", "POST");
  assert.ok(applicationEntry, "application workflow route must be registered");
  const candidateEntry = findAccessRegistryEntry("/api/recruitment/candidates", "POST");
  assert.ok(candidateEntry, "candidates route must be registered");
  assert.ok(candidateEntry?.csrf.required, "candidate mutations require CSRF");
  const templateEntry = findAccessRegistryEntry("/api/recruitment/candidates/template", "GET");
  assert.ok(templateEntry?.audit.required, "candidate template download must require audit classification");
  const interviewEntry = findAccessRegistryEntry("/api/recruitment/interviews/x", "PATCH");
  assert.ok(interviewEntry?.csrf.required, "interview record route must require CSRF");

  // --- Direct hire (no formal offer/approval-chain/PDF pipeline) --------
  const applications = read("src/lib/recruitment/applications.ts");
  assert.match(applications, /markApplicationHired\(/, "must expose the direct-hire action");
  assert.match(applications, /markRequisitionFilled\(/, "hire must close the requisition");
  assert.match(applications, /createInitialProbationRecord\(/, "hire must auto-create probation");
  const convertEntry = findAccessRegistryEntry("/api/recruitment/applications/abc/convert", "POST");
  assert.ok(convertEntry, "convert (mark hired) route must be registered");

  // --- Candidate files / Google Drive (dependency-free, dormant) --------
  const filesEntry = findAccessRegistryEntry("/api/recruitment/files/abc/download", "GET");
  assert.ok(filesEntry, "file download route must be registered");
  assert.ok(filesEntry?.audit.required, "file download must require audit classification");
  const driveStorage = read("src/lib/recruitment/drive-storage.ts");
  assert.match(driveStorage, /node:crypto/, "Drive adapter must be dependency-free (signs the JWT with node:crypto)");
  const pkg = JSON.parse(read("package.json")) as { dependencies?: Record<string, string> };
  assert.equal(pkg.dependencies?.googleapis, undefined, "no googleapis dependency should be added");

  // --- Supabase Storage (primary file backend) --------------------------
  const filesBucketMigration = read("supabase/_migrations_archive/pre-baseline-2026-07-11/20260605014515_recruitment_onboarding_postings_letters_approval_files.sql");
  assert.match(filesBucketMigration, /storage\.buckets/);
  assert.match(filesBucketMigration, /'recruitment-files'/);
  assert.match(filesBucketMigration, /recruitment_files_service_role/);
  const supabaseStorage = read("src/lib/recruitment/supabase-storage.ts");
  assert.match(supabaseStorage, /getSupabaseAdmin/, "Supabase adapter must use the service-role client");
  const fileStorage = read("src/lib/recruitment/file-storage.ts");
  assert.match(fileStorage, /isSupabaseStorageConfigured/, "file storage must prefer Supabase Storage");

  // --- Daily cron composition (no new Vercel cron) -----------------------
  const daily = read("app/api/cron/daily/_lib/daily-job-runners.ts");
  assert.match(daily, /runRecruitmentDailyNotifications/, "recruitment daily work must ride the existing cron");
  const notifications = read("src/lib/recruitment/notifications.ts");
  assert.match(notifications, /listInterviewsDueForReminder/, "daily run must send interview reminders");
}
