import assert from "node:assert/strict";

import { phoenixRoles } from "../src/lib/auth/permissions.ts";
import { DEFAULT_NOTIFICATION_ROLE_POLICIES, notificationRoleKeys } from "../src/lib/notifications/role-recipients.ts";

// Regression guard: today's exact production role values for the 12 hardcoded arrays this
// feature replaced (confirmed file:line during implementation). If this drifts from
// DEFAULT_NOTIFICATION_ROLE_POLICIES, either the default changed without updating this test's
// expectation, or a real behavior change slipped in unintentionally — both worth a hard stop.
// Note: 4 of these (telegram_daily_hr_digest, probation_weekly_dv_digest,
// weekly_plans_drift_alert, excuse_drift_alert) had "HR Manager" in their pre-existing hardcoded
// source array — that's a phoenixCompanyJobTitle, not a real PhoenixRole. A live production query
// confirmed zero app_auth_users rows ever had that role value, so it always silently matched
// nobody. Omitted here to match the REAL effective default (also enforced below: every listed
// role must be a genuine phoenixRoles member, which "HR Manager" is not).
const EXPECTED: Record<string, string[]> = {
  holiday_confirmation_reminder: ["Super Admin"],
  vacation_sla_hr_escalation: ["Super Admin"],
  telegram_daily_hr_digest: ["Super Admin"],
  weekly_system_health_digest: ["Super Admin"],
  probation_weekly_dv_digest: ["CEO", "Super Admin", "SFE Manager", "Training Manager"],
  field_workforce_compliance_digest: ["Super Admin"],
  outstation_sla_reminder: ["Super Admin", "Finance Manager", "CEO"],
  resignation_sla_reminder: ["Super Admin"],
  weekly_plans_drift_alert: ["Super Admin"],
  excuse_drift_alert: ["Super Admin"],
  ireports360_sync_notify: ["Super Admin"],
  attendance_ingestion_alert: ["Super Admin"],
};

export function runNotificationRoleRecipientsTests() {
  assert.equal(notificationRoleKeys.length, 12, "expected exactly the 12 confirmed notification-role keys");
  assert.deepEqual(
    [...notificationRoleKeys].sort(),
    Object.keys(EXPECTED).sort(),
    "notificationRoleKeys set does not match the confirmed 12 keys",
  );

  for (const key of notificationRoleKeys) {
    const policy = DEFAULT_NOTIFICATION_ROLE_POLICIES[key];
    assert.ok(policy, `missing DEFAULT_NOTIFICATION_ROLE_POLICIES entry for "${key}"`);
    assert.equal(policy.key, key, `"${key}" policy's own .key field is wrong`);
    assert.ok(policy.label.trim().length > 0, `"${key}" is missing a label`);
    assert.ok(policy.description.trim().length > 0, `"${key}" is missing a description`);

    assert.deepEqual(
      policy.roles.slice().sort(),
      EXPECTED[key].slice().sort(),
      `"${key}" default roles drifted from confirmed production behavior`,
    );

    for (const role of policy.roles) {
      assert.ok(
        (phoenixRoles as readonly string[]).includes(role),
        `"${key}" lists "${role}", which is not a real phoenixRoles member`,
      );
    }
  }
}
