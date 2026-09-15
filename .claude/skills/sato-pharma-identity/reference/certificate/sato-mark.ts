/**
 * The Sato Pharma mark, prepared for the PDF writer.
 *
 * The journey is the one document that leaves the programme and gets attached
 * to a job application, so the company's mark belongs on every page of it —
 * not the company's name set as type, which is what a generated report does
 * when nobody supplied a logo. `public/sato-pharma.png` is the real artwork
 * and is already in the tree; this file is what gets it onto paper.
 *
 * THREE DECISIONS, EACH OF WHICH COULD HAVE GONE THE OTHER WAY.
 *
 * It is decoded here rather than baked into a committed constant, because a
 * 12KB base64 blob in `src/` is a thing nobody can review and that silently
 * stops matching the artwork beside it the first time the artwork is redrawn.
 * `node:zlib` and `node:fs` are Node builtins, so this costs no dependency —
 * and the journey PDF is built on the server only (the export route pins
 * `runtime = "nodejs"`), which is the whole reason that is available.
 *
 * The alpha is flattened against the ground the mark will sit on, rather than
 * carried as a soft mask. Same argument as `mix()` in pdf.ts: transparency in
 * a PDF means an ExtGState or an SMask and a class of reader bug that only
 * appears on print, and the ground here is never in doubt — white paper, or
 * the navy of the cover hero. So there is a prepared copy per ground, and the
 * reverse artwork is used for the dark one because white-out of navy is what
 * the brand does there. The certificate's Arabic watermark is the same
 * machinery asked a slightly different question — the ground is white paper
 * and what varies is how much of the ink survives; see MarkStencil.
 *
 * It can fail and the document still builds. A missing or corrupt file gives
 * `null` and the caller sets the wordmark as type instead, which is exactly
 * the bargain share-card.ts already struck for the same artwork on canvas: the
 * record is the point, and no intern should be handed "your journey could not
 * be built" because a logo did not read.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import type { PdfImage, RgbColor } from "./pdf.ts";

/** The artwork's own proportions, so a caller can give height and get width. */
export const SATO_MARK_RATIO = 355 / 134;

/**
 * The Arabic lockup's, which is a landscape 1.35:1 and used to be a portrait.
 *
 * This is the company's own calligraphic wordmark and it is one line — `ساتو
 * فارما` written through a single elliptical sweep, which is a composition and
 * not a setting, so it cannot be stacked onto two lines the way typeset words
 * can. The file it is measured from is cropped to its own ink and carries no
 * clear space at all, so this ratio and the ink box agree to the pixel; a
 * replacement that arrives padded costs nothing, because `satoMarkInk()` is
 * what the placement actually uses.
 */
export const SATO_ARABIC_RATIO = 1136 / 842;

/**
 * Which artwork to read: the dark mark, the white-out one, or the Arabic.
 *
 * `arabic` is `ساتو فارما` — the company's name in Arabic, and the ornament
 * the certificate carries behind its text. It is a raster and not type for a
 * reason that has nothing to do with taste: Arabic is **shaped**, every letter
 * taking one of four forms depending on its neighbours, and it is written
 * right to left. PDF does neither — a simple font is one byte per glyph in
 * visual order — so setting this as text would mean a shaping engine, a
 * bidirectional reorderer and `/Type0` with Identity-H, all of it to place one
 * fixed decorative string that never changes. A renderer that already does
 * those things produced these pixels once instead.
 *
 * It is **Sato Pharma's own Arabic wordmark**, supplied by the owner on 12 Sep
 * 2026 — calligraphic, one line, a single elliptical sweep through both words.
 * It replaced a typesetting of the same two words in Amiri Bold, which stood in
 * while there was nothing else to use and was a watermark of the right words in
 * the wrong hand. The file is cropped to its own ink, so the frame IS the mark;
 * a padded replacement still lands correctly, because everything that positions
 * it goes through `satoMarkInk()`.
 *
 * A raster of a mark is not font software, so nothing here redistributes a
 * face — which is the whole difference from the certificate's Latin script,
 * where the face itself has to travel inside the PDF.
 */
export type SatoMarkArt = "dark" | "reverse" | "arabic";

const FILES: Record<SatoMarkArt, string> = {
  dark: "sato-pharma.png",
  reverse: "sato-pharma-reverse.png",
  arabic: "sato-pharma-arabic.png",
};

/**
 * Use the artwork as a stencil: take its shape, but not its colour.
 *
 * Only the alpha channel survives — every pixel is drawn in `color` at
 * `strength` of full opacity, flattened against the ground as usual. That is
 * what a watermark needs, and doing it here rather than in the PNG is the same
 * argument this file makes about not baking a base64 blob into `src/`: a tint
 * chosen in code sits next to the palette where a reviewer can read it and
 * change it, where a tint baked into pixels is a number nobody can see and
 * nobody can move without opening an image editor.
 *
 * It is only honest on artwork that is a single flat colour. Passing it the
 * Latin mark would throw away the mark's own colours.
 */
export type MarkStencil = { color: RgbColor; strength: number };

/* One prepared copy per (artwork, ground, stencil) triple, for the life of the
   process.
   Decoding is a megabyte of array work and the answer never changes, so the
   first journey exported after a deploy pays for it and no other one does.
   `null` is cached too — a file that is not there will not be there next
   time either, and retrying it per request would be a filesystem hit on every
   page of every export. */
const prepared = new Map<string, PdfImage | null>();

/**
 * The mark, flattened onto `ground` and ready to hand to `Pdf.image()`.
 *
 * Returns null if the artwork cannot be read or is not the 8-bit RGBA PNG
 * this decoder handles — the caller is expected to have a typeset fallback.
 */
export function satoMark(
  art: SatoMarkArt,
  ground: RgbColor,
  stencil?: MarkStencil,
): PdfImage | null {
  const key = [
    art,
    channels(ground),
    stencil ? `${channels(stencil.color)}@${stencil.strength}` : "as-drawn",
  ].join(":");
  const cached = prepared.get(key);
  if (cached !== undefined) return cached;
  let image: PdfImage | null = null;
  try {
    image = prepare(FILES[art], ground, stencil);
  } catch {
    /* Deliberately swallowed. There is nothing the caller can do about it and
       nothing an intern could do about it either; the fallback is type. */
    image = null;
  }
  prepared.set(key, image);
  return image;
}

/** Where the ink is inside the artwork, as fractions of the file's own frame. */
export type MarkInk = { left: number; top: number; right: number; bottom: number };

/* One measurement per artwork, for the life of the process. It does not depend
   on the ground or the stencil, so it is keyed on the file alone. */
const inkBoxes = new Map<SatoMarkArt, MarkInk | null>();

/**
 * The bounding box of everything the artwork actually draws.
 *
 * Every one of these files carries clear space around the mark - about seven
 * per cent a side on the Latin one - which is correct for a logo and wrong for
 * a layout. A mark placed on a margin by the edges of its file sits indented
 * from everything else on that margin, and a height handed to it is not the
 * height that prints: 13 draws 11.3. Both are invisible in the source and both
 * are the "almost aligned" that reads as a mistake rather than a choice.
 *
 * A caller that has something to align to asks for this and solves for the
 * frame; the journey's running head and the certificate's band do not, because
 * nothing is set against them. It is measured from the file on disk rather
 * than written down, so replacing the artwork moves the layout with it - the
 * same bargain the rest of this module already has. Null when the file cannot
 * be read, which is the condition that puts the caller on its typeset fallback
 * anyway, and type has no clear space to correct for.
 */
export function satoMarkInk(art: SatoMarkArt): MarkInk | null {
  const cached = inkBoxes.get(art);
  if (cached !== undefined) return cached;
  let box: MarkInk | null = null;
  try {
    box = measureInk(FILES[art]);
  } catch {
    box = null;
  }
  inkBoxes.set(art, box);
  return box;
}

function measureInk(file: string): MarkInk | null {
  const decoded = decodeRgba(readFileSync(join(process.cwd(), "public", file)));
  if (!decoded) return null;
  const { width, height, pixels } = decoded;

  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      /* Not a threshold of zero: an exporter leaves a hairline of one- and
         two-per-cent alpha around a curve, and counting that as ink hands back
         the whole frame and quietly undoes the correction. */
      if (pixels[(y * width + x) * 4 + 3] <= 8) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  /* A file with nothing in it is not a mark, and returning a zero-height box
     would divide a caller by zero rather than send it to its fallback. */
  if (x1 < x0 || y1 < y0) return null;

  return {
    left: x0 / width,
    top: y0 / height,
    right: (x1 + 1) / width,
    bottom: (y1 + 1) / height,
  };
}

/** A colour as a cache-key fragment, in the 0-255 the pixels are actually in. */
function channels(color: RgbColor): string {
  return color.map((c) => Math.round(c * 255)).join(",");
}

function prepare(
  file: string,
  ground: RgbColor,
  stencil?: MarkStencil,
): PdfImage | null {
  /* Read out of /public, which is where the artwork already lives for the app
     itself — the alternative is a second copy that drifts from the one the
     login page shows. `next start` runs from the project root, so cwd is it. */
  const png = readFileSync(join(process.cwd(), "public", file));
  const decoded = decodeRgba(png);
  if (!decoded) return null;

  const { width, height, pixels } = decoded;
  const rgb = Buffer.alloc(width * height * 3);
  const bg = ground.map((c) => c * 255);
  const fg = stencil ? stencil.color.map((c) => c * 255) : null;
  for (let i = 0; i < width * height; i++) {
    /* A stencil scales the coverage rather than the colour, which is the only
       way to lighten ink that is correct: a pale mark is ink that covers less
       of the paper, not black paint mixed with white paint. They come to the
       same arithmetic here because the ground IS the paper — but the day this
       is asked for on a tinted ground, scaling the colour would leave a pale
       grey rectangle sitting on it and scaling the coverage will not. */
    const alpha = (pixels[i * 4 + 3] / 255) * (stencil ? stencil.strength : 1);
    for (let c = 0; c < 3; c++) {
      const ink = fg ? fg[c] : pixels[i * 4 + c];
      rgb[i * 3 + c] = Math.round(ink * alpha + bg[c] * (1 - alpha));
    }
  }

  return {
    width,
    height,
    /* latin1 is not a lossy read here: it is the exact byte-per-character
       mapping pdf.ts reverses with `charCodeAt(i) & 0xff` when it lays the
       file out. Any other encoding would corrupt the stream on the way in. */
    data: deflateSync(rgb, { level: 9 }).toString("latin1"),
  };
}

/**
 * Enough of a PNG reader for these two files and no more.
 *
 * 8-bit RGBA, non-interlaced, which is what all three files are and what a
 * designer exporting from Illustrator produces. Anything else returns null rather than
 * guessing — a decoder that half-handles a palette or a 16-bit sample does not
 * fail, it just prints the wrong colours, and that is worse than type.
 */
function decodeRgba(
  png: Buffer,
): { width: number; height: number; pixels: Buffer } | null {
  if (png.length < 8 || png.toString("latin1", 1, 4) !== "PNG") return null;

  let offset = 8;
  let header: { width: number; height: number } | null = null;
  const idat: Buffer[] = [];
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("latin1", offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      const depth = body[8];
      const colorType = body[9];
      const interlace = body[12];
      if (depth !== 8 || colorType !== 6 || interlace !== 0) return null;
      header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4) };
    } else if (type === "IDAT") {
      // Deliberately concatenated: a PNG may split its pixels over any number
      // of IDAT chunks and the zlib stream only makes sense end to end.
      idat.push(Buffer.from(body));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (!header || idat.length === 0) return null;

  const { width, height } = header;
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) return null;

  /* Undo the per-scanline filters. Each row is prefixed with the filter byte
     that was used on it, and every filter is expressed against the byte one
     pixel to the left (a), the byte above (b) and the byte above-left (c) —
     all of which are the ALREADY-RECONSTRUCTED values, which is why this has
     to run in order and cannot be a map. */
  const pixels = Buffer.alloc(height * stride);
  let read = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[read++];
    const row = raw.subarray(read, read + stride);
    read += stride;
    const out = y * stride;
    const above = (y - 1) * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? pixels[out + i - bpp] : 0;
      const b = y > 0 ? pixels[above + i] : 0;
      const c = y > 0 && i >= bpp ? pixels[above + i - bpp] : 0;
      let value = row[i];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        // Paeth: whichever of the three neighbours the linear guess is nearest.
        const guess = a + b - c;
        const da = Math.abs(guess - a);
        const db = Math.abs(guess - b);
        const dc = Math.abs(guess - c);
        value += da <= db && da <= dc ? a : db <= dc ? b : c;
      } else if (filter !== 0) {
        return null;
      }
      pixels[out + i] = value & 0xff;
    }
  }

  return { width, height, pixels };
}
