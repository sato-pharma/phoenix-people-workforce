/**
 * Is anything to be seen in an evidence photo? (owner, 2026-11-23, after the District Manager expense
 * inspection.) Pure and client-safe: the claim form and the departure card measure the camera frame
 * BEFORE the stamp is drawn, and the server measures the stored JPEG (blank-frame-server.ts) with the
 * same numbers, so a blank frame is refused where it is taken and again where it is kept.
 *
 * What it measures: the TOP 55% of the frame — the stamp panel is sized to the bottom 45%
 * (evidence-watermark.ts, `computeEvidencePanelLayout`), so the part measured is the photo itself,
 * never the burned-in text. (A caption long enough to grow the panel past that only puts text into
 * the measured part, which can make a blank photo read as a real one, never the other way.) The
 * part is shrunk to 64×64 grey pixels and read two ways:
 *   - `sd`, the spread of brightness: a black, white or grey frame has almost none;
 *   - `edge`, the mean difference between neighbouring pixels: a covered lens or a blur has no edges.
 *
 * Calibrated on the 378 arrival and departure photos of the July–November inspection (23 Nov 2026):
 * every black, white, covered and grey-blank frame measured edge under 1.0 with sd under 20 (or sd
 * under 5) — 30 photos, among them one white frame filed on three claims — while the darkest real
 * night shot measured sd 27.9 and edge 7. A floor or a wall photographed close (edge 1.5) is NOT
 * blank: it is a real photo of the wrong thing, and the approver reads it.
 *
 * 🔴 TICKETS ARE NOT MEASURED HERE. Real tickets measured sd 7–8 (a white slip on a white table); the
 *    ticket reader (ticket-scan.ts) already refuses a ticket it cannot read.
 */

/** The share of the frame above the stamp panel (which takes 45% at most). */
export const FRAME_TOP_SHARE = 0.55;
/** The measured part is shrunk to this many pixels on each side. */
export const FRAME_SAMPLE_SIZE = 64;
/** Below this edge energy AND below `BLANK_SPREAD_BELOW` spread, nothing can be seen. */
export const BLANK_EDGE_BELOW = 1;
export const BLANK_SPREAD_BELOW = 20;
/** Below this spread the frame is one flat colour, whatever its edges say (sensor noise). */
export const BLANK_FLAT_SPREAD_BELOW = 5;

export type FrameReading = {
  /** True when nothing can be seen in the photo. */
  blank: boolean;
  /** Mean neighbour difference, 0–255. */
  edge: number;
  /** Mean brightness, 0–255. */
  mean: number;
  /** Spread of brightness (standard deviation), 0–255. */
  sd: number;
};

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

export function isBlankFrame(reading: Pick<FrameReading, "edge" | "sd">): boolean {
  return reading.sd < BLANK_FLAT_SPREAD_BELOW || (reading.edge < BLANK_EDGE_BELOW && reading.sd < BLANK_SPREAD_BELOW);
}

/** Reads a grey image (one byte a pixel, row by row). Null for an empty or malformed one. */
export function readFrame(grey: ArrayLike<number>, width: number, height: number): FrameReading | null {
  if (!(width > 1) || !(height > 0) || grey.length < width * height) return null;
  const count = width * height;
  let sum = 0;
  for (let index = 0; index < count; index += 1) sum += grey[index];
  const mean = sum / count;
  let squares = 0;
  for (let index = 0; index < count; index += 1) squares += (grey[index] - mean) ** 2;
  const sd = Math.sqrt(squares / count);
  let edges = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 1; x < width; x += 1) edges += Math.abs(grey[y * width + x] - grey[y * width + x - 1]);
  }
  const edge = edges / (height * (width - 1));
  const reading = { edge: round(edge, 2), mean: round(mean, 1), sd: round(sd, 1) };
  return { ...reading, blank: isBlankFrame(reading) };
}

/** RGBA pixels (a canvas's `ImageData.data`) to grey, with the same weights the server's grey uses. */
export function greyFromRgba(rgba: ArrayLike<number>): Uint8Array {
  const grey = new Uint8Array(Math.floor(rgba.length / 4));
  for (let index = 0; index < grey.length; index += 1) {
    const at = index * 4;
    grey[index] = Math.round(0.2126 * rgba[at] + 0.7152 * rgba[at + 1] + 0.0722 * rgba[at + 2]);
  }
  return grey;
}

/** What the employee is told when the camera frame is blank: what is wrong, then what to do. */
export function blankFrameRefusal(photo: "arrival" | "departure", reading: Pick<FrameReading, "mean">): string {
  const what = photo === "arrival" ? "arrival photo" : "departure photo";
  const cause =
    reading.mean < 40
      ? "it is black — the lens is covered or the place is too dark"
      : reading.mean > 215
        ? "it is white — the lens is pointed at a light or the photo is burned out"
        : "it is one flat colour — the lens is covered or out of focus";
  return `Nothing can be seen in this ${what}: ${cause}. Take it again with the lens clear and the place in view.`;
}

/** The sentence the approver reads on a stored blank photo. */
export function blankFrameSentence(photo: "arrival" | "departure"): string {
  return `The ${photo} photo is blank: nothing can be seen in it.`;
}

/** The stored reading of a photo's metadata, when it has one. */
export function frameOfMetadata(metadata: unknown): FrameReading | null {
  if (!metadata || typeof metadata !== "object") return null;
  const frame = (metadata as { frame?: unknown }).frame;
  if (!frame || typeof frame !== "object") return null;
  const { blank, edge, mean, sd } = frame as Record<string, unknown>;
  if (typeof blank !== "boolean" || typeof edge !== "number" || typeof sd !== "number") return null;
  return { blank, edge, mean: typeof mean === "number" ? mean : 0, sd };
}

/**
 * A photo refused for what is in it — a blank frame, or a car photo whose odometer cannot be read. A 400
 * the employee acts on by taking the photo again, never a server fault (the routes map it like a
 * refused ticket).
 */
export class OutstationPhotoRefusedError extends Error {
  /**
   * "odometer" when the photo was refused for its kilometres. The routes answer it as `odometer_refused`, and
   * the phone counts those refusals so the next photo is kept instead (odometer-scan-rules.ts, owner 2026-11-25).
   */
  readonly reason: "blank" | "odometer";

  constructor(message: string, reason: "blank" | "odometer" = "blank") {
    super(message);
    this.name = "OutstationPhotoRefusedError";
    this.reason = reason;
  }
}

/** The `error` code a route answers for a refused photo: `odometer_refused` is the one the phone counts. */
export function photoRefusalCode(error: unknown): "odometer_refused" | null {
  return error instanceof OutstationPhotoRefusedError && error.reason === "odometer" ? "odometer_refused" : null;
}
