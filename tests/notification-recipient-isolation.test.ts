import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  canViewerSeeNotification,
  isValidRecipientHrId,
  normalizeNotificationHrId,
} from "../src/lib/notifications/recipients.ts";
import { mapInAppNotificationRows } from "../src/lib/communication/metrics.ts";

/**
 * P1 regression coverage: in-app notification recipient isolation. The viewer
 * visibility rule must be fail-closed (default DENY) and ignore invalid/fixture
 * recipients. The notification service/mapper are pure for this rule, so it is
 * unit-tested directly; the env-bound query path and the bell UI are locked via
 * source assertions.
 */
export function runNotificationRecipientIsolationTests() {
  const A = "A-1";
  const B = "B-2";
  const C = "C-3";

  // 1. Own employee_hr_id notification is visible.
  assert.equal(canViewerSeeNotification(A, { employeeHrId: A, recipients: [] }), true, "own employee notification visible");

  // 2. Visible when recipients includes the viewer.
  assert.equal(canViewerSeeNotification(A, { employeeHrId: null, recipients: [A] }), true, "recipient match visible");

  // 3. User A does NOT see User B's notification.
  assert.equal(canViewerSeeNotification(A, { employeeHrId: B, recipients: [B] }), false, "other employee's notification hidden");

  // 4. User A does NOT see a notification addressed to [B].
  assert.equal(canViewerSeeNotification(A, { employeeHrId: null, recipients: [B] }), false, "recipients [B] hidden from A");

  // 5. Invalid PHASE/fixture/email recipients never grant access.
  assert.equal(isValidRecipientHrId("PHASE17_MPBRQEFJ_521DF68E_VAC"), false, "PHASE id is not a valid recipient");
  assert.equal(isValidRecipientHrId("user@satopharma.com"), false, "email is not a valid recipient");
  assert.equal(isValidRecipientHrId(""), false, "empty is not a valid recipient");
  assert.equal(isValidRecipientHrId("FIXTURE-1"), false, "fixture id is not a valid recipient");
  assert.equal(isValidRecipientHrId("A-1"), true, "real HR_ID is a valid recipient");
  assert.equal(
    canViewerSeeNotification("PHASE17_X", { employeeHrId: null, recipients: ["PHASE17_X"] }),
    false,
    "phase fixture recipient does not leak even to a matching token",
  );
  assert.equal(
    canViewerSeeNotification(A, { employeeHrId: null, recipients: ["PHASE17_X", A] }),
    true,
    "valid recipient still matches alongside an ignored fixture token",
  );
  assert.equal(
    canViewerSeeNotification(A, { employeeHrId: null, recipients: ["x@y.com"] }),
    false,
    "email recipient is ignored (no leak)",
  );

  // 6. No employee and no matching recipient -> denied.
  assert.equal(canViewerSeeNotification(A, { employeeHrId: null, recipients: [] }), false, "no subject + no recipient denied");
  assert.equal(canViewerSeeNotification(A, { recipients: [B] }), false, "no subject + non-matching recipient denied");

  // 7. Mixed recipients [A, B] shows to A and B only.
  assert.equal(canViewerSeeNotification(A, { recipients: [A, B] }), true, "mixed recipients visible to A");
  assert.equal(canViewerSeeNotification(B, { recipients: [A, B] }), true, "mixed recipients visible to B");
  assert.equal(canViewerSeeNotification(C, { recipients: [A, B] }), false, "mixed recipients hidden from C");

  // 8. Case-insensitive HR_ID matching.
  assert.equal(normalizeNotificationHrId(" a-1 "), "A-1", "normalization trims + uppercases");
  assert.equal(canViewerSeeNotification(A, { employeeHrId: "a-1", recipients: [] }), true, "employee match is case-insensitive");
  assert.equal(canViewerSeeNotification(A, { recipients: ["a-1"] }), true, "recipient match is case-insensitive");

  // 9. Admin/Super Admin personal bell does NOT auto-see everyone's notifications.
  assert.equal(
    canViewerSeeNotification("ADMIN-HR", { employeeHrId: B, recipients: [B] }),
    false,
    "admin does not auto-see another employee's notification (no implicit broadcast)",
  );
  assert.equal(
    canViewerSeeNotification("ADMIN-HR", { employeeHrId: null, recipients: ["ADMIN-HR", B] }),
    true,
    "admin sees a notification only when explicitly a recipient",
  );

  // Empty/invalid viewer is always denied (fail closed).
  assert.equal(canViewerSeeNotification("", { recipients: [A] }), false, "empty viewer denied");
  assert.equal(canViewerSeeNotification(null, { employeeHrId: A, recipients: [A] }), false, "null viewer denied");

  // Integration via mapInAppNotificationRows: filtering applies to all categories.
  const mapped = mapInAppNotificationRows(
    [
      { category: "leave", employeeHrId: A, id: "n1", metadata: { title: "Yours", message: "m" }, recipients: [A], status: "sent", subject: "Yours" },
      { category: "leave", employeeHrId: B, id: "n2", metadata: { title: "Theirs", message: "m" }, recipients: [B], status: "sent", subject: "Theirs" },
      { category: "vacation_request", employeeHrId: null, id: "n3", metadata: { title: "Fixture", message: "m" }, recipients: ["PHASE17_X"], status: "sent", subject: "Fixture" },
    ],
    A,
  ).map((row) => row.id);
  assert.deepEqual(mapped, ["n1"], "mapper keeps only the viewer's own notification across categories");

  // Sensitive metadata must not be surfaced in notification details.
  const detailRows = mapInAppNotificationRows(
    [
      {
        category: "general",
        employeeHrId: A,
        id: "s1",
        metadata: { title: "t", message: "m", orderId: "O-1", token: "super-secret-token", email: "a@b.com", password: "pw", netSalary: "99999", grossSalary: "123456" },
        recipients: [A],
        status: "sent",
        subject: "t",
      },
    ],
    A,
  );
  const details = detailRows[0]?.details ?? [];
  const detailBlob = JSON.stringify(details).toLowerCase();
  assert.equal(detailBlob.includes("super-secret-token"), false, "token value must not appear in details");
  assert.equal(detailBlob.includes("password"), false, "password must not appear in details");
  assert.equal(detailBlob.includes("a@b.com"), false, "email must not appear in details");
  // Salary amounts must never surface in a notification card (payslip privacy).
  assert.equal(detailBlob.includes("99999"), false, "net salary must not appear in details");
  assert.equal(detailBlob.includes("123456"), false, "gross salary must not appear in details");
  assert.ok(details.some((d) => d.label === "Order"), "non-sensitive details (Order) still render");

  // Wiring: the query path selects employee_hr_id and applies the canonical filter.
  const inAppSource = readFileSync(new URL("../src/lib/notifications/in-app.ts", import.meta.url), "utf8");
  assert.match(inAppSource, /employee_hr_id/, "in-app query must select employee_hr_id");
  assert.match(inAppSource, /canViewerSeeNotification\(employeeHrId/, "in-app must fail-closed filter after the DB query");

  const metricsSource = readFileSync(new URL("../src/lib/communication/metrics.ts", import.meta.url), "utf8");
  assert.match(metricsSource, /canViewerSeeNotification\(employeeHrId/, "mapper must use the canonical recipient rule");
  assert.match(metricsSource, /isSensitiveMetadataKey/, "mapper must screen sensitive metadata keys");

  // Wiring: the bell UI premium states + recipient clarity.
  const bellSource = readFileSync(new URL("../src/components/layout/in-app-notifications-bell.tsx", import.meta.url), "utf8");
  assert.match(bellSource, /You&rsquo;re all caught up\.|You're all caught up\./, "empty state present");
  assert.match(bellSource, /Try again/, "error state has a retry control");
  assert.match(bellSource, /animate-pulse/, "loading skeleton present");
  assert.match(bellSource, /Action required/, "action-required badge present");
  assert.match(bellSource, /notificationsSubtitle/, "header uses the recipient-clarity subtitle");

  const settingsSource = readFileSync(new URL("../src/config/system-settings.ts", import.meta.url), "utf8");
  assert.match(settingsSource, /notificationsSubtitle: "Only updates assigned to you\."/, "subtitle clarifies recipient scope");

  // ===========================================================================
  // WP-N1: notification CONTENT clarity (who / what / when / status / action).
  // Vacation + probation services are env-bound, so content is locked via source.
  // ===========================================================================
  const vacationSource = readFileSync(new URL("../src/lib/vacation/service.ts", import.meta.url), "utf8");
  // Submitted: employee + type + period (start->end) + clear action.
  assert.match(
    vacationSource,
    /\$\{input\.request\.employeeName\} submitted \$\{vacationTypeLabel\(input\.request\.vacationType\)\} from \$\{input\.request\.startDate\} to \$\{input\.request\.endDate\}[\s\S]*Review is pending your decision\./,
    "vacation submitted message must include employee, type, dates and the pending-decision action",
  );
  // Manager review + HR decision messages must include type + period.
  assert.match(
    vacationSource,
    /\$\{input\.request\.employeeName\}'s \$\{vacationTypeLabel\(input\.request\.vacationType\)\} \(\$\{input\.request\.startDate\} to \$\{input\.request\.endDate\}\)[\s\S]*HR final decision is required\./,
    "vacation manager-review message must include type, period and required HR action",
  );
  assert.match(
    vacationSource,
    /\$\{vacationTypeLabel\(input\.request\.vacationType\)\} \(\$\{input\.request\.startDate\} to \$\{input\.request\.endDate\}\) was/,
    "vacation HR-decision message must include type and period",
  );

  const probationSource = readFileSync(new URL("../src/lib/probation/service.ts", import.meta.url), "utf8");
  assert.match(probationSource, /Submit manager probation feedback\./, "probation reminder must state the required action");
  assert.match(probationSource, /Probation feedback due: \$\{employee\.fullName\}/, "probation reminder title must name the employee and the due action");

  // Defensive: salary terms are in the sensitive-key denylist (payslip privacy).
  assert.match(metricsSource, /sensitiveMetadataKeyPattern[\s\S]*salary/, "sensitive-key denylist must cover salary terms");
}
