import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { foldAreaCodeForLine } from "../src/lib/sales/closing-area-merges.ts";

// THE BRICK DRILL-DOWN MUST OPEN THE AREA THE PAGE SHOWED, WHICH IS THE FOLDED ONE.
//
// SoS audit. The Sales vs Target Areas table applies `applyAchievementAreaMerges`, so on PEDIA the
// Beni Suef (UE9) row is folded into Fayoum (GZ6): the node the user clicks is keyed "GZ6" and its
// total INCLUDES Beni Suef. The drill-down route filtered the raw `areaCode`, so it returned
// Fayoum's bricks only — the panel that exists to PROVE the area number silently disproved it,
// with no indication anything was missing.
//
// The audit says "the pedia and cns lines". It was written on 2026-08-09, and the answer has moved
// twice since: the owner removed CNS from the merge on 2026-08-30, then put it back on 2026-09-07
// from August onward. So both lines fold again today — and this drill-down passes no period, because
// it shows what the page shows NOW. July CNS, which is published, still drills down as two areas.
//
// The audit also filed this PLAUSIBLE and latent, on the grounds that no Pedia row existed in UE9
// yet. Re-measured on production 2026-09-05 through the route's own RPC (phx_sales_brick_detail),
// they exist now and it is LIVE:
//
//     period   line    shown (GZ6)      missing (UE9)     short by
//     2026-07  Pedia     29,913.38         5,690.25         16.0%
//     2026-08  Pedia      3,047.63        11,100.38         78.5%
//
// 16,790.63 EGP invisible. PEDIA ONLY: CNS carries UE9 sales too (96,807.38 in July) but the owner
// removed CNS from the merge on 2026-08-30, so its drill-down is already correct and must stay so.

const ROUTE_SOURCE = readFileSync(
  fileURLToPath(new URL("../app/api/sales/vs-target/bricks/route.ts", import.meta.url)),
  "utf8",
);

/** The route's own predicate, so this test exercises the rule the route applies. */
function selectedForArea(
  rows: readonly { areaCode: string | null; brickId: string; lineCode: string | null }[],
  area: string,
  period?: string,
) {
  return rows.filter((row) => foldAreaCodeForLine(row.lineCode, row.areaCode ?? "", period) === area);
}

export async function runBrickDrilldownFollowsTheAreaMergeTests(): Promise<void> {
  // ── 1. the fold itself, per line ───────────────────────────────────────────────────────────
  assert.equal(foldAreaCodeForLine("pedia", "UE9", "2026-08"), "GZ6", "Pedia folds Beni Suef into Fayoum");
  assert.equal(
    foldAreaCodeForLine("cns", "UE9"),
    "GZ6",
    "CNS folds again from August — the owner merged CNS from 2026-08 (2026-09-07: «in pedia and cns fayoum and bani suef are one area»), reversing his 2026-08-30 split. The drill-down passes no period, so it answers for today.",
  );
  assert.equal(
    foldAreaCodeForLine("cns", "UE9", "2026-07"),
    "UE9",
    "but July CNS is PUBLISHED as two areas, and drilling into it must still find Beni Suef's " +
      "bricks under Beni Suef — the start date is the whole point of the rule",
  );
  assert.equal(
    foldAreaCodeForLine("anti infective", "UE9"),
    "UE9",
    "ANTI INFECTIVE MUST NOT FOLD. Beni Suef is its own area on that line, so folding it would " +
      "make an Anti Infective row answer a request for Fayoum — corrupting the opposite " +
      "drill-down, which is the mirror-image bug",
  );
  assert.equal(foldAreaCodeForLine("pedia", "GZ6", "2026-08"), "GZ6", "the surviving code folds to itself");
  assert.equal(foldAreaCodeForLine("pedia", " ue9 ", "2026-08"), "GZ6", "codes are trimmed and upper-cased");

  // ── 2. the predicate over a realistic mixed set ────────────────────────────────────────────
  const rows = [
    { areaCode: "GZ6", brickId: "B-FAYOUM-1", lineCode: "pedia" },
    { areaCode: "UE9", brickId: "B-BENI-1", lineCode: "pedia" },
    { areaCode: "UE9", brickId: "B-BENI-2", lineCode: "cns" }, // folded again from 2026-08
    { areaCode: "UE9", brickId: "B-BENI-3", lineCode: "anti infective" },
    { areaCode: "AB4", brickId: "B-OTHER", lineCode: "pedia" },
  ];

  assert.deepEqual(
    selectedForArea(rows, "GZ6", "2026-08").map((row) => row.brickId).sort(),
    ["B-BENI-1", "B-BENI-2", "B-FAYOUM-1"],
    "asking for GZ6 must return Fayoum's brick AND the Beni Suef bricks of every line that folds " +
      "today — Pedia and, since August, CNS. Anti Infective still keeps Beni Suef separate.",
  );
  for (const unmergedLine of ["anti infective"]) {
    assert.ok(
      !selectedForArea(rows, "GZ6", "2026-08").some((row) => row.lineCode === unmergedLine),
      `the ${unmergedLine} Beni Suef brick must NOT appear under Fayoum — that line shows the two ` +
        "areas separately, and pulling it in would corrupt the opposite drill-down",
    );
  }
  assert.deepEqual(
    selectedForArea(rows, "UE9", "2026-08").map((row) => row.brickId),
    ["B-BENI-3"],
    "asking for UE9 returns only the line that still shows UE9 as its own area — Anti Infective. " +
      "The Pedia and CNS bricks answer under GZ6, where the page shows them",
  );
  assert.deepEqual(
    selectedForArea(rows, "AB4").map((row) => row.brickId),
    ["B-OTHER"],
    "an unmerged area is unaffected",
  );

  // ── 2b. FROM SEPTEMBER PEDIA SHOWS THEM SEPARATELY ────────────────────────────────────────
  //
  // Owner 2026-09-09: "fayoum separate area and banisuef separate area but august closing not
  // affected starting from september". Pedia's merge now ENDS at 2026-08, so the same rows answer
  // differently either side of that date — which is the whole point of dating the rule rather than
  // deleting it. CNS is untouched and still folds, so this also proves the change is per line.
  assert.deepEqual(
    selectedForArea(rows, "GZ6", "2026-09").map((row) => row.brickId).sort(),
    ["B-BENI-2", "B-FAYOUM-1"],
    "September: Fayoum keeps its own brick and CNS's folded one — Pedia's Beni Suef brick has left",
  );
  assert.deepEqual(
    selectedForArea(rows, "UE9", "2026-09").map((row) => row.brickId).sort(),
    ["B-BENI-1", "B-BENI-3"],
    "September: Beni Suef answers for itself on Pedia, beside Anti Infective which never folded",
  );

  // ── 3. the route uses that predicate, and AFTER the bound ──────────────────────────────────
  assert.match(
    ROUTE_SOURCE,
    /foldAreaCodeForLine\(row\.lineCode, row\.areaCode \?\? ""\) === area/,
    "the route must match on the FOLDED code, using each row's own line",
  );
  const boundAt = ROUTE_SOURCE.indexOf("filterBricksForBound(");
  const foldAt = ROUTE_SOURCE.indexOf("foldAreaCodeForLine(row.lineCode");
  assert.ok(boundAt > 0 && foldAt > 0, "expected both the bound filter and the fold to be present");
  assert.ok(
    boundAt < foldAt,
    "THE ORDER IS THE SECURITY PROPERTY. filterBricksForBound must run FIRST, on the REAL area " +
      "codes, so folding afterwards only re-keys rows the viewer was already allowed to see. " +
      "Folding first would let a viewer scoped to Beni Suef alone pull in Fayoum's bricks",
  );
  assert.doesNotMatch(
    ROUTE_SOURCE,
    /String\(row\.areaCode \?\? ""\)\.trim\(\)\.toUpperCase\(\) === area/,
    "the raw-code comparison is the defect and must not come back",
  );
}
