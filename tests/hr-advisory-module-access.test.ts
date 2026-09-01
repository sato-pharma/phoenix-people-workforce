/**
 * The HR Business Partner's 2026-09-01 module opening — and the one boundary inside it.
 *
 * WHAT THE OWNER ASKED FOR. Seventeen modules were to appear in her account. Four already worked
 * and only lacked a sidebar row; seven were already there; six needed a decision, which he gave.
 * One of those six came with a rule attached, and that rule is what most of this file defends:
 *
 *     "in payslips, you will make her able to see the district managers, the Medicare reps,
 *      and herself only in the payslips."
 *
 * WHY THAT RULE NEEDS A TEST AND THE OTHER SIXTEEN DO NOT. Every other item is a link appearing or
 * a gate widening: if one breaks, a page 404s or a row vanishes, and somebody says so within a day.
 * This one is the opposite shape. If the audience filter silently stops filtering, nothing looks
 * wrong — the page renders, the dropdown fills, the numbers are real. It just quietly shows her
 * every salary in the company, including the managers above her. A failure that LOOKS like success
 * is exactly the kind this repository writes tests for.
 *
 * THE TWO HALVES THAT MUST AGREE. The same sentence governs two screens: the Payslips Center rows
 * and the Employee Directory's salary columns. They deliberately share ONE list
 * (HR_ADVISORY_COMPENSATION_JOB_TITLES) so they cannot drift, and the test below asserts the
 * agreement rather than checking each against a copy of the answer.
 *
 * MEASURED AGAINST PRODUCTION when it was written: 796 published payslip rows in total, of which
 * 676 (144 people) are District Sales Managers and Medical Representatives. Those figures are NOT
 * asserted here — they move every payroll month, and a test that pins a count becomes a test that
 * fails for being right. What is asserted is the PREDICATE that produced the split.
 */

import assert from "node:assert/strict";

import { getNavigationSections } from "../src/config/system-navigation.ts";
import {
  HR_ROLE_BUNDLES,
  hrBundleGrants,
  type HrFunctionKey,
} from "../src/lib/auth/hr-functions.ts";
import { canViewManagerCvEngagement } from "../src/lib/recruitment/manager-cv-engagement.ts";
import {
  buildPermissionLookup,
  HR_ADVISORY_COMPENSATION_JOB_TITLES,
  matchesHrAdvisoryCompensationAudience,
  permissionMatrix,
  type AccessContext,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import {
  HR_ADVISORY_PAYSLIP_JOB_TITLES,
  isPayslipRowVisibleToAudience,
  resolvePayslipCenterAudience,
} from "../src/lib/payroll/payslip-center.ts";

function viewer(role: PhoenixRole, hrId: string | null = "HR-010"): AccessContext {
  return { hrId, loginId: hrId, role, scope: "self", source: "session" };
}

/** Every row this seat is actually OFFERED, flattened out of the authored /hr catalogue. */
function hrRowsFor(role: PhoenixRole): { href: string; label: string; section: string }[] {
  const lookup = buildPermissionLookup(permissionMatrix, role);
  const rows: { href: string; label: string; section: string }[] = [];
  for (const section of getNavigationSections("hr")) {
    for (const item of section.items) {
      if (item.roles && !item.roles.includes(role)) continue;
      if (item.excludedRoles?.includes(role)) continue;
      const allowed = (item.permissions ?? []).every(
        (permission) => lookup[`${permission.resource}:${permission.action ?? "read"}`] === true,
      );
      if (!allowed) continue;
      rows.push({ href: item.href, label: item.label, section: section.label });
    }
  }
  return rows;
}

export async function runHrAdvisoryModuleAccessTests() {
  // ── 1. The payslip audience ────────────────────────────────────────────────
  const advisory = resolvePayslipCenterAudience(viewer("HR Advisory"));
  assert.ok(advisory, "the HR Business Partner must reach the Payslips Center at all");
  assert.equal(advisory.kind, "job-titles", "she gets a NAMED audience, never company scope");

  const operations = resolvePayslipCenterAudience(viewer("HR Operations", "HR-011"));
  assert.deepEqual(operations, { kind: "company" }, "HR Operations keeps company-wide payroll sight");
  assert.equal(
    resolvePayslipCenterAudience(viewer("Medical Rep", "A-40")),
    null,
    "a rep has no Payslips Center audience and must be sent to her own payslip",
  );

  // The two screens must be governed by ONE list. Asserted by identity, not by re-listing the
  // titles: a copy would agree with itself while the screens disagreed with each other.
  assert.deepEqual(
    [...HR_ADVISORY_PAYSLIP_JOB_TITLES],
    [...HR_ADVISORY_COMPENSATION_JOB_TITLES],
    "the Payslips Center and the Employee Directory must share one job-title list",
  );

  // ── 2. The predicate itself ────────────────────────────────────────────────
  const see = (jobTitle: string | null, hrId: string | null = "A-99") =>
    isPayslipRowVisibleToAudience(advisory, { hrId, jobTitle });

  assert.equal(see("District Sales Manager"), true, "a district manager is hers to see");
  assert.equal(see("Medical Representative"), true, "a medical rep is hers to see");
  // The column is free text and already carries casing drift elsewhere ("Sfe Manager" beside "SFE
  // Manager"), so a case-sensitive match would drop real rows — and a dropped payslip row reads as
  // "this person was never paid" rather than as a bug.
  assert.equal(see("  medical representative "), true, "casing and padding must not hide a row");

  // The refusals are the point of the rule. Each of these is somebody's real salary.
  assert.equal(see("National Sales Manager"), false, "her own management chain stays closed");
  assert.equal(see("Regional Sales Manager"), false, "a title that merely LOOKS like a district row stays closed");
  assert.equal(see("Finance Manager"), false, "finance stays closed");
  assert.equal(see("HR Operations Coordinator"), false, "the other HR seat stays closed");
  assert.equal(see(null), false, "a row with no job title is not admitted by default");

  // "and herself". She had no salary record on the day this shipped (she joined 2026-09-01), so
  // this is the half that cannot be verified by looking at production — only here.
  assert.equal(see("HR Business Partner", "HR-010"), true, "her own record is hers to see");
  // HR ids are MIXED CASE in this database and a plain equality has under-returned by 28%
  // elsewhere, so the comparison must survive either spelling.
  assert.equal(see("HR Business Partner", "hr-010"), true, "her own record matches case-insensitively");
  assert.equal(
    see("HR Business Partner", "HR-999"),
    false,
    "another HR Business Partner is NOT her — the self match is by HR_ID, never by shared title",
  );

  // A company viewer is filtered by nothing at all.
  assert.equal(
    isPayslipRowVisibleToAudience({ kind: "company" }, { hrId: "AA", jobTitle: "CEO" }),
    true,
    "company scope must keep seeing every row",
  );

  // ── 3. The same rule on the Employee Directory's salary columns ────────────
  // Opened to her in the same breath, and it carries base/basic/gross/net columns — so without
  // this the payslip restriction would be undone by the screen next to it.
  const inAudience = (jobTitle: string, hrId = "A-99") =>
    matchesHrAdvisoryCompensationAudience({ hrId, jobTitle }, "HR-010");
  assert.equal(inAudience("Medical Representative"), true, "she sees a rep's pay in the directory too");
  assert.equal(inAudience("National Sales Manager"), false, "and not an NSM's, on either screen");
  assert.equal(inAudience("HR Business Partner", "HR-010"), true, "her own pay, in the directory too");

  // ── 4. The grants that were widened, and the one that was NOT ──────────────
  const advisoryGrants = hrBundleGrants("HR Advisory");
  assert.ok(advisoryGrants.contracts?.includes("read"), "Contract Renewal needs contracts:read");
  assert.ok(advisoryGrants.hr_calendar?.includes("read"), "Company Calendar needs hr_calendar:read");
  // Refused on 2026-08-28 and still refused: hr_calendar:update saves an HR decision on a Field
  // Workforce Compliance recommendation, the PATCH accepts payroll recommendations as well as leave
  // ones, and "may not approve salary changes" is a named boundary in her job description.
  assert.equal(
    advisoryGrants.hr_calendar?.includes("update"),
    false,
    "hr_calendar:update must stay refused — read is sight of the calendar, update decides payroll recommendations",
  );
  assert.equal(
    advisoryGrants.contracts?.includes("update"),
    false,
    "she advises on renewals and cannot change one — contract writes stay with HR Operations",
  );
  assert.equal(
    advisoryGrants.employees?.includes("update"),
    false,
    "the Employee Directory row moved to employees:read; the write grant must NOT have moved with it",
  );
  // The widening lives in workforce_insight, which HR Advisory alone holds. If it is ever moved to
  // a shared function, HR Operations silently gains it — this is the assertion that would notice.
  // Widened to HrFunctionKey deliberately: the bundle is a literal tuple, so TypeScript refuses
  // `.includes("workforce_insight")` on it outright. That refusal is the proof today — but it
  // disappears the moment someone adds the function, which is exactly when the check has to fire.
  // The runtime assertion is what survives that edit, so it is the one kept.
  assert.equal(
    (HR_ROLE_BUNDLES["HR Operations"] as readonly HrFunctionKey[]).includes("workforce_insight"),
    false,
    "workforce_insight must stay HR-Advisory-only, or the contracts/hr_calendar widening leaks",
  );

  // ── 5. Manager Engagement: a role set, amended for one seat only ───────────
  assert.equal(canViewManagerCvEngagement(viewer("HR Advisory")), true, "owner amendment 2026-09-01");
  assert.equal(
    canViewManagerCvEngagement(viewer("HR Operations", "HR-011")),
    false,
    "the amendment was HR Advisory alone — 'add HR' would have been the easy misreading",
  );
  assert.equal(canViewManagerCvEngagement(viewer("SFE Manager", "A-12")), false, "still NOT SFE");

  // ── 6. Every module he listed is now a row she is offered ──────────────────
  const rows = hrRowsFor("HR Advisory");
  const byHref = new Map(rows.map((row) => [row.href, row]));
  const required = [
    "/hr/employees",
    "/hr/reports/vacancies",
    "/hr/contracts",
    "/hr/probation",
    "/hr/probation/dashboard",
    "/hr/workspace/leave-management/vacation-request",
    "/hr/workspace/excuses",
    "/hr/admin/weekly-plans/calendar",
    "/hr/recruitment/manager-engagement",
    "/hr/hiring-documents",
    "/hr/hiring-pack",
    "/hr/recruitment",
    "/hr/recruitment/returned-cvs",
    "/hr/hr-calendar",
    "/hr/admin/payslips-center",
    "/hr/coaching/analytics",
    "/hr/admin/screening-questions",
  ];
  for (const href of required) {
    assert.ok(byHref.has(href), `${href} must be a row the HR Business Partner is offered`);
  }

  // ── 7. Where they were grouped ─────────────────────────────────────────────
  // The grouping is the half of the answer he asked to see before any of it was built, so a later
  // edit that scatters probation back across two sections should have to say so out loud.
  // Two sections, not one. They were briefly merged as "Performance & Probation"; the owner split
  // them the same day ("separate performance from probation"), so a later edit that quietly folds
  // them back together has to fail here rather than just look tidier in the file.
  assert.equal(byHref.get("/hr/probation")?.section, "Probation", "Probation moved out of People");
  assert.equal(byHref.get("/hr/probation/dashboard")?.section, "Probation");
  assert.equal(byHref.get("/hr/coaching")?.section, "Performance");
  assert.equal(byHref.get("/hr/coaching/analytics")?.section, "Performance");
  assert.equal(byHref.get("/hr/recruitment/returned-cvs")?.section, "Recruitment");
  assert.equal(byHref.get("/hr/admin/screening-questions")?.section, "Recruitment");
  assert.equal(byHref.get("/hr/recruitment/manager-engagement")?.section, "Recruitment");
  assert.equal(byHref.get("/hr/admin/weekly-plans/calendar")?.section, "Attendance & Calendars");
  assert.equal(byHref.get("/hr/hr-calendar")?.section, "Attendance & Calendars");
  assert.equal(byHref.get("/hr/admin/payslips-center")?.section, "Payroll");
  assert.equal(byHref.get("/hr/employees")?.section, "People");
  assert.equal(byHref.get("/hr/contracts")?.section, "People");

  // ── What the owner cut back out ───────────────────────────────────────────
  // Three rows reached her rail and were then removed on 2026-09-01: "I think there are irrelevant
  // modules... I don't want any crowd... remove them from this sidebar", and "I told you to remove
  // the workforce compliance. Remove it."
  //
  // All three are DELETED outright. The two recruitment rows were always safe to delete, because
  // `recruitment` is her grant alone and no other seat rendered them. Workforce Compliance was
  // first excluded BY ROLE instead — it gates on hr_calendar:read, which HR Operations holds
  // too, so deleting the line would have reached a seat the owner had not named — and then he
  // was asked and said "yes remove it". Section 8 below pins the Operations half.
  for (const href of [
    "/hr/recruitment/contact-review",
    "/hr/recruitment/intake-health",
    "/hr/admin/field-workforce-compliance",
  ]) {
    assert.equal(
      byHref.has(href),
      false,
      `${href} was cut from the HR Business Partner's sidebar on 2026-09-01 — do not re-add it`,
    );
  }

  // ── 8. What HR Operations must NOT have gained ────────────────────────────
  const operationsRows = new Set(hrRowsFor("HR Operations").map((row) => row.href));
  assert.equal(
    operationsRows.has("/hr/recruitment/manager-engagement"),
    false,
    "Manager Engagement must not appear for HR Operations",
  );
  assert.equal(
    operationsRows.has("/hr/admin/weekly-plans/calendar"),
    false,
    "the Planning Calendar is workforce_insight's, and Operations has no reason to read a rep's plan",
  );
  assert.ok(
    operationsRows.has("/hr/admin/payslips-center"),
    "the Payslips Center row must render for HR Operations too — she is the company-wide viewer",
  );
  // Workforce Compliance is gone for BOTH seats. It was excluded for Advisory alone first, since
  // hr_calendar:read is shared and deleting the line would have reached a seat the owner had not
  // named; he was then asked directly and said "yes remove it". Pinned for Operations as well so
  // that a later edit restoring the row has to justify it against the instruction, not just
  // against Advisory's half of it.
  assert.equal(
    operationsRows.has("/hr/admin/field-workforce-compliance"),
    false,
    "Workforce Compliance was removed from BOTH HR rails on 2026-09-01 — field-force compliance is not an HR seat's work",
  );
}
