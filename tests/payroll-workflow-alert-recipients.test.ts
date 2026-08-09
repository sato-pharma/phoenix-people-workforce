import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { DEFAULT_NOTIFICATION_ROLE_POLICIES, notificationRoleKeys } from "@/lib/notifications/role-recipients";

const workflowRouteSource = readFileSync(
  new URL("../app/api/payroll/[id]/workflow/route.ts", import.meta.url),
  "utf8",
);
const uploadRouteSource = readFileSync(
  new URL("../app/api/payroll/upload/route.ts", import.meta.url),
  "utf8",
);
const policySource = readFileSync(
  new URL("../src/lib/notifications/policy.ts", import.meta.url),
  "utf8",
);

/**
 * "Payroll Workflow Updated" and "Payroll Upload Imported" reached NOBODY, on every batch.
 *
 * The payroll.* policy uses recipientStrategy: ["permission_based"], which resolves an
 * audience by scope-matching candidates against the notification's SUBJECT. Both of these are
 * ops events about a BATCH, not a person, so there is no subject — and
 * `if (!subject) continue` in permissionBasedRecipients then discards every candidate,
 * including the company-scope Super Admin/CEO/Finance Manager bypass that sits a few lines
 * below it (same failure mode as employee_import_alert and attendance_ingestion_alert before
 * their fixes).
 *
 * Result: a fail-closed skip on every channel, recorded as
 *   "permission_recipient_missing" / "notification_governance_fail_closed"
 * Confirmed in production: 8 workflow_updated events and 1 salary_upload_imported event, every
 * one with employee_hr_id NULL on the parent notification_event, last seen 2026-07-13.
 *
 * Fix: name the audience explicitly via metadata.moduleOwnerHrIds, which permission_based
 * consumes directly. Each named person must still hold payroll:read to survive canAccess —
 * though that floor is granted to every role (permissions.ts), so the real gate is this role
 * list, not canAccess.
 *
 * Owner decision 2026-08-09 (asked alongside the other three subject-less system alerts):
 * company-scope holders of the module's permission — Super Admin, CEO, Finance Manager.
 */
export function runPayrollWorkflowAlertRecipientTests() {
  // ── The audience must be named explicitly, on BOTH routes ──────────────────
  assert.match(
    workflowRouteSource,
    /resolveNotificationPersonRecipients\("payroll_workflow_alert"/,
    "the payroll workflow notification must resolve its recipients from the admin-editable role policy",
  );
  assert.match(
    workflowRouteSource,
    /moduleOwnerHrIds,\n\s*sensitivity: "payroll",/,
    "the workflow notification must pass its recipients as metadata.moduleOwnerHrIds — a subject-less ops alert resolves to nobody without them",
  );

  assert.match(
    uploadRouteSource,
    /resolveNotificationPersonRecipients\("payroll_workflow_alert"/,
    "the payroll upload notification must resolve its recipients from the SAME admin-editable role policy as the workflow notification — one toggle for both payroll ops alerts",
  );
  assert.match(
    uploadRouteSource,
    /moduleOwnerHrIds,\n\s*sensitivity: "payroll",/,
    "the upload notification must pass its recipients as metadata.moduleOwnerHrIds — a subject-less ops alert resolves to nobody without them",
  );

  // ── The role policy must exist and be enabled ──────────────────────────────
  assert.ok(
    (notificationRoleKeys as readonly string[]).includes("payroll_workflow_alert"),
    "payroll_workflow_alert must be a registered notification role key",
  );
  const policy = DEFAULT_NOTIFICATION_ROLE_POLICIES.payroll_workflow_alert;
  assert.deepEqual(
    policy.roles,
    ["Super Admin", "CEO", "Finance Manager"],
    "default oversight audience is the company-scope holders of the payroll permission, per the owner's 2026-08-09 decision",
  );
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
    /"payroll\.\*": \{[^}]*recipientStrategy: \["permission_based"\]/,
    "the payroll.* policy should still be permission_based — explicit recipients are consumed by it, and each still has to pass canAccess",
  );
  assert.match(
    policySource,
    /"payroll\.\*": \{[^}]*permissionResource: "payroll"/,
    "named recipients must still be gated on payroll:read — naming an audience must not widen authorization",
  );
}
