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

  // --- Workflow registry seed -------------------------------------------
  const seed = read("supabase/migrations/20260604170100_recruitment_workflow_registry_module.sql");
  assert.match(seed, /'recruitment'/);
  assert.match(seed, /on conflict \(module_key\) do update/);
  for (const stage of [...applicationStages, ...requisitionStatuses]) {
    assert.ok(seed.includes(`"${stage}"`), `seed missing status ${stage}`);
  }
  for (const action of recruitmentActionKeys) {
    assert.ok(seed.includes(`"${action}"`), `seed missing action ${action}`);
  }

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

  // --- Offer-engine reuse (do not rewrite the engine) --------------------
  const applications = read("src/lib/recruitment/applications.ts");
  assert.match(applications, /createOffer\(/, "must reuse createOffer");
  assert.match(applications, /approveAcceptedOffer\(/, "must reuse approveAcceptedOffer for convert");
  assert.match(applications, /\.from\("job_offers"\)[\s\S]*application_id/, "must link offer back to application");
  assert.match(applications, /reconcileOfferStatuses/, "must reconcile candidate decisions");

  // --- Daily cron composition (no new Vercel cron) -----------------------
  const daily = read("app/api/notifications/daily/route.ts");
  assert.match(daily, /runRecruitmentDailyNotifications/, "recruitment daily work must ride the existing cron");
  const vercel = JSON.parse(read("vercel.json")) as { crons?: Array<{ path?: string }> };
  const cronPaths = (vercel.crons ?? []).map((cron) => cron.path ?? "");
  assert.ok(
    cronPaths.every((cronPath) => !cronPath.includes("recruitment")),
    "recruitment must not add a Vercel cron (Hobby limit)",
  );
}
