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
  assert.match(reminderRoute, /getEmployeeDirectoryRows/);
  assert.match(reminderRoute, /createSystemNotification/);
  assert.match(reminderRoute, /workflowApproverHrIdsForEmployee/);
  assert.match(reminderRoute, /resolveActiveHrApproverHrIds/, "HR approvers must be resolved by role, not hardcoded IDs");
  assert.doesNotMatch(reminderRoute, /phase6HrApproverHrIds/, "hardcoded approver IDs must be removed from contract renewals");
  assert.match(reminderRoute, /managerOfManager/);
  assert.match(reminderRoute, /actionUrl = "\/contracts\/renewals"/);
  assert.doesNotMatch(reminderRoute, /recipientHrId:/);
  assert.match(reminderRoute, /runScheduledNotificationProcessing/);
  const dailyRoute = readFileSync("app/api/notifications/daily/route.ts", "utf8");
  assert.match(dailyRoute, /runContractRenewalNotifications/);
  assert.match(dailyRoute, /runBirthdayNotifications/);
  assert.match(dailyRoute, /runVacationSlaDaily/);

  // Finding #41: an unset CRON_SECRET must fail closed on every Vercel environment
  // (production, preview, `vercel dev`), not just when NODE_ENV happens to say
  // "development" — Vercel always sets NODE_ENV=production, including on Preview, so
  // that check alone is not a safe signal. Only a real local machine (no VERCEL env
  // var at all) may still bypass an unset secret for `npm run dev` convenience.
  const birthdaysRoute = readFileSync("app/api/notifications/birthdays/route.ts", "utf8");
  const cronAuthRoutes = { birthdaysRoute, dailyRoute, processRoute, reminderRoute };
  for (const [name, source] of Object.entries(cronAuthRoutes)) {
    assert.doesNotMatch(
      source,
      /if \(!secret\) return process\.env\.NODE_ENV === "development";/,
      `${name} cron auth must not fail open on NODE_ENV alone`,
    );
    assert.match(
      source,
      /if \(!secret\) return !process\.env\.VERCEL && process\.env\.NODE_ENV === "development";/,
      `${name} cron auth must fail closed on every Vercel environment missing CRON_SECRET`,
    );
  }

  // Vercel Pro hosts the daily dispatcher, the sub-daily outbox drain (moved off GitHub Actions
  // so it no longer burns Actions minutes), the iReports360 visits sync, and its weekly wide
  // reconciliation. The daily dispatcher must stay daily; any cron beyond these four must be a
  // deliberate change.
  const vercelConfig = readFileSync("vercel.json", "utf8");
  const crons = JSON.parse(vercelConfig).crons as Array<{ path: string; schedule: string }>;
  assert.equal(crons.length, 4);
  assert.deepEqual(crons.map((cron) => cron.path), [
    "/api/notifications/daily",
    "/api/notifications/process?limit=50",
    "/api/cron/ireports360-visits-sync",
    "/api/cron/ireports360-visits-reconcile",
  ]);
  const dailyCron = crons.find((cron) => cron.path === "/api/notifications/daily");
  assert.ok(dailyCron && !dailyCron.schedule.startsWith("*/"), "the daily dispatcher must stay daily");
}
