import assert from "node:assert/strict";

import { fileBrickForPoint, resolveBrickForPoint } from "@/lib/crm/brick-geo";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// A CAPTURE IS FILED IN THE TERRITORY IT WAS TAKEN IN — the capturing seat's own area breaks a near
// tie between brick centroids.
//
// Owner, 2026-10-10: "they capture the location in a place and is saved in another. Example Hana
// Abdelaziz captured Tabark in Faisal but it is saved in Imbaba."
//
// 🔴 THE CAUSE IS NOT THE GPS AND NOT THE PHOTO — IT IS THE BRICK MASTER'S REFERENCE POINTS. A brick
// has one geocoded centroid and no polygon, so `resolveBrickForPoint` answers with the nearest
// centroid. Measured on production the same day: 68 of the 699 live centroids sit on 25 SHARED
// coordinates, because a brick named after a street Google cannot place falls back to the town's or
// the governorate's own point — and 34 of those sit on 11 coordinates that straddle an AREA
// boundary. Among bricks sharing one coordinate the "nearest" is whichever the array happened to
// hold first, which is not a geographic fact at all:
//
//   - 30.0130557, 31.2088526 is carried by تكلا (GZ3, Imbaba) and by three Helwan-Maadi bricks. It
//     sat 1.26 km from Hana Abdelaziz's capture at Tabarak hospital on King Faisal Street, while the
//     real Haram-Faisal brick كفر طهرمس sat 1.45 km away — so her clinic was filed in Imbaba.
//   - 26.1551, 32.7160 is carried by مدينة قنا (UE7, Qena 1) and by كامولا (UE8, Qena 2) to thirteen
//     decimals. Six Qena 1 captures between 7 and 10 October were filed in Qena 2 on that tie, and
//     Qena 2 carries no CNS target at all.
//
// The fix hands the resolver the capturing seat's area codes and the same trust radius the match is
// judged by. It changed 7 of 631 live place rows and nothing else — 599 already resolved inside
// their own area, and the 13 whose own area has no brick within the radius keep the nearest brick
// anywhere, which is the honest answer for a rep working at the edge of a neighbouring district.
//
// These are BEHAVIOURAL assertions on the real production geometry, not source text: the numbers
// below are the coordinates and the area codes as production held them on 2026-10-10.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The junk coordinate four Giza bricks share — a geocode that is no brick's centre. */
const SHARED_GIZA = { lat: 30.0130557, lon: 31.2088526 };
/** The junk coordinate Qena 1's and Qena 2's city bricks share. */
const SHARED_QENA = { lat: 26.1551, lon: 32.716 };

const brick = (
  brickId: string,
  brickName: string,
  areaCode: string,
  areaName: string,
  at: { lat: number; lon: number },
) => ({
  areaCode,
  areaName,
  brickId,
  brickName,
  lat: at.lat,
  lon: at.lon,
  regionCode: areaCode.slice(0, 2),
  regionName: areaCode.startsWith("GZ") ? "Giza" : "Upper Egypt",
});

/** Hana Abdelaziz's capture: Tabarak hospital, King Faisal Street, filed from seat SEAT-PED-REP-GZ4. */
const TABARAK = { lat: 30.0126356327815, lon: 31.1958162077664 };
const TEKLA = brick("B160-2", "تكلا", "GZ3", "Imbaba - Imbaba Centers", SHARED_GIZA);
const TEBBIN = brick("B197-1", "تبين", "GZ5", "Helwan-Maadi", SHARED_GIZA);
const KAFR_TOHORMOS = brick("B195-3", "كفر طهرمس", "GZ4", "Haram - Faisal", { lat: 30.015173, lon: 31.181061 });

const QENA_CITY = brick("UE7-QENA", "مدينة قنا", "UE7", "Qena 1", SHARED_QENA);
const KAMOULA = brick("UE8-KAM", "كامولا", "UE8", "Qena 2", SHARED_QENA);

// Girga, as production held it on 2026-10-29: 40 validated clinics in the town read "no brick on
// record", because جرجا's one dot sat 15 km north-west of them and the nearest dot of any brick was a
// village 8.5 km away. Sohag1's nearest dot to the town is بلصفورة, 25 km off.
/** A validated capture: the agricultural secondary school in Girga, filed from seat SEAT-AIF-REP-UE6. */
const GIRGA_CLINIC = { lat: 26.3420207, lon: 31.8889412 };
const BARDIS = brick("B165-2", "برديس", "UE6", "Sohag2", { lat: 26.2857296, lon: 31.9464484 });
const ASIRAT = brick("B214-2", "العسيرات", "UE6", "Sohag2", { lat: 26.393673, lon: 31.821766 });
const GIRGA_OLD_DOT = brick("B165-3", "جرجا", "UE6", "Sohag2", { lat: 26.4478038062312, lon: 31.7912561820514 });
const BALSAFOURA = brick("B213-3", "بلصفورة", "UE5", "Sohag1", { lat: 26.52383, lon: 31.73772 });
const SOHAG_BRICKS = [BARDIS, ASIRAT, GIRGA_OLD_DOT, BALSAFOURA];
const FILING = { trustKm: 3, reachKm: 20 } as const;
const km = (value: number | undefined) => (value === undefined ? undefined : Math.round(value * 100) / 100);

export function runPhoenixCrmCaptureBrickTerritoryTests() {
  const GIZA_BRICKS = [TEKLA, TEBBIN, KAFR_TOHORMOS];

  // ── 1. The defect, reproduced: with no territory the junk centroid wins on raw distance ────────
  {
    const blind = resolveBrickForPoint(TABARAK.lat, TABARAK.lon, GIZA_BRICKS);
    assert.ok(blind, "the nearest centroid is found");
    assert.equal(blind.areaCode, "GZ3", "unguided, Tabarak on King Faisal Street resolves to Imbaba — the reported defect");
  }

  // ── 2. The fix: the capturing seat's own area wins inside the trust radius ─────────────────────
  {
    const filed = resolveBrickForPoint(TABARAK.lat, TABARAK.lon, GIZA_BRICKS, { areaCodes: ["GZ4"], withinKm: 3 });
    assert.ok(filed, "the capture still resolves to a brick");
    assert.equal(filed.brickName, "كفر طهرمس", "the Haram-Faisal brick is chosen, not the Imbaba one 190 m closer");
    assert.equal(filed.areaCode, "GZ4", "so the capture is filed in the area it was taken in");
    assert.equal(filed.areaName, "Haram - Faisal", "and the area NAME travels with the code — it is what the owner reads");
    // 🔴 THE DISTANCE IS THE CHOSEN BRICK'S, NEVER THE RUNNER-UP'S. `brick_distance_km` is the number
    // that justifies the brick, and the comment on it in place-location.ts is explicit that a wrong
    // brick is only ever visible in that number. Leaving 1.26 beside كفر طهرمس would make the row
    // evidence for a brick it does not name.
    assert.equal(Math.round(filed.distanceKm * 100) / 100, 1.45, "and the distance is the distance to the brick that was named");
  }

  // ── 3. An exact tie on a SHARED coordinate stops being decided by array order ──────────────────
  {
    // Production's order put كامولا first, which is why six Qena 1 captures read Qena 2.
    const asProduction = resolveBrickForPoint(SHARED_QENA.lat + 0.008, SHARED_QENA.lon, [KAMOULA, QENA_CITY]);
    assert.equal(asProduction?.areaCode, "UE8", "unguided, the tie is broken by whichever brick the array held first");
    for (const order of [
      [KAMOULA, QENA_CITY],
      [QENA_CITY, KAMOULA],
    ]) {
      const filed = resolveBrickForPoint(SHARED_QENA.lat + 0.008, SHARED_QENA.lon, order, { areaCodes: ["UE7"], withinKm: 3 });
      assert.equal(filed?.areaCode, "UE7", "with the seat's territory the answer is the same whatever order the centroids arrive in");
      assert.equal(filed?.brickName, "مدينة قنا", "and it is Qena 1's own city brick");
    }
  }

  // ── 4. OUTSIDE the radius nothing is dragged home — the Kafr El-Sheikh shape ───────────────────
  {
    // Eleven real captures by Kafr El-Sheikh 1 reps sit 0.08–0.99 km from بيلا, a Kafr El-Sheikh 2
    // brick, while their own area's nearest brick is 5.5 km away. That is a rep genuinely working at
    // the edge of the next district, and the nearest brick is the honest answer.
    const bila = brick("D17-BILA", "بيلا", "D17", "Kafr El-Sheikh 2", { lat: 31.2, lon: 30.95 });
    const abshan = brick("D16-ABS", "ابشان", "D16", "Kafr El-Sheikh 1", { lat: 31.25, lon: 30.95 });
    const at = { lat: 31.2005, lon: 30.95 };
    const filed = resolveBrickForPoint(at.lat, at.lon, [bila, abshan], { areaCodes: ["D16"], withinKm: 3 });
    assert.equal(filed?.brickName, "بيلا", "a brick 5.5 km away in the rep's own area never beats one 60 m away");
    assert.ok(filed && filed.distanceKm < 0.1, "and the distance is the real one, so the row shows exactly how it was decided");
  }

  // ── 5. A seat with no area in the organogram behaves exactly as it did before ──────────────────
  {
    const empty = resolveBrickForPoint(TABARAK.lat, TABARAK.lon, GIZA_BRICKS, { areaCodes: [], withinKm: 3 });
    const blind = resolveBrickForPoint(TABARAK.lat, TABARAK.lon, GIZA_BRICKS);
    assert.equal(empty?.brickId, blind?.brickId, "an empty territory is not a filter — a vacant or unmapped seat still gets the nearest brick");
    const missing = resolveBrickForPoint(TABARAK.lat, TABARAK.lon, GIZA_BRICKS, null);
    assert.equal(missing?.brickId, blind?.brickId, "and so does a caller with no territory to give at all");
  }

  // ── 6. The preference cannot invent a brick where there is none ────────────────────────────────
  {
    assert.equal(resolveBrickForPoint(TABARAK.lat, TABARAK.lon, [], { areaCodes: ["GZ4"], withinKm: 3 }), null, "no centroids, no brick");
    assert.equal(resolveBrickForPoint(null, null, GIZA_BRICKS, { areaCodes: ["GZ4"], withinKm: 3 }), null, "no point, no brick");
    // A preferred brick further than the radius does not become the answer just because it is the
    // seat's own — and a point with nothing in range at all still reports the nearest, untrusted, so
    // `brick_lookup` can say `none_nearby` rather than inventing a match.
    const far = resolveBrickForPoint(29.0, 31.0, GIZA_BRICKS, { areaCodes: ["GZ4"], withinKm: 3 });
    assert.ok(far && far.distanceKm > 3, "a point far from every centroid keeps its real distance, and the caller refuses the match on it");
  }

  // ── 7. Past the trust radius, ONLY the capturing seat's own area reaches — up to 20 km ─────────
  // Owner, 2026-10-29: "Validated · no brick on record how fucken come?" — 204 validated places sat
  // further than 3 km from every dot, at most 17.46 km. Asked, he chose "Rep's own area".
  {
    // Inside the trust radius nothing changes: the 60 m neighbour still wins over the own area's 5.5 km.
    const bila = brick("D17-BILA", "بيلا", "D17", "Kafr El-Sheikh 2", { lat: 31.2, lon: 30.95 });
    const abshan = brick("D16-ABS", "ابشان", "D16", "Kafr El-Sheikh 1", { lat: 31.25, lon: 30.95 });
    const edge = fileBrickForPoint(31.2005, 30.95, [bila, abshan], { areaCodes: ["D16"], ...FILING });
    assert.equal(edge.filed?.brickName, "بيلا", "a brick within 3 km is filed whatever area it is in, exactly as before");
    assert.equal(edge.measured?.brickName, "بيلا", "and the distance recorded is that brick's");

    // A Sohag2 rep at a Girga clinic: no dot within 3 km, so the nearest dot of HIS OWN area is filed.
    const sohag2 = fileBrickForPoint(GIRGA_CLINIC.lat, GIRGA_CLINIC.lon, SOHAG_BRICKS, { areaCodes: ["UE6"], ...FILING });
    assert.equal(sohag2.filed?.brickName, "برديس", "past 3 km the seat's own area's nearest dot within 20 km is the place's brick");
    assert.equal(sohag2.filed?.areaCode, "UE6", "so it is filed in the area the rep works");
    assert.equal(km(sohag2.filed?.distanceKm), 8.49, "and the distance recorded is the real one to the brick that was filed");
    assert.equal(sohag2.measured?.brickId, sohag2.filed?.brickId, "the measured brick IS the filed brick, so the row is evidence for what it names");

    // The same clinic with only جرجا's old dot to go by: 15.27 km, still the own area, still filed.
    const oldDot = fileBrickForPoint(GIRGA_CLINIC.lat, GIRGA_CLINIC.lon, [GIRGA_OLD_DOT, BALSAFOURA], { areaCodes: ["UE6"], ...FILING });
    assert.equal(oldDot.filed?.brickName, "جرجا", "an own-area dot 15 km away is within the reach");
    assert.equal(km(oldDot.filed?.distanceKm), 15.27, "and it is recorded at its true 15.27 km, never rounded into trust");

    // A Sohag1 rep at the same clinic: Sohag2's dots are 8.5 km off, his own area's are 25 km off.
    const sohag1 = fileBrickForPoint(GIRGA_CLINIC.lat, GIRGA_CLINIC.lon, SOHAG_BRICKS, { areaCodes: ["UE5"], ...FILING });
    assert.equal(sohag1.filed, null, "a neighbouring area's dot never reaches, and the own area's 25 km dot is past the reach — nothing is filed");
    assert.equal(sohag1.measured?.brickName, "برديس", "the row still records the nearest dot anywhere, so brick_lookup says none_nearby with the real distance");
    assert.equal(km(sohag1.measured?.distanceKm), 8.49, "at its true distance");
    const reachAt26 = fileBrickForPoint(GIRGA_CLINIC.lat, GIRGA_CLINIC.lon, SOHAG_BRICKS, { areaCodes: ["UE5"], trustKm: 3, reachKm: 26 });
    assert.equal(reachAt26.filed?.brickName, "بلصفورة", "it is the reach that refused بلصفورة, not a missing dot");
    // 🔴 The neighbour's برديس is 8.49 km off and the filed بلصفورة 25.21 km: the row records the
    // FILED brick's distance, never the nearer neighbour's, or it would be evidence for a brick it does not name.
    assert.equal(reachAt26.measured?.brickName, "بلصفورة", "the measured brick is the filed brick, not the nearer neighbour");
    assert.equal(km(reachAt26.measured?.distanceKm), 25.21, "and its distance is the filed brick's own");

    // A seat with no area in the organogram: no own area to reach with, so the old answer stands.
    const vacant = fileBrickForPoint(GIRGA_CLINIC.lat, GIRGA_CLINIC.lon, SOHAG_BRICKS, { areaCodes: [], ...FILING });
    assert.equal(vacant.filed, null, "with no territory nothing past 3 km is filed — the behaviour before the reach");
    assert.equal(vacant.measured?.brickName, "برديس", "and the nearest dot anywhere is still measured");

    // Nothing is invented where there is nothing to file.
    assert.deepEqual(fileBrickForPoint(GIRGA_CLINIC.lat, GIRGA_CLINIC.lon, [], { areaCodes: ["UE6"], ...FILING }), { filed: null, measured: null }, "no centroids, no brick");
    assert.deepEqual(fileBrickForPoint(null, null, SOHAG_BRICKS, { areaCodes: ["UE6"], ...FILING }), { filed: null, measured: null }, "no point, no brick");
  }
}
