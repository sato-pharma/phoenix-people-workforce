// The Sales Review pack — the PowerPoint deck.
//
// Owner, 2026-09-26: "instead of spending time doing a presentation for sales review … he has the
// option to choose what metrics he wants, and then press export as PPTX … and Phoenix does for him
// a comprehensive perfect corporate professional presentation to present in front of his manager or
// in front of his team." He sequenced it himself — PDF and Excel first, PPTX after — and this is
// the after.
//
// Like the other two renderers it READS the pack model and computes NOTHING. That is the whole
// design of this directory: a renderer with its own arithmetic would be a second opinion about
// achievement, and the three files a manager exports within a minute of each other would disagree
// in front of the room he is presenting to.
//
// ── WHY THIS IS HAND-WRITTEN OOXML AND NOT A PPTX LIBRARY ──────────────────────────────────────
//
// The repo has `pdfmake`, `pdf-lib` and `exceljs`, and NO PowerPoint capability of any kind. The
// obvious move is to add `pptxgenjs` — but a new dependency cannot be installed from a worktree
// here (`pnpm` purges the `node_modules` junction, and `bash-guard.mjs` C6 denies it outright), so
// adding one is a lockfile change that no session in a worktree can actually produce and test.
//
// `jszip` is ALREADY a dependency and is already imported by five runtime modules in `src/` —
// `closing-engine-fill.ts`, `closing-consolidated.ts`, `closing-executive-look.ts`,
// `closing-report-pdf.ts` and `weekly/export-workbook.ts`. A .pptx IS a zip of XML parts, exactly
// as a .xlsx is, and this repo already writes OOXML parts into a zip by hand for the premium
// closing workbook. So this adds a sixth caller of an existing tool rather than a new dependency.
//
// ── WHAT IS DELIBERATE ABOUT THE LOOK ──────────────────────────────────────────────────────────
//
// THE HOUSE IDENTITY `SATO-DIS-2026-01 v1.0`, ink rule relaxed for the bands — the owner's decision
// on 2026-09-26, the same exemption the premium closing workbook and the spotlight sheet hold, and
// the same one the PDF and the workbook in this directory already take. The 6% zebra row is the
// house's and stays exactly that.
//
// EVERY CORNER IS SQUARE. `prstGeom prst="rect"` everywhere, never `roundRect` — the square-edge
// golden rule reaches a generated document as much as a screen.
//
// CALIBRI, because it is on every machine that opens a .pptx and it is what the pack's own workbook
// already uses. A face nobody has is substituted silently by PowerPoint, which is how a deck
// reflows on the projector it is shown on.
//
// 🔴 A TABLE IS CAPPED AND THE SLIDE SAYS SO — the same decision the PDF already took, at a smaller
// number because a slide holds less than an A4 page. What is cut is stated, with the Excel version
// named as where the whole of it lives. Never silently truncated: a reader who cannot see that
// rows were dropped believes a district sells through twelve bricks when it sells through forty.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import JSZip from "jszip";

import { HOUSE_COLORS } from "@/lib/hiring-pack/house-identity";

import type { PackCell, PackSection, SalesReviewPack } from "./model";

// ── geometry ───────────────────────────────────────────────────────────────────────────────────
// EMU: 914,400 per inch. 16:9 widescreen, which is what a meeting room projects.
const EMU_PER_INCH = 914400;
const inch = (n: number) => Math.round(n * EMU_PER_INCH);
const SLIDE_W = 12192000; // 13.333"
const SLIDE_H = 6858000; // 7.5"
const MARGIN = inch(0.5);

// The crest band and its brand seam — the Spotlight sheet's head, projected. The mark reversed out
// of a near-black band, closed by a light-blue seam over the deep.
const CREST_H = inch(0.55);
const SEAM_H = inch(0.045);
const LOGO_H = inch(0.34);
const LOGO_W = Math.round(LOGO_H * (401 / 158)); // the mark's own aspect
const EYEBROW_Y = inch(0.88);
const TITLE_Y = inch(1.16);
const TITLE_H = inch(0.62);
const NOTE_Y = inch(1.86);
const NOTE_H = inch(0.5);
const TABLE_Y = inch(2.46);
const TABLE_W = SLIDE_W - MARGIN * 2;
const HEADER_ROW_H = inch(0.4);
const BODY_ROW_H = inch(0.3);

/**
 * Rows drawn on one slide. Above this the slide names the workbook instead of going on.
 *
 * Twelve, not the PDF's eighteen: an A4 page read at arm's length holds more than a slide read from
 * the back of a room, and the table has to leave space for the line that admits the cut.
 */
const ROW_CAP = 12;

const hex = (value: string) => value.replace("#", "").toUpperCase();
const DEEP = hex(HOUSE_COLORS.deep);
const BLUE = hex(HOUSE_COLORS.blue);
const LIGHT = hex(HOUSE_COLORS.light);
const TINT = hex(HOUSE_COLORS.tint);
const HAIR = hex(HOUSE_COLORS.hair);
const BODY = hex(HOUSE_COLORS.body);
const MUTED = hex(HOUSE_COLORS.muted);
const WHITE = "FFFFFF";
// The crest band and plinth — near-black, so a blue mark does not flatten against a blue ground.
// The same value the Spotlight sheet uses.
const CREST = "0E1720";
// The ink for a name and a figure — outweighs the blue, the way the Spotlight sheet sets it.
const INK = "111820";
// A tint that survives under text on a projector — the Spotlight sheet's wash, for a quiet panel.
const WASH = "EEF3F7";

/** The reversed mark for the crest, read once. Null when the file cannot be read → wordmark as type. */
let logoBuf: Buffer | null | undefined;
function crestLogo(): Buffer | null {
  if (logoBuf === undefined) {
    try {
      logoBuf = readFileSync(join(process.cwd(), "public", "brand", "sato-pharma-logo.png"));
    } catch {
      logoBuf = null;
    }
  }
  return logoBuf;
}

/**
 * XML escaping. Every string that reaches a part goes through this.
 *
 * Not cosmetic: a district manager called "Sons & Co" or an area label carrying `<` would otherwise
 * produce a part PowerPoint refuses to open at all, and the failure arrives as "the presentation
 * cannot be opened" with nothing naming the row that caused it.
 */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

// Georgia for the display line — the title and the figures. It ships with Office on Windows and Mac
// and reads as the serif the PDF sets in Noto Serif, so the deck matches the pack's other two files
// instead of looking like a spreadsheet dropped into a slide. Calibri stays the body face — and must
// stay present, because a projector without the display face substitutes it silently.
const SERIF = "Georgia";

type TextOptions = {
  align?: "l" | "r" | "ctr";
  bold?: boolean;
  color: string;
  italic?: boolean;
  /** The face. Calibri for body; Georgia for the display line (titles, figures). */
  font?: string;
  /** Hundredths of a point, as DrawingML counts: 1000 is 10pt. */
  size: number;
  /** Letter-spacing, in hundredths of a point — the eyebrow's and header's tracked caps. */
  spc?: number;
};

/** One paragraph of one run. Every piece of text in this deck is built from this. */
function paragraph(text: string, options: TextOptions): string {
  const { align = "l", bold = false, color, italic = false, size, font = "Calibri", spc } = options;
  return (
    `<a:p><a:pPr algn="${align}"/>` +
    `<a:r><a:rPr lang="en-US" sz="${size}" b="${bold ? 1 : 0}" i="${italic ? 1 : 0}"${spc != null ? ` spc="${spc}"` : ""} dirty="0">` +
    `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>` +
    `<a:latin typeface="${font}"/><a:cs typeface="${font}"/>` +
    `</a:rPr><a:t>${esc(text)}</a:t></a:r></a:p>`
  );
}

/** A filled rectangle carrying text — the bands, and the cover's blocks. SQUARE, always. */
function textShape(
  id: number,
  name: string,
  box: { h: number; w: number; x: number; y: number },
  paragraphs: string,
  fill: string | null,
): string {
  const fillXml = fill ? `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>` : "<a:noFill/>";
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.w}" cy="${box.h}"/></a:xfrm>` +
    // prstGeom "rect" — the square-edge golden rule. Never roundRect.
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fillXml}<a:ln><a:noFill/></a:ln></p:spPr>` +
    `<p:txBody><a:bodyPr lIns="${Math.round(0.14 * EMU_PER_INCH)}" rIns="${Math.round(0.14 * EMU_PER_INCH)}" ` +
    `tIns="45720" bIns="45720" anchor="ctr" wrap="square"><a:normAutofit/></a:bodyPr>` +
    `<a:lstStyle/>${paragraphs}</p:txBody></p:sp>`
  );
}

/** A filled rectangle with no text — the crest band, the seam. SQUARE, always. */
function rectShape(id: number, name: string, box: { h: number; w: number; x: number; y: number }, fill: string): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.w}" cy="${box.h}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${fill}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`
  );
}

/** The reversed mark as a picture, referencing the one embedded image (rId2). */
function picShape(id: number, box: { h: number; w: number; x: number; y: number }): string {
  return (
    `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Sato Pharma"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.w}" cy="${box.h}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
  );
}

/** The crest band, the mark and the brand seam — the head of every slide. */
function crestShapes(hasLogo: boolean): string {
  const band = rectShape(30, "Crest", { h: CREST_H, w: SLIDE_W, x: 0, y: 0 }, CREST);
  const seam = rectShape(31, "Seam", { h: SEAM_H, w: SLIDE_W, x: 0, y: CREST_H }, LIGHT);
  const mark = hasLogo
    ? picShape(32, { h: LOGO_H, w: LOGO_W, x: Math.round((SLIDE_W - LOGO_W) / 2), y: Math.round((CREST_H - LOGO_H) / 2) })
    : textShape(32, "Wordmark", { h: CREST_H, w: SLIDE_W, x: 0, y: 0 },
        paragraph("SATO PHARMA", { align: "ctr", bold: true, color: WHITE, size: 1600 }), null);
  return band + mark + seam;
}

/** An outlined rectangle — no fill, a coloured stroke. The field keylines. */
function outlineRect(id: number, name: string, box: { h: number; w: number; x: number; y: number }, color: string, w: number): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.w}" cy="${box.h}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/>` +
    `<a:ln w="${w}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:ln></p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`
  );
}

// The field the content sits in — between the crest and the plinth.
const FIELD_X = inch(0.32);
const FIELD_Y = inch(0.72);
const FIELD_R = SLIDE_W - inch(0.32);
const FIELD_B = inch(6.92);

/** The double keyline and the four bracket corners — the Spotlight sheet's bracketed field. */
function fieldFrame(): string {
  const w = FIELD_R - FIELD_X;
  const h = FIELD_B - FIELD_Y;
  const outer = outlineRect(50, "Field", { h, w, x: FIELD_X, y: FIELD_Y }, HAIR, 6350);
  const inset = inch(0.05);
  const inner = outlineRect(51, "Field inner", { h: h - inset * 2, w: w - inset * 2, x: FIELD_X + inset, y: FIELD_Y + inset }, LIGHT, 3175);
  // Four L-brackets in ink, two thin rects each.
  const L = inch(0.34);
  const T = inch(0.03);
  let id = 52;
  const brk = (x: number, y: number, horizX: number, vertY: number): string => {
    const a = rectShape(id++, "Bracket", { h: T, w: L, x: horizX, y }, INK);
    const b = rectShape(id++, "Bracket", { h: L, w: T, x, y: vertY }, INK);
    return a + b;
  };
  const corners =
    brk(FIELD_X, FIELD_Y, FIELD_X, FIELD_Y) + // TL
    brk(FIELD_R - T, FIELD_Y, FIELD_R - L, FIELD_Y) + // TR
    brk(FIELD_X, FIELD_B - T, FIELD_X, FIELD_B - L) + // BL
    brk(FIELD_R - T, FIELD_B - T, FIELD_R - L, FIELD_B - L); // BR
  return outer + inner + corners;
}

/** The plinth — a dark band closing the slide, matching the crest, carrying the record. */
function plinthShapes(leftText: string, rightText: string): string {
  const y = inch(7.02);
  const h = SLIDE_H - y;
  const band = rectShape(60, "Plinth", { h, w: SLIDE_W, x: 0, y }, CREST);
  const pad = inch(0.5);
  const half = Math.round((SLIDE_W - pad * 2) / 2);
  const left = textShape(61, "Plinth L", { h, w: half, x: pad, y },
    paragraph(leftText, { color: "FFFFFF", size: 700, spc: 60 }), null);
  const right = textShape(62, "Plinth R", { h, w: half, x: pad + half, y },
    paragraph(rightText, { align: "r", color: "9AA6AF", size: 700, spc: 60 }), null);
  return band + left + right;
}

/** A value as the deck shows it. Thousands separators, and an em dash for nothing. */
function cellText(value: PackCell): string {
  if (value == null) return "—";
  return typeof value === "number" ? value.toLocaleString("en-US") : String(value);
}

function tableCell(
  text: string,
  options: {
    align: "l" | "r";
    bold?: boolean;
    fill: string;
    color: string;
    size: number;
    font?: string;
    spc?: number;
    bottomColor: string;
    bottomW: number;
  },
): string {
  // A ruled row, never a boxed cell. Only a BOTTOM line is drawn — no vertical or top rules — so the
  // table reads as a sequence of ruled rows (the Spotlight leaderboard's voice) rather than a grid
  // dropped in from a spreadsheet, which is what made the old deck look cheap.
  const lnB =
    `<a:lnB w="${options.bottomW}" cap="flat" cmpd="sng" algn="ctr">` +
    `<a:solidFill><a:srgbClr val="${options.bottomColor}"/></a:solidFill></a:lnB>`;
  return (
    `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>` +
    paragraph(text, {
      align: options.align,
      bold: options.bold,
      color: options.color,
      size: options.size,
      font: options.font,
      spc: options.spc,
    }) +
    `</a:txBody>` +
    // Schema order inside a:tcPr is lnL, lnR, lnT, lnB, then the fill. Only lnB is emitted, which is
    // still valid — it sits before the fill.
    `<a:tcPr marL="73152" marR="73152" marT="27432" marB="27432" anchor="ctr">` +
    lnB +
    `<a:solidFill><a:srgbClr val="${options.fill}"/></a:solidFill>` +
    `</a:tcPr></a:tc>`
  );
}

/**
 * Column widths, measured from what the column HOLDS rather than split evenly.
 *
 * A name column and a percentage column given the same width wastes half the slide on white space
 * and wraps "Nermeen Salah Abdelaty Abohussien" onto three lines. Left-aligned columns carry names
 * and get the room; right-aligned ones carry figures and do not.
 */
function columnWidths(section: PackSection): number[] {
  const weights = section.columns.map((_, i) => (section.align[i] === "left" ? 2.4 : 1));
  const total = weights.reduce((sum, w) => sum + w, 0);
  const widths = weights.map((w) => Math.floor((TABLE_W * w) / total));
  // Rounding lands on the last column, so the grid totals the table's own width exactly.
  widths[widths.length - 1] += TABLE_W - widths.reduce((sum, w) => sum + w, 0);
  return widths;
}

function sectionTable(section: PackSection): string {
  const widths = columnWidths(section);
  const shown = section.rows.slice(0, ROW_CAP);
  // Wide tables get smaller type rather than a horizontal squeeze that clips the figures.
  const size = section.columns.length > 6 ? 800 : 900;
  const headSize = section.columns.length > 6 ? 700 : 800;

  const header =
    `<a:tr h="${HEADER_ROW_H}">` +
    section.columns
      .map((label, i) =>
        // Tracked caps on the house brand blue, closed by a deep rule — the PDF's own header voice.
        tableCell(label.toUpperCase(), {
          align: section.align[i] === "left" ? "l" : "r",
          bold: true,
          color: WHITE,
          fill: BLUE,
          size: headSize,
          spc: 30,
          bottomColor: DEEP,
          bottomW: 19050,
        }),
      )
      .join("") +
    `</a:tr>`;

  const body = shown
    .map((row, r) => {
      // The house zebra at 6%, and nothing else filled.
      const fill = r % 2 === 1 ? TINT : WHITE;
      const last = r === shown.length - 1;
      const cells = section.columns
        .map((_, i) => {
          const right = section.align[i] === "right";
          // Figures in the serif, in ink — the leaderboard's voice for a number. The first column
          // (the name) reads in ink too; everything else stays body Calibri.
          return tableCell(cellText(row[i] ?? null), {
            align: right ? "r" : "l",
            bold: right || i === 0,
            color: right || i === 0 ? INK : BODY,
            fill,
            size,
            font: right ? SERIF : "Calibri",
            bottomColor: last ? DEEP : HAIR,
            bottomW: last ? 19050 : 6350,
          });
        })
        .join("");
      return `<a:tr h="${BODY_ROW_H}">${cells}</a:tr>`;
    })
    .join("");

  const height = HEADER_ROW_H + shown.length * BODY_ROW_H;

  return (
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="20" name="Table"/>` +
    `<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm><a:off x="${MARGIN}" y="${TABLE_Y}"/><a:ext cx="${TABLE_W}" cy="${height}"/></p:xfrm>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">` +
    `<a:tbl><a:tblPr firstRow="1" bandRow="0"/>` +
    `<a:tblGrid>${widths.map((w) => `<a:gridCol w="${w}"/>`).join("")}</a:tblGrid>` +
    header + body +
    `</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
  );
}

/**
 * The cover's "in this pack" — a ruled index that FILLS its column, the way the PDF cover's does.
 *
 * A plain text list left the right half of the cover empty below it, which is what read as cheap. So
 * the sections are laid in a borderless table with a hairline under each row, sized to as many rows
 * as the column holds, and the rest named "+ N more".
 */
function indexTable(sections: readonly PackSection[], x: number, y: number, w: number, availH: number): string {
  const rowH = inch(0.32);
  const fit = Math.max(1, Math.floor(availH / rowH));
  const overflow = sections.length > fit;
  const showN = overflow ? fit - 1 : sections.length;
  const c1 = Math.round(w * 0.1);
  const c2 = w - c1;
  const row = (num: string, title: string, titleColor: string) =>
    `<a:tr h="${rowH}">` +
    tableCell(num, { align: "l", bold: true, color: LIGHT, fill: "FFFFFF", size: 950, font: SERIF, bottomColor: HAIR, bottomW: 6350 }) +
    tableCell(title, { align: "l", color: titleColor, fill: "FFFFFF", size: 900, bottomColor: HAIR, bottomW: 6350 }) +
    `</a:tr>`;
  let body = sections.slice(0, showN).map((s, i) => row(String(i + 1).padStart(2, "0"), s.title, INK)).join("");
  if (overflow) body += row("", `+ ${sections.length - showN} more sections`, MUTED);
  const nRows = showN + (overflow ? 1 : 0);
  const height = nRows * rowH;
  return (
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="21" name="Index"/>` +
    `<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${height}"/></p:xfrm>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">` +
    `<a:tbl><a:tblPr firstRow="0" bandRow="0"/>` +
    `<a:tblGrid><a:gridCol w="${c1}"/><a:gridCol w="${c2}"/></a:tblGrid>` +
    body +
    `</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
  );
}

function slideXml(shapes: string): string {
  return (
    `${XML_HEAD}<p:sld ${NS_P}><p:cSld><p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>` +
    `<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    shapes +
    `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
  );
}

/** The short tracked tick under an eyebrow — the PDF's one piece of punctuation. */
function tick(id: number, x: number, y: number): string {
  return rectShape(id, "Tick", { h: inch(0.028), w: inch(0.55), x, y }, INK);
}

function coverSlide(pack: SalesReviewPack, generated: string, hasLogo: boolean, sheetTotal: number): string {
  // Two framed columns, divided by a hairline. Left: the title block. Right: the ruled index that
  // fills its column. The measures are worked from the field so the divider lands between them.
  const leftX = MARGIN;
  const rightEdge = FIELD_R - inch(0.18);
  const totalW = rightEdge - leftX;
  const leftW = Math.round(totalW * 0.52);
  const gap = inch(0.55);
  const rightX = leftX + leftW + gap;
  const rightW = rightEdge - rightX;
  const dividerX = leftX + leftW + Math.round(gap / 2);
  const indexY = inch(1.5);
  const indexAvailH = FIELD_B - inch(0.2) - indexY;

  // The coverage block — a quiet wash panel holding the honesty line, labelled like the index, so
  // the left column reads as a deliberate block rather than a title floating over white.
  const panelY = inch(3.55);
  const panelH = inch(2.55);
  const padX = inch(0.32);

  const shapes = [
    crestShapes(hasLogo),
    fieldFrame(),
    // ── left: the title block ──
    textShape(2, "Eyebrow", { h: inch(0.28), w: leftW, x: leftX, y: EYEBROW_Y },
      paragraph("SALES REVIEW", { color: BLUE, bold: true, size: 1050, spc: 140 }), null),
    tick(33, leftX, inch(1.2)),
    textShape(3, "Subject", { h: inch(1.1), w: leftW, x: leftX, y: inch(1.44) },
      paragraph(pack.subject.title, { bold: true, color: INK, size: 3600, font: SERIF }), null),
    rectShape(35, "Title rule", { h: inch(0.02), w: Math.min(leftW, inch(4.6)), x: leftX, y: inch(2.62) }, INK),
    textShape(4, "Window", { h: inch(0.45), w: leftW, x: leftX, y: inch(2.85) },
      paragraph(pack.subject.windowLabel, { bold: true, color: LIGHT, size: 1800, font: SERIF }), null),
    // ── the coverage panel ──
    rectShape(37, "Coverage panel", { h: panelH, w: leftW, x: leftX, y: panelY }, WASH),
    // A light seam down the panel's leading edge — the brand accent, so the wash is not a bare box.
    rectShape(38, "Panel seam", { h: panelH, w: inch(0.03), x: leftX, y: panelY }, LIGHT),
    textShape(39, "Coverage label", { h: inch(0.24), w: leftW - padX * 2, x: leftX + padX, y: panelY + inch(0.24) },
      paragraph("WHAT THIS WINDOW HOLDS", { color: BLUE, bold: true, size: 850, spc: 120 }), null),
    // The coverage note is the honesty line the screen carries: what the window holds, and what is
    // held OUT of it. It travels onto the cover so a deck read in a meeting still says so.
    textShape(5, "Coverage", { h: panelH - inch(0.7), w: leftW - padX * 2, x: leftX + padX, y: panelY + inch(0.6) },
      paragraph(pack.coverageNote, { color: BODY, size: 1050 }), null),
    // Review, not a payout record — the pack must never read as one. Kept on the cover.
    textShape(6, "Meta", { h: inch(0.3), w: leftW, x: leftX, y: inch(6.5) },
      paragraph(`Generated ${generated}.  ·  Review, not a payout record.`, { color: MUTED, italic: true, size: 850 }), null),
    // ── the divider ──
    rectShape(36, "Divider", { h: FIELD_B - FIELD_Y - inch(0.4), w: inch(0.008), x: dividerX, y: FIELD_Y + inch(0.2) }, HAIR),
    // ── right: the ruled index ──
    textShape(7, "Index title", { h: inch(0.3), w: rightW, x: rightX, y: EYEBROW_Y },
      paragraph("IN THIS PACK", { color: BLUE, bold: true, size: 1050, spc: 140 }), null),
    tick(34, rightX, inch(1.2)),
    pack.sections.length > 0
      ? indexTable(pack.sections, rightX, indexY, rightW, indexAvailH)
      : textShape(8, "Empty", { h: inch(1), w: rightW, x: rightX, y: indexY },
          paragraph("No metrics were chosen, so this pack has no sections. Tick what you want on the Business Review page and export again.", { color: MUTED, size: 1050 }), null),
    plinthShapes(`Sato Pharma  ·  Sales Review  ·  ${pack.subject.windowLabel}`, `Sheet 1 of ${sheetTotal}  ·  SATO-DIS-2026-01 v1.0`),
  ];
  return slideXml(shapes.join(""));
}

function sectionSlide(
  section: PackSection,
  index: number,
  total: number,
  hasLogo: boolean,
  windowLabel: string,
  sheetNo: number,
  sheetTotal: number,
): string {
  const inner = SLIDE_W - MARGIN * 2;
  const cut = section.rows.length - Math.min(section.rows.length, ROW_CAP);
  const shapes = [
    crestShapes(hasLogo),
    fieldFrame(),
    textShape(2, "Eyebrow", { h: inch(0.26), w: inner, x: MARGIN, y: EYEBROW_Y },
      paragraph(`SECTION ${String(index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}`, { color: BLUE, bold: true, size: 900, spc: 120 }), null),
    tick(33, MARGIN, inch(1.13)),
    // The title in the serif display, in ink — the way the Spotlight sheet and the PDF set it.
    textShape(3, "Title", { h: TITLE_H, w: inner, x: MARGIN, y: TITLE_Y },
      paragraph(section.title, { bold: true, color: INK, size: 2200, font: SERIF }), null),
    // Every honesty rule the screen carries travels with its section — that the achievement beside
    // a rep is his AREA's, that the months do not sum. In the file, not only on the page.
    textShape(4, "Note", { h: NOTE_H, w: inner, x: MARGIN, y: NOTE_Y },
      paragraph(section.note, { color: MUTED, italic: true, size: 950 }), null),
    sectionTable(section),
    plinthShapes(`Sato Pharma  ·  Sales Review  ·  ${windowLabel}`, `Sheet ${sheetNo} of ${sheetTotal}  ·  SATO-DIS-2026-01 v1.0`),
  ];
  if (cut > 0) {
    shapes.push(
      textShape(
        5,
        "Cut",
        { h: inch(0.3), w: inner, x: MARGIN, y: inch(6.62) },
        paragraph(
          `${cut} more row${cut === 1 ? "" : "s"} are in the Excel version of this pack — a slide is a presentation, not the whole dataset.`,
          { color: MUTED, italic: true, size: 850 },
        ),
        null,
      ),
    );
  }
  return slideXml(shapes.join(""));
}

function emptySlide(hasLogo: boolean, windowLabel: string): string {
  const inner = SLIDE_W - MARGIN * 2;
  return slideXml(
    crestShapes(hasLogo) +
      fieldFrame() +
      textShape(2, "Eyebrow", { h: inch(0.26), w: inner, x: MARGIN, y: EYEBROW_Y },
        paragraph("SALES REVIEW", { color: BLUE, bold: true, size: 900, spc: 120 }), null) +
      tick(33, MARGIN, inch(1.13)) +
      textShape(3, "Title", { h: TITLE_H, w: inner, x: MARGIN, y: TITLE_Y },
        paragraph("Nothing was chosen", { bold: true, color: INK, size: 2200, font: SERIF }), null) +
      textShape(4, "Why", { h: inch(1), w: inner, x: MARGIN, y: NOTE_Y },
        paragraph(
          "No metrics were chosen, so this pack has no sections. Tick what you want on the Business Review page and export again.",
          { color: MUTED, size: 1200 },
        ), null) +
      plinthShapes(`Sato Pharma  ·  Sales Review  ·  ${windowLabel}`, `Sheet 2 of 2  ·  SATO-DIS-2026-01 v1.0`),
  );
}

// ── the fixed parts ────────────────────────────────────────────────────────────────────────────
// Small, and written out rather than templated, because a presentation needs all of them present
// and correct before PowerPoint will open it at all.

const THEME = `${XML_HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Sato">` +
  `<a:themeElements><a:clrScheme name="Sato">` +
  `<a:dk1><a:srgbClr val="${BODY}"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>` +
  `<a:dk2><a:srgbClr val="${DEEP}"/></a:dk2><a:lt2><a:srgbClr val="${TINT}"/></a:lt2>` +
  `<a:accent1><a:srgbClr val="${DEEP}"/></a:accent1><a:accent2><a:srgbClr val="${BLUE}"/></a:accent2>` +
  `<a:accent3><a:srgbClr val="${hex(HOUSE_COLORS.light)}"/></a:accent3><a:accent4><a:srgbClr val="${HAIR}"/></a:accent4>` +
  `<a:accent5><a:srgbClr val="${MUTED}"/></a:accent5><a:accent6><a:srgbClr val="${TINT}"/></a:accent6>` +
  `<a:hlink><a:srgbClr val="${BLUE}"/></a:hlink><a:folHlink><a:srgbClr val="${MUTED}"/></a:folHlink></a:clrScheme>` +
  `<a:fontScheme name="Sato"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>` +
  `<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>` +
  `<a:fmtScheme name="Sato">` +
  `<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>` +
  `<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>` +
  `<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>` +
  `<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>` +
  `</a:fmtScheme></a:themeElements></a:theme>`;

const SLIDE_MASTER = `${XML_HEAD}<p:sldMaster ${NS_P}><p:cSld>` +
  `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>` +
  `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
  `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
  `</p:spTree></p:cSld>` +
  `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" ` +
  `accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
  `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`;

const SLIDE_LAYOUT = `${XML_HEAD}<p:sldLayout ${NS_P} type="blank" preserve="1"><p:cSld name="Blank">` +
  `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
  `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
  `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

const TABLE_STYLES = `${XML_HEAD}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
  `def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`;

/**
 * The deck.
 *
 * One slide per section, in the model's own order, behind a cover. Returns a Buffer so the route
 * hands it back exactly as it hands back the PDF and the workbook.
 */
export async function renderPackPptx(pack: SalesReviewPack): Promise<Buffer> {
  const generated =
    new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Africa/Cairo",
    }).format(new Date(pack.generatedAt)) + " Cairo";

  const logo = crestLogo();
  const hasLogo = logo !== null;
  const total = pack.sections.length;
  const sheetTotal = pack.sections.length === 0 ? 2 : pack.sections.length + 1;
  const slides = [
    coverSlide(pack, generated, hasLogo, sheetTotal),
    ...(pack.sections.length === 0
      ? [emptySlide(hasLogo, pack.subject.windowLabel)]
      : pack.sections.map((section, i) => sectionSlide(section, i, total, hasLogo, pack.subject.windowLabel, i + 2, sheetTotal))),
  ];

  const zip = new JSZip();
  if (hasLogo && logo) zip.file("ppt/media/image1.png", logo);

  zip.file(
    "[Content_Types].xml",
    `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      (hasLogo ? `<Default Extension="png" ContentType="image/png"/>` : "") +
      `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
      `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>` +
      `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>` +
      `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` +
      `<Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>` +
      slides
        .map(
          (_, i) =>
            `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
        )
        .join("") +
      `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
      `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
      `</Types>`,
  );

  zip.file(
    "_rels/.rels",
    `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
      `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>` +
      `</Relationships>`,
  );

  // Slide ids start at 256 — PowerPoint reserves everything below it.
  const slideIds = slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("");
  zip.file(
    "ppt/presentation.xml",
    `${XML_HEAD}<p:presentation ${NS_P} saveSubsetFonts="1">` +
      `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
      `<p:sldIdLst>${slideIds}</p:sldIdLst>` +
      `<p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/><p:notesSz cx="6858000" cy="9144000"/>` +
      `</p:presentation>`,
  );

  zip.file(
    "ppt/_rels/presentation.xml.rels",
    `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>` +
      slides
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
        )
        .join("") +
      `<Relationship Id="rId${slides.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>` +
      `<Relationship Id="rId${slides.length + 3}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles" Target="tableStyles.xml"/>` +
      `</Relationships>`,
  );

  zip.file("ppt/slideMasters/slideMaster1.xml", SLIDE_MASTER);
  zip.file(
    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>` +
      `</Relationships>`,
  );

  zip.file("ppt/slideLayouts/slideLayout1.xml", SLIDE_LAYOUT);
  zip.file(
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
    `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>` +
      `</Relationships>`,
  );

  zip.file("ppt/theme/theme1.xml", THEME);
  zip.file("ppt/tableStyles.xml", TABLE_STYLES);

  slides.forEach((xml, i) => {
    zip.file(`ppt/slides/slide${i + 1}.xml`, xml);
    zip.file(
      `ppt/slides/_rels/slide${i + 1}.xml.rels`,
      `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
        (hasLogo
          ? `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>`
          : "") +
        `</Relationships>`,
    );
  });

  const title = `Sales Review — ${pack.subject.title} — ${pack.subject.windowLabel}`;
  zip.file(
    "docProps/core.xml",
    `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
      `xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ` +
      `xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
      `<dc:title>${esc(title)}</dc:title><dc:creator>Phoenix Workforce</dc:creator>` +
      `<cp:lastModifiedBy>Phoenix Workforce</cp:lastModifiedBy>` +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${pack.generatedAt}</dcterms:created>` +
      `<dcterms:modified xsi:type="dcterms:W3CDTF">${pack.generatedAt}</dcterms:modified>` +
      `</cp:coreProperties>`,
  );

  zip.file(
    "docProps/app.xml",
    `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ` +
      `xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
      `<Application>Phoenix Workforce</Application><Slides>${slides.length}</Slides>` +
      `<Company>Sato Pharma</Company></Properties>`,
  );

  return Buffer.from(await zip.generateAsync({ compression: "DEFLATE", type: "nodebuffer" }));
}
