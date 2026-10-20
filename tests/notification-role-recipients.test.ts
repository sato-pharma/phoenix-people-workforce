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
  // Owner-set 2026-08-09 as ["Super Admin", "Talent Acquisition"]. That seat retired 2026-08-28
  // and its resignations grant went to HR Operations, not HR Advisory — resignations:update is
  // in the people_records function, which only HR Operations holds — so she inherits the audience.
  // This is a DEFAULT: production carries a stored notification_role_policies row (verified
  // 2026-08-28, exactly one, still reading ["Super Admin","Talent Acquisition"] with the old name
  // inside its description too), and the stored row WINS over this constant. The migration in
  // this PR rewrites both columns; until it is applied, changing this line alone changes nothing
  // in production, which is precisely the drift this guard exists to make visible.
  // HR Administration (the HR Operations Specialist seat) joined on 2026-10-20 on the owner's word:
  // she follows each resignation up until the leaver completes the cycle at the office. The same
  // stored-row caveat applies, so the seat's migration rewrites the row's roles and description too.
  resignation_workflow_alert: { roles: ["Super Admin", "HR Operations", "HR Administration"], enabled: true },
  // 15th key, added 2026-08-09. Oversight audience for a completed employee import; the
  // admin who ran the import is notified in addition to these roles, from the route itself.
  employee_import_alert: { roles: ["Super Admin"], enabled: true },
  // 16th key, added 2026-08-09/10. Payroll workflow_updated and salary_upload_imported are
  // ops events about a BATCH, not a person, so the same fail-closed-on-no-subject bug applied
  // (0 recipients, every channel skipped — 8 + 1 events in production, all NULL employee_hr_id).
  // Owner-set audience: company-scope holders of the payroll permission.
  payroll_workflow_alert: { roles: ["Super Admin", "CEO", "Finance Manager"], enabled: true },
  // 17th key, added 2026-08-29. #2686 made an overdue marketing invoice visible on the Approved
  // Requests tab and in the export; this is the push behind it. Owner, asked directly and answered
  // in three words: "the requester and finance". Only the FINANCE half is a role list — the
  // requester is always told about their own request and is not configurable, which is why the
  // roles here name the Finance Manager alone rather than including a requester-shaped entry.
  marketing_invoice_overdue_alert: { roles: ["Finance Manager"], enabled: true },
  // 18th key, added 2026-09-03. Nothing watched the eighteen hand-uploaded distributor files the
  // monthly closing is assembled from — July 2026 was built on four of its eighteen sources, 84% of
  // its value absent, and every tab rendered immaculately. Owner, asked directly, answered "sfe" and
  // "You + Super Admins"; the uploader himself holds Super Admin, so the role list reaches him
  // without a separate always-on leg that would deliver the same message to him twice. Both default
  // roles hold sales:import, which is what the /sales/upload link in the message requires, so every
  // recipient can perform the upload rather than land on a redirect.
  distributor_upload_overdue_alert: { roles: ["Super Admin", "SFE Manager"], enabled: true },
  // 19th key, added 2026-09-07. Payroll pays Part 1 at the start of the month and Part 2 the day
  // after, and people collect both and resign — 23 of 59 recorded resignations land in the first
  // ten days of a month, five medical reps resigned on 9 August 2026 alone, and four of those five
  // had stopped logging CRM entries five or more days earlier with nothing raised anywhere. Owner,
  // asked directly on 2026-09-06, picked all four of these roles. The subject's own line manager is
  // a fifth recipient added per alert by the sweep from that employee's reporting line — NOT a role
  // here, deliberately: it is one named manager per subject, and making it a role would mean every
  // District Manager in the company receiving every alert about everybody.
  retention_risk_alert: {
    // HR Advisory was the fourth until the owner retired the HR Business Partner seat on 2026-10-08;
    // the stored production row lost it in 20261008235900_retire_hr_advisory_seat.sql the same day.
    roles: ["HR Operations", "Super Admin", "SFE Manager"],
    enabled: true,
  },
  // 20th key, added 2026-09-07. `employees.crm_username` and `employees.crm_id` are how every CRM
  // read resolves a visit back to a person, both are optional on the employee form, and nothing
  // used to say so — a new rep saved without them files every day of field work under an unmapped
  // agent id, with no error anywhere and no empty state. Owner instruction: tell the SFE Manager
  // by email and in-app when an employee is added, and link him to the screen that asks for the
  // two values. He named ONE recipient, and one is the point: an audience of two on a per-hire
  // notice is how both learn to assume the other one did it. Extended 2026-09-29 at the owner's
  // instruction to copy HR Operations, so the same notice reaches HR alongside the SFE Manager.
  crm_account_setup_alert: { roles: ["SFE Manager", "HR Operations"], enabled: true },
  // 22nd key, added 2026-09-18. Owner instruction: when an employee is added, their Turbify
  // mailbox is made and its app password lands in Phoenix, so My email works on day one. Turbify
  // has no API for either, so one person does the Turbify half; he named himself as that person.
  // Super Admin ALONE, and in-app plus Telegram only — the alert is ABOUT a mailbox that does not
  // exist yet, and his standing rule is that nothing here sends anyone an email.
  new_hire_mailbox_alert: { roles: ["Super Admin"], enabled: true },
  // 23rd key, added 2026-09-23. The milestones module's reminder audience. Super Admin ALONE,
  // because the owner narrowed the whole module to Super Admin the same day ("make it only super
  // admin. None either uh, CEO").
  service_milestone_notice: { roles: ["Super Admin"], enabled: true },
  // 24th key, added 2026-09-26. The daily inactive-colleague digest. Super Admin ALONE —
  // the owner asked for it to reach him, in-app and on Telegram, and never by email.
  activity_inactivity_digest: { roles: ["Super Admin"], enabled: true },
  // 25th key, added 2026-10-02. Fires the moment a job offer is marked accepted, so the new hire
  // can be seated. Owner chose Super Admin + HR Operations, in-app + push + Telegram (he added
  // Telegram when asked), and never email. Talent Acquisition (HR Resourcing) added 2026-10-16.
  accepted_offer_alert: { roles: ["Super Admin", "HR Operations", "HR Resourcing"], enabled: true },
};

export function runNotificationRoleRecipientsTests() {
  assert.equal(notificationRoleKeys.length, 24, "expected exactly the 24 confirmed notification-role keys");
  assert.deepEqual(
    [...notificationRoleKeys].sort(),
    Object.keys(EXPECTED).sort(),
    "notificationRoleKeys set does not match the confirmed 25 keys",
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
