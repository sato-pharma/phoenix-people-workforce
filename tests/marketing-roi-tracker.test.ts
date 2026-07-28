import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The ROI Tracker exists to END the "four surfaces, three engines, different answers" problem.
// Its whole value is that it COMPOSES the authoritative path rather than computing its own.
// These guards make that structural, not just intentional: if someone later adds an attribution
// query here, this file fails and the reviewer is forced to explain why a fifth engine is a good
// idea.

const SERVICE = "src/lib/marketing-requests/roi-tracker-service.ts";
const COMPONENT = "src/components/marketing-requests/marketing-roi-tracker.tsx";
const ROUTE = "app/api/marketing-requests/roi-tracker/route.ts";
const PAGE = "app/(admin)/admin/marketing-roi-tracker/page.tsx";

const source = (path: string) => readFileSync(path, "utf8");

/**
 * Strips line and block comments so a header that NAMES the engines this module deliberately
 * avoids (which is exactly the documentation we want) cannot trip the "must not call" guards
 * below. Same approach as tests/migrations-secdef-revoke-guard.test.ts.
 */
function code(path: string): string {
  return source(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
}

/** The service must delegate to the authoritative report, never re-derive attribution. */
function testTrackerAddsNoAttributionEngine() {
  const service = code(SERVICE);

  assert.match(
    service,
    /getMarketingRoiReport\s*\(/,
    "ROI Tracker must obtain its rows from getMarketingRoiReport (the authoritative engine)",
  );

  // No attribution RPCs. These are the four engines the module already had; the tracker must call
  // none of them directly.
  for (const rpc of [
    "phx_marketing_request_roi_actuals",
    "phx_marketing_roi_customer_dashboard",
    "phx_marketing_roi_fast",
    "phx_refresh_marketing_roi_facts",
  ]) {
    assert.doesNotMatch(
      service,
      new RegExp(rpc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `ROI Tracker must not call ${rpc} — it composes getMarketingRoiReport instead`,
    );
  }

  // No raw sales access: attribution belongs to the engine, not to this composition layer.
  for (const table of ["source_of_sales_import_rows", "marketing_roi_request_facts"]) {
    assert.doesNotMatch(
      service,
      new RegExp(table),
      `ROI Tracker must not read ${table} directly — that would be a second attribution path`,
    );
  }

  // It must not re-implement the verdict either; resultStatus arrives on the row.
  assert.doesNotMatch(
    service,
    /resolveRoiResultStatus\s*\(/,
    "ROI Tracker must inherit resultStatus from the report row, not recompute it",
  );
}

/** Access/masking must be inherited, never re-implemented. */
function testTrackerDoesNotReimplementAccess() {
  const service = code(SERVICE);
  const route = code(ROUTE);

  // The confidential-product decision is clamped inside getMarketingRoiReport. A local
  // includeRestricted/reveal decision here would be a second, weaker gate.
  assert.doesNotMatch(
    service,
    /RESTRICTED_PRODUCT_CODES|canViewRestrictedProducts/,
    "ROI Tracker must inherit confidential masking from getMarketingRoiReport",
  );

  // The route delegates; it must not carry its own role logic.
  assert.doesNotMatch(
    route,
    /assertMarketing\w*Access\s*\(|marketingCreatorRoles|companyMarketingRoles/,
    "the ROI Tracker route must delegate access to the service, not gate on its own role sets",
  );
  assert.match(route, /resolveAccessContext\s*\(/, "route must resolve the caller");
  assert.match(route, /getMarketingRoiTracker\s*\(/, "route must delegate to getMarketingRoiTracker");
}

/** Labels come from the shared module — a forked copy is what made Excel disagree with the screen. */
function testTrackerUsesCanonicalLabels() {
  const component = code(COMPONENT);
  assert.match(
    component,
    /ROI_RESULT_STATUS_LABEL/,
    "ROI Tracker must render verdicts via the shared ROI_RESULT_STATUS_LABEL map",
  );
  assert.doesNotMatch(
    component,
    /RESULT_LABELS\s*[:=]\s*\{/,
    "ROI Tracker must not declare its own verdict label map",
  );
  // All four verdicts must be representable, including awaiting_data.
  for (const verdict of ["on_track", "behind", "awaiting_data", "no_data"]) {
    assert.match(component, new RegExp(`\\b${verdict}\\b`), `ROI Tracker must handle the ${verdict} verdict`);
  }
}

/** The page must be reachable and must not repeat the CEO bounce that ROI Tracking has. */
function testTrackerPageIsReachable() {
  const page = code(PAGE);
  assert.match(page, /assertMarketingAdminPageAccess/, "page must be server-guarded");
  assert.match(page, /allowCompanyOversight:\s*true/, "page must admit company-oversight roles");
  assert.doesNotMatch(
    page,
    /redirect\(/,
    "ROI Tracker must not redirect the CEO away — that trap is what made the existing ROI Tracking unusable for them",
  );

  const nav = code("src/config/system-navigation.ts");
  assert.match(nav, /"\/admin\/marketing-roi-tracker"/, "ROI Tracker must have a navigation entry");
}

export function runMarketingRoiTrackerTests() {
  testTrackerAddsNoAttributionEngine();
  testTrackerDoesNotReimplementAccess();
  testTrackerUsesCanonicalLabels();
  testTrackerPageIsReachable();
}
