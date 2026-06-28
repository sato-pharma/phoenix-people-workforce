import assert from "node:assert/strict";

import {
  computeFacetedDimensions,
  entryMatchesRoiFilters,
  pruneRoiFilterState,
} from "../src/lib/marketing-requests/roi-facets.ts";
import { emptyRoiFilterState } from "../src/lib/marketing-requests/roi-report-types.ts";
import type { MarketingRoiRequestIndexEntry, RoiFilterDimension, RoiFilterKey } from "../src/lib/marketing-requests/roi-report-types.ts";

function entry(overrides: Partial<MarketingRoiRequestIndexEntry>): MarketingRoiRequestIndexEntry {
  return {
    requestId: "r", requestCode: "REQ", requesterHrId: "r1", requesterName: "Rep One", managerHrId: null,
    status: "approved", requestTypeId: 1, requestTypeName: "Doctor", payDate: "2026-03-01", roiDurationMonths: 3,
    lineName: "Pedia", regionName: "Delta", dmHrId: "d1", dmName: "DM One", nsmHrId: "n1", nsmName: "NSM One",
    rsmHrId: null, rsmName: null, approverRoleKeys: [], distributorCodes: ["IS"], productCodes: ["P1"],
    productNames: ["Prod 1"], pharmacyKeys: ["ph1"], pharmacyNames: ["Pharm 1"], hasRestrictedProduct: false,
    ...overrides,
  };
}

function dim(dims: RoiFilterDimension[], key: RoiFilterKey): RoiFilterDimension {
  const found = dims.find((d) => d.key === key);
  assert.ok(found, `dimension ${key}`);
  return found as RoiFilterDimension;
}

export function runMarketingRoiFacetsTests() {
  const entries: MarketingRoiRequestIndexEntry[] = [
    entry({ requestId: "a", nsmHrId: "n1", nsmName: "NSM One", dmHrId: "d1", dmName: "DM One", lineName: "Pedia", productCodes: ["P1"], productNames: ["Prod 1"], requesterHrId: "r1" }),
    entry({ requestId: "b", nsmHrId: "n1", nsmName: "NSM One", dmHrId: "d2", dmName: "DM Two", lineName: "Pedia", productCodes: ["P2"], productNames: ["Prod 2"], requesterHrId: "r2" }),
    entry({ requestId: "c", nsmHrId: "n2", nsmName: "NSM Two", dmHrId: "d3", dmName: "DM Three", lineName: "CNS", productCodes: ["P3"], productNames: ["Prod 3"], requesterHrId: "r3" }),
  ];

  // ── scope order: management chain leads (NSM → RSM → DM → Requester → line …) ──
  const base = computeFacetedDimensions(entries, emptyRoiFilterState(), false);
  const order = base.dimensions.map((d) => d.key);
  assert.equal(order[0], "nsm");
  assert.equal(order[1], "rsm");
  assert.equal(order[2], "dm");
  assert.equal(order[3], "requester");
  assert.ok(order.indexOf("nsm") < order.indexOf("dm"), "NSM must come before DM");

  // unfiltered: DM offers all three; NSM offers both
  assert.equal(dim(base.dimensions, "dm").options.length, 3);
  assert.equal(dim(base.dimensions, "nsm").options.length, 2);
  assert.equal(base.matchedCount, 3);

  // ── CASCADE: choosing NSM One collapses the DM list to that NSM's DMs ──────────
  const pickNsm = { ...emptyRoiFilterState(), nsm: ["n1"] };
  const facetedNsm = computeFacetedDimensions(entries, pickNsm, false);
  const dmOpts = dim(facetedNsm.dimensions, "dm").options.map((o) => o.value).sort();
  assert.deepEqual(dmOpts, ["d1", "d2"], "DM list cascades to NSM One's DMs (d3 excluded)");
  assert.equal(facetedNsm.matchedCount, 2, "two requests under NSM One");
  // NSM's own options are NOT collapsed by its own selection (faceted self-exclusion)
  assert.equal(dim(facetedNsm.dimensions, "nsm").options.length, 2, "NSM still shows both for multi-select");

  // ── never-empty: line collapses to one value under NSM One → auto-applied/hidden ─
  const lineDim = dim(facetedNsm.dimensions, "line");
  assert.equal(lineDim.render, false);
  assert.deepEqual(lineDim.autoApplied, ["Pedia"]);

  // choosing line = CNS narrows NSM to NSM Two
  const pickLine = { ...emptyRoiFilterState(), line: ["CNS"] };
  const facetedLine = computeFacetedDimensions(entries, pickLine, false);
  assert.deepEqual(dim(facetedLine.dimensions, "nsm").options.map((o) => o.value), ["n2"], "line=CNS → only NSM Two");

  // ── AUTO-FIT: the just-chosen dimension (anchor) is preserved; the others adjust ─
  // user had DM Three (n2) + product P3, then chose NSM One (n1) → nsm anchored, the
  // now-incompatible DM + product are dropped (not the NSM).
  const conflicting = { ...emptyRoiFilterState(), nsm: ["n1"], dm: ["d3"], product: ["P3"] };
  const pruned = pruneRoiFilterState(entries, conflicting, "nsm");
  assert.deepEqual(pruned.nsm, ["n1"], "anchored NSM selection kept");
  assert.deepEqual(pruned.dm, [], "incompatible DM dropped");
  assert.deepEqual(pruned.product, [], "incompatible product dropped");

  // a compatible combination survives pruning unchanged
  const compatible = { ...emptyRoiFilterState(), nsm: ["n1"], dm: ["d1"], product: ["P1"] };
  assert.deepEqual(pruneRoiFilterState(entries, compatible, "nsm"), compatible, "compatible selection untouched");

  // ── entryMatchesRoiFilters: roiStatus/includeRestricted never narrow the cascade ─
  const withRoiStatus = { ...emptyRoiFilterState(), roiStatus: ["behind" as const], includeRestricted: true };
  assert.equal(entries.every((e) => entryMatchesRoiFilters(e, withRoiStatus)), true, "roiStatus + includeRestricted do not filter entries");

  // ── REGRESSION: a lone value present on only SOME entries must NOT auto-apply ─────
  // The org's single Regional Manager sits in one request's chain; the rest have none.
  // Before the fix this auto-applied that RM for every viewer (and, if applied, hid the
  // value-less requests). Now: 1 value but NOT universal → not auto-applied, not rendered.
  const rsmEntries: MarketingRoiRequestIndexEntry[] = [
    entry({ requestId: "x", rsmHrId: "rm1", rsmName: "Solo RM" }),
    entry({ requestId: "y", rsmHrId: null, rsmName: null }),
    entry({ requestId: "z", rsmHrId: null, rsmName: null }),
  ];
  const rsmFaceted = computeFacetedDimensions(rsmEntries, emptyRoiFilterState(), false);
  const rsmDim = dim(rsmFaceted.dimensions, "rsm");
  assert.equal(rsmDim.options.length, 1, "only one RM value exists across the entries");
  assert.equal(rsmDim.autoApplied, null, "a lone value covering only a subset is NOT auto-applied");
  assert.equal(rsmDim.render, false, "a single-option dimension still does not render");
  assert.equal(rsmFaceted.matchedCount, 3, "all requests stay in scope — none hidden by a phantom auto-apply");

  // contrast: when the lone value IS universal (every entry carries it) it still auto-applies
  const universalRsm: MarketingRoiRequestIndexEntry[] = [
    entry({ requestId: "p", rsmHrId: "rm1", rsmName: "Solo RM" }),
    entry({ requestId: "q", rsmHrId: "rm1", rsmName: "Solo RM" }),
  ];
  const uniFaceted = computeFacetedDimensions(universalRsm, emptyRoiFilterState(), false);
  assert.deepEqual(dim(uniFaceted.dimensions, "rsm").autoApplied, ["rm1"], "a universal lone value still auto-applies");
}
