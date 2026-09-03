import assert from "node:assert/strict";

import { getNavigationSections } from "../src/config/system-navigation.ts";
import { getSections } from "../src/lib/navigation/active-path.ts";
import {
  buildPermissionLookup,
  canAccess,
  createAccessContext,
  permissionMatrix,
  type AccessContext,
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
  isHeadOfficeRow,
} from "../src/lib/reports/organogram.ts";

/**
 * The Training Manager's company organogram must contain Head Office — the branch he sits in.
 *
 * Owner instruction, 2026-09-03: "the training manager ui want to make him able to see full
 * company organogram."
 *
 * ## What was actually broken
 *
 * He was not missing the page. He has held `organogram: ["read"]` all along, has been named in
 * `canAccessCompanyOrganogram` and has carried a portal sidebar row since 2026-08-25 — so the
 * chart opened, in COMPANY mode, and looked complete. `canAccessHeadOffice` did not name him,
 * so `stripHeadOfficeRows` quietly removed line_id 4 before it rendered.
 *
 * Measured on production the day of the change: A-7 Ahmed Elkawas is himself line_id 4, manager
 * A-9. His "company" chart therefore omitted HIMSELF, his own manager (A-9, Marketing Manager)
 * and both peers reporting to that manager (A-8 GPM, A-10 PM). This is the third instance of one
 * defect — the Finance Manager (2026-08-10) and A-3 (2026-09-02) are the other two, and both
 * comments in organogram.ts describe it in the same words: the one part of the tree the viewer
 * sits in is the part that vanishes, and a chart missing a branch still looks like a whole chart.
 *
 * ## What must stay true
 *
 * Block 3 is the reason this is a chart change and not a payroll one, and block 4 is the guard
 * that this addition did not quietly become an `access.scope === "company"` shortcut — the thing
 * every comment in `canAccessHeadOffice` is written to refuse. By the end of 2026-09-03 no NAMED
 * role was left outside that helper (the SFE and Marketing Managers followed this one), so block 4
 * pins a SYNTHETIC context instead: an unnamed role at scope `company` refused, the same role at
 * scope `system` allowed.
 */

const ctx = (role: string, scope: AccessContext["scope"] = "company"): AccessContext =>
  ({ hrId: "A-7", role, scope }) as unknown as AccessContext;

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

export async function runTrainingManagerHeadOfficeTests() {
  const trainingManager = createAccessContext({ hrId: "A-7", role: "Training Manager" });

  // ── 1. All three gates, in the order the page asks them ──────────────────────────────────────
  assert.equal(
    await canAccess(trainingManager, "organogram", "read"),
    true,
    "assertPermission is the FIRST gate on the portal page and on every /api/reports/organogram " +
      "route — without organogram:read nothing below is reachable",
  );
  assert.equal(
    canAccessCompanyOrganogram(trainingManager),
    true,
    "gate TWO: without company mode the portal page falls to redirect(\"/employee-portals\") — " +
      "the two-gate trap the SFE, Finance and District Managers each hit in turn",
  );
  assert.equal(
    canAccessHeadOffice(trainingManager),
    true,
    "gate THREE, the one this change adds: he IS Head Office (A-7, line_id 4), so without it " +
      "stripHeadOfficeRows removes his own branch and the chart still renders as if complete",
  );

  // ── 2. The branch actually survives the render chain ─────────────────────────────────────────
  // The gate alone was never enough here: HR Advisory was granted Head Office on 2026-08-25 and
  // still saw four sales lines, because the picker's own filter runs AFTER the entitlement and
  // knows nothing about it. So assert the two view-model steps the page really calls.
  const rows = [
    row({ hrId: "B-1", lineId: 1, lineName: "Pedia" }),
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

  const showHeadOfficeLine =
    canAccessCompanyOrganogram(trainingManager) && canAccessHeadOffice(trainingManager);
  assert.equal(showHeadOfficeLine, true, "the flag app/employee-portals/organogram/page.tsx sets");

  const options = buildLinePickerOptions(rows, { includeHeadOffice: showHeadOfficeLine });
  assert.equal(
    options.some((option) => option.trim().toLowerCase() === "office"),
    true,
    "the picker must OFFER Head Office — a branch with no button is the 2026-08-25 bug, where " +
      "the rows reached the browser and were dropped by the last filter in the chain",
  );

  const officeRows = filterOrganogramRows(rows, "Office", "");
  assert.equal(
    officeRows.some((visible) => visible.hrId === "A-7"),
    true,
    "…and selecting it must render A-7's own row. He is the viewer: a chart that hides him is " +
      "the exact symptom the owner reported",
  );
  assert.equal(isHeadOfficeRow(rows[1]), true, "the row under test really is a Head Office row");

  // The negative control. Without it this block would pass just as well against a picker that
  // offers Head Office to everyone — the failure mode the line-picker test was written for.
  assert.equal(
    buildLinePickerOptions(rows, { includeHeadOffice: false }).some(
      (option) => option.trim().toLowerCase() === "office",
    ),
    false,
    "a viewer NOT cleared for Head Office must still be offered only the sales lines",
  );

  // ── 3. The chart, never the payroll behind it ────────────────────────────────────────────────
  assert.equal(
    canViewOrganogramSensitiveFields(trainingManager),
    false,
    "Training Manager must NOT gain the Personal + Compensation sections of the node popup. The " +
      "owner asked for an org chart; salary and national ID are a separate, narrower allowlist " +
      "(admins / HR / finance) and the \"no pay anywhere near an overview\" rule depends on it",
  );

  // ── 4. The scope shortcut must still fail loudly ─────────────────────────────────────────────
  // Marketing Manager was the last NAMED role outside canAccessHeadOffice, and was cleared later
  // the same day. With no named role left to pin, the guard is synthetic: an UNNAMED role carrying
  // scope `company` must be refused, and the same role at scope `system` must pass. Collapse the
  // helper to `access.scope === "company"` and the first flips true and the second false.
  assert.equal(
    canAccessHeadOffice(ctx("National Sales Manager", "company")),
    false,
    "a role that was NOT named must still be refused even at company scope — the shortcut guard",
  );
  assert.equal(
    canAccessHeadOffice(ctx("National Sales Manager", "system")),
    true,
    "…and the same role at genuine system scope must pass, or the guard above would also hold " +
      "for a helper that had simply stopped working",
  );
  assert.equal(
    canAccessHeadOffice(createAccessContext({ hrId: "N-1", role: "National Sales Manager" })),
    false,
    "a line-scoped role at its REAL scope must never reach Head Office, even holding chain context",
  );

  // ── 5. The sidebar row he opens it from ──────────────────────────────────────────────────────
  // buildPermissionLookup rather than a hand-rolled loop: a drifting copy fails OPEN, so an
  // absent link would read as false and this assertion would pass for the wrong reason.
  const offered = getSections(
    getNavigationSections("employee-portal"),
    "employee-portal",
    buildPermissionLookup(permissionMatrix, "Training Manager"),
    "Training Manager",
  ).some((section) => section.items.some((item) => item.href === "/employee-portals/organogram"));
  assert.equal(
    offered,
    true,
    "the portal Organogram entry in system-navigation.ts must keep listing Training Manager — " +
      "an entitlement with no link is a page he cannot find",
  );
}
