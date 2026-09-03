import assert from "node:assert/strict";

import { getNavigationSections } from "../src/config/system-navigation.ts";
import { getSections } from "../src/lib/navigation/active-path.ts";
import {
  buildPermissionLookup,
  canAccess,
  canSeeEmployee,
  createAccessContext,
  getPayrollScope,
  permissionMatrix,
  resolveNavigationMode,
  type AccessContext,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import {
  buildLinePickerOptions,
  filterOrganogramRows,
  type OrganogramRow,
} from "../src/lib/reports/organogram-view-model.ts";
import {
  canAccessCompanyOrganogram,
  canAccessHeadOffice,
  canViewOrganogramSensitiveFields,
} from "../src/lib/reports/organogram.ts";

/**
 * The Marketing Manager's company organogram must contain Head Office — the branch he sits in.
 *
 * Owner instruction, 2026-09-03: "marketing manager also", completing the sweep he opened the same
 * day with "the training manager ui want to make him able to see full company organogram" and
 * continued with "same thing for sfe manager".
 *
 * ## The defect, for the fifth and last time
 *
 * He has been named in `canAccessCompanyOrganogram` for as long as that helper has existed, and has
 * carried a portal sidebar row throughout, so the chart opened in COMPANY mode and looked complete.
 * `canAccessHeadOffice` did not name him, so `getOrganogramReport` dropped every line_id 4 row
 * before it rendered. Measured on production the day of the change: A-9 Hossam AboElftouh, line_id
 * 4, manager AA — so his "company" chart omitted himself, the CEO he reports to, and the three
 * people who report to HIM (A-7 Training Manager, A-8 GPM, A-10 PM). Same shape as the Finance
 * Manager (2026-08-10), A-3 (2026-09-02), and the Training and SFE Managers earlier the same day.
 *
 * ## Why this file exists SEPARATELY from the other two
 *
 * Two reasons, and both are load-bearing.
 *
 * Block 2 is the disclosure argument, and it is the SFE Manager's rather than the Training
 * Manager's. The Training Manager has an unconditional branch in `canSeeEmployee`, so every Head
 * Office record already opened for him and his grant changed which door, not what was behind it.
 * This seat has no such branch — and is not even in `canSeeDirectReportsByRole`, so `canSeeEmployee`
 * refuses him his OWN direct reports. Head Office names and reporting lines were genuinely new to
 * him here. Block 5 then records where the two new-disclosure seats differ from each other: unlike
 * the SFE Manager he holds `vacancies: ["read"]`, so the Vacancy Report follows the chart for him.
 *
 * Block 7 is the reason `getOrganogramReport`'s Head Office strip now carries an UNREACHABLE note.
 * With this seat cleared, `canAccessHeadOffice` and `canAccessCompanyOrganogram` name the SAME set
 * of roles, so that filter can no longer be true for anybody. Block 7 is what notices the day they
 * diverge again. Read its failure message before "fixing" it.
 */

const ctx = (role: string, scope: AccessContext["scope"] = "company"): AccessContext =>
  ({ hrId: "A-9", role, scope }) as unknown as AccessContext;

function row(overrides: Partial<OrganogramRow> = {}): OrganogramRow {
  return {
    areaId: null,
    areaName: null,
    departmentId: null,
    departmentName: "Sales",
    displayName: "Person",
    fullName: "Person",
    hireDate: null,
    hrId: "X-1",
    jobTitle: "Medical Rep",
    lineId: 1,
    lineName: "Pedia",
    managerHrId: null,
    managerName: null,
    positionId: null,
    positionTitle: "Medical Rep",
    regionName: null,
    type: "employee",
    ...overrides,
  } as OrganogramRow;
}

export async function runMarketingManagerHeadOfficeTests() {
  const marketingManager = createAccessContext({ hrId: "A-9", role: "Marketing Manager" });

  // ── 1. The three gates, in the order the page asks them ──────────────────────────────────────
  assert.equal(
    await canAccess(marketingManager, "organogram", "read"),
    true,
    "assertPermission is the FIRST gate on the portal page and on every /api/reports/organogram route",
  );
  assert.equal(
    canAccessCompanyOrganogram(marketingManager),
    true,
    "gate TWO — without company mode the portal page falls to redirect(\"/employee-portals\"), the " +
      "two-gate trap the SFE, Finance and District Managers each hit in turn",
  );
  assert.equal(
    canAccessHeadOffice(marketingManager),
    true,
    "gate THREE, the one this change adds: he IS Head Office (A-9, line_id 4, manager AA), so " +
      "without it getOrganogramReport strips his own branch and the chart still looks complete",
  );

  // ── 2. Why this was a REAL disclosure, as for the SFE Manager and unlike the Training Manager ─
  // These are the evidence for the paragraph in organogram.ts. Do not delete them: without this
  // block the next session reads the Training Manager's entry directly above his in that file and
  // concludes, wrongly, that every Head Office record already opened for this seat too.
  assert.equal(
    canSeeEmployee(marketingManager, { hrId: "A-2", managerHrId: "AA" }),
    false,
    "canSeeEmployee must NOT return true for a Head Office colleague. The Training Manager has an " +
      "unconditional branch here and the Marketing Manager does not — that difference is exactly " +
      "why his grant was a new disclosure and had to be described as one",
  );
  assert.equal(
    canSeeEmployee(marketingManager, { hrId: "A-7", managerHrId: "A-9" }),
    false,
    "…and not even for his OWN direct report: canSeeDirectReportsByRole names the DM, Manager, " +
      "Regional Manager and NSM only, so this seat falls through it. The chart is genuinely the " +
      "first surface that shows him the three people reporting to him",
  );
  assert.equal(
    canSeeEmployee(marketingManager, { hrId: "A-9", managerHrId: "AA" }),
    true,
    "…while he still resolves HIMSELF, so the two assertions above are a real boundary rather " +
      "than a helper that returns false for everybody",
  );
  assert.equal(
    getPayrollScope(marketingManager),
    "SELF",
    "his matrix payroll/payslips grants are bounced by getPayrollScope, so they were never a " +
      "pre-existing route to Head Office people either",
  );

  // ── 3. The branch survives the render chain ──────────────────────────────────────────────────
  // The gate alone was never enough: HR Advisory was granted Head Office on 2026-08-25 and still
  // saw four sales lines, because the portal picker's own filter runs AFTER the entitlement and
  // knows nothing about it. So assert the two view-model steps the page really calls.
  const rows = [
    row({ hrId: "B-1", lineId: 1, lineName: "Pedia" }),
    row({
      departmentName: "Head Office",
      hrId: "A-9",
      jobTitle: "Marketing Manager",
      lineId: 4,
      lineName: "Office",
      managerHrId: "AA",
      positionTitle: "Marketing Manager",
    }),
    row({
      departmentName: "Head Office",
      hrId: "A-7",
      jobTitle: "Training Manager",
      lineId: 4,
      lineName: "Office",
      managerHrId: "A-9",
      positionTitle: "Training Manager",
    }),
  ];
  const showHeadOffice =
    canAccessCompanyOrganogram(marketingManager) && canAccessHeadOffice(marketingManager);
  assert.equal(showHeadOffice, true, "the flag app/employee-portals/organogram/page.tsx sets");
  assert.equal(
    buildLinePickerOptions(rows, { includeHeadOffice: showHeadOffice }).some(
      (option) => option.trim().toLowerCase() === "office",
    ),
    true,
    "the picker must OFFER Head Office — a branch with no button is the 2026-08-25 bug, where the " +
      "rows reached the browser and were dropped by the last filter in the chain",
  );
  const officeRows = filterOrganogramRows(rows, "Office", "");
  assert.equal(
    officeRows.some((visible) => visible.hrId === "A-9"),
    true,
    "…and selecting it must render A-9's own row. He is the viewer: a chart that hides him is the " +
      "exact symptom the owner reported",
  );
  assert.equal(
    officeRows.some((visible) => visible.hrId === "A-7"),
    true,
    "…together with the report who hangs off him, or the branch is drawn without its own subtree",
  );
  assert.equal(
    buildLinePickerOptions(rows, { includeHeadOffice: false }).some(
      (option) => option.trim().toLowerCase() === "office",
    ),
    false,
    "the negative control — a viewer NOT cleared for Head Office is still offered only sales lines",
  );

  // ── 4. The chart, never the payroll behind it ────────────────────────────────────────────────
  assert.equal(
    canViewOrganogramSensitiveFields(marketingManager),
    false,
    "the Marketing Manager must NOT gain the Personal + Compensation sections of the node popup. " +
      "The owner asked for an org chart; salary and national ID are a separate, narrower allowlist",
  );

  // ── 5. The Vacancy Report DOES follow the chart for him ──────────────────────────────────────
  // This is where the two new-disclosure seats differ, and the asymmetry is deliberate rather than
  // an oversight in either direction. He holds `vacancies: ["read"]`, so getScopedVacancyReport's
  // Head Office mirror applies to him the way it does to the Training Manager; the SFE Manager has
  // no such key and is refused at assertPermission before that mirror is ever reached.
  assert.equal(
    await canAccess(marketingManager, "vacancies", "read"),
    true,
    "the Marketing Manager holds a vacancies grant, so the Head Office mirror in " +
      "getScopedVacancyReport is reachable for him — the note there says so and must stay true",
  );

  // ── 6. The scope shortcut must still fail loudly ─────────────────────────────────────────────
  // This seat was itself the guard until this change: every earlier comment pinned it to false at
  // company scope. With it cleared no NAMED role is left outside canAccessHeadOffice, so the guard
  // is synthetic — and stronger, because it no longer depends on any role's real scope. Collapse
  // that helper to `access.scope === "company"` and the first flips true and the second false.
  assert.equal(
    canAccessHeadOffice(ctx("National Sales Manager", "company")),
    false,
    "a role that was NOT named must still be refused even at company scope — the shortcut guard",
  );
  assert.equal(
    canAccessHeadOffice(ctx("National Sales Manager", "system")),
    true,
    "…and the same role at genuine system scope must pass, or the guard above would also hold for " +
      "a helper that had simply stopped working",
  );
  assert.equal(
    canAccessHeadOffice(createAccessContext({ hrId: "N-1", role: "National Sales Manager" })),
    false,
    "a line-scoped role at its REAL scope must never reach Head Office, even holding chain context",
  );
  // And the correction that made the two assertions above necessary: this seat's real scope is
  // `line`, not `company`. Every comment written for the Training and SFE Manager changes called it
  // "a company-scope role"; the company scope in those tests was always the ctx() helper's
  // synthetic default. Pinned so the wrong description cannot come back.
  assert.equal(
    createAccessContext({ hrId: "A-9", role: "Marketing Manager" }).scope,
    "line",
    "scopeForRole gives this seat LINE. It reaches a company chart by being NAMED in " +
      "canAccessCompanyOrganogram, never by its scope — which is why neither helper may ever be " +
      "rewritten as a scope check",
  );

  // ── 7. The two helpers now name the SAME set, and this is what notices when they diverge ─────
  // Read this before changing anything. The strip in getOrganogramReport
  // (`mode === "company" && !canAccessHeadOffice`) and its mirror in getScopedVacancyReport are
  // UNREACHABLE as of 2026-09-03 precisely because these two sets are identical, and both carry a
  // comment saying so. This assertion is the tripwire on that claim.
  //
  // If it fails, a role was added to canAccessCompanyOrganogram without Head Office. That may be
  // entirely correct — it is the case those two filters exist for, and they simply go live again.
  // The fix is then to update the UNREACHABLE notes in organogram.ts and record the new role HERE.
  // The fix is NOT to add the role to canAccessHeadOffice to make this green: that would hand a
  // department's names and reporting lines to a seat nobody cleared for them, which is the whole
  // failure mode the strip was written to prevent.
  const scopeIsolated = (role: PhoenixRole) => ctx(role, "company");
  const headOfficeOnly: string[] = [];
  const companyChartOnly: string[] = [];
  for (const role of Object.keys(permissionMatrix) as PhoenixRole[]) {
    const access = scopeIsolated(role);
    const headOffice = canAccessHeadOffice(access);
    const companyChart = canAccessCompanyOrganogram(access);
    if (headOffice && !companyChart) headOfficeOnly.push(role);
    if (companyChart && !headOffice) companyChartOnly.push(role);
  }
  assert.deepEqual(
    companyChartOnly,
    [],
    "a role reaches the COMPANY chart without Head Office clearance, so getOrganogramReport's " +
      `strip has gone live again for: ${companyChartOnly.join(", ")}. That is not automatically a ` +
      "bug — see the block comment above — but the UNREACHABLE notes in organogram.ts are now " +
      "false and must be corrected. Do NOT silence this by granting Head Office",
  );
  assert.deepEqual(
    headOfficeOnly,
    [],
    "a role holds Head Office clearance but cannot open a company chart, so the clearance does " +
      `nothing at all for: ${headOfficeOnly.join(", ")} — the two-gate trap, from the other side`,
  );
  // The comparison above is only meaningful if it actually ran over the roles in question.
  assert.equal(
    canAccessHeadOffice(scopeIsolated("Marketing Manager")) &&
      canAccessCompanyOrganogram(scopeIsolated("Marketing Manager")),
    true,
    "the sweep must include this seat on BOTH sides, or the deepEqual pair above passes vacuously",
  );
  assert.equal(
    canAccessHeadOffice(scopeIsolated("Medical Rep")) ||
      canAccessCompanyOrganogram(scopeIsolated("Medical Rep")),
    false,
    "…and must still exclude a role in NEITHER set, so it is comparing two real sets and not two " +
      "helpers that have both started returning true",
  );

  // ── 8. The sidebar row he opens it from ──────────────────────────────────────────────────────
  // He is a PORTAL role, not an admin one, so his door is /employee-portals/organogram. Asserting
  // the admin link would pass for the wrong reason — and in his case would not pass at all: the
  // admin entry carries excludedRoles: ["Marketing Manager"], deliberately, so that he has exactly
  // one Organogram link rather than two.
  assert.equal(
    resolveNavigationMode(marketingManager),
    "employee-portal",
    "if this ever flips to admin, the link asserted below is the wrong one",
  );
  const portalOffers = getSections(
    getNavigationSections("employee-portal"),
    "employee-portal",
    buildPermissionLookup(permissionMatrix, "Marketing Manager"),
    "Marketing Manager",
  ).some((section) =>
    section.items.some((item) => item.href === "/employee-portals/organogram"),
  );
  assert.equal(
    portalOffers,
    true,
    "the portal Organogram entry must keep listing Marketing Manager — an entitlement with no " +
      "link is a page he cannot find",
  );
  const adminOffers = getSections(
    getNavigationSections("admin"),
    "admin",
    buildPermissionLookup(permissionMatrix, "Marketing Manager"),
    "Marketing Manager",
  ).some((section) => section.items.some((item) => item.href === "/organogram"));
  assert.equal(
    adminOffers,
    false,
    "the admin Organogram entry excludes him by name, and clearing him for Head Office must not " +
      "have quietly handed him a second door into the same chart",
  );
}
