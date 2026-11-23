/**
 * The server half of blank-frame.ts: measures a stored evidence JPEG exactly as the calibration did —
 * the top 55% of the image, greyscale, shrunk to 64×64 — and reads it with the same pure rule.
 *
 * 🔴 IT NEVER COSTS THE EMPLOYEE HIS CLAIM FOR THE SYSTEM'S OWN FAULT. A photo it cannot open is
 *    `null`, and `null` refuses nothing: only a photo that WAS measured and IS blank is refused.
 *
 * WHY `sharp` IS IMPORTED INSIDE THE FUNCTION: a top-level import of the native module has 500ed a
 * whole page once already when the binary did not load (photo-dupes.ts). Loaded lazily, a missing
 * binary costs one unmeasured photo, never the submit route.
 */

import { FRAME_SAMPLE_SIZE, FRAME_TOP_SHARE, readFrame, type FrameReading } from "@/lib/outstation/blank-frame";

export async function measureEvidencePhoto(bytes: Buffer): Promise<FrameReading | null> {
  try {
    const { default: sharp } = await import("sharp");
    const meta = await sharp(bytes).metadata();
    const width = Number(meta.width ?? 0);
    const height = Number(meta.height ?? 0);
    if (!(width > 1) || !(height > 1)) return null;
    const top = Math.max(1, Math.floor(height * FRAME_TOP_SHARE));
    const grey = await sharp(bytes)
      .extract({ height: top, left: 0, top: 0, width })
      .greyscale()
      .resize(FRAME_SAMPLE_SIZE, FRAME_SAMPLE_SIZE, { fit: "fill" })
      .raw()
      .toBuffer();
    return readFrame(grey, FRAME_SAMPLE_SIZE, FRAME_SAMPLE_SIZE);
  } catch {
    return null;
  }
}
