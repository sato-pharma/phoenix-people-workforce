/**
 * Map options for the outstation route preview — pinned to the RASTER renderer.
 *
 * This one map is rendered on `/employee-portals/submit-expense`, where a rep files a trip
 * claim, and on `/admin/outstation/expense-command`. Google's VECTOR renderer draws it with
 * WebGL and a WebAssembly module, and on the phones this workforce actually carries that
 * renderer fails outright. Measured on production over the 60 days to 2026-09-09, every one of
 * the 159 client errors carrying a `maps.googleapis.com` frame also carried a `webgl.js` frame:
 *
 *   Android  112  `CompileError: call to WebAssembly.instantiate` and masked "Script error."
 *   iOS       39  `null is not an object (evaluating 'z0[c].indexOf')` and friends
 *   Windows    8
 *
 * SO THIS IS NOT AN iOS BUG, which is the shape it first looked like — the iPhone rows are the
 * only ones whose message survives cross-origin masking and reads like real code, so they are
 * the only ones a reader ever sees. Android is 70% of the volume and says WebAssembly outright.
 * A fix predicated on the platform would leave most of it in place.
 *
 * Raster costs this map NOTHING. It draws two markers and a route polyline; it has no tilt, no
 * heading, no WebGL overlay and no 3D marker, which are the only things vector provides. The
 * Map ID is still passed when one is configured, so cloud styling and Advanced Markers are
 * unaffected — a Map ID is what those need, not a vector renderer.
 *
 * Nobody was ever blocked by the failure: both people whose sessions were traced submitted their
 * claim within minutes, for 482.70 and 815 EGP. This removes a broken renderer, not an outage.
 */

/**
 * `google.maps.RenderingType.RASTER`. The enum's values are these exact strings, and the option
 * is read before any library object exists, so the literal is what belongs in the options bag.
 *
 * Two facts from Google's own reference, both load-bearing here. `renderingType` "cannot be set
 * or changed after a map is instantiated", so it has to travel in the constructor's options —
 * which is the whole reason this builder exists rather than a setter. And when it is not set,
 * "the cloud configuration for the map ID will determine the rendering type", which is what was
 * choosing vector for us. Advanced Markers need a Map ID and not a vector map; only marker
 * ALTITUDE is vector-only, and this map places nothing at an altitude.
 */
export const RASTER_RENDERING_TYPE = "RASTER";

export type ReviewMapOptionsInput = {
  center: { lat: number; lng: number };
  /** From NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID. Empty or whitespace means none is configured. */
  mapId: string | null | undefined;
  zoom: number;
};

/**
 * The full options bag for the review map.
 *
 * `mapId` is omitted rather than passed empty: Google rejects an empty Map ID, and the caller
 * uses the same emptiness test to choose between Advanced Markers and the classic constructor,
 * so the two decisions must not be able to disagree.
 */
export function buildReviewMapOptions(input: ReviewMapOptionsInput): Record<string, unknown> {
  const mapId = (input.mapId ?? "").trim();

  return {
    center: input.center,
    ...(mapId ? { mapId } : {}),
    mapTypeControl: false,
    renderingType: RASTER_RENDERING_TYPE,
    streetViewControl: false,
    zoom: input.zoom,
  };
}

/** True when a Map ID is configured, which is what Advanced Markers require. */
export function hasConfiguredMapId(mapId: string | null | undefined): boolean {
  return (mapId ?? "").trim().length > 0;
}
