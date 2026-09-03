import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  canAccess,
  createAccessContext,
  getPayrollScope,
  getSalesScope,
  permissionMatrix,
  type AccessContext,
} from "../src/lib/auth/permissions.ts";
import { canViewAdminCoreAnalytics, canViewAdminDetailedAnalytics } from "../src/lib/analytics/portal-access.ts";
import { canAccessCompanyOrganogram, canAccessHeadOffice } from "../src/lib/reports/organogram.ts";
import { canManageCompanyCalendar, canPublishCompanyWide } from "../src/lib/calendar/logic.ts";
import { canExportPayslipDocument } from "../src/lib/payroll/payslip-center.ts";
import { canViewHeadOfficeLine, canViewRestrictedProducts } from "../src/lib/sales/access-scope.ts";

/**
 * Six modules granted to the Finance Manager (B-185) on 2026-08-10, ahead of handing the account to
 * a human for the first time.
 *
 * WHY A DEDICATED FILE. Five of the six needed MORE than a permission grant, and in every case the
 * "more" is a role allow-list somewhere else that does not honour `scope === "company"`. A grant
 * without its partner produces the repo's signature failure — authorised on paper, bounced or empty
 * in practice — and it is silent every time:
 *
 *   * `sales` without a getSalesScope arm  -> fail-closed EMPTY line/region sets, read downstream as
 *     "no rows". This exact pairing was granted and then REMOVED on 2026-08-10 for that reason.
 *   * `organogram` without canAccessCompanyOrganogram -> the page's second gate redirects him out.
 *     The SFE Manager hit this identical trap first; he is the second.
 *   * `resignations` alone is genuinely sufficient — isCompanyResignationReader already honours
 *     company scope — which is precisely why the others are worth asserting.
 *
 * Each assertion below names the failure it prevents, because "a boolean flipped" is not a useful
 * thing to read at 4am.
 */

const EXPORT_ROUTE = "app/api/sales/monthly-closing/export/route.ts";
const CLOSING_WORKSPACE_PAGE = "app/(admin)/sales/monthly-closing/page.tsx";
const ANALYTICS_HUB_PAGE = "app/(admin)/admin/analytics/page.tsx";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function ctx(role: AccessContext["role"]): AccessContext {
  return createAccessContext({ hrId: "B-185", role });
}

// A context whose SCOPE is stated rather than derived from the role. createAccessContext resolves
// scope through scopeForRole, which is exactly what the head-office guard below must not depend on:
// it has to ask "what happens to an unnamed role carrying scope `company`", and no real role
// carries that combination any more.
function scoped(role: AccessContext["role"], scope: AccessContext["scope"] = "company"): AccessContext {
  return { ...createAccessContext({ hrId: "B-185", role }), scope };
}

export async function runFinanceManagerSixModuleAccessTests() {
  const fm = ctx("Finance Manager");

  // ── 1. Monthly Closing: the grant and the scope are ONE change ───────────────────────────────
  // Asserted together, in one block, because separating them is not a style question — a `sales`
  // grant whose scope falls through to NONE is the bug that got the grant pulled earlier the same
  // day, and it presents as a confident empty table rather than an error.
  assert.equal(
    getSalesScope({ role: "Finance Manager" }),
    "COMPANY",
    "Finance Manager sales scope must be COMPANY. Without this arm getSalesScope returns NONE, " +
      "computeSalesAccessScope builds EMPTY allowed-line/region sets, and every closing and " +
      "Source-of-Sales query returns zero rows with no error — the exact 2026-08-10 regression.",
  );
  assert.equal(await canAccess(fm, "sales", "read"), true, "sales:read is the closing/SoS page gate");
  assert.equal(await canAccess(fm, "sales", "export"), true, "sales:export is what the XLSX route asserts");
  assert.equal(
    await canAccess(fm, "sales", "import"),
    false,
    "sales:import is the UPLOAD/PUBLISH key — it gates /sales/monthly-closing, /sales/upload and the " +
      "mapping database. He consumes the closing; he must never be able to produce or publish one.",
  );

  // ── 2. The full workbook branch ──────────────────────────────────────────────────────────────
  const exportSource = read(EXPORT_ROUTE);
  assert.ok(
    exportSource.includes('access.role === "Finance Manager"'),
    "the Monthly Closing export must admit Finance Manager into the FULL-workbook branch. Without it " +
      "he falls to the scoped branch, which is publication-gated: on an unpublished (line, period) it " +
      "silently returns a Data+Total-only workbook with HTTP 200 and nothing saying why.",
  );
  assert.ok(
    exportSource.includes('access.role === "Super Admin" || access.scope === "system" || access.role === "SFE Manager"'),
    "the first three terms of that disjunction are pinned as a literal by " +
      "tests/sfe-manager-nav-dead-links.test.ts — append to the end, never reorder",
  );
  assert.ok(
    !read(CLOSING_WORKSPACE_PAGE).includes('access.role === "Finance Manager"'),
    "the upload/publish workspace must NOT admit him — that page is Super Admin + SFE Manager, and " +
      "publishing a closing is not a finance-consumer act",
  );

  // ── 3. Analytics: core tier only ─────────────────────────────────────────────────────────────
  assert.equal(
    canViewAdminCoreAnalytics("Finance Manager"),
    true,
    "/admin/analytics/monthly-closing/details is the ONLY page that renders his Export XLSX button",
  );
  assert.equal(
    canViewAdminDetailedAnalytics("Finance Manager"),
    false,
    "Executive Comparison and Cross-Source Reconciliation stay CEO / Super Admin",
  );
  const analyticsHub = read(ANALYTICS_HUB_PAGE);
  assert.ok(
    analyticsHub.includes("SALES_ANALYTICS_SALES_RESOURCE_ROLES"),
    "the hub filters tiles by its OWN local list, not by canViewAdminCoreAnalytics — without a " +
      "sales-resource list he passes the page gate and sees zero cards",
  );
  assert.equal(
    await canAccess(fm, "weekly_sales", "read"),
    false,
    "he holds no weekly_sales grant, so the Weekly Analytics tile must never be offered to him — it " +
      "would 403 on arrival",
  );

  // ── 4. Restricted products stay locked (owner: keep confidential excluded) ───────────────────
  assert.equal(canViewRestrictedProducts("Finance Manager"), false, "LA003/LA004/SS001 stay CEO + Super Admin");
  assert.equal(canViewHeadOfficeLine("Finance Manager"), false, "the Head Office SALES line stays CEO + Super Admin");

  // ── 5. Organogram: BOTH gates, and the head-office split ─────────────────────────────────────
  assert.equal(await canAccess(fm, "organogram", "read"), true, "gate one: the matrix grant");
  assert.equal(
    canAccessCompanyOrganogram(fm),
    true,
    "gate two. The page has TWO gates and this is the second — with the grant alone he passes " +
      "canAccess and then hits the page's final redirect('/employee-portals'), granted on paper and " +
      "bounced in practice. The SFE Manager hit this identical trap in 2026-08.",
  );
  assert.equal(
    canAccessHeadOffice(fm),
    true,
    "owner decision: he IS head-office staff, so without this the company organogram he was granted " +
      "would hide his own department",
  );
  // The negative control. This is what fails if anyone re-implements the two functions above as
  // `access.scope === "company"` — the tempting one-liner that would hand Head Office to every
  // company-scope role at once.
  //
  // This was the SFE MANAGER's pair until 2026-09-03, then briefly the Marketing Manager's. The
  // owner cleared both that day, and with them no NAMED role is refused any more: since the
  // Marketing Manager went, canAccessHeadOffice and canAccessCompanyOrganogram name the same set.
  //
  // So the control is now synthetic and no longer depends on any role's real scope — an UNNAMED
  // role carrying scope `company` must still be refused. Collapse the helper to
  // `access.scope === "company"` and this flips true. (National Sales Manager's real scope is
  // `line`; the company scope below is constructed on purpose. That distinction matters: every
  // earlier version of this comment called Marketing Manager "a company-scope role", which
  // scopeForRole never agreed with.)
  assert.equal(
    canAccessHeadOffice(scoped("National Sales Manager")),
    false,
    "an unnamed role at scope `company` must NOT reach Head Office — this is the sharpest guard " +
      "against the two functions being collapsed into a scope check",
  );
  assert.equal(
    canAccessHeadOffice(scoped("National Sales Manager", "system")),
    true,
    "…and the same role at scope `system` must pass. The pair is the point: either assertion " +
      "alone would hold just as well for a helper that had stopped working entirely",
  );
  // Both are POSITIVES now, for the same reason as the Finance Manager above them: all three are
  // head-office staff whose company chart omitted the one branch they sit in.
  assert.equal(
    canAccessHeadOffice(ctx("SFE Manager")),
    true,
    "owner decision 2026-09-03 — he is Head Office (A-2, line_id 4, reporting to the CEO)",
  );
  assert.equal(
    canAccessHeadOffice(ctx("Marketing Manager")),
    true,
    "owner decision 2026-09-03 — he is Head Office too (A-9, line_id 4, reporting to the CEO)",
  );
  assert.equal(
    canAccessCompanyOrganogram(ctx("Marketing Manager")),
    true,
    "…and keeps the company view he already had",
  );
  assert.equal(canAccessCompanyOrganogram(ctx("SFE Manager")), true, "…and keeps the company view");
  // The retired Talent Acquisition seat WAS a second negative control here. The owner granted her
  // Head Office on 2026-08-25 (she recruits for it, and already browses the whole employee
  // directory), so it became a positive. That decision belongs to the DUTY, not the seat name, so
  // it carries to both successor bundles: HR Advisory recruits for Head Office, and HR Operations
  // holds its records. The Marketing Manager pair above now guards the scope-collapse shortcut.
  for (const role of ["HR Advisory", "HR Operations"] as const) {
    assert.equal(
      canAccessHeadOffice(ctx(role)),
      true,
      `owner decision 2026-08-25, inherited by ${role} — the Marketing Manager above remains the ` +
        "negative control that would fail if these two functions were collapsed into a scope check",
    );
  }

  // ── 6. Resignations: read, and only read ─────────────────────────────────────────────────────
  assert.equal(await canAccess(fm, "resignations", "read"), true, "company-wide via isCompanyResignationReader");
  for (const action of ["create", "update", "approve", "delete"] as const) {
    assert.equal(
      await canAccess(fm, "resignations", action),
      false,
      `resignations:${action} must stay absent — acting on a resignation also needs a Workflow ` +
        "Registry row and a canSeeEmployee company-scope branch, neither of which exists. Granting " +
        "the action alone would produce a visible button that 403s on every record but his own.",
    );
  }

  // ── 7. Company Calendar: reachable, but line-scoped ──────────────────────────────────────────
  assert.equal(canManageCompanyCalendar("Finance Manager"), true, "he creates events on his own line");
  assert.equal(
    canPublishCompanyWide("Finance Manager"),
    false,
    "he must NOT publish company-wide. This fires if anyone 'fixes' his line-scoping by adding him " +
      "to CALENDAR_ADMIN_ROLES, which would silently widen every event he creates to the whole company.",
  );

  // ── 8. Payslips: the document export, and who still cannot have it ───────────────────────────
  assert.equal(getPayrollScope(fm), "COMPANY", "the Payslips Center data gate — already true before this change");
  assert.equal(canExportPayslipDocument({ role: "Finance Manager" }), true, "owner decision, 2026-08-10");
  assert.equal(canExportPayslipDocument({ role: "Super Admin" }), true, "unchanged");
  assert.equal(
    canExportPayslipDocument({ role: "CEO" }),
    false,
    "the CEO reads the Payslips Center but must NOT carry the document out — this is the assertion " +
      "that fires if the predicate is widened to 'anyone who can open the page'",
  );
  for (const role of ["Financial Advisor", "HR Advisory", "HR Operations", "SFE Manager", "Employee"] as const) {
    assert.equal(canExportPayslipDocument({ role }), false, `${role} must not export payslip documents`);
  }

  // ── 9. Nothing leaked into the hard-boundary resources ───────────────────────────────────────
  // employees is hard-boundary-locked to Super Admin + Talent Acquisition and is override-proof;
  // asserting its absence here keeps "give him the fingerprint report" from ever being implemented
  // by widening that boundary instead of using the self-scoped workspace page.
  assert.equal(permissionMatrix["Finance Manager"].employees, undefined, "employees must stay absent");
  assert.equal(permissionMatrix["Finance Manager"].vacancies, undefined, "vacancies must stay absent");
  assert.equal(
    permissionMatrix["Finance Manager"].outstation,
    undefined,
    "outstation stays gone (owner, 2026-08-10) — this change must not quietly restore it",
  );
}
