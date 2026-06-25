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
 * Marketing Manager = company-wide MARKETING + COMMERCIAL executive. It additionally holds
 * company-wide READ-ONLY oversight of the field/commercial reports PM/GPM/TM see (coaching,
 * double-visit, organogram, vacancies, probation), but NO write authority on coaching and NO HR
 * authority. This suite pins that identity end to end: effective permissions, commercial + report
 * scope, marketing record visibility, weekly-sales tier, approver robustness, the ROI dashboard
 * line-scoping, and navigation. It guards every dimension raised in the role remediation.
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

  // ── HR authority stays DENIED (hard boundary holds, even for the executive role) ─────────────
  assert.equal(await canAccess(mm, "support_requests", "read"), false, "MM is a sender, not HR support staff");
  assert.equal(await canAccess(mm, "employees", "read"), false, "MM holds no employee-directory authority");
  assert.equal(await canAccess(mm, "employee_documents", "read"), false);
  assert.equal(await canAccess(mm, "offers", "read"), false, "MM holds no HR/offers authority");
  assert.equal(await canAccess(mm, "recruitment", "read"), false);
  assert.equal(await canAccess(mm, "recruitment", "update"), false);
  assert.equal(await canAccess(mm, "candidates", "read"), false);

  // ── Executive READ oversight: mirrors PM/GPM/TM report data (company-wide, VIEW-only) ────────
  assert.equal(await canAccess(mm, "coaching", "read"), true, "MM has company-wide coaching VIEW");
  assert.equal(await canAccess(mm, "coaching", "create"), false, "MM coaching is read-only (no write)");
  assert.equal(await canAccess(mm, "coaching", "update"), false, "MM coaching is read-only (no write)");
  assert.equal(await canAccess(mm, "double_visit_analytics", "read"), true, "MM reads double-visit analytics");
  assert.equal(await canAccess(mm, "double_visit_analytics", "export"), true);
  assert.equal(await canAccess(mm, "team", "read"), true, "MM has team read");
  assert.equal(await canAccess(mm, "organogram", "read"), true, "MM has organogram read");
  assert.equal(await canAccess(mm, "probation", "read"), true, "MM has probation read");
  assert.equal(await canAccess(mm, "vacancies", "read"), true, "MM has vacancies read");

  // ── Per-domain scope: commercial = COMPANY, financial/HR = SELF ─────────────────────────────
  assert.equal(getSalesScope(mm), "COMPANY", "MM sees company-wide monthly sales + ROI dashboard");
  assert.equal(getPayrollScope(mm), "SELF", "MM payroll/payslips stay self-scoped (intentional)");
  assert.equal(getExpensesScope(mm), "COMPANY", "MM sees company-wide expenses (manages PM/GPM/TM team)");

  // ── New report scope is COMPANY-WIDE (executive), source-pinned so refactors can't regress ───
  const coachingService = source("src/lib/coaching/service.ts");
  assert.match(
    coachingService,
    /coachingOversightRoles = new Set<[^>]*>\(\[[\s\S]{0,160}"Marketing Manager"/,
    "coachingOversightRoles must include Marketing Manager (company-wide coaching VIEW)",
  );
  const probationService = source("src/lib/probation/service.ts");
  assert.match(
    probationService,
    /canViewAllProbation[\s\S]{0,260}access\.role === "Marketing Manager"/,
    "canViewAllProbation must admit Marketing Manager (company-wide probation VIEW)",
  );
  const organogramService = source("src/lib/reports/organogram.ts");
  assert.match(
    organogramService,
    /canAccessCompanyOrganogram[\s\S]{0,600}access\.role === "Marketing Manager"/,
    "canAccessCompanyOrganogram must admit Marketing Manager (company-wide organogram + vacancies)",
  );
  const doubleVisitService = source("src/lib/double-visit-analytics/service.ts");
  assert.match(
    doubleVisitService,
    /resolveDoubleVisitAccessScope[\s\S]{0,600}access\.role === "Marketing Manager"/,
    "resolveDoubleVisitAccessScope must admit Marketing Manager (company-wide double-visit VIEW)",
  );

  // ── Navigation / landing ────────────────────────────────────────────────────────────────────
  assert.equal(resolveNavigationMode(mm), "admin", "MM is an admin-shell account, never the portal");
  assert.equal(
    resolveLandingPathForRole("Marketing Manager"),
    "/workspace/marketing-requests/overview",
    "MM lands on its at-a-glance marketing Overview dashboard",
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

  // 3. Weekly sales: Marketing Manager is NOT product-scoped and lands in the full-minus-restricted tier.
  const weeklyAccess = source("src/lib/sales/weekly/access.ts");
  assert.match(
    weeklyAccess,
    /ctx\.role === "SFE Manager" \|\| ctx\.role === "Marketing Manager"[\s\S]{0,120}tier: "full", canViewRestricted: false/,
    "Marketing Manager must get full weekly access minus restricted products",
  );

  // 3b. Weekly sales: Product / Group Product Manager are line-scoped (their whole line), never
  // narrowed by the per-person weekly_sales_product_scope sheet — that table is opt-in for OTHER
  // roles only (e.g. a curated SFE Manager list).
  assert.match(
    weeklyAccess,
    /const LINE_SCOPED_ROLES[\s\S]{0,40}"Product Manager"[\s\S]{0,40}"Group Product Manager"/,
    "PM/GPM must be in LINE_SCOPED_ROLES (whole line, not the curated product sheet)",
  );
  assert.match(
    weeklyAccess,
    /LINE_SCOPED_ROLES\.has\(ctx\.role\)[\s\S]{0,300}tier: "territory", allowedLineNames: scope\.allowedLineNames, allowedRegionCodes: null/,
    "PM/GPM must resolve to the territory tier bounded to their line with no region restriction",
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
    /p_lines: (?:params\.)?effectiveLines/,
    "ROI dashboard must inject the role-derived line filter into the RPC",
  );

  // 5. Monthly Sales portal: Product / Group Product Manager are NEVER product-scoped — they see
  // their whole line, same as National Sales Manager.
  const monthlyClosingPortal = source("src/lib/sales/monthly-closing-portal.ts");
  assert.doesNotMatch(
    monthlyClosingPortal,
    /PRODUCT_SCOPED_CLOSING_ROLES/,
    "Monthly Sales portal must not product-scope any role (PM/GPM see their whole line)",
  );
}
