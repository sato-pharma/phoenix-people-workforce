// The portrait treatment — a photograph, polished, never redrawn.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The identity says REAL PHOTOGRAPHS ONLY (SHARP rule 7). Everything here is a retoucher's move on
// the picture HR already has: a portrait crop, a quiet grade, local contrast, a defocused
// surround, a vignette and print grain. Nothing paints, replaces or beautifies a face.
//
// THE ORDER IS THE POINT, not the filters. Grade before contrast, contrast before defocus, grain
// last — a grain added before a blur is simply erased by it, and local contrast applied after the
// vignette drags the darkened corners back up.
//
// 🔴 THE SURROUND IS A RADIAL FALL-OFF, NOT A CUT-OUT. Real subject segmentation needs a
// neural matte, which is not available in the Node runtime and is not worth a model download for a
// keepsake. A radial mask centred on the upper third does what a portrait lens does — it is honest
// about being an optical effect, and it can never eat a shoulder the way a bad matte does.
//
// EVERY STEP IS BEST-EFFORT. A card for somebody whose photo is missing, corrupt or in a format
// sharp cannot read must still print; `polishPortrait` returns null and the card falls back to its
// monogram plate.

import sharp from "sharp";

/**
 * Where the 4:5 window sits on the photograph, and how far in.
 *
 * `x` and `y` are a fraction of the SLACK in each axis — 0 flush to the left/top edge, 1 flush to
 * the right/bottom, 0.5 dead centre. Deliberately not a pixel offset: the same pair then means the
 * same framing whatever size the photograph is, and it is the same arithmetic the browser does to
 * lay the picture out while somebody drags it. Neither side converts anything, so neither side can
 * drift.
 *
 * 🔴 `zoom` IS WHAT MAKES DRAGGING IN ALL FOUR DIRECTIONS POSSIBLE AT ALL. At zoom 1 the
 * picture is scaled to cover the window exactly, and a rectangle scaled to exactly cover another
 * rectangle overhangs it in ONE axis only — the other is already shown edge to edge, with nothing
 * above or below to reveal. Dragging it there does nothing, and looks broken rather than
 * geometric (the owner, 2026-09-23: "I need dragging up, down, left, right, and any place I
 * want"). Scale past 1 and both axes overhang, so the picture travels freely in every direction.
 * 1 means exactly cover, which is what this module has always done.
 */
export type PortraitFocus = { x: number; y: number; zoom?: number };

/** Past this the photograph is enlarged more than it can carry and the card prints mush. */
const MAX_ZOOM = 4;

export type PortraitOptions = {
  /** Output width in pixels. The card prints the photo 350pt wide, so 1600px is ~330 DPI. */
  width?: number;
  /** Output height. Defaults to a 4:5 portrait of `width`. */
  height?: number;
  /** How much of the surround is thrown out of focus, 0 (none) to 1. */
  defocus?: number;
  /** Grain amplitude, 0 to 1. Print grain hides banding in a flat studio background. */
  grain?: number;
  /**
   * Where to put the window. Omit it and sharp's `attention` strategy chooses, which is the
   * default the card has always printed. Pass one and that choice is replaced outright — this is
   * the person at the keyboard saying where the face goes, and a machine's guess never overrides
   * a human's instruction.
   */
  focus?: PortraitFocus | null;
};

export type PolishedPortrait = {
  buffer: Buffer;
  width: number;
  height: number;
  contentType: "image/jpeg";
  /** The window this portrait was actually cut at — the handed-in focus, or what `attention` chose. */
  focus: PortraitFocus;
};

const DEFAULT_WIDTH = 1600;
const PORTRAIT_RATIO = 5 / 4;
/** The size `portraitFocus` scores at. Small enough to be quick, big enough to score the same. */
const FOCUS_PROBE_WIDTH = 480;

/**
 * Polish a portrait for the card. Returns null when the bytes are not a readable image — the
 * caller falls back rather than failing the whole card.
 */
export async function polishPortrait(
  input: Buffer,
  options: PortraitOptions = {},
): Promise<PolishedPortrait | null> {
  const width = Math.max(320, Math.round(options.width ?? DEFAULT_WIDTH));
  const height = Math.max(400, Math.round(options.height ?? width * PORTRAIT_RATIO));
  const defocus = clamp01(options.defocus ?? 1);
  const grain = clamp01(options.grain ?? 1);

  try {
    // 1. Portrait crop. `attention` lands on the region sharp scores as most interesting, which on
    //    a head-and-shoulders photograph is the face — closer to a human crop than a centre cut.
    //    When a focus is handed in, that guess is not consulted at all.
    const cut = await cutPortrait(input, width, height, options.focus ?? null);
    const cropped = await sharp(cut.buffer)
      .removeAlpha()
      .toColourspace("srgb")
      .toBuffer();

    // 2. The grade. A whisper of warmth and saturation, blacks lifted off zero so the print does
    //    not plug, highlights pulled back so a bright collar keeps its weave.
    const graded = await sharp(cropped)
      .modulate({ saturation: 1.05, brightness: 1.015 })
      .linear(0.955, 255 * 0.028)
      .toBuffer();

    // 3. Local contrast (big radius, low amount) and then true detail sharpening. Two passes,
    //    because one pass cannot do both without halos.
    const sharpened = await sharp(graded)
      .sharpen({ sigma: 6, m1: 0, m2: 0.35 })
      .sharpen({ sigma: 1.1, m1: 0.6, m2: 1.6 })
      .toBuffer();

    // 4. The surround: the same frame, muted, flattened and defocused, so the eye goes to the face.
    const composed = defocus <= 0 ? sharpened : await applyDefocus(sharpened, width, height, defocus);

    // 5. Vignette, then grain. In that order — see the header.
    const vignetted = await applyVignette(composed, width, height);
    const grained = grain <= 0 ? vignetted : await applyGrain(vignetted, width, height, grain);

    const buffer = await sharp(grained)
      .jpeg({ quality: 92, chromaSubsampling: "4:4:4", mozjpeg: true })
      .toBuffer();

    return { buffer, width, height, contentType: "image/jpeg", focus: cut.focus };
  } catch {
    return null;
  }
}

/**
 * Cut the 4:5 window, and say where it landed.
 *
 * 🔴 THE TWO BRANCHES MUST AGREE, or the box somebody drags shows a different picture from the one
 * that prints. `attention` is sharp's own crop and reports its choice back as `cropOffsetTop` /
 * `cropOffsetLeft` — NEGATIVE numbers, in the resized space, counting how much was taken off the
 * top and the left. A focus is applied by resizing to that same cover size and extracting the
 * window by hand, which is the same geometry the browser applies for `object-fit: cover` with an
 * `object-position` percentage. Feed the fractions the first branch reported into the second and
 * the same FRAMING comes back — measured, not assumed — though not the same bytes: one resample
 * is a single cover pass and the other a resize then an extract, so they round differently by a
 * pixel or two. That is why the workspace sends no focus at all until somebody drags one: an
 * untouched card goes down the identical path it always did.
 */
async function cutPortrait(
  input: Buffer,
  width: number,
  height: number,
  focus: PortraitFocus | null,
): Promise<{ buffer: Buffer; focus: PortraitFocus }> {
  const upright = await sharp(input, { failOn: "none" })
    .rotate() // honour the EXIF orientation a phone wrote; without it portraits arrive sideways
    .toBuffer();

  const meta = await sharp(upright).metadata();

  if (!focus) {
    // Nobody has framed this one, so sharp's own `attention` strategy does — at cover size, which
    // is the crop this module has always produced. Its choice is reported back so the box somebody
    // drags can open exactly where the card is already printing.
    const cover = coverSize(meta.width ?? width, meta.height ?? height, width, height, 1);
    const { data, info } = await sharp(upright)
      .resize(width, height, { fit: "cover", position: sharp.strategy.attention })
      .toBuffer({ resolveWithObject: true });
    return {
      buffer: data,
      focus: {
        x: slackFraction(info.cropOffsetLeft, cover.width - width),
        y: slackFraction(info.cropOffsetTop, cover.height - height),
        zoom: 1,
      },
    };
  }

  const zoom = clampZoom(focus.zoom);
  const chosen = { x: clamp01(focus.x), y: clamp01(focus.y), zoom };
  const fit = coverSize(meta.width ?? width, meta.height ?? height, width, height, zoom);
  const buffer = await sharp(upright)
    .resize(fit.width, fit.height)
    .extract({
      left: Math.round((fit.width - width) * chosen.x),
      top: Math.round((fit.height - height) * chosen.y),
      width,
      height,
    })
    .toBuffer();
  return { buffer, focus: chosen };
}

/**
 * The size a source fills a `width × height` window at, covering it in both axes, times `zoom`.
 *
 * At zoom 1 it covers exactly — one axis flush, the other overhanging. Above 1 BOTH overhang,
 * which is the whole reason a zoom exists: slack in both axes is what a drag travels through.
 */
function coverSize(
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
  zoom: number,
): { width: number; height: number } {
  const safeW = Math.max(1, sourceWidth);
  const safeH = Math.max(1, sourceHeight);
  const scale = Math.max(width / safeW, height / safeH) * clampZoom(zoom);
  // Ceil, never round: a rounded-down side lands one pixel short of the window and `extract`
  // throws rather than returning a slightly small picture.
  return { width: Math.max(width, Math.ceil(safeW * scale)), height: Math.max(height, Math.ceil(safeH * scale)) };
}

/**
 * Turn one of sharp's crop offsets into a fraction of that axis's slack.
 *
 * The offsets arrive NEGATIVE — they say how much came off the top and the left — so the sign is
 * dropped. An axis the photograph already fits exactly has no slack and no meaning to a fraction;
 * it reports centred, which is what a zero-width drag range shows anyway.
 */
function clampZoom(zoom: number | undefined): number {
  if (typeof zoom !== "number" || !Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(1, zoom));
}

function slackFraction(offset: number | undefined, slack: number): number {
  if (!Number.isFinite(slack) || slack <= 0) return 0.5;
  return clamp01(Math.abs(offset ?? 0) / slack);
}

/** The polished portrait as a `data:` URI, ready to drop into the card's HTML. */
export async function polishPortraitDataUri(
  input: Buffer,
  options: PortraitOptions = {},
): Promise<string | null> {
  const polished = await polishPortrait(input, options);
  if (!polished) return null;
  return `data:${polished.contentType};base64,${polished.buffer.toString("base64")}`;
}

/**
 * Where the card would put the window if nobody said otherwise — the crop alone, none of the
 * polish.
 *
 * This exists so the box somebody drags can OPEN on the framing the card already prints. Running
 * the whole treatment to learn one pair of numbers would cost six sharp passes over a 1600px
 * image, every time a name is picked, to throw away the picture at the end of it; this runs the
 * one pass that decides the crop, at a size small enough to be quick and large enough for
 * `attention` to score the same regions. Measured on a real 492×691 staff photograph: 0.987 here
 * against 0.996 at full size — under three pixels of a two-thousand-pixel portrait, which is a
 * starting position, not the printed crop.
 */
export async function portraitFocus(input: Buffer): Promise<PortraitFocus | null> {
  try {
    const cut = await cutPortrait(input, FOCUS_PROBE_WIDTH, Math.round(FOCUS_PROBE_WIDTH * PORTRAIT_RATIO), null);
    return cut.focus;
  } catch {
    return null;
  }
}

async function applyDefocus(base: Buffer, width: number, height: number, amount: number): Promise<Buffer> {
  // The surround recedes mostly by LOSING COLOUR, not by blurring. Blur is what a longer lens
  // would do, and more of it starts eating a hand or an elbow that the radial mask counts as
  // background; desaturating and flattening costs nothing geometrically and does most of the work
  // — on this company's photographs the thing competing with a face is almost always foliage.
  const sigma = Math.max(1, (width / 75) * amount);
  const surround = await sharp(base)
    .blur(sigma)
    .modulate({ saturation: 1 - 0.5 * amount, brightness: 1 - 0.04 * amount })
    .linear(1 - 0.2 * amount, 255 * 0.1 * amount) // flatten it so it sits behind the subject
    .toBuffer();

  // A soft ellipse over the upper third — where a head sits in a portrait crop.
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
       <defs>
         <radialGradient id="m" cx="50%" cy="38%" r="76%">
           <stop offset="0%" stop-color="#fff" stop-opacity="1"/>
           <stop offset="52%" stop-color="#fff" stop-opacity="1"/>
           <stop offset="100%" stop-color="#fff" stop-opacity="0"/>
         </radialGradient>
       </defs>
       <rect width="100%" height="100%" fill="url(#m)"/>
     </svg>`,
  );

  const subject = await sharp(base)
    .ensureAlpha()
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();

  return sharp(surround).composite([{ input: subject, blend: "over" }]).toBuffer();
}

async function applyVignette(base: Buffer, width: number, height: number): Promise<Buffer> {
  const vignette = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
       <defs>
         <radialGradient id="v" cx="50%" cy="40%" r="78%">
           <stop offset="0%" stop-color="#000" stop-opacity="0"/>
           <stop offset="62%" stop-color="#000" stop-opacity="0"/>
           <stop offset="100%" stop-color="#000" stop-opacity="0.22"/>
         </radialGradient>
       </defs>
       <rect width="100%" height="100%" fill="url(#v)"/>
     </svg>`,
  );
  return sharp(base).composite([{ input: vignette, blend: "over" }]).toBuffer();
}

async function applyGrain(base: Buffer, width: number, height: number, amount: number): Promise<Buffer> {
  // Seeded, so the same photo grains identically on every run and a reprint matches the first print.
  const noise = Buffer.allocUnsafe(width * height);
  let seed = 0x9e3779b9;
  const spread = 9 * amount;
  for (let i = 0; i < noise.length; i += 1) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed |= 0;
    noise[i] = 128 + Math.round(((seed & 0xffff) / 0xffff - 0.5) * spread);
  }
  const grain = await sharp(noise, { raw: { width, height, channels: 1 } }).png().toBuffer();
  return sharp(base).composite([{ input: grain, blend: "overlay" }]).toBuffer();
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * The fallback when there is no usable photograph: the person's initials. Two letters, never three,
 * and never a code — the card shows a name or it shows nothing (AGENTS.md §4).
 */
export function portraitInitials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? "" : "";
  return `${first}${last}`.toUpperCase();
}
