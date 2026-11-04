import { readFileSync } from "node:fs";
import path from "node:path";

import ExcelJS from "exceljs";

import { lineHasOfficeChannel } from "@/lib/sales/office-distributor";
import { unprotectExcelWorkbook } from "@/lib/sales/closing-workbook-lock";
import { type ClosingRepRankingCarve, type RepRanking } from "@/lib/sales/closing-rep-ranking";
import {
  rankingDressFor,
  type RankingDress,
} from "@/lib/sales/closing-ranking-dress";
import { CLOSING_ROWS_SHEET_NAME, closingRowsSheetSpec } from "@/lib/sales/closing-rows-sheet";
import { CLOSING_EPDA_SHEET_NAME, type ClosingEpdaSheetSpec } from "@/lib/sales/closing-epda-sheet";
import type { ClosingDetailRow } from "@/lib/sales/monthly-closing-details";
import {
  DIRECT,
  DIST,
  OFFICE,
  type LegacySeat,
  type LegacyWho,
  type RankingPublication,
  toLegacyShape,
} from "@/lib/sales/closing-rep-ranking-legacy-shape";

// ─────────────────────────────────────────────────────────────────────────────
// THE REP RANKING WORKBOOK, wearing ITS LINE'S OWN IDENTITY.
//
// This is the file a viewer downloads from the employee portal's Monthly Closing, and from the admin
// closing screen's third export button (owner, 2026-10-13: "wire this sheet instead of the current
// sheet in the employee portal ... forget about the other sheet. This will replace it in the employee
// portal, any role" - and, the same message, "everyone his scope, not me").
//
// 🔴 ONE BUILDER, THREE IDENTITIES, AND NEVER A COPY OF IT. It opened on Anti Infective alone ("wire
// this only to the anti-infective line. Leave PD and CNS as they are") and he widened it the same
// day: "now use the CNS identity to make the new identity ranking rep closing sheet, exactly as you
// did for anti-infective, but for CNS with CNS identity." So every line-specific colour, folder and
// sentence lives in `closing-ranking-dress.ts` and arrives here as ONE record. Pedia joined them on
// 2026-10-13 ("build the Pedia ranking dress"). A line with no dress has no ranking workbook at all - `isRepRankingLine`
// is the gate, and it is pinned to the dress registry by a test so the two cannot drift.
//
// WHAT WEARS WHAT. Each identity is an EVENT look built for a 2480-wide rendered piece: a radial
// field, grain, a vignette, a two-colour seam, letter-spaced micro labels, a box-reflect under the
// cartons. Excel can do none of those. So the piece is split:
//
//   THE CHROME IS RENDERED, NOT IMITATED. The masthead and the sheet strips are real pixels from
//   that identity's own reference render at its own width, with its own self-hosted typefaces,
//   committed under public/brand/<line>-ranking/. Nothing about the field, the seam, the cartons or
//   the Arabic wordmark is approximated in cells.
//
//   THE TABLE WEARS THE IDENTITY'S TOKENS. Fills, rules, inks and bars are things Excel does
//   natively, so they use that identity's own hex values - `dress.colours`, and nowhere else.
//
//   WHAT IS NOT THE IDENTITY'S IS SAID SO ON THE TRUST SHEET, in that line's own words, because the
//   facts differ: the CNS identity has a zebra of its own and the Anti-Infective identity has none.
//
// THE FIGURES ARE NEVER COMPUTED HERE. Every one arrives in `RepRanking`, lifted out of the
// published closing (closing-rep-ranking.ts). Absence is never a zero, a seat with no target is
// unranked rather than scored 0%, vacant seats are ranked rather than hidden, a district is value
// over value and never a mean of percentages, and units are never added across product codes.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The ten files every line's chrome folder holds, under the same names.
 *
 * The FOLDER is the dress's (`dress.bannerDir`); the names are shared, so a second identity is a
 * second folder of ten renders rather than a second table of filenames to keep in step.
 */
const BANNER_FILES = {
  districts: "strip-districts.png",
  filter: "strip-filter.png",
  full: "banner-full.png",
  months: "strip-months.png",
  product: "strip-product.png",
  ranking: "strip-ranking.png",
  regions: "strip-regions.png",
  trend: "strip-trend.png",
  units: "strip-units.png",
  who: "strip-who.png",
} as const;

type BannerKey = keyof typeof BANNER_FILES;

// ---------------------------------------------------------------------------
// THE TOKENS THAT ARE THE SAME ON EVERY LINE.
//
// The house inks, which all three sibling identities share unchanged, plus the probation marker,
// which is NOT any identity's - the owner asked for it in yellow by name. Everything that changes
// with the line is in `dress.colours`.
// ---------------------------------------------------------------------------
const INK = "FF0A1322";
const SOFT = "FF69757E";
const HAIR = "FFDDE4E8";
const LABEL_GREY = "FF8C98A4";
// NOT any identity's — the owner asked for the probation marker by name
const PROB_FILL = "FFFFF2C2";
const PROB_TEXT = "FF7A4F00";
const FONT = "Calibri";

const money = "#,##0;-#,##0";
const units = "#,##0;[Red]-#,##0";
const unitsSigned = "+#,##0;[Red]-#,##0;0";
const moneySigned = "+#,##0;-#,##0;0";
const pct = "0.00%";
const pct1 = "0.0%";
/** Excel's "show nothing" mask — the Performance column holds the figure a data bar draws. */
const hidden = ";;;";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
// 🔴 NEITHER OF THESE MAY THROW. They name a column head and a caption, and on 2026-10-13 one
// of them took the whole download down: the Trust sheet read `monthName(TREND[2])` while the trend
// held ONE month, so an undefined period reached `.split` and the owner got "Cannot read properties
// of undefined (reading 'split')" instead of a workbook. The indexing is fixed at every call site
// below - the trend is 1, 2 or 3 months and never assumed three - and these two stop being able to
// cause it: a period they cannot read comes back as itself, which is wrong in a caption and
// survivable, where a throw loses the file.
const monthName = (period: string | null | undefined): string => {
  const raw = String(period ?? "").trim();
  const [year, month] = raw.split("-");
  const name = MONTHS[Number(month) - 1];
  return name && year ? `${name} ${year}` : raw;
};
const monthShort = (period: string | null | undefined): string => {
  const raw = String(period ?? "").trim();
  const name = MONTHS[Number(raw.split("-")[1]) - 1];
  return name ? `${name.slice(0, 3)} ${raw.slice(2, 4)}` : raw;
};

type Argb = string;
type BorderStyle = "thin" | "hair" | "medium";

const rule = (color: Argb, style: BorderStyle = "thin") => ({ color: { argb: color }, style });
const text = (size = 10, color: Argb = INK) => ({ color: { argb: color }, name: FONT, size });
const bold = (size: number, color: Argb = INK) => ({ bold: true, color: { argb: color }, name: FONT, size });
const CENTRE = { horizontal: "center" as const, vertical: "middle" as const, wrapText: true };

type Sheet = ExcelJS.Worksheet;

type CellOptions = {
  bracket?: Argb;
  color?: Argb;
  fill?: Argb;
  font?: Partial<ExcelJS.Font>;
  muted?: boolean;
  numFmt?: string;
  size?: number;
  zebra?: boolean;
};

const sum = <T,>(rows: readonly T[], pick: (row: T) => number | null | undefined): number =>
  rows.reduce((total, row) => total + (pick(row) || 0), 0);

/** Excel's own column pixel width for a width given in characters. */
const pxOf = (chars: number): number => Math.round(chars * 7) + 5;

const BANNER_RATIO = { full: 1382 / 2480, strip: 176 / 2480 };

/**
 * One build's worth of workbook plumbing. A class rather than module-level state because this runs
 * inside a request: two viewers exporting at once must not share a banner-image registry.
 */
class RankingWorkbook {
  readonly workbook = new ExcelJS.Workbook();

  private readonly bannerIds = new Map<BannerKey, number>();

  private readonly bannerBytes = new Map<BannerKey, string>();

  // Declared and assigned rather than written as a constructor parameter property: the test runner
  // loads these modules under Node type-STRIPPING, which refuses a parameter property outright, so
  // that shorthand would make this builder untestable.
  private readonly subtitlePrefix: string;

  /**
   * What this line's workbook wears — the only place the builder learns a colour or a folder.
   *
   * 🔴 NOT NAMED `dress`: this class already has a METHOD called `dress`, which sets a sheet's page
   * setup and footer, and a field of that name assigned in the constructor shadows the prototype
   * method outright. It compiles, and then every sheet dies on `book.dress is not a function`.
   */
  readonly identity: RankingDress;

  constructor(subtitlePrefix: string, identity: RankingDress) {
    this.subtitlePrefix = subtitlePrefix;
    this.identity = identity;
    this.workbook.creator = "Sato Pharma - Phoenix Workforce";
    this.workbook.created = new Date();
  }

  /**
   * REGISTERED ON FIRST USE, never up front: a workbook that drops a sheet would otherwise still
   * ship that sheet's rendered strip inside it, and the file would carry chrome for a tab that is
   * not there.
   */
  private bannerImage(key: BannerKey): number {
    const existing = this.bannerIds.get(key);
    if (existing !== undefined) return existing;
    let base64 = this.bannerBytes.get(key);
    if (base64 === undefined) {
      base64 = readFileSync(path.join(process.cwd(), this.identity.bannerDir, BANNER_FILES[key])).toString("base64");
      this.bannerBytes.set(key, base64);
    }
    const id = this.workbook.addImage({ base64, extension: "png" });
    this.bannerIds.set(key, id);
    return id;
  }

  get bannerCount(): number {
    return this.bannerIds.size;
  }

  dress(sheet: Sheet, subtitle: string): Sheet {
    sheet.pageSetup = {
      fitToHeight: 0,
      fitToPage: true,
      fitToWidth: 1,
      margins: { bottom: 0.45, footer: 0.2, header: 0.2, left: 0.35, right: 0.35, top: 0.45 },
      orientation: "landscape",
      paperSize: 9,
    };
    sheet.headerFooter = {
      oddFooter:
        `&L&"${FONT}"&8&K0A1322SATO-DIS-2026-01 v1.0  -  ${this.subtitlePrefix}  -  ${subtitle}` +
        `&R&"${FONT}"&8&K69757EPage &P of &N`,
    };
    sheet.views = [{ showGridLines: false }];
    return sheet;
  }

  /**
   * Drops the rendered identity chrome over a block of spacer rows sized to hold it.
   *
   * A WORKED SHEET GETS THE BAR, NEVER THE MASTHEAD. Excel's frozen pane holds everything above the
   * split, so chrome sitting over a table's header row is pinned to the top of the window and cannot
   * be scrolled away: a tall masthead does not push the numbers down, it eats the window. The sheets
   * that are read for figures carry the 2480 x 176 letterhead bar; the full masthead lives on Trust,
   * which is the document-identity page and is never scrolled for a number.
   */
  banner(sheet: Sheet, key: BannerKey, widths: readonly number[]): number {
    const widthPx = widths.reduce((total, width) => total + pxOf(width), 0);
    const ratio = key === "full" ? BANNER_RATIO.full : BANNER_RATIO.strip;
    const heightPx = Math.round(widthPx * ratio);
    const rows = key === "full" ? 14 : 3;
    const perRowPt = (heightPx / rows) * 0.75;
    for (let row = 1; row <= rows; row += 1) sheet.getRow(row).height = perRowPt;
    sheet.addImage(this.bannerImage(key), {
      editAs: "absolute",
      ext: { height: heightPx, width: widthPx },
      tl: { col: 0, row: 0 },
    });
    return rows + 2; // one clear row under the chrome
  }
}

type Keycard = { colour?: Argb; fmt?: string; label: string; sub: string; value: string | number };

/**
 * The sheet helpers, bound to one build's dress.
 *
 * A FACTORY RATHER THAN MODULE CONSTANTS, and rather than a dress argument on each of them. These
 * are called about a hundred and twenty times between them, so threading a parameter through every
 * call site would be a hundred and twenty chances to pass the wrong line's colour; and module-level
 * mutable state would be shared by two viewers exporting different lines in the same process, which
 * is the same reason the banner registry lives on the instance. One closure per build, no argument,
 * and a helper cannot see any colour but its own line's.
 */
function dressedHelpers(dress: RankingDress) {
  const {
    covered: COVERED,
    field: FIELD,
    seamLeft: SEAM_LEFT,
    seamRight: SEAM_RIGHT,
    vacantFill: VACANT_FILL,
    zebra: ZEBRA,
  } = dress.colours;
  const EYEBROW = dress.colours.eyebrow;
  const SUB = dress.colours.keycardSub;
  // A vacant seat is written in the alarm colour's deeper tone, which is the one that holds on white.
  const VACANT_TEXT = dress.colours.shortDeep;

  function keycards(sheet: Sheet, row: number, cards: readonly Keycard[], widthCols: number): number {
    // the field for the ground, the identity's eyebrow for the label, white for the figure
    const span = Math.max(2, Math.floor(widthCols / cards.length));
    cards.forEach((card, index) => {
      const first = index * span + 1;
      const last = index === cards.length - 1 ? widthCols : first + span - 1;
      const lines: Array<[number, string | number, Partial<ExcelJS.Font>, string | null]> = [
        [row, card.label, { bold: true, color: { argb: EYEBROW }, name: FONT, size: 8 }, null],
        [row + 1, card.value, { bold: true, color: { argb: card.colour ?? "FFFFFFFF" }, name: FONT, size: 18 }, card.fmt ?? null],
        [row + 2, card.sub, { color: { argb: SUB }, name: FONT, size: 8 }, null],
      ];
      for (const [at, value, font, numFmt] of lines) {
        sheet.mergeCells(at, first, at, last);
        const target = sheet.getCell(at, first);
        target.value = value;
        target.font = font;
        target.alignment = CENTRE;
        target.fill = { fgColor: { argb: FIELD }, pattern: "solid", type: "pattern" };
        if (numFmt) target.numFmt = numFmt;
      }
    });
    sheet.getRow(row).height = 11;
    sheet.getRow(row + 1).height = 24;
    sheet.getRow(row + 2).height = 11;

    // THE SEAM — the identity's signature, closing the field into the white below it
    const seamRow = row + 3;
    const half = Math.ceil(widthCols / 2);
    for (let col = 1; col <= widthCols; col += 1) {
      sheet.getCell(seamRow, col).fill = {
        fgColor: { argb: col <= half ? SEAM_LEFT : SEAM_RIGHT },
        pattern: "solid",
        type: "pattern",
      };
    }
    sheet.getRow(seamRow).height = 4;
    return seamRow + 1;
  }

  function sectionLabel(sheet: Sheet, row: number, label: string, note: string | null, widthCols: number): number {
    sheet.mergeCells(row, 1, row, widthCols);
    const target = sheet.getCell(row, 1);
    target.value = note ? `${label}      ${note}` : label;
    target.font = bold(10, SOFT);
    target.alignment = CENTRE;
    sheet.getRow(row).height = 13;
    return row + 1;
  }

  function headerRow(sheet: Sheet, row: number, labels: readonly string[], widths: readonly number[]): number {
    labels.forEach((label, index) => {
      const target = sheet.getCell(row, index + 1);
      target.value = label;
      target.font = { bold: true, color: { argb: INK }, name: FONT, size: 9 };
      target.alignment = CENTRE;
      target.border = { bottom: rule(INK), top: rule(HAIR, "hair") };
    });
    widths.forEach((width, index) => {
      sheet.getColumn(index + 1).width = width;
    });
    sheet.getRow(row).height = 26;
    return row + 1;
  }

  function cell(
    sheet: Sheet,
    row: number,
    col: number,
    value: string | number | null,
    options: CellOptions = {},
  ): ExcelJS.Cell {
    const target = sheet.getCell(row, col);
    target.value = value;
    target.font = (options.font ?? text(options.size ?? 10, options.muted ? SOFT : options.color ?? INK)) as ExcelJS.Font;
    target.alignment = CENTRE;
    if (options.numFmt) target.numFmt = options.numFmt;
    if (options.fill) target.fill = { fgColor: { argb: options.fill }, pattern: "solid", type: "pattern" };
    else if (options.zebra) target.fill = { fgColor: { argb: ZEBRA }, pattern: "solid", type: "pattern" };
    target.border = {
      bottom: rule(HAIR, "hair"),
      ...(options.bracket ? { left: rule(options.bracket, "medium") } : {}),
    };
    return target;
  }

  function totalRow(sheet: Sheet, row: number, cols: number): void {
    for (let col = 1; col <= cols; col += 1) {
      const target = sheet.getCell(row, col);
      target.font = { bold: true, color: { argb: INK }, name: FONT, size: 10 };
      target.alignment = CENTRE;
      target.border = { bottom: rule(INK, "hair"), top: rule(INK) };
    }
    sheet.getRow(row).height = 19;
  }

  function footnote(sheet: Sheet, row: number, lines: readonly string[], widthCols: number): number {
    let at = row;
    for (const line of lines) {
      sheet.mergeCells(at, 1, at, widthCols);
      const target = sheet.getCell(at, 1);
      target.value = line;
      target.font = text(8.5, SOFT) as ExcelJS.Font;
      target.alignment = { horizontal: "center", vertical: "top", wrapText: true };
      sheet.getRow(at).height = Math.max(12, Math.ceil(line.length / (widthCols * 11)) * 11);
      at += 1;
    }
    return at;
  }

  function dataBar(sheet: Sheet, ref: string, options: { color?: Argb; max?: number | null } = {}): void {
    const { color = COVERED, max = null } = options;
    sheet.addConditionalFormatting({
      ref,
      rules: [
        {
          cfvo: [{ type: "num", value: 0 }, max == null ? { type: "max" } : { type: "num", value: max }],
          color: { argb: color },
          gradient: true,
          priority: 1,
          type: "dataBar",
        } as unknown as ExcelJS.ConditionalFormattingRule,
      ],
    });
  }

  function colourScale(sheet: Sheet, ref: string): void {
    sheet.addConditionalFormatting({
      ref,
      rules: [
        {
          cfvo: [{ type: "min" }, { type: "percentile", value: 50 }, { type: "max" }],
          color: [{ argb: "FFFFFFFF" }, { argb: "FFDCEAF6" }, { argb: "FF9ACBEA" }],
          priority: 2,
          type: "colorScale",
        } as unknown as ExcelJS.ConditionalFormattingRule,
      ],
    });
  }

  /**
   * How tall an outlined sub-row must be to hold a wrapped name. The owner's rule is that text WRAPS
   * and is never cut, so a fixed short row on a wrapping cell is a truncation by another name.
   */
  function nameRowHeight(name: string | null | undefined, widthChars: number): number {
    const chars = String(name ?? "").length + 3; // the arrow and its spaces
    const lines = Math.max(1, Math.ceil(chars / Math.max(8, widthChars - 1)));
    return 13 * lines;
  }

  /**
   * A rep's name cell. Vacant wears the identity's red, a rep inside his probation period wears the
   * yellow — on the NAME cell alone, so it reads as a fact about the person and not about the seat's
   * numbers.
   */
  function nameCell(
    sheet: Sheet,
    row: number,
    col: number,
    who: LegacyWho,
    options: { zebra: boolean },
  ): ExcelJS.Cell {
    if (who.vacant) {
      return cell(sheet, row, col, who.rep, {
        fill: VACANT_FILL,
        font: { bold: true, color: { argb: VACANT_TEXT }, name: FONT, size: 10 },
      });
    }
    if (who.repProbation) {
      return cell(sheet, row, col, who.rep, {
        fill: PROB_FILL,
        font: { bold: true, color: { argb: PROB_TEXT }, name: FONT, size: 10 },
      });
    }
    return cell(sheet, row, col, who.rep, { zebra: options.zebra });
  }

  return {
    cell, colourScale, dataBar, footnote, headerRow, keycards, nameCell, nameRowHeight,
    sectionLabel, totalRow,
  };
}

export type RepRankingWorkbookResult = {
  buffer: Buffer;
  /** What the build proved about itself — written onto the Trust sheet and returned for the tests. */
  facts: {
    sheetNames: string[];
    bannersEmbedded: number;
    falseCollapsesCleared: number;
    openSheets: number;
    productRows: number;
  };
};

/**
 * The five fixes ExcelJS's own output needs, applied to the EMITTED file.
 *
 * Each one was found by opening what ExcelJS wrote, not by reading its source:
 *
 *  1. `<sheetPr>` children in schema order. Excel refuses the file otherwise.
 *  2. `cfRule` priorities renumbered 1..n per sheet. Duplicated priorities make Excel repair it.
 *  3. The data-bar `extLst` x14 extension stripped — ExcelJS writes an empty `<x14:id/>`, which
 *     Excel reads as a dangling reference.
 *  4. `outlineLevelRow` set to the real outline depth, so Excel draws the outline gutter at all.
 *  5. 🔴 `collapsed="1"`, which ExcelJS stamps on EVERY outlined row. Excel ignores the flag when no
 *     row is actually hidden, so the workbook looks right there — but LIBREOFFICE honours it, and
 *     LibreOffice is what renders the PDF. The result was a file whose every row was present and
 *     whose reader saw only the last rep's products in each team. Measured on this workbook's first
 *     build: 424 rows carried the flag.
 *
 * It also REFUSES a workbook whose merged ranges overlap, which Excel silently repairs by dropping
 * cells — a corruption that reads as missing data rather than as an error.
 */
async function repairEmittedWorkbook(source: Buffer): Promise<{ buffer: Buffer; falseCollapses: number }> {
  const JSZipModule = (await import("jszip")).default;
  const zip = await JSZipModule.loadAsync(source);
  let falseCollapses = 0;
  const colNum = (letters: string): number =>
    [...letters].reduce((total, char) => total * 26 + (char.charCodeAt(0) - 64), 0);
  const boxOf = (ref: string): { c1: number; c2: number; r1: number; r2: number } | null => {
    const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(ref);
    return match
      ? { c1: colNum(match[1]), c2: colNum(match[3]), r1: Number(match[2]), r2: Number(match[4]) }
      : null;
  };

  for (const name of Object.keys(zip.files)) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) continue;
    const file = zip.file(name);
    if (!file) continue;
    const before = await file.async("string");
    let xml = before.replace(/<sheetPr>([\s\S]*?)<\/sheetPr>/, (_whole, inner: string) => {
      const take = (tag: string): string => (new RegExp(`<${tag}\\b[^>]*\\/>`).exec(inner) ?? [""])[0];
      return `<sheetPr>${["tabColor", "outlinePr", "pageSetUpPr"].map(take).join("")}</sheetPr>`;
    });
    let priority = 0;
    xml = xml.replace(/(<cfRule\b[^>]*?priority=")(\d+)(")/g, (_match, head: string, _had: string, tailQuote: string) => {
      priority += 1;
      return `${head}${priority}${tailQuote}`;
    });
    xml = xml.replace(
      /<extLst><ext uri="\{B025F937-C7B1-47D3-B67F-A62EFF666E3E\}"[^>]*><x14:id\/><\/ext><\/extLst>/g,
      "",
    );
    xml = xml.replace(/ collapsed="1"/g, () => {
      falseCollapses += 1;
      return "";
    });
    const depth = Math.max(
      0,
      ...[...xml.matchAll(/\soutlineLevel="(\d+)"/g)].map((match) => Number(match[1])),
    );
    if (depth > 0) {
      xml = xml.replace(/(<sheetFormatPr\b[^>]*?)outlineLevelRow="\d+"/, (_match, head: string) =>
        `${head}outlineLevelRow="${depth}"`);
    }
    const refs = [...xml.matchAll(/<mergeCell ref="([^"]+)"/g)].map((match) => match[1]);
    const boxes = refs.map(boxOf);
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i];
        const b = boxes[j];
        if (a && b && a.c1 <= b.c2 && b.c1 <= a.c2 && a.r1 <= b.r2 && b.r1 <= a.r2) {
          throw new Error(`${name}: merged ranges overlap — ${refs[i]} and ${refs[j]}`);
        }
      }
    }
    if (xml !== before) zip.file(name, xml);
  }
  return {
    buffer: await zip.generateAsync({ compression: "DEFLATE", type: "nodebuffer" }),
    falseCollapses,
  };
}

/**
 * Grow any row whose wrapped text needs a second line.
 *
 * The owner's rule is that text WRAPS and is never cut, so a fixed row height on a wrapping cell is
 * a truncation by another name. Chrome ABOVE a frozen split is left alone — those heights are the
 * banner's, and growing one would push the window's whole pinned strip down.
 */
function growRowsToFitWrappedText(workbook: ExcelJS.Workbook): void {
  const CHARS_PER_WIDTH = 1.35; // Calibri 9-10pt against Excel's width unit, measured
  for (const sheet of workbook.worksheets) {
    const spanWidth = new Map<string, number>();
    const covered = new Set<string>();
    for (const merge of (sheet.model.merges ?? []) as string[]) {
      const [a, b] = merge.split(":");
      const colIndex = (letters: string): number =>
        [...letters].reduce((total, char) => total * 26 + (char.charCodeAt(0) - 64), 0);
      const r1 = Number(/\d+/.exec(a)?.[0] ?? 0);
      const r2 = Number(/\d+/.exec(b)?.[0] ?? 0);
      const c1 = colIndex(/[A-Z]+/.exec(a)?.[0] ?? "A");
      const c2 = colIndex(/[A-Z]+/.exec(b)?.[0] ?? "A");
      let width = 0;
      for (let col = c1; col <= c2; col += 1) width += sheet.getColumn(col).width ?? 8.43;
      spanWidth.set(`${r1},${c1}`, width);
      for (let row = r1; row <= r2; row += 1) {
        for (let col = c1; col <= c2; col += 1) {
          if (!(row === r1 && col === c1)) covered.add(`${row},${col}`);
        }
      }
    }
    const split = (sheet.views?.[0] as { ySplit?: number } | undefined)?.ySplit ?? 0;
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber <= split) return;
      let need = 0;
      row.eachCell({ includeEmpty: false }, (target, col) => {
        if (covered.has(`${rowNumber},${col}`)) return;
        if (typeof target.value !== "string" || !target.alignment?.wrapText) return;
        const width = spanWidth.get(`${rowNumber},${col}`) ?? sheet.getColumn(col).width ?? 8.43;
        const lines = Math.ceil(target.value.length / Math.max(4, width * CHARS_PER_WIDTH));
        if (lines > 1) need = Math.max(need, lines * ((target.font?.size ?? 10) >= 10 ? 13 : 11.5) + 2);
      });
      if (need > (row.height ?? 15)) row.height = Math.ceil(need);
    });
  }
}

/** The mixed row shape the quarter sheets walk: a seat, or an area that holds no seat this month. */
type MonthRow = {
  area: string;
  code: string;
  extra?: boolean;
  noArea?: boolean;
  region: string;
  who: LegacyWho;
};

/**
 * A line reached the builder with no dress — a programming error, never a plainer file.
 *
 * `isRepRankingLine` has already refused an undressed line at the route AND at the screen's button,
 * so arriving here means those two lists have drifted apart, and the right answer is to say so
 * loudly rather than to ship a workbook in another line's colours.
 */
function noRankingDress(line: string): never {
  throw new Error(
    `No ranking dress for line "${line}" - isRepRankingLine and closing-ranking-dress.ts disagree `
    + "about which lines have a ranking workbook",
  );
}

/**
 * Build one line's rep-ranking workbook for an already-scoped, already-published month.
 *
 * Every figure comes out of `ranking`; this function only arranges and dresses them. The sheets
 * below are the build the owner signed off on 2026-10-13, carried over with their arrangement, their
 * wording and their footnotes intact — see closing-rep-ranking-legacy-shape.ts for why they read the
 * shape they do.
 */
export async function buildRepRankingWorkbook(input: {
  ranking: RepRanking;
  probationByName: ReadonlyMap<string, string>;
  carve: Pick<ClosingRepRankingCarve, "direct" | "office" | "stores">;
  /**
   * 🔴 WHAT THIS FILE COVERS WHEN IT IS NOT THE WHOLE LINE — one short line per active filter, from
   * `describeRankingFilters`. Empty on an unfiltered workbook, and then NOTHING extra is printed.
   *
   * A narrowed file is the dangerous one: its line total is smaller than the line and it is
   * forwarded as "the ranking". So when this is non-empty every sheet says so under its heading,
   * and the Trust sheet spells out the rectangle — owner, 2026-10-13, who asked for the filter to
   * be followed in the first place.
   */
  coverage?: readonly string[];
  publications?: ReadonlyArray<RankingPublication>;
  /**
   * The closing month's detail rows, for the Rows tab — owner, 2026-10-13.
   *
   * Optional: absent, the workbook is built exactly as it was before, minus that one tab. The
   * caller already holds these rows (it carves the channels out of them), so passing them costs no
   * second read of the month and the tab cannot disagree with the ranking it sits beside.
   */
  details?: readonly ClosingDetailRow[];
  /**
   * Distributor code → name, for the Rows tab's Distributor column. The owner's standing rule is
   * names, never codes; an empty map falls back to "Unnamed distributor" rather than printing one.
   */
  distributorNames?: ReadonlyMap<string, string>;
  /**
   * The EPDA tab (owner, 2026-11-04) — each area's EPDA units of each rule-2 product, after the
   * spread, drawn by the caller on the closing month's own scoped matrix (closingEpdaSheetSpec).
   * Absent or null, there is no tab.
   */
  epda?: ClosingEpdaSheetSpec | null;
}): Promise<RepRankingWorkbookResult> {
  const { ranking } = input;
  const L = toLegacyShape(ranking, input.probationByName, input.carve, input.publications ?? []);

  // 🔴 THE DRESS IS RESOLVED BEFORE A SINGLE CELL IS DRAWN, and a line without one is a programming
  // error rather than a plainer file: `isRepRankingLine` has already refused an undressed line at
  // the route AND at the screen's button, so arriving here means those two lists have drifted apart
  // and the right answer is to say so loudly, not to ship a workbook in another line's colours.
  // 🔴 `?? noRankingDress(...)` RATHER THAN AN `if (!dress) throw`: the sheets below are nested
  // functions, and a narrowing that happens in the enclosing body does not reach inside them under
  // the gate's compiler — four `TS18047: 'dress' is possibly 'null'` on the Trust sheet, which the
  // unit suite cannot see because it type-STRIPS. A helper returning `never` makes the binding
  // non-nullable at the declaration, where every closure can see it.
  const dress = rankingDressFor(ranking.line) ?? noRankingDress(ranking.line);
  const {
    base: BASE,
    covered: COVERED,
    eyebrow: EYEBROW,
    field: FIELD,
    short: SHORT,
    shortDeep: SHORT_DEEP,
    teamBand: TEAM_BAND,
    vacantKeycard: VACANT_CARD,
  } = dress.colours;
  const {
    cell, colourScale, dataBar, footnote, headerRow, keycards, nameCell, nameRowHeight,
    sectionLabel, totalRow,
  } = dressedHelpers(dress);

  const book = new RankingWorkbook(`${ranking.line} Rep Ranking`, dress);
  const wb = book.workbook;

  // The names the sheets below were written and break-tested against.
  const LINE = ranking.line;
  // THE THIRD CHANNEL IS DIRECT ON EVERY LINE BUT CNS, WHERE IT IS OFFICE. Owner, 2026-10-13:
  // "in CNS, instead of the direct order column in channels, you will put office. CNS don't have
  // direct orders. So instead of the direct you will consider the office as the direct, and put it
  // in a separate column in the tab that shows this." Read from the repo's OWN list
  // (`lineHasOfficeChannel`, office-distributor.ts) rather than a second list of lines living here,
  // and measured on production the same day: CNS September 2026 has ZERO direct rows and 6,971,180
  // EGP of Office over 3,960 rows - the line's biggest channel of all. That is also why Office
  // cannot be left inside the distributor book: the three shares would read past the sales they
  // divide.
  // A SEPARATE COLUMN, NOT A RENAMED ONE: `office` is carved in `carveChannelsByArea` and
  // `distributor` already excludes it, so Distributor + Stores + Office = Sales by construction on
  // CNS exactly as Distributor + Stores + Direct = Sales everywhere else.
  // The filter, as one sentence for a sheet heading. Empty string on an unfiltered file, which
  // every call below tests for rather than printing an empty clause.
  const COVERAGE = (input.coverage ?? []).filter((line) => line.trim().length > 0);
  const COVERS = COVERAGE.length > 0 ? COVERAGE.join("   ·   ") : "";
  const CH3 = lineHasOfficeChannel(LINE) ? OFFICE : DIRECT;
  const ch3 = (r: { dir: number; office: number }): number => (CH3 === OFFICE ? r.office : r.dir);
  // What a line with no direct column still carries in direct money, folded into its distributor
  // book by `toLegacyShape` so the three columns add to Sales. Named on the Trust sheet rather than
  // left for a reader to discover by subtracting: CNS September 2026 is -25,640 EGP of credits.
  const FOLDED_DIRECT = CH3 === OFFICE
    ? ranking.seats.reduce((whole, seat) => whole + seat.channels.direct, 0)
    : 0;
  const PERIOD = ranking.period;
  const TREND = ranking.trend;
  // 🔴 THE TREND IS 1, 2 OR 3 MONTHS - NEVER ASSUMED THREE. `resolveTrendPeriods` hands back the
  // closing month plus the offered months before it, so a line with only July offered trends over
  // July alone. Every caption, width and sentence below is built from these three constants instead
  // of the Jul-Sep span this workbook was first written against: that assumption is what crashed the
  // download on 2026-10-13, and what would otherwise have a one-month file claiming a quarter.
  const SPAN = TREND.length > 1
    ? `${monthName(TREND[0])} to ${monthName(TREND[TREND.length - 1])}`
    : monthName(TREND[0]);
  const SPAN_COUNT = ["no months", "one month", "two months", "three months"][TREND.length]
    ?? `${TREND.length} months`;
  const SPAN_PLUS = TREND.map(monthName).join(" PLUS ").toUpperCase();
  const { DM_OF, PRODUCTS_BY_AREA, SEATS, TEAMS } = L;
  const {
    achievement, apOf, apSalesTotal, apTargetOf, areaRegion, cellsOf, holderOf,
    lineSales, lineTarget, monthOf, monthTargetOf, productFamily, productName,
    targetRows, targetUnitsOf, unitsOf,
  } = L;
  const dayOf = (iso: string | null): string =>
    iso
      ? new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
        day: "2-digit", month: "short", timeZone: "Africa/Cairo", year: "numeric",
      })
      : "";

  const HEADS = ["Rank", "Region", "Medical rep", "Area", "District manager",
    "Distributor EGP", "Stores EGP", `${CH3} EGP`, "Sales EGP",
    "Distributor %", "Stores %", `${CH3} %`,
    "Target EGP", "Gap to target", "Achievement", "Performance", "Share of line", "vs last month"];
  const WIDTHS = [7, 14, 27, 19, 25, 13, 11, 11, 13, 10, 10, 10, 13, 12, 11, 12, 10, 11];

  function sheetRanking() {
    const COLS = HEADS.length;
    const ws = book.dress(wb.addWorksheet("Ranking", { properties: { tabColor: { argb: FIELD } } }), monthName(PERIOD));
    const { rows, ranked, total } = SEATS;
    const t = lineTarget(PERIOD);
    const a = achievement(total, t);
    const vacant = rows.filter((r) => r.who.vacant);
    const vacantValue = sum(vacant, (r) => r.sales);
    const probation = rows.filter((r) => r.who.repProbation);
    const storeTotal = sum(rows, (r) => r.store);

    let row = book.banner(ws, "ranking", WIDTHS);
    row = keycards(ws, row, [
      { label: "SALES", value: total, fmt: money, sub: `EGP  ·  ${Math.round(storeTotal / 1000)}k of it through warehouses` },
      { label: "TARGET", value: t, fmt: money, sub: `${rows.length} seats, ${ranked} with a target` },
      { label: "ACHIEVEMENT", value: a ?? "no target", fmt: a == null ? undefined : pct,
        sub: a == null ? "no seat on this line carries a target" : a >= 1 ? `ahead by ${((a - 1) * 100).toFixed(1)} pts` : `short by ${((1 - a) * 100).toFixed(1)} pts` },
      { label: "VACANT SEATS", value: vacant.length, fmt: "#,##0", sub: `${Math.round(vacantValue).toLocaleString("en-US")} EGP through them`, colour: VACANT_CARD },
      { label: "ON PROBATION", value: probation.length, fmt: "#,##0", sub: probation.length ? "marked yellow below" : "nobody on this line", colour: "FFFFD98A" },
    ], COLS);

    row = sectionLabel(ws, row, COVERS
      ? `THE SEATS   ·   ${rows.length} on ${LINE}, FILTERED   ·   ${COVERS}`
      : `THE SEATS   ·   ${rows.length} on ${LINE}`,
      COVERS
        ? `${ranked} carry a target and are ranked; the rest are listed unranked rather than scored zero   ·   this file is the filter above, not the whole line - every figure on it is the published closing over that selection`
        : `${ranked} carry a target and are ranked; the rest are listed unranked rather than scored zero`, COLS);
    const headAt = row;
    row = headerRow(ws, row, HEADS, WIDTHS);
    const first = row;

    rows.forEach((r, i) => {
      const zebra = i % 2 === 1;
      cell(ws, row, 1, r.rank ?? "unranked", { numFmt: r.rank ? "#,##0" : undefined, zebra, muted: !r.rank, size: r.rank ? 10 : 8, font: r.rank ? bold(10, INK) : undefined });
      cell(ws, row, 2, r.region, { zebra, size: 9 });
      nameCell(ws, row, 3, r.who, { zebra });
      cell(ws, row, 4, r.area, { zebra });
      cell(ws, row, 5, r.who.dm, r.who.dmProbation
        ? { fill: PROB_FILL, font: { name: FONT, size: 9, bold: true, color: { argb: PROB_TEXT } } }
        : { zebra, size: 9, muted: r.who.dm === "Not assigned" });
      if (r.answered) {
        // THE THREE CHANNELS, side by side, adding to Sales. `distOnly` is the distributor book with
        // the warehouses taken out of it, so a store's money is counted once and in one place.
        cell(ws, row, 6, r.distOnly, { numFmt: money, zebra });
        // 🔴 `!== 0`, NEVER `> 0`. A NEGATIVE channel figure is a MEASURED figure - a month whose
        // credits outweighed its invoices - and `> 0` printed it as "none", which is the
        // absence-is-not-zero mistake with its sign reversed: it hides a real number AND makes the
        // three columns stop adding to Sales for that seat with nothing on the row saying why.
        // Measured on CNS September 2026, where Cairo East 2's warehouses are -25,640 EGP and the
        // row read Distributor + Office = 25,640 MORE than its own sales.
        cell(ws, row, 7, r.store !== 0 ? r.store : "none", { numFmt: r.store !== 0 ? money : undefined, zebra, muted: r.store === 0, font: r.store < 0 ? bold(10, SHORT_DEEP) : undefined });
        const third = ch3(r);
        cell(ws, row, 8, third !== 0 ? third : "none", { numFmt: third !== 0 ? money : undefined, zebra, muted: third === 0, font: third < 0 ? bold(10, SHORT_DEEP) : undefined });
        cell(ws, row, 9, r.sales, { numFmt: money, zebra, font: bold(10, INK) });
        // SHARE OF THE SPLIT -- each channel against this seat's own sales, so the three read across
        // to 100%. Shaded in that channel's own colour below.
        for (const [col, v] of [[10, r.distOnly], [11, r.store], [12, third]]) {
          cell(ws, row, col, r.sales > 0 ? v / r.sales : "", { numFmt: r.sales > 0 ? pct1 : undefined, zebra, size: 9 });
        }
      } else {
        for (const col of [6, 7, 8, 9]) cell(ws, row, col, col === 7 || col === 8 ? "none" : "no sales", { zebra, muted: true, size: 9 });
        for (const col of [10, 11, 12]) cell(ws, row, col, "", { zebra });
      }
      if (r.target > 0) {
        cell(ws, row, 13, r.target, { numFmt: money, zebra });
        cell(ws, row, 14, r.sales - r.target, { numFmt: moneySigned, zebra });
        // THE BRACKET: the dress's alarm colour when the seat is under its target, its covered colour when it
        // covered it. The identity allows its two product colours as seams, rules and brackets.
        cell(ws, row, 15, r.ach, { numFmt: pct, zebra, bracket: (r.ach ?? 0) >= 1 ? COVERED : SHORT });
        cell(ws, row, 16, r.ach, { numFmt: hidden, zebra });
      } else {
        cell(ws, row, 13, "no target", { zebra, muted: true, size: 9 });
        cell(ws, row, 14, "", { zebra });
        cell(ws, row, 15, "no achievement", { zebra, muted: true, size: 9 });
        cell(ws, row, 16, "", { zebra });
      }
      cell(ws, row, 17, r.share, { numFmt: pct1, zebra });
      const prior = r.prior ?? 0;
      cell(ws, row, 18, r.prior == null ? "not in the feed" : (prior > 0 ? (r.sales - prior) / prior : "no prior sales"),
        { numFmt: prior > 0 ? "+0.0%;-0.0%;0.0%" : undefined, zebra, muted: !(prior > 0), size: prior > 0 ? 10 : 8 });
      row += 1;
    });
    const last = row - 1;

    totalRow(ws, row, COLS);
    cell(ws, row, 2, `${rows.length} seats`, { font: bold(10, INK) });
    cell(ws, row, 3, `ALL ${LINE.toUpperCase()}`, { font: bold(10, INK) });
    for (const [col, L] of [[6, "F"], [7, "G"], [8, "H"], [9, "I"], [13, "M"], [17, "Q"]]) {
      const x = ws.getCell(row, col);
      x.value = { formula: `SUM(${L}${first}:${L}${last})` };
      x.numFmt = col === 17 ? pct1 : money;
    }
    for (const [col, L] of [[10, "F"], [11, "G"], [12, "H"]]) {
      const x = ws.getCell(row, col);
      x.value = { formula: `IF(I${row}>0,${L}${row}/I${row},"")` };
      x.numFmt = pct1;
    }
    ws.getCell(row, 14).value = { formula: `I${row}-M${row}` };
    ws.getCell(row, 14).numFmt = moneySigned;
    ws.getCell(row, 15).value = { formula: `IF(M${row}>0,I${row}/M${row},"")` };
    ws.getCell(row, 15).numFmt = pct;
    for (let c = 1; c <= COLS; c += 1) ws.getRow(row).getCell(c).alignment = CENTRE;
    row += 2;

    dataBar(ws, `P${first}:P${last}`, { max: 1.2 });
    dataBar(ws, `Q${first}:Q${last}`);
    colourScale(ws, `I${first}:I${last}`);
    // THE SPLIT, SHADED IN EACH CHANNEL'S OWN COLOUR -- owner point 8. The dress's covered colour
    // for the distributor book, its alarm colour for the warehouses, its eyebrow for direct.
    dataBar(ws, `J${first}:J${last}`, { color: COVERED, max: 1 });
    dataBar(ws, `K${first}:K${last}`, { color: SHORT, max: 1 });
    dataBar(ws, `L${first}:L${last}`, { color: EYEBROW, max: 1 });

    footnote(ws, row, [
      "ACHIEVEMENT is the seat's whole sales value - distributor and direct together, money nobody targeted included - divided by the target value it was given. That is the Monthly Closing engine's own rule, and it is the same rule at every level of this workbook.",
      "A SEAT WITH NO TARGET SHOWS NO ACHIEVEMENT AND IS UNRANKED, never scored zero. A seat that WAS given a target and sold nothing scores 0.00% and ranks last - that is measured, and hiding it would flatter the rep.",
      `VACANT SEATS ARE RANKED, NOT HIDDEN. The ${vacant.length} unstaffed seats here carry ${Math.round(vacantValue).toLocaleString("en-US")} EGP of ${monthName(PERIOD)}, ${total > 0 ? ((vacantValue / total) * 100).toFixed(0) : 0}% of the line. Dropping them would understate it. They are marked in ${dress.shortName} on the owner's instruction.`,
      "A NAME ON PROBATION IS YELLOW, on the name cell alone, so it reads as a fact about the person and not about the seat's numbers.",
      dress.bracketNote,
      "EVERY FIGURE ON THIS SHEET IS VALUE. Units live on one sheet only - Units x Product x Month - and are cut by product there, because a rep sells several products and concentrations and units of different products are not addable. Above one product code, value is the only figure that aggregates.",
      `THE THREE CHANNELS ADD TO SALES. A warehouse buys from a distributor, so Stores is carved OUT of the distributor book rather than added beside it - Distributor here is the distributor book with the warehouses taken out${CH3 === OFFICE ? ", and with the company's own Office stock taken out beside them, which on this line is its own column rather than direct orders" : ""}. ${Math.round(storeTotal).toLocaleString("en-US")} EGP of ${monthName(PERIOD)} reached ${L.warehouseCustomers} warehouses, ${total > 0 ? ((storeTotal / total) * 100).toFixed(1) : 0}% of the line.`,
      "WHO IS A WAREHOUSE is the platform's own rule, read out of src/lib/sales/customer-channel.ts rather than copied, and asked of each month with the rule that was in force for it. Every one of the 260 published cells is reproduced to the penny by the split, so no figure in this workbook moved to make the three columns appear.",
    ], COLS);

    ws.autoFilter = { from: { row: headAt, column: 1 }, to: { row: last, column: COLS } };
    ws.views = [{ state: "frozen", xSplit: 4, ySplit: headAt, showGridLines: false }];
    return ws;
  }

  // ===========================================================================
  // 2 -- Who          owner point 6: "the same arrangment of today reps then under them their dm"
  //
  // THE CLOSING MATRIX'S OWN ARRANGEMENT (owner, 2026-10-13): a district's reps listed one after
  // another, then THEIR district manager closing the team, then the next team and its manager. The
  // manager's line carries HIS WHOLE DISTRICT -- which is exactly the reps standing above it added
  // together -- and he appears ONCE, never repeated under every rep. The reps are an outline level
  // under him, so the sheet collapses to one line a district.
  // ===========================================================================
  // Both DM_OF and TEAMS come from the domain module above (toLegacyShape), which derives them from
  // the ranking itself: a district is value over value, the teams are ordered by their own
  // achievement with "Not assigned" last, and a manager appears ONCE carrying his whole district.
  // They are NOT re-derived here -- a second copy of the arrangement is how the two halves of a
  // sheet start disagreeing. Pinned by tests/closing-rep-ranking.test.ts.

  function sheetWho() {
    const HEAD = ["Rank", "Region", "Area", "Name", "Role", "Seat", "Sales EGP", "Target EGP",
      "Achievement", "Performance", "Share of line"];
    const W = [7, 16, 21, 30, 18, 20, 15, 15, 13, 14, 12];
    const COLS = HEAD.length;
    const ws = book.dress(wb.addWorksheet("Who", { properties: { tabColor: { argb: EYEBROW } } }), monthName(PERIOD));
    const { rows, total } = SEATS;

    let row = book.banner(ws, "who", W);
    row = sectionLabel(ws, row, `WHO CARRIES WHAT   ·   ${rows.length} seats`,
      `a district's reps together, then their district manager closing the team - the closing matrix's own arrangement`, COLS);
    const headAt = row;
    row = headerRow(ws, row, HEAD, W);
    const first = row;
    const perfRows = [];

    let i = 0;
    TEAMS.forEach(({ dm, d, members, probation }) => {
      // ---- the team: his reps, in the ranking's own order -------------------------------------
      members.forEach((r) => {
        const zebra = i % 2 === 1;
        i += 1;
        cell(ws, row, 1, r.rank ?? "unranked", { zebra, muted: !r.rank, size: r.rank ? 10 : 8, font: r.rank ? bold(10, INK) : undefined });
        cell(ws, row, 2, r.region, { zebra, size: 9 });
        cell(ws, row, 3, r.area, { zebra });
        nameCell(ws, row, 4, r.who, { zebra });
        cell(ws, row, 5, "Medical rep", { zebra, size: 9, muted: true });
        cell(ws, row, 6, r.who.vacant ? "unstaffed" : (r.who.repProbation ? `on probation to ${dayOf(r.who.repProbation)}` : "staffed"),
          { zebra, size: 9, muted: !r.who.vacant && !r.who.repProbation,
            ...(r.who.vacant ? { color: SHORT_DEEP } : r.who.repProbation ? { color: PROB_TEXT } : {}) });
        cell(ws, row, 7, r.answered ? r.sales : "no sales", { numFmt: r.answered ? money : undefined, zebra, muted: !r.answered, font: r.answered ? bold(10, INK) : undefined });
        cell(ws, row, 8, r.target > 0 ? r.target : "no target", { numFmt: r.target > 0 ? money : undefined, zebra, muted: !(r.target > 0), size: r.target > 0 ? 10 : 9 });
        cell(ws, row, 9, r.ach == null ? "no achievement" : r.ach, { numFmt: r.ach == null ? undefined : pct, zebra, muted: r.ach == null, size: r.ach == null ? 9 : 10, bracket: r.ach == null ? undefined : (r.ach >= 1 ? COVERED : SHORT) });
        cell(ws, row, 10, r.ach == null ? "" : r.ach, { numFmt: hidden, zebra });
        cell(ws, row, 11, r.share, { numFmt: pct1, zebra });
        ws.getRow(row).outlineLevel = 1;        // the reps fold INTO the manager line below them
        perfRows.push(row);
        row += 1;
      });

      // ---- and the district manager, closing his own team --------------------------------------
      const unassigned = dm === "Not assigned";
      const dmFont = probation
        ? { name: FONT, size: 9.5, bold: true, color: { argb: PROB_TEXT } }
        : { name: FONT, size: 9.5, bold: true, color: { argb: unassigned ? SOFT : INK } };
      const band = probation ? PROB_FILL : TEAM_BAND;
      cell(ws, row, 1, "", { fill: band });
      cell(ws, row, 2, "", { fill: band });
      cell(ws, row, 3, "", { fill: band });
      cell(ws, row, 4, dm, { fill: band, font: dmFont });
      cell(ws, row, 5, "District manager", { fill: band, size: 9, muted: true });
      cell(ws, row, 6, unassigned ? "no manager on these seats" : `${members.length} seats, ${d.vacant} unstaffed`, { fill: band, size: 8.5, muted: true });
      cell(ws, row, 7, d.sales, { numFmt: money, fill: band, size: 9.5, font: bold(9.5, INK) });
      cell(ws, row, 8, d.target > 0 ? d.target : "no target", { numFmt: d.target > 0 ? money : undefined, fill: band, size: 9.5, muted: !(d.target > 0), font: d.target > 0 ? bold(9.5, INK) : undefined });
      cell(ws, row, 9, d.ach == null ? "no achievement" : d.ach, { numFmt: d.ach == null ? undefined : pct, fill: band, size: 9.5, muted: d.ach == null, font: d.ach == null ? undefined : bold(9.5, INK) });
      cell(ws, row, 10, "", { fill: band });
      cell(ws, row, 11, total > 0 ? d.sales / total : "", { numFmt: pct1, fill: band, size: 9.5 });
      // a long manager name WRAPS rather than being cut -- so the row has to be tall enough to hold
      // the second line. Pinning every one of these at 13pt clipped four of the nine managers.
      ws.getRow(row).height = nameRowHeight(dm, W[3]);
      row += 1;
    });
    const last = row - 1;

    totalRow(ws, row, COLS);
    cell(ws, row, 3, `${rows.length} seats`, { font: bold(10, INK) });
    cell(ws, row, 4, `ALL ${LINE.toUpperCase()}`, { font: bold(10, INK) });
    cell(ws, row, 5, `${DM_OF.size} district managers`, { font: bold(9, INK) });
    ws.getCell(row, 7).value = total; ws.getCell(row, 7).numFmt = money;
    ws.getCell(row, 8).value = lineTarget(PERIOD); ws.getCell(row, 8).numFmt = money;
    ws.getCell(row, 9).value = achievement(total, lineTarget(PERIOD)); ws.getCell(row, 9).numFmt = pct;
    ws.getCell(row, 11).value = 1; ws.getCell(row, 11).numFmt = pct1;
    for (let c = 1; c <= COLS; c += 1) ws.getRow(row).getCell(c).alignment = CENTRE;
    row += 2;

    dataBar(ws, `J${first}:J${last}`, { max: 1.2 });
    colourScale(ws, `G${first}:G${last}`);

    footnote(ws, row, [
      "THE ARRANGEMENT IS THE CLOSING MATRIX'S: a district's reps listed one after another, then that district's manager closing the team, then the next team. The manager appears ONCE, at the foot of its own team, never repeated under each rep.",
      "A MANAGER'S LINE IS THE WHOLE DISTRICT - every seat reporting to that manager, vacant ones included - which is exactly the reps standing above it added together.",
      "THE TEAMS ARE IN THE DISTRICTS' OWN ORDER, ranked by achievement, and the reps inside a team keep the ranking's order, so a rep's line rank still reads straight down the first column.",
      "COLLAPSE THE REPS with the outline control in the left margin and the sheet becomes one line a district.",
      "A SEAT'S STATE IS STATED IN WORDS, not left to a colour alone: unstaffed, on probation to a date, or staffed. The colours repeat it for speed, they do not carry it.",
    ], COLS);

    ws.autoFilter = { from: { row: headAt, column: 1 }, to: { row: last, column: COLS } };
    ws.views = [{ state: "frozen", xSplit: 4, ySplit: headAt, showGridLines: false }];
    return ws;
  }

  // ===========================================================================
  // 3 -- Area x Product          owner point 6, second half
  //
  // Every product a seat actually sold or was targeted on, under the seat, with the manager closing
  // the block. Published cells throughout: this is the grain the Monthly Closing publishes at, so
  // nothing here is re-derived from a query of its own.
  // ===========================================================================
  // A CELL THAT EXISTS AND IS NEGATIVE IS A MEASURED FIGURE, NOT AN ABSENCE. Three cells in this
  // feed are negative -- a month whose credits outweighed its invoices. Filtering or wording them
  // away as "none" would be the mirror of the absence-is-not-zero mistake: it hides a real number
  // because of its sign, and the month's column then no longer adds to the line.
  function apRowsFor(code: string) {
    const list = (PRODUCTS_BY_AREA.get(code) ?? []).map((pc) => {
      const c = apOf(PERIOD, code, pc);
      const t = apTargetOf(PERIOD, code, pc);
      const sales = apSalesTotal(c);
      const store = c?.store ?? 0;
      const office = c?.office ?? 0;
      return {
        pc, name: productName(pc), family: productFamily(pc), exists: c !== null,
        // `dist` carries the warehouses AND Office inside it, so both come out here - the same
        // treatment for the same reason: neither is a distributor's own purchase.
        distOnly: (c?.dist ?? 0) - store - office, store, dir: c?.dir ?? 0, office,
        sales, target: t, ach: achievement(sales, t),
      };
    }).filter((p) => p.exists || p.target > 0);
    list.sort((a, b) => b.sales - a.sales || a.name.localeCompare(b.name));
    return list;
  }

  function sheetAreaProduct() {
    const HEAD = ["Rank", "Region", "Area", "Medical rep  /  Product", "Family",
      "Distributor EGP", "Stores EGP", `${CH3} EGP`, "Sales EGP", "Target EGP",
      "Achievement", "Performance", "Share of seat"];
    const W = [7, 15, 20, 32, 15, 14, 12, 12, 14, 14, 12, 13, 12];
    const COLS = HEAD.length;
    const ws = book.dress(wb.addWorksheet("Area x Product", { properties: { tabColor: { argb: COVERED } } }), monthName(PERIOD));
    const { rows, total } = SEATS;

    let row = book.banner(ws, "product", W);
    row = sectionLabel(ws, row, `EVERY PRODUCT, UNDER ITS SEAT`,
      `a district's reps with their products, then that district's manager closing the team`, COLS);
    const headAt = row;
    row = headerRow(ws, row, HEAD, W);
    const first = row;
    let productLines = 0;

    let i = 0;
    TEAMS.forEach(({ dm, d, members, probation }) => {
      members.forEach((r) => {
        const zebra = i % 2 === 1;
        i += 1;
        // the seat's own line
        cell(ws, row, 1, r.rank ?? "unranked", { zebra, muted: !r.rank, size: r.rank ? 10 : 8, font: r.rank ? bold(10, INK) : undefined });
        cell(ws, row, 2, r.region, { zebra, size: 9 });
        cell(ws, row, 3, r.area, { zebra });
        nameCell(ws, row, 4, r.who, { zebra });
        cell(ws, row, 5, "", { zebra });
        cell(ws, row, 6, r.distOnly, { numFmt: money, zebra, font: bold(10, INK) });
        cell(ws, row, 7, r.store, { numFmt: money, zebra, font: bold(10, INK) });
        cell(ws, row, 8, ch3(r), { numFmt: money, zebra, font: bold(10, INK) });
        cell(ws, row, 9, r.sales, { numFmt: money, zebra, font: bold(10, INK) });
        cell(ws, row, 10, r.target > 0 ? r.target : "no target", { numFmt: r.target > 0 ? money : undefined, zebra, muted: !(r.target > 0), size: r.target > 0 ? 10 : 9, font: r.target > 0 ? bold(10, INK) : undefined });
        cell(ws, row, 11, r.ach == null ? "no achievement" : r.ach, { numFmt: r.ach == null ? undefined : pct, zebra, muted: r.ach == null, size: r.ach == null ? 9 : 10, bracket: r.ach == null ? undefined : (r.ach >= 1 ? COVERED : SHORT), font: r.ach == null ? undefined : bold(10, INK) });
        cell(ws, row, 12, r.ach == null ? "" : r.ach, { numFmt: hidden, zebra });
        cell(ws, row, 13, 1, { numFmt: pct1, zebra, muted: true, size: 9 });
        ws.getRow(row).outlineLevel = 1;
        row += 1;

        const products = apRowsFor(r.code);
        for (const p of products) {
          cell(ws, row, 1, "", { zebra });
          cell(ws, row, 2, "", { zebra });
          cell(ws, row, 3, "", { zebra });
          cell(ws, row, 4, `·  ${p.name}`, { zebra, size: 9 });
          cell(ws, row, 5, p.family, { zebra, size: 8.5, muted: true });
          cell(ws, row, 6, p.exists ? p.distOnly : "no sales", { numFmt: p.exists ? money : undefined, zebra, size: 9, muted: !p.exists });
          cell(ws, row, 7, p.store !== 0 ? p.store : "none", { numFmt: p.store !== 0 ? money : undefined, zebra, size: 9, muted: p.store === 0 });
          const p3 = ch3(p);
          cell(ws, row, 8, p3 !== 0 ? p3 : "none", { numFmt: p3 !== 0 ? money : undefined, zebra, size: 9, muted: p3 === 0 });
          cell(ws, row, 9, p.exists ? p.sales : "no sales", { numFmt: p.exists ? money : undefined, zebra, size: 9, muted: !p.exists,
            font: p.sales < 0 ? bold(9, SHORT_DEEP) : undefined });
          cell(ws, row, 10, p.target > 0 ? p.target : "no target", { numFmt: p.target > 0 ? money : undefined, zebra, size: 9, muted: !(p.target > 0) });
          cell(ws, row, 11, p.ach == null ? "no achievement" : p.ach, { numFmt: p.ach == null ? undefined : pct, zebra, size: 9, muted: p.ach == null, bracket: p.ach == null ? undefined : (p.ach >= 1 ? COVERED : SHORT) });
          cell(ws, row, 12, p.ach == null ? "" : p.ach, { numFmt: hidden, zebra });
          cell(ws, row, 13, r.sales !== 0 ? p.sales / r.sales : "", { numFmt: r.sales !== 0 ? pct1 : undefined, zebra, size: 9 });
          ws.getRow(row).outlineLevel = 2;
          ws.getRow(row).height = 13;
          row += 1;
          productLines += 1;
        }
        if (products.length === 0) {
          for (const c of [1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13]) cell(ws, row, c, "", { zebra });
          cell(ws, row, 4, "·  no product line on this seat in the feed", { zebra, size: 9, muted: true });
          ws.getRow(row).outlineLevel = 2;
          ws.getRow(row).height = 13;
          row += 1;
        }
      });

      // THE DISTRICT MANAGER CLOSES HIS TEAM -- the closing matrix's arrangement, where a block of
      // areas is closed by its own subtotal band. His line is his WHOLE district, which is the reps
      // standing above it added together, and he appears once on the sheet, not under every rep.
      const unassigned = dm === "Not assigned";
      const band = probation ? PROB_FILL : TEAM_BAND;
      const dmFont = probation
        ? { name: FONT, size: 9.5, bold: true, color: { argb: PROB_TEXT } }
        : { name: FONT, size: 9.5, bold: true, color: { argb: unassigned ? SOFT : INK } };
      for (const c of [1, 2, 3, 12]) cell(ws, row, c, "", { fill: band });
      cell(ws, row, 4, dm, { fill: band, font: dmFont });
      cell(ws, row, 5, "District manager", { fill: band, size: 8.5, muted: true });
      cell(ws, row, 6, d.dist, { numFmt: money, fill: band, size: 9.5, font: bold(9.5, INK) });
      cell(ws, row, 7, d.store, { numFmt: money, fill: band, size: 9.5, font: bold(9.5, INK) });
      cell(ws, row, 8, ch3(d), { numFmt: money, fill: band, size: 9.5, font: bold(9.5, INK) });
      cell(ws, row, 9, d.sales, { numFmt: money, fill: band, size: 9.5, font: bold(9.5, INK) });
      cell(ws, row, 10, d.target > 0 ? d.target : "no target", { numFmt: d.target > 0 ? money : undefined, fill: band, size: 9.5, muted: !(d.target > 0), font: d.target > 0 ? bold(9.5, INK) : undefined });
      cell(ws, row, 11, d.ach == null ? "no achievement" : d.ach, { numFmt: d.ach == null ? undefined : pct, fill: band, size: 9.5, muted: d.ach == null, font: d.ach == null ? undefined : bold(9.5, INK) });
      cell(ws, row, 13, "", { fill: band });
      ws.getRow(row).height = nameRowHeight(dm, W[3]);
      row += 1;
    });
    const last = row - 1;

    totalRow(ws, row, COLS);
    cell(ws, row, 3, `${rows.length} seats`, { font: bold(10, INK) });
    cell(ws, row, 4, `ALL ${LINE.toUpperCase()}`, { font: bold(10, INK) });
    cell(ws, row, 5, `${productLines} product lines`, { font: bold(9, INK) });
    for (const [col, v] of [[6, sum(rows, (x) => x.distOnly)], [7, sum(rows, (x) => x.store)],
      [8, sum(rows, ch3)], [9, total], [10, lineTarget(PERIOD)]]) {
      ws.getCell(row, col).value = v; ws.getCell(row, col).numFmt = money;
    }
    ws.getCell(row, 11).value = achievement(total, lineTarget(PERIOD)); ws.getCell(row, 11).numFmt = pct;
    for (let c = 1; c <= COLS; c += 1) ws.getRow(row).getCell(c).alignment = CENTRE;
    row += 2;

    dataBar(ws, `L${first}:L${last}`, { max: 1.2 });
    dataBar(ws, `M${first}:M${last}`, { color: COVERED, max: 1 });

    footnote(ws, row, [
      "A SEAT'S LINE IS BOLD and that seat's products follow it; when the district's reps are done, their manager closes the team on a banded line. Collapse one outline level and the sheet is one line a seat, collapse the next and it is one line a district.",
      "SHARE OF SEAT is each product against its own seat's sales, so a block reads down to 100%. It is deliberately not share of the line - a product's weight inside one rep's bag is the question this sheet answers.",
      "A PRODUCT WITH A TARGET AND NO SALES IS SHOWN, scoring no achievement rather than 0%, exactly as a seat is. A product with neither is not invented as a zero row.",
      "EVERY CELL HERE IS A PUBLISHED CLOSING CELL. Area x product is the grain the Monthly Closing publishes at, so these figures are read from it, never recomputed beside it.",
    ], COLS);

    ws.autoFilter = { from: { row: headAt, column: 1 }, to: { row: last, column: COLS } };
    ws.views = [{ state: "frozen", xSplit: 4, ySplit: headAt, showGridLines: false }];
    return ws;
  }

  // ===========================================================================
  // 4 -- Area x Product, flat      owner point 6: "another tab make able to filter normal"
  //
  // The same figures with every grouping taken out: one row a cell, every column filled on every
  // row, no outline, no blanks carried down from a group header. That is what Excel's own filter
  // and PivotTable need, and what the grouped sheet above deliberately is not.
  // ===========================================================================
  function sheetAreaProductFlat() {
    const HEAD = ["Region", "Area", "Medical rep", "District manager", "Seat", "Product", "Family",
      "Distributor EGP", "Stores EGP", `${CH3} EGP`, "Sales EGP", "Target EGP", "Gap to target",
      "Achievement", "Share of line"];
    const W = [15, 20, 28, 26, 13, 24, 15, 14, 12, 12, 14, 14, 13, 12, 12];
    const COLS = HEAD.length;
    const ws = book.dress(wb.addWorksheet("Area x Product (filter)", { properties: { tabColor: { argb: LABEL_GREY } } }), monthName(PERIOD));
    const { rows, total } = SEATS;

    let row = book.banner(ws, "filter", W);
    row = sectionLabel(ws, row, "ONE ROW A CELL",
      "no groups, no outline, nothing carried down - filter, sort or pivot this one any way you like", COLS);
    const headAt = row;
    row = headerRow(ws, row, HEAD, W);
    const first = row;
    let n = 0;

    for (const r of rows) {
      const products = apRowsFor(r.code);
      for (const p of products) {
        const zebra = n % 2 === 1;
        cell(ws, row, 1, r.region, { zebra, size: 9 });
        cell(ws, row, 2, r.area, { zebra, size: 9 });
        // vacant and probation colour the NAME cell here too -- the rule is about the person, and it
        // has to survive a sort that moves the row anywhere.
        nameCell(ws, row, 3, r.who, { zebra });
        cell(ws, row, 4, r.who.dm, r.who.dmProbation
          ? { fill: PROB_FILL, font: { name: FONT, size: 9, bold: true, color: { argb: PROB_TEXT } } }
          : { zebra, size: 9, muted: r.who.dm === "Not assigned" });
        cell(ws, row, 5, r.who.vacant ? "unstaffed" : (r.who.repProbation ? "on probation" : "staffed"),
          { zebra, size: 9, ...(r.who.vacant ? { color: SHORT_DEEP } : r.who.repProbation ? { color: PROB_TEXT } : { muted: true }) });
        cell(ws, row, 6, p.name, { zebra, size: 9 });
        cell(ws, row, 7, p.family, { zebra, size: 9, muted: true });
        cell(ws, row, 8, p.distOnly, { numFmt: money, zebra, size: 9 });
        cell(ws, row, 9, p.store, { numFmt: money, zebra, size: 9, muted: p.store === 0 });
        cell(ws, row, 10, ch3(p), { numFmt: money, zebra, size: 9, muted: ch3(p) === 0 });
        cell(ws, row, 11, p.sales, { numFmt: money, zebra, size: 9, font: bold(9, INK) });
        cell(ws, row, 12, p.target, { numFmt: money, zebra, size: 9, muted: p.target === 0 });
        cell(ws, row, 13, p.target > 0 ? p.sales - p.target : "", { numFmt: p.target > 0 ? moneySigned : undefined, zebra, size: 9 });
        cell(ws, row, 14, p.ach == null ? "" : p.ach, { numFmt: p.ach == null ? undefined : pct, zebra, size: 9 });
        cell(ws, row, 15, total > 0 ? p.sales / total : 0, { numFmt: pct1, zebra, size: 9 });
        row += 1; n += 1;
      }
    }
    const last = row - 1;

    totalRow(ws, row, COLS);
    cell(ws, row, 2, `${n} cells`, { font: bold(10, INK) });
    cell(ws, row, 3, `ALL ${LINE.toUpperCase()}`, { font: bold(10, INK) });
    for (const [col, L] of [[8, "H"], [9, "I"], [10, "J"], [11, "K"], [12, "L"], [15, "O"]]) {
      const x = ws.getCell(row, col);
      x.value = { formula: `SUM(${L}${first}:${L}${last})` };
      x.numFmt = col === 15 ? pct1 : money;
    }
    ws.getCell(row, 13).value = { formula: `K${row}-L${row}` }; ws.getCell(row, 13).numFmt = moneySigned;
    ws.getCell(row, 14).value = { formula: `IF(L${row}>0,K${row}/L${row},"")` }; ws.getCell(row, 14).numFmt = pct;
    for (let c = 1; c <= COLS; c += 1) ws.getRow(row).getCell(c).alignment = CENTRE;
    row += 2;

    dataBar(ws, `K${first}:K${last}`, { color: COVERED });
    dataBar(ws, `I${first}:I${last}`, { color: SHORT });

    footnote(ws, row, [
      "THIS IS THE SAME DATA AS THE SHEET BEFORE IT, flattened. Every row stands on its own: region, area, rep, manager, seat state, product and family are repeated on every line rather than carried down from a group header, so a filter or a sort can never strand a number away from whose it is.",
      "NOTHING IS MERGED AND NOTHING IS OUTLINED on this sheet, deliberately. Merged cells and grouped rows are exactly what stops Excel's own filter and PivotTable from reading a table.",
      "A GAP AND AN ACHIEVEMENT ARE LEFT EMPTY where a cell has no target, rather than written as zero. An empty cell filters and sorts as 'no answer'; a zero would sort as the worst answer.",
    ], COLS);

    ws.autoFilter = { from: { row: headAt, column: 1 }, to: { row: last, column: COLS } };
    ws.views = [{ state: "frozen", xSplit: 3, ySplit: headAt, showGridLines: false }];
    return ws;
  }

  // ===========================================================================
  // 5 -- Area x Product x Month        owner point 7, "month by month and month to date"
  // ===========================================================================
  // ===========================================================================
  function sheetAreaProductMonth() {
    const HEAD = ["Region", "Area", "Medical rep", "Product",
      ...TREND.map((p) => `${monthShort(p)} EGP`),
      "To date EGP", "Target to date", "Gap to date", "Achievement to date", "Performance", "Share of line"];
    const W = [15, 19, 26, 23, ...TREND.map(() => 13), 14, 14, 13, 14, 13, 12];
    const COLS = HEAD.length;
    const ws = book.dress(wb.addWorksheet("Area x Product x Month", { properties: { tabColor: { argb: SHORT } } }), SPAN);
    const { rows } = SEATS;

    let row = book.banner(ws, "trend", W);
    row = sectionLabel(ws, row, `EVERY CELL, MONTH BY MONTH`,
      `${TREND.map(monthName).join("  ·  ")} - a district's reps with their products, then that district's manager closing the team`, COLS);
    const headAt = row;
    row = headerRow(ws, row, HEAD, W);
    const first = row;

    let n = 0, grandToDate = 0, grandTarget = 0, noSeatToDate = 0, noAreaToDate = 0, negativeCells = 0;
    const lineToDate = TREND.reduce((a, p) => a + lineSales(p), 0);

    // THE SEATS ARE SEPTEMBER'S. A quarter's sheet keyed only on them silently drops every area
    // that sold earlier in the quarter and is gone now -- and most of that money here carries NO
    // AREA CODE AT ALL, so the footnote counts the two apart. Dropping it would make the July column stop adding to
    // July's line, which is the same defect as hiding a vacant seat, one level up. So the extra
    // areas are carried at the foot, named for what they are.
    const seatCodes = new Set(rows.map((r) => r.code));
    const extraCodes = [...PRODUCTS_BY_AREA.keys()].filter((c) => !seatCodes.has(c));
    const extraRows = extraCodes.map((code) => ({
      code,
      noArea: !L.areaRowOf(code),
      area: L.areaRowOf(code)?.area_name ?? (code ? "Area not in today's area map" : "No area on the invoice"),
      region: L.areaRowOf(code) ? areaRegion(code) : "Not attributed",
      who: L.areaRowOf(code) ? holderOf(code) : { rep: "Reached no seat", dm: "Not assigned", vacant: false, repProbation: null, dmProbation: null },
      extra: true,
    })).sort((a, b) => a.area.localeCompare(b.area));

    // A SEAT'S OWN MONTHS AND HIS MANAGER'S ARE SUMMED FROM THE SAME PUBLISHED CELLS the product
    // rows print - never from a second query, which is how two numbers on one sheet start to differ.
    const areaMonthSales = (p: string, code: string) => (PRODUCTS_BY_AREA.get(code) ?? []).reduce((a, pc) => a + apSalesTotal(apOf(p, code, pc)), 0);
    const areaMonthTarget = (p: string, code: string) => (PRODUCTS_BY_AREA.get(code) ?? []).reduce((a, pc) => a + apTargetOf(p, code, pc), 0);

    let seatIndex = 0;
    const emitSeat = (r: MonthRow) => {
      const codes = PRODUCTS_BY_AREA.get(r.code) ?? [];
      const list = codes.map((pc) => {
        // existence per month, kept apart from value: a negative month is a real figure (credits
        // outweighing invoices) and must print; a month with no published cell at all reads "none".
        const cells = TREND.map((p) => apOf(p, r.code, pc));
        const months = cells.map((c) => apSalesTotal(c));
        const toDate = months.reduce((a, b) => a + b, 0);
        const target = TREND.reduce((a, p) => a + apTargetOf(p, r.code, pc), 0);
        return { pc, name: productName(pc), cells, months, toDate, target, ach: achievement(toDate, target) };
      }).filter((p) => p.cells.some(Boolean) || p.target > 0);
      list.sort((a, b) => b.toDate - a.toDate || a.name.localeCompare(b.name));
      if (list.length === 0) return false;
      const zebra = seatIndex % 2 === 1;
      seatIndex += 1;

      // the seat's own line, in the ranking's order
      const seatMonths = TREND.map((_, i) => list.reduce((a, p) => a + p.months[i], 0));
      const seatHere = TREND.map((_, i) => list.some((p) => p.cells[i] !== null));
      const seatToDate = seatMonths.reduce((a, b) => a + b, 0);
      const seatTarget = list.reduce((a, p) => a + p.target, 0);
      const seatAch = achievement(seatToDate, seatTarget);
      cell(ws, row, 1, r.region, { zebra, size: 9, muted: r.extra === true });
      cell(ws, row, 2, r.area, { zebra, size: 9, muted: r.extra === true });
      if (r.extra) cell(ws, row, 3, r.who.rep, { zebra, size: 9, muted: true });
      else nameCell(ws, row, 3, r.who, { zebra });
      cell(ws, row, 4, `${list.length} product${list.length === 1 ? "" : "s"}`, { zebra, size: 8.5, muted: true });
      seatMonths.forEach((v, i) => {
        cell(ws, row, 5 + i, seatHere[i] ? v : "none", { numFmt: seatHere[i] ? money : undefined, zebra, muted: !seatHere[i],
          font: seatHere[i] ? bold(10, v < 0 ? SHORT_DEEP : INK) : undefined });
      });
      cell(ws, row, 8, seatToDate, { numFmt: money, zebra, font: bold(10, seatToDate < 0 ? SHORT_DEEP : INK) });
      cell(ws, row, 9, seatTarget > 0 ? seatTarget : "no target", { numFmt: seatTarget > 0 ? money : undefined, zebra, muted: !(seatTarget > 0), size: seatTarget > 0 ? 10 : 9 });
      cell(ws, row, 10, seatTarget > 0 ? seatToDate - seatTarget : "", { numFmt: seatTarget > 0 ? moneySigned : undefined, zebra });
      cell(ws, row, 11, seatAch == null ? "no achievement" : seatAch, { numFmt: seatAch == null ? undefined : pct, zebra, muted: seatAch == null, size: seatAch == null ? 9 : 10, bracket: seatAch == null ? undefined : (seatAch >= 1 ? COVERED : SHORT), font: seatAch == null ? undefined : bold(10, INK) });
      cell(ws, row, 12, seatAch == null ? "" : seatAch, { numFmt: hidden, zebra });
      cell(ws, row, 13, lineToDate > 0 ? seatToDate / lineToDate : "", { numFmt: pct1, zebra });
      ws.getRow(row).height = nameRowHeight(r.who.rep, W[2]);
      // a seat folds into its manager's line; the quarter's seatless areas at the foot answer to
      // nobody, so they stand at the top level with their own products under them.
      const lvl = r.extra ? 0 : 1;
      ws.getRow(row).outlineLevel = lvl;
      row += 1;

      for (const p of list) {
        for (const c of [1, 2, 3]) cell(ws, row, c, "", { zebra });
        cell(ws, row, 4, `·  ${p.name}`, { zebra, size: 9 });
        p.months.forEach((v, i) => {
          const here = p.cells[i] !== null;
          if (here && v < 0) negativeCells += 1;
          cell(ws, row, 5 + i, here ? v : "none", { numFmt: here ? money : undefined, zebra, size: 9, muted: !here,
            font: here && v < 0 ? bold(9, SHORT_DEEP) : undefined });
        });
        cell(ws, row, 8, p.toDate, { numFmt: money, zebra, size: 9, font: bold(9, p.toDate < 0 ? SHORT_DEEP : INK) });
        cell(ws, row, 9, p.target > 0 ? p.target : "no target", { numFmt: p.target > 0 ? money : undefined, zebra, size: 9, muted: !(p.target > 0) });
        cell(ws, row, 10, p.target > 0 ? p.toDate - p.target : "", { numFmt: p.target > 0 ? moneySigned : undefined, zebra, size: 9 });
        cell(ws, row, 11, p.ach == null ? "no achievement" : p.ach, { numFmt: p.ach == null ? undefined : pct, zebra, size: 9, muted: p.ach == null, bracket: p.ach == null ? undefined : (p.ach >= 1 ? COVERED : SHORT) });
        cell(ws, row, 12, p.ach == null ? "" : p.ach, { numFmt: hidden, zebra });
        cell(ws, row, 13, lineToDate > 0 ? p.toDate / lineToDate : 0, { numFmt: pct1, zebra, size: 9 });
        grandToDate += p.toDate; grandTarget += p.target;
        if (r.extra) { noSeatToDate += p.toDate; if (r.noArea) noAreaToDate += p.toDate; }
        ws.getRow(row).outlineLevel = lvl + 1;
        row += 1; n += 1;
      }
        return true;
    };

    // THE OWNER'S ARRANGEMENT, the closing matrix's own: a district's reps one after another, then
    // that district's manager closing the team across the same three months, then the next team.
    for (const { dm, d, members, probation } of TEAMS) {
      let printed = 0;
      for (const r of members) if (emitSeat(r)) printed += 1;
      if (printed === 0) continue;
      const dmMonths = TREND.map((p) => d.members.reduce((a, m) => a + areaMonthSales(p, m.code), 0));
      const dmToDate = dmMonths.reduce((a, b) => a + b, 0);
      const dmTarget = TREND.reduce((a, p) => a + d.members.reduce((x, m) => x + areaMonthTarget(p, m.code), 0), 0);
      const dmAch = achievement(dmToDate, dmTarget);
      const unassigned = dm === "Not assigned";
      const band = probation ? PROB_FILL : TEAM_BAND;
      const dmFont = probation
        ? { name: FONT, size: 9.5, bold: true, color: { argb: PROB_TEXT } }
        : { name: FONT, size: 9.5, bold: true, color: { argb: unassigned ? SOFT : INK } };
      for (const c of [1, 2]) cell(ws, row, c, "", { fill: band });
      cell(ws, row, 3, dm, { fill: band, font: dmFont });
      cell(ws, row, 4, "District manager", { fill: band, size: 8.5, muted: true });
      dmMonths.forEach((v, i) => cell(ws, row, 5 + i, v, { numFmt: money, fill: band, size: 9.5, font: bold(9.5, v < 0 ? SHORT_DEEP : INK) }));
      cell(ws, row, 8, dmToDate, { numFmt: money, fill: band, size: 9.5, font: bold(9.5, dmToDate < 0 ? SHORT_DEEP : INK) });
      cell(ws, row, 9, dmTarget > 0 ? dmTarget : "no target", { numFmt: dmTarget > 0 ? money : undefined, fill: band, size: 9.5, muted: !(dmTarget > 0), font: dmTarget > 0 ? bold(9.5, INK) : undefined });
      cell(ws, row, 10, dmTarget > 0 ? dmToDate - dmTarget : "", { numFmt: dmTarget > 0 ? moneySigned : undefined, fill: band, size: 9.5 });
      cell(ws, row, 11, dmAch == null ? "no achievement" : dmAch, { numFmt: dmAch == null ? undefined : pct, fill: band, size: 9.5, muted: dmAch == null, font: dmAch == null ? undefined : bold(9.5, INK) });
      cell(ws, row, 12, "", { fill: band });
      cell(ws, row, 13, lineToDate > 0 ? dmToDate / lineToDate : "", { numFmt: pct1, fill: band, size: 9.5 });
      ws.getRow(row).height = nameRowHeight(dm, W[2]);
      row += 1;
    }
    // the quarter's own leftovers: areas that sold earlier and hold no seat today, so no manager
    for (const r of extraRows) emitSeat(r);

    const last = row - 1;

    totalRow(ws, row, COLS);
    cell(ws, row, 2, `${n} cells`, { font: bold(10, INK) });
    cell(ws, row, 3, `ALL ${LINE.toUpperCase()}`, { font: bold(10, INK) });
    cell(ws, row, 4, `${TREND.length} months`, { font: bold(9, INK) });
    TREND.forEach((p, i) => {
      ws.getCell(row, 5 + i).value = lineSales(p);
      ws.getCell(row, 5 + i).numFmt = money;
    });
    ws.getCell(row, 8).value = grandToDate; ws.getCell(row, 8).numFmt = money;
    ws.getCell(row, 9).value = grandTarget; ws.getCell(row, 9).numFmt = money;
    ws.getCell(row, 10).value = grandToDate - grandTarget; ws.getCell(row, 10).numFmt = moneySigned;
    ws.getCell(row, 11).value = achievement(grandToDate, grandTarget); ws.getCell(row, 11).numFmt = pct;
    ws.getCell(row, 13).value = 1; ws.getCell(row, 13).numFmt = pct1;
    for (let c = 1; c <= COLS; c += 1) ws.getRow(row).getCell(c).alignment = CENTRE;
    row += 2;

    dataBar(ws, `L${first}:L${last}`, { max: 1.2 });
    dataBar(ws, `H${first}:H${last}`, { color: COVERED });
    for (const L of ["E", "F", "G"]) colourScale(ws, `${L}${first}:${L}${last}`);

    footnote(ws, row, [
      `TO DATE IS ${SPAN_PLUS}, ${SPAN_COUNT} this feed carries - it is not a year to date, and nothing older than ${monthName(TREND[0])} is in it. Said plainly because a column headed 'to date' that quietly means something narrower is the easiest number in a workbook to misread.`,
      `ACHIEVEMENT TO DATE DIVIDES ${SPAN_COUNT.toUpperCase()}' SALES BY ${SPAN_COUNT.toUpperCase()}' TARGETS, which is not the average of the monthly percentages - a weak month with a small target would otherwise count as much as a heavy one.`,
      // The count is COUNTED, not stated. It read "three cells in this feed" because three was true
      // of the build it was written against, and a sentence naming a figure has to be produced by the
      // same pass that prints it or it becomes a confident lie the first time the data moves.
      `A MONTH READS 'none' WHERE THE CLOSING PUBLISHES NO CELL AT ALL, never 0 - absence is not a measured zero. A cell that DOES exist prints its figure even when that figure is NEGATIVE, in dark red: ${negativeCells === 0 ? "no cell in this feed is negative" : `${negativeCells} cell${negativeCells === 1 ? "" : "s"} in this feed ${negativeCells === 1 ? "is a month" : "are months"} whose credits outweighed their invoices`}, and hiding them for their sign would be the same mistake in reverse, with the month's column no longer adding to the line.`,
      `SHARE OF LINE IS AGAINST THE WHOLE LINE OVER ${SPAN_COUNT.toUpperCase()}, so the column adds to 100% down the sheet.`,
      `THE SEATS ARE ${monthName(PERIOD).toUpperCase()}'S, so the foot of this sheet carries the ${Math.round(noSeatToDate).toLocaleString("en-US")} EGP sold through areas that hold no seat today - of which ${Math.round(noAreaToDate).toLocaleString("en-US")} EGP reached NO AREA AT ALL on the invoice, and the other ${(Math.round(noSeatToDate) - Math.round(noAreaToDate)).toLocaleString("en-US")} EGP reached an area that is on the map but carries no ${monthName(PERIOD)} seat. It is listed rather than dropped, for the same reason a vacant seat is ranked rather than hidden: without it the month columns stop adding to the line, and the first question worth asking about the span goes unasked.`,
    ], COLS);

    ws.autoFilter = { from: { row: headAt, column: 1 }, to: { row: last, column: COLS } };
    ws.views = [{ state: "frozen", xSplit: 4, ySplit: headAt, showGridLines: false }];
    return ws;
  }

  // ===========================================================================
  // 2 -- Districts   (and Regions, only when they are not the same table twice)
  //
  // ON THIS LINE EVERY DISTRICT IS EXACTLY ONE REGION, so a separate Regions sheet was the same
  // nine rows under different labels - the owner read the two side by side and said so. The two
  // groupings are compared here, not assumed: identical partition, one sheet carrying both names;
  // different partition, both sheets, because then they really are two questions.
  // ===========================================================================
  const PARTITION = (() => {
    const key = (ms: LegacySeat[]) => ms.map((r) => r.code).sort().join(",");
    const byDm = new Map<string, LegacySeat[]>(), byRegion = new Map<string, LegacySeat[]>();
    for (const r of SEATS.rows) {
      if (!byDm.has(r.who.dm)) byDm.set(r.who.dm, []);
      byDm.get(r.who.dm)!.push(r);
      if (!byRegion.has(r.region)) byRegion.set(r.region, []);
      byRegion.get(r.region)!.push(r);
    }
    const dmKeys = [...byDm.values()].map(key).sort();
    const rgKeys = [...byRegion.values()].map(key).sort();
    return { byDm, byRegion, same: dmKeys.length === rgKeys.length && dmKeys.every((k, i) => k === rgKeys[i]) };
  })();

  function sheetDistricts() {
    const HEAD = ["Rank", "District manager", "Region", "Seats", "Vacant seats", "Distributor EGP", "Stores EGP",
      `${CH3} EGP`, "Sales EGP", "Target EGP", "Achievement", "Performance", "Share of line"];
    const W = [7, 28, 18, 9, 11, 14, 12, 12, 14, 14, 12, 13, 11];
    const COLS = HEAD.length;
    const ws = book.dress(wb.addWorksheet("Districts", { properties: { tabColor: { argb: COVERED } } }), monthName(PERIOD));
    const { total } = SEATS;
    const list = [...PARTITION.byDm.entries()].map(([dm, members]) => ({
      dm, members,
      regions: [...new Set(members.map((r) => r.region))],
      dist: sum(members, (r) => r.distOnly), store: sum(members, (r) => r.store), dir: sum(members, ch3),
      sales: sum(members, (r) => r.sales), target: sum(members, (r) => r.target),
      vacant: members.filter((r) => r.who.vacant).length,
      probation: members.some((r) => r.who.dmProbation),
    })).map((d) => ({ ...d, ach: achievement(d.sales, d.target), rank: null as number | null }))
      .sort((a, b) => (a.ach == null && b.ach == null) ? b.sales - a.sales : a.ach == null ? 1 : b.ach == null ? -1 : b.ach - a.ach);
    let n = 0;
    for (const d of list) d.rank = d.ach == null ? null : (n += 1);

    let row = book.banner(ws, "districts", W);
    row = sectionLabel(ws, row, `THE DISTRICTS   ·   ${list.length} on ${LINE}`,
      PARTITION.same
        ? `${n} carry a target and are ranked   ·   every district here is exactly one region, so the region sits beside its manager rather than on a second sheet saying the same thing`
        : `${n} carry a target and are ranked   ·   a district spans more than one region on this line, so the regions have their own sheet as well`, COLS);
    const headAt = row;
    row = headerRow(ws, row, HEAD, W);
    const first = row;
    list.forEach((d, i) => {
      const zebra = i % 2 === 1;
      cell(ws, row, 1, d.rank ?? "unranked", { numFmt: d.rank ? "#,##0" : undefined, zebra, muted: !d.rank, size: d.rank ? 10 : 8, font: d.rank ? bold(10, INK) : undefined });
      cell(ws, row, 2, d.dm, d.probation
        ? { fill: PROB_FILL, font: { name: FONT, size: 10, bold: true, color: { argb: PROB_TEXT } } }
        : { zebra, muted: d.dm === "Not assigned" });
      cell(ws, row, 3, d.regions.join("  ·  "), { zebra, size: 9, muted: true });
      cell(ws, row, 4, d.members.length, { numFmt: "#,##0", zebra });
      cell(ws, row, 5, d.vacant > 0 ? d.vacant : "none", { numFmt: d.vacant > 0 ? "#,##0" : undefined, zebra, muted: d.vacant === 0,
        font: d.vacant > 0 ? bold(10, SHORT_DEEP) : undefined });
      cell(ws, row, 6, d.dist, { numFmt: money, zebra });
      cell(ws, row, 7, d.store !== 0 ? d.store : "none", { numFmt: d.store !== 0 ? money : undefined, zebra, muted: d.store === 0, font: d.store < 0 ? bold(10, SHORT_DEEP) : undefined });
      cell(ws, row, 8, d.dir !== 0 ? d.dir : "none", { numFmt: d.dir !== 0 ? money : undefined, zebra, muted: d.dir === 0, font: d.dir < 0 ? bold(10, SHORT_DEEP) : undefined });
      cell(ws, row, 9, d.sales, { numFmt: money, zebra, font: bold(10, INK) });
      if (d.target > 0) {
        cell(ws, row, 10, d.target, { numFmt: money, zebra });
        cell(ws, row, 11, d.ach, { numFmt: pct, zebra, bracket: (d.ach ?? 0) >= 1 ? COVERED : SHORT });
        cell(ws, row, 12, d.ach, { numFmt: hidden, zebra });
      } else {
        cell(ws, row, 10, "no target", { zebra, muted: true, size: 9 });
        cell(ws, row, 11, "no achievement", { zebra, muted: true, size: 9 });
        cell(ws, row, 12, "", { zebra });
      }
      cell(ws, row, 13, total > 0 ? d.sales / total : null, { numFmt: pct1, zebra });
      ws.getRow(row).height = nameRowHeight(d.dm, W[1]);
      row += 1;
    });
    const last = row - 1;
    totalRow(ws, row, COLS);
    cell(ws, row, 2, `ALL ${LINE.toUpperCase()}`, { font: bold(10, INK) });
    for (const [col, L] of [[4, "D"], [6, "F"], [7, "G"], [8, "H"], [9, "I"], [10, "J"], [13, "M"]]) {
      const x = ws.getCell(row, col);
      x.value = { formula: `SUM(${L}${first}:${L}${last})` };
      x.numFmt = col === 13 ? pct1 : col === 4 ? "#,##0" : money;
    }
    ws.getCell(row, 11).value = { formula: `IF(J${row}>0,I${row}/J${row},"")` };
    ws.getCell(row, 11).numFmt = pct;
    for (let c = 1; c <= COLS; c += 1) ws.getRow(row).getCell(c).alignment = CENTRE;
    row += 2;
    dataBar(ws, `L${first}:L${last}`, { max: 1.2 });
    dataBar(ws, `M${first}:M${last}`);
    dataBar(ws, `G${first}:G${last}`, { color: SHORT });
    footnote(ws, row, [
      "A district's achievement is its own seats' sales over its own seats' targets - the same rule as a seat and as the line. It is NOT the average of its seats' percentages, which would weight a small seat like a large one.",
      "Vacant seats count into their district in full. A district carrying several is not penalised twice: the money that did come through them is in its sales, and the target they carry is in its target.",
      "Ranked by achievement, not by sales, so a small district that covered its target outranks a large one that did not.",
      PARTITION.same
        ? "THE REGION COLUMN IS THE AREA MAP'S OPERATIONAL REGION, and on this line it partitions the seats exactly as the managers do - the same rows, the same seats, the same figures. A second Regions sheet would have been this table again under another heading, so there is not one."
        : "THE REGION COLUMN LISTS EVERY REGION THE DISTRICT TOUCHES. They do not partition the seats the same way on this line, so the Regions sheet is a different question and is kept.",
    ], COLS);
    ws.autoFilter = { from: { row: headAt, column: 1 }, to: { row: last, column: COLS } };
    ws.views = [{ state: "frozen", xSplit: 2, ySplit: headAt, showGridLines: false }];
    return ws;
  }

  // ===========================================================================
  // 3 -- Regions
  // ===========================================================================
  function sheetRegions() {
    const COLS = 12;
    const W = [7, 23, 9, 11, 14, 12, 12, 14, 14, 12, 13, 11];
    const ws = book.dress(wb.addWorksheet("Regions", { properties: { tabColor: { argb: SHORT } } }), monthName(PERIOD));
    const { rows, total } = SEATS;
    const byRegion = new Map<string, LegacySeat[]>();
    for (const r of rows) {
      if (!byRegion.has(r.region)) byRegion.set(r.region, []);
      byRegion.get(r.region)!.push(r);
    }
    const list = [...byRegion.entries()].map(([region, members]) => ({
      region, members,
      dist: sum(members, (r) => r.distOnly), store: sum(members, (r) => r.store), dir: sum(members, ch3),
      sales: sum(members, (r) => r.sales), target: sum(members, (r) => r.target),
      vacant: members.filter((r) => r.who.vacant).length,
    })).map((g) => ({ ...g, ach: achievement(g.sales, g.target), rank: null as number | null }))
      .sort((a, b) => (a.ach == null && b.ach == null) ? b.sales - a.sales : a.ach == null ? 1 : b.ach == null ? -1 : b.ach - a.ach);
    let n = 0;
    for (const g of list) g.rank = g.ach == null ? null : (n += 1);

    let row = book.banner(ws, "regions", W);
    row = sectionLabel(ws, row, `THE REGIONS   ·   ${list.length} on ${LINE}`, `${n} carry a target and are ranked`, COLS);
    const headAt = row;
    row = headerRow(ws, row,
      ["Rank", "Region", "Seats", "Vacant seats", "Distributor EGP", "Stores EGP", `${CH3} EGP`, "Sales EGP", "Target EGP", "Achievement", "Performance", "Share of line"], W);
    const first = row;
    list.forEach((g, i) => {
      const zebra = i % 2 === 1;
      cell(ws, row, 1, g.rank ?? "unranked", { numFmt: g.rank ? "#,##0" : undefined, zebra, muted: !g.rank, size: g.rank ? 10 : 8, font: g.rank ? bold(10, INK) : undefined });
      cell(ws, row, 2, g.region, { zebra });
      cell(ws, row, 3, g.members.length, { numFmt: "#,##0", zebra });
      cell(ws, row, 4, g.vacant > 0 ? g.vacant : "none", { numFmt: g.vacant > 0 ? "#,##0" : undefined, zebra, muted: g.vacant === 0,
        font: g.vacant > 0 ? bold(10, SHORT_DEEP) : undefined });
      cell(ws, row, 5, g.dist, { numFmt: money, zebra });
      cell(ws, row, 6, g.store !== 0 ? g.store : "none", { numFmt: g.store !== 0 ? money : undefined, zebra, muted: g.store === 0, font: g.store < 0 ? bold(10, SHORT_DEEP) : undefined });
      cell(ws, row, 7, g.dir !== 0 ? g.dir : "none", { numFmt: g.dir !== 0 ? money : undefined, zebra, muted: g.dir === 0, font: g.dir < 0 ? bold(10, SHORT_DEEP) : undefined });
      cell(ws, row, 8, g.sales, { numFmt: money, zebra, font: bold(10, INK) });
      if (g.target > 0) {
        cell(ws, row, 9, g.target, { numFmt: money, zebra });
        cell(ws, row, 10, g.ach, { numFmt: pct, zebra, bracket: (g.ach ?? 0) >= 1 ? COVERED : SHORT });
        cell(ws, row, 11, g.ach, { numFmt: hidden, zebra });
      } else {
        cell(ws, row, 9, "no target", { zebra, muted: true, size: 9 });
        cell(ws, row, 10, "no achievement", { zebra, muted: true, size: 9 });
        cell(ws, row, 11, "", { zebra });
      }
      cell(ws, row, 12, total > 0 ? g.sales / total : null, { numFmt: pct1, zebra });
      row += 1;
    });
    const last = row - 1;
    totalRow(ws, row, COLS);
    cell(ws, row, 2, `ALL ${LINE.toUpperCase()}`, { font: bold(10, INK) });
    for (const [col, L] of [[3, "C"], [5, "E"], [6, "F"], [7, "G"], [8, "H"], [9, "I"], [12, "L"]]) {
      const x = ws.getCell(row, col);
      x.value = { formula: `SUM(${L}${first}:${L}${last})` };
      x.numFmt = col === 12 ? pct1 : col === 3 ? "#,##0" : money;
    }
    ws.getCell(row, 10).value = { formula: `IF(I${row}>0,H${row}/I${row},"")` };
    ws.getCell(row, 10).numFmt = pct;
    for (let c = 1; c <= COLS; c += 1) ws.getRow(row).getCell(c).alignment = CENTRE;
    row += 2;
    dataBar(ws, `K${first}:K${last}`, { max: 1.2 });
    dataBar(ws, `L${first}:L${last}`);
    dataBar(ws, `F${first}:F${last}`, { color: SHORT });
    colourScale(ws, `H${first}:H${last}`);
    footnote(ws, row, [
      "The region is the AREA MAP's operational region as at the pull, not whatever a distributor's own sheet called the area on an invoice.",
      "A region holding seats but no target is listed and left unranked - it still contributes its sales to the line.",
    ], COLS);
    ws.autoFilter = { from: { row: headAt, column: 1 }, to: { row: last, column: COLS } };
    ws.views = [{ state: "frozen", xSplit: 2, ySplit: headAt, showGridLines: false }];
    return ws;
  }

  // ===========================================================================
  // 4 -- Month by month
  // ===========================================================================
  function sheetMonths() {
    const COLS = 5 + TREND.length + 4;
    const W = [7, 14, 27, 19, 25, ...TREND.map(() => 13), 14, 14, 14, 13];
    const ws = book.dress(wb.addWorksheet("Month by month", { properties: { tabColor: { argb: SOFT } } }), SPAN);
    const { rows } = SEATS;
    let row = book.banner(ws, "months", W);
    row = sectionLabel(ws, row, `THE SEATS ACROSS ${SPAN.toUpperCase()}   ·   ${rows.length} on ${LINE}`,
      `ranked by the achievement of ${SPAN_COUNT} together, which is not always the ranking of the closing month`, COLS);
    const headAt = row;
    const heads = ["Rank", "Region", "Medical rep", "Area", "District manager"];
    for (const p of TREND) heads.push(`${monthShort(p)} EGP`);
    heads.push("To date EGP", "To date target", "To date achievement", "Performance");
    row = headerRow(ws, row, heads, W);
    const first = row;

    const list = rows.map((r) => {
      const months = TREND.map((p) => monthOf(p, r.code));
      const answered = months.filter((m): m is { dir: number; dist: number } => m !== null);
      const toDate = sum(answered, (m) => m.dist + m.dir);
      const toDateTarget = TREND.reduce((a, p) => a + monthTargetOf(p, r.code), 0);
      return { ...r, months, toDate, toDateTarget, toDateAch: achievement(toDate, toDateTarget), qRank: null as number | null };
    }).sort((a, b) => (a.toDateAch == null && b.toDateAch == null) ? b.toDate - a.toDate
      : a.toDateAch == null ? 1 : b.toDateAch == null ? -1 : b.toDateAch - a.toDateAch);
    let n = 0;
    for (const r of list) r.qRank = r.toDateAch == null ? null : (n += 1);

    list.forEach((r, i) => {
      const zebra = i % 2 === 1;
      cell(ws, row, 1, r.qRank ?? "unranked", { numFmt: r.qRank ? "#,##0" : undefined, zebra, muted: !r.qRank, size: r.qRank ? 10 : 8, font: r.qRank ? bold(10, INK) : undefined });
      cell(ws, row, 2, r.region, { zebra, size: 9 });
      nameCell(ws, row, 3, r.who, { zebra });
      cell(ws, row, 4, r.area, { zebra, size: 9 });
      cell(ws, row, 5, r.who.dm, { zebra, size: 9, muted: r.who.dm === "Not assigned" });
      TREND.forEach((p, j) => {
        const m = r.months[j];
        cell(ws, row, 6 + j, m ? m.dist + m.dir : null, { numFmt: money, zebra });
      });
      const c0 = ws.getColumn(6).letter, c1 = ws.getColumn(5 + TREND.length).letter;
      // The to-date column is a live SUM across the month columns, so a reader who filters the
      // sheet sees Excel re-add it. `cell` writes values, so the formula is set on the cell it hands back.
      cell(ws, row, 6 + TREND.length, null, { numFmt: money, zebra, font: bold(10, INK) })
        .value = { formula: `SUM(${c0}${row}:${c1}${row})` };
      if (r.toDateTarget > 0) {
        cell(ws, row, 7 + TREND.length, r.toDateTarget, { numFmt: money, zebra });
        cell(ws, row, 8 + TREND.length, r.toDateAch, { numFmt: pct, zebra, bracket: (r.toDateAch ?? 0) >= 1 ? COVERED : SHORT });
        cell(ws, row, 9 + TREND.length, r.toDateAch, { numFmt: hidden, zebra });
      } else {
        cell(ws, row, 7 + TREND.length, "no target", { zebra, muted: true, size: 9 });
        cell(ws, row, 8 + TREND.length, "no achievement", { zebra, muted: true, size: 9 });
        cell(ws, row, 9 + TREND.length, "", { zebra });
      }
      row += 1;
    });
    const last = row - 1;
    totalRow(ws, row, COLS);
    cell(ws, row, 2, `${list.length} seats`, { font: bold(10, INK) });
    cell(ws, row, 3, `ALL ${LINE.toUpperCase()}`, { font: bold(10, INK) });
    TREND.forEach((p, j) => {
      const x = ws.getCell(row, 6 + j);
      x.value = Math.round(lineSales(p));
      x.numFmt = money;
    });
    ws.getCell(row, 6 + TREND.length).value = Math.round(TREND.reduce((a, p) => a + lineSales(p), 0));
    ws.getCell(row, 6 + TREND.length).numFmt = money;
    ws.getCell(row, 7 + TREND.length).value = Math.round(TREND.reduce((a, p) => a + lineTarget(p), 0));
    ws.getCell(row, 7 + TREND.length).numFmt = money;
    ws.getCell(row, 8 + TREND.length).value = achievement(TREND.reduce((a, p) => a + lineSales(p), 0), TREND.reduce((a, p) => a + lineTarget(p), 0));
    ws.getCell(row, 8 + TREND.length).numFmt = pct;
    for (let c = 1; c <= COLS; c += 1) ws.getRow(row).getCell(c).alignment = CENTRE;
    row += 2;
    colourScale(ws, `${ws.getColumn(6).letter}${first}:${ws.getColumn(5 + TREND.length).letter}${last}`);
    dataBar(ws, `${ws.getColumn(9 + TREND.length).letter}${first}:${ws.getColumn(9 + TREND.length).letter}${last}`, { max: 1.2 });
    footnote(ws, row, [
      "A BLANK MONTH means the closing returned no row at all for that seat in that month - no sale, or no source carrying it. It is not a zero, and it is not the same as a month that returned a zero.",
      `Ranked by the achievement of ${SPAN_COUNT} together, which is their sales over their targets. A seat can rank well here and badly in the closing month, or the other way round - that difference is the point of the tab.`,
      `The seats, the areas and the managers are today's arrangement, applied to every month shown. A seat that changed hands inside ${SPAN} shows the person sitting in it now.`,
    ], COLS);
    ws.autoFilter = { from: { row: headAt, column: 1 }, to: { row: last, column: COLS } };
    ws.views = [{ state: "frozen", xSplit: 4, ySplit: headAt, showGridLines: false }];
    return ws;
  }

  // ===========================================================================
  // 8 -- Units x Product x Month     owner, 2026-10-13: "add a tab month by month x units x product"
  //
  // THE ONE PLACE UNITS ARE ALLOWED, AND THE REASON IT IS GROUPED BY PRODUCT. A unit total is only
  // ever valid inside ONE product code: a rep sells several products and concentrations, and adding
  // their units gives a number that means nothing. So this sheet is cut BY PRODUCT first - every
  // figure in a block is the same product code - and it carries no grand total at all, because the
  // only honest total across products is value, which the rest of the workbook already shows.
  // ===========================================================================
  function sheetUnits() {
    const HEAD = ["Product", "Region", "Area", "Medical rep",
      ...TREND.map((p) => `${monthShort(p)} units`),
      "Units to date", "Target units", "Gap to date", "Achievement to date", "Performance", "Share of product"];
    const W = [23, 15, 19, 26, ...TREND.map(() => 13), 14, 14, 13, 14, 13, 14];
    const COLS = HEAD.length;
    const ws = book.dress(wb.addWorksheet("Units x Product x Month", { properties: { tabColor: { argb: COVERED } } }), `units, ${SPAN}`);
    const { rows } = SEATS;

    let row = book.banner(ws, "units", W);
    row = sectionLabel(ws, row, `EVERY PRODUCT'S UNITS, MONTH BY MONTH`,
      `${TREND.map(monthName).join("  ·  ")} - one block a product, because units are only addable inside one product code`, COLS);
    const headAt = row;
    row = headerRow(ws, row, HEAD, W);
    const first = row;

    // every area the trend touched, named the way the month sheet names it, in the ranking's order
    // first and the areas that hold no seat today after them
    const seatCodes = new Set(rows.map((r) => r.code));
    const extraCodes = [...PRODUCTS_BY_AREA.keys()].filter((c) => !seatCodes.has(c));
    const places = [
      ...rows.map((r) => ({ code: r.code, area: r.area, region: r.region, who: r.who, extra: false })),
      ...extraCodes.map((code) => ({
        code,
        area: L.areaRowOf(code)?.area_name ?? (code ? "Area not in today's area map" : "No area on the invoice"),
        region: L.areaRowOf(code) ? areaRegion(code) : "Not attributed",
        who: L.areaRowOf(code) ? holderOf(code) : { rep: "Reached no seat", dm: "Not assigned", vacant: false, repProbation: null, dmProbation: null },
        extra: true,
      })).sort((a, b) => a.area.localeCompare(b.area)),
    ];

    const products = [...new Set([...L.apUnits.keys(), ...L.apTargetUnits.keys()].map((k) => k.split("|")[2]))]
      .map((pc) => {
        const months = TREND.map((p) => places.reduce((a, pl) => a + (unitsOf(p, pl.code, pc) ?? 0), 0));
        const toDate = months.reduce((a, b) => a + b, 0);
        const target = TREND.reduce((a, p) => a + places.reduce((x, pl) => x + targetUnitsOf(p, pl.code, pc), 0), 0);
        return { pc, name: productName(pc), months, toDate, target, ach: achievement(toDate, target) };
      })
      .sort((a, b) => b.toDate - a.toDate || a.name.localeCompare(b.name));

    let blocks = 0;
    for (const prod of products) {
      const zebra = blocks % 2 === 1;
      blocks += 1;
      const mine = places.map((pl) => {
        const months = TREND.map((p) => unitsOf(p, pl.code, prod.pc));
        const have = months.map((u) => u !== null);
        const got = months.map((u) => u ?? 0);
        const toDate = got.reduce((a, b) => a + b, 0);
        const target = TREND.reduce((a, p) => a + targetUnitsOf(p, pl.code, prod.pc), 0);
        return { ...pl, have, got, toDate, target, ach: achievement(toDate, target) };
      }).filter((x) => x.have.some(Boolean) || x.target > 0);

      // the product's own line
      cell(ws, row, 1, prod.name, { zebra, font: bold(10, INK) });
      cell(ws, row, 2, "", { zebra });
      cell(ws, row, 3, "", { zebra });
      cell(ws, row, 4, `${mine.length} ${mine.length === 1 ? "area" : "areas"}`, { zebra, size: 8.5, muted: true });
      prod.months.forEach((u, i) => cell(ws, row, 5 + i, u, { numFmt: units, zebra, font: bold(10, u < 0 ? SHORT_DEEP : INK) }));
      cell(ws, row, 8, prod.toDate, { numFmt: units, zebra, font: bold(10, prod.toDate < 0 ? SHORT_DEEP : INK) });
      cell(ws, row, 9, prod.target > 0 ? prod.target : "no target", { numFmt: prod.target > 0 ? units : undefined, zebra, muted: !(prod.target > 0), size: prod.target > 0 ? 10 : 9 });
      cell(ws, row, 10, prod.target > 0 ? prod.toDate - prod.target : "", { numFmt: prod.target > 0 ? unitsSigned : undefined, zebra });
      cell(ws, row, 11, prod.ach == null ? "no achievement" : prod.ach, { numFmt: prod.ach == null ? undefined : pct, zebra, muted: prod.ach == null, size: prod.ach == null ? 9 : 10, bracket: prod.ach == null ? undefined : (prod.ach >= 1 ? COVERED : SHORT), font: prod.ach == null ? undefined : bold(10, INK) });
      cell(ws, row, 12, prod.ach == null ? "" : prod.ach, { numFmt: hidden, zebra });
      cell(ws, row, 13, 1, { numFmt: pct1, zebra, muted: true, size: 9 });
      row += 1;

      for (const x of mine) {
        cell(ws, row, 1, "", { zebra });
        cell(ws, row, 2, x.region, { zebra, size: 9, muted: x.extra });
        cell(ws, row, 3, x.area, { zebra, size: 9, muted: x.extra });
        if (x.extra) cell(ws, row, 4, x.who.rep, { zebra, size: 9, muted: true });
        else nameCell(ws, row, 4, x.who, { zebra });
        x.got.forEach((u, i) => {
          cell(ws, row, 5 + i, x.have[i] ? u : "none", { numFmt: x.have[i] ? units : undefined, zebra, size: 9, muted: !x.have[i],
            font: x.have[i] && u < 0 ? bold(9, SHORT_DEEP) : undefined });
        });
        cell(ws, row, 8, x.toDate, { numFmt: units, zebra, size: 9, font: bold(9, x.toDate < 0 ? SHORT_DEEP : INK) });
        cell(ws, row, 9, x.target > 0 ? x.target : "no target", { numFmt: x.target > 0 ? units : undefined, zebra, size: 9, muted: !(x.target > 0) });
        cell(ws, row, 10, x.target > 0 ? x.toDate - x.target : "", { numFmt: x.target > 0 ? unitsSigned : undefined, zebra, size: 9 });
        cell(ws, row, 11, x.ach == null ? "no achievement" : x.ach, { numFmt: x.ach == null ? undefined : pct, zebra, size: 9, muted: x.ach == null, bracket: x.ach == null ? undefined : (x.ach >= 1 ? COVERED : SHORT) });
        cell(ws, row, 12, x.ach == null ? "" : x.ach, { numFmt: hidden, zebra });
        cell(ws, row, 13, prod.toDate !== 0 ? x.toDate / prod.toDate : "", { numFmt: pct1, zebra, size: 9 });
        ws.getRow(row).outlineLevel = 1;
        ws.getRow(row).height = nameRowHeight(x.who.rep, W[3]);
        row += 1;
      }
    }
    const last = row - 1;

    // NO GRAND TOTAL, AND THE SHEET SAYS WHY. Every other tab's foot adds up; this one must not.
    totalRow(ws, row, COLS);
    cell(ws, row, 1, `${products.length} products`, { font: bold(10, INK) });
    cell(ws, row, 4, "UNITS ARE NOT ADDED ACROSS PRODUCTS", { font: bold(9, SHORT) });
    for (let c = 5; c <= COLS; c += 1) cell(ws, row, c, "", {});
    for (let c = 1; c <= COLS; c += 1) ws.getRow(row).getCell(c).alignment = CENTRE;
    row += 2;

    dataBar(ws, `L${first}:L${last}`, { max: 1.2 });
    dataBar(ws, `M${first}:M${last}`, { color: COVERED, max: 1 });

    footnote(ws, row, [
      "UNITS ARE ONLY EVER ADDED INSIDE ONE PRODUCT CODE. A rep sells several products and concentrations; adding their units gives a figure that means nothing, however neat it looks. That is why this sheet is cut by product, why a block totals only its own product, and why the foot carries no grand total - above one product code, value is the only thing that aggregates.",
      "A MONTH READS 'none' WHERE THE CLOSING PUBLISHES NO CELL AT ALL for that area and product, never 0 - the same rule as everywhere else in this workbook. A cell that does exist prints its figure, negative included.",
      "THE UNITS ARE THE CLOSING'S OWN: the distributor book's units from the closing matrix plus the direct orders' own units. Nothing here is value divided by a price, and no unit figure is re-derived.",
      "TARGET UNITS ARE THE TARGET ROWS' OWN UNIT FIGURE, so achievement on this sheet is units over units - it is not the value achievement shown elsewhere and the two can differ wherever a price moved.",
      "SHARE OF PRODUCT is each area against its own product's units to date, so a block reads down to 100%. Share of the line would need units of different products added, which is exactly what this sheet refuses to do.",
    ], COLS);

    ws.autoFilter = { from: { row: headAt, column: 1 }, to: { row: last, column: COLS } };
    ws.views = [{ state: "frozen", xSplit: 4, ySplit: headAt, showGridLines: false }];
    return ws;
  }

  // ===========================================================================
  // 5 -- Rows: every counted row of the closing month, at invoice grain
  // ===========================================================================
  // Owner, 2026-10-13: "I want the raw detailed sheet to be in the export rep ranking in monthly
  // closing." Every other tab in this file is an aggregate — a seat, a district, an area x product.
  // This is the layer underneath them, and the only one the ranking can be re-added from by hand.
  //
  // 🔴 ITS TOTAL IS THE LINE'S OWN FIGURE FOR THE MONTH, BY CONSTRUCTION — the Value column is each
  // row's contribution to the closing, the same number the matrix sums, so this tab cannot drift
  // from the Ranking tab beside it. The arrangement is shared with the premium workbook's Rows tab
  // (closing-rows-sheet.ts), so the two files cannot disagree about what a counted row is.
  //
  // 🔴 IT CARRIES NO LETTERHEAD STRIP, AND THAT IS DELIBERATE RATHER THAN AN OMISSION. Every strip
  // in `public/brand/anti-infective-ranking/` names ONE tab and bakes a MONTH into the artwork
  // ("SEPTEMBER 2026"); there is no strip for this tab, and borrowing another's would print both
  // the wrong tab name and a month this file may not be. The identity's own keycard band is drawn
  // instead, from the figures this build actually counted.
  //
  // ONLY THE CLOSING MONTH, never the trend: the trend months are shown as figures on the
  // month-by-month tabs, and three months of invoice rows is a different and much larger file. The
  // caption names the month, so nobody has to infer it.
  // THE EPDA TAB — owner, 2026-11-04: "a column per product share for epda after the spread", in
  // all three closing downloads. The grid is closing-epda-sheet.ts's, shared with the two closing
  // workbooks, so the three files cannot disagree about an area's EPDA units. Only the closing month.
  function sheetEpda() {
    const spec = input.epda ?? null;
    if (spec === null) return null;
    const HEAD = [...spec.headers];
    const W = [...spec.widths];
    const COLS = HEAD.length;
    const ws = book.dress(
      wb.addWorksheet(CLOSING_EPDA_SHEET_NAME, { properties: { tabColor: { argb: LABEL_GREY } } }),
      `EPDA units by area, ${monthName(PERIOD)}`,
    );

    const totals = spec.records[spec.records.length - 1] ?? [];
    const products = HEAD.slice(2);
    // One card per product, never one across them: units of different products are never added.
    const cards = products.slice(0, Math.max(1, Math.floor(COLS / 2))).map((label, index) => ({
      label: label.toUpperCase(),
      value: Number(totals[index + 2] ?? 0),
      fmt: "#,##0",
      sub: `${monthName(PERIOD)}, every area in this file`,
    }));
    let row = keycards(ws, 2, cards, COLS);
    row = sectionLabel(ws, row, "EPDA UNITS BY AREA", spec.caption, COLS);
    const headAt = row;
    row = headerRow(ws, row, HEAD, W);

    spec.records.forEach((record, index) => {
      const kind = spec.rowKinds[index];
      if (kind === "total") {
        record.forEach((value, column) => {
          cell(ws, row, column + 1, value, typeof value === "number" ? { numFmt: "#,##0" } : {});
        });
        totalRow(ws, row, COLS);
      } else {
        const group = kind === "group";
        record.forEach((value, column) => {
          cell(ws, row, column + 1, group && column === 1 ? "" : value, {
            zebra: !group && index % 2 === 1,
            ...(typeof value === "number" ? { numFmt: "#,##0" } : {}),
            ...(group ? { font: bold(10, INK) } : {}),
          });
        });
      }
      row += 1;
    });

    ws.views = [{ state: "frozen", xSplit: 2, ySplit: headAt, showGridLines: false }];
    return ws;
  }

  function sheetRows() {
    const spec = closingRowsSheetSpec({
      distributorNames: input.distributorNames ?? new Map<string, string>(),
      line: LINE,
      periodLabel: monthName(PERIOD),
      rows: input.details ?? [],
    });
    // Null rather than an empty tab, exactly as every other optional sheet in this repo: a tab the
    // Trust page lists and that holds nothing reads as a read that failed.
    if (spec === null) return null;

    const HEAD = [...spec.headers];
    const W = [...spec.widths];
    const COLS = HEAD.length;
    const ws = book.dress(
      wb.addWorksheet(CLOSING_ROWS_SHEET_NAME, { properties: { tabColor: { argb: LABEL_GREY } } }),
      `every counted row, ${monthName(PERIOD)}`,
    );

    let row = keycards(ws, 2, [
      { label: "ROWS COUNTED", value: spec.rowCount, fmt: "#,##0", sub: "every one of them is in the ranking" },
      { label: "THEIR VALUE", value: Math.round(spec.totalValue), fmt: money, sub: `EGP - the line's own figure for ${monthName(PERIOD)}` },
      { label: "LINE", value: LINE, sub: `${monthName(PERIOD)} only` },
      { label: "GRAIN", value: "one invoice row", sub: "not an aggregate of anything" },
    ], COLS);

    row = sectionLabel(ws, row, "EVERY COUNTED ROW", spec.caption, COLS);
    const headAt = row;
    row = headerRow(ws, row, HEAD, W);

    // 🔴 UNITS, PRICE, DISCOUNT AND THE ROW ID TAKE EXCEL'S GENERAL FORMAT, never the money one: an
    // Office allocation row carries fractional units by the golden rule, and rounded to whole
    // numbers a real sale prints as a zero. Only Value is money here.
    const VALUE_COLUMN = HEAD.indexOf("Value EGP") + 1;
    const UNITS_COLUMN = HEAD.indexOf("Units") + 1;
    const BONUS_COLUMN = HEAD.indexOf("Bonus units") + 1;
    const SMALL = new Set(["Customer name", "Customer address", "Product"]);

    spec.records.forEach((record, index) => {
      const zebra = index % 2 === 1;
      record.forEach((value, column) => {
        const heading = HEAD[column] ?? "";
        cell(ws, row, column + 1, value, {
          zebra,
          ...(typeof value === "number" && column + 1 === VALUE_COLUMN ? { numFmt: money } : {}),
          ...(SMALL.has(heading) ? { size: 9 } : {}),
        });
      });
      row += 1;
    });
    const last = row - 1;

    // 🔴 VALUE ONLY. Units are NOT totalled, here or anywhere: each row is one product code, so a
    // column total across different products and concentrations is not a quantity of anything
    // (AGENTS.md §4). The foot says so rather than leaving a reader to wonder why it stops.
    for (let column = 1; column <= COLS; column += 1) cell(ws, row, column, "", {});
    cell(ws, row, 1, `${spec.rowCount.toLocaleString("en-US")} rows`, { font: bold(10, INK) });
    cell(ws, row, UNITS_COLUMN, "not totalled", { muted: true, size: 8.5 });
    cell(ws, row, BONUS_COLUMN, "not totalled", { muted: true, size: 8.5 });
    cell(ws, row, VALUE_COLUMN, Math.round(spec.totalValue), { numFmt: money, font: bold(10, INK) });
    totalRow(ws, row, COLS);
    row += 1;

    footnote(ws, row + 1, spec.notes, COLS);

    ws.autoFilter = { from: { row: headAt, column: 1 }, to: { row: last, column: COLS } };
    // Frozen under the headings and after the first two columns, so a reader scrolling right keeps
    // the invoice date and its reference in view — the two things a row is looked up by.
    ws.views = [{ state: "frozen", xSplit: 2, ySplit: headAt, showGridLines: false }];
    return ws;
  }

  // ===========================================================================
  // 6 -- Trust
  // ===========================================================================
  function sheetTrust() {
    const COLS = 7;
    // ONE width profile for the whole sheet: headerRow sets column widths, and a column has a single
    // width per sheet, so a per-table array silently re-widths every table above it.
    const W = [38, 20, 18, 20, 16, 16, 16];
    const PROSE = 104;   // characters a line holds across the merged 2..7 span
    const NAMED = 66;    // and across the merged 4..7 span
    const ws = book.dress(wb.addWorksheet("Trust", { properties: { tabColor: { argb: BASE } } }), "how every figure was worked out");
    const { rows, ranked, total } = SEATS;
    let row = book.banner(ws, "full", W);

    const section = (label: string, note: string | null) => { row = sectionLabel(ws, row, label, note, COLS); };

    // 🔴 FIRST, BEFORE THE TABS: what this file is. A reader who opens Trust to check a figure
    // against the closing has to be told the rectangle before anything else, or he reconciles a
    // filtered total against the line and concludes the workbook is wrong.
    if (COVERAGE.length > 0) {
      section("WHAT THIS FILE COVERS", `It is NOT the whole ${LINE} line.`);
      row = headerRow(ws, row, ["The filter", "What it means for every figure here", "", "", "", "", ""], W);
      const covers: Array<[string, string]> = COVERAGE.map((line) => {
        const [head, ...rest] = line.split(":");
        return [head!.trim(), rest.join(":").trim()] as [string, string];
      });
      covers.push(["Every figure", "Still the published closing, cell for cell - a filter only DROPS cells here, it never re-derives a number. A seat's sales is the sum of its own surviving cells, and its target the sum of theirs, so an achievement on this sheet is that selection's achievement and not the seat's whole month."]);
      covers.push(["The line total", `${Math.round(SEATS.total).toLocaleString("en-US")} EGP is the total OF THIS SELECTION. Reconciling it against ${LINE}'s own month will not balance, and should not.`]);
      covers.forEach(([k, v], j) => {
        const zebra = j % 2 === 1;
        cell(ws, row, 1, k, { zebra, font: bold(10, INK) });
        const c = cell(ws, row, 2, v, { zebra, size: 9 });
        c.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
        ws.mergeCells(row, 2, row, COLS);
        ws.getRow(row).height = Math.max(24, Math.ceil(v.length / PROSE) * 13);
        row += 1;
      });
      row += 1;
    }

    section(`THE ${wb.worksheets.length} TABS, AND WHAT EACH ONE ANSWERS`, "Every one of them reads the same published closing. None re-derives a figure beside it.");
    row = headerRow(ws, row, ["Tab", "The question it answers", "", "", "", "", ""], W);
    // THE LIST IS THE WORKBOOK'S OWN TABS, in their own order -- never a hand-kept list that can
    // go on naming a sheet after it is dropped.
    const TAB_NOTE: Record<string, string> = {
      "Ranking": "Who is ahead this month, and where each seat's money came from. The three channels sit side by side with the share each takes of that seat's own sales.",
      "Who": "The closing matrix's arrangement: a district's reps one after another, then their district manager closing the team, then the next team. A manager's line is the whole district - the reps above it added up - and that line appears once, not under every rep. Collapse the outline and the sheet is one line a district.",
      "Area x Product": "A district's reps with every product each one sold, then that district's manager closing the team. Share of seat reads down a block to 100%, so it answers what a product is worth inside one rep's bag.",
      "Area x Product (filter)": "The same cells with every grouping removed - one row a cell, nothing merged, nothing outlined, nothing carried down from a header. This is the one to filter, sort or pivot.",
      "Area x Product x Month": `The same arrangement across ${SPAN}: a district's reps with their products, their manager closing the team, and the months added. To date means those months and nothing older; achievement to date divides their sales by their targets, which is not the average of the monthly percentages.`,
      "Districts": PARTITION.same
        ? "Each manager's whole district, ranked by achievement rather than by sales, with the region beside it - on this line a district and a region hold exactly the same seats, so there is no second sheet saying it again."
        : "Each manager's whole district, ranked by achievement rather than by sales, with every region it touches beside it.",
      "Regions": "The area map's operational regions, which on this line do NOT hold the same seats as the districts - which is why they have their own sheet.",
      "Month by month": `Each seat across ${SPAN}, ranked by the achievement of ${SPAN_COUNT} together - which is not always the ranking of the closing month.`,
      "Units x Product x Month": "Units, one product at a time, month by month. The only sheet with a unit column, and it has no grand total on purpose: units of different products are not addable, so the foot says so instead of adding them.",
      [CLOSING_ROWS_SHEET_NAME]: `Every counted row of ${monthName(PERIOD)}, at invoice grain — the layer under every tab above, and the only one the ranking can be re-added from by hand. Its Value column is each row's own contribution to the closing, so the total at its foot is the line's figure for the month. Units are not totalled on it: each row is one product code, and units of different products are not addable.`,
      "Trust": "This sheet. What every figure is made of, what is absent rather than zero, and which choices in the look were the identity's and which were not.",
    };
    const tabs = wb.worksheets.map((w) => [w.name, TAB_NOTE[w.name] ?? "-"]);
    tabs.forEach(([k, v], j) => {
      const zebra = j % 2 === 1;
      cell(ws, row, 1, k, { zebra, font: bold(10, INK) });
      const c = cell(ws, row, 2, v, { zebra, size: 9 });
      c.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      ws.mergeCells(row, 2, row, COLS);
      ws.getRow(row).height = Math.max(24, Math.ceil(v.length / PROSE) * 13);
      row += 1;
    });
    row += 1;

    section("WHAT THE RANKING IS MADE OF", "A rank can be arithmetically perfect over a fraction of the seats.");
    row = headerRow(ws, row, ["Month", "Seats selling", "Seats with a target", "Distributor cells", `${CH3} cells`, "Sales EGP", "Target EGP"], W);
    TREND.forEach((p, i) => {
      const all = cellsOf(p);
      const zebra = i % 2 === 1;
      cell(ws, row, 1, monthName(p), { zebra });
      cell(ws, row, 2, new Set(all.map((c) => c.areaCode)).size, { numFmt: "#,##0", zebra });
      cell(ws, row, 3, new Set(targetRows(p).map((t) => t.areaCode)).size, { numFmt: "#,##0", zebra });
      cell(ws, row, 4, all.filter((c) => c.channel === DIST).length, { numFmt: "#,##0", zebra });
      const dc = all.filter((c) => c.channel === CH3).length;
      cell(ws, row, 5, dc > 0 ? dc : "none", { numFmt: dc > 0 ? "#,##0" : undefined, zebra, muted: dc === 0 });
      cell(ws, row, 6, lineSales(p), { numFmt: money, zebra });
      cell(ws, row, 7, lineTarget(p), { numFmt: money, zebra });
      row += 1;
    });
    row += 1;

    section("THINGS THAT ARE ABSENT, NOT ZERO", "Each would read as a nil result anywhere that prints a 0.");
    row = headerRow(ws, row, ["What is absent", "How many", "What it is worth", "Named", "", "", ""], W);
    const unranked = rows.filter((r) => r.rank == null);
    const soldNothing = rows.filter((r) => !r.answered && r.target > 0);
    const vacant = rows.filter((r) => r.who.vacant);
    const vacantWithTarget = vacant.filter((r) => r.target > 0);
    const probation = rows.filter((r) => r.who.repProbation);
    const noDm = rows.filter((r) => r.who.dm === "Not assigned");
    const facts = [
      { what: "Seats listed but UNRANKED - no target was set", list: unranked, worth: sum(unranked, (r) => r.sales), name: (r: LegacySeat) => r.area },
      { what: "Seats with a target that returned no sales at all", list: soldNothing, worth: sum(soldNothing, (r) => r.target), name: (r: LegacySeat) => r.area },
      { what: "Vacant seats, ranked and marked red", list: vacant, worth: sum(vacant, (r) => r.sales), name: (r: LegacySeat) => r.area },
      { what: "Vacant seats still carrying a target", list: vacantWithTarget, worth: sum(vacantWithTarget, (r) => r.target), name: (r: LegacySeat) => r.area },
      { what: "Reps still inside their probation period", list: probation, worth: sum(probation, (r) => r.target), name: (r: LegacySeat) => `${r.who.rep} (${r.area}, to ${dayOf(r.who.repProbation)})` },
      { what: "Seats with no district manager assigned", list: noDm, worth: sum(noDm, (r) => r.sales), name: (r: LegacySeat) => r.area },
    ];
    facts.forEach((f, i) => {
      const zebra = i % 2 === 1;
      const named = f.list.map(f.name).join(", ");
      cell(ws, row, 1, f.what, { zebra });
      cell(ws, row, 2, f.list.length, { numFmt: "#,##0", zebra });
      cell(ws, row, 3, f.list.length > 0 ? f.worth : "nothing", { numFmt: f.list.length > 0 ? money : undefined, zebra, muted: f.list.length === 0 });
      const c = cell(ws, row, 4, named || "none", { zebra, muted: !named, size: 9 });
      c.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      ws.mergeCells(row, 4, row, COLS);
      ws.getRow(row).height = 13 + Math.ceil((named || "none").length / NAMED) * 11;
      row += 1;
    });
    row += 1;

    section("PUBLICATION STATE", "A rank here is the live engine's. Published is a separate act.");
    row = headerRow(ws, row, ["Month", "Published", "By", "Then unpublished", "State now", "", ""], W);
    const stamp = (iso: string | null) => iso ? new Date(iso).toLocaleString("en-GB", { timeZone: "Africa/Cairo", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "";
    // Already this line's — loadRankingPublications queries by line — and copied before sorting,
    // because sort mutates and this array is the caller's.
    [...L.publications].sort((a, b) => b.period.localeCompare(a.period)).forEach((p, j) => {
      const zebra = j % 2 === 1;
      cell(ws, row, 1, monthName(p.period), { zebra });
      cell(ws, row, 2, stamp(p.published_at), { zebra, size: 9 });
      cell(ws, row, 3, p.published_by === "b-10" ? "Omar Gawish" : p.published_by, { zebra });
      cell(ws, row, 4, stamp(p.unpublished_at) || "still published", { zebra, muted: !p.unpublished_at, size: 9 });
      cell(ws, row, 5, p.unpublished_at ? "Not published" : "Published", { zebra, muted: !!p.unpublished_at });
      row += 1;
    });
    row += 1;

    section("HOW EVERY NUMBER ABOVE WAS WORKED OUT", "Quote this when a rank is challenged.");
    row = headerRow(ws, row, ["Figure", "How it is produced", "", "", "", "", ""], W);
    const how = [
      ["The rank", `Seats sorted by achievement, high to low. ${ranked} of ${rows.length} seats carry a target and take a rank; the rest are listed at the foot as unranked. Ranking by SALES instead would put a large untargeted seat above a small one that covered its figure.`],
      ["Achievement", `The seat's whole sales value - every channel together, ${CH3 === OFFICE ? "the company's own Office stock" : "direct orders"} and money nobody targeted included - divided by the target value it was given. A zero or missing target yields no percentage rather than 0%.`],
      ["The three channels", CH3 === OFFICE
        ? `Distributor sales come from the closing matrix. ${LINE} SELLS NO DIRECT ORDERS AT ALL - the owner's ruling of 13 October 2026, "CNS don't have direct orders" - so the third column is OFFICE: the company's own stock, allocated across the areas by the locked Office rule, each area taking its share of the line's non-Office VALUE. It is carved OUT of the distributor book exactly as STORES is, and for the same reason: Office is not a distributor and a warehouse buys from one, so counting either beside the book would count its money twice. Distributor + Stores + Office = Sales, exactly. ${Math.round(sum(rows, (r) => r.office)).toLocaleString("en-US")} EGP of ${monthName(PERIOD)} was Office, and ${Math.round(sum(rows, (r) => r.store)).toLocaleString("en-US")} EGP went through ${L.warehouseCustomers} warehouses.${FOLDED_DIRECT !== 0 ? ` ${Math.round(FOLDED_DIRECT).toLocaleString("en-US")} EGP of direct movement did reach this line this month - credits rather than orders - and with no direct column to stand in, it sits INSIDE the distributor figure instead of outside the three. The three still add to Sales exactly; that is what folding it in is for.` : ""}`
        : `Distributor sales come from the closing matrix; direct orders from the direct-order path. They are separate reads of the engine and both are counted - reading only the matrix understates any line that sells direct. STORES is the third, and it is carved OUT of the distributor book rather than added beside it, because a warehouse buys from a distributor: counting it as a fourth bucket would count its money twice. So Distributor + Stores + Direct = Sales, exactly. ${Math.round(sum(rows, (r) => r.store)).toLocaleString("en-US")} EGP of ${monthName(PERIOD)} went through ${L.warehouseCustomers} warehouses.`],
      ["Who is a warehouse", "The platform's own rule, imported from src/lib/sales/customer-channel.ts rather than transcribed - that file declares itself the single edit point, and its own comment records that a hand-copied version of the six store words once mis-stated this channel by 8.7M EGP. Each month is asked with the rule that was IN FORCE FOR IT: the owner's 2026-09-06 rulings start at September on this line, so July and August are classified on the earlier rule. Using today's rule for every month shown would silently restate a published one."],
      ["The split is taken, not re-priced", `Every invoice row is carved at the sales value the closing engine itself gave it - the same figure the published cell was built from - so Distributor, Stores and ${CH3} add to that cell by construction and not by a reconciliation that could drift. A warehouse is a KIND OF CUSTOMER inside the distributor book, which is why Stores is carved OUT of the distributor figure instead of added beside it: ${L.warehouseCustomers} warehouse customers in ${monthName(PERIOD)}, over ${cellsOf(PERIOD).length} channel-tagged cells of the month. No figure anywhere in this workbook moved to make the three columns appear.`],
      ["A district's figure", "Its own seats' sales over its own seats' targets - never the average of its seats' percentages, which would weight a small seat like a large one."],
      ["Vacant and probation", `A seat with nobody in it is red and still ranked, because the money through it is real and the target it carries is real. A rep inside their probation period is yellow on the name cell alone. ${probation.length} on this line.`],
      ["Units", "On ONE sheet only - Units x Product x Month - and cut by product there, because a unit total is valid only inside one product code. A rep sells several products and concentrations, so above a product code value is the only figure that aggregates: that sheet carries no grand total, and no other sheet carries a unit column."],
      ["Seats, areas, managers", "The area map and the live seat occupancy as at the pull - today's arrangement, applied to every month shown."],
      // 🔴 THIS IS THE LINE THAT CRASHED THE DOWNLOAD: `TREND[2]` on a trend of one month.
      ["Scope", `${LINE} only, ${monthName(PERIOD)} for the ranking and ${SPAN} for the month-by-month tab. Head Office is not a tracked line and is not in any figure here.${CH3 === OFFICE ? " The Office column is a CHANNEL inside this line - the company's own stock sold against these areas - and not the Head Office line, which is a different thing with the same word in it." : ""}`],
    ];
    how.forEach(([k, v], j) => {
      const zebra = j % 2 === 1;
      cell(ws, row, 1, k, { zebra, font: bold(10, INK) });
      const c = cell(ws, row, 2, v, { zebra, size: 9 });
      c.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      ws.mergeCells(row, 2, row, COLS);
      ws.getRow(row).height = Math.max(24, Math.ceil(v.length / PROSE) * 13);
      row += 1;
    });
    row += 1;

    // ---- the dress itself, declared ----
    section("THE DRESS, AND WHAT IN IT IS NOT THE IDENTITY'S", "So nobody has to guess which choices were the identity's and which were mine.");
    row = headerRow(ws, row, ["Element", "Where it comes from", "", "", "", "", ""], W);
    // THE LINE'S OWN ANSWER, out of its dress - the facts differ per identity and a shared answer
    // would be wrong on one of them. Only the two rows that are computed from THIS build sit here.
    const dressRows: Array<readonly [string, string]> = [
      ...dress.dressRows,
      ["The letterhead bar", `The ${wb.worksheets.length - 1} sheets that are read for figures carry a 2480 x ${Math.round(2480 * BANNER_RATIO.strip)} bar instead - the mark on the left, the title in the middle, the scope on the right, closing on the same seam. Excel's frozen pane holds EVERYTHING above the split, so chrome over a table's header row is pinned to the top of the window and cannot be scrolled away: a tall masthead there does not push the numbers down, it eats the window. One judgement call: the bar's title is a fraction of the masthead's and its chrome is laid out horizontally, which is the same move the identity makes when it scales its own chrome to a piece.`],
      ["What Excel cannot do", "Radial gradients, film grain, vignettes, soft shadows, the cartons' box-reflect and letter-spaced micro labels have no cell equivalent. That is precisely why the chrome is rendered rather than approximated."],
    ];
    dressRows.forEach(([k, v], j) => {
      const zebra = j % 2 === 1;
      cell(ws, row, 1, k, { zebra, font: bold(10, INK) });
      const c = cell(ws, row, 2, v, { zebra, size: 9 });
      c.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      ws.mergeCells(row, 2, row, COLS);
      ws.getRow(row).height = Math.max(24, Math.ceil(v.length / PROSE) * 13);
      row += 1;
    });
    row += 1;

    footnote(ws, row, [
      `The line's own figure: ${Math.round(total).toLocaleString("en-US")} EGP against ${Math.round(lineTarget(PERIOD)).toLocaleString("en-US")} EGP, ${((achievement(total, lineTarget(PERIOD)) ?? 0) * 100).toFixed(2)}%. Every seat above adds into exactly that.`,
      "Built outside Phoenix from a read-only pull of the production closing engine. It writes nothing back and is a view of the month, not a record of it.",
      dress.identityLine,
    ], COLS);
    return ws;
  }

  sheetRanking();
  sheetWho();
  sheetAreaProduct();
  sheetAreaProductFlat();
  sheetAreaProductMonth();
  sheetDistricts();
  if (!PARTITION.same) sheetRegions();
  sheetMonths();
  sheetUnits();
  // Before Trust, deliberately: Trust lists the workbook's OWN tabs in their own order, so a sheet
  // added after it would be missing from the list it prints.
  sheetEpda();
  sheetRows();
  sheetTrust();

  // The product rows actually in the file — counted on the built sheet rather than tracked by the
  // builder, because what a reader can see is what the FILE holds. This is the number the
  // collapsed-flag defect moved without moving any row: 197 here, 0 visible in the first PDF.
  const productLineCount = (() => {
    const sheet = wb.worksheets.find((candidate) => candidate.name === "Area x Product");
    if (!sheet) return 0;
    let seen = 0;
    sheet.eachRow({ includeEmpty: false }, (row) => {
      if (row.outlineLevel === 2) seen += 1;
    });
    return seen;
  })();

  growRowsToFitWrappedText(wb);

  // NO TAB PROTECTED (owner, 2026-10-26: "all its types download non protected"), hidden ones included.
  const openSheets = unprotectExcelWorkbook(wb);

  const written = Buffer.from(await wb.xlsx.writeBuffer());
  const repaired = await repairEmittedWorkbook(written);

  return {
    buffer: repaired.buffer,
    facts: {
      bannersEmbedded: book.bannerCount,
      falseCollapsesCleared: repaired.falseCollapses,
      openSheets,
      productRows: productLineCount,
      sheetNames: wb.worksheets.map((sheet) => sheet.name),
    },
  };
}
