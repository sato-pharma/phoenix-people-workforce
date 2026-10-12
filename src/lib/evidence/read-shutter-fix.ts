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
 * Short on purpose (see above): the worst case is one null, and a null is honest.
 */
export const SHUTTER_FIX_TIMEOUT_MS = 8000;

/**
 * 🔴 ZERO, AND IT MUST STAY ZERO: THIS READING IS ONLY WORTH TAKING IF IT IS A SECOND READING.
 *
 * Until 2026-10-12 this was `SHUTTER_FIX_TIMEOUT_MS`, on the reasoning that "a cached fix from
 * within the last few seconds is still a genuinely independent reading of where the camera is
 * now". It is not. The Capture-location pin is taken moments earlier with `maximumAge: 0`
 * (src/components/phoenix-crm/capture-location.tsx), the browser caches that result as the last
 * known position, and `getCurrentPosition` with an 8-second grace then handed the SAME position
 * straight back — so the shutter's "own" reading was a copy of the pin, down to the 13-decimal
 * accuracy figure.
 *
 * MEASURED ON PRODUCTION, the day the comparison first had enough rows to speak: of 141 places
 * whose two readings were compared, 127 carried `photo_pin_identical` — bit-for-bit the same
 * reading — and 119 of those 127 had their two timestamps EIGHT SECONDS OR LESS apart, exactly
 * this window. 105 of the 127 reported an accuracy better than 100 m, so it was not coarse-fix
 * handsets: it was this option. The photo-versus-pin detector, built on 2026-10-08 to catch a
 * place whose two readings disagree, was comparing one reading with itself on 89% of places.
 *
 * It is the same defect #4781 removed one layer up — defaulting the photo fix to the pin when the
 * shutter read nothing — surviving in the browser's cache instead of in our own code. A fresh read
 * that times out resolves to {@link NO_SHUTTER_FIX}, and the caller treats that as "not measured"
 * rather than as corroboration, which is the outcome this file's header asks for.
 */
export const SHUTTER_FIX_MAX_AGE_MS = 0;

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
        maximumAge: SHUTTER_FIX_MAX_AGE_MS,
        timeout: SHUTTER_FIX_TIMEOUT_MS,
      },
    );
  });
}
