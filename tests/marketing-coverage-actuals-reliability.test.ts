import assert from "node:assert/strict";

import {
  findCoverageActualsGaps,
  narrowRequestsForFanOut,
} from "../src/lib/marketing-requests/coverage-report-service.ts";
import type { MappedRoiRequest } from "../src/lib/marketing-requests/roi-report-service.ts";
import type { MarketingRoiScope } from "../src/lib/marketing-requests/roi-report-types.ts";

function request(overrides: Partial<MappedRoiRequest>): MappedRoiRequest {
  return {
    id: "req-1",
    requestCode: "REQ-0001",
    requesterHrId: "R-1",
    managerHrId: "D-1",
    customerId: "cust-1",
    status: "approved",
    requestTypeId: 1,
    payDate: "2026-03-01",
    roiDurationMonths: 3,
    estimatedCost: 1000,
    expectedRoiValue: 9000,
    requiredRoiValue: 10000,
    ...overrides,
  };
}

function scope(overrides: Partial<MarketingRoiScope>): MarketingRoiScope {
  return {
    role: "District Manager",
    isCompanyWide: false,
    viewerHrId: "d-1",
    selfOnly: false,
    visibleRequesterHrIds: new Set<string>(),
    visibleDmHrIds: new Set<string>(),
    visibleNsmHrIds: new Set<string>(),
    visibleRsmHrIds: new Set<string>(),
    visibleLineNames: null,
    visibleProductCodes: null,
    visibleAreaIds: new Set<number>(),
    visibleAreaLineNames: new Set<string>(),
    visibleLineRouteNames: new Set<string>(),
    canRevealRestricted: false,
    ...overrides,
  };
}

export function runMarketingCoverageActualsReliabilityTests() {
  // ── findCoverageActualsGaps: ids present in the fact map are not "missing"; ids absent are.
  {
    const factByRequest = new Map([
      ["a", { value: 100, units: 5, salesRows: 2, quality: "exact_customer" }],
      ["b", { value: 0, units: 0, salesRows: 0, quality: "no_sales" }],
    ]);
    const missing = findCoverageActualsGaps(["a", "b", "c", "d"], factByRequest);
    assert.deepEqual(missing, ["c", "d"], "only ids absent from the fact map are reported missing");
  }

  // ── findCoverageActualsGaps: empty fact map → every id is missing.
  {
    const missing = findCoverageActualsGaps(["a", "b"], new Map());
    assert.deepEqual(missing, ["a", "b"]);
  }

  // ── findCoverageActualsGaps: every id present → nothing missing.
  {
    const factByRequest = new Map([["a", { value: 1, units: 1, salesRows: 1, quality: "exact_customer" }]]);
    assert.deepEqual(findCoverageActualsGaps(["a"], factByRequest), []);
  }

  // ── findCoverageActualsGaps: empty requestIds → empty result, never throws.
  assert.deepEqual(findCoverageActualsGaps([], new Map()), []);

  // ── narrowRequestsForFanOut: company-wide scope is never narrowed.
  {
    const requests = [request({ id: "a", requesterHrId: "R-1" }), request({ id: "b", requesterHrId: "R-2" })];
    const result = narrowRequestsForFanOut(requests, scope({ isCompanyWide: true, visibleRequesterHrIds: null }));
    assert.equal(result, requests, "company-wide scope returns the exact same array reference — never re-filtered");
  }

  // ── narrowRequestsForFanOut: PM/GPM scope (visibleRequesterHrIds null, visibleProductCodes
  //    set) is never narrowed here — product membership isn't known at this point.
  {
    const requests = [request({ id: "a" }), request({ id: "b" })];
    const result = narrowRequestsForFanOut(
      requests,
      scope({ isCompanyWide: false, visibleRequesterHrIds: null, visibleProductCodes: new Set(["GU001"]) }),
    );
    assert.equal(result, requests, "PM/GPM scope (product-based) must pass through unfiltered");
  }

  // ── narrowRequestsForFanOut: manager-chain scope narrows to exactly the visible requesters.
  {
    const requests = [
      request({ id: "a", requesterHrId: "R-1" }),
      request({ id: "b", requesterHrId: "R-2" }),
      request({ id: "c", requesterHrId: "R-3" }),
    ];
    const result = narrowRequestsForFanOut(
      requests,
      scope({ isCompanyWide: false, visibleRequesterHrIds: new Set(["r-1", "r-3"]) }),
    );
    assert.deepEqual(result.map((r) => r.id), ["a", "c"], "only requests whose requester is in the visible set survive");
  }

  // ── narrowRequestsForFanOut: comparison is normalized on BOTH sides (mixed case / whitespace),
  //    proving this JS-level pre-filter uses the exact same normalizeHrId semantics as the
  //    existing entries-loop filter it mirrors — never a stricter/looser comparison.
  {
    const requests = [request({ id: "a", requesterHrId: "  r-1  " }), request({ id: "b", requesterHrId: "R-2" })];
    const result = narrowRequestsForFanOut(
      requests,
      scope({ isCompanyWide: false, visibleRequesterHrIds: new Set(["r-1"]) }),
    );
    assert.deepEqual(result.map((r) => r.id), ["a"], "casing/whitespace drift is absorbed identically to the existing filter");
  }

  // ── narrowRequestsForFanOut: an empty visible set narrows to zero requests, not "everything".
  {
    const requests = [request({ id: "a" }), request({ id: "b" })];
    const result = narrowRequestsForFanOut(requests, scope({ isCompanyWide: false, visibleRequesterHrIds: new Set() }));
    assert.deepEqual(result, [], "an empty (but non-null) visible set must narrow to nothing, not fall through to unfiltered");
  }

  // ── narrowRequestsForFanOut: a National Sales Manager's LINE route (owner, 2026-10-20) is NOT
  //    pre-narrowed by requester. The route admits a Product Manager's campaign on his line, and the
  //    products that put it on his line are exactly what has not been fetched yet — narrowing here
  //    dropped it before the entries loop's line check could ever see it.
  {
    const requests = [
      request({ id: "subtree", requesterHrId: "D-1" }),
      request({ id: "pm-campaign", requesterHrId: "PM-1" }),
    ];
    const result = narrowRequestsForFanOut(
      requests,
      scope({
        role: "National Sales Manager",
        visibleRequesterHrIds: new Set(["d-1"]),
        visibleLineRouteNames: new Set(["anti inf"]),
      }),
    );
    assert.deepEqual(
      result.map((r) => r.id),
      ["subtree", "pm-campaign"],
      "a line-route viewer keeps every request for the fan-out; the entries loop decides by line",
    );
  }
}
