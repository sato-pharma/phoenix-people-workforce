import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { phoenixRoles } from "../src/lib/auth/permissions.ts";
import { DEFAULT_NOTIFICATION_ROLE_POLICIES, notificationRoleKeys } from "../src/lib/notifications/role-recipients.ts";

// Regression guard: today's exact production role + enabled values for the 13 keys this
// feature governs (confirmed file:line during implementation). If this drifts from
// DEFAULT_NOTIFICATION_ROLE_POLICIES, either the default changed without updating this test's
// expectation, or a real behavior change slipped in unintentionally — both worth a hard stop.
// Note: 4 of these (telegram_daily_hr_digest, probation_weekly_dv_digest,
// weekly_plans_drift_alert, excuse_drift_alert) had "HR Manager" in their pre-existing hardcoded
// source array — that's a phoenixCompanyJobTitle, not a real PhoenixRole. A live production query
// confirmed zero app_auth_users rows ever had that role value, so it always silently matched
// nobody. Omitted here to match the REAL effective default (also enforced below: every listed
// role must be a genuine phoenixRoles member, which "HR Manager" is not).
// `probation_weekly_dv_digest` and `outstation_sla_reminder` are `enabled: false` because they
// were hard-disabled in code on 2026-07-22 (335437cc) and restored 2026-07-23 behind this real
// toggle, still defaulting off until a Super Admin explicitly re-enables them. `marketing_sla_reminder`
// is a new 13th key, also seeded `enabled: false` for the same reason, with an intentionally empty
// `roles` (its recipients are per-request, not role-configurable — see role-recipients.ts).
const EXPECTED: Record<string, { roles: string[]; enabled: boolean }> = {
  holiday_confirmation_reminder: { roles: ["Super Admin"], enabled: true },
  vacation_sla_hr_escalation: { roles: ["Super Admin"], enabled: true },
  telegram_daily_hr_digest: { roles: ["Super Admin"], enabled: true },
  weekly_system_health_digest: { roles: ["Super Admin"], enabled: true },
  probation_weekly_dv_digest: { roles: ["CEO", "Super Admin", "SFE Manager", "Training Manager"], enabled: false },
  field_workforce_compliance_digest: { roles: ["Super Admin"], enabled: true },
  // Finance Manager removed 2026-08-10 (owner: "exclude him 100% from outstation or expenses").
  outstation_sla_reminder: { roles: ["Super Admin", "CEO"], enabled: false },
  resignation_sla_reminder: { roles: ["Super Admin"], enabled: true },
  weekly_plans_drift_alert: { roles: ["Super Admin"], enabled: true },
  excuse_drift_alert: { roles: ["Super Admin"], enabled: true },
  ireports360_sync_notify: { roles: ["Super Admin"], enabled: true },
  attendance_ingestion_alert: { roles: ["Super Admin"], enabled: true },
  marketing_sla_reminder: { roles: [], enabled: false },
  // 14th key, added 2026-08-09 with the resignation-notification fix. Owner-set
  // audience: Super Admin + Talent Acquisition — deliberately NOT the CEO and NOT
  // the leaver's manager chain. Enabled on purpose: resignation notifications had
  // been silently dropping every message for seven weeks before this landed.
  resignation_workflow_alert: { roles: ["Super Admin", "Talent Acquisition"], enabled: true },
  // 15th key, added 2026-08-09. Oversight audience for a completed employee import; the
  // admin who ran the import is notified in addition to these roles, from the route itself.
  employee_import_alert: { roles: ["Super Admin"], enabled: true },
  // 16th key, added 2026-08-09/10. Payroll workflow_updated and salary_upload_imported are
  // ops events about a BATCH, not a person, so the same fail-closed-on-no-subject bug applied
  // (0 recipients, every channel skipped — 8 + 1 events in production, all NULL employee_hr_id).
  // Owner-set audience: company-scope holders of the payroll permission.
  payroll_workflow_alert: { roles: ["Super Admin", "CEO", "Finance Manager"], enabled: true },
};

export function runNotificationRoleRecipientsTests() {
  assert.equal(notificationRoleKeys.length, 16, "expected exactly the 16 confirmed notification-role keys");
  assert.deepEqual(
    [...notificationRoleKeys].sort(),
    Object.keys(EXPECTED).sort(),
    "notificationRoleKeys set does not match the confirmed 16 keys",
  );

  for (const key of notificationRoleKeys) {
    const policy = DEFAULT_NOTIFICATION_ROLE_POLICIES[key];
    assert.ok(policy, `missing DEFAULT_NOTIFICATION_ROLE_POLICIES entry for "${key}"`);
    assert.equal(policy.key, key, `"${key}" policy's own .key field is wrong`);
    assert.ok(policy.label.trim().length > 0, `"${key}" is missing a label`);
    assert.ok(policy.description.trim().length > 0, `"${key}" is missing a description`);

    assert.deepEqual(
      policy.roles.slice().sort(),
      EXPECTED[key].roles.slice().sort(),
      `"${key}" default roles drifted from confirmed production behavior`,
    );
    assert.equal(policy.enabled, EXPECTED[key].enabled, `"${key}" default enabled state drifted from confirmed production behavior`);

    for (const role of policy.roles) {
      assert.ok(
        (phoenixRoles as readonly string[]).includes(role),
        `"${key}" lists "${role}", which is not a real phoenixRoles member`,
      );
    }
  }

  assertEveryNotificationRoleKeyHasAMigratedCheckConstraintSeat();
}

// Regression guard for the exact gap that shipped resignation_workflow_alert and
// employee_import_alert into notificationRoleKeys (2026-08-09) with no migration: reads still
// worked (getNotificationRolePolicies() falls back to DEFAULT_NOTIFICATION_ROLE_POLICIES per key
// when no DB row exists), so nothing broke until an admin tried to edit either key from the
// notification-recipients console — updateNotificationRolePolicy()'s .update().eq(...).single()
// has no row to match (0 rows updated / "no rows returned"), and even a future INSERT would be
// rejected by the stale notification_key CHECK constraint. Every migration that touches this
// constraint rewrites it wholesale (the `do $$ ... drop constraint ... end $$` pattern first used
// in 20260723020000), so its real live shape is whichever such migration sorts LAST by filename
// (filenames are 14-digit timestamps, so lexicographic order is chronological order) — not any
// one file read in isolation.
function assertEveryNotificationRoleKeyHasAMigratedCheckConstraintSeat() {
  const migrationsDir = new URL("../supabase/migrations/", import.meta.url);
  const migrationFiles = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  let latest: { file: string; keys: string[] } | null = null;
  for (const file of migrationFiles) {
    const sql = readFileSync(new URL(file, migrationsDir), "utf8");
    const constraintBody = sql.match(/check\s*\(\s*notification_key\s+in\s*\(([\s\S]*?)\)\s*\)/i)?.[1];
    if (!constraintBody) continue;
    latest = { file, keys: [...constraintBody.matchAll(/'([a-z0-9_]+)'/gi)].map((m) => m[1]!) };
  }
  assert.ok(
    latest,
    "no migration under supabase/migrations defines the notification_role_policies notification_key CHECK constraint",
  );
  const { file: latestFile, keys: constraintKeys } = latest;

  const missingFromConstraint = notificationRoleKeys.filter((key) => !constraintKeys.includes(key));
  assert.deepEqual(
    missingFromConstraint,
    [],
    `notificationRoleKeys has keys with no seat in the notification_key CHECK constraint (latest definition: ${latestFile}) — ` +
      `add a migration (follow the "do $$ ... select conname ... drop constraint ... end $$" pattern in 20260723020000) ` +
      "that includes them, or updateNotificationRolePolicy() will fail the moment an admin edits that key's recipients",
  );

  const staleInConstraint = constraintKeys.filter((key) => !(notificationRoleKeys as readonly string[]).includes(key));
  assert.deepEqual(
    staleInConstraint,
    [],
    `the notification_key CHECK constraint in ${latestFile} allows keys that no longer exist in notificationRoleKeys: ${staleInConstraint.join(", ")}`,
  );
}
