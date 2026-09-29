/**
 * Read the camera's OWN position at the moment the shutter fires.
 *
 * Shared by every live-capture surface in Phoenix — marketing customer/venue validation,
 * direct-order pharmacy validation, and the outstation departure and wizard photos — so that all
 * of them produce the same evidence shape and one rule governs the lot. See
 * `src/lib/evidence/capture-trust.ts` for why a second, independent fix is the whole point, and
 * for what a null means.
 *
 * ─── NEVER THROWS, NEVER BLOCKS ───────────────────────────────────────────────
 *
 * A refusal, a timeout, a browser with no geolocation, or an Android WebView that silently calls
 * neither callback all resolve to {@link NO_SHUTTER_FIX}. The live photo is the evidence; this
 * reading is a measurement ABOUT it. A rep standing in a shop doorway with a weak signal must
 * never be left holding a frozen camera, and a completed field visit must never fail because a
 * satellite lock did not arrive — that would turn an integrity improvement into lost field work.
 *
 * Callers fire it beside the capture and let it land late; they must not await it before showing
 * the photo.
 */

/** The shutter's own reading. All three null when it could not be taken. */
export type ShutterFix = {
  accuracy: number | null;
  latitude: number | null;
  longitude: number | null;
};

/**
 * The "we did not measure" value.
 *
 * Frozen so a caller cannot mutate the shared singleton into a real-looking reading, which would
 * be indistinguishable downstream from a genuine second measurement.
 */
export const NO_SHUTTER_FIX: ShutterFix = Object.freeze({
  accuracy: null,
  latitude: null,
  longitude: null,
});

/**
 * How long the shutter waits for its own fix before giving up.
 *
 * Short on purpose (see above). The browser is also asked to accept a cached position no older
 * than this, so an indoor handset that already holds a recent fix answers instantly instead of
 * burning the whole window on a fresh satellite lock — and a cached fix from within the last few
 * seconds is still a genuinely independent reading of where the camera is now.
 */
export const SHUTTER_FIX_TIMEOUT_MS = 8000;

export function readShutterFix(): Promise<ShutterFix> {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return Promise.resolve(NO_SHUTTER_FIX);
  }
  return new Promise<ShutterFix>((resolve) => {
    let settled = false;
    const finish = (fix: ShutterFix) => {
      if (settled) return;
      settled = true;
      resolve(fix);
    };
    // Belt and braces: some Android WebViews never call EITHER callback when the page holds the
    // permission but the OS location service is switched off, so the promise would hang for ever
    // and the caller's "photo pending" state would never resolve.
    const timer = setTimeout(() => finish(NO_SHUTTER_FIX), SHUTTER_FIX_TIMEOUT_MS);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        clearTimeout(timer);
        finish({
          accuracy: position.coords.accuracy ?? null,
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });
      },
      () => {
        clearTimeout(timer);
        finish(NO_SHUTTER_FIX);
      },
      {
        enableHighAccuracy: true,
        maximumAge: SHUTTER_FIX_TIMEOUT_MS,
        timeout: SHUTTER_FIX_TIMEOUT_MS,
      },
    );
  });
}
