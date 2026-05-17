import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { nextContractAnniversary } from "../src/lib/contracts/date-rules.ts";

export function runContractRenewalHardeningTests() {
  assert.equal(
    nextContractAnniversary("2023-05-01", new Date(2026, 4, 17)),
    "2027-05-01",
    "fallback renewal should advance to the next valid anniversary, not stale hire_date + 1 year",
  );
  assert.equal(
    nextContractAnniversary("2024-02-29", new Date(2025, 1, 28)),
    "2025-02-28",
    "leap-day hires should renew on the last valid day in non-leap years",
  );
  const service = readFileSync("src/lib/contracts/service.ts", "utf8");
  assert.match(service, /phx_create_contract_renewal_request/);
  assert.match(service, /phx_apply_contract_renewal_workflow/);
  assert.match(service, /ContractRenewalValidationError/);
  assert.match(service, /getContractRenewalReminderCandidates/);
  assert.match(service, /export function validateWorkflowTransition/);
  assert.match(service, /action === "cancel"/);
  assert.doesNotMatch(service, /action === "reopen"/);

  const migration = readFileSync("supabase/migrations/20260517035419_contract_renewal_stabilization.sql", "utf8");
  assert.match(migration, /create or replace function public\.phx_create_contract_renewal_request/);
  assert.match(migration, /create or replace function public\.phx_apply_contract_renewal_workflow/);
  assert.match(migration, /contract_renewal_requests_one_active_idx/);
  assert.match(migration, /employee_contracts_one_active_idx/);
  assert.match(migration, /multiple active contracts/);
  assert.match(migration, /status in \('draft', 'active', 'expired', 'renewed', 'terminated', 'not_renewed', 'cancelled'\)/);
  assert.match(migration, /revoke execute on function public\.phx_apply_contract_renewal_workflow/);
  assert.doesNotMatch(migration, /p_action = 'reopen'/);

  const processRoute = readFileSync("app/api/notifications/process/route.ts", "utf8");
  assert.match(processRoute, /export async function GET/);
  assert.match(processRoute, /CRON_SECRET/);

  const reminderRoute = readFileSync("app/api/notifications/contract-renewals/route.ts", "utf8");
  assert.match(reminderRoute, /getContractRenewalReminderCandidates/);
  assert.match(reminderRoute, /safeSendNotificationEmail/);

  const vercelConfig = readFileSync("vercel.json", "utf8");
  assert.match(vercelConfig, /\/api\/notifications\/contract-renewals/);
  assert.match(vercelConfig, /\/api\/notifications\/process/);
}
