import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  canAccess,
  createAccessContext,
  getExpensesScope,
  getPayrollScope,
  getSalesScope,
  resolveNavigationMode,
} from "../src/lib/auth/permissions.ts";
import { resolveLandingPathForRole } from "../src/lib/auth/landing.ts";

function source(relPath: string): string {
  return readFileSync(relPath, "utf8");
}

/**
 * Marketing Manager = company-wide MARKETING + COMMERCIAL oversight, with NO field-management
 * tools and NO HR authority. This suite pins that identity end to end: effective permissions,
 * commercial scope, marketing record visibility, weekly-sales tier, approver robustness, the ROI
 * dashboard line-scoping, and navigation. It guards every dimension raised in the role remediation.
 */
export async function runMarketingManagerRoleTests() {
  const mm = createAccessContext({ hrId: "A-9", role: "Marketing Manager" });

  // ── Identity / base scope ───────────────────────────────────────────────────────────────────
  assert.equal(mm.role, "Marketing Manager");
  // Base context scope stays SELF (HR/payroll/expenses are self-bounded); commercial breadth comes
  // from the per-domain scope resolvers below, not from a blanket company scope.
  assert.equal(mm.scope, "self", "Marketing Manager keeps a self base scope");

  // ── Matrix honesty: granted (and surviving the hard boundary) ───────────────────────────────
  assert.equal(await canAccess(mm, "sales", "read"), true, "MM reads monthly Source-of-Sales");
  assert.equal(await canAccess(mm, "sales", "export"), true, "MM exports monthly sales");
  assert.equal(await canAccess(mm, "weekly_sales", "read"), true, "MM reads weekly sales");
  assert.equal(await canAccess(mm, "weekly_sales", "export"), true, "MM exports weekly sales");
  assert.equal(await canAccess(mm, "weekly_plans", "read"), true, "MM reads weekly plans");
  assert.equal(await canAccess(mm, "weekly_plans", "approve"), true, "MM approves weekly plans");
  assert.equal(await canAccess(mm, "expenses", "read"), true);
  assert.equal(await canAccess(mm, "expenses", "export"), true);
  assert.equal(await canAccess(mm, "payroll", "read"), true);
  assert.equal(await canAccess(mm, "leave", "read"), true);
  assert.equal(await canAccess(mm, "outstation", "create"), true);
  assert.equal(await canAccess(mm, "report_it", "create"), true);
  assert.equal(await canAccess(mm, "support_requests", "create"), true, "MM can raise support requests");

  // ── Matrix honesty: denied (boundary-stripped or never granted) ─────────────────────────────
  // These were previously DECLARED in the matrix but silently stripped by the hard boundary; the
  // declarations are now removed so the matrix reads as the true effective access. Behaviour pinned:
  assert.equal(await canAccess(mm, "support_requests", "read"), false, "MM is a sender, not HR support staff");
  assert.equal(await canAccess(mm, "employees", "read"), false, "MM holds no employee-directory authority");
  assert.equal(await canAccess(mm, "employee_documents", "read"), false);
  assert.equal(await canAccess(mm, "offers", "read"), false, "MM holds no HR/offers authority");
  assert.equal(await canAccess(mm, "recruitment", "read"), false);
  assert.equal(await canAccess(mm, "recruitment", "update"), false);
  assert.equal(await canAccess(mm, "candidates", "read"), false);
  // No field-management tools (kept deliberately narrow — marketing + commercial only):
  assert.equal(await canAccess(mm, "coaching", "read"), false, "MM is not a field-management role");
  assert.equal(await canAccess(mm, "double_visit_analytics", "read"), false);
  assert.equal(await canAccess(mm, "organogram", "read"), false);
  assert.equal(await canAccess(mm, "probation", "read"), false);
  assert.equal(await canAccess(mm, "team", "read"), false);
  assert.equal(await canAccess(mm, "vacancies", "read"), false);

  // ── Per-domain scope: commercial = COMPANY, financial/HR = SELF ─────────────────────────────
  assert.equal(getSalesScope(mm), "COMPANY", "MM sees company-wide monthly sales + ROI dashboard");
  assert.equal(getPayrollScope(mm), "SELF", "MM payroll/payslips stay self-scoped (intentional)");
  assert.equal(getExpensesScope(mm), "SELF", "MM expenses stay self-scoped (intentional)");

  // ── Navigation / landing ────────────────────────────────────────────────────────────────────
  assert.equal(resolveNavigationMode(mm), "admin", "MM is an admin-shell account, never the portal");
  assert.equal(
    resolveLandingPathForRole("Marketing Manager"),
    "/admin/marketing-requests",
    "MM lands in the admin marketing-requests shell",
  );

  // ── Structural guarantees (source-pinned, so refactors cannot silently regress them) ─────────
  const marketingService = source("src/lib/marketing-requests/service.ts");
  // 1. Company-wide marketing record visibility includes Marketing Manager (fixes the workspace,
  //    Customer Validation, ROI Tracking, and "see what I approved" blind spot). Anchored on the
  //    Finance Manager + Marketing Manager + SFE Manager triplet, which only appears in this
  //    company-visibility branch.
  assert.match(
    marketingService,
    /access\.role === "Finance Manager" \|\|\s*access\.role === "Marketing Manager" \|\|\s*access\.role === "SFE Manager"/,
    "canSeeMarketingHierarchyRecord must grant Marketing Manager company-wide visibility",
  );
  // 2. Company-wide singleton approver resolution is deterministic (never null-stalls on 2+ seats).
  assert.match(
    marketingService,
    /\[\.\.\.scoped\]\.sort\(\)\[0\]/,
    "roleApproverHrId must deterministically pick among multiple scoped company-role seats",
  );
  assert.match(
    marketingService,
    /\[\.\.\.candidates\]\.sort\(\)\[0\]/,
    "roleApproverHrId must deterministically pick among multiple company-role seats",
  );

  // 3. Weekly sales: Marketing Manager is NOT product-scoped and lands in the full-minus-restricted tier.
  const weeklyAccess = source("src/lib/sales/weekly/access.ts");
  assert.match(
    weeklyAccess,
    /const PRODUCT_SCOPED_ROLES[\s\S]{0,160}\]\)/,
    "PRODUCT_SCOPED_ROLES block must exist",
  );
  const productScopedBlock = weeklyAccess.slice(
    weeklyAccess.indexOf("PRODUCT_SCOPED_ROLES"),
    weeklyAccess.indexOf("PRODUCT_SCOPED_ROLES") + 200,
  );
  assert.doesNotMatch(
    productScopedBlock,
    /Marketing Manager/,
    "Marketing Manager must NOT be product-scoped for weekly sales",
  );
  assert.match(
    weeklyAccess,
    /ctx\.role === "SFE Manager" \|\| ctx\.role === "Marketing Manager"[\s\S]{0,120}tier: "full", canViewRestricted: false/,
    "Marketing Manager must get full weekly access minus restricted products",
  );

  // 4. Marketing ROI dashboard is line-scoped per role (closes PM/GPM/NSM company-wide over-exposure).
  const intelligenceService = source("src/lib/sales-marketing-intelligence/service.ts");
  assert.match(
    intelligenceService,
    /resolveDashboardLineScope/,
    "ROI dashboard must resolve a per-role line scope",
  );
  assert.match(
    intelligenceService,
    /p_lines: effectiveLines/,
    "ROI dashboard must inject the role-derived line filter into the RPC",
  );
}
