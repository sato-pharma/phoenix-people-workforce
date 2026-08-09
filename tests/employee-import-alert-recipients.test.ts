import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { DEFAULT_NOTIFICATION_ROLE_POLICIES, notificationRoleKeys } from "@/lib/notifications/role-recipients";

const routeSource = readFileSync(
  new URL("../app/api/imports/employees/confirm/route.ts", import.meta.url),
  "utf8",
);
const policySource = readFileSync(
  new URL("../src/lib/notifications/policy.ts", import.meta.url),
  "utf8",
);

/**
 * "Employee Import Completed" reached NOBODY, on every import.
 *
 * The employee_import.* policy uses recipientStrategy: ["permission_based"], which resolves
 * an audience by scope-matching candidates against the notification's SUBJECT. An import is
 * an ops event about a FILE, not about a person, so there is no subject — and
 * `if (!subject) continue` in permissionBasedRecipients then discards every candidate,
 * including the company-scope Super Admin/CEO bypass that sits a few lines below it.
 *
 * Result: a fail-closed skip on every channel, recorded as
 *   "permission_recipient_missing" / "notification_governance_fail_closed"
 * which reads like a permissions failure rather than "this alert names nobody". Confirmed in
 * production on the 2026-07-17 and 2026-08-05 imports — recipients: [], zero sent.
 *
 * Fix: name the audience explicitly via metadata.moduleOwnerHrIds, which permission_based
 * consumes directly. Each named person must still hold `imports:import` to survive canAccess,
 * so this names an audience without widening authorization.
 *
 * Owner decision 2026-08-09: the admin who RAN the import, plus Super Admin for oversight.
 */
export function runEmployeeImportAlertRecipientTests() {
  // ── The audience must be named explicitly ──────────────────────────────────
  assert.match(
    routeSource,
    /moduleOwnerHrIds: importAlertHrIds,/,
    "the import notification must pass its recipients as metadata.moduleOwnerHrIds — a subject-less ops alert resolves to nobody without them",
  );

  // The person who ran the import is always included, straight from the session.
  assert.match(
    routeSource,
    /\[access\.hrId, \.\.\.importOversightRecipients\.map\(\(recipient\) => recipient\.hrId\)\]/,
    "the admin who ran the import must always be notified of their own import's outcome",
  );

  // Oversight roles come from the admin-editable policy, not hardcoded HR IDs.
  assert.match(
    routeSource,
    /resolveNotificationPersonRecipients\("employee_import_alert"/,
    "oversight recipients must come from the admin-editable role policy, not a hardcoded list",
  );

  // Deduped: the importer may themselves be a Super Admin, and must not be told twice.
  assert.match(
    routeSource,
    /Array\.from\(\s*\n?\s*new Set\(/,
    "recipients must be deduped — a Super Admin running their own import must not receive two of everything",
  );

  // ── The role policy must exist and be enabled ──────────────────────────────
  assert.ok(
    (notificationRoleKeys as readonly string[]).includes("employee_import_alert"),
    "employee_import_alert must be a registered notification role key",
  );
  const policy = DEFAULT_NOTIFICATION_ROLE_POLICIES.employee_import_alert;
  assert.deepEqual(policy.roles, ["Super Admin"], "default oversight audience is Super Admin");
  assert.equal(policy.enabled, true, "the alert must default to enabled — it reached nobody for weeks while nominally 'working'");
  assert.ok(policy.description.trim().length > 0, "the policy needs a description for the admin console");

  // ── The guard must not be weakened to achieve this ─────────────────────────
  // The fix is "name the recipients", NOT "let permission_based fall back to everyone".
  assert.match(
    policySource,
    /if \(!subject\) continue;/,
    "permission_based must still refuse to invent an audience when a notification has neither a subject nor explicit recipients",
  );
  assert.match(
    policySource,
    /"employee_import\.\*": \{[^}]*recipientStrategy: \["permission_based"\]/,
    "the employee_import policy should still be permission_based — explicit recipients are consumed by it, and each still has to pass canAccess",
  );
  assert.match(
    policySource,
    /"employee_import\.\*": \{[^}]*permissionAction: "import", permissionResource: "imports"/,
    "named recipients must still be gated on imports:import — naming an audience must not widen authorization",
  );
}
