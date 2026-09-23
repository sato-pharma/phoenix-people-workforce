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

export type PortraitOptions = {
  /** Output width in pixels. The card prints the photo 350pt wide, so 1600px is ~330 DPI. */
  width?: number;
  /** Output height. Defaults to a 4:5 portrait of `width`. */
  height?: number;
  /** How much of the surround is thrown out of focus, 0 (none) to 1. */
  defocus?: number;
  /** Grain amplitude, 0 to 1. Print grain hides banding in a flat studio background. */
  grain?: number;
};

export type PolishedPortrait = { buffer: Buffer; width: number; height: number; contentType: "image/jpeg" };

const DEFAULT_WIDTH = 1600;
const PORTRAIT_RATIO = 5 / 4;

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
    const cropped = await sharp(input, { failOn: "none" })
      .rotate() // honour the EXIF orientation a phone wrote; without it portraits arrive sideways
      .resize(width, height, { fit: "cover", position: sharp.strategy.attention })
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

    return { buffer, width, height, contentType: "image/jpeg" };
  } catch {
    return null;
  }
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
