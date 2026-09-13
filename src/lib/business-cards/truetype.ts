import { PDFHexString, PDFString } from "pdf-lib";
import type { PDFDocument, PDFRef } from "pdf-lib";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// A TRUETYPE FONT, EMBEDDED AS REAL VECTOR TEXT — Type0 / CIDFontType2 / Identity-H.
//
// pdf-lib draws custom fonts only through `@pdf-lib/fontkit`, which this repository does not carry.
// The card needs nothing fontkit adds: no shaping, no ligatures, no kerning (the owner's Canva card
// has none — every glyph sits at its plain advance plus tracking). So this file does the part that
// matters for print by hand: glyph ids straight from the font's own `cmap`, widths from its own
// `hmtx`, the outlines themselves as FontFile2, and a ToUnicode map so the text stays selectable
// and searchable in the PDF.
//
// THE OUTLINES ARE SUBSET BY ZEROING, NOT RENUMBERING. Every glyph keeps its id, so CIDToGIDMap
// stays Identity and nothing written before the subset is taken can go stale; glyphs no card used
// simply carry no outline. That is what keeps a file of 100 cards at kilobytes of font instead of
// half a megabyte per PDF — and a ZIP of separate PDFs pays that per file.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

type TableRecord = { length: number; offset: number };

export type CardFont = {
  postScriptName: string;
  /** Characters in `text` the font has no glyph for (Montserrat carries no Arabic, for one). */
  missingCharacters(text: string): string[];
  /** Width of `text` in points: advances at `sizePt`, plus `trackingPt` BETWEEN glyphs. */
  widthOfText(text: string, sizePt: number, trackingPt: number): number;
  /** Identity-H glyph codes for `text`. Every glyph passed here is kept in the subset. */
  encode(text: string): PDFHexString;
  /** Writes the font into `doc` at `ref`. Call once, after the last `encode`. */
  embedInto(doc: PDFDocument, ref: PDFRef): void;
};

/** The tables a CIDFontType2 program needs. GPOS/GSUB/GDEF, `name` and `post` are dropped. */
const KEPT_TABLES = ["OS/2", "cmap", "cvt ", "fpgm", "glyf", "head", "hhea", "hmtx", "loca", "maxp", "prep"];

function readTables(view: DataView): Map<string, TableRecord> {
  const version = view.getUint32(0);
  if (version !== 0x00010000 && version !== 0x74727565) {
    throw new Error("Only TrueType-outline fonts can be embedded as FontFile2.");
  }
  const tables = new Map<string, TableRecord>();
  const count = view.getUint16(4);
  for (let index = 0; index < count; index += 1) {
    const at = 12 + 16 * index;
    const tag = String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
    tables.set(tag, { offset: view.getUint32(at + 8), length: view.getUint32(at + 12) });
  }
  return tables;
}

function requireTable(tables: Map<string, TableRecord>, tag: string): TableRecord {
  const table = tables.get(tag);
  if (!table) throw new Error(`The font has no '${tag}' table.`);
  return table;
}

function readCmap(view: DataView, cmap: number): Map<number, number> {
  let format4 = -1;
  let format12 = -1;
  const count = view.getUint16(cmap + 2);
  for (let index = 0; index < count; index += 1) {
    const at = cmap + 4 + 8 * index;
    const platform = view.getUint16(at);
    const encoding = view.getUint16(at + 2);
    const subtable = cmap + view.getUint32(at + 4);
    const format = view.getUint16(subtable);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (unicode && format === 12) format12 = subtable;
    if (unicode && format === 4) format4 = subtable;
  }

  const map = new Map<number, number>();
  if (format12 >= 0) {
    const groups = view.getUint32(format12 + 12);
    for (let group = 0; group < groups; group += 1) {
      const at = format12 + 16 + 12 * group;
      const start = view.getUint32(at);
      const end = Math.min(view.getUint32(at + 4), 0x10ffff);
      const firstGlyph = view.getUint32(at + 8);
      for (let codePoint = start; codePoint <= end; codePoint += 1) map.set(codePoint, firstGlyph + codePoint - start);
    }
    return map;
  }
  if (format4 >= 0) {
    const segCountX2 = view.getUint16(format4 + 6);
    const ends = format4 + 14;
    const starts = ends + segCountX2 + 2;
    const deltas = starts + segCountX2;
    const ranges = deltas + segCountX2;
    for (let segment = 0; segment < segCountX2; segment += 2) {
      const end = view.getUint16(ends + segment);
      const start = view.getUint16(starts + segment);
      const delta = view.getUint16(deltas + segment);
      const rangeOffset = view.getUint16(ranges + segment);
      for (let codePoint = start; codePoint <= end && codePoint !== 0xffff; codePoint += 1) {
        let glyph: number;
        if (rangeOffset === 0) {
          glyph = (codePoint + delta) & 0xffff;
        } else {
          const raw = view.getUint16(ranges + segment + rangeOffset + (codePoint - start) * 2);
          glyph = raw === 0 ? 0 : (raw + delta) & 0xffff;
        }
        if (glyph !== 0) map.set(codePoint, glyph);
      }
    }
    return map;
  }
  throw new Error("The font has no Unicode cmap.");
}

function readPostScriptName(view: DataView, name: TableRecord | undefined): string | null {
  if (!name) return null;
  const count = view.getUint16(name.offset + 2);
  const strings = name.offset + view.getUint16(name.offset + 4);
  for (let index = 0; index < count; index += 1) {
    const at = name.offset + 6 + 12 * index;
    const platform = view.getUint16(at);
    if (view.getUint16(at + 6) !== 6) continue;
    const length = view.getUint16(at + 8);
    const offset = strings + view.getUint16(at + 10);
    let value = "";
    if (platform === 3 || platform === 0) {
      for (let char = 0; char + 1 < length; char += 2) value += String.fromCharCode(view.getUint16(offset + char));
    } else {
      for (let char = 0; char < length; char += 1) value += String.fromCharCode(view.getUint8(offset + char));
    }
    const clean = value.replace(/[^A-Za-z0-9-]/g, "");
    if (clean) return clean;
  }
  return null;
}

function tableChecksum(data: Uint8Array): number {
  let sum = 0;
  for (let index = 0; index < data.length; index += 4) {
    const word =
      (((data[index] ?? 0) << 24) | ((data[index + 1] ?? 0) << 16) | ((data[index + 2] ?? 0) << 8) | (data[index + 3] ?? 0)) >>> 0;
    sum = (sum + word) >>> 0;
  }
  return sum;
}

function writeSfnt(entries: Array<[string, Uint8Array]>): Uint8Array {
  const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const count = sorted.length;
  let offset = 12 + 16 * count;
  const placed = sorted.map(([tag, data]) => {
    const at = offset;
    offset += (data.length + 3) & ~3;
    return { at, data, tag };
  });
  const out = new Uint8Array(offset);
  const view = new DataView(out.buffer);
  const selector = Math.floor(Math.log2(count));
  const searchRange = 16 * 2 ** selector;
  view.setUint32(0, 0x00010000);
  view.setUint16(4, count);
  view.setUint16(6, searchRange);
  view.setUint16(8, selector);
  view.setUint16(10, 16 * count - searchRange);
  let headAt = -1;
  placed.forEach(({ at, data, tag }, index) => {
    const record = 12 + 16 * index;
    for (let char = 0; char < 4; char += 1) view.setUint8(record + char, tag.charCodeAt(char));
    view.setUint32(record + 4, tableChecksum(data));
    view.setUint32(record + 8, at);
    view.setUint32(record + 12, data.length);
    out.set(data, at);
    if (tag === "head") headAt = at;
  });
  if (headAt >= 0) view.setUint32(headAt + 8, (0xb1b0afba - tableChecksum(out)) >>> 0);
  return out;
}

function toUnicodeHex(codePoint: number): string {
  if (codePoint <= 0xffff) return codePoint.toString(16).padStart(4, "0");
  const value = codePoint - 0x10000;
  return ((0xd800 + (value >> 10)).toString(16) + (0xdc00 + (value & 0x3ff)).toString(16)).padStart(8, "0");
}

export function loadCardFont(input: Uint8Array): CardFont {
  const bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tables = readTables(view);

  const head = requireTable(tables, "head").offset;
  const unitsPerEm = view.getUint16(head + 18);
  const bbox = [view.getInt16(head + 36), view.getInt16(head + 38), view.getInt16(head + 40), view.getInt16(head + 42)];
  const longLoca = view.getInt16(head + 50) === 1;
  const hhea = requireTable(tables, "hhea").offset;
  const ascender = view.getInt16(hhea + 4);
  const descender = view.getInt16(hhea + 6);
  const hMetrics = view.getUint16(hhea + 34);
  const numGlyphs = view.getUint16(requireTable(tables, "maxp").offset + 4);
  const os2 = tables.get("OS/2");
  const capHeight = os2 && view.getUint16(os2.offset) >= 2 ? view.getInt16(os2.offset + 88) : ascender;
  const weight = os2 ? view.getUint16(os2.offset + 4) : 400;
  const post = tables.get("post");
  const italicAngle = post ? view.getInt32(post.offset + 4) / 65536 : 0;
  const fixedPitch = post ? view.getUint32(post.offset + 12) !== 0 : false;
  const postScriptName = readPostScriptName(view, tables.get("name")) ?? "CardFont";

  const hmtx = requireTable(tables, "hmtx").offset;
  const advances = new Array<number>(numGlyphs);
  for (let glyph = 0; glyph < numGlyphs; glyph += 1) {
    advances[glyph] = view.getUint16(hmtx + 4 * Math.min(glyph, hMetrics - 1));
  }
  const cmap = readCmap(view, requireTable(tables, "cmap").offset);

  const loca = requireTable(tables, "loca").offset;
  const glyf = requireTable(tables, "glyf").offset;
  const glyphStart = (glyph: number) => (longLoca ? view.getUint32(loca + 4 * glyph) : view.getUint16(loca + 2 * glyph) * 2);

  const used = new Map<number, number>();

  function glyphsOf(text: string): Array<{ codePoint: number; glyph: number }> {
    return Array.from(text, (char) => {
      const codePoint = char.codePointAt(0) ?? 0;
      return { codePoint, glyph: cmap.get(codePoint) ?? 0 };
    });
  }

  function components(glyph: number): number[] {
    const start = glyphStart(glyph);
    if (glyphStart(glyph + 1) - start < 10 || view.getInt16(glyf + start) >= 0) return [];
    const found: number[] = [];
    let at = glyf + start + 10;
    for (;;) {
      const flags = view.getUint16(at);
      found.push(view.getUint16(at + 2));
      at += 4 + (flags & 0x0001 ? 4 : 2);
      if (flags & 0x0008) at += 2;
      else if (flags & 0x0040) at += 4;
      else if (flags & 0x0080) at += 8;
      if (!(flags & 0x0020)) return found;
    }
  }

  function subsetProgram(): Uint8Array {
    const keep = new Set<number>([0]);
    const queue = [...used.keys()];
    while (queue.length) {
      const glyph = queue.pop() as number;
      if (keep.has(glyph) && glyph !== 0) continue;
      keep.add(glyph);
      for (const part of components(glyph)) if (!keep.has(part)) queue.push(part);
    }
    const locaOut = new Uint8Array(4 * (numGlyphs + 1));
    const locaView = new DataView(locaOut.buffer);
    const pieces: Uint8Array[] = [];
    let size = 0;
    for (let glyph = 0; glyph < numGlyphs; glyph += 1) {
      locaView.setUint32(4 * glyph, size);
      if (!keep.has(glyph)) continue;
      const start = glyphStart(glyph);
      const length = glyphStart(glyph + 1) - start;
      if (length <= 0) continue;
      const piece = new Uint8Array((length + 3) & ~3);
      piece.set(bytes.subarray(glyf + start, glyf + start + length));
      pieces.push(piece);
      size += piece.length;
    }
    locaView.setUint32(4 * numGlyphs, size);
    const glyfOut = new Uint8Array(size);
    let at = 0;
    for (const piece of pieces) {
      glyfOut.set(piece, at);
      at += piece.length;
    }

    const entries: Array<[string, Uint8Array]> = [];
    for (const tag of KEPT_TABLES) {
      const table = tables.get(tag);
      if (tag === "glyf") entries.push([tag, glyfOut]);
      else if (tag === "loca") entries.push([tag, locaOut]);
      else if (table) {
        const copy = bytes.slice(table.offset, table.offset + table.length);
        if (tag === "head") {
          const headView = new DataView(copy.buffer);
          headView.setUint32(8, 0);
          headView.setInt16(50, 1);
        }
        entries.push([tag, copy]);
      }
    }
    return writeSfnt(entries);
  }

  return {
    postScriptName,
    missingCharacters(text) {
      return [...new Set(glyphsOf(text).filter((entry) => entry.glyph === 0).map((entry) => String.fromCodePoint(entry.codePoint)))];
    },
    widthOfText(text, sizePt, trackingPt) {
      const glyphs = glyphsOf(text);
      const advance = glyphs.reduce((sum, entry) => sum + (advances[entry.glyph] ?? 0), 0);
      return (advance * sizePt) / unitsPerEm + trackingPt * Math.max(0, glyphs.length - 1);
    },
    encode(text) {
      let hex = "";
      for (const { codePoint, glyph } of glyphsOf(text)) {
        if (!used.has(glyph)) used.set(glyph, codePoint);
        hex += glyph.toString(16).padStart(4, "0");
      }
      return PDFHexString.of(hex);
    },
    embedInto(doc, ref) {
      const context = doc.context;
      const scale = 1000 / unitsPerEm;
      const glyphs = [...used.keys()].filter((glyph) => glyph !== 0).sort((a, b) => a - b);

      // The subset tag is derived from the glyphs themselves, so the same cards give the same bytes.
      let hash = 2166136261;
      for (const glyph of glyphs) hash = Math.imul(hash ^ glyph, 16777619) >>> 0;
      let tag = "";
      for (let index = 0; index < 6; index += 1) {
        tag += String.fromCharCode(65 + (hash % 26));
        hash = Math.floor(hash / 26) + index * 7919;
      }
      const baseFont = `${tag}+${postScriptName}`;

      const program = subsetProgram();
      const fontFileRef = context.register(context.flateStream(program, { Length1: program.length }));
      const descriptorRef = context.register(
        context.obj({
          Type: "FontDescriptor",
          FontName: baseFont,
          Flags: 32 | (fixedPitch ? 1 : 0) | (italicAngle !== 0 ? 64 : 0),
          FontBBox: bbox.map((value) => Math.round(value * scale)),
          ItalicAngle: italicAngle,
          Ascent: Math.round(ascender * scale),
          Descent: Math.round(descender * scale),
          CapHeight: Math.round(capHeight * scale),
          StemV: weight >= 600 ? 140 : 80,
          FontFile2: fontFileRef,
        }),
      );

      const widths: Array<number | number[]> = [];
      for (const glyph of glyphs) widths.push(glyph, [Math.round((advances[glyph] ?? 0) * scale * 1000) / 1000]);

      const cidFontRef = context.register(
        context.obj({
          Type: "Font",
          Subtype: "CIDFontType2",
          BaseFont: baseFont,
          CIDSystemInfo: context.obj({
            Registry: PDFString.of("Adobe"),
            Ordering: PDFString.of("Identity"),
            Supplement: 0,
          }),
          FontDescriptor: descriptorRef,
          W: widths,
          CIDToGIDMap: "Identity",
        }),
      );

      const mappings = glyphs.map((glyph) => `<${glyph.toString(16).padStart(4, "0")}> <${toUnicodeHex(used.get(glyph) ?? 0)}>`);
      const blocks: string[] = [];
      for (let index = 0; index < mappings.length; index += 100) {
        const chunk = mappings.slice(index, index + 100);
        blocks.push(`${chunk.length} beginbfchar\n${chunk.join("\n")}\nendbfchar`);
      }
      const toUnicode = [
        "/CIDInit /ProcSet findresource begin",
        "12 dict begin",
        "begincmap",
        "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
        "/CMapName /Adobe-Identity-UCS def",
        "/CMapType 2 def",
        "1 begincodespacerange",
        "<0000> <FFFF>",
        "endcodespacerange",
        ...blocks,
        "endcmap",
        "CMapName currentdict /CMap defineresource pop",
        "end",
        "end",
      ].join("\n");
      const toUnicodeRef = context.register(context.flateStream(toUnicode));

      context.assign(
        ref,
        context.obj({
          Type: "Font",
          Subtype: "Type0",
          BaseFont: baseFont,
          Encoding: "Identity-H",
          DescendantFonts: [cidFontRef],
          ToUnicode: toUnicodeRef,
        }),
      );
    },
  };
}
