import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  canAccess,
  createAccessContext,
  getExpensesScope,
  getPayrollScope,
  getSalesScope,
  isAdminShellEmployeeRole,
  resolveNavigationMode,
} from "../src/lib/auth/permissions.ts";
import { resolveLandingPathForRole } from "../src/lib/auth/landing.ts";

function source(relPath: string): string {
  return readFileSync(relPath, "utf8");
}

/**
 * Marketing requests: per-line review routing (Pedia → GPM, Anti Inf/CNS → Marketing Manager),
 * the non-blocking Product-Manager advisory comment, and the new Financial Advisor finance role.
 * Pins the role's scope and the structural wiring of the routing/comment/finance-fallback so a
 * refactor cannot silently regress them.
 */
export async function runMarketingReviewRoutingTests() {
  // ── Financial Advisor: admin-shell finance executor, tightly scoped ─────────────────────────
  const fa = createAccessContext({ hrId: "FA-1", role: "Financial Advisor" });
  assert.equal(fa.role, "Financial Advisor");
  assert.equal(isAdminShellEmployeeRole("Financial Advisor"), true, "Financial Advisor is an admin-shell role");
  assert.equal(resolveNavigationMode(fa), "admin", "Financial Advisor uses the admin shell, not the portal");
  assert.equal(resolveLandingPathForRole("Financial Advisor"), "/workspace/marketing-requests/inbox");
  const workspaceRolesSource = source("src/lib/workspace/admin-shell-employee.ts");
  assert.match(workspaceRolesSource, /workspaceMarketingRoles\s*=/, "workspaceMarketingRoles is defined");
  assert.match(workspaceRolesSource, /"Financial Advisor"/, "Financial Advisor reaches the workspace marketing inbox");
  assert.match(workspaceRolesSource, /"Finance Manager"/, "Finance Manager (finance fallback) also reaches the workspace marketing inbox");

  // Granted: own self-service + report-it. Denied: any HR / payroll / sales / employee authority.
  assert.equal(await canAccess(fa, "employee_profile", "read"), true);
  assert.equal(await canAccess(fa, "report_it", "create"), true);
  assert.equal(await canAccess(fa, "payslips", "read"), true);
  assert.equal(await canAccess(fa, "leave", "create"), true);
  assert.equal(await canAccess(fa, "employees", "read"), false);
  assert.equal(await canAccess(fa, "payroll", "read"), false);
  assert.equal(await canAccess(fa, "sales", "read"), false);
  assert.equal(await canAccess(fa, "recruitment", "read"), false);
  assert.equal(await canAccess(fa, "deductions", "read"), false);
  assert.equal(getSalesScope(fa), "NONE");
  assert.equal(getPayrollScope(fa), "SELF");
  assert.equal(getExpensesScope(fa), "SELF");

  // ── Marketing company-visibility + role-sets include Financial Advisor ──────────────────────
  const service = source("src/lib/marketing-requests/service.ts");
  assert.match(service, /companyMarketingRoles[\s\S]{0,220}"Financial Advisor"/, "Financial Advisor is a company marketing role");
  assert.match(service, /access\.role === "Financial Advisor"/, "canSeeMarketingHierarchyRecord grants Financial Advisor company visibility");

  // ── Per-line review routing wired into the chain builder ────────────────────────────────────
  assert.match(service, /loadMarketingReviewRoutingByLine/, "chain builder loads per-line review routing");
  assert.match(service, /from\("marketing_review_routing"\)/, "routing reads the marketing_review_routing table");
  assert.match(
    service,
    /step\.stepCode === "marketing_review"[\s\S]{0,300}routing\.reviewerRole/,
    "the marketing_review reviewer is overridden per line",
  );

  // ── Reviewer roles resolve deterministically (Pedia GPM + finance Financial Advisor) ─────────
  assert.match(service, /role === "Group Product Manager"/, "Group Product Manager resolves as a line-scoped reviewer");
  assert.match(service, /role === "Financial Advisor"/, "Financial Advisor resolves as a reviewer");
  assert.doesNotMatch(
    service,
    /stepKind === "finance"[\s\S]{0,200}roleName: "Finance Manager"/,
    "the finance step no longer falls back to Finance Manager — Financial Advisor is the direct executor",
  );

  // ── Non-blocking advisory comment ───────────────────────────────────────────────────────────
  assert.match(service, /export async function postMarketingAdvisoryComment/, "advisory-comment service exists");
  const commentBody = service.slice(service.indexOf("export async function postMarketingAdvisoryComment"));
  const commentFn = commentBody.slice(0, commentBody.indexOf("\n}\n") + 3);
  assert.match(commentFn, /\.eq\("is_cc", true\)/, "advisory comment only writes a CC row");
  assert.doesNotMatch(
    commentFn,
    /\.from\("marketing_requests"\)/,
    "advisory comment never touches the request status (only the CC step row)",
  );
  assert.match(
    source("app/api/marketing-requests/[id]/comment/route.ts"),
    /postMarketingAdvisoryComment/,
    "the comment API route calls the service",
  );
  // Inbox surfaces an advisory list separate from the gating decisions.
  assert.match(service, /advisoryRows/, "inbox exposes advisory (comment-only) rows");
  // The same comment box is reachable on the request detail/tracking view via a shared component.
  assert.match(service, /viewerCanComment/, "request detail computes viewer comment eligibility");
  assert.match(
    source("src/components/employee-portal/marketing-advisory-comment-box.tsx"),
    /\/api\/marketing-requests\/\$\{(?:encodeURIComponent\()?requestId\)?\}\/comment/,
    "the shared advisory comment box posts to the comment endpoint",
  );
  const draftsSource = source("src/components/employee-portal/marketing-request-drafts.tsx");
  assert.match(draftsSource, /detail\.viewerCanComment/, "the request detail view gates on viewerCanComment");
  assert.match(draftsSource, /MarketingAdvisoryCommentBox/, "the request detail view renders the advisory comment box");

  // ── Migration: routing seed + finance re-point ──────────────────────────────────────────────
  const migration = source("supabase/_migrations_archive/pre-baseline-2026-07-11/20260619130000_marketing_review_product_routing.sql");
  assert.match(migration, /create table if not exists public\.marketing_review_routing/);
  for (const lineName of ["Anti Inf", "CNS", "Pedia"]) {
    assert.match(migration, new RegExp(`'${lineName}'`), `routing seeds the ${lineName} line`);
  }
  assert.match(migration, /'Group Product Manager'/, "Pedia routes to the Group Product Manager");
  assert.match(migration, /assigned_role = 'Financial Advisor'/, "finance step re-points to Financial Advisor");
  assert.match(migration, /step_code = 'finance_execution'/, "finance re-point targets the finance_execution step");

  // ── Workspace marketing pages are reachable, but deliberately not in the admin sidebar ──────
  // Financial Advisor / Finance Manager / SFE Manager still land on and can use
  // /workspace/marketing-requests(/inbox) directly (guard-level access above is unchanged,
  // and Financial Advisor's landing path still points there) — the admin sidebar entries were
  // removed by explicit product decision, so this only pins their absence from the nav config.
  assert.doesNotMatch(
    source("src/config/system-navigation.ts"),
    /href: "\/workspace\/marketing-requests"/,
    "workspace marketing pages are not linked from the admin sidebar",
  );
}
