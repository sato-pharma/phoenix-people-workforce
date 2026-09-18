import { Skia } from "@shopify/react-native-skia";
import { Image } from "react-native";

import { ApiError, NetworkError, apiRequest } from "./api";
import { capturePhoto, describeCaptureFailure } from "./camera";
import { EvidenceBurnError, burnEvidencePhoto, type BurnedEvidencePhoto } from "./evidence-burn";
import {
  DEPARTURE_PHOTO_LABEL,
  EVIDENCE_LOOKUP_TIMEOUT_MS,
  EVIDENCE_MAX_UPLOAD_BYTES,
  OUTSTATION_REVERSE_GEOCODE_PATH,
  departurePhotoReference,
  evidenceLocationWithoutFix,
  readEvidenceLocationStamp,
  type EvidenceLocationResponse,
  type ResolvedEvidenceLocation,
} from "./evidence-stamp";
import { prepareLocation, readCurrentPosition, type LocationAccess, type LocationFix } from "./location";

/**
 * The outstation DEPARTURE photo, taken on the phone: the camera, the place, the stamp, the upload.
 *
 * It does what the portal's `DeparturePhotoCard` does (`src/components/outstation/departure-photo-card.tsx`),
 * in the same order and against the same two routes, so a departure photo from either one is the
 * same kind of evidence. Where the two differ, it is because a phone is not a browser:
 *
 *   - Location is asked for BEFORE the camera opens, not after. Android's permission prompt and its
 *     "turn on location" dialog are full-screen system dialogs; landing one on top of a photo the
 *     person has just framed reads as the app losing it.
 *   - The time on the stamp is when the shutter fired. The web reads the clock after the address
 *     lookup, up to 24 seconds later; the moment the photo was taken is the truer of the two.
 *   - With no position, the coordinates are LEFT OUT of the upload rather than sent as null. The
 *     route reads them with `Number(body.latitude)`, and `Number(null)` is 0 — a finite number — so
 *     a null arrives as 0°N 0°E, thousands of kilometres from the trip, and the approver is told
 *     the photo was "taken well away from where the trip was" when the truth is "unknown". Leaving
 *     the keys out gives `Number(undefined)`, which is NaN, which the route turns into null.
 *
 * NO QUEUE. A photo that fails to send is not kept and retried later: a departure photo is only
 * worth anything if it is taken at the destination, and one sent later from somewhere else would
 * carry the right stamp and the wrong journey. The person is told to take it again, while still
 * there.
 */

/** Where the capture has got to, for the button label. */
export type DeparturePhotoStep = "opening" | "locating" | "address" | "stamping" | "sending";

export type DeparturePhotoOutcome =
  | {
      status: "saved";
      /** The server's review of the pair, e.g. "Departure photo captured 1.2 km from the arrival photo…". */
      message: string;
      /** Why the position on this photo is missing or rough, when it is — said AFTER, never as a block. */
      locationNote: string | null;
    }
  /** The person backed out of the camera. Nothing to report. */
  | { status: "cancelled" }
  | { status: "failed"; message: string }
  /** The server stopped accepting this session. The caller signs out. */
  | { status: "session-expired" };

/** The Phoenix mark stamped bottom right — the same file as the portal's `EVIDENCE_LOGO_SRC`. */
const WATERMARK_LOGO = require("../../assets/phoenix/camera-watermark.png") as number;

/**
 * The mark, as bytes. Resolved the way Skia's own `useImage` does it: a bundled asset is a drawable
 * resource in a release build and a URL on the development server, and `Data.fromURI` reads both.
 * A mark that will not load is left off, exactly as the web draws the stamp without it.
 */
async function loadWatermarkLogo() {
  try {
    return await Skia.Data.fromURI(Image.resolveAssetSource(WATERMARK_LOGO).uri);
  } catch {
    return null;
  }
}

/**
 * The address and territory lines for a pin, worded by the server. Best effort, as on the web: any
 * failure — no signal, a slow Google, a refusal — gives null, and the stamp then says in words that
 * the lookup could not run, with the coordinates still on it.
 */
async function lookUpPlace(
  fix: Extract<LocationFix, { status: "fixed" }>,
  token: string | null,
): Promise<EvidenceLocationResponse | null> {
  try {
    return await apiRequest<EvidenceLocationResponse>(OUTSTATION_REVERSE_GEOCODE_PATH, {
      body: { accuracyMeters: fix.accuracyMeters, latitude: fix.latitude, longitude: fix.longitude },
      method: "POST",
      timeoutMs: EVIDENCE_LOOKUP_TIMEOUT_MS,
      token,
    });
  } catch {
    return null;
  }
}

/** What to tell the person after a save when the position is missing or rough. Null when it is fine. */
function describeLocationGap(access: LocationAccess, fix: LocationFix): string | null {
  if (!access.granted) {
    return access.canAskAgain
      ? "Location was not allowed, so this photo was saved without a position and your approver will see that. Choose Allow next time."
      : "Location is turned off for Phoenix, so this photo was saved without a position and your approver will see that. Turn it on in Android Settings, under Apps, then Phoenix Workforce, then Permissions.";
  }
  if (fix.status !== "fixed") {
    return "The phone could not find its position in time, so this photo was saved without one and your approver will see that. Location may be switched off, or the signal is weak here.";
  }
  if (!access.precise) {
    return "Phoenix only has your approximate location, so the position on this photo may be several kilometres out. Allow precise location for Phoenix in Android Settings.";
  }
  return null;
}

/**
 * Take, stamp and send one departure photo. Never throws: every ending is an outcome.
 *
 * `employeeHrId` is the signed-in person's HR ID, the same value the portal stamps
 * (`access.hrId` there, `user.hrId` here).
 */
export async function captureDeparturePhoto(input: {
  employeeHrId: string;
  onStep?: (step: DeparturePhotoStep) => void;
  requestId: number;
  token: string | null;
}): Promise<DeparturePhotoOutcome> {
  const { employeeHrId, onStep, requestId, token } = input;

  // 1. Location permission, then the camera — see the module note for the order.
  onStep?.("opening");
  const access = await prepareLocation();

  // Quality 1: the camera's own file, stamped and compressed once, below — see `capturePhoto`.
  const shot = await capturePhoto({ maxBytes: null, quality: 1 });
  if (shot.status === "cancelled") return { status: "cancelled" };
  if (shot.status !== "captured") {
    return { message: describeCaptureFailure(shot) ?? "The camera could not take the photo.", status: "failed" };
  }
  const capturedAt = new Date().toISOString();

  // 2. Where it was taken.
  onStep?.("locating");
  const fix = await readCurrentPosition(access);

  let location: ResolvedEvidenceLocation;
  if (fix.status === "fixed") {
    onStep?.("address");
    const place = await lookUpPlace(fix, token);
    location = readEvidenceLocationStamp(place, fix.latitude, fix.longitude, fix.accuracyMeters);
  } else {
    location = evidenceLocationWithoutFix();
  }

  // 3. The stamp, burnt into the pixels.
  onStep?.("stamping");
  let stamped: BurnedEvidencePhoto;
  try {
    const [photo, logo] = await Promise.all([Skia.Data.fromURI(shot.photo.uri), loadWatermarkLogo()]);
    stamped = burnEvidencePhoto(Skia, {
      details: {
        capturedAt,
        employeeHrId,
        label: DEPARTURE_PHOTO_LABEL,
        locationLines: location.lines,
        reference: departurePhotoReference(requestId),
      },
      logo,
      photo,
    });
  } catch (error) {
    return {
      message:
        error instanceof EvidenceBurnError
          ? error.message
          : "The photo could not be stamped on this phone. Take it again.",
      status: "failed",
    };
  }

  // 1280 pixels at quality 0.74 lands far below this; the check is here so a phone that somehow
  // produces a larger file hears it from the app rather than as the server's refusal.
  if (stamped.byteLength > EVIDENCE_MAX_UPLOAD_BYTES) {
    return { message: "The stamped photo came out larger than Phoenix accepts. Take it again.", status: "failed" };
  }

  // 4. Send it.
  onStep?.("sending");
  try {
    const response = await apiRequest<{ review?: { summary?: unknown } | null }>(
      `/api/outstation/${requestId}/departure-photo`,
      {
        body: {
          imageDataUrl: `data:image/jpeg;base64,${stamped.base64}`,
          locationLabel: location.label,
          // Present only with a fix — see the module note on why never null.
          ...(fix.status === "fixed" ? { latitude: fix.latitude, longitude: fix.longitude } : {}),
        },
        method: "POST",
        // Bytes over a field connection, as `apiUpload` allows for, not a JSON read.
        timeoutMs: 60_000,
        token,
      },
    );
    const summary = response?.review?.summary;
    return {
      locationNote: describeLocationGap(access, fix),
      message: typeof summary === "string" && summary.trim() ? summary : "Departure photo saved.",
      status: "saved",
    };
  } catch (error) {
    if (error instanceof ApiError && error.isSessionExpired) return { status: "session-expired" };
    if (error instanceof NetworkError) {
      // Covers both "never left the phone" and "sent, but no answer in time" — the second may have
      // been saved, so the person is sent to the list to find out rather than told it failed.
      return {
        message:
          "The photo may not have reached Phoenix — the connection dropped. Pull down to refresh: if this trip is still listed, take the photo again before you leave.",
        status: "failed",
      };
    }
    return {
      message: error instanceof Error && error.message ? error.message : "The departure photo could not be saved.",
      status: "failed",
    };
  }
}
