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
