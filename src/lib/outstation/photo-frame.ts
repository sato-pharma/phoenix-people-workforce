/**
 * Does an outstation evidence photo actually carry a PICTURE?
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * The evidence gate checks that a photo EXISTS. It has never checked that the frame shows
 * anything, so a photo taken with the lens covered — or fired before the camera exposed — satisfies
 * it completely. The approver then opens a black rectangle with the Phoenix overlay printed on it
 * and has no way to tell that apart from a genuinely dark room.
 *
 * Measured on production 2026-09-29, 60 arrival photos, mean luminance of the TOP HALF of each
 * frame (the overlay text sits in the bottom half and would otherwise lift every reading):
 *
 *   - OUTSTATION-151 (AI-0014)  mean 0    max 0     — literally nothing
 *   - OUTSTATION-148 (AI-0013)  mean 2    max 5     — both its photos, 07:50 and 08:04, in Cairo
 *   - OUTSTATION-129 (B-119)    mean 31.7 max 42    — a real, genuinely dark photo
 *   - the brightest (A-7)       mean 244            — ordinary daylight
 *
 * So 2 of 60. Rare, and not one traveller's device: AI-0013's other trips read 178 and 180.
 *
 * ── What this is NOT ─────────────────────────────────────────────────────────
 *
 * 🔴 It never refuses, and it never reaches the rep. THE CRM GOLDEN RULE #1 — the rep's app is
 * easy and BLIND, and he is never made to feel checked — so this is measured on the APPROVER's
 * side, from the image the approver is already looking at. Nothing is added to the capture screen,
 * no retake is demanded, and no flag of any kind travels back to the traveller.
 *
 * 🔴 It is not an accusation. A dark photo is not a false one: a stairwell, a night trip and a
 * thumb over the lens produce the same frame, and only a person can tell them apart. The sentence
 * says what the FRAME contains and stops there — the same rule the departure review follows, which
 * "NEVER refuses the photo ... so an employee with a poor GPS fix is never stranded".
 *
 * The thresholds are set so an honest dark photo cannot trip them. The darkest real photo on
 * production reads mean 31.7 / max 42; the ceiling here is mean 8 / max 24, which leaves that one
 * a factor of four of room on the mean and nearly double on the peak. A false positive here would
 * tell an approver that real evidence is blank, which is worse than missing the rare black frame.
 *
 * Pure: the caller supplies the two numbers, so this is testable with no image and no browser.
 */

/** Whether the frame carries a picture. */
export type PhotoFrameVerdict =
  /** There is something in the frame. */
  | "has-image"
  /** The frame is black — no detail anywhere, not merely dark. */
  | "no-image"
  /** It could not be measured, so nothing may be claimed about it. */
  | "unknown";

export type PhotoFrame = {
  /** One neutral sentence for the approver, or null when there is nothing to say. */
  headline: string | null;
  verdict: PhotoFrameVerdict;
};

/**
 * Mean luminance at or above which a frame is never called blank, whatever its peak.
 * The darkest REAL photo on production reads 31.7.
 */
export const BLANK_FRAME_MEAN_CEILING = 8;

/**
 * Peak luminance at or above which a frame is never called blank, whatever its mean. A single
 * bright pixel is detail; a black frame has none. The darkest real photo peaks at 42.
 */
export const BLANK_FRAME_MAX_CEILING = 24;

/**
 * Classify a measured frame.
 *
 * Both readings are 0-255. They must come from the frame ONLY — measure the top half, or otherwise
 * exclude the Phoenix overlay, which is white text on black and lifts the mean of even a dead
 * frame. `null` for either reading means the measurement failed, and the answer is "unknown": a
 * photo that could not be read is not a photo that is blank.
 */
export function classifyPhotoFrame(input: {
  maxLuminance: number | null | undefined;
  meanLuminance: number | null | undefined;
}): PhotoFrame {
  const mean = input.meanLuminance;
  const max = input.maxLuminance;
  const measured =
    typeof mean === "number" && Number.isFinite(mean)
    && typeof max === "number" && Number.isFinite(max);

  if (!measured) return { headline: null, verdict: "unknown" };

  // BOTH have to be at the floor. Either one alone is an ordinary dark photograph.
  if (mean < BLANK_FRAME_MEAN_CEILING && max < BLANK_FRAME_MAX_CEILING) {
    return {
      headline:
        "This photo carries no image — the frame is black, with no detail anywhere in it. The time, "
        + "place and GPS stamped on it are still recorded. Judge the trip on its other evidence.",
      verdict: "no-image",
    };
  }

  return { headline: null, verdict: "has-image" };
}

/**
 * The attribute the PDF marks its photos with, so the measurement below can find them in the
 * rendered document and report a reading per photo, in order.
 */
export const PHOTO_FRAME_INDEX_ATTRIBUTE = "data-photo-index";

/**
 * The measurement, as a script the PDF's own Chromium page can run.
 *
 * 🔴 IT SHIPS `measureImageFrame` ITSELF, via `toString()`, rather than a second copy written out
 * in the PDF route. Two implementations of one measurement is how a flag comes to appear on the
 * screen and not on the document that claims to BE that screen — and the divergence would be
 * invisible, because both would keep producing plausible numbers.
 *
 * This is why `measureImageFrame` must stay self-contained: a reference to anything outside its own
 * body — a module constant, an import, a helper — is not carried by `toString()` and would throw
 * `ReferenceError` inside the page, where it degrades to "unknown" and silently prints nothing.
 * Pinned by a test that reads the function's own source.
 */
export function photoFrameMeasurementScript(): string {
  return `(async () => {
  const measureImageFrame = ${String(measureImageFrame)};
  const images = Array.from(document.querySelectorAll("img[${PHOTO_FRAME_INDEX_ATTRIBUTE}]"));
  // DECODE FIRST, because the caller loads the document with domcontentloaded, which fires before
  // an image is necessarily ready — and an image that is not ready has naturalWidth 0, which the
  // measurement correctly reports as "could not be read". That failure would be invisible: no note
  // would print, and a document with nothing to say looks exactly like a document with no blank
  // photo in it.
  //
  // Measured 2026-09-29: the race did NOT reproduce here. Chromium had inline data URIs ready by
  // the time evaluate ran, at 16x16 and again at 1800x1800, so removing this line changed no
  // reading. It is kept as insurance rather than as a proven fix — it costs one already-settled
  // promise per photo, and the alternative is relying on a decode order nothing guarantees.
  await Promise.all(images.map((image) => image.decode().catch(() => undefined)));
  return images.map((image) => ({
    index: Number(image.getAttribute("${PHOTO_FRAME_INDEX_ATTRIBUTE}")),
    reading: measureImageFrame(image),
  }));
})()`;
}

/**
 * Measure a loaded image in the browser: mean and peak luminance of its TOP HALF.
 *
 * The top half only, because the Phoenix overlay — white text and the crest on black — sits in the
 * bottom half and lifts both readings on a frame that is otherwise dead. Downsampled to a small
 * canvas: the question is whether there is ANY light in the frame, and a 120x120 sample answers it
 * as well as four megapixels would, for a fraction of the work.
 *
 * Returns nulls rather than throwing when the canvas cannot be read — a cross-origin image taints
 * it, and a tainted canvas must read as "unknown", never as "blank".
 */
export function measureImageFrame(
  image: HTMLImageElement,
  createCanvas: () => HTMLCanvasElement = () => document.createElement("canvas"),
): { maxLuminance: number | null; meanLuminance: number | null } {
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (!width || !height) return { maxLuminance: null, meanLuminance: null };

  try {
    const sample = 120;
    const canvas = createCanvas();
    canvas.width = sample;
    canvas.height = sample;
    const context = canvas.getContext("2d");
    if (!context) return { maxLuminance: null, meanLuminance: null };

    context.drawImage(image, 0, 0, width, Math.max(1, Math.floor(height / 2)), 0, 0, sample, sample);
    const { data } = context.getImageData(0, 0, sample, sample);

    let total = 0;
    let peak = 0;
    for (let i = 0; i < data.length; i += 4) {
      // Rec. 709 luma: the eye's own weighting, so a dim green frame is not called black.
      const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      total += luma;
      if (luma > peak) peak = luma;
    }
    return {
      maxLuminance: Math.round(peak),
      meanLuminance: Number((total / (data.length / 4)).toFixed(1)),
    };
  } catch {
    // A tainted canvas throws on getImageData. Unknown, never blank.
    return { maxLuminance: null, meanLuminance: null };
  }
}
