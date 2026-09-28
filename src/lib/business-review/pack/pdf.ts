// The Sales Review pack — the PDF.
//
// Reads the pack model and draws it. It computes NO figure and names NO section, exactly as the
// workbook does not: the two files a manager exports a minute apart must not disagree in front of
// his own manager.
//
// ── BUILT LIKE THE SPOTLIGHT SHEET, ON PURPOSE ──────────────────────────────────────────────────
//
// The owner's bar for this pack is the Spotlight sheet and the milestone card — the company's hero
// documents — not a page of plain tables. Those are HTML rendered through headless Chromium, which is
// what gives them the crest band, the bracketed field, the serif display face, the closed stat bands
// and the plinth. An earlier version of this file drew the pack with pdfmake in coordinates and it
// read as weak beside them. So this renders the SAME design language `src/lib/spotlight/pdf.ts` uses,
// through the same `withChromiumPage` driver, and shares its palette and its devices device for device.
//
// THE HOUSE IDENTITY `SATO-DIS-2026-01 v1.0`, with the ink rule relaxed for the crest band, the
// plinth and the stat/table fills — the owner's decision on 2026-09-26, the same exemption the
// premium closing workbook and the Spotlight sheet already hold. Everything else about the identity
// is unchanged: the logo palette, square edges everywhere, the on-light mark on white and the
// reversed mark on the crest, the 0.5 pt hairline floor, the document identity on every sheet, and no
// truncation anywhere.
//
// 🔴 A TABLE IS CAPPED AND SAYS SO. A pack is a presentation, not a dataset: forty rows of bricks is
// a page nobody reads. What is cut is stated on the page, with the workbook named as where the whole
// of it lives — never silently truncated, which would let a reader believe a district has four bricks
// when it has forty.
//
// 🔴 NOTHING RASTERISES. Chromium turns a CSS gradient or a repeating background into a page-sized
// layer per page. Fills are flat colours and both marks are single base64 data URIs referenced by
// every page — the raster discipline the Spotlight sheet records at length.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { escapeHtml } from "@/lib/hiring-pack/render-shared";
import { withChromiumPage } from "@/lib/pdf/chromium";

import { splitLeaverLabel } from "../employment-status";
import type { PackCell, PackChart, PackSection, SalesReviewPack } from "./model";

// ── Palette — the same values the Spotlight sheet uses ──────────────────────────────────────────
const C = {
  deep: "#0A527D",
  blue: "#0A6BA6",
  light: "#1482C2",
  tint: "#F3F7FA",
  hair: "#B9C7D4",
  muted: "#5A6B7C",
  body: "#1A1A1A",
  // The crest band and the plinth — near-black rather than the logo's deepest blue, so a blue mark
  // does not flatten against a blue ground.
  crest: "#0E1720",
  ink: "#111820",
  wash: "#EEF3F7",
  rule: "#D7DFE7",
  // The ONE non-blue ink in this document, and it marks exactly one thing: the person named beside
  // it has left the company (owner, 2026-09-28 — "make the left red colored"). Text colour only,
  // never a fill, so the INK RULE is untouched.
  danger: "#B91C1C",
} as const;

/**
 * Rows shown for a section, in total, across as many pages as they need. Above this the pack names
 * the workbook instead of going on — a pack is a presentation, not a dataset.
 */
const ROW_CAP = 24;

/**
 * Rows per PAGE, so a table never overruns the bracketed field and slices its last row under the
 * plinth. Landscape A4 holds far fewer than the cap once a district name wraps to two lines, so the
 * shown rows are split across continuation pages. Wide tables (a name column that wraps) get fewer.
 */
const CONTENT_PX = 1009.1; // 267mm — the table's usable width inside the page margins
/**
 * The table's own top (207.4px) down to where the page FOOTER sits when the page is not full
 * (689.1px). 🔴 It is the footer that binds, NOT the plinth at 771px: the foot is inside the page
 * column, so a table too tall pushes it down and out rather than sliding under it. Budgeting to the
 * plinth reads as 82px of room that does not exist, and that is precisely how the first fix here
 * still shipped two Rep-by-rep pages with the footer printed over the plinth.
 */
const TABLE_BOX_PX = 481.7;
const ROW_PX = 32.3; // a single-line body row
const EXTRA_LINE_PX = 17.0; // each wrapped line after the first
const HEADER_PX = 19.8; // a single-line header row
const HEADER_LINE_PX = 12.0; // each wrapped header line (6.6pt caps, tighter than a body line)
const CUT_NOTE_PX = 28.0; // the "N more rows are in the Excel version" line
const CELL_PAD_PX = 16.6; // 2.2mm of padding either side
/**
 * A glyph at 8.6pt — 0.66 em. 🔴 THE ADVANCE IS LETTER-DEPENDENT, AND THIS COVERS THE WIDEST NAME,
 * NOT AN AVERAGE. Averaging is how this has now been wrong twice.
 *
 * Measured in Chromium against real district-manager names in a 199.6px column:
 *
 *   "Weaam Mahmoud Mohamed Mahmoud"             29 chars  215.8px  0.649 em   WRAPS
 *   "Yehya Mohamed Kamal eldeen Saad Mohamed"   39 chars  253.1px  0.566 em   wraps
 *   "Nosiba Salah Hassanin Moussa"              28 chars  167.0px  0.520 em   one line
 *
 * A name full of M and W runs a quarter wider per character than one without, so "Weaam…" at
 * exactly 29 characters overflowed a 29-character column and took the Upper Egypt pack's fourth
 * page 52px past its footer — while a LONGER name on that same page fitted. 0.5 em missed it by a
 * page, 0.6 em by a row; 0.66 covers the widest observed.
 *
 * Over-estimating costs at most a row on a page. Under-estimating deletes rows from the file with
 * nothing on the page to say so, which is why this errs high deliberately.
 */
const CHAR_PX = 7.57;
const CHART_MARGIN_PX = 15.7; // .chart's own margin-top
const CHART_CAP_PX = 26.0; // the note under a chart that plots fewer than the table holds
/**
 * One wrapped line held back. A percentage would not help: the way this estimate goes wrong is one
 * cell wrapping a line more than predicted, which costs exactly EXTRA_LINE_PX, so that is what is
 * reserved. It costs a row on a page only where the fit was that tight anyway.
 */
const HEADROOM_PX = EXTRA_LINE_PX;

/** Characters one line of a column holds, from the same weights `colgroup` lays the columns out on. */
function columnChars(section: PackSection): number[] {
  const weights = section.align.map((a) => (a === "left" ? 2.4 : 1));
  const total = weights.reduce((sum, w) => sum + w, 0);
  return weights.map((w) => Math.max(((w / total) * CONTENT_PX - CELL_PAD_PX) / CHAR_PX, 4));
}

function rowHeightPx(row: readonly PackCell[], chars: readonly number[]): number {
  let lines = 1;
  row.forEach((cell, i) => {
    const fits = chars[i] ?? chars[chars.length - 1] ?? 10;
    const n = Math.ceil(cellText(cell).length / fits);
    if (n > lines) lines = n;
  });
  return ROW_PX + (lines - 1) * EXTRA_LINE_PX;
}

function headerHeightPx(section: PackSection, chars: readonly number[]): number {
  let lines = 1;
  section.columns.forEach((label, i) => {
    // The header is tracked caps at 6.6pt — narrower per glyph than a body cell, hence the factor.
    const n = Math.ceil((label.length * 0.86) / (chars[i] ?? 10));
    if (n > lines) lines = n;
  });
  return HEADER_PX + (lines - 1) * HEADER_LINE_PX;
}

function chartHeightPx(chart: PackChart): number {
  const top = chart.reference ? 16 : 4;
  const svg = ((top + chart.items.length * 23 + 4) / 1000) * CONTENT_PX;
  return CHART_MARGIN_PX + svg + (chart.capNote ? CHART_CAP_PX : 0);
}

/**
 * Split a section's rows into pages, each filled to the height it actually has.
 *
 * `firstBudget` is what the first page has left over after whatever shares it — a chart. A page
 * always takes at least one row, so a single freakishly tall row still renders rather than looping.
 */
function paginateByHeight(
  section: PackSection,
  rows: readonly PackCell[][],
  firstBudget: number,
  budget: number,
): PackCell[][][] {
  if (rows.length === 0) return [[]];
  const chars = columnChars(section);
  const out: PackCell[][][] = [];
  let page: PackCell[][] = [];
  let used = 0;
  let cap = firstBudget;
  for (const row of rows) {
    const h = rowHeightPx(row, chars);
    if (page.length > 0 && used + h > cap) {
      out.push(page);
      page = [];
      used = 0;
      cap = budget;
    }
    page.push(row);
    used += h;
  }
  if (page.length > 0) out.push(page);
  return out;
}

// ── The marks, read once and inlined as base64 data URIs (one image object, every page) ─────────
const markCache = new Map<string, string>();
function houseMark(onDark: boolean): string {
  const file = onDark ? "sato-pharma-logo.svg" : "sato-pharma-logo-on-light.svg";
  const cached = markCache.get(file);
  if (cached !== undefined) return cached;
  let html = "";
  try {
    const svg = readFileSync(join(process.cwd(), "public", "brand", file), "utf8");
    html = `<img alt="Sato Pharma" src="data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}">`;
  } catch {
    // A document must never lose whose it is: the wordmark as type when the file will not load.
    html = `<span class="markfallback">SATO PHARMA</span>`;
  }
  markCache.set(file, html);
  return html;
}

const arabicCache = { html: undefined as string | undefined };
function arabicMark(): string {
  if (arabicCache.html === undefined) {
    try {
      const png = readFileSync(join(process.cwd(), "public", "brand", "sato-pharma-arabic-on-light.png"));
      arabicCache.html = `<img alt="" src="data:image/png;base64,${png.toString("base64")}">`;
    } catch {
      arabicCache.html = "";
    }
  }
  return arabicCache.html;
}

// Amiri Quran (SIL OFL 1.1) embedded as a data URI. Every brick name and most customer names are
// Arabic, and no Chromium this runs on installs an Arabic face by default — the production image ships
// `font-noto` only and CI ships none — so without an embedded face the names render as tofu or in a
// non-joining fallback. Embedding it the way the award cheque does makes the shaping deterministic
// everywhere. The serif naskh also sits right beside the Latin Noto Serif figures.
const fontCache = { uri: undefined as string | undefined };
function amiriFace(): string {
  if (fontCache.uri === undefined) {
    try {
      const ttf = readFileSync(join(process.cwd(), "public", "fonts", "amiri-quran-regular.ttf"));
      fontCache.uri = `data:font/ttf;base64,${ttf.toString("base64")}`;
    } catch {
      fontCache.uri = "";
    }
  }
  return fontCache.uri;
}

/** The bracket corner — two strokes meeting at a right angle. The Spotlight sheet's corner. */
const BRACKET_SVG = `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <polyline points="0,40 0,0 40,0" fill="none" stroke="${C.ink}" stroke-width="3.2"/>
  <polyline points="7.5,40 7.5,7.5 40,7.5" fill="none" stroke="${C.light}" stroke-width="1"/>
</svg>`;

// ── Formatting ──────────────────────────────────────────────────────────────────────────────────
const cellText = (value: PackCell): string =>
  value == null ? "—" : typeof value === "number" ? value.toLocaleString("en-US") : String(value);

/**
 * A cell, with a leaver's "(left …)" mark set in red — the owner's instruction, 2026-09-28.
 *
 * The NAME keeps the table's own ink; only the mark is coloured, so a reader's eye lands on the
 * fact that the person has gone without the row shouting. Text colour only — no fill, so the house
 * INK RULE is untouched.
 */
function cellHtml(value: PackCell): string {
  const text = cellText(value);
  const parts = splitLeaverLabel(text);
  if (!parts) return escapeHtml(text);
  return `${escapeHtml(parts.name)}<span class="left">${escapeHtml(parts.mark)}</span>`;
}

/** Column widths as percentages — names get the room, figures do not. Matches the deck's rule. */
function colgroup(section: PackSection): string {
  const weights = section.align.map((a) => (a === "left" ? 2.4 : 1));
  const total = weights.reduce((sum, w) => sum + w, 0);
  return `<colgroup>${weights.map((w) => `<col style="width:${((w / total) * 100).toFixed(3)}%">`).join("")}</colgroup>`;
}

function sectionTable(section: PackSection, rows: readonly PackCell[][]): string {
  const head =
    `<thead><tr>` +
    section.columns
      .map((label, i) => `<th class="${section.align[i] === "right" ? "r" : "l"}" dir="auto">${escapeHtml(label)}</th>`)
      .join("") +
    `</tr></thead>`;
  const body =
    `<tbody>` +
    rows
      .map((row, r) => {
        const cells = section.columns
          .map((_, i) => {
            const align = section.align[i] === "right" ? "r" : "l";
            const cls = `${align}${section.align[i] === "right" ? " fig" : ""}`;
            // `dir="auto"` so an Arabic name gets RTL bidi ordering while a figure or a Latin name
            // stays LTR — the alignment class still fixes which edge the column sits against.
            return `<td class="${cls}" dir="auto">${cellHtml(row[i] ?? null)}</td>`;
          })
          .join("");
        return `<tr class="${r % 2 === 1 ? "zebra" : ""}">${cells}</tr>`;
      })
      .join("") +
    `</tbody>`;
  return `<table>${colgroup(section)}${head}${body}</table>`;
}

/** The eyebrow-over-a-rule that opens every page — the Spotlight sheet's one piece of punctuation. */
function opener(text: string): string {
  return `<p class="eyebrow">${escapeHtml(text)}</p><div class="tick"></div>`;
}

function pageShell(pack: SalesReviewPack, body: string, page: number, total: number, last: boolean): string {
  return `<div class="sheet${last ? "" : " sheet--break"}">
    <header class="crest"><div class="crest__mark">${houseMark(true)}</div></header>
    <div class="crest__rule"></div>
    <div class="page">
      <div class="field"></div>
      <div class="bracket bracket--tl">${BRACKET_SVG}</div>
      <div class="bracket bracket--tr">${BRACKET_SVG}</div>
      <div class="bracket bracket--bl">${BRACKET_SVG}</div>
      <div class="bracket bracket--br">${BRACKET_SVG}</div>
      <div class="inner">
        ${body}
        <footer class="foot">
          <div class="foot__block foot__block--mark">${arabicMark()}</div>
          <div class="foot__block foot__block--no"><p class="foot__cap">Sheet</p><p class="foot__no">${page}<span>of ${total}</span></p></div>
          <div class="foot__block foot__block--rec"><p class="foot__cap">Record</p><p class="foot__line"><strong>SATO-DIS-2026-01 v1.0</strong></p></div>
        </footer>
      </div>
    </div>
    <div class="plinth"><span>Sato Pharma &middot; Sales Review &middot; ${escapeHtml(pack.subject.windowLabel)}</span></div>
  </div>`;
}

function coverBody(pack: SalesReviewPack, generated: string): string {
  const index =
    pack.sections.length > 0
      ? `<ol class="index">${pack.sections
          .map(
            (s, i) =>
              `<li><span class="index__n">${String(i + 1).padStart(2, "0")}</span><span class="index__t">${escapeHtml(s.title)}</span></li>`,
          )
          .join("")}</ol>`
      : `<p class="lede">No metrics were chosen, so this pack has no sections. Tick what you want on the Business Review page and export again.</p>`;

  return `<div class="cover">
      <div class="cover__main">
        ${opener("Sales Review")}
        <h1 class="title">${escapeHtml(pack.subject.title)}</h1>
        <div class="ruleunder"></div>
        <p class="window">${escapeHtml(pack.subject.windowLabel)}</p>
        <p class="lede">${escapeHtml(pack.coverageNote)}</p>
        <p class="meta">Generated ${escapeHtml(generated)}. &middot; Review, not a payout record.</p>
      </div>
      <div class="cover__index">
        <p class="eyebrow eyebrow--left">In this pack</p>
        <div class="tick tick--left"></div>
        ${index}
      </div>
    </div>`;
}

/** A bar's own figure, in the unit the model gave it. Formatting only — nothing is computed here. */
function chartValueLabel(chart: PackChart, value: number): string {
  if (chart.unit !== "count") return `${value.toFixed(1)}%`;
  const n = new Intl.NumberFormat("en-US").format(Math.round(value));
  return chart.countSuffix ? `${n} ${chart.countSuffix}` : n;
}

/**
 * A section's chart, as inline SVG.
 *
 * 🔴 VECTOR, NEVER A RASTER. Chromium turns a canvas or an image into a page-sized layer per page —
 * the discipline the Spotlight sheet records at length and this file's header repeats. An SVG stays
 * a handful of paths, prints at the printer's own resolution, and costs nothing per page.
 *
 * It DRAWS what the model handed it and computes no figure: every bar is a value the section's table
 * also prints, so a reader cannot find a bar that disagrees with its own row.
 *
 * `targetPx` is the printed height the page has room for. The SVG scales to the width of its
 * container, so its printed HEIGHT follows from its aspect ratio alone: a narrower viewBox over the
 * same rows prints taller and larger. That is the one lever, and it is what stops a chart being a
 * strip of bars above half a page of white — on its own page, or above a short table.
 */
function chartSvg(chart: PackChart, targetPx = 0): string {
  const items = chart.items;
  const ROW = 23;
  const BAR = 11;
  const TOP = chart.reference ? 16 : 4;
  const H = TOP + items.length * ROW + 4;
  // Printed height is H/W × the content width, so the viewBox width is what sets it. Clamped at 620
  // so a three-bar chart cannot blow its own type up past the section title above it, and at 1000 so
  // it never prints smaller than its natural size.
  const W = targetPx > 0 ? Math.min(Math.max((H * CONTENT_PX) / targetPx, 620), 1000) : 1000;

  /**
   * 🔴 The label column is sized to the LONGEST label, never to a fixed fraction.
   *
   * A label is anchored at the column's right edge and runs leftward, so one too long for the
   * column does not wrap or ellipsise — it runs off the left of the viewBox and is CLIPPED, silently.
   * That is how "Hassan Mohamed Raffat Mohamed Elsherbiny" first printed as "hamed Raffat Mohamed
   * Elsherbiny" on the rep chart, breaking the owner's no-truncation rule with no sign on the page.
   * So: take the room the longest name needs, up to 42% of the chart, and below that shrink the type
   * until it fits rather than cut a single character off anybody's name.
   */
  const LABEL_FS = 11.5;
  const NOTE_FS = 8.4;
  // 0.62 em per glyph. MEASURED in Chromium across this pack's own names, where the real advance
  // ranged 0.496 to 0.598 — the first cut of this used 0.5, the average, and three rep names still
  // ran off the left edge. It is the WORST case that has to fit, so the estimate sits above it.
  const GLYPH = 0.62;
  const longestLabel = Math.max(...items.map((item) => item.label.length), 1);
  const longestNote = Math.max(...items.map((item) => (item.note ?? "").length), 0);
  const needed = Math.max(longestLabel * LABEL_FS, longestNote * NOTE_FS) * GLYPH;
  const LABEL_W = Math.max(Math.min(needed, W * 0.46), W * 0.286);
  const labelFs = needed > LABEL_W ? LABEL_FS * (LABEL_W / needed) : LABEL_FS;
  const noteFs = NOTE_FS * (labelFs / LABEL_FS);
  // A counted figure carries thousands separators and a unit ("1,204,880 EGP"), so it needs a wider
  // gutter than "84.2%" — without it the figure would run back over its own bar.
  const VALUE_W = W * (chart.unit === "count" ? 0.2 : 0.104);
  const PLOT_X = LABEL_W + W * 0.014;
  const PLOT_W = W - PLOT_X - VALUE_W;

  // Percentages are read against 100 even when nobody reached it — a chart that rescales to the best
  // performer flatters a bad month. A share chart scales to its own largest slice.
  const values = items.map((item) => (item.value == null ? 0 : item.value));
  const max = Math.max(chart.unit === "pct" ? 100 : 0, ...values, 1);
  const at = (value: number) => PLOT_X + (PLOT_W * Math.max(0, Math.min(value, max))) / max;

  const parts: string[] = [];
  if (chart.reference) {
    const x = at(chart.reference.value);
    parts.push(
      `<line x1="${x.toFixed(1)}" y1="${TOP - 10}" x2="${x.toFixed(1)}" y2="${H - 4}" stroke="${C.ink}" stroke-width="1.1" stroke-dasharray="3 3"/>`,
      `<text x="${(x + 4).toFixed(1)}" y="${TOP - 4}" font-size="10.5" font-weight="700" fill="${C.ink}">${escapeHtml(chart.reference.label)}</text>`,
    );
  }
  items.forEach((item, i) => {
    const y = TOP + i * ROW;
    const mid = y + ROW / 2;
    parts.push(
      `<text x="${LABEL_W.toFixed(1)}" y="${(mid + 4).toFixed(1)}" text-anchor="end" font-size="${labelFs.toFixed(2)}" fill="${C.ink}">${escapeHtml(item.label)}</text>`,
      `<rect x="${PLOT_X.toFixed(1)}" y="${(mid - BAR / 2).toFixed(1)}" width="${PLOT_W.toFixed(1)}" height="${BAR}" fill="${C.wash}"/>`,
    );
    if (item.value == null) {
      parts.push(
        `<text x="${(PLOT_X + 6).toFixed(1)}" y="${(mid + 4).toFixed(1)}" font-size="10.5" font-style="italic" fill="${C.muted}">not gradeable</text>`,
      );
      return;
    }
    // Below the earner mark the bar goes pale: short is legible at a glance, without a second legend.
    const short = chart.reference != null && item.value < chart.reference.value;
    const width = Math.max(at(item.value) - PLOT_X, 0.8);
    parts.push(
      `<rect x="${PLOT_X.toFixed(1)}" y="${(mid - BAR / 2).toFixed(1)}" width="${width.toFixed(1)}" height="${BAR}" fill="${short ? C.hair : C.light}"/>`,
      // Anchored 2 units inside the edge: a glyph's own right bearing would otherwise sit exactly on
      // the viewBox boundary, which is where a renderer is free to shave it.
      `<text x="${(W - 2).toFixed(1)}" y="${(mid + 4).toFixed(1)}" text-anchor="end" font-size="11.5" font-weight="700" fill="${C.ink}">${escapeHtml(chartValueLabel(chart, item.value))}</text>`,
    );
    if (item.note) {
      parts.push(
        `<text x="${LABEL_W.toFixed(1)}" y="${(mid + 14).toFixed(1)}" text-anchor="end" font-size="${noteFs.toFixed(2)}" fill="${C.muted}">${escapeHtml(item.note)}</text>`,
      );
    }
  });

  return `<div class="chart">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMin meet" role="img">${parts.join("")}</svg>
    ${chart.capNote ? `<p class="chart__cap">${escapeHtml(chart.capNote)}</p>` : ""}
  </div>`;
}

function sectionBody(
  section: PackSection,
  index: number,
  total: number,
  rows: readonly PackCell[][],
  part: number,
  parts: number,
  offset: number,
  cut: number,
  chart: PackChart | null,
  chartTargetPx = 0,
): string {
  const eyebrow = `Section ${String(index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}${parts > 1 ? ` · ${part} of ${parts}` : ""}`;
  const note =
    part === 1
      ? `<p class="note">${escapeHtml(section.note)}</p>`
      : `<p class="note">Continued — rows ${offset + 1}–${offset + rows.length}.</p>`;
  return `
    ${opener(eyebrow)}
    <h2 class="sectitle">${escapeHtml(section.title)}${part > 1 ? ` <span class="cont">continued</span>` : ""}</h2>
    <div class="ruleunder ruleunder--short"></div>
    ${note}
    ${chart ? chartSvg(chart, chartTargetPx) : ""}
    ${rows.length > 0 ? `<section class="tbl">${sectionTable(section, rows)}</section>` : ""}
    ${
      cut > 0
        ? `<p class="cut">${cut} more row${cut === 1 ? "" : "s"} are in the Excel version of this pack — a page is a presentation, not the whole dataset.</p>`
        : ""
    }
    <div class="gap"></div>`;
}

const CSS = `
  @page { size: A4 landscape; margin: 0; }
  :root {
    --deep:${C.deep}; --blue:${C.blue}; --light:${C.light}; --tint:${C.tint}; --hair:${C.hair};
    --muted:${C.muted}; --body:${C.body}; --crest:${C.crest}; --ink:${C.ink}; --wash:${C.wash}; --rule:${C.rule};
    --danger:${C.danger};
    /* Arabic falls to Amiri Quran (embedded) then Noto Naskh, so a brick or customer name shapes and
       joins on any Chromium — a Latin face earlier in each list has no Arabic glyphs, so per-glyph
       fallback reaches the Arabic face for exactly the characters that need it. */
    --display:"Noto Serif","Times New Roman",Georgia,"Amiri Quran","Noto Naskh Arabic",serif;
    --text:"Noto Sans","Segoe UI",Calibri,Helvetica,Arial,"Amiri Quran","Noto Naskh Arabic",Tahoma,sans-serif;
    --arabic:"Amiri Quran","Noto Naskh Arabic","Noto Sans Arabic","Segoe UI",Tahoma,Arial,sans-serif;
    --hair-w:0.5pt; --u:3.2mm;
  }
  * { box-sizing:border-box; margin:0; padding:0; border-radius:0; }
  body { font-family:var(--text); color:var(--body); background:#FFF;
    -webkit-print-color-adjust:exact; print-color-adjust:exact; font-kerning:normal; }

  .sheet { position:relative; width:297mm; height:210mm; overflow:hidden; display:flex; flex-direction:column; }
  .sheet--break { page-break-after:always; break-after:page; }

  /* crest band */
  .crest { flex:0 0 auto; height:16mm; background:var(--crest); display:flex; align-items:center; justify-content:center; }
  .crest__mark { width:30mm; }
  .crest__mark img { display:block; width:100%; height:auto; }
  .markfallback { color:#FFF; font-weight:800; letter-spacing:.18em; font-size:12pt; }
  .crest__rule { flex:0 0 auto; height:1.3mm; background:var(--light); border-bottom:.4mm solid var(--deep); }

  /* bracketed field */
  .page { position:relative; flex:1 1 auto; min-height:0; padding:7mm 15mm 8mm; }
  .field { position:absolute; inset:4mm 9mm; border:var(--hair-w) solid var(--hair); }
  .field::after { content:""; position:absolute; inset:1.5mm; border:var(--hair-w) solid var(--light); }
  .bracket { position:absolute; width:7mm; height:7mm; }
  .bracket svg { display:block; width:100%; height:100%; }
  .bracket--tl { top:4mm; left:9mm; }
  .bracket--tr { top:4mm; right:9mm; transform:scaleX(-1); }
  .bracket--bl { bottom:4mm; left:9mm; transform:scaleY(-1); }
  .bracket--br { bottom:4mm; right:9mm; transform:scale(-1,-1); }
  .inner { position:relative; height:100%; display:flex; flex-direction:column; }
  .inner > *:not(.gap):not(.tbl):not(.cover) { flex:0 0 auto; }
  .gap { flex:1 1 0; min-height:0; }

  /* plinth */
  .plinth { flex:0 0 auto; height:6mm; background:var(--crest); color:#FFF; display:flex; align-items:center; justify-content:center; }
  .plinth span { font-size:5.8pt; font-weight:600; letter-spacing:.3em; text-transform:uppercase; }

  /* openers */
  .eyebrow { text-align:center; font-size:7.4pt; font-weight:700; letter-spacing:.42em; text-transform:uppercase; color:var(--blue); }
  .eyebrow--left { text-align:left; }
  .tick { width:15mm; height:1.5pt; background:var(--ink); margin:calc(var(--u)*.7) auto 0; }
  .tick--left { margin-left:0; margin-right:0; }

  /* cover */
  .cover { flex:1 1 auto; min-height:0; overflow:hidden; display:flex; gap:12mm; }
  .cover__main { flex:1 1 56%; display:flex; flex-direction:column; min-width:0; }
  .cover__main .eyebrow { text-align:left; }
  .cover__main .tick { margin-left:0; }
  .cover__index { flex:1 1 44%; border-left:var(--hair-w) solid var(--hair); padding-left:11mm; min-width:0;
    display:flex; flex-direction:column; }
  .title { margin-top:calc(var(--u)*1.4); font-family:var(--display); font-weight:700; font-size:31pt;
    line-height:1.1; color:var(--ink); letter-spacing:-.008em; }
  .ruleunder { width:120mm; max-width:100%; height:1.1pt; background:var(--ink); margin-top:calc(var(--u)*.9); }
  .ruleunder--short { width:60mm; }
  .window { margin-top:calc(var(--u)*.9); font-family:var(--display); font-weight:700; font-size:14pt; color:var(--light);
    letter-spacing:.01em; }
  .lede { margin-top:calc(var(--u)*1); max-width:150mm; font-size:8.6pt; line-height:1.6; color:var(--muted); }
  .meta { margin-top:auto; font-size:7.4pt; font-style:italic; color:var(--muted); letter-spacing:.02em; }

  .index { list-style:none; margin-top:calc(var(--u)*.9); columns:2; column-gap:9mm; }
  .index li { display:flex; align-items:baseline; gap:4mm; padding:calc(var(--u)*.48) 0;
    border-bottom:var(--hair-w) solid var(--rule); break-inside:avoid; -webkit-column-break-inside:avoid; }
  .index__n { font-family:var(--display); font-weight:700; font-size:8.6pt; color:var(--light);
    font-variant-numeric:tabular-nums; min-width:7mm; }
  .index__t { font-size:8pt; color:var(--ink); line-height:1.3; }

  /* section head */
  .sectitle { margin-top:calc(var(--u)*1); font-family:var(--display); font-weight:700; font-size:20pt;
    line-height:1.1; color:var(--ink); letter-spacing:-.006em; }
  .sectitle .cont { font-family:var(--text); font-weight:700; font-size:8pt; letter-spacing:.22em;
    text-transform:uppercase; color:var(--muted); vertical-align:middle; margin-left:3mm; }
  .note { margin-top:calc(var(--u)*.7); max-width:240mm; font-size:7.8pt; font-style:italic; color:var(--muted); line-height:1.5; }
  .cut { margin-top:calc(var(--u)*.6); font-size:7.2pt; font-style:italic; color:var(--muted); }
  /* A leaver's mark. The one red in the document, and text only — never a fill. */
  .left { color:var(--danger); font-weight:700; white-space:nowrap; }

  /* the chart — vector, flat, no rounding and no shadow, like everything else on the sheet */
  .chart { margin-top:calc(var(--u)*1.3); }
  .chart svg { display:block; width:100%; height:auto; }
  .chart__cap { margin-top:calc(var(--u)*.55); font-size:7.2pt; font-style:italic; color:var(--muted); }

  /* the table — the Spotlight leaderboard's voice */
  .tbl { margin-top:calc(var(--u)*1.1); }
  table { width:100%; table-layout:fixed; border-collapse:collapse; }
  thead th { padding:0 2.2mm calc(var(--u)*.6); font-size:6.6pt; font-weight:700; letter-spacing:.2em;
    text-transform:uppercase; color:var(--blue); border-bottom:1.2pt solid var(--ink); vertical-align:bottom; }
  thead th.l { text-align:left; }
  thead th.r { text-align:right; }
  td { padding:1.9mm 2.2mm; font-size:8.6pt; color:var(--body); vertical-align:baseline;
    border-bottom:var(--hair-w) solid var(--rule); overflow-wrap:anywhere; }
  /* A name column wraps on WORD boundaries, never anywhere — Arabic joins cursively and a break
     between two letters splits a word into disconnected forms, so an Arabic name must break only at
     its spaces. */
  td.l { text-align:left; overflow-wrap:break-word; word-break:normal; }
  td.l:first-child { color:var(--ink); font-weight:600; }
  td.r { text-align:right; }
  /* Figures in the serif display, tabular — the Spotlight leaderboard's own voice for a number. */
  td.fig { font-family:var(--display); font-variant-numeric:lining-nums tabular-nums; color:var(--ink);
    font-weight:700; font-size:9.2pt; letter-spacing:-.004em; }
  /* The house 6% zebra — locked at this tint, and nothing else filled. */
  tr.zebra td { background:var(--tint); }
  tbody tr:last-child td { border-bottom:1.2pt solid var(--ink); }

  /* record foot */
  .foot { margin-top:auto; padding-top:calc(var(--u)*.5); display:flex; align-items:flex-start; gap:8mm; }
  .foot__block { padding-top:calc(var(--u)*.55); border-top:var(--hair-w) solid var(--hair); }
  .foot__block--mark { flex:1 1 0; }
  .foot__block--mark img { display:block; height:10mm; width:auto; }
  .foot__block--no { flex:0 0 20mm; text-align:center; }
  .foot__block--rec { flex:1 1 0; text-align:right; }
  .foot__cap { font-size:5.6pt; font-weight:700; letter-spacing:.3em; text-transform:uppercase; color:var(--muted); }
  .foot__line { margin-top:calc(var(--u)*.32); font-size:6.8pt; color:var(--body); }
  .foot__line strong { color:var(--ink); font-weight:700; }
  .foot__no { margin-top:calc(var(--u)*.28); font-family:var(--display); font-size:11pt; font-weight:700; color:var(--ink); line-height:1.1; }
  .foot__no span { display:block; font-size:5.8pt; font-weight:600; color:var(--muted); letter-spacing:.14em; text-transform:uppercase; }
`;

/** The whole document as HTML. Exported so a test can assert on the markup without Chromium. */
export function packDocumentHtml(pack: SalesReviewPack): string {
  const generated =
    new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Africa/Cairo",
    }).format(new Date(pack.generatedAt)) + " Cairo";

  // Build every page's body first, so each sheet's footer can name the true total. Sections whose
  // shown rows exceed one page's worth continue onto the next sheet rather than clip under the plinth.
  const bodies: string[] = [coverBody(pack, generated)];
  pack.sections.forEach((section, i) => {
    const shown = section.rows.slice(0, ROW_CAP);
    const cut = section.rows.length - shown.length;
    const chart = section.chart ?? null;
    // What a page of this section's table has: its own box, less its header, less the cut note if
    // the section is capped at all (reserved on every page rather than only the last — a page that
    // has to shed one row is cheaper than a note printed over the plinth).
    const budget =
      TABLE_BOX_PX - headerHeightPx(section, columnChars(section)) - (cut > 0 ? CUT_NOTE_PX : 0) - HEADROOM_PX;
    // A short chart rides on the section's first page and simply costs it rows. A tall one takes a
    // page of its own: sharing would either shrink the bars past reading size or push the last rows
    // under the plinth, which is the exact failure the budget above exists to prevent.
    const chartPx = chart ? chartHeightPx(chart) : 0;
    const inline = chart != null && chartPx <= budget * 0.45;
    const ownPage = chart != null && !inline ? 1 : 0;
    const tableParts = paginateByHeight(section, shown, inline ? budget - chartPx : budget, budget);
    const parts = tableParts.length + ownPage;
    // Then give the chart whatever that page has LEFT. On its own page that is the whole budget; on
    // a page it shares, only what a table ending early leaves behind — and nothing at all when the
    // rows already run on, where growing it would push them off the page it was just fitted to.
    const chars = columnChars(section);
    const firstPageRows = (tableParts[0] ?? []).reduce((sum, row) => sum + rowHeightPx(row, chars), 0);
    const chartTargetPx =
      ownPage === 1
        ? budget
        : tableParts.length === 1
          ? Math.max(budget - firstPageRows - CHART_MARGIN_PX, chartPx)
          : 0;
    if (ownPage && chart) {
      bodies.push(sectionBody(section, i, pack.sections.length, [], 1, parts, 0, 0, chart, chartTargetPx));
    }
    let offset = 0;
    tableParts.forEach((rows, ci) => {
      const isLast = ci === tableParts.length - 1;
      bodies.push(
        sectionBody(
          section,
          i,
          pack.sections.length,
          rows,
          ci + 1 + ownPage,
          parts,
          offset,
          isLast ? cut : 0,
          ci === 0 && inline ? chart : null,
          chartTargetPx,
        ),
      );
      offset += rows.length;
    });
  });

  const total = bodies.length;
  const pages = bodies.map((body, i) => pageShell(pack, body, i + 1, total, i === total - 1));

  // The embedded Arabic face is injected before the static CSS so the @font-face lands once, lazily —
  // the font is read from disk the first time a pack is built, not at module import.
  const fontFace = `@font-face{font-family:"Amiri Quran";font-weight:400;font-style:normal;src:url("${amiriFace()}") format("truetype");}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Sales Review — ${escapeHtml(pack.subject.title)}</title><style>${fontFace}${CSS}</style></head>
<body>${pages.join("\n")}</body></html>`;
}

export async function renderPackPdf(pack: SalesReviewPack): Promise<Buffer> {
  const html = packDocumentHtml(pack);
  const bytes = await withChromiumPage(async (page) => {
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.emulateMediaType("print");
    // The embedded Amiri face decodes asynchronously; printing before it is ready falls the Arabic
    // back to a non-joining system font for the first render. Wait for it — as a STRING, which is the
    // evaluate signature this page type takes (see award-cheque.ts).
    await page.evaluate("document.fonts.ready.then(() => document.fonts.size)");
    return page.pdf({
      format: "A4",
      landscape: true,
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });
  });
  return Buffer.from(bytes);
}
