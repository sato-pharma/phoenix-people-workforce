/**
 * A tiny PDF writer. Dependency-free, for the same reason src/lib/csv.ts and
 * src/lib/xlsx.ts are: the alternative is megabytes of library to emit a file
 * format that is a handful of numbered objects and a byte-offset table.
 *
 * WHAT IT DOES. Multi-page A4, text in the three Helvetica faces, filled
 * rectangles, and hairline rules. That is the whole of the SHARP Executive
 * system — every corner is 90 degrees, hierarchy is weight and rule, and there
 * is no shadow to draw — so the identity survives the trip to paper without a
 * single feature this file does not have.
 *
 * WHAT IS DELIBERATELY MISSING. No transparency, no annotations, no outlines,
 * and no compression of the text — an uncompressed journey's content streams run
 * about 60KB, which is smaller than one photograph and is not worth a deflate
 * pass to halve.
 *
 * TWO THINGS TRAVEL INSIDE THE FILE, and each is a decision rather than a
 * feature. The raster, because a document carrying a company's name next to a
 * person's is expected to carry the company's mark and a mark set as type is not
 * the mark: an image XObject, 8-bit RGB, deflated, NO alpha channel (the caller
 * flattens against the ground it sits on; see PdfImage), one copy serving every
 * page that draws it. And, since 12 Sep 2026, a font — see PdfFont. The three
 * Helveticas are still named rather than embedded, because they are three of the
 * fourteen faces every reader is required to carry, and they are still what
 * almost every line in both documents is set in. The embedded face exists for
 * the one line neither they nor the other eleven can set: a name written in a
 * calligraphic script on a certificate.
 *
 * WHY NOT window.print(). A print dialog produces whatever the browser feels
 * like: Chrome on Android puts a URL and a page number in the margin, iOS
 * Safari re-flows the columns, and neither is a file until the person taps
 * through a system sheet. This is a document — the same bytes on every phone,
 * downloaded in one tap, with the programme's name on it rather than the
 * portal's URL.
 *
 * COORDINATES ARE FROM THE TOP. PDF measures y upward from the bottom-left
 * corner, which is the opposite of how a page is laid out and of how every
 * other file in this codebase thinks. Callers give y as points from the TOP
 * edge and this file flips it, once, at the last moment.
 */

/* ------------------------------------------------------------ the units -- */

/** A4 at 72 points to the inch, which is the only unit PDF has. */
export const A4_WIDTH = 595.28;
export const A4_HEIGHT = 841.89;

/** 1mm, for the few places a paper measurement reads better than a point. */
export const MM = 72 / 25.4;

export type PdfFace = "regular" | "bold" | "italic";

export type TextOptions = {
  size?: number;
  face?: PdfFace;
  /** "r,g,b" each 0-1. Defaults to black. */
  color?: RgbColor;
  /** Extra space between characters, in points. The micro labels use it. */
  tracking?: number;
  align?: "left" | "center" | "right";
  /** For centre and right, the box the text is aligned within. */
  width?: number;
  /**
   * An embedded face to set this line in, instead of `face`.
   *
   * Nullable on purpose, so a caller can pass the result of `pdfFont()`
   * straight through: a font that did not read falls back to `face` and the
   * document still builds, which is the same bargain the mark strikes.
   */
  font?: PdfFont | null;
  /**
   * Stroke the glyphs as well as filling them, in the same ink, this many
   * points wide.
   *
   * It is **not** a bold and must never be used as one: there is no second
   * weight of a calligraphic face to reach for, and a faux bold on a text face
   * is a defect. It exists for one thing — a face whose hairlines are thin
   * enough that the renderer antialiases them to a fraction of the value they
   * are set in, so the line reads paler than its own colour. Filling and
   * stroking in one ink puts the value back without touching it.
   */
  ink?: number;
};

/**
 * A font that travels inside the file, rather than being named and assumed.
 *
 * Carried in the one form this writer will accept, exactly as PdfImage is: the
 * numbers a PDF font dictionary and its descriptor require, plus the deflated
 * sfnt as one Latin-1 character per byte. Producing it is src/lib/truetype.ts's
 * job — this file writes PDFs and does not parse font binaries, on the same
 * division of labour that keeps PNG decoding in sato-mark.ts.
 *
 * Registering the same object twice embeds one font and references it twice, so
 * a face used on every page costs what a face used on one page costs.
 */
export type PdfFont = {
  /** The PostScript name, written as /BaseFont. No spaces: it is a PDF name. */
  baseFont: string;
  /** Advance widths for WinAnsi codes 32-255, in thousandths of the em. */
  widths: number[];
  /** FontDescriptor /Flags. Nonsymbolic (32) is what honours the encoding. */
  flags: number;
  /** The font bounding box, in thousandths of the em. */
  bbox: readonly [number, number, number, number];
  italicAngle: number;
  ascent: number;
  descent: number;
  capHeight: number;
  stemV: number;
  /** The deflated sfnt, one Latin-1 character per byte. */
  data: string;
  /** Its length before deflating, which is /Length1. */
  rawLength: number;
};

export type RgbColor = readonly [number, number, number];

export const BLACK: RgbColor = [0, 0, 0];

/**
 * Two colours blended, `t` of the way from the first to the second.
 *
 * There is no transparency in this writer and there deliberately is not: an
 * alpha channel means an ExtGState, a resource dictionary per page and a class
 * of reader bug that shows up only on print. A chart needs tints all the same
 * — a heatmap is nothing but one colour at six strengths — so the tint is
 * mixed against the paper here instead, which is what an ink actually does and
 * is one line rather than a graphics state.
 */
export function mix(a: RgbColor, b: RgbColor, t: number): RgbColor {
  const k = Math.min(1, Math.max(0, t));
  return [
    a[0] + (b[0] - a[0]) * k,
    a[1] + (b[1] - a[1]) * k,
    a[2] + (b[2] - a[2]) * k,
  ];
}

/** #rrggbb to the 0-1 triple PDF wants. */
export function rgb(hex: string): RgbColor {
  const h = hex.replace("#", "");
  const n = parseInt(
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h,
    16,
  );
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/* ------------------------------------------------------------ the widths -- */

/*
 * Character widths for codes 32-126, in thousandths of the font size, taken
 * from the Adobe AFM metrics for the Helvetica family.
 *
 * These are needed for anything but left-aligned text: PDF has no concept of
 * measuring a string, so centring a heading or truncating a name to fit a
 * column means doing the arithmetic here. Getting them wrong does not corrupt
 * the file — it just puts the text in slightly the wrong place, which is the
 * kind of bug that is invisible until a long name overlaps a number.
 */
const W_REGULAR = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278,
  278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584,
  584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556,
  833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
  278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222,
  500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500,
  500, 334, 260, 334, 584,
];

const W_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278,
  278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584,
  584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611,
  833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333,
  278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278,
  556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556,
  500, 389, 280, 389, 584,
];

/** Oblique is Helvetica sheared, so it measures identically. */
const WIDTHS: Record<PdfFace, number[]> = {
  regular: W_REGULAR,
  bold: W_BOLD,
  italic: W_REGULAR,
};

/**
 * The typographic characters this codebase actually emits, mapped to their
 * WinAnsi byte.
 *
 * prettyFormula() turns "x" into a multiplication sign, the straps are joined
 * with a middle dot, and every truncation ends in an ellipsis — so a document
 * built from the portal's own strings meets all of these. A character that is
 * not here and not Latin-1 is dropped rather than written as a wrong glyph.
 */
const WINANSI: Record<string, number> = {
  "‘": 0x91,
  "’": 0x92,
  "“": 0x93,
  "”": 0x94,
  "–": 0x96,
  "—": 0x97,
  "•": 0x95,
  "…": 0x85,
  "™": 0x99,
  " ": 0x20,
  "×": 0xd7,
  "÷": 0xf7,
  "·": 0xb7,
};

/** The WinAnsi byte for one character, or null when there is no glyph. */
function byteFor(ch: string): number | null {
  const mapped = WINANSI[ch];
  if (mapped !== undefined) return mapped;
  const code = ch.charCodeAt(0);
  /* Latin-1 passes straight through: WinAnsi and Latin-1 agree everywhere
     except 0x80-0x9F, which Latin-1 leaves as control codes and nothing in
     this app produces. */
  if (code >= 32 && code <= 255) return code;
  return null;
}

/** byteFor, inverted, so the table above is stated once and read both ways. */
const FROM_WINANSI = new Map<number, string>(
  Object.entries(WINANSI).map(([ch, code]) => [code, ch]),
);

/**
 * The character a WinAnsi byte stands for, or null where nothing does.
 *
 * The inverse of byteFor(), and it exists because an embedded font has to be
 * given a width for every code in the range it declares — which means going
 * from the byte back to the character back to the glyph. The encoding is
 * stated once, here, rather than in the file that needs the widths: two copies
 * of a 224-entry table disagree eventually, and the symptom is a name that
 * centres a point or two off.
 *
 * Codes 0x80-0x9F that are not in the table above are genuinely unreachable —
 * escapeLiteral() can only write what byteFor() returns — so null is the right
 * answer rather than an omission.
 */
export function charForWinAnsi(code: number): string | null {
  const mapped = FROM_WINANSI.get(code);
  if (mapped !== undefined) return mapped;
  if (code >= 0x80 && code <= 0x9f) return null;
  if (code >= 32 && code <= 255) return String.fromCharCode(code);
  return null;
}

/** The AFM width slot a character measures as. */
function widthSlot(code: number): number {
  if (code >= 32 && code <= 126) return code - 32;
  /* An accented letter is the base letter's width in every Helvetica metric,
     and the few symbols above 126 are close enough to "o" that a name never
     visibly misaligns. */
  if (code >= 0xc0) return "o".charCodeAt(0) - 32;
  return "n".charCodeAt(0) - 32;
}

/**
 * How wide a string sets, in points.
 *
 * The face may be one of the three standard ones or an embedded font, and the
 * two are indexed differently: the AFM tables above cover 32-126 and fold
 * everything above that onto a representative letter, while an embedded face
 * carries a real width for every code it declares. Taking either here is what
 * lets truncate(), wrapText() and text() itself work in a script face without
 * a second copy of each.
 */
export function measure(
  text: string,
  size: number,
  face: PdfFace | PdfFont = "regular",
  tracking = 0,
): number {
  const embedded = typeof face === "string" ? null : face;
  const table = embedded ? embedded.widths : WIDTHS[face as PdfFace];
  let total = 0;
  let glyphs = 0;
  for (const ch of text) {
    const byte = byteFor(ch);
    if (byte === null) continue;
    total += table[embedded ? byte - 32 : widthSlot(byte)] ?? 556;
    glyphs += 1;
  }
  return (total / 1000) * size + Math.max(0, glyphs - 1) * tracking;
}

/** Cut a string to fit a width, ending in an ellipsis when it had to. */
export function truncate(
  text: string,
  max: number,
  size: number,
  face: PdfFace | PdfFont = "regular",
  tracking = 0,
): string {
  if (measure(text, size, face, tracking) <= max) return text;
  let cut = text;
  while (
    cut.length > 1 &&
    measure(`${cut}…`, size, face, tracking) > max
  ) {
    cut = cut.slice(0, -1);
  }
  return `${cut.trimEnd()}…`;
}

/**
 * Break a paragraph into lines that fit a width.
 *
 * Greedy, on spaces, with a hard break for a single word longer than the
 * column — a URL in a coordinator's note would otherwise run off the page
 * rather than wrap.
 */
export function wrapText(
  text: string,
  max: number,
  size: number,
  face: PdfFace | PdfFont = "regular",
  tracking = 0,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate, size, face, tracking) <= max) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      if (measure(word, size, face, tracking) <= max) {
        line = word;
        continue;
      }
      // One word wider than the column: break it at the last character that fits.
      let rest = word;
      while (measure(rest, size, face, tracking) > max && rest.length > 1) {
        let head = rest;
        while (head.length > 1 && measure(head, size, face, tracking) > max) {
          head = head.slice(0, -1);
        }
        lines.push(head);
        rest = rest.slice(head.length);
      }
      line = rest;
    }
    lines.push(line);
  }
  // A trailing empty line is the paragraph split, not content.
  while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/* ------------------------------------------------------------ the writer -- */

/** Escape the three characters a PDF literal string cannot carry raw. */
function escapeLiteral(text: string): string {
  let out = "";
  for (const ch of text) {
    const byte = byteFor(ch);
    if (byte === null) continue;
    const c = String.fromCharCode(byte);
    if (c === "(" || c === ")" || c === "\\") out += `\\${c}`;
    else out += c;
  }
  return out;
}

/**
 * A string for the document information dictionary, rather than for a page.
 *
 * These are the one place the encoding is NOT the font's. A page's text is
 * decoded through /WinAnsiEncoding, but the title, author and subject are read
 * as PDFDocEncoding — which agrees with WinAnsi over ASCII and disagrees over
 * exactly the range this app's typography lives in, so an em dash in a title
 * arrives in the browser tab as a capital S with a caron. The fix is the one
 * the specification gives: anything but plain ASCII goes as UTF-16BE behind a
 * byte order mark, which every reader recognises and decodes correctly.
 */
function textString(value: string): string {
  if (!/[^\x20-\x7e]/.test(value)) return `(${escapeLiteral(value)})`;
  /* A hex string rather than a literal one, because UTF-16BE is full of null
     high bytes and a parenthesis or a backslash can fall out of a code unit —
     all of which a hex string simply does not have to think about. */
  let hex = "FEFF";
  for (let i = 0; i < value.length; i++) {
    hex += value.charCodeAt(i).toString(16).padStart(4, "0").toUpperCase();
  }
  return `<${hex}>`;
}

const FACE_RESOURCE: Record<PdfFace, string> = {
  regular: "/F1",
  bold: "/F2",
  italic: "/F3",
};

/** Numbers in a content stream, kept short — three places is sub-micron. */
const n = (value: number): string => {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
};

export type PdfInfo = {
  title?: string;
  author?: string;
  subject?: string;
  creator?: string;
};

/**
 * A raster to draw — the logo, and nothing else so far.
 *
 * It is carried in the one form this writer will accept: 8-bit RGB samples,
 * deflated, one Latin-1 character per byte, which is exactly the string the
 * stream is written from. **There is no alpha channel here**, on the same
 * argument as mix(): a soft mask is transparency machinery, and the one thing
 * a logo on a report needs is to be the same ink on every reader and every
 * printer. A caller with a transparent PNG flattens it against the ground it
 * is going to sit on before it ever reaches this file — see sato-mark.ts,
 * which keeps one copy for paper and one for the navy cover.
 *
 * Deflated rather than raw because a 355x134 mark is 142KB of samples and 6KB
 * of zlib, and `/FlateDecode` is a filter every reader has had since 1994.
 * Registering the same object twice draws one XObject twice, so the mark on
 * seven pages costs what the mark on one page costs.
 */
export type PdfImage = {
  /** Pixels, not points — the box given to image() is what sets the size. */
  width: number;
  height: number;
  /** Deflated 8-bit RGB samples, one Latin-1 character per byte. */
  data: string;
};

/**
 * One document, built page by page.
 *
 * Every drawing call takes y as points from the top of the page. The class
 * holds a cursor as well, because a report is mostly a column of things one
 * under another and threading `y` through forty call sites is how a layout
 * drifts by a point.
 */
export class Pdf {
  readonly width: number;
  readonly height: number;
  /** Where the content column starts and ends, in points from the left. */
  readonly left: number;
  readonly right: number;
  /** The first and last y a page will accept content at. */
  readonly top: number;
  readonly bottom: number;

  /** Points from the top of the current page. Moved by the helpers below. */
  y = 0;

  /**
   * Called after every page is started, to draw whatever is on all of them.
   *
   * A report's furniture — the rail, the running head, the page number — has
   * to be drawn by whoever starts the page, and most pages here are not
   * started by a caller at all: they are started by room() in the middle of a
   * list of days, three function calls below anything that knows what section
   * it is in. Before this hook those continuation pages came out bare, which
   * is the one defect in a document that says at a glance that it was
   * generated rather than designed. Set it AFTER the cover, which draws its
   * own.
   */
  onPage: ((doc: Pdf) => void) | null = null;

  private pages: string[] = [];
  private current: string[] = [];
  private info: PdfInfo;
  /**
   * Every raster the document has drawn, in the order it first drew one.
   *
   * Keyed by the object itself rather than by any name the caller invents, so
   * a mark drawn on all seven pages is stored once and referenced seven times.
   */
  private images = new Map<PdfImage, string>();
  /**
   * Every embedded face the document has set a line in, in first-use order.
   *
   * Keyed on the object for the reason the images are: a face used on every
   * page is embedded once. The names start at F4 because F1 to F3 are the three
   * standard Helveticas, which are named in the resources of every page whether
   * or not a page uses them.
   */
  private fonts = new Map<PdfFont, string>();

  constructor(options: {
    width?: number;
    height?: number;
    margin?: number;
    marginTop?: number;
    marginBottom?: number;
    info?: PdfInfo;
  } = {}) {
    this.width = options.width ?? A4_WIDTH;
    this.height = options.height ?? A4_HEIGHT;
    const margin = options.margin ?? 42;
    this.left = margin;
    this.right = this.width - margin;
    this.top = options.marginTop ?? margin;
    this.bottom = this.height - (options.marginBottom ?? margin);
    this.info = options.info ?? {};
  }

  /** The usable width of the content column. */
  get columnWidth(): number {
    return this.right - this.left;
  }

  /** How many pages have been started. */
  get pageCount(): number {
    return this.pages.length + (this.current.length > 0 ? 1 : 0);
  }

  /** Start a new page. The cursor returns to the top margin. */
  page(): this {
    this.flush();
    this.current = [];
    this.y = this.top;
    // A page with no drawing at all would flush to nothing and vanish, so
    // every page opens with a no-op that guarantees it exists.
    this.current.push("q Q");
    /* The hook draws into the page that has just been opened, and may move the
       cursor below whatever it drew. It must not start a page of its own —
       nothing it is given can, and room() is the only thing that would. */
    this.onPage?.(this);
    return this;
  }

  /** Start a new page if `need` points will not fit under the cursor. */
  room(need: number): this {
    if (this.y + need > this.bottom) this.page();
    return this;
  }

  private flush() {
    if (this.current.length > 0) this.pages.push(this.current.join("\n"));
    this.current = [];
  }

  /* ------------------------------------------------------------- drawing -- */

  /**
   * Paint through a rectangle: everything `draw` puts down is clipped to it.
   *
   * This is how a value changes across a letter in a writer with no gradient
   * and no transparency, and it adds neither: the certificate's name is drawn
   * once per band of a sheen, each band clipped to its own strip, so the ink
   * changes down the letter while every mark on the page stays an ordinary
   * opaque one. A shading pattern would be the other answer and is a dictionary
   * per page, a resource entry and a print-only class of reader bug, for
   * something a dozen rectangles can say.
   *
   * PDF can also clip to the OUTLINES of text — render mode 7 — which is one
   * call rather than a dozen and is deliberately not what this does. Its
   * failure mode is the reason: a reader that does not honour it paints
   * everything inside the clip across the whole page, which on this document is
   * a navy block where somebody's name should be. That is not hypothetical, it
   * is what the first version of this did in Chrome's renderer when the text
   * state was reset a token too early. A rectangle clip is the most ordinary
   * construct in the format, and the worst a reader that ignored it could do
   * here is print the name in one flat colour.
   *
   * `draw` is handed this document rather than the caller closing the state
   * itself, because a `q` without its `Q` leaves every later mark on the page
   * inside this rectangle.
   */
  clip(x: number, y: number, w: number, h: number, draw: (doc: this) => void): this {
    this.current.push(
      `q ${n(x)} ${n(this.height - y - h)} ${n(w)} ${n(h)} re W n`,
    );
    draw(this);
    this.current.push("Q");
    return this;
  }

  /** A filled rectangle, y from the top. */
  rect(x: number, y: number, w: number, h: number, color: RgbColor): this {
    const [r, g, b] = color;
    this.current.push(
      `${n(r)} ${n(g)} ${n(b)} rg ${n(x)} ${n(this.height - y - h)} ${n(w)} ${n(h)} re f`,
    );
    return this;
  }

  /**
   * A horizontal rule.
   *
   * Drawn as a filled rectangle rather than a stroked line, because a stroke
   * of width 1 straddles its path and lands on a half pixel at 100% zoom,
   * where a 1-point rectangle sits exactly on the grid. Rule 2 of the design
   * system rests entirely on these; a fuzzy one is a visible defect.
   */
  rule(x: number, y: number, w: number, color: RgbColor, weight = 1): this {
    return this.rect(x, y, w, weight, color);
  }

  /** A vertical rule, for the timeline spine. */
  vrule(x: number, y: number, h: number, color: RgbColor, weight = 1): this {
    return this.rect(x, y, weight, h, color);
  }

  /**
   * A filled polygon, each point [x, y] with y from the top.
   *
   * The one shape in this file that is not a rectangle, and it exists for one
   * thing: the area under the cumulative points line. Everything else a
   * dashboard needs — columns, stacks, heat cells, gauges, the ranking strip —
   * is rectangles, which is not a limitation of the writer but the design
   * system being honest about itself on paper.
   */
  polygon(points: readonly (readonly [number, number])[], color: RgbColor): this {
    if (points.length < 3) return this;
    const [r, g, b] = color;
    const path = points
      .map(([x, y], i) => `${n(x)} ${n(this.height - y)} ${i === 0 ? "m" : "l"}`)
      .join(" ");
    this.current.push(`${n(r)} ${n(g)} ${n(b)} rg ${path} h f`);
    return this;
  }

  /**
   * A stroked polyline — the trend line that sits on top of that area.
   *
   * Stroked rather than built from rectangles because this is the one mark in
   * the document that is deliberately not axis-aligned, so there is no pixel
   * grid to land on and nothing to be gained by faking it.
   */
  polyline(
    points: readonly (readonly [number, number])[],
    color: RgbColor,
    weight = 1,
  ): this {
    if (points.length < 2) return this;
    const [r, g, b] = color;
    const path = points
      .map(([x, y], i) => `${n(x)} ${n(this.height - y)} ${i === 0 ? "m" : "l"}`)
      .join(" ");
    this.current.push(
      `${n(r)} ${n(g)} ${n(b)} RG ${n(weight)} w 1 j 1 J ${path} S`,
    );
    return this;
  }

  /**
   * A raster scaled into the box given, y from the top.
   *
   * PDF draws an image into the unit square and lets the transformation
   * matrix say where that square is, which is why this is a `cm` and not the
   * x/y/w/h every other call here takes. It is wrapped in `q … Q` so the
   * matrix cannot leak into whatever is drawn next — the one operator in this
   * writer that would otherwise be sticky.
   *
   * Nothing here preserves the aspect ratio: the caller has the pixel
   * dimensions on the PdfImage and a squashed logo is a thing a reviewer
   * notices and a function cannot.
   */
  /** The resource name for an embedded face, allocated on first use. */
  private fontResource(font: PdfFont): string {
    let name = this.fonts.get(font);
    if (!name) {
      name = `F${this.fonts.size + 4}`;
      this.fonts.set(font, name);
    }
    return name;
  }

  image(image: PdfImage, x: number, y: number, w: number, h: number): this {
    let name = this.images.get(image);
    if (!name) {
      name = `Im${this.images.size + 1}`;
      this.images.set(image, name);
    }
    this.current.push(
      `q ${n(w)} 0 0 ${n(h)} ${n(x)} ${n(this.height - y - h)} cm /${name} Do Q`,
    );
    return this;
  }

  /**
   * One line of text, positioned by its BASELINE, y from the top.
   *
   * Baseline rather than the top of the em box, because that is what lines
   * text up with a rule beside it, and it is what every caller in
   * journey-pdf.ts is reasoning about.
   */
  text(content: string, x: number, y: number, options: TextOptions = {}): this {
    const size = options.size ?? 10;
    const [r, g, b] = options.color ?? BLACK;
    const tracking = options.tracking ?? 0;

    /* An embedded font wins over `face`, and a null one loses to it — so a
       caller hands over whatever pdfFont() returned and does not branch. */
    const metric = options.font ?? options.face ?? "regular";
    const resource = options.font
      ? `/${this.fontResource(options.font)}`
      : FACE_RESOURCE[options.face ?? "regular"];

    let tx = x;
    if (options.align && options.align !== "left") {
      const w = measure(content, size, metric, tracking);
      const box = options.width ?? 0;
      tx = options.align === "center" ? x + (box - w) / 2 : x + box - w;
    }

    const parts = [
      "BT",
      `${n(r)} ${n(g)} ${n(b)} rg`,
      `${resource} ${n(size)} Tf`,
    ];
    if (tracking) parts.push(`${n(tracking)} Tc`);
    parts.push(`1 0 0 1 ${n(tx)} ${n(this.height - y)} Tm`);
    /* Render mode 2 is fill-then-stroke. The stroke colour is a separate
       graphics-state entry from the fill colour (RG against rg), so it is set
       from the same three numbers rather than inherited — left unset it would
       stroke in whatever the last polyline used, which on this page is a chart
       axis on another document entirely. Reset to mode 0 inside the same BT/ET
       so nothing after this line is stroked. */
    if (options.ink) {
      parts.push(
        `${n(r)} ${n(g)} ${n(b)} RG ${n(options.ink)} w 1 j 1 J 2 Tr`,
      );
    }
    parts.push(`(${escapeLiteral(content)}) Tj`);
    if (options.ink) parts.push("0 Tr");
    if (tracking) parts.push("0 Tc");
    parts.push("ET");

    this.current.push(parts.join(" "));
    return this;
  }

  /**
   * A wrapped paragraph. Returns the y of the line after the last one drawn,
   * so a caller can carry on beneath it.
   */
  paragraph(
    content: string,
    x: number,
    y: number,
    width: number,
    options: TextOptions & { leading?: number } = {},
  ): number {
    const size = options.size ?? 10;
    const face = options.face ?? "regular";
    const leading = options.leading ?? size * 1.45;
    const lines = wrapText(content, width, size, face, options.tracking ?? 0);
    let cursor = y;
    for (const line of lines) {
      this.text(line, x, cursor, { ...options, width, align: options.align });
      cursor += leading;
    }
    return cursor;
  }

  /* -------------------------------------------------------------- output -- */

  /**
   * The finished file.
   *
   * Built as a list of Latin-1 chunks so the byte offsets the cross-reference
   * table needs can be counted as the file is assembled, which is the one
   * thing in a PDF that cannot be worked out afterwards.
   */
  bytes(): Uint8Array {
    this.flush();
    if (this.pages.length === 0) this.pages.push("q Q");

    const objects: string[] = [];
    /** Reserve an object number now, fill the body in later. */
    const reserve = () => {
      objects.push("");
      return objects.length; // 1-based, which is what a PDF reference is
    };

    const catalogId = reserve();
    const pagesId = reserve();
    const fontIds = { regular: reserve(), bold: reserve(), italic: reserve() };
    const infoId = reserve();

    const drawn = [...this.images.entries()];
    const imageIds = drawn.map(() => reserve());

    /* Three objects per embedded face: the font dictionary a page names, the
       descriptor it points at, and the sfnt itself. */
    const embedded = [...this.fonts.entries()];
    const embeddedIds = embedded.map(() => ({
      font: reserve(),
      descriptor: reserve(),
      file: reserve(),
    }));

    const pageIds: number[] = [];
    const contentIds: number[] = [];
    for (const _ of this.pages) {
      pageIds.push(reserve());
      contentIds.push(reserve());
    }

    objects[catalogId - 1] =
      `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objects[pagesId - 1] =
      `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds
        .map((id) => `${id} 0 R`)
        .join(" ")}] >>`;

    const font = (id: number, base: string) => {
      objects[id - 1] =
        `<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>`;
    };
    font(fontIds.regular, "Helvetica");
    font(fontIds.bold, "Helvetica-Bold");
    font(fontIds.italic, "Helvetica-Oblique");

    /* An embedded face, written as /TrueType rather than /Type0.

       /Type0 with Identity-H is what a document needing Arabic or CJK would
       take, and it is a different job: a two-byte string, a CIDToGIDMap, a
       /W array of glyph ids and a ToUnicode CMap so the text can still be
       selected and searched. A simple face reached through /WinAnsiEncoding is
       the whole of what this document needs — one line of Latin script — and it
       keeps the bytes in the content stream identical to every other line on
       the page, which is what lets one escapeLiteral(), one measure() and one
       SVG preview serve both. The two entries that make the encoding work are
       here and in the descriptor: /Encoding /WinAnsiEncoding, and Nonsymbolic
       in /Flags. Declare the face symbolic and a reader ignores the encoding in
       favour of the font's own cmap, which renders the right letters for the
       wrong bytes on some readers and not on others. */
    embedded.forEach(([face], index) => {
      const ids = embeddedIds[index];
      objects[ids.font - 1] =
        `<< /Type /Font /Subtype /TrueType /BaseFont /${face.baseFont} ` +
        `/FirstChar 32 /LastChar 255 /Widths [${face.widths.join(" ")}] ` +
        `/Encoding /WinAnsiEncoding /FontDescriptor ${ids.descriptor} 0 R >>`;
      objects[ids.descriptor - 1] =
        `<< /Type /FontDescriptor /FontName /${face.baseFont} ` +
        `/Flags ${face.flags} /FontBBox [${face.bbox.join(" ")}] ` +
        `/ItalicAngle ${face.italicAngle} /Ascent ${face.ascent} ` +
        `/Descent ${face.descent} /CapHeight ${face.capHeight} ` +
        `/StemV ${face.stemV} /FontFile2 ${ids.file} 0 R >>`;
      /* /Length1 is the size before deflating, and a reader that trusts it over
         the inflated length will read a truncated font if it is wrong. */
      objects[ids.file - 1] =
        `<< /Filter /FlateDecode /Length ${face.data.length} ` +
        `/Length1 ${face.rawLength} >>\nstream\n${face.data}\nendstream`;
    });

    const meta: string[] = [];
    const put = (key: string, value: string | undefined) => {
      if (value) meta.push(`/${key} ${textString(value)}`);
    };
    put("Title", this.info.title);
    put("Author", this.info.author);
    put("Subject", this.info.subject);
    put("Creator", this.info.creator ?? "Future Talents Field");
    put("Producer", "Future Talents Field");
    objects[infoId - 1] = `<< ${meta.join(" ")} >>`;

    /* One XObject per distinct raster, whatever number of pages drew it. The
       stream is binary and is written the same way the content streams are:
       Latin-1 characters counted straight into /Length, with no newline
       conversion anywhere between here and the Uint8Array at the bottom. */
    drawn.forEach(([image], index) => {
      objects[imageIds[index] - 1] =
        `<< /Type /XObject /Subtype /Image /Width ${image.width} ` +
        `/Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 ` +
        `/Filter /FlateDecode /Length ${image.data.length} >>\n` +
        `stream\n${image.data}\nendstream`;
    });

    const xobjects =
      drawn.length === 0
        ? ""
        : ` /XObject << ${drawn
            .map(([, name], index) => `/${name} ${imageIds[index]} 0 R`)
            .join(" ")} >>`;

    const faces = embedded
      .map(([, name], index) => ` /${name} ${embeddedIds[index].font} 0 R`)
      .join("");

    const resources =
      `<< /Font << /F1 ${fontIds.regular} 0 R /F2 ${fontIds.bold} 0 R ` +
      `/F3 ${fontIds.italic} 0 R${faces} >>${xobjects} >>`;

    this.pages.forEach((content, index) => {
      objects[pageIds[index] - 1] =
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox ` +
        `[0 0 ${n(this.width)} ${n(this.height)}] /Resources ${resources} ` +
        `/Contents ${contentIds[index]} 0 R >>`;
      objects[contentIds[index] - 1] =
        `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
    });

    /* %âãÏÓ on the second line. A binary comment in the first 1KB is what
       tells a file transfer, a mail gateway or a git diff that this is not
       text to be newline-converted on the way through. */
    let file = "%PDF-1.7\n%âãÏÓ\n";
    const offsets: number[] = [];
    objects.forEach((body, index) => {
      offsets.push(file.length);
      file += `${index + 1} 0 obj\n${body}\nendobj\n`;
    });

    const xref = file.length;
    file += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) {
      file += `${String(offset).padStart(10, "0")} 00000 n \n`;
    }
    file +=
      `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R ` +
      `/Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

    const bytes = new Uint8Array(file.length);
    for (let i = 0; i < file.length; i++) bytes[i] = file.charCodeAt(i) & 0xff;
    return bytes;
  }
}
