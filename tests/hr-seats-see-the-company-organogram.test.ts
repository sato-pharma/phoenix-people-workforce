import { strict as assert } from "node:assert";

import {
  composeHrRoleGrants,
  HR_ROLE_BOUNDARIES,
  HR_ROLE_BUNDLES,
  type HrBundleName,
} from "../src/lib/auth/hr-functions.ts";
import {
  createAccessContext,
  permissionMatrix,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import {
  canAccessCompanyOrganogram,
  canAccessHeadOffice,
  isLineScopedOrganogramRole,
} from "../src/lib/reports/organogram.ts";

/**
 * BOTH new HR seats must see the WHOLE company organogram, Head Office included.
 *
 * Owner instruction, 2026-08-30: "the 2 new hrs should have the organogram full company appearing
 * 2 them." The two seats are HR Advisory (Aya Mohamed Mahmoud, HR-010, shown as HR Business
 * Partner) and HR Operations (Yasmine El Safoury, HR-009, HR Operations Coordinator).
 *
 * ## The bug this pins
 *
 * HR Operations was named in `canAccessCompanyOrganogram`, in `canAccessHeadOffice` AND in
 * `canViewOrganogramSensitiveFields` from the day the seat was composed — and held no
 * `organogram` grant at all, because the only HR function that granted one was
 * `workforce_insight`, which belongs to the other seat's bundle. So the SECOND gate was wide open
 * and the FIRST was shut: `/organogram` redirected her to `/employee-portals` and the sidebar
 * never offered her the link. Measured on the live matrix before the fix:
 * `permissionMatrix["HR Operations"].organogram` was `undefined`.
 *
 * That is the same two-gate trap `canAccessCompanyOrganogram` documents for the SFE Manager,
 * the Finance Manager and the District Manager — but running the other way round, which is why
 * none of the existing organogram tests caught it. Every one of them asks "does the report let
 * her through", and the report always did.
 *
 * ## Why the grant lives where it lives
 *
 * In `people_records`, not `workforce_insight`. Handing HR Operations the whole
 * `workforce_insight` function to get one resource would have dragged `weekly_plans` along, and
 * that function's own comment says in terms that it must not reach this seat.
 *
 * The read/write split is the point: both seats may LOOK at the structure and neither may change
 * it. `organogram:update` stays in HR_ROLE_BOUNDARIES for both, which is the owner's
 * never-change-the-skeleton rule, and Rules 4 and 5 of tests/hr-function-governance.test.ts
 * enforce it from the other side.
 */
export async function runHrSeatsCompanyOrganogramTests() {
  const seats = Object.keys(HR_ROLE_BUNDLES) as HrBundleName[];
  assert.deepEqual(
    [...seats].sort(),
    ["HR Administration", "HR Operations", "HR Resourcing"],
    "this test pins the three HR seats by name (HR Advisory was retired by the owner on 2026-10-08; " +
      "HR Administration was added 2026-10-20); a new seat needs its own decision, not a silent pass",
  );
  // HR Administration — the HR Operations Specialist seat, 2026-10-20. The owner's word for her was
  // "show organogram", with salary hidden. Same verdict as the other two: company mode, Head Office
  // kept (she is Head Office staff herself), and no power over the skeleton. The salary half is not
  // this test's — she is admitted to canViewOrganogramSensitiveFields for the personal and bank rows,
  // and the organogram employee routes pass omitSalary for isSalaryBlindRole, so no money row reaches her.
  // HR Resourcing — the Talent Acquisition seat, 2026-10-08. The owner ticked the Organogram for
  // her on the access blueprint: the company chart and its vacancies are what she recruits against.
  // Same verdict as the other two seats, so the loop below asks her every question it asks them —
  // company mode, Head Office kept, and no power over the skeleton.

  for (const seat of seats) {
    const role = seat as PhoenixRole;
    const access = createAccessContext({ hrId: `probe-${role}`, role });

    // --- Gate one: the permission matrix, which is what the page asserts first ------------------
    const granted = (permissionMatrix[role] as Record<string, string[] | undefined>).organogram;
    assert.ok(
      granted?.includes("read"),
      `${role} holds no organogram:read, so /organogram redirects her to /employee-portals and ` +
        "the sidebar hides the link — granted on paper everywhere below, still bounced in practice",
    );

    // ...and it must TRACE to a function, never sit in permissions.ts as a role literal. The
    // governance test says the matrix may only narrow the composition; this says the composition
    // is where the organogram grant actually comes from.
    const composed = composeHrRoleGrants(HR_ROLE_BUNDLES[seat]) as Record<string, string[] | undefined>;
    assert.ok(
      composed.organogram?.includes("read"),
      `${role}'s organogram:read does not come from an HR function. Add it to a function in ` +
        "hr-functions.ts so it traces to a job-description line.",
    );

    // --- Gate two: COMPANY mode, not a line slice ----------------------------------------------
    assert.equal(
      canAccessCompanyOrganogram(access),
      true,
      `${role} must read the organogram in company mode; getOrganogramReport answers ` +
        "company_scope_denied otherwise",
    );
    assert.equal(
      isLineScopedOrganogramRole(access),
      false,
      `${role} must not be line-scoped — a line fallback would render one sales line and read ` +
        "as the full company chart",
    );

    // --- Head Office, which is the half that silently disappears -------------------------------
    assert.equal(
      canAccessHeadOffice(access),
      true,
      `${role} must keep the Head Office rows; stripHeadOfficeRows removes them with no message, ` +
        "so the chart looks complete while her own department is missing from it",
    );

    // --- ...and no power over the skeleton ------------------------------------------------------
    assert.equal(
      granted?.includes("update") ?? false,
      false,
      `${role} must not hold organogram:update — a vacancy is a hire in progress and the ` +
        "skeleton is the Super Admin's intent alone",
    );
  }

  assert.ok(
    HR_ROLE_BOUNDARIES.some((entry) => entry.resource === "organogram" && entry.action === "update"),
    "organogram:update must stay in HR_ROLE_BOUNDARIES; without it the read grant above could be " +
      "widened to write and nothing would object",
  );
}
