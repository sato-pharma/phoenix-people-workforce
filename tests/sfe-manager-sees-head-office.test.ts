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
} from "../src/lib/auth/permissions.ts";
import {
  buildLinePickerOptions,
  filterOrganogramRows,
  type OrganogramRow,
} from "../src/lib/reports/organogram-view-model.ts";
import {
  canAccessHeadOffice,
  canAccessCompanyOrganogram,
  canViewOrganogramSensitiveFields,
} from "../src/lib/reports/organogram.ts";

/**
 * The SFE Manager's company organogram must contain Head Office — the branch he sits in.
 *
 * Owner instruction, 2026-09-03: "same thing for sfe manager", immediately after the Training
 * Manager change of the same day.
 *
 * ## The defect, for the fourth time
 *
 * He has held `organogram: ["read"]` and a place in `canAccessCompanyOrganogram` since 2026-08-02,
 * so the chart opened in COMPANY mode and looked complete. `canAccessHeadOffice` did not name him,
 * so `getOrganogramReport` dropped every line_id 4 row before it rendered. Measured on production:
 * A-2 Khaled Bedair, line_id 4, manager AA — so his "company" chart omitted himself and the CEO he
 * reports to. Same shape as the Finance Manager (2026-08-10), A-3 (2026-09-02) and the Training
 * Manager (earlier the same day).
 *
 * ## Why this test exists SEPARATELY from training-manager-sees-head-office
 *
 * The two changes look identical and are not, and block 2 is the whole reason this file is here.
 * The Training Manager's grant was argued as "which door, not what is behind it" — he has an
 * unconditional branch in `canSeeEmployee`, so every Head Office record already opened for him.
 * The SFE Manager has NO such branch, and `getPayrollScope` returns SELF for him, so Head Office
 * names and reporting lines were genuinely NEW to him here. Block 2 pins both of those facts so a
 * future session cannot copy the Training Manager's justification onto this seat and conclude the
 * disclosure was pre-existing. If either assertion in block 2 starts failing, the REASONING in
 * organogram.ts is out of date — check it before changing the numbers.
 */

const ctx = (role: string, scope: AccessContext["scope"] = "company"): AccessContext =>
  ({ hrId: "A-2", role, scope }) as unknown as AccessContext;

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

export async function runSfeManagerHeadOfficeTests() {
  const sfe = createAccessContext({ hrId: "A-2", role: "SFE Manager" });

  // ── 1. The three gates, in the order the page asks them ──────────────────────────────────────
  assert.equal(
    await canAccess(sfe, "organogram", "read"),
    true,
    "assertPermission is the FIRST gate on every /api/reports/organogram route",
  );
  assert.equal(
    canAccessCompanyOrganogram(sfe),
    true,
    "gate TWO, held since 2026-08-02 — without it the page redirects and the grant does nothing",
  );
  assert.equal(
    canAccessHeadOffice(sfe),
    true,
    "gate THREE, the one this change adds: he IS Head Office (A-2, line_id 4, manager AA), so " +
      "without it getOrganogramReport strips his own branch and the chart still looks complete",
  );

  // ── 2. Why this was a REAL disclosure, unlike the Training Manager ───────────────────────────
  // Do not delete these two. They are the evidence for the paragraph in organogram.ts that tells
  // the next session this seat could NOT be argued as "which door, not what is behind it".
  assert.equal(
    canSeeEmployee(sfe, { hrId: "A-9", managerHrId: "AA" }),
    false,
    "canSeeEmployee must NOT return true for a Head Office colleague. The Training Manager has an " +
      "unconditional branch here and the SFE Manager does not — that difference is exactly why " +
      "his grant was a new disclosure and had to be described as one",
  );
  assert.equal(
    canSeeEmployee(sfe, { hrId: "A-2", managerHrId: "AA" }),
    true,
    "…while he still resolves HIMSELF, so the assertion above is a real boundary rather than a " +
      "helper that returns false for everybody",
  );
  assert.equal(
    getPayrollScope(sfe),
    "SELF",
    "his matrix payroll/payslips grants are bounced by getPayrollScope, so they were never a " +
      "pre-existing route to Head Office people either",
  );

  // ── 3. The branch survives the render chain ──────────────────────────────────────────────────
  const rows = [
    row({ hrId: "B-1", lineId: 1, lineName: "Pedia" }),
    row({
      departmentName: "Head Office",
      hrId: "A-2",
      jobTitle: "Sfe Manager",
      lineId: 4,
      lineName: "Office",
      managerHrId: "AA",
      positionTitle: "SFE Manager",
    }),
  ];
  const showHeadOffice = canAccessCompanyOrganogram(sfe) && canAccessHeadOffice(sfe);
  assert.equal(showHeadOffice, true, "the flag the organogram pages set from the entitlement");
  assert.equal(
    buildLinePickerOptions(rows, { includeHeadOffice: showHeadOffice }).some(
      (option) => option.trim().toLowerCase() === "office",
    ),
    true,
    "the picker must OFFER Head Office — a branch with no button is the 2026-08-25 bug",
  );
  assert.equal(
    filterOrganogramRows(rows, "Office", "").some((visible) => visible.hrId === "A-2"),
    true,
    "…and selecting it must render A-2's own row; he is the viewer",
  );
  assert.equal(
    buildLinePickerOptions(rows, { includeHeadOffice: false }).some(
      (option) => option.trim().toLowerCase() === "office",
    ),
    false,
    "the negative control — without the entitlement only the sales lines are offered",
  );

  // ── 4. The chart, never the payroll behind it ────────────────────────────────────────────────
  assert.equal(
    canViewOrganogramSensitiveFields(sfe),
    false,
    "the SFE Manager must NOT gain the Personal + Compensation sections of the node popup. The " +
      "owner asked for an org chart; salary and national ID are a separate, narrower allowlist",
  );

  // ── 5. The Vacancy Report does NOT follow the chart for him ──────────────────────────────────
  // It does for the Training Manager, and that asymmetry is deliberate rather than an oversight:
  // this seat holds no `vacancies` key at all, so both vacancy routes refuse it at assertPermission
  // before getScopedVacancyReport's Head Office mirror is reached. Pinned so nobody "fixes" the
  // inconsistency by granting the key.
  assert.equal(
    await canAccess(sfe, "vacancies", "read"),
    false,
    "the SFE Manager holds no vacancies grant — clearing him for Head Office must not have handed " +
      "him the Vacancy Report as a side effect",
  );

  // ── 6. The scope shortcut must still fail loudly ─────────────────────────────────────────────
  // The Marketing Manager was cleared later the same day, leaving NO named role outside
  // canAccessHeadOffice. The guard is therefore synthetic in this file too: an unnamed role
  // carrying scope `company` must be refused, the same role at scope `system` must pass.
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

  // ── 7. The sidebar row he opens it from ──────────────────────────────────────────────────────
  // He is an ADMIN-mode role, not a portal one, so his door is /organogram and not
  // /employee-portals/organogram. Asserting the wrong one would pass for the wrong reason.
  assert.equal(
    resolveNavigationMode(sfe),
    "admin",
    "if this ever flips to employee-portal, the link asserted below is the wrong one",
  );
  const offered = getSections(
    getNavigationSections("admin"),
    "admin",
    buildPermissionLookup(permissionMatrix, "SFE Manager"),
    "SFE Manager",
  ).some((section) => section.items.some((item) => item.href === "/organogram"));
  assert.equal(
    offered,
    true,
    "the admin Organogram entry must keep offering the SFE Manager a link — an entitlement with " +
      "no link is a page he cannot find",
  );
}
