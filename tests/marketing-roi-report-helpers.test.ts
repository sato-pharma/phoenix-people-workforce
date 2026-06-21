import assert from "node:assert/strict";

import type { AccessContext } from "../src/lib/auth/permissions.ts";
import {
  buildKpiBand,
  isRestrictedMarketingProduct,
  monthAdd,
  parseRoiFilterState,
  resolveRoiResultStatus,
  roiWindowLabel,
} from "../src/lib/marketing-requests/roi-report-service.ts";
import {
  computeMarketingFilterOptions,
  resolveMarketingRoiScope,
} from "../src/lib/marketing-requests/roi-report-scope.ts";
import {
  roiFilterStateFromParams,
  roiFilterStateHasAny,
  roiFilterStateToParams,
} from "../src/lib/marketing-requests/roi-filter-url.ts";
import { emptyRoiFilterState } from "../src/lib/marketing-requests/roi-report-types.ts";
import { STATEMENT_TIMEOUT_API_ERROR, isStatementTimeoutError } from "../src/lib/http/api-errors.ts";

export function runMarketingRoiReportHelpersTests() {
  // ── monthAdd: YYYY-MM arithmetic with year rollover ─────────────────────────
  assert.equal(monthAdd("2026-03", 0), "2026-03");
  assert.equal(monthAdd("2026-03", 2), "2026-05");
  assert.equal(monthAdd("2026-11", 3), "2027-02", "rolls over the year");
  assert.equal(monthAdd("2026-01", 11), "2026-12");
  assert.equal(monthAdd("2026-12", 1), "2027-01");

  // ── roiWindowLabel: pay date + duration → window + inclusive end period ──────
  assert.deepEqual(roiWindowLabel("2026-03-15", 3), { label: "2026-03 → 2026-05", endPeriod: "2026-05" });
  assert.deepEqual(roiWindowLabel("2026-03-01", 1), { label: "2026-03 → 2026-03", endPeriod: "2026-03" });
  assert.deepEqual(roiWindowLabel("2026-11-20", 4), { label: "2026-11 → 2027-02", endPeriod: "2027-02" });
  assert.deepEqual(roiWindowLabel(null, 3), { label: null, endPeriod: null });
  // a zero/garbage duration is clamped to a single month
  assert.equal(roiWindowLabel("2026-03-01", 0).endPeriod, "2026-03");

  // ── resolveRoiResultStatus: "actual vs required" verdict ─────────────────────
  // Complete window, met/exceeded required → on track.
  assert.equal(
    resolveRoiResultStatus({ salesRows: 4, actualValue: 1000, requiredRoiValue: 1000, salesDataComplete: true }),
    "on_track",
  );
  // Complete window, below required → behind.
  assert.equal(
    resolveRoiResultStatus({ salesRows: 4, actualValue: 600, requiredRoiValue: 1000, salesDataComplete: true }),
    "behind",
  );
  // Complete window, nothing attributed → no data.
  assert.equal(
    resolveRoiResultStatus({ salesRows: 0, actualValue: 0, requiredRoiValue: 1000, salesDataComplete: true }),
    "no_data",
  );
  // REGRESSION: incomplete window with partial sales below target must NOT be "behind".
  assert.equal(
    resolveRoiResultStatus({ salesRows: 2, actualValue: 300, requiredRoiValue: 1000, salesDataComplete: false }),
    "awaiting_data",
    "an in-progress campaign must not be flagged behind against its full required return",
  );
  // Incomplete window, no sales yet → awaiting data.
  assert.equal(
    resolveRoiResultStatus({ salesRows: 0, actualValue: 0, requiredRoiValue: 1000, salesDataComplete: false }),
    "awaiting_data",
  );
  // Already met the required return mid-window → on track even though the window is incomplete.
  assert.equal(
    resolveRoiResultStatus({ salesRows: 3, actualValue: 1200, requiredRoiValue: 1000, salesDataComplete: false }),
    "on_track",
  );

  // ── parseRoiFilterState: defensive parsing of an untrusted request body ──────
  const empty = parseRoiFilterState(null);
  assert.deepEqual(empty.dm, []);
  assert.equal(empty.includeRestricted, false);
  assert.equal(empty.payDateFrom, null);
  assert.equal(empty.durationMin, null);

  const parsed = parseRoiFilterState({
    dm: ["d-1", "d-2", 7],
    requestType: ["3", 5, "x"],
    status: ["approved", "pending_approval"],
    roiStatus: ["behind"],
    payDateFrom: "2026-01-01",
    payDateTo: "",
    durationMin: "3",
    durationMax: 6,
    includeRestricted: true,
    junk: "ignored",
  });
  assert.deepEqual(parsed.dm, ["d-1", "d-2", "7"], "coerces to strings, drops empties");
  assert.deepEqual(parsed.requestType, [3, 5], "numeric types only, drops NaN");
  assert.deepEqual(parsed.status, ["approved", "pending_approval"]);
  assert.deepEqual(parsed.roiStatus, ["behind"]);
  assert.equal(parsed.payDateFrom, "2026-01-01");
  assert.equal(parsed.payDateTo, null, "empty string → null");
  assert.equal(parsed.durationMin, 3);
  assert.equal(parsed.durationMax, 6);
  assert.equal(parsed.includeRestricted, true);
  assert.equal((parsed as Record<string, unknown>).junk, undefined, "unknown keys dropped");

  // ── URL codec: round-trips every dimension ──────────────────────────────────
  assert.equal(roiFilterStateHasAny(emptyRoiFilterState()), false);
  const rich = parseRoiFilterState({
    dm: ["d-1", "d-2"],
    nsm: ["b-157"],
    line: ["Anti Inf"],
    approvedBy: ["National Sales Manager", "SFE Manager"],
    requester: ["r-1"],
    status: ["approved", "pending_approval"],
    requestType: [1, 3],
    region: ["Delta"],
    distributor: ["IS", "EP"],
    product: ["GU001"],
    pharmacy: ["ph-1"],
    roiStatus: ["behind", "awaiting_data"],
    payDateFrom: "2026-01-01",
    payDateTo: "2026-06-30",
    durationMin: 3,
    durationMax: 9,
    includeRestricted: true,
  });
  assert.equal(roiFilterStateHasAny(rich), true);
  const restored = roiFilterStateFromParams(roiFilterStateToParams(rich));
  assert.deepEqual(restored, rich, "filter state survives a URL round-trip");

  // arrays use repeated keys; scalars omitted when unset
  const params = roiFilterStateToParams(rich);
  assert.deepEqual(params.getAll("dm"), ["d-1", "d-2"]);
  assert.deepEqual(params.getAll("requestType"), ["1", "3"]);
  assert.equal(params.get("includeRestricted"), "1");
  assert.equal(roiFilterStateToParams(emptyRoiFilterState()).toString(), "", "empty state → empty query");

  // ── confidential guard: marketing products use a DIFFERENT code namespace, so the
  //    NAME match is load-bearing (regression guard for the namespace bug). ──────────
  const restrictedNames = new Set(["satoslim", "lacto basic 1", "lacto basic 2"]);
  // name match wins even though the marketing code is a normal MKT_PRD#### (not LA003/SS001)
  assert.equal(isRestrictedMarketingProduct("MKT_PRD999", "Satoslim", restrictedNames), true);
  assert.equal(isRestrictedMarketingProduct("MKT_PRD050", "Lacto Basic 1", restrictedNames), true);
  // SoS code match still works (belt-and-suspenders)
  assert.equal(isRestrictedMarketingProduct("SS001", "Anything", restrictedNames), true);
  assert.equal(isRestrictedMarketingProduct("LA004", "", restrictedNames), true);
  // ordinary marketing product is NOT restricted
  assert.equal(isRestrictedMarketingProduct("MKT_PRD001", "Guamusin", restrictedNames), false);
  // empty name + non-restricted code → not restricted (no false positive)
  assert.equal(isRestrictedMarketingProduct("MKT_PRD002", "", restrictedNames), false);

  // ── empty-data path: a wiped ROI dataset must yield a CLEAN empty report (HTTP 200),
  //    never a thrown 500. Lock the two pure stages the report/options endpoints lean on. ──
  const companyAccess: AccessContext = {
    hrId: "AA",
    loginId: "aa",
    role: "CEO",
    scope: "system",
    source: "session",
  };
  const emptyScope = resolveMarketingRoiScope(companyAccess, []);
  assert.equal(emptyScope.isCompanyWide, true, "system scope is company-wide");
  const emptyOptions = computeMarketingFilterOptions(emptyScope, []);
  assert.equal(emptyOptions.visibleRequestCount, 0);
  assert.equal(
    emptyOptions.dimensions.every((dim) => dim.render === false),
    true,
    "no dimension renders when there are zero visible requests",
  );

  const emptyKpi = buildKpiBand([], null, 0);
  assert.equal(emptyKpi.requestCount, 0);
  assert.equal(emptyKpi.totalEstimatedCost, 0);
  assert.equal(emptyKpi.totalActualValue, 0);
  assert.equal(emptyKpi.coverageRatio, 0, "no divide-by-zero on an empty report");
  assert.equal(emptyKpi.onTrackCount, 0);
  assert.equal(emptyKpi.behindCount, 0);
  assert.equal(emptyKpi.awaitingDataCount, 0);
  assert.equal(emptyKpi.noDataCount, 0);
  assert.equal(emptyKpi.salesDataAsOf, null);

  // ── statement-timeout classifier: the recurring prod 500 was an unclassified SQLSTATE 57014
  //    (PostgREST surfaces it as a PLAIN object, not an Error). Map it to a clean 503. ──────────
  assert.equal(isStatementTimeoutError({ code: "57014", message: "canceling statement due to statement timeout" }), true);
  assert.equal(isStatementTimeoutError({ message: "canceling statement due to statement timeout" }), true);
  assert.equal(isStatementTimeoutError(new Error("canceling statement due to statement timeout")), true);
  assert.equal(isStatementTimeoutError(new Error("ERROR: canceling statement due to statement timeout")), true);
  // unrelated failures are NOT swallowed as timeouts
  assert.equal(isStatementTimeoutError(new Error("could not find the function in the schema cache")), false);
  assert.equal(isStatementTimeoutError({ code: "42P01", message: 'relation "x" does not exist' }), false);
  assert.equal(isStatementTimeoutError(null), false);
  assert.equal(STATEMENT_TIMEOUT_API_ERROR.status, 503, "timeout is a transient 503, never an opaque 500");
}
