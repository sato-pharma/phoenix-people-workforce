import assert from "node:assert/strict";

import {
  computeFacetedCoverageDimensions,
  entryMatchesCoverageFilters,
  pruneCoverageFilterState,
} from "../src/lib/marketing-requests/coverage-report-facets.ts";
import { emptyMarketingCoverageFilterState } from "../src/lib/marketing-requests/roi-report-types.ts";
import type {
  CoverageFilterDimension,
  MarketingCoverageFilterKey,
  MarketingCoverageRequestIndexEntry,
} from "../src/lib/marketing-requests/roi-report-types.ts";

function entry(overrides: Partial<MarketingCoverageRequestIndexEntry>): MarketingCoverageRequestIndexEntry {
  return {
    requestId: "r", requestCode: "REQ", requesterHrId: "r1", requesterName: "Rep One", managerHrId: null,
    status: "approved", requestTypeId: 1, requestTypeName: "Doctor", payDate: "2026-03-01", roiDurationMonths: 3,
    lineName: "Pedia", regionName: "Delta", areaName: "Cairo", requesterTier: "Medical Rep",
    dmHrId: "d1", dmName: "DM One", nsmHrId: "n1", nsmName: "NSM One",
    rsmHrId: null, rsmName: null, approverRoleKeys: [], distributorCodes: ["IS"], productCodes: ["P1"],
    productNames: ["Prod 1"], pharmacyKeys: ["ph1"], pharmacyNames: ["Pharm 1"], hasRestrictedProduct: false,
    distributorWeights: [{ distributorCode: "IS", weight: 1 }],
    ...overrides,
  };
}

function dim(dims: CoverageFilterDimension[], key: MarketingCoverageFilterKey): CoverageFilterDimension {
  const found = dims.find((d) => d.key === key);
  assert.ok(found, `dimension ${key}`);
  return found as CoverageFilterDimension;
}

export function runMarketingCoverageFacetsTests() {
  const entries: MarketingCoverageRequestIndexEntry[] = [
    entry({ requestId: "a", areaName: "Cairo", requesterTier: "Medical Rep", nsmHrId: "n1", dmHrId: "d1", lineName: "Pedia", requesterHrId: "r1" }),
    entry({ requestId: "b", areaName: "Cairo", requesterTier: "District Manager", nsmHrId: "n1", dmHrId: "d2", lineName: "Pedia", requesterHrId: "r2" }),
    entry({ requestId: "c", areaName: "Giza", requesterTier: "National Sales Manager", nsmHrId: "n2", dmHrId: "d3", lineName: "CNS", requesterHrId: "r3" }),
  ];

  // ── scope order includes the requester's own tier dimension right after requester.
  const base = computeFacetedCoverageDimensions(entries, emptyMarketingCoverageFilterState(), false);
  const order = base.dimensions.map((d) => d.key);
  assert.ok(order.indexOf("requester") < order.indexOf("requesterTier"), "requesterTier follows requester");
  assert.ok(order.indexOf("region") < order.indexOf("area"), "area follows region");

  // unfiltered: area has 2 distinct values, requesterTier has 3 distinct values.
  assert.equal(dim(base.dimensions, "area").options.length, 2);
  assert.equal(dim(base.dimensions, "requesterTier").options.length, 3);
  assert.equal(base.matchedCount, 3);

  // ── CASCADE: choosing area=Cairo collapses requesterTier to the 2 Cairo tiers.
  const pickArea = { ...emptyMarketingCoverageFilterState(), area: ["Cairo"] };
  const facetedArea = computeFacetedCoverageDimensions(entries, pickArea, false);
  const tierOpts = dim(facetedArea.dimensions, "requesterTier").options.map((o) => o.value).sort();
  assert.deepEqual(tierOpts, ["District Manager", "Medical Rep"], "requesterTier cascades to Cairo's 2 tiers");
  assert.equal(facetedArea.matchedCount, 2);

  // area's own options are not collapsed by its own selection (faceted self-exclusion).
  assert.equal(dim(facetedArea.dimensions, "area").options.length, 2, "area still shows both for multi-select");

  // ── never-empty: line collapses to a single value under area=Cairo → auto-applied/hidden.
  const lineDim = dim(facetedArea.dimensions, "line");
  assert.equal(lineDim.render, false);
  assert.deepEqual(lineDim.autoApplied, ["Pedia"]);

  // ── AUTO-FIT: choosing area=Giza (anchor) drops the now-incompatible requesterTier selection.
  const conflicting = { ...emptyMarketingCoverageFilterState(), area: ["Giza"], requesterTier: ["Medical Rep"] };
  const pruned = pruneCoverageFilterState(entries, conflicting, "area");
  assert.deepEqual(pruned.area, ["Giza"], "anchored area selection kept");
  assert.deepEqual(pruned.requesterTier, [], "incompatible requesterTier dropped (Medical Rep isn't in Giza)");

  // a compatible combination survives pruning unchanged.
  const compatible = { ...emptyMarketingCoverageFilterState(), area: ["Giza"], requesterTier: ["National Sales Manager"] };
  assert.deepEqual(pruneCoverageFilterState(entries, compatible, "area"), compatible, "compatible selection untouched");

  // ── entryMatchesCoverageFilters: roiStatus/includeRestricted never narrow the cascade.
  const withRoiStatus = { ...emptyMarketingCoverageFilterState(), roiStatus: ["behind" as const], includeRestricted: true };
  assert.equal(entries.every((e) => entryMatchesCoverageFilters(e, withRoiStatus)), true, "roiStatus + includeRestricted do not filter entries");

  // ── area/requesterTier filters actually narrow matched entries.
  const areaOnly = { ...emptyMarketingCoverageFilterState(), area: ["Giza"] };
  assert.equal(entries.filter((e) => entryMatchesCoverageFilters(e, areaOnly)).length, 1, "only the Giza entry matches");
}
