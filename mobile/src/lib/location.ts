import * as Location from "expo-location";

import { EVIDENCE_LOOKUP_TIMEOUT_MS } from "./evidence-stamp";

/**
 * Where the phone is, for an evidence photo. Foreground only, one reading at a time.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. No background location, no tracking, no watching: the app
 * asks for a position at the moment a photo is taken and never otherwise. `app.json` blocks the
 * background-location and location-foreground-service permissions outright, so this cannot grow
 * into a tracker by accident — that would be a different product, with a different conversation
 * with the people carrying the phones, and a Google Play review of its own.
 *
 * NEVER A STALE POSITION. `getLastKnownPositionAsync` is not used, on purpose: the last position the
 * phone happened to remember can be hours old and from another city, which is exactly the wrong
 * thing to stamp on a photo whose whole purpose is to show where it was taken. A fresh reading or
 * none — and "none" is written on the photo in words.
 *
 * NOTHING HERE THROWS. A refused permission, location switched off and a phone that cannot get a
 * fix in time are ordinary things to happen to a rep indoors, and the capture must go on without a
 * position rather than fail — the server FLAGS a departure photo with no position (owner decision)
 * rather than refusing it. So every outcome is a value the caller matches on.
 */

export type LocationAccess =
  /** `servicesOn` is whether the phone's location was switched on once the "turn on" dialog closed. */
  | { granted: true; precise: boolean; servicesOn: boolean }
  /** `canAskAgain` is false once Android stops showing the prompt — only Settings can change it then. */
  | { granted: false; canAskAgain: boolean };

/**
 * Why there is no reading. The server records it with a refused departure photo, for the approver
 * (owner, 2026-09-18: "Record refused tries"), so these are the server's own codes in
 * src/lib/outstation/departure-location-refusals.ts. A test pins every one the app sends to that list.
 */
export type LocationUnavailableReason = "location_off" | "timeout" | "position_unavailable";

export type LocationFix =
  | { status: "fixed"; accuracyMeters: number | null; latitude: number; longitude: number }
  | { status: "no-permission" }
  /** Location is switched off on the phone, or the phone gave no reading within the time allowed. */
  | { status: "unavailable"; reason: LocationUnavailableReason };

/**
 * Ask for location while the app is open, and make sure the phone's location is switched on.
 *
 * Called BEFORE the camera opens, so neither system dialog lands on top of a photo the person has
 * just taken. Turning location on is offered through Android's own dialog; declining it is allowed
 * and simply means the photo is stamped without a position.
 */
export async function prepareLocation(): Promise<LocationAccess> {
  try {
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) {
      return { canAskAgain: permission.canAskAgain, granted: false };
    }

    let servicesOn = await Location.hasServicesEnabledAsync().catch(() => true);
    if (!servicesOn) {
      // Android's "turn on location" dialog. Rejects when the person declines — not an error.
      await Location.enableNetworkProviderAsync().catch(() => undefined);
      // Asked again, so a person who declined is recorded as "location off", not as a slow fix.
      servicesOn = await Location.hasServicesEnabledAsync().catch(() => true);
    }

    // Android 12 lets a person grant only an approximate location. That still stamps a position,
    // but one that can be kilometres out, so the caller says so after the photo is saved.
    return { granted: true, precise: permission.android?.accuracy !== "coarse", servicesOn };
  } catch {
    return { canAskAgain: true, granted: false };
  }
}

/**
 * One fresh reading, or nothing, within the same twelve seconds the web app gives the browser.
 *
 * High accuracy, matching the web's `enableHighAccuracy: true`. The settings dialog is suppressed
 * here because `prepareLocation` already offered it before the camera opened; offering it again
 * would race a dialog against the timer below, and lose.
 */
export async function readCurrentPosition(access: LocationAccess): Promise<LocationFix> {
  if (!access.granted) return { status: "no-permission" };

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), EVIDENCE_LOOKUP_TIMEOUT_MS);
  });

  try {
    const position = await Promise.race([
      Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
        mayShowUserSettingsDialog: false,
      }),
      timeout,
    ]);
    if (!position) return { reason: access.servicesOn ? "timeout" : "location_off", status: "unavailable" };

    const { accuracy, latitude, longitude } = position.coords;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return { reason: "position_unavailable", status: "unavailable" };
    }

    return {
      accuracyMeters: typeof accuracy === "number" && Number.isFinite(accuracy) ? accuracy : null,
      latitude,
      longitude,
      status: "fixed",
    };
  } catch {
    return { reason: access.servicesOn ? "position_unavailable" : "location_off", status: "unavailable" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
