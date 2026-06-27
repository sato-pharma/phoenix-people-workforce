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
 * Marketing Manager = employee-portal manager like PM/GPM with the same report/sidebar posture
 * as Group Product Manager and NO HR authority. This suite pins effective permissions,
 * commercial scope, marketing record visibility, weekly-sales tier, approver robustness,
 * ROI dashboard line-scoping, and navigation.
 */
export async function runMarketingManagerRoleTests() {
  const mm = createAccessContext({ hrId: "A-9", role: "Marketing Manager" });
  const gpm = createAccessContext({ hrId: "A-8", role: "Group Product Manager" });

  // ── Identity / base scope ───────────────────────────────────────────────────────────────────
  assert.equal(mm.role, "Marketing Manager");
  assert.equal(mm.scope, gpm.scope, "Marketing Manager base scope must mimic GPM");
  assert.equal(mm.scope, "line", "Marketing Manager is a line-scoped employee-portal manager");

  // ── Matrix honesty: granted (and surviving the hard boundary) ───────────────────────────────
  assert.equal(await canAccess(mm, "sales", "read"), true, "MM reads monthly Source-of-Sales");
  assert.equal(await canAccess(mm, "sales", "export"), true, "MM exports monthly sales");
  assert.equal(await canAccess(mm, "weekly_sales", "read"), true, "MM reads weekly sales");
  assert.equal(await canAccess(mm, "weekly_sales", "export"), true, "MM exports weekly sales");
  assert.equal(await canAccess(mm, "weekly_plans", "read"), true, "MM reads weekly plans");
  assert.equal(await canAccess(mm, "weekly_plans", "approve"), false, "MM does not get extra approval authority over GPM");
  assert.equal(await canAccess(mm, "expenses", "read"), true);
  assert.equal(await canAccess(mm, "expenses", "export"), true);
  assert.equal(await canAccess(mm, "payroll", "read"), true);
  assert.equal(await canAccess(mm, "leave", "read"), true);
  assert.equal(await canAccess(mm, "outstation", "create"), true);
  assert.equal(await canAccess(mm, "report_it", "create"), true);
  assert.equal(await canAccess(mm, "support_requests", "create"), true, "MM can raise support requests");
  assert.equal(await canAccess(mm, "coaching", "create"), false, "MM reads coaching analytics but does not create coaching reports");

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
  assert.equal(await canAccess(mm, "coaching", "read"), true, "MM reads Coaching Analytics");
  assert.equal(await canAccess(mm, "double_visit_analytics", "read"), true, "MM reads Double Visit Analytics");
  assert.equal(await canAccess(mm, "organogram", "read"), true, "MM sees line-scoped Organogram");
  assert.equal(await canAccess(mm, "probation", "read"), true, "MM sees line-scoped Probation");
  assert.equal(await canAccess(mm, "team", "read"), false);
  assert.equal(await canAccess(mm, "vacancies", "read"), true, "MM sees line-scoped Vacancies");

  // ── Per-domain scope: commercial = COMPANY, financial/HR = SELF ─────────────────────────────
  assert.equal(getSalesScope(mm), getSalesScope(gpm), "MM sales scope must mimic GPM");
  assert.equal(getSalesScope(mm), "LINE", "MM sees line-scoped monthly sales + ROI dashboard like GPM");
  assert.equal(getPayrollScope(mm), "SELF", "MM payroll/payslips stay self-scoped (intentional)");
  assert.equal(getExpensesScope(mm), "LINE", "MM expense dashboard aligns with PM/GPM line scope");

  // ── Navigation / landing ────────────────────────────────────────────────────────────────────
  // Reversed by the role-based Employee Portal landing redesign: MM now uses the portal shell
  // (its own dedicated dashboard) instead of the admin /workspace/marketing-requests/overview.
  assert.equal(resolveNavigationMode(mm), "employee-portal", "MM uses the employee portal like PM/GPM");
  assert.equal(
    resolveLandingPathForRole("Marketing Manager"),
    "/employee-portals",
    "MM lands on the portal command center (its own MM dashboard)",
  );

  // ── Structural guarantees (source-pinned, so refactors cannot silently regress them) ─────────
  const marketingService = source("src/lib/marketing-requests/service.ts");
  // 1. Company-wide marketing record visibility includes Marketing Manager (fixes the workspace,
  //    Customer Validation, ROI Tracking, and "see what I approved" blind spot). Anchored on the
  //    Marketing Manager + SFE Manager pair, which only appears in this company-visibility branch.
  assert.match(
    marketingService,
    /access\.role === "Marketing Manager" \|\|\s*access\.role === "SFE Manager"/,
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

  // 3. Weekly sales: Marketing Manager is product-scoped like GPM.
  const weeklyAccess = source("src/lib/sales/weekly/access.ts");
  assert.match(
    weeklyAccess,
    /const PRODUCT_SCOPED_ROLES[\s\S]{0,220}\]\)/,
    "PRODUCT_SCOPED_ROLES block must exist",
  );
  const productScopedBlock = weeklyAccess.slice(
    weeklyAccess.indexOf("PRODUCT_SCOPED_ROLES"),
    weeklyAccess.indexOf("PRODUCT_SCOPED_ROLES") + 260,
  );
  assert.match(
    productScopedBlock,
    /Marketing Manager/,
    "Marketing Manager must be product-scoped for weekly sales like GPM",
  );
  assert.doesNotMatch(
    weeklyAccess,
    /ctx\.role === "SFE Manager" \|\| ctx\.role === "Marketing Manager"/,
    "Marketing Manager must not keep a special full-access weekly branch",
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
    /p_lines:.*effectiveLines/,
    "ROI dashboard must inject the role-derived line filter into the RPC",
  );
}
