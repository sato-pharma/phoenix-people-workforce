import assert from "node:assert/strict";

import {
  isRestrictedMarketingProduct,
  monthAdd,
  parseRoiFilterState,
  roiWindowLabel,
} from "../src/lib/marketing-requests/roi-report-service.ts";
import {
  roiFilterStateFromParams,
  roiFilterStateHasAny,
  roiFilterStateToParams,
} from "../src/lib/marketing-requests/roi-filter-url.ts";
import { emptyRoiFilterState } from "../src/lib/marketing-requests/roi-report-types.ts";

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
}
