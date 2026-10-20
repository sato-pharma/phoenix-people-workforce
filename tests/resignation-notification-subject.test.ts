import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { isActiveEmployee } from "@/lib/notifications/policy";

const policySource = readFileSync(
  new URL("../src/lib/notifications/policy.ts", import.meta.url),
  "utf8",
);

/**
 * Resignation notifications delivered NOTHING between 2026-06-22 and 2026-08-09:
 * 277 rows in notification_deliveries, every one status='skipped' on all four
 * channels, zero sent, while resignations kept being submitted.
 *
 * Cause: the SUBJECT of the notification was looked up with the RECIPIENT
 * eligibility filter. A resignation is by definition about somebody whose
 * employment_status has just become "resigned", so candidateByHrId returned null
 * for the subject, and that emptied BOTH configured strategies at once:
 *
 *   - manager_chain     -> managerFor() bails at `if (!employee?.hrId) return []`
 *                          before it ever reads manager_hr_id, so the chain is empty.
 *   - permission_based  -> `if (!subject) continue` skips every candidate,
 *                          including company-scope Super Admin / CEO who are
 *                          explicitly meant to bypass org-chain matching.
 *
 * Both empty -> recipients.length === 0 -> fail-closed governance skip. The
 * production events recorded exactly that, in their own words:
 *   manager_chain_missing, permission_recipient_missing,
 *   notification_governance_fail_closed.
 *
 * The rule this pins: a SUBJECT may be inactive; a RECIPIENT may not.
 */
export function runResignationNotificationSubjectTests() {
  // ── The predicate itself (behavioural) ─────────────────────────────────────
  // A leaver is correctly NOT recipient-eligible — this part was never wrong,
  // and must stay this way so departed staff are never notified.
  for (const status of ["resigned", "terminated", "inactive", "exited"]) {
    assert.equal(
      isActiveEmployee({ employment_status: status } as never),
      false,
      `"${status}" must not be eligible as a notification recipient.`,
    );
  }
  for (const status of ["active", "on_leave", ""]) {
    assert.equal(
      isActiveEmployee({ employment_status: status } as never),
      true,
      `"${status}" must remain eligible as a notification recipient.`,
    );
  }
  assert.equal(
    isActiveEmployee(null),
    true,
    "A missing employment_status must not silently disqualify a recipient.",
  );

  // ── The subject must be resolvable even when inactive ──────────────────────
  assert.match(
    policySource,
    /const subject = subjectHrId \? await candidateByHrId\(subjectHrId, \{ includeInactive: true \}\) : null;/,
    "The notification SUBJECT must be resolved with includeInactive — otherwise every resignation, termination and exit notification resolves to no recipients and is silently skipped on all channels.",
  );

  assert.match(
    policySource,
    /if \(!options\?\.includeInactive && !isActiveEmployee\(employee\)\) return null;/,
    "candidateByHrId must gate the active-employee filter behind includeInactive rather than applying it unconditionally.",
  );

  // manager_chain starts at the subject, who may be a leaver.
  assert.match(
    policySource,
    /await managerFor\(current, depth === 0 \? \{ includeInactive: true \} : undefined\)/,
    "managerChainFor must allow the FIRST hop (the subject) to be inactive, so a leaver's manager chain still resolves.",
  );

  assert.match(
    policySource,
    /const managers = await managerFor\(subjectHrId, \{ includeInactive: true \}\);/,
    "the direct_manager strategy must tolerate an inactive subject too.",
  );

  // ── The guard must NOT be weakened for recipients ──────────────────────────
  // These are the assertions that stop this fix turning into a leak.
  assert.match(
    policySource,
    /\/\/ No options here on purpose: a departed manager must not be notified\.\s*\n\s*const manager = await employeeByHrId\(managerHrId\);/,
    "The MANAGER (the actual recipient) must still be resolved under the active filter — a departed manager must never be notified.",
  );

  assert.doesNotMatch(
    policySource,
    /activeAuthCandidates\([^)]*includeInactive/,
    "The candidate pool for permission_based must stay active-only.",
  );

  assert.match(
    policySource,
    /if \(!subject\) continue;/,
    "permission_based must still refuse to match a SUBJECT-SCOPED candidate (self / reports-to / manager chain) when there is genuinely no subject.",
  );

  // ── …but a company/system-scope role must be decided BEFORE that bail ──────
  // Many operational alerts carry no subject at all — an ingestion stall, a finished
  // employee import. Those hit `if (!subject) continue` first, which rejected every
  // candidate INCLUDING Super Admin and CEO, so the alert resolved to nobody and the
  // fail-closed guard skipped it on every channel while still writing rows that made
  // cron look healthy. Production over 60 days: employee_import 4 events / 4 skipped,
  // attendance 37 skipped, payroll 24 skipped — none of them ever reaching a human.
  //
  // This is ordering only. With a subject present the old code already accepted these
  // candidates via the same scope test, so nothing newly qualifies; and canAccess()
  // still gates every candidate above, so the audience stays "roles that may access
  // this resource", never "everyone".
  const permissionBasedSlice = policySource.slice(
    policySource.indexOf("async function permissionBasedRecipients"),
  );
  const scopeEscapeIndex = permissionBasedSlice.indexOf('context.scope === "company"');
  const subjectBailIndex = permissionBasedSlice.indexOf("if (!subject) continue;");
  assert.ok(
    scopeEscapeIndex !== -1 && subjectBailIndex !== -1,
    "permissionBasedRecipients must still contain both the company/system-scope escape and the no-subject bail",
  );
  assert.ok(
    scopeEscapeIndex < subjectBailIndex,
    "the company/system-scope escape must come BEFORE `if (!subject) continue` — behind it, a subject-less " +
      "ops alert (ingestion stall, employee import) resolves to zero recipients and is silently skipped on every channel",
  );

  // The fail-closed guard itself must survive — it exists because a failed
  // recipient lookup once silently mailed the shared HR inbox instead.
  assert.match(
    policySource,
    /permission_recipient_missing/,
    "The fail-closed governance warning must remain; this fix resolves the subject, it does not disable the guard.",
  );

  // ── Owner's recipient decision (2026-08-09): Super Admin + HR Operations ──
  // Explicitly NOT the CEO, and explicitly NOT the leaver's manager chain. Pinned
  // here because "who is told someone resigned" is a business decision that must
  // not drift back to an org-chart inference.
  const roleRecipientsSource = readFileSync(
    new URL("../src/lib/notifications/role-recipients.ts", import.meta.url),
    "utf8",
  );
  const resignationsService = readFileSync(
    new URL("../src/lib/resignations/service.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    roleRecipientsSource,
    // The window is 1,200 characters, not 400: since 2026-10-20 the description names the HR
    // Operations Specialist and a comment explains her seat, and both sit between the key and roles.
    /resignation_workflow_alert: \{[\s\S]{0,1200}roles: \["Super Admin", "HR Operations", "HR Administration"\]/,
    "Resignation notifications must go to Super Admin, HR Operations (HR Generalist) and HR Administration (HR Operations Specialist).",
  );

  assert.doesNotMatch(
    policySource,
    /"resignations\.\*": \{[^}]*manager_chain/,
    "A resignation must NOT fan out up the leaver's manager chain — the owner asked for Super Admin + HR Operations only.",
  );

  assert.match(
    policySource,
    /"resignations\.\*": \{[^}]*recipientStrategy: \["permission_based"\]/,
    "resignations must resolve recipients from the explicit owner-set list via permission_based.",
  );

  assert.match(
    resignationsService,
    /resolveNotificationPersonRecipients\("resignation_workflow_alert"/,
    "the resignation emitter must resolve its audience from the admin-editable role policy, not hardcode HR IDs",
  );

  assert.match(
    resignationsService,
    /moduleOwnerHrIds,/,
    "the resolved recipients must be passed to the notification as metadata.moduleOwnerHrIds so permission_based targets them exactly",
  );

  // The email names a person; it must be able to name their job and manager even
  // though they are already marked resigned.
  assert.match(
    resignationsService,
    /getEmployeeDirectoryRows\(\{ includeInactive: true \}\)/,
    "the resignation email must load the leaver from the directory including inactive rows, or every detail token renders as a dash",
  );
}
