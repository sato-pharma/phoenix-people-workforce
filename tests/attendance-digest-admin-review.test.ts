import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Contract guards for the admin review gate on the weekly-digest pipeline
 * (owner directive 2026-07-03): a digest carrying a real deduction must
 * never reach the employee directly. It routes to the System Administrator
 * / HR Manager approver list first, who may edit any line before approving
 * — only then does it send. A clean (zero-deduction) week is unaffected.
 */
export function runAttendanceDigestAdminReviewTests() {
  const settlementService = readFileSync("src/lib/attendance/settlement-service.ts", "utf8");

  // 1. sendDigest branches on whether the digest actually has a deduction —
  //    a clean digest must never be silently held for review.
  assert.match(
    settlementService,
    /const hasDeduction = Number\(\(draftRow as \{ total_deduction_value: number \}\)\.total_deduction_value\) > 0;/,
    "sendDigest must branch on whether the draft actually carries a deduction",
  );
  assert.match(
    settlementService,
    /if \(hasDeduction\) \{\s*return routeDigestForReview/,
    "a deduction-bearing digest must route to admin review, not send directly",
  );

  // 2. routeDigestForReview and approveDigestReview are both TOCTOU-safe:
  //    guarded on the exact prior status, not just an id match.
  assert.match(settlementService, /\.eq\("status", "draft"\)/, "routing to review must guard on the digest still being in draft");
  assert.match(settlementService, /\.eq\("status", "pending_admin_review"\)/, "approval/void must guard on the digest still awaiting review");

  // 3. Approval reuses the exact same self-exclusion + CEO-fallback reviewer
  //    pool as dispute review ("if the subject is an approver, the others
  //    handle it") — not a bespoke authorization rule.
  assert.match(
    settlementService,
    /const reviewers = await resolveDisputeReviewers\(digest\.employee_hr_id, settings\);[\s\S]{0,200}if \(!actor \|\| !reviewers\.includes\(actor\)\)/,
    "approveDigestReview must gate on resolveDisputeReviewers, the same pool dispute review uses",
  );

  // 4. Line edits snapshot the system-computed value into original_* BEFORE
  //    overwriting it — the audit trail must never silently lose the
  //    original number.
  assert.match(
    settlementService,
    /original_deduction_days: line\.deduction_days,\s*original_deduction_value: line\.deduction_value,\s*original_reason: line\.reason,/,
    "an edited line must snapshot its pre-edit values into original_* before the edit is applied",
  );

  // 5. A voided digest is a dead end — no employee notification is ever sent
  //    for it (the employee must never know a rejected/voided digest existed).
  const voidFn = settlementService.slice(settlementService.indexOf("export async function voidDigestReview"));
  assert.doesNotMatch(voidFn.slice(0, voidFn.indexOf("\n}\n")), /notifyDigestSent|notifyDigestPendingReview/, "voidDigestReview must never notify the employee");

  const digestNotify = readFileSync("src/lib/attendance/digest-notify.ts", "utf8");

  // 6. The employee-facing send uses the personalized recipientName, not a
  //    generic "Dear Team" — and the digest table is a real HTML block, not
  //    just plain text stuffed into the summary.
  assert.match(digestNotify, /recipientName: input\.employeeName,/, "notifyDigestSent must pass the real recipient's name for the greeting");
  assert.match(digestNotify, /templateKey: "attendance_digest",/, "notifyDigestSent must use the dedicated attendance_digest template, not the generic fallback");
  assert.match(digestNotify, /digestTable: buildDigestTableHtml\(input\.lines, input\.currency\)/, "notifyDigestSent must render the deduction table into the email");

  // 7. The digest table only shows real deduction lines — a missing-punch
  //    line (zero EGP, handled by a separate chain) must never appear in it.
  assert.match(digestNotify, /const deductible = lines\.filter\(\(line\) => line\.deductionDays > 0\);/, "the digest table must filter to deductible lines only");

  // 8. The employee's own digest list/detail must NEVER include a digest
  //    still sitting in admin review, OR one an admin voided before it ever
  //    sent — a voided digest was never seen by the employee and must never
  //    leak the fact that it existed (regression-tested: an earlier version
  //    hid draft/pending_admin_review but forgot 'void', which genuinely
  //    leaked a voided digest into an employee's own portal payload).
  const digestRead = readFileSync("src/lib/attendance/digest-read.ts", "utf8");
  assert.match(
    digestRead,
    /const EMPLOYEE_HIDDEN_STATUSES = \["draft", "pending_admin_review", "void"\] as const;/,
    "listMyDigests/getDigestDetailForEmployee must hide draft, pending_admin_review, AND void from the employee",
  );

  // 8b. The attendance passport allows self-access (an employee can view
  //     their own record) and shares the exact same leak risk — it must apply
  //     the same hidden-status filter whenever the viewer is looking at
  //     themselves, even if they also happen to be an admin.
  const passport = readFileSync("src/lib/attendance/attendance-passport.ts", "utf8");
  assert.match(
    passport,
    /const EMPLOYEE_HIDDEN_DIGEST_STATUSES = \["draft", "pending_admin_review", "void"\] as const;/,
    "the passport must define the same hidden-status list as digest-read.ts",
  );
  assert.match(passport, /if \(options\.viewerIsSelf\) \{/, "the passport must only apply the hidden-status filter for self-view, not admin view");
  const passportRoute = readFileSync("app/api/attendance/passport/[hrId]/route.ts", "utf8");
  assert.match(passportRoute, /getAttendancePassport\(hrId, \{ viewerIsSelf: isSelf \}\)/, "the passport API route must pass viewerIsSelf through");
  const passportPage = readFileSync("app/(admin)/attendance/passport/[hrId]/page.tsx", "utf8");
  assert.match(passportPage, /getAttendancePassport\(hrId, \{ viewerIsSelf: isSelf \}\)/, "the passport page must pass viewerIsSelf through");

  // 9. Email template is registered in the system templates page (editable
  //    by an admin), not hardcoded only in the notification call.
  const emailTemplates = readFileSync("src/lib/email-templates/service.ts", "utf8");
  assert.match(emailTemplates, /"attendance_digest"/, "attendance_digest must be a registered email template key");
  assert.match(emailTemplates, /\{\{digestTable\}\}/, "the attendance_digest template body must render {{digestTable}}");
  assert.match(emailTemplates, /greeting: "Dear \{\{honorific\}\}\{\{recipientName\}\},"/, "attendance_digest greeting must use the personalized recipient name, matching weekly_plans/coaching_report");

  // 10. Routes registered with the correct guard, and mutations CSRF-protected.
  const registry = readFileSync("src/lib/security/access-registry.ts", "utf8");
  for (const pattern of ["/api/attendance/digest-review", "/api/attendance/digest-review/:id/approve", "/api/attendance/digest-review/:id/void"]) {
    assert.ok(registry.includes(`pattern: "${pattern}"`), `access registry must contain an entry for ${pattern}`);
  }
  const approveRoute = readFileSync("app/api/attendance/digest-review/[id]/approve/route.ts", "utf8");
  assert.match(approveRoute, /assertSameOriginMutation\(request\)/, "approve route must enforce same-origin CSRF protection");
  const voidRoute = readFileSync("app/api/attendance/digest-review/[id]/void/route.ts", "utf8");
  assert.match(voidRoute, /assertSameOriginMutation\(request\)/, "void route must enforce same-origin CSRF protection");
}
