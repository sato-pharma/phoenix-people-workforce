import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

// The ROI Tracker exists to END the "four surfaces, three engines, different answers" problem.
// Its whole value is that it COMPOSES the authoritative path rather than computing its own.
// These guards make that structural, not just intentional: if someone later adds an attribution
// query here, this file fails and the reviewer is forced to explain why a fifth engine is a good
// idea.

const SERVICE = "src/lib/marketing-requests/roi-tracker-service.ts";
/**
 * BOTH tracker surfaces. They are deliberately shaped differently — the archive is a closed
 * post-mortem organised by outcome, the live one is a pipeline organised by lifecycle stage and by
 * the month a campaign becomes judgeable — but they share one service and must share one set of
 * verdict labels. Guarding only one of them would leave the other free to fork its labels, which
 * is precisely how the Excel export came to disagree with the screen in the first place.
 */
const COMPONENTS = [
  "src/components/marketing-requests/marketing-roi-tracker.tsx",
  "src/components/marketing-requests/marketing-roi-live-tracker.tsx",
];
const ROUTE = "app/api/marketing-requests/roi-tracker/route.ts";
const PAGE = "app/(admin)/admin/marketing-roi-tracker/page.tsx";

const source = (path: string) => readFileSync(path, "utf8");

/**
 * Strips line and block comments so a header that NAMES the engines this module deliberately
 * avoids (which is exactly the documentation we want) cannot trip the "must not call" guards
 * below.
 *
 * Via the shared reader rather than a local regex. One of the files read here is
 * `src/config/system-navigation.ts`, which quotes route patterns like `/admin/*`; the one-liner
 * this used to carry read that `*` as a comment opener and deleted 114,555 of the file's 217,431
 * characters. The navigation guard below was matching against under half the file. Full account:
 * tests/support/comment-strip.ts.
 */
function code(path: string): string {
  return stripComments(source(path));
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
  for (const path of COMPONENTS) {
    const component = code(path);
    assert.match(
      component,
      /ROI_RESULT_STATUS_LABEL/,
      `${path} must render verdicts via the shared ROI_RESULT_STATUS_LABEL map`,
    );
    assert.doesNotMatch(
      component,
      /RESULT_LABELS\s*[:=]\s*\{/,
      `${path} must not declare its own verdict label map`,
    );
    // All four verdicts must be representable, including awaiting_data.
    for (const verdict of ["on_track", "behind", "awaiting_data", "no_data"]) {
      assert.match(component, new RegExp(`\\b${verdict}\\b`), `${path} must handle the ${verdict} verdict`);
    }
  }
}

/**
 * The two surfaces must stay two surfaces. If the live tracker ever just renders the archive
 * component, the "separate modules" decision has silently been undone — and the live page would go
 * back to answering the archive's question ("what happened?") instead of its own ("when will I
 * know?").
 */
function testLiveAndArchiveStayDistinct() {
  const live = code("src/components/marketing-requests/marketing-roi-live-tracker.tsx");
  assert.doesNotMatch(
    live,
    /from\s+"@\/components\/marketing-requests\/marketing-roi-tracker"/,
    "the live tracker must not import the archive component — they are deliberately separate surfaces",
  );
  // Its signature move: the judgement clock. Losing this means it has drifted back into being a
  // copy of the outcome-bucket view.
  assert.match(live, /judgementMonth\s*\(/, "the live tracker must organise around when a request becomes judgeable");

  const archived = code("app/(admin)/admin/archived-marketing-requests/page.tsx");
  assert.match(
    archived,
    /origin="xlsx_import"/,
    "the archived page must stay pinned to imported requests",
  );
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
  testLiveAndArchiveStayDistinct();
}
