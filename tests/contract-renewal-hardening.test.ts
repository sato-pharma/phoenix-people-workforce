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

  // Regression guard: without an explicit templateContext, {{status}} in the
  // contract_renewal email template falls back to notificationMetricStatus() — a raw
  // "Label: value | Label: value | ..." dump of every metric, duplicating the
  // employeeName/employeeHrId/endDate tokens the template already renders separately.
  assert.match(
    service,
    /notifyContractWorkflow[\s\S]{0,1600}templateContext:\s*\{[\s\S]{0,200}status:\s*record\.status\.replace/,
    "notifyContractWorkflow must supply an explicit templateContext.status instead of relying on the raw metric-dump fallback",
  );

  const migration = readFileSync("supabase/_migrations_archive/pre-baseline-2026-07-11/20260517035419_contract_renewal_stabilization.sql", "utf8");
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
    assert.match(
      source,
      /if \(!secret\) return !isProductionRuntime\(\);/,
      `${name} cron auth must fail closed in production runtime (platform-neutral)`,
    );
    assert.doesNotMatch(
      source,
      /process\.env\.VERCEL\b/,
      `${name} cron auth must not depend on Vercel-specific env vars`,
    );
  }



  // Deeper audit finding C: birthday and contract-renewal notification loops previously had no
  // per-item isolation, unlike the sibling holiday-confirmation cron — one bad send would abort
  // every remaining employee's notification for that day's run instead of just that one employee.
  assert.match(
    birthdaysRoute,
    /for \(const event of birthdayEvents\) \{[\s\S]*?try \{[\s\S]*?const result = await createSystemNotification/,
    "birthday notification loop must isolate each employee's send in its own try/catch",
  );
  assert.match(
    birthdaysRoute,
    /catch \(error\) \{\s*console\.error\(error, \{ tags: \{ cron: "birthday-notifications", employeeHrId: employee\.hrId \} \}\);/,
    "a failed birthday send must be captured in Sentry, tagged with the affected employee",
  );
  assert.match(
    reminderRoute,
    /for \(const row of candidates\) \{[\s\S]*?try \{[\s\S]*?const result = await createSystemNotification/,
    "contract renewal notification loop must isolate each employee's send in its own try/catch",
  );
  assert.match(
    reminderRoute,
    /catch \(error\) \{\s*console\.error\(error, \{ tags: \{ cron: "contract-renewals", employeeHrId: row\.hr_id \} \}\);/,
    "a failed contract-renewal send must be captured in Sentry, tagged with the affected employee",
  );
}
