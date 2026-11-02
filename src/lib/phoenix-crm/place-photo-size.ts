/**
 * Phoenix CRM — how large a signboard photo is stored (owner, 2026-10-18).
 *
 * The audit of the places filed "Not readable" found every place photo stored at 720 x 1280: the
 * camera was asked for 1920 x 1080 and the frame was then drawn through the outstation module's
 * `getCompressedEvidenceCanvasSize`, which caps the long side at 1280. A nameplate three or four
 * metres away came out a few pixels per letter, and the reader read the scale, not the sign.
 *
 * So a capture that frames a signboard (`frameGuide` set) keeps the camera's own frame up to 1920 on
 * the long side, and the camera is asked for 2560 x 1440 so a phone that can give more does. Every
 * other capture keeps the shared evidence size. 🔴 The outstation helper is NOT changed — the owner's
 * rule is to leave the outstation module alone — so the CRM owns this one.
 *
 * A leaf module with no imports: the camera is client code, and the signboard rules pull the name
 * matcher in with them.
 */

/** The long side a signboard photo is stored at, at most. */
export const PLACE_PHOTO_MAX_LONG_SIDE = 1920;

/** What the camera is asked for when it frames a signboard; a phone that cannot give it gives less. */
export const PLACE_PHOTO_CAMERA_IDEAL = { height: 1440, width: 2560 } as const;

/**
 * The canvas a signboard frame is drawn on: the camera's own frame, scaled down only when its long
 * side is past 1920, never up. A frame with no size yet falls back to a 1920 x 1080 landscape.
 */
export function placePhotoCanvasSize(sourceWidth: number, sourceHeight: number): { width: number; height: number } {
  const width = Number.isFinite(sourceWidth) && sourceWidth > 0 ? sourceWidth : 1920;
  const height = Number.isFinite(sourceHeight) && sourceHeight > 0 ? sourceHeight : 1080;
  const scale = Math.min(1, PLACE_PHOTO_MAX_LONG_SIDE / Math.max(width, height));
  return {
    height: Math.max(1, Math.round(height * scale)),
    width: Math.max(1, Math.round(width * scale)),
  };
}

/** `SIGNBOARD_STAMP_WORST_CASE_LINES` and `SIGNBOARD_CROP_MIN_FRACTION`, here because this module is a leaf. */
const STAMP_WORST_CASE_LINES = 8;
const STAMP_CROP_FLOOR = 0.18;

/**
 * The canvas an UPLOADED timetable is drawn on (owner, 2026-11-02): the same size as a framed capture,
 * plus room UNDER the picture for the stamp.
 *
 * 🔴 THE STAMP GOES BELOW AN UPLOAD, NEVER OVER IT, BECAUSE THE READER'S CROP WOULD EAT THE PICTURE.
 * `stampBandFraction` takes 18% to 49% off the bottom of a stored photo before it is read. A rep frames a
 * live photo while looking at it; a file already exists, and on the last try the names at its foot would
 * be cut away unread. So the canvas grows until that crop removes only the added room.
 * `tests/phoenix-crm-timetable-upload.test.ts` holds this against the real crop.
 */
export function uploadedPhotoCanvasSize(sourceWidth: number, sourceHeight: number): { width: number; imageHeight: number; height: number } {
  const { width, height: imageHeight } = placePhotoCanvasSize(sourceWidth, sourceHeight);
  const fontSize = Math.max(16, Math.round(width * 0.022));
  const band = STAMP_WORST_CASE_LINES * Math.round(fontSize * 1.38) + Math.round(fontSize * 0.75) * 2;
  return { width, imageHeight, height: Math.max(imageHeight + band, Math.ceil(imageHeight / (1 - STAMP_CROP_FLOOR))) };
}
