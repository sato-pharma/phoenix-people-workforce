import assert from "node:assert/strict";

import {
  coverageFiltersFromSearchParams,
  coverageFiltersToSearchParams,
} from "../src/lib/marketing-requests/coverage-report-url-state.ts";
import { emptyMarketingCoverageFilterState } from "../src/lib/marketing-requests/roi-report-types.ts";
import type { MarketingCoverageFilterState } from "../src/lib/marketing-requests/roi-report-types.ts";

export function runMarketingCoverageUrlStateTests() {
  // ── Empty state serializes to no params, and deserializing empty params returns null
  //    (nothing to hydrate from — the caller falls back to its own default/preset logic).
  {
    const params = coverageFiltersToSearchParams(emptyMarketingCoverageFilterState());
    assert.equal(params.toString(), "");
    assert.equal(coverageFiltersFromSearchParams(new URLSearchParams()), null);
  }

  // ── Full round-trip: string arrays, status/roiStatus enums, requestType numbers,
  //    payDate/duration scalars, includeRestricted boolean.
  {
    const filters: MarketingCoverageFilterState = {
      ...emptyMarketingCoverageFilterState(),
      line: ["Anti Inf", "Pedia"],
      region: ["Delta"],
      area: ["Cairo"],
      requesterTier: ["Medical Rep"],
      status: ["approved", "active"],
      roiStatus: ["behind", "no_data"],
      requestType: [1, 2],
      payDateFrom: "2026-01-01",
      payDateTo: "2026-06-30",
      durationMin: 1,
      durationMax: 6,
      includeRestricted: true,
    };

    const params = coverageFiltersToSearchParams(filters);
    const roundTripped = coverageFiltersFromSearchParams(params);
    assert.ok(roundTripped);
    assert.deepEqual(roundTripped!.line, ["Anti Inf", "Pedia"]);
    assert.deepEqual(roundTripped!.region, ["Delta"]);
    assert.deepEqual(roundTripped!.area, ["Cairo"]);
    assert.deepEqual(roundTripped!.requesterTier, ["Medical Rep"]);
    assert.deepEqual(roundTripped!.status, ["approved", "active"]);
    assert.deepEqual(roundTripped!.roiStatus, ["behind", "no_data"]);
    assert.deepEqual(roundTripped!.requestType, [1, 2]);
    assert.equal(roundTripped!.payDateFrom, "2026-01-01");
    assert.equal(roundTripped!.payDateTo, "2026-06-30");
    assert.equal(roundTripped!.durationMin, 1);
    assert.equal(roundTripped!.durationMax, 6);
    assert.equal(roundTripped!.includeRestricted, true);

    // ── every other array-type dimension stays empty, never fabricated.
    assert.deepEqual(roundTripped!.dm, []);
    assert.deepEqual(roundTripped!.distributor, []);
  }

  // ── includeRestricted omitted entirely when false — never a stray "includeRestricted=0".
  {
    const params = coverageFiltersToSearchParams({ ...emptyMarketingCoverageFilterState(), line: ["Anti Inf"] });
    assert.equal(params.has("includeRestricted"), false);
  }

  // ── A URLSearchParams built by hand (simulating a pasted/shared link) round-trips too.
  {
    const params = new URLSearchParams();
    params.append("line", "CNS");
    params.append("requestType", "3");
    params.set("durationMin", "2");
    const parsed = coverageFiltersFromSearchParams(params);
    assert.ok(parsed);
    assert.deepEqual(parsed!.line, ["CNS"]);
    assert.deepEqual(parsed!.requestType, [3]);
    assert.equal(parsed!.durationMin, 2);
    assert.equal(parsed!.durationMax, null);
  }

  // ── Garbage requestType values are dropped, not NaN-injected.
  {
    const params = new URLSearchParams();
    params.append("requestType", "not-a-number");
    params.append("line", "CNS");
    const parsed = coverageFiltersFromSearchParams(params);
    assert.ok(parsed);
    assert.deepEqual(parsed!.requestType, []);
  }
}
