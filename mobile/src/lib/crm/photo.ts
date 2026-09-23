import { Skia } from "@shopify/react-native-skia";
import { Image } from "react-native";

import { ApiError, NetworkError, apiRequest } from "@/lib/api";
import { capturePhoto, describeCaptureFailure } from "@/lib/camera";
import { crmErrorMessage, crmUpload } from "@/lib/crm/client";
import { EvidenceBurnError, burnEvidencePhoto, type BurnedEvidencePhoto } from "@/lib/evidence-burn";
import {
  EVIDENCE_LOOKUP_TIMEOUT_MS,
  EVIDENCE_MAX_UPLOAD_BYTES,
  readEvidenceLocationStamp,
  type EvidenceLocationResponse,
} from "@/lib/evidence-stamp";
import { prepareLocation, readCurrentPosition, type LocationAccess, type LocationFix } from "@/lib/location";

/**
 * Phoenix CRM — a live photo on the phone: the camera, the place, the stamp, the upload.
 *
 * It does what the web's `LivePhotoCapture` (src/components/phoenix-crm/live-photo-capture.tsx) does,
 * in the same order and against the same two routes, so a CRM photo from either one is the same kind
 * of evidence: the time, the street address, the Phoenix brick/area/region and the coordinates are
 * burned into the picture, and the location is captured on the spot.
 *
 * Two things differ because a phone is not a browser, both already settled for the outstation photo
 * (`evidence-photo.ts`, which this mirrors):
 *   - location is asked for BEFORE the camera opens, so no system dialog lands on a framed photo;
 *   - the JPEG is stamped and encoded once by Skia, then sent to `/api/phoenix-crm/photos/upload` as a
 *     base64 data URL, because this build cannot PUT binary to a Supabase signed URL. The server issues
 *     the slot and stores the bytes; the slot's issue time is still the capture time a visit is dated by.
 *
 * NO LOCATION, NO PHOTO. A CRM place and a CRM visit both need a usable fix (the server refuses a save
 * without one — `parseCapturedFix` in entry-rules.ts), so with location refused the camera never opens
 * and with no fix in time the photo is dropped before it is stamped or sent, and the person is told
 * what to change while still at the door.
 *
 * The stamp is drawn by the same parity-pinned pipeline the outstation photo uses (`evidence-burn.ts`
 * + `evidence-stamp.ts`); only the title differs, so a CRM photo reads "Phoenix Workforce — CRM visit"
 * with the customer's name on its reference line. That geometry is human-facing evidence, not data, so
 * it is not itself pinned to the web's CRM stamp — the two only have to say the same facts.
 */

export type CrmPhotoStep = "opening" | "locating" | "address" | "stamping" | "sending";

/** The upload the screens keep: the stored path plus what a save and a preview need. */
export type CrmCapturedPhoto = {
  path: string;
  /** A `file://` URI to show the thumbnail; not a URL the server can fetch. */
  previewUri: string;
  lat: number;
  lon: number;
  accuracyMeters: number | null;
  deviceCapturedAt: string;
  /** The single-line place label the stamp resolved, for the "at …" caption under the photo. */
  locationLabel: string;
};

export type CrmPhotoOutcome =
  | { status: "captured"; photo: CrmCapturedPhoto }
  /** The person backed out of the camera. Nothing to report. */
  | { status: "cancelled" }
  | { status: "failed"; message: string }
  /** The server stopped accepting this session. The caller signs out. */
  | { status: "session-expired" };

/** The Phoenix mark burned bottom-right — the same asset the outstation photo uses. */
const WATERMARK_LOGO = require("../../../assets/phoenix/camera-watermark.png") as number;

async function loadWatermarkLogo() {
  try {
    const source = Image.resolveAssetSource(WATERMARK_LOGO);
    return source ? await Skia.Data.fromURI(source.uri) : null;
  } catch {
    return null;
  }
}

/** The address and territory lines for a pin, worded by the server. Best effort, as on the web. */
async function lookUpPlace(fix: Extract<LocationFix, { status: "fixed" }>, token: string | null): Promise<EvidenceLocationResponse | null> {
  try {
    // `/api/phoenix-crm/location` answers `{ location, success }`; the stamp reader takes the whole
    // envelope and reads `.location`, so the two agree with no reshaping here.
    return await apiRequest<EvidenceLocationResponse>("/api/phoenix-crm/location", {
      body: { accuracyMeters: fix.accuracyMeters, latitude: fix.latitude, longitude: fix.longitude },
      method: "POST",
      timeoutMs: EVIDENCE_LOOKUP_TIMEOUT_MS,
      token,
    });
  } catch {
    return null;
  }
}

/** Why a CRM photo cannot be taken without a position, worded for the cause. */
function describeMissingLocation(access: LocationAccess): string {
  if (!access.granted) {
    return access.canAskAgain
      ? "A live photo needs your location, and location was not allowed. Choose Allow, then take the photo again."
      : "A live photo needs your location, and it is turned off for Phoenix. Turn it on in Android Settings, under Apps, then Phoenix Workforce, then Permissions, then take the photo again.";
  }
  return "A live photo needs your location, and the phone could not find its position in time. Step somewhere with a clearer signal, then take the photo again.";
}

/**
 * Take, stamp and send one Phoenix CRM live photo. Never throws: every ending is an outcome.
 *
 * `purpose` is "place" when validating a customer, "visit" when entering a visit — the server issues
 * the matching slot. `title` is the name burned onto the reference line (the customer's name).
 */
export async function captureCrmPhoto(input: {
  purpose: "place" | "visit";
  seatId: string;
  test: boolean;
  employeeHrId: string;
  /** The customer's name, put on the reference line so the photo names who it is of. */
  title: string;
  token: string | null;
  onStep?: (step: CrmPhotoStep) => void;
}): Promise<CrmPhotoOutcome> {
  const { purpose, seatId, test, employeeHrId, title, token, onStep } = input;

  onStep?.("opening");
  const access = await prepareLocation();
  if (!access.granted) return { message: describeMissingLocation(access), status: "failed" };

  // Quality 1, no size cap: the stamp redraws and encodes the frame once (see `capturePhoto`).
  const shot = await capturePhoto({ maxBytes: null, quality: 1 });
  if (shot.status === "cancelled") return { status: "cancelled" };
  if (shot.status !== "captured") {
    return { message: describeCaptureFailure(shot) ?? "The camera could not take the photo.", status: "failed" };
  }
  const capturedAt = new Date().toISOString();

  onStep?.("locating");
  const fix = await readCurrentPosition(access);
  if (fix.status !== "fixed") return { message: describeMissingLocation(access), status: "failed" };

  onStep?.("address");
  const place = await lookUpPlace(fix, token);
  const location = readEvidenceLocationStamp(place, fix.latitude, fix.longitude, fix.accuracyMeters);

  onStep?.("stamping");
  let stamped: BurnedEvidencePhoto;
  try {
    const [photo, logo] = await Promise.all([Skia.Data.fromURI(shot.photo.uri), loadWatermarkLogo()]);
    stamped = burnEvidencePhoto(Skia, {
      details: {
        capturedAt,
        employeeHrId,
        label: purpose === "place" ? "CRM customer" : "CRM visit",
        locationLines: location.lines,
        reference: title,
      },
      logo,
      photo,
    });
  } catch (error) {
    return {
      message: error instanceof EvidenceBurnError ? error.message : "The photo could not be stamped on this phone. Take it again.",
      status: "failed",
    };
  }

  if (stamped.byteLength > EVIDENCE_MAX_UPLOAD_BYTES) {
    return { message: "The stamped photo came out larger than Phoenix accepts. Take it again.", status: "failed" };
  }

  onStep?.("sending");
  try {
    const uploaded = await crmUpload<{ path: string; issuedAt: string }>(
      "/api/phoenix-crm/photos/upload",
      "photo",
      { imageDataUrl: `data:image/jpeg;base64,${stamped.base64}`, purpose, seatId, test },
      token,
    );
    return {
      photo: {
        accuracyMeters: fix.accuracyMeters,
        deviceCapturedAt: capturedAt,
        lat: fix.latitude,
        locationLabel: location.label,
        lon: fix.longitude,
        path: uploaded.path,
        previewUri: shot.photo.uri,
      },
      status: "captured",
    };
  } catch (error) {
    if (error instanceof ApiError && error.isSessionExpired) return { status: "session-expired" };
    if (error instanceof NetworkError) {
      return { message: "The photo did not reach Phoenix — the connection dropped. Take it again where the signal is better.", status: "failed" };
    }
    return { message: crmErrorMessage(error), status: "failed" };
  }
}
