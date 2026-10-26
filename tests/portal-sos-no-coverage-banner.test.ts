import assert from "node:assert/strict";

import { buildPortalSosOptions } from "../src/lib/sales/portal-sos-dashboard.ts";
import { loadSosCoverageFor } from "../src/lib/sales/sos-dashboard.ts";
import type { SosCoverageReport } from "../src/lib/sales/sos-coverage.ts";

// Owner, 2026-10-26: the data-gap banner ("overseas is missing from 2026-10, 2026-11 … not
// like-for-like") is NEVER shown on the employee portal's Source of Sales dashboard. The admin
// /sales dashboard keeps it. The banner is built only from the coverage read, so the portal
// options switch that read off and the engine never runs it.
export async function runPortalSosNoCoverageBannerTests() {
  // Every portal scope shape carries the flag — company, region-widened and area-bound alike.
  for (const scope of [
    { allowedProductCodes: null, areaCodes: null, regionOverride: undefined },
    { allowedProductCodes: new Set(["P1"]), areaCodes: new Set(["A1"]), regionOverride: new Set(["R1"]) },
    { allowedProductCodes: new Set<string>(), areaCodes: null, regionOverride: undefined },
  ]) {
    const options = buildPortalSosOptions(scope);
    assert.equal(options.omitCoverageWarning, true, "a portal read must hide the coverage banner");
  }
  // The scope overrides still travel with it.
  const bound = buildPortalSosOptions({
    allowedProductCodes: new Set(["P1"]),
    areaCodes: new Set(["A1"]),
    regionOverride: new Set(["R1"]),
  });
  assert.deepEqual([...(bound.allowedAreaCodes ?? [])], ["A1"]);
  assert.deepEqual([...(bound.allowedRegionCodes ?? [])], ["R1"]);
  assert.deepEqual([...(bound.allowedProductCodes ?? [])], ["P1"]);

  const report = { gaps: [] } as unknown as SosCoverageReport;
  let calls = 0;
  const load = async () => {
    calls += 1;
    return report;
  };

  // Portal: the coverage read never runs, so there is nothing to build the banner from.
  assert.equal(await loadSosCoverageFor(buildPortalSosOptions({ allowedProductCodes: null, areaCodes: null }), load), null);
  assert.equal(calls, 0, "the portal must never run the coverage read");

  // Admin (no flag): the coverage read runs and its report reaches the banner.
  assert.equal(await loadSosCoverageFor({ includeMomComparison: true }, load), report);
  assert.equal(await loadSosCoverageFor(undefined, load), report);
  assert.equal(calls, 2);

  // A failed read still degrades to "no gaps reported", never a down dashboard.
  assert.equal(await loadSosCoverageFor(undefined, async () => { throw new Error("boom"); }), null);
}
