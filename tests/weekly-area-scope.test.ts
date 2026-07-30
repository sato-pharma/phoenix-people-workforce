import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { applyWeeklyAccessScope, applyWeeklyTerritoryScope } from "../src/lib/sales/weekly/access.ts";
import { resolveBranchArea, type WeeklyMasterArea } from "../src/lib/sales/weekly/branch-region-map.ts";

// Guards the OPTIONAL area dimension on Weekly Sales.
//
// Weekly facts are at DISTRIBUTOR BRANCH grain (a depot), not rep-territory grain, so an area is only
// ever present when the owner explicitly mapped that branch to one. The scoping rule therefore splits:
// area-mapped rows are judged by the viewer's seat areas, unmapped rows keep the viewer's own-region
// bound. That split is what lets the CNS Alex-BHR DM see his Kafr El-Sheikh 1 (D16) weekly numbers —
// an area that sits in Delta (1) — without his region bound ever being widened to Delta (1).
//
// The critical invariants: additive (never removes a row he already saw), never leaks another
// manager's mapped areas, and a fully unmapped map behaves exactly like the old region-only filter.

const AREAS: WeeklyMasterArea[] = [
  { areaCode: "AB1", areaName: "Alex East", regionCode: "AB" },
  { areaCode: "AB4", areaName: "Behira 1", regionCode: "AB" },
  { areaCode: "D11", areaName: "Qalubeya", regionCode: "D1" },
  { areaCode: "D16", areaName: "Kafr El-Sheikh 1", regionCode: "D1" },
];

type Row = {
  productCode: string;
  officialLine: string;
  regionCode: string;
  areaCode: string | null;
  label: string;
};

const row = (label: string, regionCode: string, areaCode: string | null): Row => ({
  productCode: "P1",
  officialLine: "CNS",
  regionCode,
  areaCode,
  label,
});

// Saad's world: his own region AB, plus one owned area (D16) inside Delta (1).
const SAAD = {
  allowedLineNames: new Set(["CNS"]),
  allowedRegionCodes: new Set(["AB"]), // his OWN region label — deliberately NOT widened
  allowedAreaCodes: new Set(["AB1", "AB2", "AB3", "AB4", "AB5", "D16"]),
};

const ROWS: Row[] = [
  row("AB branch, unmapped", "AB", null),
  row("AB branch, mapped to his AB1", "AB", "AB1"),
  row("D1 branch mapped to HIS D16", "D1", "D16"),
  row("D1 branch mapped to ANOTHER DM's D11", "D1", "D11"),
  row("D1 branch, unmapped", "D1", null),
  row("Cairo branch, unmapped", "CA", null),
];

export function runWeeklyAreaScopeTests() {
  // ── The core split ─────────────────────────────────────────────────────────
  const visible = applyWeeklyTerritoryScope(ROWS, SAAD).map((r) => r.label);
  assert.deepEqual(
    visible.sort(),
    ["AB branch, mapped to his AB1", "AB branch, unmapped", "D1 branch mapped to HIS D16"].sort(),
    "sees his own region's rows plus his mapped out-of-region area, and nothing else",
  );
  assert.equal(
    visible.includes("D1 branch mapped to ANOTHER DM's D11"),
    false,
    "never sees another DM's mapped area in that same region",
  );
  assert.equal(
    visible.includes("D1 branch, unmapped"),
    false,
    "never sees unmapped Delta (1) rows — his region bound is not widened",
  );
  assert.equal(visible.includes("Cairo branch, unmapped"), false, "no cross-region leak at all");

  // ── Additive: strictly a superset of the old region-only behaviour ─────────
  const oldBehaviour = applyWeeklyTerritoryScope(ROWS, { ...SAAD, allowedAreaCodes: null }).map((r) => r.label);
  assert.deepEqual(
    oldBehaviour.sort(),
    ["AB branch, mapped to his AB1", "AB branch, unmapped"].sort(),
    "with no area bound the filter is the pre-existing region-only one",
  );
  for (const label of oldBehaviour) {
    assert.ok(visible.includes(label), `area scoping must never remove a row he already saw: ${label}`);
  }

  // ── A fully unmapped map is a no-op vs region-only ─────────────────────────
  const unmappedRows = ROWS.map((r) => ({ ...r, areaCode: null }));
  assert.deepEqual(
    applyWeeklyTerritoryScope(unmappedRows, SAAD).map((r) => r.label).sort(),
    applyWeeklyTerritoryScope(unmappedRows, { ...SAAD, allowedAreaCodes: null }).map((r) => r.label).sort(),
    "before any branch is area-mapped, behaviour is identical to today",
  );

  // ── Line scope still applies independently of geography ───────────────────
  const otherLine = [...ROWS, { ...row("AB branch, other line", "AB", null), officialLine: "Pedia" }];
  assert.equal(
    applyWeeklyTerritoryScope(otherLine, SAAD).some((r) => r.label === "AB branch, other line"),
    false,
    "a sibling line's row is still excluded",
  );

  // ── An RM spanning regions keeps every region for unmapped rows ────────────
  const rm = {
    allowedLineNames: new Set(["Pedia"]),
    allowedRegionCodes: new Set(["AB", "D1", "D2"]),
    allowedAreaCodes: new Set(["AB1", "D16"]),
  };
  const rmRows = [
    { ...row("AB unmapped", "AB", null), officialLine: "Pedia" },
    { ...row("D1 unmapped", "D1", null), officialLine: "Pedia" },
    { ...row("D1 mapped to D16 (his)", "D1", "D16"), officialLine: "Pedia" },
    { ...row("D1 mapped to D11 (not his)", "D1", "D11"), officialLine: "Pedia" },
    { ...row("Cairo unmapped", "CA", null), officialLine: "Pedia" },
  ];
  const rmVisible = applyWeeklyTerritoryScope(rmRows, rm).map((r) => r.label);
  assert.deepEqual(
    rmVisible.sort(),
    ["AB unmapped", "D1 mapped to D16 (his)", "D1 unmapped"].sort(),
    "RM keeps all his regions for unmapped rows but only his own areas among mapped ones",
  );

  // ── No geography bound at all (line-only roles) passes everything ──────────
  assert.equal(
    applyWeeklyTerritoryScope(ROWS, {
      allowedLineNames: new Set(["CNS"]),
      allowedRegionCodes: null,
      allowedAreaCodes: null,
    }).length,
    ROWS.length,
    "a line-only viewer is not geography-bounded",
  );

  // ── Case / whitespace insensitivity ───────────────────────────────────────
  assert.equal(
    applyWeeklyTerritoryScope([row("lowercase area", "d1", " d16 ")], SAAD).length,
    1,
    "area matching trims and upper-cases",
  );

  // ── Tier integration: restricted products still stripped, HO still gated ───
  const tierRows = [
    { ...row("normal", "AB", null) },
    { ...row("restricted", "AB", null), productCode: "LA003" },
    { ...row("head office", "AB", null), officialLine: "Head Office" },
  ];
  const tiered = applyWeeklyAccessScope(tierRows, { tier: "territory", ...SAAD, canViewHeadOffice: false });
  assert.deepEqual(tiered.map((r) => r.label), ["normal"], "confidential product + Head Office line still stripped");

  // The "full" tier must be untouched by any of this.
  assert.equal(
    applyWeeklyAccessScope(ROWS, { tier: "full", canViewRestricted: true, canViewHeadOffice: true }).length,
    ROWS.length,
    "full-access tier is unaffected by area scoping",
  );

  // ── resolveBranchArea validation ──────────────────────────────────────────
  assert.deepEqual(resolveBranchArea("", "AB", AREAS), { areaCode: null, areaName: null }, "blank = region-only");
  assert.deepEqual(resolveBranchArea(null, "AB", AREAS), { areaCode: null, areaName: null }, "null = region-only");
  assert.deepEqual(
    resolveBranchArea(" ab1 ", "AB", AREAS),
    { areaCode: "AB1", areaName: "Alex East" },
    "trims + upper-cases a valid in-region area",
  );
  assert.throws(
    () => resolveBranchArea("ZZ9", "AB", AREAS),
    /not an official Source of Sales area/,
    "an unknown area code is rejected, never silently dropped",
  );
  assert.throws(
    () => resolveBranchArea("D16", "AB", AREAS),
    /belongs to region D1/,
    "an area outside the branch's own region is rejected — this is the guard against mis-scoping",
  );
  // The legitimate case: the D16 area on a branch actually mapped to Delta (1).
  assert.deepEqual(
    resolveBranchArea("D16", "D1", AREAS),
    { areaCode: "D16", areaName: "Kafr El-Sheikh 1" },
    "an in-region area is accepted — the Kafr El-Sheikh case this whole change exists for",
  );

  // ── Source pins: the parser must never infer an area from a name ──────────
  const parserSource = readFileSync(fileURLToPath(new URL("../src/lib/sales/weekly/parser.ts", import.meta.url)), "utf8");
  assert.ok(
    parserSource.includes("areaCode: entry.areaCode"),
    "the parser stamps the area from the explicit branch mapping",
  );
  assert.equal(
    /areaCode:\s*(normalizeSoft|guess|infer)/.test(parserSource),
    false,
    "the parser must never fuzzy-derive an area from a branch name",
  );
}
