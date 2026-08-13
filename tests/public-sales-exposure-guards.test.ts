import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";

// Two unauthenticated-exposure regressions, pinned together because they share a root cause:
// sales figures escaping to an audience that was never access-checked.
//
// 1. public/incentive-race.html shipped in PR #608 as a "public game page" and was still being
//    served at the production root on 2026-08-13 -- HTTP 200, 690 KB, no session, no token. There
//    is no middleware.ts in this repo, so nothing gates public/. It carried 25 named medical reps
//    with HR_ID, territory, embedded photo and real achievement % (15%-181%). Nothing in src/ or
//    app/ ever linked to it, so it was invisible to every route-level access audit.
// 2. /api/sales/master-workbook/export builds a company-wide workbook whose Raw_Sales sheet is
//    every validated invoice row nationally -- customer name, address, quantity, net EGP -- with
//    NO access-scope narrowing inside the builder. Its only gate was assertPermission(sales,
//    export), and the base Employee and Medical Rep roles both hold sales: ["read", "export"].
//    The page that hosts the button was Super-Admin-gated; the route behind it was not.

const publicDir = new URL("../public/", import.meta.url);

const masterWorkbookRouteSource = readFileSync(
  new URL("../app/api/sales/master-workbook/export/route.ts", import.meta.url),
  "utf8",
);

/** A named person's achievement percentage, the shape the race page leaked. */
const achievementDataPattern = /achievement:\s*\d+/;

export function runPublicSalesExposureGuardsTests() {
  // --- 1. the specific file, by name -------------------------------------------------------
  assert.equal(
    existsSync(new URL("incentive-race.html", publicDir)),
    false,
    "public/incentive-race.html must stay deleted: anything under public/ is served unauthenticated, and this file held 25 named reps' HR_IDs, territories, photos and achievement percentages",
  );

  // --- 2. the class of mistake, not just the one file ---------------------------------------
  // A re-add under a different filename would be the same leak, so scan every served HTML page
  // rather than trusting one hardcoded name.
  for (const entry of readdirSync(publicDir)) {
    if (!entry.toLowerCase().endsWith(".html")) continue;
    const source = readFileSync(new URL(entry, publicDir), "utf8");
    assert.doesNotMatch(
      source,
      achievementDataPattern,
      `public/${entry} embeds per-person achievement figures. Files under public/ are served with no session and no token — employee performance data must come from an access-checked route instead`,
    );
  }

  // --- 3. the master workbook route keeps a role gate, not just a permission check -----------
  assert.match(
    masterWorkbookRouteSource,
    /access\.role !== "Super Admin"/,
    'master-workbook export must gate on the Super Admin role explicitly — assertPermission(sales, export) is NOT sufficient, because the base Employee and Medical Rep roles both hold sales:export',
  );
  assert.match(
    masterWorkbookRouteSource,
    /access\.scope !== "system"/,
    "master-workbook export must admit system scope alongside Super Admin, matching the page gate in app/(admin)/sales/database-mapping/page.tsx",
  );

  // Ordering matters more than presence: a gate that runs after the workbook is built has already
  // done the expensive national read, and a later edit could easily reorder these lines.
  const gateIndex = masterWorkbookRouteSource.indexOf('access.role !== "Super Admin"');
  const buildIndex = masterWorkbookRouteSource.indexOf("buildMasterWorkbookBuffer(");
  assert.ok(gateIndex !== -1 && buildIndex !== -1, "expected both the role gate and the workbook build call to be present");
  assert.ok(
    gateIndex < buildIndex,
    "the Super Admin gate must run BEFORE buildMasterWorkbookBuffer — otherwise the company-wide national read has already happened by the time the caller is rejected",
  );

  // The route must still return 403 rather than falling through to a generic error.
  assert.match(
    masterWorkbookRouteSource,
    /status:\s*403/,
    "a rejected master-workbook export must answer 403, not 200 with an empty workbook or a 500",
  );
}
