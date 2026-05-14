import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

export function runLeaveMigrationTests() {
  const source = readFileSync("supabase/20260512_leave_management_engine.sql", "utf8");
  const legacyDomain = ["vac", "ation"].join("");

  for (const table of [
    "leave_types",
    "leave_policies",
    "employee_leave_balances",
    "leave_requests",
    "leave_transactions",
    "leave_approvals",
    "public_holidays",
  ]) {
    assert.match(source, new RegExp(`create table public\\.${table}`));
    assert.match(source, new RegExp(`alter table public\\.${table} enable row level security`));
  }

  assert.match(source, /Egypt Annual Leave Policy/);
  assert.match(source, /annual_days_first_year[\s\S]*default 15/);
  assert.match(source, /annual_days_after_first_year[\s\S]*default 21/);
  const simplifiedPolicyMigration = readFileSync("supabase/migrations/20260514163534_simplify_leave_entitlement_policy.sql", "utf8");
  assert.match(simplifiedPolicyMigration, /annual_days_first_year = 15/);
  assert.match(simplifiedPolicyMigration, /annual_days_after_first_year = 21/);
  assert.match(simplifiedPolicyMigration, /accrual_method = 'monthly'/);
  assert.match(simplifiedPolicyMigration, /accrual_frequency = 'monthly'/);
  assert.match(simplifiedPolicyMigration, /check \(accrual_method = 'monthly'\)/);
  assert.match(simplifiedPolicyMigration, /check \(accrual_frequency = 'monthly'\)/);
  assert.match(simplifiedPolicyMigration, /drop column if exists annual_days_senior/);
  assert.match(simplifiedPolicyMigration, /drop column if exists annual_days_disability/);
  assert.match(simplifiedPolicyMigration, /drop column if exists senior_after_years/);
  assert.match(simplifiedPolicyMigration, /drop column if exists senior_after_age/);
  assert.match(simplifiedPolicyMigration, /drop column if exists has_disability/);
  assert.match(source, /Opening Balance \+ Accrual|opening_balance/);
  assert.match(source, /leave_transactions_monthly_accrual_uidx/);
  assert.match(source, /leave_transactions_request_type_uidx/);
  assert.match(source, /transaction_type in \('pending', 'pending_reversal', 'consumed', 'consumed_reversal'\)/);
  assert.match(source, /grant select on public\.leave_types, public\.leave_policies, public\.employee_leave_balances, public\.leave_requests, public\.leave_transactions, public\.leave_approvals, public\.public_holidays to authenticated/);
  assert.doesNotMatch(source, /grant select, insert, update on public\.employee_leave_balances/);
  assert.match(source, /if to_regclass\('public\.email_notification_policies'\) is not null then/);
  assert.match(source, /pending_manager/);
  assert.match(source, /pending_hr/);
  assert.match(source, /hr_approved/);
  assert.match(source, /private\.phx_can_access_employee/);
  assert.match(source, /notification_type[\s\S]*'leave'/);

  assert.equal(existsSync(["app/api", legacyDomain].join("/")), false, "legacy vacation API routes should be removed");
  assert.equal(existsSync(["src/lib", legacyDomain].join("/")), false, "legacy vacation library should be removed");
  assert.equal(existsSync(["src/components", legacyDomain].join("/")), false, "legacy vacation components should be removed");
}
