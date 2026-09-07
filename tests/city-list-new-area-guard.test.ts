import assert from "node:assert/strict";

import { buildImportSplitPlan, type SplitPlanSourceRow } from "../src/lib/sales/import-split-preview.ts";
import {
  AREA_CITY,
  AREAS_DELIBERATELY_NOT_SPLIT,
  isUnlistedArea,
} from "../src/lib/sales/store-sales-city-split.ts";

/**
 * A NEW AREA MUST NOT SILENTLY STOP THE SPLIT — owner, 2026-09-07: "in pedia fayoum and bani suef is
 * one area so no splitting here, but in future if fayoum and bani suef hired in them more than 1
 * area, split."
 *
 * He is right on both halves, and the second one is the dangerous one. AREA_CITY is a hand-written
 * list, and "missing" is deliberately its safe direction: an unlisted area never splits and its sales
 * stay where the file put them. But that safety is silent, and on the day a second Beni Suef area is
 * hired it fails TWICE at once:
 *
 *   1. the new area is not in AREA_CITY, so its own wholesalers do not split; and
 *   2. UE9 still reads as a one-area city, so it does not start splitting either.
 *
 * Neither raises an error. The split preserves each line's unit total while moving units between
 * areas, so the publication drift check — which compares units — sees nothing. The first sign would
 * be a new rep asking why no wholesaler money ever reached him.
 *
 * ONE LINE in AREA_CITY fixes both. The entire problem is that nobody is told to add it, which is
 * what this guard exists to change.
 *
 * 🔴 THE NEGATIVE HALF IS WHAT KEEPS THE GUARD ALIVE. Two live areas are legitimately outside
 * AREA_CITY — OT3 (Aswan Legacy, retired) and OTMS (Main Store, real sales but no rep, DM or target).
 * Main Store carries CNS money most months, so a guard that did not know about these two would fire
 * on EVERY import, and a warning that fires at the normal working level is wallpaper within a month.
 * That is the same failure the session-count statusline had. So the assertions below are as much
 * about staying quiet as about firing.
 */

const base: SplitPlanSourceRow = {
  areaCode: "UE9",
  clientCode: "C1",
  clientName: "مخزن بنى سويف",
  distributorCode: "EP-PHS",
  isDirect: false,
  officialLine: "Pedia",
  qty: 100,
};

const row = (over: Partial<SplitPlanSourceRow> = {}): SplitPlanSourceRow => ({ ...base, ...over });

export function runCityListNewAreaGuardTests() {
  // ── Today's state: the two deliberate exclusions, and nothing else ────────────────────────────
  assert.deepEqual(
    [...AREAS_DELIBERATELY_NOT_SPLIT.keys()].sort(),
    ["OT3", "OTMS"],
    "verified live 2026-09-07: these are the only two of 51 live areas absent from AREA_CITY",
  );
  for (const area of ["OT3", "OTMS"]) {
    assert.equal(isUnlistedArea(area), false, `${area} is a known exclusion — the guard must stay silent`);
    assert.equal(AREA_CITY.has(area), false, `${area} is genuinely not grouped into a city`);
  }

  // ── The owner's two governorates, exactly as they stand ──────────────────────────────────────
  assert.equal(AREA_CITY.get("UE9"), "Beni Suef");
  assert.equal(AREA_CITY.get("GZ6"), "Fayoum");
  const beniSuef = buildImportSplitPlan({ period: "2026-09", rows: [row()] });
  assert.equal(beniSuef.customers[0].willSplit, false, "one area, so nothing to divide across — correct today");
  assert.match(beniSuef.customers[0].reason ?? "", /one area only/);
  assert.deepEqual(beniSuef.unlistedAreas, [], "and nothing is unlisted, so no warning is shown");

  const fayoum = buildImportSplitPlan({ period: "2026-09", rows: [row({ areaCode: "GZ6" })] });
  assert.equal(fayoum.customers[0].willSplit, false, "Fayoum likewise holds one area");
  assert.deepEqual(fayoum.unlistedAreas, []);

  // ── A quiet file stays quiet: every listed area, plus both exclusions, warns about nothing ────
  const everything = buildImportSplitPlan({
    period: "2026-09",
    rows: [
      ...[...AREA_CITY.keys()].map((areaCode, i) => row({ areaCode, clientCode: `L${i}` })),
      row({ areaCode: "OT3", clientCode: "X1" }),
      row({ areaCode: "OTMS", clientCode: "X2" }),
    ],
  });
  assert.deepEqual(
    everything.unlistedAreas,
    [],
    "a file touching EVERY known area raises nothing — this is the assertion that stops the warning becoming wallpaper",
  );

  // ── THE ACTUAL SCENARIO HE DESCRIBED: a second Beni Suef area is hired ────────────────────────
  const hired = buildImportSplitPlan({
    period: "2026-09",
    rows: [
      row({ areaCode: "UE10", clientCode: "NEW", clientName: "مخزن بنى سويف الثانى" }),
      row({ areaCode: "UE9", clientCode: "OLD" }),
    ],
  });
  assert.equal(isUnlistedArea("UE10"), true, "an area nobody has classified is unlisted");
  assert.deepEqual(hired.unlistedAreas, ["UE10"], "and the plan names it, so the import screen can say so");

  const newArea = hired.customers.find((c) => c.clientCode === "NEW");
  assert.equal(newArea?.willSplit, false, "the new area does not split — this is the silent half, now visible");
  assert.match(newArea?.reason ?? "", /not on the city list/, "and its reason names the cause, not the customer");

  const oldArea = hired.customers.find((c) => c.clientCode === "OLD");
  assert.equal(oldArea?.willSplit, false, "and UE9 STILL does not split — the second half of the failure");

  // ── Case and whitespace must not defeat it ────────────────────────────────────────────────────
  assert.equal(isUnlistedArea("ue10"), true, "areas arrive from files in any casing");
  assert.equal(isUnlistedArea("  otms  "), false, "and a padded known exclusion is still known");
  assert.equal(isUnlistedArea(""), false, "a blank area is a different problem and not this warning's job");
  assert.equal(isUnlistedArea(null), false);
}
