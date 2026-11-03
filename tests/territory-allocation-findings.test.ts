import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { haversineKm } from "../src/lib/sales/normalizer/geo-validate.ts";
import { areaGeography, medianCentre, pinConfidence } from "../src/lib/territory-management/service.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Territory Management — the mis-allocation findings (production audit, 2026-10-27).
//
// The owner reported bricks allocated to the wrong areas. The map's two findings — "far from the
// rest of the area" and "closer to another area" — are how a manager is meant to SEE that, and on
// production neither saw Qena 1's clearest case:
//
//   • قريه الكلاحين (Qena 1) sits 57 km east of Qena 1's other bricks and 6 km from Qena 2's centre.
//     The area centre was a MEAN, which that one brick dragged 12 km toward itself, so it measured
//     46 km out — under an orphan cut of 1.75× the mean pair distance (63 km), a figure the brick's
//     own long pairs had inflated. Not an orphan.
//   • "Closer to another area" compared a brick only with the OTHER SELECTED areas' centres. With
//     Qena 1 picked on its own — the commonest way the map is read — there was nothing to compare
//     with. Not an overlap either.
//   • And each list was cut at five on screen, with nothing saying more existed.
//
// What this file pins:
//   1. The centre is the median, which one far brick does not move.
//   2. The real Qena pins: الكلاحين is an orphan of Qena 1 and nearer Qena 2, and nothing else in
//      either area is flagged.
//   3. The overlap rule needs the brick to be OUT of its own area, not merely nearer a neighbour —
//      a border brick is not a finding.
//   4. Too few bricks to have a "rest" flags nothing.
//   5. The loader reads every area of the line for the comparison, and returns only those asked for.
//   6. A pin moved to rep GPS is never presented as more trustworthy than a geocode.
//   7. The workspace lists every finding.
// ─────────────────────────────────────────────────────────────────────────────

type Located = { areaCode: string; brickId: string; brickName: string; lat: number; lng: number };

function brick(areaCode: string, brickId: string, brickName: string, lat: number, lng: number): Located {
  return { areaCode, brickId, brickName, lat, lng };
}

const AREA_NAMES = new Map([
  ["UE7", "Qena 1"],
  ["UE8", "Qena 2"],
]);

/** Qena 1's located bricks in force on production, 2026-10-27 (its four shared-fallback pins are unlocated). */
const QENA_1 = [
  brick("UE7", "B140-32", "أبو طشت", 26.1209427, 32.0956124),
  brick("UE7", "B140-M1", "دشنا", 26.1259306, 32.4715932),
  brick("UE7", "B140-26", "فرشوط", 26.0556441, 32.1676013),
  brick("UE7", "B209-7", "قريه الكلاحين", 25.99697, 32.81004), // checkin_gps
  brick("UE7", "B140-31", "نجع حمادى", 26.0451551, 32.2427609),
];

/** Qena 2's, with the three bricks that moved in on 13 Oct drawn at the pins they inherit. */
const QENA_2 = [
  brick("UE8", "B210-1", "الصالحية", 26.1497288, 32.7604395),
  brick("UE8", "B141-36", "الطويرات", 26.1092374, 32.734326),
  brick("UE8", "B175-1", "العشى", 25.762395, 32.723784),
  brick("UE8", "B144-34", "قفط", 26.0002314, 32.8159277),
  brick("UE8", "B167-1", "نقادة", 25.9177, 32.76028), // checkin_gps
  brick("UE8", "B209B-2", "قوص", 25.918093, 32.759921),
  brick("UE8", "B209B-3", "أبنود", 26.05098, 32.788653),
  brick("UE8", "B209B-4", "مدينة قنا", 26.155061, 32.7160121),
];

function meanCentre(points: Located[]) {
  return {
    lat: points.reduce((sum, p) => sum + p.lat, 0) / points.length,
    lng: points.reduce((sum, p) => sum + p.lng, 0) / points.length,
  };
}

export function runTerritoryAllocationFindingsTests() {
  // ── 1. The centre is the median ────────────────────────────────────────────
  const median = medianCentre(QENA_1);
  assert.ok(median, "five located bricks have a centre");
  const mean = meanCentre(QENA_1);
  const kalahin = QENA_1[3];
  const fromMedian = haversineKm(kalahin.lat, kalahin.lng, median.lat, median.lng);
  const fromMean = haversineKm(kalahin.lat, kalahin.lng, mean.lat, mean.lng);
  assert.ok(
    fromMedian > 55 && fromMean < 47,
    `the mean is dragged toward the stray brick (${fromMean.toFixed(1)} km) — the median is not (${fromMedian.toFixed(1)} km)`,
  );
  assert.equal(medianCentre([]), null, "no located brick, no centre");

  // ── 2. The real Qena pins ──────────────────────────────────────────────────
  // Only Qena 1's bricks are "on screen" — but the comparison is fed the whole line.
  const geography = areaGeography([...QENA_1, ...QENA_2], AREA_NAMES);
  const qena1 = geography.get("UE7");
  const qena2 = geography.get("UE8");
  assert.ok(qena1 && qena2, "both areas get a geography");

  assert.deepEqual(
    qena1.orphans.map((o) => o.brickName),
    ["قريه الكلاحين"],
    "الكلاحين is 57 km from a Qena 1 whose other bricks sit within 25 km — it is far from the rest of its area",
  );
  assert.ok(qena1.orphans[0].kmFromCentre > 55 && qena1.orphans[0].kmFromCentre < 60);
  assert.deepEqual(
    qena1.overlaps.map((o) => [o.brickName, o.nearerAreaName]),
    [["قريه الكلاحين", "Qena 2"]],
    "and it is nearer Qena 2's centre than its own — the finding that names where it may belong",
  );
  assert.ok(qena1.overlaps[0].kmToOtherCentre < 10, "a few km from Qena 2's centre, against ~57 from its own");
  assert.equal(qena2.orphans.length, 0, "Qena 2's bricks sit together — nothing invented around them");
  assert.equal(qena2.overlaps.length, 0, "and none of them is nearer Qena 1");

  // The same Qena 1, compared with nothing but itself, still finds its orphan (the old loader's
  // single-area view), and finds no overlap — which is exactly why the loader must feed the line.
  const alone = areaGeography(QENA_1, AREA_NAMES).get("UE7");
  assert.deepEqual(alone?.orphans.map((o) => o.brickName), ["قريه الكلاحين"]);
  assert.equal(alone?.overlaps.length, 0, "with no neighbour to compare against there is no overlap to find");

  // ── 3. A border brick is not a finding ─────────────────────────────────────
  // Two neighbouring areas. a5 sits on A's eastern edge, a little nearer B's centre than A's — but
  // well inside A's own spread. The old "nearer" rule flagged exactly this; it is geometry.
  const borderBricks = [
    brick("A", "a1", "a1", 30.0, 31.0),
    brick("A", "a2", "a2", 30.0, 31.06),
    brick("A", "a3", "a3", 30.05, 31.03),
    brick("A", "a4", "a4", 29.95, 31.03),
    brick("A", "a5", "a5", 30.0, 31.13),
    brick("B", "b1", "b1", 30.0, 31.2),
    brick("B", "b2", "b2", 30.04, 31.22),
    brick("B", "b3", "b3", 29.96, 31.22),
  ];
  const border = areaGeography(
    borderBricks,
    new Map([
      ["A", "Area A"],
      ["B", "Area B"],
    ]),
  );
  const a5 = borderBricks[4];
  const centreA = border.get("A")?.centre;
  const centreB = border.get("B")?.centre;
  assert.ok(centreA && centreB);
  assert.ok(
    haversineKm(a5.lat, a5.lng, centreB.lat, centreB.lng) < haversineKm(a5.lat, a5.lng, centreA.lat, centreA.lng),
    "control: a5 really is nearer B's centre than A's",
  );
  assert.equal(border.get("A")?.overlaps.length, 0, "a brick on its own area's edge is geometry, not a mis-allocation");
  assert.equal(border.get("A")?.orphans.length, 0);

  // Push the same brick well out of A, past B: now it is a finding.
  const strayed = areaGeography(
    borderBricks.map((b) => (b.brickId === "a5" ? { ...b, lng: 31.3 } : b)),
    new Map([
      ["A", "Area A"],
      ["B", "Area B"],
    ]),
  );
  assert.deepEqual(
    strayed.get("A")?.overlaps.map((o) => [o.brickId, o.nearerAreaName]),
    [["a5", "Area B"]],
    "a brick out of its own area and nearer a neighbour IS flagged — the rule is narrowed, not switched off",
  );

  // ── 4. Too few bricks to have a "rest" ─────────────────────────────────────
  const pair = areaGeography(
    [brick("P", "p1", "p1", 30.0, 31.0), brick("P", "p2", "p2", 30.0, 32.0)],
    new Map([["P", "Pair"]]),
  ).get("P");
  assert.equal(pair?.orphans.length, 0, "two bricks 96 km apart: neither is far from 'the rest' — there is no rest");

  // ── 5. The loader feeds the line, returns the selection ────────────────────
  const service = readFileSync(new URL("../src/lib/territory-management/service.ts", import.meta.url), "utf8");
  const start = service.indexOf("export async function loadTerritoryMap(");
  const loader = service.slice(start, service.indexOf("\n}\n", start));
  assert.match(
    loader,
    /const lineAreaCodes = \[\.\.\.new Set\(\[\.\.\.visibleLineAreas\(allowed, scope\)\.keys\(\), \.\.\.requested\]\)\];/,
    "the comparison set is every area of the line the viewer may see — the picker's own definition, so it can never widen scope",
  );
  assert.match(loader, /\.in\("area_code", lineAreaCodes\)/, "the brick read covers the line, not only the selection");
  assert.match(loader, /areaGeography\(lineBricks, areaNames\)/, "the findings are computed over every located brick of the line");
  assert.match(
    loader,
    /const bricks = lineBricks\.filter\(\(brick\) => wanted\.has\(brick\.areaCode\)\);/,
    "only the requested areas' bricks are drawn and returned — a neighbour is read for its centre alone",
  );
  assert.match(loader, /const unlocated = lineUnlocated\.filter\(\(brick\) => wanted\.has\(brick\.areaCode\)\);/);
  assert.match(loader, /total: requestedRows\.length,/, "coverage counts the selection, never the whole line");
  assert.ok(!/\bcentreOf\(/.test(service), "the mean centre is gone");

  // ── 6. Rep GPS is never ground truth ───────────────────────────────────────
  const geocoded = pinConfidence("google_places_hint", "success");
  for (const provider of ["checkin_gps", "field_gps"]) {
    const confidence = pinConfidence(provider, "success");
    assert.equal(confidence.verified, false, `${provider} is a phone's report, not a confirmed location`);
    assert.ok(
      confidence.percent < geocoded.percent,
      `${provider} must read below a matched place (${confidence.percent}% vs ${geocoded.percent}%) — check-ins can be spoofed`,
    );
    assert.notEqual(confidence.label, "Unverified", `${provider} says where its pin came from`);
  }

  // ── 7. The workspace lists every finding ───────────────────────────────────
  const workspace = readFileSync(
    new URL("../src/components/territory-management/territory-map-workspace.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(
    !/(overlaps|orphans)\.slice\(/.test(workspace),
    "a finding list cut at a fixed length drops bricks silently — a dropped brick reads as a clean one",
  );
  assert.match(workspace, /items=\{area\.overlaps\.map\(/);
  assert.match(workspace, /items=\{area\.orphans\.map\(/);
  assert.match(workspace, /const folded = items\.slice\(FINDINGS_SHOWN\);/, "the rest fold behind a click, never off the page");

  // ── 8. A mis-assigned brick links to its fix, for whoever can open the fix ─────────────────
  assert.match(workspace, /href: canReviewBricks \? brickCorrectionHref\(overlap\.brickId\) : undefined/, "an overlap row links to that brick's correction, only for a viewer who can open it");
  assert.match(workspace, />Review<\/Link>/, "it says Review, never Fix: the finding rests on pins, and a pin can be a guess");
  const adminPage = readFileSync(new URL("../app/(admin)/sales/territory-management/page.tsx", import.meta.url), "utf8");
  assert.match(adminPage, /canReviewBricks=\{access\.role === "Super Admin" \|\| access\.scope === "system"\}/, "the same bar as the Database Mapping page");
  const portalPage = readFileSync(new URL("../app/employee-portals/territory-management/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(portalPage, /canReviewBricks/, "the portal never draws a link its roles would only be bounced from");
}
