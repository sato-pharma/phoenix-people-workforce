import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const serviceSource = readFileSync(
  new URL("../src/lib/vacation/service.ts", import.meta.url),
  "utf8",
);
const sidebarSource = readFileSync(
  new URL("../src/components/layout/sidebar.tsx", import.meta.url),
  "utf8",
);
const migrationSource = readFileSync(
  new URL("../supabase/migrations/20260517040154_v2_vacation_management.sql", import.meta.url),
  "utf8",
);
const policyMigrationSource = readFileSync(
  new URL("../supabase/migrations/20260519203733_vacation_request_policy_updates.sql", import.meta.url),
  "utf8",
);
const typesSource = readFileSync(
  new URL("../src/lib/vacation/types.ts", import.meta.url),
  "utf8",
);
const routeSource = readFileSync(
  new URL("../app/api/vacations/requests/route.ts", import.meta.url),
  "utf8",
);

export function runVacationModuleTests() {
  assert.match(serviceSource, /const vacationRequestsTable = "v2_vacation_requests"/);
  assert.match(serviceSource, /request\.status !== "pending_manager"/);
  assert.match(serviceSource, /hrIdsMatch\(resolveEmployeeIdentityId\(access\), request\.managerHrId\)/);
  assert.match(serviceSource, /access\.role === "Super Admin" \|\| isDesignatedHrSpecialist\(access\)/);
  assert.match(serviceSource, /\.ilike\("hr_id", "A-16"\)/);
  assert.match(serviceSource, /managerOfManagerHrId/);
  assert.match(serviceSource, /validateVacationRequestPolicy/);
  assert.match(serviceSource, /getEmergencyVacationBalancePeriod/);
  assert.match(serviceSource, /leave-attachments/);
  assert.match(serviceSource, /Sick vacation requires an uploaded medical document/);
  assert.match(serviceSource, /\.neq\("vacation_type", "emergency"\)/);
  assert.match(routeSource, /request\.formData\(\)/);
  assert.match(routeSource, /sickDocument/);
  assert.match(typesSource, /label: "Other", value: "other"/);
  assert.doesNotMatch(typesSource, /Personal Vacation/);

  assert.match(sidebarSource, /label: "Leave Management"/);
  assert.match(sidebarSource, /label: "Vacation Request"/);
  assert.match(sidebarSource, /label: "Vacation Report"/);
  assert.doesNotMatch(sidebarSource, /Leave Policy|Entitlement|Approval Matrix|Workflow Builder/);

  assert.match(migrationSource, /create table if not exists public\.v2_vacation_requests/);
  assert.match(migrationSource, /create table if not exists public\.v2_vacation_email_tokens/);
  assert.match(migrationSource, /enable row level security/);
  assert.doesNotMatch(migrationSource, /drop table|drop function|drop policy .*leave/i);
  assert.match(policyMigrationSource, /update public\.v2_vacation_requests\s+set vacation_type = 'other'/i);
  assert.match(policyMigrationSource, /vacation_type in \('annual', 'emergency', 'sick', 'other'\)/i);
  assert.match(policyMigrationSource, /sick_attachment_object_path/);
  assert.match(policyMigrationSource, /leave-attachments/);
}
