/**
 * A TrueType face, read off disk and prepared for the PDF writer.
 *
 * This is the first font this project embeds, and it exists for exactly one
 * line of type: the intern's name on their certificate, which the owner ruled
 * on 12 Sep 2026 should be set in a calligraphic script. Helvetica cannot do
 * that and neither can any of the other thirteen faces a PDF reader is
 * required to carry, so the face has to travel inside the file.
 *
 * WHY IT IS A SEPARATE FILE. pdf.ts writes PDFs; it does not parse font
 * binaries, in the same way it does not decode PNGs. sato-mark.ts reads the
 * artwork and hands over a `PdfImage`; this reads the sfnt and hands over a
 * `PdfFont`. The writer stays a writer, and the two things that can fail
 * because a file on disk is missing or malformed both fail in their own file
 * and both return null.
 *
 * WHAT IT UNDERSTANDS. Six tables — `head`, `hhea`, `hmtx`, `cmap`, `OS/2`
 * and `post` — which between them give every number a PDF font dictionary and
 * its descriptor require. It does NOT understand `glyf`, `loca` or anything
 * else about the outlines, because it does not have to: `/FontFile2` hands the
 * whole sfnt to the reader and the reader draws it. That is also why there is
 * no subsetting here. Subsetting means rebuilding `glyf`, `loca`, `hmtx` and
 * `cmap` from a glyph set and recomputing three checksums — a few hundred
 * lines whose failure mode is a file that opens with the wrong letters in it —
 * to save perhaps 40KB on a document nobody has ever complained about the size
 * of. If a future face is a megabyte, subset it then and test it by looking at
 * the page.
 *
 * OpenType/CFF (`OTTO`) is refused rather than half-handled: its outlines are
 * PostScript and belong in `/FontFile3` behind a different subtype, and a
 * reader handed CFF bytes under `/FontFile2` renders nothing at all. Pick the
 * TTF build of a face, or this returns null and the caller sets the name in
 * Helvetica Bold, which is what it did before there was a script at all.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { charForWinAnsi, type PdfFont } from "./pdf.ts";

/* One prepared face per file, for the life of the process — the same bargain
   sato-mark.ts strikes, for the same reason: the answer never changes, and a
   font is a bigger read than a logo. `null` is cached too, so a missing file
   is one filesystem miss per deploy rather than one per certificate. */
const prepared = new Map<string, PdfFont | null>();

/**
 * The named face from `public/fonts`, ready to hand to `Pdf.text()`.
 *
 * Returns null when the file is absent or is not a TrueType-outline font, and
 * says nothing about it — the caller's fallback is a different typeface, not
 * an error page. `next start` runs from the project root, so `process.cwd()`
 * is it, exactly as the mark relies on.
 */
export function pdfFont(file: string): PdfFont | null {
  const hit = prepared.get(file);
  if (hit !== undefined) return hit;
  let font: PdfFont | null = null;
  try {
    font = parseTrueType(readFileSync(join(process.cwd(), "public", "fonts", file)));
  } catch {
    font = null;
  }
  prepared.set(file, font);
  return font;
}

/* --------------------------------------------------------------- the sfnt -- */

/** The sfnt table directory: a tag mapped to its slice of the file. */
function tables(view: DataView): Map<string, { at: number; length: number }> {
  const found = new Map<string, { at: number; length: number }>();
  const count = view.getUint16(4);
  for (let i = 0; i < count; i++) {
    const record = 12 + i * 16;
    if (record + 16 > view.byteLength) break;
    let tag = "";
    for (let b = 0; b < 4; b++) {
      tag += String.fromCharCode(view.getUint8(record + b));
    }
    found.set(tag, {
      at: view.getUint32(record + 8),
      length: view.getUint32(record + 12),
    });
  }
  return found;
}

/**
 * Everything the PDF needs about a face, from its own bytes.
 *
 * Exported because tests/truetype.test.mts assembles a font byte by byte and
 * hands it straight to this: the failure mode here is not a crash but a width
 * that is slightly wrong, and a test against a real face can only assert the
 * numbers somebody read out of this same function, which is one misreading
 * checked against itself.
 */
export function parseTrueType(bytes: Uint8Array): PdfFont | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12) return null;
  const version = view.getUint32(0);
  /* 0x00010000 is the normal TrueType version and 'true' is what Apple's own
     tooling writes. 'OTTO' is CFF outlines and is refused above; 'ttcf' is a
     collection, which would need a face index and a second header. */
  if (version !== 0x00010000 && version !== 0x74727565) return null;

  const table = tables(view);
  const head = table.get("head");
  const hhea = table.get("hhea");
  const hmtx = table.get("hmtx");
  const cmap = table.get("cmap");
  if (!head || !hhea || !hmtx || !cmap) return null;

  const unitsPerEm = view.getUint16(head.at + 18) || 1000;
  /** Font units to the PDF's thousandths of an em. */
  const em = (value: number): number => Math.round((value * 1000) / unitsPerEm);

  const bbox = [
    em(view.getInt16(head.at + 36)),
    em(view.getInt16(head.at + 38)),
    em(view.getInt16(head.at + 40)),
    em(view.getInt16(head.at + 42)),
  ] as const;

  const metrics = view.getUint16(hhea.at + 34);
  /** The advance of one glyph id. The last entry covers every glyph after it. */
  const advance = (gid: number): number => {
    if (metrics === 0) return unitsPerEm / 2;
    const slot = Math.min(gid, metrics - 1);
    const at = hmtx.at + slot * 4;
    if (at + 2 > bytes.byteLength) return unitsPerEm / 2;
    return view.getUint16(at);
  };

  const glyphFor = characterMap(view, cmap.at);
  if (!glyphFor) return null;

  /* One width per WinAnsi code from 32 to 255, which is the /FirstChar to
     /LastChar range the writer's /WinAnsiEncoding declares. A code this
     codebase cannot emit gets the space's width; it is never selected, and a
     hole in the array is a malformed dictionary. */
  const widths: number[] = [];
  const spaceWidth = em(advance(glyphFor(32)));
  for (let code = 32; code <= 255; code++) {
    const ch = charForWinAnsi(code);
    const gid = ch === null ? 0 : glyphFor(ch.codePointAt(0) ?? 0);
    widths.push(gid === 0 ? spaceWidth : em(advance(gid)));
  }

  const os2 = table.get("OS/2");
  const post = table.get("post");
  const italicAngle = post
    ? Math.round(view.getInt32(post.at + 4) / 65536)
    : 0;
  const weight = os2 ? view.getUint16(os2.at + 4) : 400;

  const ascent = em(view.getInt16(hhea.at + 4));
  const descent = em(view.getInt16(hhea.at + 6));
  /* sCapHeight only exists from OS/2 version 2, and a script face often has a
     wrong or absent one anyway. The ascender is the honest fallback: the
     descriptor's /CapHeight is used by a reader for substitution metrics, and
     nothing substitutes a font that is embedded. */
  const capHeight =
    os2 && view.getUint16(os2.at) >= 2 && os2.length >= 90
      ? em(view.getInt16(os2.at + 88)) || ascent
      : ascent;

  /* Flags, and the one that matters is bit 6 rather than bit 3: Nonsymbolic
     (32) is what tells a reader to believe the /Encoding, and Symbolic (4)
     tells it to ignore the encoding and use the font's own cmap — which is how
     an embedded font renders the right letters for the wrong bytes. Script (8)
     is descriptive. Italic (64) follows the face's own angle, because a
     calligraphic face usually declares one. */
  const flags = 32 | 8 | (italicAngle !== 0 ? 64 : 0);

  const raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const deflated = deflateSync(raw, { level: 9 });

  return {
    baseFont: postScriptName(view, table.get("name")) ?? "EmbeddedScript",
    widths,
    flags,
    bbox,
    italicAngle,
    ascent,
    descent,
    capHeight,
    /* A rough vertical stem width. Nothing renders from it — the outlines are
       in the file — but it is a required entry in the descriptor, and the
       weight class is the only thing here that knows whether the face is
       light or black. */
    stemV: Math.max(50, Math.round(weight / 5)),
    data: deflated.toString("latin1"),
    rawLength: bytes.byteLength,
  };
}

/* --------------------------------------------------------------- the cmap -- */

/**
 * A Unicode code point to glyph id lookup, from the best subtable available.
 *
 * Windows BMP (3,1) first, then Unicode (0,x), then Windows Symbol (3,0) —
 * which some older script faces ship instead, mapping the Latin alphabet into
 * the private use area at 0xF000. A missing glyph is 0, which callers read as
 * "not in this face".
 */
function characterMap(
  view: DataView,
  at: number,
): ((code: number) => number) | null {
  const count = view.getUint16(at + 2);
  let best: { at: number; symbol: boolean } | null = null;
  let rank = -1;
  for (let i = 0; i < count; i++) {
    const record = at + 4 + i * 8;
    const platform = view.getUint16(record);
    const encoding = view.getUint16(record + 2);
    const offset = view.getUint32(record + 4);
    const score =
      platform === 3 && encoding === 1
        ? 3
        : platform === 0
          ? 2
          : platform === 3 && encoding === 0
            ? 1
            : 0;
    if (score > rank) {
      rank = score;
      best = { at: at + offset, symbol: score === 1 };
    }
  }
  if (!best) return null;

  const lookup = subtable(view, best.at);
  if (!lookup) return null;
  if (!best.symbol) return lookup;
  /* A symbol cmap keeps the Latin alphabet at 0xF000 + the byte. Try the code
     point first all the same: a font can carry both. */
  return (code) => lookup(code) || lookup(0xf000 + code);
}

/** One cmap subtable, in whichever of the three formats it declares. */
function subtable(view: DataView, at: number): ((code: number) => number) | null {
  const format = view.getUint16(at);
  if (format === 0) {
    return (code) => (code > 255 ? 0 : view.getUint8(at + 6 + code));
  }
  if (format === 6) {
    const first = view.getUint16(at + 6);
    const entries = view.getUint16(at + 8);
    return (code) =>
      code < first || code >= first + entries
        ? 0
        : view.getUint16(at + 10 + (code - first) * 2);
  }
  if (format !== 4) return null;

  const segments = view.getUint16(at + 6) / 2;
  const ends = at + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const ranges = deltas + segments * 2;
  return (code) => {
    if (code > 0xffff) return 0;
    for (let s = 0; s < segments; s++) {
      if (code > view.getUint16(ends + s * 2)) continue;
      const start = view.getUint16(starts + s * 2);
      if (code < start) return 0;
      const delta = view.getInt16(deltas + s * 2);
      const range = view.getUint16(ranges + s * 2);
      if (range === 0) return (code + delta) & 0xffff;
      /* The range offset is measured from its own slot in the array, which is
         the one genuinely strange thing in the format 4 definition and the
         one place a rewrite of this function gets it wrong. */
      const gid = view.getUint16(ranges + s * 2 + range + (code - start) * 2);
      return gid === 0 ? 0 : (gid + delta) & 0xffff;
    }
    return 0;
  };
}

/* --------------------------------------------------------------- the name -- */

/**
 * The face's PostScript name, for `/BaseFont`.
 *
 * A PDF name cannot carry a space, and nothing enforces that this matches the
 * font's own — a reader with the file in hand uses the file. But a viewer's
 * font panel prints this string, so it is worth reading rather than inventing.
 */
function postScriptName(
  view: DataView,
  name: { at: number; length: number } | undefined,
): string | null {
  if (!name) return null;
  const count = view.getUint16(name.at + 2);
  const strings = name.at + view.getUint16(name.at + 4);
  for (let i = 0; i < count; i++) {
    const record = name.at + 6 + i * 12;
    if (view.getUint16(record + 6) !== 6) continue; // nameID 6, PostScript name
    const platform = view.getUint16(record);
    const length = view.getUint16(record + 8);
    const offset = strings + view.getUint16(record + 10);
    let text = "";
    if (platform === 3) {
      // Windows records are UTF-16BE; the names here are all ASCII in practice.
      for (let b = 0; b + 1 < length; b += 2) {
        text += String.fromCharCode(view.getUint16(offset + b));
      }
    } else {
      for (let b = 0; b < length; b++) {
        text += String.fromCharCode(view.getUint8(offset + b));
      }
    }
    const clean = text.replace(/[^A-Za-z0-9+\-]/g, "");
    if (clean) return clean;
  }
  return null;
}
