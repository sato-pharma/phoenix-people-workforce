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

  // Cairo/UTC timezone fix: todayDate() (used by both getContractRenewalReminderCandidates'
  // due-date matching and the non-renewal auto-terminate path's effectiveDate/submittedDate
  // fallback) must resolve "today" via Africa/Cairo, not the server's own local/UTC clock —
  // the reminder route's own display-only cairoDate() was already Cairo-aware; this used to be
  // the one place in this file that diverged.
  assert.match(
    service,
    /function todayDate\(\) \{\s*return currentCairoDateOnlyIso\(\);\s*\}/,
    "todayDate() must delegate to the canonical Cairo-aware currentCairoDateOnlyIso helper",
  );
  assert.doesNotMatch(
    service,
    /toDateOnlyString\(new Date\(\)\)/,
    'todayDate() must not resolve "today" via the server\'s local/UTC clock',
  );

  assert.match(service, /phx_create_contract_renewal_request/);
  assert.match(service, /phx_apply_contract_renewal_workflow/);
  assert.match(service, /ContractRenewalValidationError/);
  assert.match(service, /getContractRenewalReminderCandidates/);
  assert.match(service, /export function validateWorkflowTransition/);
  assert.match(service, /action === "cancel"/);
  assert.doesNotMatch(service, /action === "reopen"/);

  // Regression guard: without an explicit templateContext, {{status}} in the
  // contract_renewal email template falls back to metricValue(input, "Status") — this
  // caller's metrics array has no "Status" entry, so that fallback would render blank.
  assert.match(
    service,
    /notifyContractWorkflow[\s\S]{0,1600}templateContext:\s*\{[\s\S]{0,200}status:\s*record\.status\.replace/,
    "notifyContractWorkflow must supply an explicit templateContext.status instead of relying on the metrics-based fallback",
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
  assert.doesNotMatch(reminderRoute, /"HR Manager"/, "\"HR Manager\" is a job title, not an app_auth_users.role value — it must never appear in a role-array literal");
  assert.doesNotMatch(reminderRoute, /phase6HrApproverHrIds/, "hardcoded approver IDs must be removed from contract renewals");
  assert.match(reminderRoute, /managerOfManager/);
  assert.match(reminderRoute, /actionUrl = "\/contracts"/);
  assert.doesNotMatch(reminderRoute, /actionUrl = "\/contracts\/renewals"/, "\"/contracts/renewals\" is not a real route and 404s for every recipient");
  assert.doesNotMatch(reminderRoute, /recipientHrId:/);
  assert.match(reminderRoute, /runScheduledNotificationProcessing/);
  const dailyRoute = readFileSync("app/api/notifications/daily/route.ts", "utf8");
  assert.match(dailyRoute, /runContractRenewalNotifications/);
  assert.match(dailyRoute, /runBirthdayNotifications/);
  assert.match(dailyRoute, /runVacationSlaDaily/);

  // Finding #41, hardened further after the 2026-08-27 APP_ENV audit: an unset CRON_SECRET
  // must fail closed everywhere except a real local dev machine. `!isProductionRuntime()`
  // was the FORMER guard here — it reads as "only in dev" but actually means "anywhere not
  // labelled production", which includes staging, a 1:1 clone of production data, the
  // moment its APP_ENV/VERCEL_ENV/NODE_ENV label is anything other than "production". The
  // hardened form checks NODE_ENV === "development" directly instead, matching the pattern
  // already used by the ireports360-visits-* routes and reconciliation-check.
  //
  // All 18 routes #2479 hardened, not just the 4 this file already reads for other reasons —
  // a guard over 4 of 18 lets the other 14 (including the master-map sheet, the one route that
  // was actually exploitable on staging) regress silently on a green suite.
  const birthdaysRoute = readFileSync("app/api/notifications/birthdays/route.ts", "utf8");
  const cronAuthRouteFiles = [
    "app/api/cron/background-jobs/route.ts",
    "app/api/cron/brevo-keepalive/route.ts",
    "app/api/cron/db-health-snapshot/route.ts",
    "app/api/cron/direct-orders-expire-held/route.ts",
    "app/api/cron/direct-orders-probation/route.ts",
    "app/api/cron/direct-orders-rotate-sheet-token/route.ts",
    "app/api/cron/inbound-intake/route.ts",
    "app/api/cron/marketing-assignment-backfill/route.ts",
    "app/api/cron/marketing-requests-rotate-sheet-token/route.ts",
    "app/api/cron/recruitment-cv-digest/route.ts",
    "app/api/cron/recruitment-email-intake/route.ts",
    "app/api/cron/run-synthetic-journeys/route.ts",
    "app/api/notifications/birthdays/route.ts",
    "app/api/notifications/contract-renewals/route.ts",
    "app/api/notifications/daily/route.ts",
    "app/api/notifications/holiday-confirmation/route.ts",
    "app/api/notifications/process/route.ts",
    "app/api/sales/master-map/sheet/route.ts",
  ];
  for (const file of cronAuthRouteFiles) {
    const source = readFileSync(file, "utf8");
    assert.match(
      source,
      /if \(!secret\) return process\.env\.NODE_ENV === "development";/,
      `${file} cron auth must fail closed everywhere except a real local dev machine`,
    );
    assert.doesNotMatch(
      source,
      /if \(!secret\) return !isProductionRuntime\(\);/,
      `${file} cron auth must not fall back to the broader, staging-exposing !isProductionRuntime() guard`,
    );
    assert.doesNotMatch(
      source,
      /process\.env\.VERCEL\b/,
      `${file} cron auth must not depend on Vercel-specific env vars`,
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

  // Item A: birthday eligibility must delegate to the shared predicate (which treats
  // on_leave as active and resigned/terminated/not_renewed as terminal) instead of a
  // hand-rolled inline check that wrongly excluded on_leave employees.
  assert.match(
    birthdaysRoute,
    /import \{ isBirthdayEligibleEmployee \} from "@\/lib\/notifications\/birthday-eligibility";/,
    "birthdays route must import the shared eligibility predicate",
  );
  assert.match(
    birthdaysRoute,
    /\.filter\(isBirthdayEligibleEmployee\)/,
    "birthdays route must filter using the shared eligibility predicate",
  );
  assert.doesNotMatch(
    birthdaysRoute,
    /const active = !employee\.employment_status \|\| employee\.employment_status === "active";/,
    "the old inline active-status check must be removed from the birthdays route",
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
