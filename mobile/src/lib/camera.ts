import * as ImagePicker from "expo-image-picker";

/**
 * Taking a photo on the handset.
 *
 * THE CAMERA ONLY — NEVER THE GALLERY. `launchCameraAsync` is the single entry point here and
 * `launchImageLibraryAsync` is deliberately not imported, so a picture this app sends was taken now,
 * on this phone, by the person holding it. The web app makes the same choice in
 * `src/components/phoenix-crm/live-photo-capture.tsx` and says why: a photo chosen from a gallery
 * proves nothing, because it can be any image from any day. Adding a "choose from library" button
 * here would quietly retire that property for every screen at once.
 *
 * EVERY OUTCOME IS ORDINARY, so nothing here throws. A tapped-away camera, a refused permission and
 * an oversized file are all normal things that happen to a rep in a pharmacy, and a caller that has
 * to wrap each of them in a try/catch ends up reporting "something went wrong" for all three. The
 * result is a discriminated union instead: the screen matches on it and says the one true thing.
 *
 * WHAT IT DOES NOT DO YET. No location, no watermark. The web app's live photo burns the time, the
 * address, the Phoenix brick/area/region and the coordinates into the image before upload, and its
 * capture opens the camera and the location together because a venue photo without a fix proves
 * nothing about a place. That belongs to the evidence flows — venue validation, the direct-order
 * storefront, the outstation departure photo — and to the GPS phase alongside them. A profile photo
 * is not evidence of a place, so it needs none of it. 🔴 Do NOT wire this module into an evidence
 * flow as it stands: it would produce a picture the desk has no way to trust.
 */

/** Matches `MAX_EMPLOYEE_PHOTO_BYTES` in `src/lib/employees/employee-photo.ts`. */
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

/**
 * What the server will accept, from `isAllowedPhotoContentType`. Checked here as well so an
 * unsupported type is caught before a rep spends upload bandwidth on it in a weak-signal place.
 */
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export type CapturedPhoto = {
  /** A `file://` URI on this device. Not a URL the server can fetch — it is uploaded as bytes. */
  uri: string;
  mimeType: string;
  fileName: string;
  /** Bytes, when the platform reported a size. Android usually does; treat null as unknown. */
  byteSize: number | null;
};

export type CaptureOutcome =
  | { status: "captured"; photo: CapturedPhoto }
  /** The person backed out of the camera. Not an error and never reported as one. */
  | { status: "cancelled" }
  /**
   * Camera permission refused. `canAskAgain` is false once Android stops showing the prompt, and
   * that distinction matters to the person: one is "tap again and allow", the other is "this is now
   * only changeable in Settings", and telling them the wrong one wastes their time.
   */
  | { status: "denied"; canAskAgain: boolean }
  | { status: "too-large"; byteSize: number; limitBytes: number }
  | { status: "unsupported-type"; mimeType: string };

/**
 * A sensible filename when the platform does not supply one.
 *
 * The server derives the stored object's extension from the CONTENT TYPE, not from this name, so
 * this is for the multipart part and for anything a human later reads in a bucket listing — it is
 * never what decides how the file is stored.
 */
function fallbackFileName(mimeType: string): string {
  const extension = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
  return `photo.${extension}`;
}

/**
 * Open the camera and return what the person took.
 *
 * `quality` is 0.7 rather than 1: an unchanged 12-megapixel JPEG routinely clears 5 MB, which the
 * server refuses outright, and a profile photo renders at a fraction of that size anyway. Refusing
 * after the fact would mean the rep framed a photo, waited, and then got told no — so the shrink
 * happens before they can hit the ceiling. The explicit size check below still stands, because
 * `quality` is a hint to the encoder and not a guarantee about the resulting file.
 */
export async function capturePhoto(
  options: { allowsEditing?: boolean; aspect?: [number, number] } = {},
): Promise<CaptureOutcome> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    return { canAskAgain: permission.canAskAgain, status: "denied" };
  }

  const result = await ImagePicker.launchCameraAsync({
    allowsEditing: options.allowsEditing ?? false,
    ...(options.aspect ? { aspect: options.aspect } : {}),
    // "images" only. A video would sail past the size ceiling and no Phoenix surface takes one.
    mediaTypes: "images",
    quality: 0.7,
  });

  if (result.canceled) return { status: "cancelled" };

  const asset = result.assets[0];
  // `assets` is typed non-null on a success result, but an empty array is cheap to survive and
  // expensive to debug from a crash report on someone else's handset.
  if (!asset) return { status: "cancelled" };

  const mimeType = asset.mimeType ?? "image/jpeg";
  if (!ALLOWED_MIME_TYPES.has(mimeType.toLowerCase())) {
    return { mimeType, status: "unsupported-type" };
  }

  const byteSize = typeof asset.fileSize === "number" ? asset.fileSize : null;
  if (byteSize !== null && byteSize > MAX_PHOTO_BYTES) {
    return { byteSize, limitBytes: MAX_PHOTO_BYTES, status: "too-large" };
  }

  return {
    photo: {
      byteSize,
      fileName: asset.fileName ?? fallbackFileName(mimeType),
      mimeType,
      uri: asset.uri,
    },
    status: "captured",
  };
}

/** Human wording for every outcome that is not a photo. Kept here so screens phrase it identically. */
export function describeCaptureFailure(outcome: CaptureOutcome): string | null {
  switch (outcome.status) {
    case "captured":
    case "cancelled":
      return null;
    case "denied":
      return outcome.canAskAgain
        ? "Phoenix needs the camera to take a photo. Tap again and choose Allow."
        : "Camera access is turned off for Phoenix. Turn it on in Android Settings, under Apps, then Phoenix Workforce, then Permissions.";
    case "too-large":
      return `That photo is ${Math.round(outcome.byteSize / (1024 * 1024))} MB. The largest Phoenix accepts is ${Math.round(outcome.limitBytes / (1024 * 1024))} MB.`;
    case "unsupported-type":
      return "That image type cannot be uploaded. Phoenix accepts JPG, PNG and WebP.";
  }
}
