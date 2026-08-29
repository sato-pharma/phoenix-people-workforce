import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildPermissionLookup,
  canAccess,
  createAccessContext,
  getExpensesScope,
  getPayrollScope,
  getSalesScope,
  isAdminShellEmployeeRole,
  permissionMatrix,
  resolveNavigationMode,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import { adminNavigationSections } from "../src/config/system-navigation.ts";
import { getSections } from "../src/lib/navigation/active-path.ts";
import { resolveLandingPathForRole } from "../src/lib/auth/landing.ts";
import {
  canAccessAdminShellEmployeeWorkspacePage,
  workspaceMarketingRoles,
} from "../src/lib/workspace/admin-shell-employee-roles.ts";

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
  // These used to be regex matches over admin-shell-employee.ts, because that module imports
  // next/navigation and could not be loaded here. The role sets now live in their own pure module
  // (admin-shell-employee-roles.ts), so assert the real values instead of their spelling.
  assert.equal(
    canAccessAdminShellEmployeeWorkspacePage("Financial Advisor", workspaceMarketingRoles),
    true,
    "Financial Advisor reaches the workspace marketing inbox",
  );
  assert.equal(
    canAccessAdminShellEmployeeWorkspacePage("Finance Manager", workspaceMarketingRoles),
    true,
    "Finance Manager (finance fallback) also reaches the workspace marketing inbox",
  );

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
  // The routing is now read ONCE above the step loop, because the managerial chain has to know the
  // line's reviewer role before it walks (otherwise it mints a duplicate rung for that same seat —
  // see buildMarketingManagerChain's `rolesGatedLater`). The override itself is unchanged: a
  // marketing_review step still takes its reviewer from the line's routing row.
  assert.match(
    service,
    /step\.stepCode === "marketing_review" && reviewRouting \? reviewRouting\.reviewerRole : step\.assignedRole/,
    "the marketing_review reviewer is overridden per line",
  );
  assert.match(
    service,
    /const effectiveRole = effectiveStepRole\(step\);/,
    "the step loop takes its reviewer role from the hoisted per-line routing",
  );
  assert.match(
    service,
    /step\.stepCode === "marketing_review" && reviewRouting \? reviewRouting\.ccRoles : step\.ccRoles/,
    "the per-line routing still overrides the CC roles too",
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

  // ── The workspace marketing HOME is in the admin sidebar; the INBOX is deliberately not ────
  // This assertion has now been flipped three times, so it states the current decision and its date
  // rather than a bare expectation. Owner, 2026-08-30: "open the sidebar route" — the row's own
  // comment in src/config/system-navigation.ts carries the full history, including why neither
  // earlier removal recorded a product reason.
  //
  // The pairing is what matters and is why this lives here: the nav roles must equal the page
  // guard. The guard-level assertions above already pin that Financial Advisor / Finance Manager /
  // SFE Manager reach these pages; a sidebar row narrower than the guard is the gap #2713 closed,
  // and one wider is a button that redirects the viewer straight back out.
  const navSource = source("src/config/system-navigation.ts");
  assert.match(
    navSource,
    /href: "\/workspace\/marketing-requests",/,
    "the workspace marketing home IS linked from the admin sidebar (owner, 2026-08-30)",
  );
  // The /inbox sibling was removed in the same 2026-07-03 commit and the owner did NOT ask for it
  // back. It is a second queue for a decision the Marketing Inbox row already carries, so leaving
  // it out is the narrower reading of the instruction — deliberate, not an oversight.
  assert.doesNotMatch(
    navSource,
    /href: "\/workspace\/marketing-requests\/inbox"/,
    "the workspace marketing INBOX stays off the sidebar — only the home route was re-opened",
  );

  // The pairing above, asserted by BEHAVIOUR rather than by reading the roles array. Grepping the
  // config proves a row exists; it does not prove the right people see it, because visibility also
  // runs through resolveNavigationMode (a portal-mode role never sees the admin rail at all) and
  // through navigationItemVisible. Both sides are resolved here and compared as sets.
  //
  // A row NARROWER than the guard is the bug #2713 existed to close — a page reachable by nobody
  // reads exactly like a page nobody uses. A row WIDER than the guard is the other failure this
  // module has already paid for: a button that redirects the viewer straight back out.
  //
  // buildPermissionLookup, never a hand-rolled double loop over permissionResources:
  // tests/permission-lookup-totality.test.ts RATCHETS the number of hand-built copies in the tree
  // (20 when that guard was written) and this file was briefly the 21st. The shared builder is also
  // the only version guaranteed TOTAL — a lookup missing a key reads as fail-OPEN in
  // permissionAllowed, which would quietly widen the very thing this block is here to measure.
  const allRoles = Object.keys(permissionMatrix) as PhoenixRole[];
  const lookupFor = (role: PhoenixRole) => buildPermissionLookup(permissionMatrix, role);
  const seesRow = allRoles.filter((role) =>
    getSections(adminNavigationSections, "admin", lookupFor(role), role).some((section) =>
      section.items.some((item) => item.href === "/workspace/marketing-requests"),
    ),
  );
  // resolveNavigationMode asks about a VIEWER, not a role name — it reads .source and .scope as
  // well as .role, so it has to be handed a real context. A bare role string does not typecheck
  // (TS2345), and `pnpm run test` strips types, so nothing local can see that: only the PR's
  // typecheck job answers, which is exactly how this line first shipped red.
  const guardAdmits = allRoles.filter((role) => {
    const viewer = createAccessContext({ hrId: "NAV-1", role });
    return (
      canAccessAdminShellEmployeeWorkspacePage(role, workspaceMarketingRoles) &&
      resolveNavigationMode(viewer) === "admin"
    );
  });
  assert.deepEqual(
    [...seesRow].sort(),
    [...guardAdmits].sort(),
    "every admin-shell role the page admits must see the sidebar row, and no role that it rejects may",
  );
  // Pinned by NAME too, so a future widening of workspaceMarketingRoles cannot quietly move both
  // sides together and keep this test green while changing who reaches marketing execution.
  assert.deepEqual(
    [...seesRow].sort(),
    ["CEO", "Finance Manager", "Financial Advisor", "SFE Manager", "Super Admin"],
    "exactly five roles reach the marketing execution workspace from the sidebar",
  );
}
