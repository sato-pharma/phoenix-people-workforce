import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  buildPermissionLookup,
  createAccessContext,
  permissionMatrix,
  phoenixRoles,
  systemAccessContext,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import {
  canOpenClosingPerformanceReview,
  canOpenPortalClosingPerformanceReview,
  CLOSING_PERFORMANCE_REVIEW_AUDIENCE_MESSAGE,
  performanceReviewSalesAction,
} from "../src/lib/sales/closing-performance-review-access.ts";
import {
  blankOut,
  isShellGated,
  permissionGateKeys,
  unreadableGatePredicates,
} from "./support/page-gate-reader.ts";

/**
 * 🔒 THE PERFORMANCE REVIEW EXPORT ADMITS EXACTLY WHO ITS PAGE ADMITS.
 *
 * Found 2026-09-16. POST /api/sales/monthly-closing/performance-review/export asked `sales:export`
 * and nothing else, then read the review company-wide — every line, every region, every rep — for
 * whatever month the body named, published or not. `sales:export` reaches down to Medical Rep, while
 * the page admits the Super Admin, system scope and the SFE Manager, so every other holder of the
 * permission could download the company-wide rep ranking the page refused to show them.
 *
 * The fix is one function, `canOpenClosingPerformanceReview`, asked by the page and by both routes
 * behind it. The routes cannot be called from here without reading production, so each is pinned by
 * where that question sits in its source: before the rate limit, the body and the load.
 *
 * 🔴 **A SECOND AUDIENCE ARRIVED ON 2026-10-13 AND THE DEFECT ABOVE IS EXACTLY WHAT IT COULD REVIVE.**
 * Each sales manager now reads this review BOUNDED to his own territory
 * (`canOpenPortalClosingPerformanceReview`), which means both routes must admit a caller the
 * unbounded gate refuses — and the whole danger is that such a caller reaches the UNBOUNDED loader.
 * So the shape pinned here is now two-part: neither gate admits ⇒ 403, and the unbounded
 * `loadClosingPerformanceReview` sits downstream of a branch on `isAdminAudience`, with the bounded
 * caller served by `loadScopedClosingPerformanceReview`, which resolves his scope from his own
 * access. The two audiences are asserted DISJOINT below, because one reader with two answers is the
 * same leak wearing a different hat.
 */

const ROOT = resolve(import.meta.dirname, "..");
const PAGE = "app/(admin)/sales/monthly-closing/performance-review/page.tsx";
const REVIEW_ROUTE = "app/api/sales/monthly-closing/performance-review/route.ts";
const EXPORT_ROUTE = "app/api/sales/monthly-closing/performance-review/export/route.ts";
/** The PAGE's own refusal — the admin shell admits the unbounded audience and nobody else. */
const GATE = "if (!canOpenClosingPerformanceReview(access)) {";
/** A ROUTE's refusal: neither audience admits this caller. */
const ROUTE_GATE = "if (!isAdminAudience && !canOpenPortalClosingPerformanceReview(access)) {";
/** Where a route branches, so the UNBOUNDED load can only be reached by the unbounded audience. */
const ROUTE_BRANCH = "isAdminAudience) {";

function read(file: string): string {
  return readFileSync(join(ROOT, file), "utf8");
}

/** Where `needle` first appears as CODE, never inside a comment or a string; -1 when it does not. */
function codeIndexOf(source: string, needle: string): number {
  const blanked = blankOut(source);
  let at = source.indexOf(needle);
  while (at >= 0 && blanked[at] !== source[at]) at = source.indexOf(needle, at + 1);
  return at;
}

function rolesHolding(key: string): PhoenixRole[] {
  return phoenixRoles.filter((role) => {
    const lookup: Record<string, boolean> = buildPermissionLookup(permissionMatrix, role);
    return Boolean(lookup[key]);
  });
}

export function runClosingPerformanceReviewExportGateTests() {
  const exporters = rolesHolding("sales:export");

  // ── The export asks who the caller is before it spends, reads or builds anything ─────────────
  const exportRoute = read(EXPORT_ROUTE);
  const exportGate = codeIndexOf(exportRoute, ROUTE_GATE);
  assert.ok(
    codeIndexOf(exportRoute, "canOpenClosingPerformanceReview(access)") > 0,
    `${EXPORT_ROUTE} no longer asks canOpenClosingPerformanceReview, so every holder of sales:export ` +
      `(${exporters.join(", ")}) can download the company-wide Performance Review its page refuses them`,
  );
  assert.ok(
    exportGate > 0,
    `${EXPORT_ROUTE} must refuse a caller neither audience admits, in one place: ${ROUTE_GATE}`,
  );
  const exportAccess = codeIndexOf(exportRoute, "resolveAccessContext(request)");
  assert.ok(exportAccess > 0 && exportAccess < exportGate, `${EXPORT_ROUTE} must resolve the caller before asking about them`);
  for (const step of [
    "assertExportRateLimit(",
    "request.json(",
    "loadClosingPerformanceReview(",
    "buildClosingPerformanceReviewWorkbook(",
  ]) {
    assert.ok(
      codeIndexOf(exportRoute, step) > exportGate,
      `${EXPORT_ROUTE} reaches ${step} before it refuses a caller the page refuses — the company-wide ` +
        "review must not be read, and no rate-limit slot spent, on anyone outside its audience",
    );
  }
  assert.match(
    exportRoute.slice(exportGate, codeIndexOf(exportRoute, "assertExportRateLimit(")),
    /return\s+Response\.json\(\s*\{\s*error:\s*CLOSING_PERFORMANCE_REVIEW_AUDIENCE_MESSAGE\s*\}\s*,\s*\{\s*status:\s*403\s*\}\s*\)/,
    "a refused caller gets a 403 carrying the plain-words audience message",
  );
  const exportLoad = codeIndexOf(exportRoute, "loadClosingPerformanceReview(");
  for (const permission of [
    'assertPermission(access, "sales", performanceReviewSalesAction(isAdminAudience))',
    'assertPermission(access, "sales", "export")',
  ]) {
    const at = codeIndexOf(exportRoute, permission);
    assert.ok(
      at > exportGate && at < exportLoad,
      `${EXPORT_ROUTE} must run ${permission} after the audience check and before the load — the file ` +
        "needs whatever its own audience needs to read the review on screen, plus its own export key",
    );
  }

  // ── The route the page re-reads from asks the same question ──────────────────────────────────
  const reviewRoute = read(REVIEW_ROUTE);
  const reviewGate = codeIndexOf(reviewRoute, ROUTE_GATE);
  const reviewLoad = codeIndexOf(reviewRoute, "loadClosingPerformanceReview(");
  assert.ok(
    codeIndexOf(reviewRoute, "canOpenClosingPerformanceReview(access)") > 0,
    `${REVIEW_ROUTE} must ask canOpenClosingPerformanceReview — sales:import names the same roles only ` +
      "while no override grants it to anyone else",
  );
  assert.ok(
    reviewGate > 0 && reviewGate < reviewLoad,
    `${REVIEW_ROUTE} must refuse a caller neither audience admits before it loads anything`,
  );

  // ── 🔴 A BOUNDED CALLER CANNOT REACH THE UNBOUNDED LOADER ────────────────────────────────────
  // Both routes now admit two audiences, so the gate alone no longer protects the company-wide read:
  // what protects it is that `loadClosingPerformanceReview` sits downstream of a branch on
  // `isAdminAudience`, with the other branch served by the scoped loader. Drop the branch and the
  // 2026-09-16 defect is back, this time for every sales manager rather than every exporter.
  for (const [file, source, unbounded] of [
    [EXPORT_ROUTE, exportRoute, exportLoad],
    [REVIEW_ROUTE, reviewRoute, reviewLoad],
  ] as const) {
    const gate = codeIndexOf(source, ROUTE_GATE);
    const branch = codeIndexOf(source, ROUTE_BRANCH);
    assert.ok(
      branch > gate && branch < unbounded,
      `${file} reaches loadClosingPerformanceReview without branching on isAdminAudience first — a sales ` +
        "manager would be served the whole line instead of his own territory",
    );
    const scoped = codeIndexOf(source, "loadScopedClosingPerformanceReview(");
    assert.ok(
      scoped > gate,
      `${file} must serve a bounded caller through loadScopedClosingPerformanceReview, which resolves his ` +
        "scope from his OWN access rather than from anything the request carries",
    );
  }
  assert.match(
    reviewRoute.slice(reviewGate, reviewLoad),
    /return\s+Response\.json\(\s*\{\s*error:\s*CLOSING_PERFORMANCE_REVIEW_AUDIENCE_MESSAGE\s*,\s*success:\s*false\s*\}\s*,\s*\{\s*status:\s*403\s*\}\s*\)/,
    "a refused reload gets a 403 carrying the plain-words audience message",
  );
  const reviewPermission = codeIndexOf(
    reviewRoute,
    'assertPermission(access, "sales", performanceReviewSalesAction(isAdminAudience))',
  );
  assert.ok(
    reviewPermission > reviewGate && reviewPermission < reviewLoad,
    `${REVIEW_ROUTE} must assert its audience's own sales action before loading anything`,
  );

  // ── The page is where the audience is read from, and nobody keeps a second copy of it ─────────
  const page = read(PAGE);
  const pageGate = codeIndexOf(page, GATE);
  const pageLoad = codeIndexOf(page, "loadClosingPerformanceReview(");
  assert.ok(pageGate > 0 && pageGate < pageLoad, `${PAGE} must refuse through canOpenClosingPerformanceReview before it loads`);
  assert.match(
    page.slice(pageGate, pageLoad),
    /redirect\(resolveLandingPathForRole\(access\.role\)\)/,
    "the page still sends a refused admin-shell visitor to their own landing page",
  );
  for (const [file, source] of [
    [PAGE, page],
    [REVIEW_ROUTE, reviewRoute],
    [EXPORT_ROUTE, exportRoute],
  ] as const) {
    assert.doesNotMatch(
      blankOut(source),
      /access\.(role|scope)\s*[!=]==/,
      `${file} compares access.role or access.scope itself. The audience lives in ` +
        "canOpenClosingPerformanceReview; a second copy in one caller is how the export drifted from its page",
    );
  }

  // ── Who that is ───────────────────────────────────────────────────────────────────────────────
  const admitted = phoenixRoles.filter((role) => canOpenClosingPerformanceReview(createAccessContext({ role })));
  assert.deepEqual(
    [...admitted].sort(),
    ["SFE Manager", "Super Admin"],
    `the Performance Review admits ${admitted.join(", ")} — its audience is the Super Admin and the SFE ` +
      "Manager (owner decision, 2026-08-05)",
  );
  assert.equal(canOpenClosingPerformanceReview(systemAccessContext), true, "system scope has always been admitted by the page");
  assert.equal(
    canOpenClosingPerformanceReview(createAccessContext({ role: "Super Admin", source: "guest" })),
    false,
    "a caller with no session is never admitted, whatever role name it carries",
  );
  for (const role of admitted) {
    const lookup: Record<string, boolean> = buildPermissionLookup(permissionMatrix, role);
    assert.ok(
      lookup[`sales:${performanceReviewSalesAction(true)}`] && lookup["sales:export"],
      `${role} is admitted but lacks sales:${performanceReviewSalesAction(true)} or sales:export, so the ` +
        "export would refuse its own audience",
    );
  }
  const refusedExporters = exporters.filter((role) => !admitted.includes(role));
  assert.ok(
    refusedExporters.includes("Medical Rep") && refusedExporters.length >= 5,
    `sales:export is held by ${exporters.join(", ")}. This test exists because that list reaches roles the ` +
      "page refuses; with Medical Rep gone or fewer than five of them left, re-measure what it guards",
  );
  for (const name of ["Super Admin", "SFE Manager", "sales manager"]) {
    assert.ok(CLOSING_PERFORMANCE_REVIEW_AUDIENCE_MESSAGE.includes(name), `the refusal names ${name} in plain words`);
  }

  // ── The BOUNDED audience, and that it shares nobody with the unbounded one ────────────────────
  const scopedAudience = phoenixRoles.filter((role) =>
    canOpenPortalClosingPerformanceReview(createAccessContext({ role })),
  );
  assert.deepEqual(
    [...scopedAudience].sort(),
    ["District Manager", "National Sales Manager", "Regional Manager"],
    `the scoped review admits ${scopedAudience.join(", ")} — the three territory tiers the owner named ` +
      "on 2026-10-13, each bounded to his own scope",
  );
  assert.ok(
    !scopedAudience.includes("Medical Rep"),
    "a Medical Rep is in neither audience: this sheet RANKS reps, which his own area bound withholds from him",
  );
  assert.deepEqual(
    scopedAudience.filter((role) => admitted.includes(role)),
    [],
    "the two audiences are disjoint — one reader must never be handed both the bounded and the unbounded answer",
  );

  // ── 🔴 EACH AUDIENCE MUST HOLD WHAT ITS OWN ROUTES ASSERT ─────────────────────────────────────
  //
  // The loop above has asked this of the unbounded audience since 2026-09-16, and it was not extended
  // when the second audience arrived — so the routes, cloned from the admin screen, asserted
  // `sales:import` for three roles that do not hold it. The page server-rendered on `sales:read` and
  // then every month change, every filter and every Export press came back 403. Fail-closed, but
  // broken for exactly the audience it was built for, and invisible to every other test here.
  for (const role of scopedAudience) {
    const lookup: Record<string, boolean> = buildPermissionLookup(permissionMatrix, role);
    const action = performanceReviewSalesAction(false);
    assert.ok(
      lookup[`sales:${action}`],
      `${role} reads the bounded review but lacks sales:${action}, which both routes assert for him — his ` +
        "page would render and then 403 on its first reload",
    );
    assert.ok(
      lookup["sales:export"],
      `${role} reads the bounded review but lacks sales:export, so his own Export button would refuse him`,
    );
  }
  assert.deepEqual(
    scopedAudience.filter((role) => {
      const lookup: Record<string, boolean> = buildPermissionLookup(permissionMatrix, role);
      return Boolean(lookup["sales:import"]);
    }),
    [],
    "none of the three holds sales:import — which is WHY the portal audience asserts sales:read. If a role " +
      "here ever gains sales:import, that is a matrix change to decide on its own, not a reason to unify the two",
  );

  // ── How the navigation guards read the page now ───────────────────────────────────────────────
  // It left the OR-chain list in page-gate-reader-role-inequality-gates.test.ts when its gate moved
  // into the shared function. The reader cannot evaluate that function, and must say so rather than
  // report no gate; the permission and shell gates beside it stay readable.
  assert.deepEqual([...permissionGateKeys(page)], ["sales:import"], `${PAGE} keeps a readable sales:import gate`);
  assert.equal(isShellGated(page), true, "portal roles are still sent to the employee portal first");
  assert.deepEqual(
    unreadableGatePredicates(page),
    ["canOpenClosingPerformanceReview"],
    "the reader reports the audience check as a gate it cannot evaluate, never as no gate at all",
  );
}
