import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { regionLabelsWithinManagerHierarchy } from "../src/lib/workforce/hierarchy-resolver.ts";

/**
 * A Regional Manager's portal header names EVERY region his team works in. His own region_name holds
 * one of them — Hany Saad's read "Alex-BHR" while his seat runs Alex-BHR, Delta (1) and Delta (2)
 * (owner, 2026-11-09: "why shown like this?").
 */

type Row = {
  hrId: string;
  managerHrId: string | null;
  pendingManagerReplacementForHrId: string | null;
  regionName: string | null;
};

const row = (hrId: string, managerHrId: string | null, regionName: string | null): Row => ({
  hrId,
  managerHrId,
  pendingManagerReplacementForHrId: null,
  regionName,
});

export function runRegionalManagerTerritoryLabelTests() {
  const canonicalize = (value: string | null | undefined) => value?.trim().toUpperCase() || null;
  const rows: Row[] = [
    row("RM-1", "NSM-1", "Alex-BHR"),
    row("DM-AB", "RM-1", "Alex-BHR"),
    row("DM-D1", "RM-1", "Delta (1)"),
    row("DM-D2", "RM-1", "Delta (2)"),
    row("REP-AB", "DM-AB", "ALEX-BHR"),
    row("REP-D2", "DM-D2", "Delta (2)"),
    row("REP-OTHER", "DM-OTHER", "Cairo (1)"),
  ];

  assert.deepEqual(
    regionLabelsWithinManagerHierarchy(rows, "RM-1", canonicalize),
    ["Alex-BHR", "Delta (1)", "Delta (2)"],
    "a regional manager's territory names all three regions under him, once each, in reading order",
  );
  assert.deepEqual(
    regionLabelsWithinManagerHierarchy(rows, "NOBODY", canonicalize),
    [],
    "a person with no team has no team regions — the header keeps his own region",
  );

  // The three portal builders print the territory through the one helper, never the raw region_name.
  const service = readFileSync(new URL("../src/lib/employee-portal/service.ts", import.meta.url), "utf8");
  assert.equal(
    (service.match(/territory: employee\.regionName \?\? employee\.areaName/g) ?? []).length,
    0,
    "no portal builder prints a regional manager's own single region as his territory",
  );
  assert.ok(
    /if \(normalizeRole\(role\) !== "Regional Manager"\) return ownLabel;/.test(service),
    "portalTerritoryLabel widens the label for the Regional Manager only",
  );
}
