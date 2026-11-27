// ─────────────────────────────────────────────────────────────────────────────────────────────
// CROP A PHOTO OF A NATIONAL ID CARD TO THE CARD, LANDSCAPE (owner, 2026-11-27: "crop exactly to
// the card, no extra picture around it, and make the card landscape — adjust the picture, don't
// take it as it is").
//
// A joining-form photo is a phone shot of a card on a desk: background all round, often upright
// (portrait) or at a slant. The ID page after the bank letter must show the card alone, flat and
// landscape. Four corners of the card — found on the server (`id-card-corners.ts`) and given in
// the order the card READS (top-left of its printed text first) — are warped onto a rectangle in
// the card's own proportion, ISO/IEC 7810 ID-1, 85.6 × 54 mm, with a thin border of the photo kept
// all round so the cut never runs into the card. That one warp removes the
// background, squares a slanted shot and turns a sideways or upside-down card the right way up.
//
// Pure arithmetic on raw RGB pixels: no imaging library, so it is tested to the pixel.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A point in image pixels. */
export type Point = { x: number; y: number };

/** The card's corners in reading order: top-left, top-right, bottom-right, bottom-left. */
export type CardQuad = readonly [Point, Point, Point, Point];

/** ID-1 card proportion, width over height (85.6 mm × 54 mm). */
export const ID_CARD_ASPECT = 85.6 / 54;

/** The long edge of a cropped card, in pixels — ~470 dpi across the card, ~240 across the printed box. */
export const ID_CARD_CROP_WIDTH_PX = 1600;

/**
 * The border kept round the card, as a share of the card's width (owner, 2026-11-27: "never eat a
 * piece of the card — always leave a small bit around it so the cut never runs into the card").
 * 3% of an 85.6 mm card is about 2.5 mm a side: the cut always lands on the desk, never on the card.
 */
export const ID_CARD_BORDER_SHARE = 0.03;

/** The cropped card's size: always landscape, always the card's own proportion. */
export function cardCropSize(width = ID_CARD_CROP_WIDTH_PX): { width: number; height: number } {
  return { height: Math.round(width / ID_CARD_ASPECT), width };
}

function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** The quad's area, by the shoelace formula (absolute). */
export function quadArea(quad: CardQuad): number {
  let twice = 0;
  for (let i = 0; i < 4; i += 1) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    twice += a.x * b.y - b.x * a.y;
  }
  return Math.abs(twice) / 2;
}

/**
 * Can this quad be a card in a photo of this size? Every corner inside the frame (a small allowance
 * for a corner just off the edge), the four turning the same way (convex, not crossed), the card
 * covering at least 8% of the photo, and its sides — the long pair against the short pair — no
 * further from a card's 1.59 than a steep slant explains. Anything else is a misread, and the
 * photo is then printed as it is rather than warped into nonsense.
 */
export function isPlausibleCardQuad(quad: CardQuad, imageWidth: number, imageHeight: number): boolean {
  const slack = 0.03;
  for (const point of quad) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
    if (point.x < -slack * imageWidth || point.x > (1 + slack) * imageWidth) return false;
    if (point.y < -slack * imageHeight || point.y > (1 + slack) * imageHeight) return false;
  }
  const turns = quad.map((point, i) => cross(point, quad[(i + 1) % 4], quad[(i + 2) % 4]));
  if (!(turns.every((turn) => turn > 0) || turns.every((turn) => turn < 0))) return false;
  if (quadArea(quad) < 0.08 * imageWidth * imageHeight) return false;
  const top = distance(quad[0], quad[1]);
  const bottom = distance(quad[3], quad[2]);
  const left = distance(quad[0], quad[3]);
  const right = distance(quad[1], quad[2]);
  const ratio = (top + bottom) / (left + right);
  return ratio > 1.0 && ratio < 2.6;
}

/** Solves the 8×8 system of a homography by Gaussian elimination with partial pivoting. */
function solve(matrix: number[][], vector: number[]): number[] | null {
  const n = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    if (Math.abs(a[pivot][col]) < 1e-12) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = a[row][col] / a[col][col];
      for (let k = col; k <= n; k += 1) a[row][k] -= factor * a[col][k];
    }
  }
  return a.map((row, i) => row[n] / row[i]);
}

/**
 * The projective map taking each `from` point onto the matching `to` point, as the 3×3 matrix
 * [a b c; d e f; g h 1] flattened row by row. Null when the points are degenerate.
 */
export function homography(from: readonly Point[], to: readonly Point[]): number[] | null {
  const matrix: number[][] = [];
  const vector: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const { x, y } = from[i];
    const { x: u, y: v } = to[i];
    matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    vector.push(u);
    matrix.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    vector.push(v);
  }
  const h = solve(matrix, vector);
  return h ? [...h, 1] : null;
}

export function applyHomography(h: readonly number[], point: Point): Point {
  const w = h[6] * point.x + h[7] * point.y + h[8];
  return { x: (h[0] * point.x + h[1] * point.y + h[2]) / w, y: (h[3] * point.x + h[4] * point.y + h[5]) / w };
}

/** Raw interleaved pixels, `channels` bytes each, row by row. */
export type RawImage = { data: Uint8Array; width: number; height: number; channels: number };

/**
 * Warps the card inside `quad` onto a `width` × `height` rectangle, with `border` pixels of the
 * photo kept on every side of it, so the picture is `width + 2·border` × `height + 2·border`. Each
 * output pixel is traced back through the inverse map and sampled bilinearly; a border pixel beyond
 * the photo's own edge reads white.
 */
export function warpCard(source: RawImage, quad: CardQuad, width: number, height: number, border = 0): RawImage | null {
  const b = Math.max(0, Math.round(border));
  const corners: Point[] = [
    { x: b, y: b },
    { x: b + width - 1, y: b },
    { x: b + width - 1, y: b + height - 1 },
    { x: b, y: b + height - 1 },
  ];
  height += 2 * b;
  width += 2 * b;
  // Output → source: sample each output pixel where it lands in the photo.
  const back = homography(corners, quad);
  if (!back) return null;
  const { channels, data, width: sw, height: sh } = source;
  const out = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = applyHomography(back, { x, y });
      const o = (y * width + x) * channels;
      const x0 = Math.floor(p.x);
      const y0 = Math.floor(p.y);
      if (x0 < 0 || y0 < 0 || x0 >= sw - 1 || y0 >= sh - 1) {
        out.fill(255, o, o + channels);
        continue;
      }
      const fx = p.x - x0;
      const fy = p.y - y0;
      const i00 = (y0 * sw + x0) * channels;
      const i10 = i00 + channels;
      const i01 = i00 + sw * channels;
      const i11 = i01 + channels;
      for (let c = 0; c < channels; c += 1) {
        const top = data[i00 + c] * (1 - fx) + data[i10 + c] * fx;
        const bottom = data[i01 + c] * (1 - fx) + data[i11 + c] * fx;
        out[o + c] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return { channels, data: out, height, width };
}

/**
 * Corners read as thousandths of the photo's width and height (how the corner reader answers),
 * turned into pixels. Null unless there are exactly four finite points.
 */
export function quadFromThousandths(points: readonly { x: number; y: number }[], imageWidth: number, imageHeight: number): CardQuad | null {
  if (points.length !== 4) return null;
  const quad = points.map((point) => ({ x: (point.x / 1000) * imageWidth, y: (point.y / 1000) * imageHeight }));
  if (quad.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return null;
  return [quad[0], quad[1], quad[2], quad[3]];
}

/** One channel of pixels, row by row — the photo in grey, for finding the card's edges. */
export type GreyImage = { data: Uint8Array; width: number; height: number };

function greyAt(image: GreyImage, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 >= image.width - 1 || y0 >= image.height - 1) return Number.NaN;
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * image.width + x0;
  const d = image.data;
  const top = d[i] * (1 - fx) + d[i + 1] * fx;
  const bottom = d[i + image.width] * (1 - fx) + d[i + image.width + 1] * fx;
  return top * (1 - fy) + bottom * fy;
}

type Line = { point: Point; direction: Point };

function intersect(a: Line, b: Line): Point | null {
  const det = a.direction.x * b.direction.y - a.direction.y * b.direction.x;
  if (Math.abs(det) < 1e-9) return null;
  const dx = b.point.x - a.point.x;
  const dy = b.point.y - a.point.y;
  const t = (dx * b.direction.y - dy * b.direction.x) / det;
  return { x: a.point.x + t * a.direction.x, y: a.point.y + t * a.direction.y };
}

/** The best straight line through points (total least squares): through their centre, along their spread. */
function fitLine(points: readonly Point[]): Line {
  const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
  const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of points) {
    sxx += (p.x - cx) ** 2;
    sxy += (p.x - cx) * (p.y - cy);
    syy += (p.y - cy) ** 2;
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { direction: { x: Math.cos(angle), y: Math.sin(angle) }, point: { x: cx, y: cy } };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** How far each refined corner may move from the one it was given, as a share of the photo's diagonal. */
const REFINE_MAX_SHIFT = 0.06;
/** The smallest step in grey (0–255) across a card edge that counts as an edge at all. */
const REFINE_MIN_EDGE_STEP = 14;

/**
 * Snaps a corner reading onto the card's real edges. A corner reader places corners to within a few
 * per cent; that error, warped, leaves a sliver of desk along one side or shaves the card's printing.
 * Each side is searched across a narrow band either side of where it was read, at 32 places along
 * it, for the outermost sharp change in grey (never a line printed on the card); a straight line is fitted through the places that agree, and
 * the four lines meet at the four corners. A side with no clear edge (a white card on white paper)
 * keeps the line it was given, and a result that moved too far, or is no longer a card, is dropped
 * for the reading as it came. The corner order — the card's reading order — is never changed.
 */
export function refineCardQuad(grey: GreyImage, quad: CardQuad): CardQuad {
  const diagonal = Math.hypot(grey.width, grey.height);
  const band = Math.max(6, 0.035 * Math.min(grey.width, grey.height));
  const centre = {
    x: quad.reduce((sum, p) => sum + p.x, 0) / 4,
    y: quad.reduce((sum, p) => sum + p.y, 0) / 4,
  };
  const lines: Line[] = [];
  let snapped = 0;
  for (let side = 0; side < 4; side += 1) {
    const a = quad[side];
    const b = quad[(side + 1) % 4];
    const length = distance(a, b);
    const along = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
    let normal = { x: -along.y, y: along.x };
    // The normal points OUT of the card, so "inside" and "outside" mean the same on every side.
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if ((mid.x - centre.x) * normal.x + (mid.y - centre.y) * normal.y < 0) normal = { x: -normal.x, y: -normal.y };
    const found: { point: Point; offset: number; step: number }[] = [];
    for (let k = 0; k < 32; k += 1) {
      const t = 0.12 + (0.76 * k) / 31;
      const base = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      const steps: { offset: number; step: number }[] = [];
      for (let d = -band; d <= band; d += 0.5) {
        const outside = greyAt(grey, base.x + normal.x * (d + 1.5), base.y + normal.y * (d + 1.5));
        const inside = greyAt(grey, base.x + normal.x * (d - 1.5), base.y + normal.y * (d - 1.5));
        const step = Math.abs(outside - inside);
        if (Number.isFinite(step)) steps.push({ offset: d, step });
      }
      // The OUTERMOST strong edge, not the strongest: a line printed on the card can be sharper than
      // the card against the desk, and snapping to it would cut the card (owner, 2026-11-27).
      const strongest = steps.reduce((max, s) => Math.max(max, s.step), 0);
      const best = steps.filter((s) => s.step >= Math.max(REFINE_MIN_EDGE_STEP, 0.6 * strongest)).at(-1) ?? { offset: 0, step: 0 };
      if (best.step >= REFINE_MIN_EDGE_STEP) {
        found.push({ offset: best.offset, point: { x: base.x + normal.x * best.offset, y: base.y + normal.y * best.offset }, step: best.step });
      }
    }
    const given: Line = { direction: along, point: a };
    if (found.length < 10) {
      lines.push(given);
      continue;
    }
    const typical = median(found.map((f) => f.offset));
    const agreeing = found.filter((f) => Math.abs(f.offset - typical) <= Math.max(2, band * 0.25));
    if (agreeing.length >= 10) snapped += 1;
    lines.push(agreeing.length >= 10 ? fitLine(agreeing.map((f) => f.point)) : given);
  }
  if (snapped === 0) return quad;
  const corners: Point[] = [];
  for (let i = 0; i < 4; i += 1) {
    const corner = intersect(lines[(i + 3) % 4], lines[i]);
    if (!corner || distance(corner, quad[i]) > REFINE_MAX_SHIFT * diagonal) return quad;
    corners.push(corner);
  }
  const refined: CardQuad = [corners[0], corners[1], corners[2], corners[3]];
  return isPlausibleCardQuad(refined, grey.width, grey.height) ? refined : quad;
}
