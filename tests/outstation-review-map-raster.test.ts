import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  RASTER_RENDERING_TYPE,
  buildReviewMapOptions,
  hasConfiguredMapId,
} from "../src/lib/outstation/review-map-options.ts";

/**
 * The outstation route preview must never ask Google for the VECTOR renderer.
 *
 * Over the 60 days to 2026-09-09 every one of the 159 production client errors carrying a
 * `maps.googleapis.com` frame also carried a `webgl.js` frame: 112 on Android, which say
 * `CompileError: call to WebAssembly.instantiate` outright, 39 on iOS and 8 on Windows. The iOS
 * rows are the only ones whose message survives cross-origin masking, so they are the only ones
 * a reader ever sees — which is why this reads as an iOS bug and is not one. A platform-
 * predicated fix would have left 70% of it in place, so there is deliberately NO platform test
 * here to regress.
 */
export function runOutstationReviewMapRasterTests() {
  const center = { lat: 30.0444, lng: 31.2357 };

  // ── Raster is unconditional ─────────────────────────────────────────────────
  const withMapId = buildReviewMapOptions({ center, mapId: "phoenix-map", zoom: 8 });
  assert.equal(withMapId.renderingType, "RASTER");
  assert.equal(RASTER_RENDERING_TYPE, "RASTER"); // google.maps.RenderingType.RASTER's own value

  const withoutMapId = buildReviewMapOptions({ center, mapId: "", zoom: 8 });
  assert.equal(withoutMapId.renderingType, "RASTER");
  assert.equal(buildReviewMapOptions({ center, mapId: null, zoom: 8 }).renderingType, "RASTER");

  // ── A Map ID is passed only when one exists ─────────────────────────────────
  // Google rejects an empty Map ID, and Advanced Markers need a real one.
  assert.equal(withMapId.mapId, "phoenix-map");
  assert.equal("mapId" in withoutMapId, false);
  assert.equal("mapId" in buildReviewMapOptions({ center, mapId: "   ", zoom: 8 }), false);

  // The renderer choice and the marker choice must not be able to disagree, so both read the
  // same emptiness test.
  assert.equal(hasConfiguredMapId("phoenix-map"), true);
  assert.equal(hasConfiguredMapId(""), false);
  assert.equal(hasConfiguredMapId("   "), false);
  assert.equal(hasConfiguredMapId(null), false);
  assert.equal(hasConfiguredMapId(undefined), false);

  // ── The rest of the bag is carried through unchanged ────────────────────────
  assert.deepEqual(withMapId.center, center);
  assert.equal(withMapId.zoom, 8);
  assert.equal(withMapId.mapTypeControl, false);
  assert.equal(withMapId.streetViewControl, false);

  // ── The component must build its options HERE, not inline ───────────────────
  // Pinning the builder is worthless if the map goes back to its own literal, which is exactly
  // what this replaced. Read as a whole file, never a byte window — a source pin that slices a
  // fixed offset false-fails the moment anything above it moves.
  const component = readFileSync(
    new URL("../src/components/outstation/outstation-review-map.tsx", import.meta.url),
    "utf8",
  );
  assert.match(component, /buildReviewMapOptions\(/);
  assert.match(component, /hasConfiguredMapId\(mapId\)/);
  // No second options literal handing `new MapCtor` a bare object.
  assert.doesNotMatch(component, /new MapCtor\(\s*mapElement,\s*\{/);
}
