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

export function runVacationModuleTests() {
  assert.match(serviceSource, /const vacationRequestsTable = "v2_vacation_requests"/);
  assert.match(serviceSource, /request\.status !== "pending_manager"/);
  assert.match(serviceSource, /hrIdsMatch\(resolveEmployeeIdentityId\(access\), request\.managerHrId\)/);
  assert.match(serviceSource, /access\.role === "Super Admin" \|\| access\.role === "HR Specialist"/);
  assert.match(serviceSource, /managerOfManagerHrId/);

  assert.match(sidebarSource, /label: "Leave Management"/);
  assert.match(sidebarSource, /label: "Vacation Request"/);
  assert.match(sidebarSource, /label: "Vacation Report"/);
  assert.doesNotMatch(sidebarSource, /Leave Policy|Entitlement|Approval Matrix|Workflow Builder/);

  assert.match(migrationSource, /create table if not exists public\.v2_vacation_requests/);
  assert.match(migrationSource, /create table if not exists public\.v2_vacation_email_tokens/);
  assert.match(migrationSource, /enable row level security/);
  assert.doesNotMatch(migrationSource, /drop table|drop function|drop policy .*leave/i);
}
