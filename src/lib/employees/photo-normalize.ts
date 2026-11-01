// Every profile photo is made a portrait BEFORE it is stored.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// People send what they have: a phone screenshot of a passport photo with the phone's black bars
// baked in above and below, a full-length holiday picture, a selfie the phone saved sideways with an
// EXIF tag, a PNG whose transparent surround turns black in a JPEG. The identity card, the rankings,
// the milestone card and the performance card all draw the stored file into a fixed portrait frame
// (`EmployeePortrait`, 0.785 : 1, anchored at the top), so a black bar on the file is a black bar on
// the card — which is what the owner saw on 1 November 2026: a new joiner's face in the lower half of
// her frame under a solid black block.
//
// The fix is at the one door every upload passes through (`uploadEmployeePhoto`), not in the four
// frames that draw it: the stored object IS the portrait. Four moves, in this order:
//
//   1. Upright — honour the EXIF orientation, then flatten any transparency onto white.
//   2. Strip letterbox bars — a flat band of one colour along an edge that ends in a HARD edge
//      spanning most of the width (the photo begins) is a bar and goes. A studio backdrop is also
//      flat, but it ends where the HEAD begins — a narrow change, not a full-width one — so it stays,
//      and the breathing room above the head with it.
//   3. Cut the frame's own ratio — the largest 0.785 : 1 window the picture holds, placed by sharp's
//      `attention` strategy (skin tones, saturation, detail), which on a photograph of a person
//      lands on the face.
//   4. Downscale to at most `EMPLOYEE_PORTRAIT_MAX_WIDTH` and encode as JPEG. Never enlarged.
//
// EVERY STEP IS BEST-EFFORT: sharp failing to load or to read the bytes returns null and the caller
// stores the original as it always did. A photo is never refused for what this module cannot do.
//
// sharp is loaded on demand, never at module load — `employee-photo.ts` is imported by the employee
// directory and so by most of the app and the test suite, and a native library must not sit on
// that path (see `src/lib/hiring-documents/document-scan.ts` for the incident).

export const EMPLOYEE_PORTRAIT_RATIO = 0.785;
export const EMPLOYEE_PORTRAIT_MAX_WIDTH = 1000;
/** Below this the picture is a thumbnail and the crop would be guesswork; it is stored as sent. */
const MIN_SOURCE_EDGE = 48;
/** The probe the bars are measured on — wide enough to see an edge, small enough to be instant. */
const PROBE_WIDTH = 160;
/**
 * A row or column is "flat" when its pixels vary this little (0..255 greyscale). Measured on the
 * first photos this ran on (2026-11-01): a phone's letterbox bar spreads 0.0, a photographed
 * ceiling 3.6 and a plain wall 5–6 — so 3 keeps a bar and leaves every real surface alone.
 */
const FLAT_STDDEV = 3;
/** A flat row belongs to the SAME bar when its mean stays this close to the bar's colour. */
const SAME_BAR_DELTA = 12;
/** A pixel "differs" from the bar when it is this far from its colour. */
const EDGE_PIXEL_DELTA = 10;
/** The bar is a bar only if this share of the first non-flat row differs from it — a head is narrower. */
const HARD_EDGE_SHARE = 0.6;
/** A strip that would throw away more than this of the picture is not believed. */
const MAX_STRIPPED_SHARE = 0.7;

type SharpFactory = typeof import("sharp").default;

let cachedSharp: SharpFactory | null = null;

async function loadSharp(): Promise<SharpFactory> {
  if (!cachedSharp) {
    cachedSharp = (await import("sharp")).default;
  }
  return cachedSharp;
}

export type LetterboxBars = { top: number; bottom: number; left: number; right: number };

export type NormalizedEmployeePhoto = {
  bytes: Buffer;
  contentType: "image/jpeg";
  width: number;
  height: number;
  /** The bars that were stripped, in source pixels (after the EXIF rotation). */
  bars: LetterboxBars;
  /** The upright source size the window was cut from. */
  source: { width: number; height: number };
};

/**
 * Make the bytes a portrait at the frame's ratio. Null when the bytes are not a picture sharp can
 * read, or are too small to crop — the caller then stores what it was given.
 */
export async function normalizeEmployeePhoto(input: Buffer): Promise<NormalizedEmployeePhoto | null> {
  try {
    const sharp = await loadSharp();

    // 1. Upright, opaque, sRGB.
    const upright = await sharp(input, { failOn: "none" })
      .rotate()
      .flatten({ background: "#ffffff" })
      .toColourspace("srgb")
      .toBuffer();
    const meta = await sharp(upright).metadata();
    const srcW = meta.width ?? 0;
    const srcH = meta.height ?? 0;
    if (srcW < MIN_SOURCE_EDGE || srcH < MIN_SOURCE_EDGE) return null;

    // 2. Letterbox bars.
    const bars = await measureLetterboxBars(sharp, upright, srcW, srcH);
    const region = {
      left: bars.left,
      top: bars.top,
      width: srcW - bars.left - bars.right,
      height: srcH - bars.top - bars.bottom,
    };

    // 3. The frame's ratio — the largest window the stripped picture holds.
    const window = portraitWindow(region.width, region.height);
    if (window.width < MIN_SOURCE_EDGE || window.height < MIN_SOURCE_EDGE) return null;

    // 4. Down to the stored size, never up. The window's own sides are kept when it fits — deriving
    //    the height from a floored width loses a pixel (235 / 0.785 rounds to 299, not 300).
    const outW = Math.min(EMPLOYEE_PORTRAIT_MAX_WIDTH, window.width);
    const outH = outW === window.width ? window.height : Math.round((outW * window.height) / window.width);

    const bytes = await sharp(upright)
      .extract(region)
      .resize(outW, outH, { fit: "cover", position: sharp.strategy.attention })
      .jpeg({ quality: 88, chromaSubsampling: "4:4:4", mozjpeg: true })
      .toBuffer();

    return { bytes, contentType: "image/jpeg", width: outW, height: outH, bars, source: { width: srcW, height: srcH } };
  } catch {
    return null;
  }
}

/** The largest `EMPLOYEE_PORTRAIT_RATIO` window inside a `width × height` picture. */
export function portraitWindow(width: number, height: number): { width: number; height: number } {
  if (width / height > EMPLOYEE_PORTRAIT_RATIO) {
    // Wider than the frame: the height is the limit.
    return { width: Math.floor(height * EMPLOYEE_PORTRAIT_RATIO), height };
  }
  // Taller than the frame (the usual phone picture): the width is the limit.
  return { width, height: Math.floor(width / EMPLOYEE_PORTRAIT_RATIO) };
}

/**
 * Measure the flat, hard-edged bars along each edge, in source pixels.
 *
 * Works on a small greyscale probe. Each edge is read independently with its own colour: a phone
 * screenshot has black above and below, a scanned print may have grey on all four sides.
 */
async function measureLetterboxBars(
  sharp: SharpFactory,
  upright: Buffer,
  srcW: number,
  srcH: number,
): Promise<LetterboxBars> {
  const probeW = Math.min(PROBE_WIDTH, srcW);
  const { data, info } = await sharp(upright)
    .resize(probeW, null, { kernel: "nearest" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const px = (x: number, y: number) => data[y * w + x];

  const rowLine = (y: number) => Array.from({ length: w }, (_, x) => px(x, y));
  const colLine = (x: number) => Array.from({ length: h }, (_, y) => px(x, y));

  const top = barDepth(h, (i) => rowLine(i));
  const bottom = barDepth(h - top, (i) => rowLine(h - 1 - i));
  const left = barDepth(w, (i) => colLine(i));
  const right = barDepth(w - left, (i) => colLine(w - 1 - i));

  const scaleX = srcW / w;
  const scaleY = srcH / h;
  // A probe pixel is `scale` source pixels; one extra row/column eats the bar's anti-aliased edge.
  const toSource = (depth: number, scale: number) => (depth > 0 ? Math.min(Math.ceil((depth + 1) * scale), Number.MAX_SAFE_INTEGER) : 0);
  const bars = {
    top: toSource(top, scaleY),
    bottom: toSource(bottom, scaleY),
    left: toSource(left, scaleX),
    right: toSource(right, scaleX),
  };

  const keptW = srcW - bars.left - bars.right;
  const keptH = srcH - bars.top - bars.bottom;
  if (keptW < MIN_SOURCE_EDGE || keptH < MIN_SOURCE_EDGE || (keptW * keptH) / (srcW * srcH) < 1 - MAX_STRIPPED_SHARE) {
    return { top: 0, bottom: 0, left: 0, right: 0 };
  }
  return bars;
}

/**
 * How many lines from one edge are a bar: flat, all of one colour, and ended by a hard edge.
 * `line(i)` is the i-th line in from that edge. Zero when the edge is not a bar.
 */
function barDepth(limit: number, line: (i: number) => number[]): number {
  if (limit < 3) return 0;
  const first = stats(line(0));
  if (first.stddev > FLAT_STDDEV) return 0;
  const colour = first.mean;
  let depth = 1;
  while (depth < limit - 1) {
    const s = stats(line(depth));
    if (s.stddev > FLAT_STDDEV || Math.abs(s.mean - colour) > SAME_BAR_DELTA) break;
    depth += 1;
  }
  if (depth >= limit - 1) return 0; // the whole picture is one flat colour — nothing to strip
  // The line after the bar: a bar ends where the PICTURE begins, across most of the width. A
  // backdrop ends where a head begins, across a little of it.
  const edge = line(depth);
  const differing = edge.filter((v) => Math.abs(v - colour) > EDGE_PIXEL_DELTA).length;
  return differing / edge.length >= HARD_EDGE_SHARE ? depth : 0;
}

function stats(values: number[]): { mean: number; stddev: number } {
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / values.length;
  let sq = 0;
  for (const v of values) sq += (v - mean) * (v - mean);
  return { mean, stddev: Math.sqrt(sq / values.length) };
}
