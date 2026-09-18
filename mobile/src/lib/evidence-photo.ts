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
  readEvidenceLocationStamp,
  type EvidenceLocationResponse,
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
 *   - No location, no photo (owner ruling, 2026-09-18). With location refused the camera never
 *     opens; with no fix in time the photo is dropped before it is stamped or sent. The server
 *     refuses one without a position as well (src/lib/outstation/departure-photo-location.ts), so an
 *     older build that still leaves the coordinates out is told why and stores nothing.
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
      /** Why the position on this photo is rough, when it is — said AFTER, never as a block. */
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

/**
 * Why a departure photo cannot be taken without a position — no location, no photo (owner ruling,
 * 2026-09-18; the server refuses it too, in src/lib/outstation/departure-photo-location.ts). Worded
 * for the cause, so the person knows what to change before taking it again.
 */
function describeMissingLocation(access: LocationAccess): string {
  if (!access.granted) {
    return access.canAskAgain
      ? "A departure photo needs your location, and location was not allowed. Choose Allow, then take the photo again."
      : "A departure photo needs your location, and it is turned off for Phoenix. Turn it on in Android Settings, under Apps, then Phoenix Workforce, then Permissions, then take the photo again.";
  }
  return "A departure photo needs your location, and the phone could not find its position in time. Switch location on, or step somewhere with a clearer signal, then take the photo again.";
}

/**
 * The cause the approver reads for a refused try, as one of the server's codes
 * (src/lib/outstation/departure-location-refusals.ts). `fix` is null when the camera never opened.
 */
function refusedTryReason(
  access: LocationAccess,
  fix: LocationFix | null,
): "permission_denied" | "location_off" | "timeout" | "position_unavailable" {
  if (!access.granted || !fix || fix.status === "no-permission") return "permission_denied";
  return fix.status === "unavailable" ? fix.reason : "position_unavailable";
}

/**
 * Tell Phoenix the departure photo was refused for having no location, and why, so the approver
 * sees the try (owner, 2026-09-18: "Record refused tries"). Nothing else is sent. Best effort: a
 * lost report changes nothing for the person, who is still told what to change. Returns that message.
 */
async function refuseWithoutLocation(
  requestId: number,
  token: string | null,
  access: LocationAccess,
  fix: LocationFix | null,
): Promise<string> {
  try {
    await apiRequest(`/api/outstation/${requestId}/departure-photo/location-refusal`, {
      body: { reason: refusedTryReason(access, fix) },
      method: "POST",
      // Short: this is often a spot with no signal, and the person is waiting to read why.
      timeoutMs: 8_000,
      token,
    });
  } catch {
    // The refusal below is what the person needs.
  }
  return describeMissingLocation(access);
}

/** What to tell the person after a save when the position is rough. Null when it is fine. */
function describeRoughLocation(access: LocationAccess): string | null {
  if (access.granted && !access.precise) {
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
  // No permission can never become a fix, so say so before the camera opens, not after a photo
  // the person has just framed.
  if (!access.granted) return { message: await refuseWithoutLocation(requestId, token, access, null), status: "failed" };

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
  // No location, no photo: nothing is stamped or sent (owner ruling, 2026-09-18).
  if (fix.status !== "fixed") return { message: await refuseWithoutLocation(requestId, token, access, fix), status: "failed" };

  onStep?.("address");
  const place = await lookUpPlace(fix, token);
  const location = readEvidenceLocationStamp(place, fix.latitude, fix.longitude, fix.accuracyMeters);

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
          latitude: fix.latitude,
          locationLabel: location.label,
          longitude: fix.longitude,
        },
        method: "POST",
        // Bytes over a field connection, as `apiUpload` allows for, not a JSON read.
        timeoutMs: 60_000,
        token,
      },
    );
    const summary = response?.review?.summary;
    return {
      locationNote: describeRoughLocation(access),
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
