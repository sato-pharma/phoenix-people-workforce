import assert from "node:assert/strict";

import {
  EVIDENCE_ADDRESS_UNRESOLVED,
  EVIDENCE_BRICK_CONFIDENT_KM,
  EVIDENCE_TERRITORY_UNMATCHED,
  formatCoordinatePair,
  formatEvidenceLocationLabel,
  formatEvidenceLocationLines,
  type EvidenceLocationStamp,
} from "../src/lib/evidence/location-stamp.ts";
import { computeEvidencePanelLayout } from "../src/components/outstation/evidence-watermark.ts";

/**
 * The wording burned into every Phoenix evidence photo (owner instruction, 2026-08-23).
 *
 * The defect these pin down: two of the three capture surfaces wrote the captured place as nothing
 * but `GPS: 30.059482, 31.223145`. The headline assertion is therefore the LAST one — that no line
 * of a stamp is ever a bare coordinate pair standing in for an address.
 */
export function runEvidenceLocationStampTests() {
  const mohandessin: EvidenceLocationStamp = {
    accuracyMeters: 12,
    address: "12 Ahmed Orabi Street, Mohandessin, Giza Governorate",
    areaName: "Giza",
    brickDistanceKm: 0.4,
    brickName: "Mohandessin",
    latitude: 30.059482,
    longitude: 31.223145,
    regionName: "Cairo",
  };

  // ── The whole point: address first, then the territory, then the pin ────────────
  const lines = formatEvidenceLocationLines(mohandessin);
  assert.equal(lines.length, 3, "the stamp is exactly three lines");
  assert.equal(
    lines[0],
    "Address: 12 Ahmed Orabi Street, Mohandessin, Giza Governorate",
    "the first line an approver reads is the street address",
  );
  assert.ok(lines[1].includes("Brick: Mohandessin"), "the Phoenix brick is named");
  assert.ok(lines[1].includes("Area: Giza"), "the Phoenix area is named");
  assert.ok(lines[1].includes("Region: Cairo"), "the Phoenix region is named");
  assert.ok(lines[2].startsWith("GPS: "), "the coordinates survive, as the last line");
  assert.ok(lines[2].includes("±12 m"), "and carry the device's accuracy when it reported one");

  // ── A confident match must NOT be qualified — that would train people to ignore it ──
  assert.ok(
    !lines[1].includes("nearest"),
    "a brick 0.4 km away is stated as fact, with no hedge",
  );

  // ── A far brick is the nearest centroid, not a territory. Say so, with the number ──
  const farBrick = formatEvidenceLocationLines({
    ...mohandessin,
    brickDistanceKm: EVIDENCE_BRICK_CONFIDENT_KM + 32,
  });
  assert.ok(
    farBrick[1].includes("(nearest, 42 km away)"),
    "beyond the confidence band the distance is printed, so a nonsense match reads as nonsense",
  );
  assert.ok(farBrick[1].includes("Area: Giza"), "the area is still shown, qualified by the same line");

  // Exactly at the boundary is still confident — the band is inclusive.
  const atBoundary = formatEvidenceLocationLines({
    ...mohandessin,
    brickDistanceKm: EVIDENCE_BRICK_CONFIDENT_KM,
  });
  assert.ok(!atBoundary[1].includes("nearest"), "10 km exactly is inside the confident band");

  // ── Nothing is ever invented when a lookup comes back empty ────────────────────
  const nowhere: EvidenceLocationStamp = {
    accuracyMeters: null,
    address: null,
    areaName: null,
    brickDistanceKm: null,
    brickName: null,
    latitude: 27.180001,
    longitude: 31.189999,
    regionName: null,
  };
  const nowhereLines = formatEvidenceLocationLines(nowhere);
  assert.equal(
    nowhereLines[0],
    `Address: ${EVIDENCE_ADDRESS_UNRESOLVED}`,
    "a failed address lookup says so in words",
  );
  assert.equal(
    nowhereLines[1],
    EVIDENCE_TERRITORY_UNMATCHED,
    "and an unmatched pin never borrows a neighbouring brick's name",
  );
  assert.ok(!nowhereLines[2].includes("±"), "no accuracy is printed when the device withheld it");

  // A partial territory still shows what it has, rather than collapsing to "unmatched".
  const areaOnly = formatEvidenceLocationLines({ ...nowhere, areaName: "Assiut", regionName: "Upper Egypt" });
  assert.equal(
    areaOnly[1],
    "Area: Assiut  ·  Region: Upper Egypt",
    "a known area and region are shown even when the brick is unknown",
  );

  // ── Coordinates read as coordinates: six decimals and an explicit hemisphere ────
  assert.equal(formatCoordinatePair(30.059482, 31.223145), "30.059482°N, 31.223145°E");
  assert.equal(
    formatCoordinatePair(-1.286389, -78.5),
    "1.286389°S, 78.500000°W",
    "a negative coordinate names its hemisphere instead of relying on a minus sign",
  );
  assert.equal(formatCoordinatePair(Number.NaN, 31.2), "unavailable", "a non-finite pin says so");

  // ── The one-line stored label carries the same four facts ──────────────────────
  const label = formatEvidenceLocationLabel(mohandessin);
  assert.equal(
    label,
    "12 Ahmed Orabi Street, Mohandessin, Giza Governorate · Brick Mohandessin · Area Giza · Region Cairo",
    "the stored label is the full address plus brick, area and region",
  );
  assert.equal(
    formatEvidenceLocationLabel(nowhere),
    "Unresolved location at 27.180001°N, 31.189999°E",
    "with nothing resolved the label still says WHERE, rather than 'Location unavailable'",
  );

  // ── HEADLINE: no line may be a bare coordinate pair posing as a place ──────────
  //
  // This is the defect the owner reported. `GPS: …` is exempt — it is labelled as the pin and is
  // deliberately kept as the forensic fine print; what must never happen again is an Address or
  // territory line whose entire content is two numbers.
  const bareCoordinatePair = /^-?\d{1,3}\.\d+,\s*-?\d{1,3}\.\d+$/;
  for (const stamp of [mohandessin, nowhere, { ...mohandessin, address: null }]) {
    for (const line of formatEvidenceLocationLines(stamp)) {
      const [, ...rest] = line.split(": ");
      const value = rest.join(": ");
      assert.ok(
        !bareCoordinatePair.test(value.trim()),
        `no stamp line may read as raw coordinates — got "${line}"`,
      );
    }
  }
}

/**
 * The burned-in panel must GROW to hold its captions.
 *
 * Before 2026-08-23 the panel was a fixed `max(150, 22% of height)` band and the caption was a
 * fixed four lines that happened to fit. The location block turns that into three wrapping lines,
 * and a fifth line drawn past the bottom edge of a JPEG is evidence that no longer exists — there
 * is no scrollbar on a photograph.
 *
 * The canvas is stubbed with a proportional-width model (0.55em per character, close enough to a
 * bold sans-serif for a layout bound), so this runs in plain node with no browser.
 */
export function runEvidencePanelLayoutTests() {
  function stubContext() {
    let size = 15;
    return {
      get font() {
        return `700 ${size}px sans-serif`;
      },
      set font(value: string) {
        size = Number(/(\d+)px/.exec(value)?.[1] ?? 15);
      },
      measureText: (text: string) => ({ width: text.length * size * 0.55 }),
    } as unknown as CanvasRenderingContext2D;
  }

  const longestRealisticCaptions = [
    "Time: 23 Aug 2026, 02:22 pm (Cairo)",
    "Address: 12 Ahmed Orabi Street, off Gameat El Dowal El Arabeya, Mohandessin, Giza Governorate 12411, Egypt",
    "Brick: Mohandessin (nearest, 42 km away)  ·  Area: Giza  ·  Region: Greater Cairo North",
    "GPS: 30.059482°N, 31.223145°E  ·  accuracy ±12 m",
    "HR ID: B-1042 | Draft: 8f2c1a90-4d31-4f0e-9b77-2f5a6c1e0d33",
  ];

  // Landscape 16:9, portrait phone, and a small legacy frame.
  for (const [width, height] of [[1280, 720], [720, 1280], [640, 480]] as const) {
    const layout = computeEvidencePanelLayout(stubContext(), longestRealisticCaptions, width, height);

    assert.ok(layout.lines.length >= longestRealisticCaptions.length, `${width}x${height}: every caption survives wrapping`);
    assert.ok(
      layout.lastBaselineY <= height,
      `${width}x${height}: the last caption's baseline (${layout.lastBaselineY}) must stay inside the ${height}px frame`,
    );
    assert.ok(
      layout.panelHeight >= layout.padding * 2 + layout.titleFont + layout.lineHeight * layout.lines.length,
      `${width}x${height}: the panel is at least as tall as the text it holds`,
    );
    assert.ok(layout.bodyFont >= 9, `${width}x${height}: the font never shrinks below legibility`);
    assert.ok(
      layout.lines.every((line) => !line.includes("...") && !line.includes("…")),
      `${width}x${height}: captions wrap, they are never truncated with an ellipsis`,
    );
  }

  // A short caption keeps the familiar band rather than collapsing to a thin strip.
  const short = computeEvidencePanelLayout(stubContext(), ["Time: 23 Aug 2026, 02:22 pm (Cairo)"], 1280, 720);
  assert.ok(short.panelHeight >= 150, "the historical 150px floor still applies to a one-line caption");

  // An absurd caption shrinks the font instead of spilling off the frame.
  const absurd = computeEvidencePanelLayout(
    stubContext(),
    Array.from({ length: 14 }, (_, index) => `Line ${index + 1}: ${"a very long Egyptian street address ".repeat(3)}`),
    1280,
    720,
  );
  assert.ok(absurd.bodyFont < 15, "an oversized caption block shrinks the body font");
  assert.ok(absurd.lastBaselineY <= 720, "and still lands inside the frame");
}
