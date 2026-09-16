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
  CLOSING_PERFORMANCE_REVIEW_AUDIENCE_MESSAGE,
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
 */

const ROOT = resolve(import.meta.dirname, "..");
const PAGE = "app/(admin)/sales/monthly-closing/performance-review/page.tsx";
const REVIEW_ROUTE = "app/api/sales/monthly-closing/performance-review/route.ts";
const EXPORT_ROUTE = "app/api/sales/monthly-closing/performance-review/export/route.ts";
const GATE = "if (!canOpenClosingPerformanceReview(access)) {";

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
  const exportGate = codeIndexOf(exportRoute, GATE);
  assert.ok(
    exportGate > 0,
    `${EXPORT_ROUTE} no longer asks canOpenClosingPerformanceReview, so every holder of sales:export ` +
      `(${exporters.join(", ")}) can download the company-wide Performance Review its page refuses them`,
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
  for (const permission of ['assertPermission(access, "sales", "import")', 'assertPermission(access, "sales", "export")']) {
    const at = codeIndexOf(exportRoute, permission);
    assert.ok(
      at > exportGate && at < exportLoad,
      `${EXPORT_ROUTE} must run ${permission} after the audience check and before the load — the page ` +
        "shows the review only with sales:import, and the file is an export",
    );
  }

  // ── The route the page re-reads from asks the same question ──────────────────────────────────
  const reviewRoute = read(REVIEW_ROUTE);
  const reviewGate = codeIndexOf(reviewRoute, GATE);
  const reviewLoad = codeIndexOf(reviewRoute, "loadClosingPerformanceReview(");
  assert.ok(
    reviewGate > 0 && reviewGate < reviewLoad,
    `${REVIEW_ROUTE} must ask canOpenClosingPerformanceReview before it loads — sales:import names the ` +
      "same two roles only while no override grants it to anyone else",
  );
  assert.match(
    reviewRoute.slice(reviewGate, reviewLoad),
    /return\s+Response\.json\(\s*\{\s*error:\s*CLOSING_PERFORMANCE_REVIEW_AUDIENCE_MESSAGE\s*,\s*success:\s*false\s*\}\s*,\s*\{\s*status:\s*403\s*\}\s*\)/,
    "a refused reload gets a 403 carrying the plain-words audience message",
  );
  const reviewImport = codeIndexOf(reviewRoute, 'assertPermission(access, "sales", "import")');
  assert.ok(reviewImport > reviewGate && reviewImport < reviewLoad, `${REVIEW_ROUTE} keeps its sales:import check`);

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
      lookup["sales:import"] && lookup["sales:export"],
      `${role} is admitted but lacks sales:import or sales:export, so the export would refuse its own audience`,
    );
  }
  const refusedExporters = exporters.filter((role) => !admitted.includes(role));
  assert.ok(
    refusedExporters.includes("Medical Rep") && refusedExporters.length >= 5,
    `sales:export is held by ${exporters.join(", ")}. This test exists because that list reaches roles the ` +
      "page refuses; with Medical Rep gone or fewer than five of them left, re-measure what it guards",
  );
  for (const name of ["Super Admin", "SFE Manager"]) {
    assert.ok(CLOSING_PERFORMANCE_REVIEW_AUDIENCE_MESSAGE.includes(name), `the refusal names ${name} in plain words`);
  }

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
