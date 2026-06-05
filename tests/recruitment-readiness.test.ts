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
  const schema = read("supabase/migrations/20260604170000_recruitment_phase1_schema.sql");
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
  assert.match(schema, /alter table public\.job_offers\s+add column if not exists application_id uuid null/);
  assert.match(schema, /recruitment_candidates_national_id_norm_uidx/);
  assert.match(schema, /recruitment_applications_active_uidx/);
  assert.match(schema, /notify pgrst, 'reload schema'/);
  // PII tables must NOT be granted to browser roles.
  assert.doesNotMatch(schema, /grant[^;]*to authenticated/i, "recruitment tables must not grant to authenticated");

  // --- Workflow registry seed (original + the Rules 5/6 update) ----------
  const seed =
    read("supabase/migrations/20260604170100_recruitment_workflow_registry_module.sql") +
    "\n" +
    read("supabase/migrations/20260605160000_recruitment_workflow_registry_rules.sql");
  assert.match(seed, /'recruitment'/);
  assert.match(seed, /on conflict \(module_key\) do update/);
  for (const stage of [...applicationStages, ...requisitionStatuses]) {
    assert.ok(seed.includes(`"${stage}"`), `seed missing status ${stage}`);
  }
  for (const action of recruitmentActionKeys) {
    assert.ok(seed.includes(`"${action}"`), `seed missing action ${action}`);
  }

  // --- Workflow Rules 4/5/6 schema migration ----------------------------
  const rulesSchema = read("supabase/migrations/20260605150000_recruitment_workflow_rules.sql");
  assert.match(rulesSchema, /add column if not exists status text not null default 'Candidate Created'/);
  for (const stage of ["shortlisted", "on_hold", "no_response", "call_back"]) {
    assert.ok(rulesSchema.includes(`'${stage}'`), `rules schema missing stage ${stage}`);
  }
  assert.match(rulesSchema, /interview_type in \('phone', 'hr', 'hiring_manager', 'cv'\)/);
  assert.match(rulesSchema, /notify pgrst, 'reload schema'/);

  // --- Permissions -------------------------------------------------------
  assert.ok(permissionResources.includes("recruitment"), "recruitment resource registered");
  assert.ok(permissionResources.includes("candidates"), "candidates resource registered");

  assert.ok(permissionMatrix["Super Admin"].recruitment?.includes("approve"));
  assert.ok(permissionMatrix["Super Admin"].candidates?.includes("import"));
  assert.ok(permissionMatrix["HR Specialist"].recruitment?.includes("create"));
  assert.ok(permissionMatrix["HR Specialist"].candidates?.includes("read"));
  assert.deepEqual(permissionMatrix.CEO.recruitment, ["read"]);
  assert.deepEqual(permissionMatrix.CEO.candidates, ["read"]);
  assert.deepEqual(permissionMatrix["District Manager"].recruitment, ["read", "update"]);
  assert.equal(permissionMatrix["District Manager"].candidates, undefined, "managers get no candidate PII");
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
  const onboardingEntry = findAccessRegistryEntry("/api/recruitment/onboarding/x", "PATCH");
  assert.ok(onboardingEntry?.csrf.required, "onboarding update route must require CSRF");

  // --- Offer-engine reuse (do not rewrite the engine) --------------------
  const applications = read("src/lib/recruitment/applications.ts");
  assert.match(applications, /createOffer\(/, "must reuse createOffer");
  assert.match(applications, /approveAcceptedOffer\(/, "must reuse approveAcceptedOffer for convert");
  assert.match(applications, /\.from\("job_offers"\)[\s\S]*application_id/, "must link offer back to application");
  assert.match(applications, /reconcileOfferStatuses/, "must reconcile candidate decisions");
  assert.match(applications, /ensureOnboardingChecklist/, "pre-boarding must seed the onboarding checklist");
  assert.match(applications, /areRequiredDocumentsApproved/, "hire must gate on approved documents");

  const onboardingMigration = read("supabase/migrations/20260604180000_recruitment_onboarding.sql");
  assert.match(onboardingMigration, /create table if not exists public\.recruitment_onboarding_items/);
  assert.match(onboardingMigration, /revoke all on public\.recruitment_onboarding_items from anon, authenticated/);

  // --- Public application funnel (Phase 4) ------------------------------
  const applyEntry = findAccessRegistryEntry("/api/recruitment/apply/sometoken", "POST");
  assert.ok(applyEntry, "public apply route must be registered");
  assert.equal(applyEntry?.authMode, "public-token", "public apply must be a token route, not a session route");
  assert.equal(applyEntry?.csrf.required, false, "public apply is token-protected (no CSRF), matching the offer token routes");

  const postingsMigration = read("supabase/migrations/20260604190000_recruitment_job_postings.sql");
  assert.match(postingsMigration, /create table if not exists public\.recruitment_job_postings/);
  assert.match(postingsMigration, /add column if not exists submitted_ip_hash/);
  assert.match(postingsMigration, /revoke all on public\.recruitment_job_postings from anon, authenticated/);

  const postings = read("src/lib/recruitment/postings.ts");
  assert.match(postings, /systemAccessContext/, "public submit must run under a system context");
  assert.match(postings, /submitted_ip_hash/, "public submit must record a hashed IP for rate limiting");

  // --- Offer letters (Phase 4c) -----------------------------------------
  const offerLetterEntry = findAccessRegistryEntry("/api/recruitment/offers/o1/letter", "POST");
  assert.ok(offerLetterEntry, "offer-letter generate route must be registered");
  const offerLetterDocEntry = findAccessRegistryEntry("/api/recruitment/offer-letter/v1", "GET");
  assert.ok(offerLetterDocEntry, "offer-letter document route must be registered");
  const offerLettersMigration = read("supabase/migrations/20260605120000_recruitment_offer_letters.sql");
  assert.match(offerLettersMigration, /create table if not exists public\.recruitment_offer_letters/);
  assert.match(offerLettersMigration, /revoke all on public\.recruitment_offer_letters from anon, authenticated/);

  // --- Candidate files / Google Drive (dependency-free, dormant) --------
  const filesEntry = findAccessRegistryEntry("/api/recruitment/files/abc/download", "GET");
  assert.ok(filesEntry, "file download route must be registered");
  assert.ok(filesEntry?.audit.required, "file download must require audit classification");
  const driveStorage = read("src/lib/recruitment/drive-storage.ts");
  assert.match(driveStorage, /node:crypto/, "Drive adapter must be dependency-free (signs the JWT with node:crypto)");
  const pkg = JSON.parse(read("package.json")) as { dependencies?: Record<string, string> };
  assert.equal(pkg.dependencies?.googleapis, undefined, "no googleapis dependency should be added");

  // --- Supabase Storage (primary file backend) --------------------------
  const filesBucketMigration = read("supabase/migrations/20260605140000_recruitment_files_bucket.sql");
  assert.match(filesBucketMigration, /storage\.buckets/);
  assert.match(filesBucketMigration, /'recruitment-files'/);
  assert.match(filesBucketMigration, /recruitment_files_service_role/);
  const supabaseStorage = read("src/lib/recruitment/supabase-storage.ts");
  assert.match(supabaseStorage, /getSupabaseAdmin/, "Supabase adapter must use the service-role client");
  const fileStorage = read("src/lib/recruitment/file-storage.ts");
  assert.match(fileStorage, /isSupabaseStorageConfigured/, "file storage must prefer Supabase Storage");

  // --- Threshold offer approval (Phase 4b) ------------------------------
  const seniorEntry = findAccessRegistryEntry("/api/recruitment/applications/abc/senior-approval", "POST");
  assert.ok(seniorEntry, "senior-approval route must be registered");
  const seniorMigration = read("supabase/migrations/20260605130000_recruitment_senior_approval.sql");
  assert.match(seniorMigration, /senior_approval_status/);
  assert.match(applications, /requiresSeniorApproval/, "convert must gate above-band offers on Super Admin sign-off");

  // --- Daily cron composition (no new Vercel cron) -----------------------
  const daily = read("app/api/notifications/daily/route.ts");
  assert.match(daily, /runRecruitmentDailyNotifications/, "recruitment daily work must ride the existing cron");
  const notifications = read("src/lib/recruitment/notifications.ts");
  assert.match(notifications, /listInterviewsDueForReminder/, "daily run must send interview reminders");
  const vercel = JSON.parse(read("vercel.json")) as { crons?: Array<{ path?: string }> };
  const cronPaths = (vercel.crons ?? []).map((cron) => cron.path ?? "");
  assert.ok(
    cronPaths.every((cronPath) => !cronPath.includes("recruitment")),
    "recruitment must not add a Vercel cron (Hobby limit)",
  );
}
