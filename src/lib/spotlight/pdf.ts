// Spotlight — the sheet.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE DESIGN IS THE ONE THE OWNER APPROVED, on 2026-09-10, after rejecting three others. Its rules,
// in the order he settled them:
//
//   · THE ENGRAVED SHEET. A rule trio frame with lathe-cut corners, braided bands under the
//     masthead and above the footer, a rule PAIR (heavy over hairline, letterpress fashion) above
//     and below the figure. He rejected a modern dark layout outright and asked to come back here.
//
//   · NO DEVICES INSIDE THE FRAME. A guilloche lozenge and then a laurel wreath both went in and
//     both came out — "what are those shapes". The number sits in open space. Do not put anything
//     behind it, around it, or under it except the rules and the gauge.
//
//   · COLOUR MEANS SOMETHING. Green is at-or-above target, red is below, and nothing else on the
//     page may be either colour. That is the whole licence: the moment green also means "nice", it
//     stops meaning anything. Both are muted so they sit with the logo blues.
//
// Everything else follows the house identity SATO-DIS-2026-01 v1.0 — the logo-sampled palette,
// square edges everywhere, the on-light mark, and the 0.5 pt hairline floor.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 2026-09-12 — "very weak exported pdf premium polish". Four things were making a correct sheet
// look unfinished, and each is fixed here rather than decorated over:
//
//   1. THE PAGE DID NOT FILL. Both sheets ended a third of the way up from the footer and left a
//      dead band of white — the hero between its territory and its figure, the leaderboard under
//      the last row. Nothing was wrong with either; the space was simply never distributed. The
//      column now carries explicit FLEXIBLE GAPS (`.gap`) that share what is left over, and the
//      leaderboard sizes its own row height to the page it is on. A sheet that fills is the single
//      biggest difference between "a printout" and "a document".
//
//   2. A LONG LIST WAS SILENTLY CUT. `.sheet` clips at A4 and the table never paginated, so a
//      40-name leaderboard printed 18 names, no footer, and a row sliced through the middle — with
//      no error anywhere. The limit reaches into the hundreds and "everyone" is a real answer, so
//      this was a loaded gun. The leaderboard now PAGINATES, every page carries the frame and the
//      footer, and the footer numbers the sheets.
//
//   3. THE ORNAMENT WAS TOO FINE TO READ. The braid ran 29 periods through 1.8 mm of height, which
//      at print size is a dotted line, and the corner bosses were 8.6 mm of nested circles. Both
//      are drawn heavier and coarser now — the weave is legible as a weave.
//
//   4. GREEN HAD STOPPED MEANING ANYTHING on the leaderboard. Seven of ten rows were filled with
//      green tint, so the page read as a spreadsheet with conditional formatting and the eye had
//      nowhere to land. The house ink rule allows the 6% zebra and nothing else, so the fill is
//      back to the plain zebra and the KEY moved to a rule: a 1.3 pt green or red edge on the rank
//      cell, beside the arrow and the figure that were always coloured. The meaning survives; the
//      block of colour does not.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { escapeHtml } from "@/lib/hiring-pack/render-shared";
import { withChromiumPage } from "@/lib/pdf/chromium";

import type { SpotlightResult, SpotlightRow } from "./types";

// ── Palette ───────────────────────────────────────────────────────────────────────────────────
const C = {
  deep: "#0A527D",
  blue: "#0A6BA6",
  light: "#1482C2",
  tint: "#F3F7FA",
  hair: "#B9C7D4",
  muted: "#5A6B7C",
  body: "#1A1A1A",
  green: "#0F7A47",
  // NO GREEN TINT. There was one, and it filled every over-target row — which is how green stopped
  // meaning "at or above target" and started meaning "this row is nice". It is not coming back: the
  // key is a rule on the rank cell, and the only fill the house identity allows is the 6% zebra.
  red: "#B4231C",
} as const;

const HAIR = "0.5pt";

// ── The mark ──────────────────────────────────────────────────────────────────────────────────
// Read once and inlined. `setContent` gives Chromium no base URL, so an `<img src="/brand/…">`
// would silently render nothing — the failure mode is a letterhead with a hole in it, which no
// error reports. The ON-LIGHT file, always: the stock mark sets "SATO" in white for dark grounds
// and this sheet is white paper, so the stock file would print a letterhead reading "PHARMA".
let markCache: string | null = null;
function houseMark(): string {
  if (markCache === null) {
    const svg = readFileSync(join(process.cwd(), "public", "brand", "sato-pharma-logo-on-light.svg"), "utf8");
    // 🔴 AN <img> WITH A BASE64 DATA URI, NOT INLINE MARKUP. Inlining the SVG puts the mark's paths
    // into the PDF once PER PAGE: measured on a 6-page sheet at 6.88 MB, and 34.69 MB at 31 pages,
    // which is ~1.15 MB a page of nothing but a repeated logo. As an image resource Chromium
    // embeds it once and every page references the same object. Base64 rather than percent-encoding
    // because the encoded form is going inside an attribute, and a raw SVG's own quotes would end
    // that attribute early — the defect that has blanked bands and a footer in this repository.
    markCache = `<img alt="" src="data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}">`;
  }
  return markCache;
}

// ── Ornament ──────────────────────────────────────────────────────────────────────────────────
/**
 * A guilloche strand is a rose curve, r(t) = R + amp·cos(lobes·t); copies rotated by a fraction of
 * ONE lobe cross into the woven chain that reads as engine turning. Rotating by a fraction of a
 * lobe rather than an arbitrary angle is the whole trick — anything else is overlapping scribble.
 *
 * Used for the corner bosses ONLY. It is not allowed anywhere near the number.
 */
function rosette(cx: number, cy: number, R: number, amp: number, lobes: number, strands: number, color: string, width: number): string {
  let out = "";
  for (let s = 0; s < strands; s += 1) {
    const phase = (s / strands) * ((2 * Math.PI) / lobes);
    const pts: string[] = [];
    for (let i = 0; i <= 120; i += 1) {
      const t = (i / 120) * 2 * Math.PI;
      const r = R + amp * Math.cos(lobes * (t + phase));
      pts.push(`${(cx + r * Math.cos(t)).toFixed(2)},${(cy + r * Math.sin(t)).toFixed(2)}`);
    }
    out += `<polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round"/>`;
  }
  return out;
}

/**
 * The corner boss. Drawn at 11 mm rather than the original 8.6: the rosette is the only piece of
 * engine turning left on the sheet, and at the smaller size its three strands collapsed into what
 * printed as a pair of concentric circles. The lobe count comes DOWN as the size goes up — a
 * bigger boss with more lobes is finer, not bolder, which is the opposite of what was wanted.
 */
const CORNER_SVG = `<svg viewBox="0 0 88 88" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M0,88 L0,30 Q0,0 30,0 L88,0" fill="none" stroke="${C.deep}" stroke-width="2.6"/>
  <path d="M10,88 L10,34 Q10,10 34,10 L88,10" fill="none" stroke="${C.hair}" stroke-width="1.1"/>
  ${rosette(31, 31, 15.5, 4.4, 9, 3, C.light, 1.05)}
  <circle cx="31" cy="31" r="3.4" fill="none" stroke="${C.deep}" stroke-width="1.3"/>
  <circle cx="31" cy="31" r="0.9" fill="${C.deep}"/>
</svg>`;

/**
 * The braided band: three sine passes a third of a wavelength apart.
 *
 * 🔴 DRAWN AS ONE INLINE SVG, NOT AS A TILED CSS BACKGROUND. This is the difference between a
 * 1.2 MB page and a 60 KB one. Chromium rasterises a repeating background — and every CSS gradient
 * — into its OWN PAGE-SIZED LAYER when printing: measured on a 6-page sheet, 36 images of
 * 595x842 at roughly half a megabyte each, 6.88 MB of a document whose text is a few kilobytes.
 * Nothing warns; the PDF simply arrives too big to send, which is where this was found.
 *
 * The whole strip is emitted as explicit polylines instead, so it stays vector. `preserveAspectRatio
 * ="none"` lets it stretch to whatever width it is given; the periods are computed for a 176 mm
 * measure, so the stretch is under 2% and invisible.
 *
 * THE WEAVE IS COARSE ON PURPOSE. It ran at 29 periods across that measure, which puts a whole
 * braid cycle inside 6 mm — printed, that is a dotted rule, not a braid. 18 periods over the same
 * measure gives each cycle just under 10 mm, which is where the eye resolves the crossing.
 */
function braidSvg(color: string, weight: number): string {
  const PERIOD = 72, H = 20, AMP = 6.8, MID = H / 2, STEPS = 24, PERIODS = 18;
  const W = PERIOD * PERIODS;
  const wave = (phase: number) => {
    const pts: string[] = [];
    for (let i = 0; i <= STEPS * PERIODS; i += 1) {
      const x = (i / STEPS) * PERIOD;
      pts.push(`${x.toFixed(1)},${(MID + AMP * Math.sin((2 * Math.PI * i) / STEPS + phase)).toFixed(2)}`);
    }
    return pts.join(" ");
  };
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">`
    + [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3]
      .map((phase) => `<polyline points="${wave(phase)}" fill="none" stroke="${color}" stroke-width="${weight}" stroke-linecap="round"/>`)
      .join("")
    + `</svg>`;
}

const BAND_SVG = braidSvg(C.deep, 2.6);
const BAND_LIGHT_SVG = braidSvg(C.hair, 2.2);

/** The rule-and-diamond flourish. One piece of markup, under every title block. */
const FLOURISH = `<div class="flourish"><i></i><s></s><b></b><s></s><i></i></div>`;

// ── Formatting ────────────────────────────────────────────────────────────────────────────────
const egp = (n: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(n));
const millions = (n: number) => (n / 1_000_000).toFixed(2);
const pct = (n: number | null) => (n === null ? "—" : n.toFixed(1));

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * The months a window actually covers, written out — "June · July · August 2026".
 *
 * It is on the hero sheet because "Q3 2026" is a label the reader has to decode, and the hero sheet
 * is the one that goes to the person it names. Purely a restatement of `result.periods`: no month
 * is named that the numbers were not taken from, and a window spanning two years prints both years
 * rather than quietly assuming one.
 */
function monthsLabel(periods: string[]): string {
  if (periods.length === 0) return "";
  const parts = periods.map((period) => {
    const [year, month] = period.split("-");
    const index = Number(month) - 1;
    return { year, name: MONTH_NAMES[index] ?? period };
  });
  const oneYear = parts.every((part) => part.year === parts[0].year);
  if (oneYear) return `${parts.map((part) => part.name).join(" · ")} ${parts[0].year}`;
  return parts.map((part) => `${part.name} ${part.year}`).join(" · ");
}

/** The gauge scale. 112 leaves an overshoot room to read AS an overshoot rather than as the end. */
const GAUGE_MAX = 112;

/**
 * A gauge for one achievement.
 *
 * Above 112% the bar is pinned full and the tick moves instead, so a 210% rep does not render a
 * bar eight times the width of the page. The number beside it is always the true one.
 */
function gauge(achievement: number | null, caption: string): string {
  if (achievement === null) {
    return `<div class="gauge"><p class="gauge__none">No target was set for this window, so there is no achievement to draw.</p></div>`;
  }
  const scale = Math.max(GAUGE_MAX, achievement * 1.06);
  const base = (Math.min(100, achievement) / scale) * 100;
  const over = achievement > 100 ? ((achievement - 100) / scale) * 100 : 0;
  const under = achievement < 100 ? ((100 - achievement) / scale) * 100 : 0;
  const tick = (100 / scale) * 100;

  return `<div class="gauge">
    ${caption ? `<p class="gauge__win ${achievement >= 100 ? "is-up" : "is-down"}"><i>${achievement >= 100 ? "&#9650;" : "&#9660;"}</i>${escapeHtml(caption)}</p>` : ""}
    <div class="gauge__track">
      <div class="gauge__base" style="width:${base.toFixed(3)}%"></div>
      ${over > 0 ? `<div class="gauge__over" style="left:${base.toFixed(3)}%;width:${over.toFixed(3)}%"></div>` : ""}
      ${under > 0 ? `<div class="gauge__under" style="left:${base.toFixed(3)}%;width:${under.toFixed(3)}%"></div>` : ""}
      <div class="gauge__tick" style="left:${tick.toFixed(3)}%"></div>
    </div>
    <div class="gauge__labels"><span class="gauge__t" style="left:${tick.toFixed(3)}%">Target 100%</span></div>
  </div>`;
}

// ── Chrome shared by every page ───────────────────────────────────────────────────────────────
/**
 * Every page is this: the frame, the four bosses, the masthead, a braid, the body, and a footer
 * that says where the numbers came from and which sheet of how many this is.
 *
 * THE SHEET NUMBER IS NOT DECORATION. These go out as a stapled pack — a leaderboard, then a hero
 * sheet per person — and until now nothing on a loose page said whether anything was missing.
 */
function pageShell(result: SpotlightResult, body: string, page: number, total: number): string {
  return `<div class="sheet${page === total ? "" : " sheet--break"}">
    <div class="frame"></div>
    <div class="corner corner--tl">${CORNER_SVG}</div>
    <div class="corner corner--tr">${CORNER_SVG}</div>
    <div class="corner corner--bl">${CORNER_SVG}</div>
    <div class="corner corner--br">${CORNER_SVG}</div>
    <div class="inner">
      <header class="lh">
        <div class="lh__mark">${houseMark()}</div>
        <div class="lh__id">
          <strong>SATO-DIS-2026-01 v1.0</strong>
          <em>Sales Performance Spotlight</em><br>
          ${escapeHtml(result.windowLabel)}<br>
          Issued ${escapeHtml(result.generatedAtCairo)} &middot; Africa/Cairo
        </div>
      </header>
      <div class="band">${BAND_SVG}</div>
      ${body}
      <footer class="foot">
        <div class="band band--foot">${BAND_LIGHT_SVG}</div>
        <div class="foot__txt">
          <span class="foot__src"><strong>Source.</strong> Monthly Closing &mdash; Sales vs Target, ${escapeHtml(result.periods.join(", "))}.<br>
            Indirect sales at factory price, direct orders on the Finance-owned sales month.</span>
          <span class="foot__no">Sheet ${page}<br><i>of ${total}</i></span>
          <span class="foot__house"><strong>Sato Pharma</strong><br>Phoenix Workforce &middot; Spotlight</span>
        </div>
      </footer>
    </div>
  </div>`;
}

// ── The leaderboard ───────────────────────────────────────────────────────────────────────────
/**
 * The pagination, in millimetres rather than in rows.
 *
 * A fixed rows-per-page number is wrong the moment one name wraps: sixteen ordinary rows fit a
 * continuation page and sixteen long ones overrun it by 37 mm, which does not error — it pushes the
 * footer off the bottom of the paper and cuts the last row in half. So a page is filled by ADDING
 * UP what its rows actually cost, and closed when the next row would not fit.
 */
const MIN_PAD_MM = 1.35;
const MAX_PAD_MM = 4.2;

/**
 * Vertical measure, in mm, a page has for rows once its head, note and footer are paid for, and
 * what one row costs before any padding is added to it.
 *
 * MEASURED, not estimated. The first try put 18 rows on a continuation page from an arithmetic that
 * assumed a 7 mm row; the territory cell is two lines, the real row is nearer 7.8 mm, and the sheet
 * overran by about 13 mm — which does not error, it pushes the footer off the bottom of the page.
 * Both numbers below are therefore set BELOW what fits, so that a long name wrapping to two lines
 * still has somewhere to go.
 */
const ROW_AREA_FIRST = 146;
const ROW_AREA_LATER = 178;
const ROW_CONTENT_MM = 7.8;

/**
 * What one row costs before padding — its own height in millimetres.
 *
 * The name column is about 70 mm of usable measure at 9.2 pt and the territory column about 40 mm
 * at 8 pt, so the character counts below are where each wraps. They are estimates and they are
 * deliberately PESSIMISTIC (a shorter line than the font really fits), because over-estimating a
 * row costs a little white space and under-estimating it walks a name off the page.
 */
function rowHeightMm(row: SpotlightRow): number {
  const nameChars = row.title.length + (row.isVacant ? 12 : 0);
  const nameLines = Math.max(1, Math.ceil(nameChars / 40));
  const whereLines = Math.max(1, Math.ceil(row.territory.length / 25));
  return ROW_CONTENT_MM + (nameLines - 1) * 3.3 + (whereLines - 1) * 2.6;
}

/** How many of these rows fit on a page of this measure, at the tightest padding allowed. */
function fitCount(rows: SpotlightRow[], areaMm: number): number {
  let used = 0;
  let count = 0;
  for (const row of rows) {
    const cost = rowHeightMm(row) + MIN_PAD_MM * 2;
    if (count > 0 && used + cost > areaMm) break;
    count += 1;
    used += cost;
  }
  return count;
}

/**
 * Split the ranking into pages — and then BALANCE them.
 *
 * Filling each page to the brim leaves the last one holding whatever is left, which is how a
 * two-page ranking ends with a sheet carrying two names and 150 mm of white under them. So the page
 * COUNT is worked out by filling greedily, and the rows are then spread evenly over that many
 * pages: ten names over two sheets print five and five, not eight and two.
 */
function paginateRows(rows: SpotlightRow[], areaFirst: number, areaLater: number): SpotlightRow[][] {
  let rest = rows;
  let pages = 0;
  while (rest.length > 0) {
    rest = rest.slice(fitCount(rest, pages === 0 ? areaFirst : areaLater));
    pages += 1;
  }

  const chunks: SpotlightRow[][] = [];
  rest = rows;
  let pagesLeft = pages;
  while (rest.length > 0) {
    const area = chunks.length === 0 ? areaFirst : areaLater;
    const fits = fitCount(rest, area);
    const even = pagesLeft > 0 ? Math.ceil(rest.length / pagesLeft) : fits;
    const take = Math.max(1, Math.min(fits, even));
    chunks.push(rest.slice(0, take));
    rest = rest.slice(take);
    pagesLeft -= 1;
  }
  return chunks;
}

/**
 * Cell padding chosen so THIS page's rows fill THIS page.
 *
 * A ten-name sheet and a sixteen-name sheet are both ordinary, and one fixed row height serves
 * exactly one of them: the other either overflows or leaves 40 mm of white under the last name,
 * which is precisely what "the export looks weak" was. The clamp is the whole safety — never
 * tighter than legible, never so airy that a three-name list prints like a menu.
 */
function rowPaddingMm(rows: SpotlightRow[], areaMm: number): number {
  if (rows.length === 0) return 2.4;
  const content = rows.reduce((sum, row) => sum + rowHeightMm(row), 0);
  return Math.min(MAX_PAD_MM, Math.max(MIN_PAD_MM, (areaMm - content) / (rows.length * 2)));
}

function leaderboardRows(rows: SpotlightRow[], offset: number): string {
  return rows.map((row, index) => {
    const rank = offset + index + 1;
    const beat = row.achievement !== null && row.achievement >= 100;
    const key = row.achievement === null ? "" : beat ? "beat" : "miss";
    const zebra = rank % 2 === 0 ? "zebra" : "";
    const arrow = row.achievement === null ? "" : beat ? "&#9650;" : "&#9660;";
    const tone = row.achievement === null ? "flat" : beat ? "up" : "down";
    return `<tr class="${[key, zebra].filter(Boolean).join(" ")}">
      <td class="lb-rank">${String(rank).padStart(2, "0")}</td>
      <td class="lb-name">${escapeHtml(row.title)}${row.isVacant ? '<span class="lb-vacant">vacant seat</span>' : ""}</td>
      <td class="lb-where">${escapeHtml(row.territory)}${row.lineName ? `<span class="lb-line">${escapeHtml(row.lineName)}</span>` : ""}</td>
      <td class="lb-value">${millions(row.actualValue)}<span class="lb-unit">M</span></td>
      <td class="lb-ach ${tone}"><span class="lb-arrow">${arrow}</span>${pct(row.achievement)}${row.achievement === null ? "" : '<span class="lb-pc">%</span>'}</td>
    </tr>`;
  }).join("");
}

const LB_COLS = `<colgroup><col style="width:12mm"><col><col style="width:43mm"><col style="width:22mm"><col style="width:25mm"></colgroup>`;
const LB_HEAD = `<thead><tr>
  <th></th><th>Name</th><th>Territory</th><th class="r">Sales</th><th class="r">Achievement</th>
</tr></thead>`;

function leaderboardPage(
  result: SpotlightResult,
  rows: SpotlightRow[],
  offset: number,
  part: number,
  parts: number,
  page: number,
  total: number,
): string {
  const first = part === 1;
  const last = part === parts;
  const pad = rowPaddingMm(rows, first ? ROW_AREA_FIRST : ROW_AREA_LATER);
  const totals = result.shortlistAchievement;

  const head = first
    ? `<p class="eyebrow">Spotlight &middot; ${escapeHtml(result.windowLabel)}</p>
    <h1 class="lb-head">${escapeHtml(result.headline)}</h1>
    <p class="lb-sub">${escapeHtml(result.subheadline)}</p>
    ${FLOURISH}

    <section class="stats stats--lb">
      <div class="stat">
        <p class="stat__v">${egp(result.shortlistActualValue)}<small> EGP</small></p>
        <p class="stat__l">Delivered by everyone<br>on this sheet</p>
      </div>
      <div class="stat">
        <p class="stat__v ${totals !== null && totals >= 100 ? "is-up" : totals !== null ? "is-down" : ""}">${pct(totals)}<small>%</small></p>
        <p class="stat__l">Their joint achievement,<br>summed and not averaged</p>
      </div>
      <div class="stat">
        <p class="stat__v">${result.rows.length}<small> of ${result.totalSubjects}</small></p>
        <p class="stat__l">Spotlighted out of<br>everyone who qualified</p>
      </div>
    </section>`
    : `<p class="eyebrow">Spotlight &middot; ${escapeHtml(result.windowLabel)}</p>
    <h1 class="lb-head lb-head--cont">${escapeHtml(result.headline)}</h1>
    <p class="lb-sub">Continued &mdash; ranks ${offset + 1} to ${offset + rows.length} of ${result.rows.length}</p>
    ${FLOURISH}`;

  const body = `${head}
    <section class="lb" style="--pad:${pad.toFixed(2)}mm">
      <table>
        ${LB_COLS}
        ${LB_HEAD}
        <tbody>${leaderboardRows(rows, offset)}</tbody>
      </table>
      ${last
        ? `<p class="lb-note">
        Sales in millions of EGP over ${escapeHtml(result.windowLabel)}. Achievement is measured against each
        subject's own target, summed across the window and never averaged.
        ${result.untargetedSubjects > 0
          ? `${result.untargetedSubjects} carried no target in this window and cannot be ranked by achievement.`
          : ""}
      </p>`
        : `<p class="lb-note">The ranking continues on sheet ${page + 1}.</p>`}
    </section>
    <div class="gap"></div>`;
  return pageShell(result, body, page, total);
}

// ── One hero sheet ────────────────────────────────────────────────────────────────────────────
function heroPage(result: SpotlightResult, row: SpotlightRow, rank: number, page: number, total: number): string {
  const beat = row.achievement !== null && row.achievement >= 100;
  const variance = row.varianceValue;
  const caption = variance === null
    ? ""
    : `${egp(Math.abs(variance))} EGP ${variance >= 0 ? "over" : "under"} target`;
  const months = monthsLabel(result.periods);

  // THE FIGURE PANEL TAKES THE SLACK. A single `margin-top: auto` used to shove the figure downward
  // and leave every millimetre of leftover page in ONE place, under the stats, where it reads as the
  // sheet having run out rather than having been laid out. Now the rule pair is the top and bottom
  // of a panel that GROWS to whatever the page has spare, with the number centred inside it — which
  // is the owner's own rule for this sheet, that the number sits in open space, done properly: the
  // open space is the composition, not what is left when the content stops.
  const body = `
    <p class="eyebrow">${escapeHtml(result.headline)} &middot; ${escapeHtml(result.windowLabel)}</p>
    <p class="accolade">${result.rows.length > 1 ? `No. ${rank}` : "Spotlight"}</p>
    ${FLOURISH}

    <h1 class="name">${escapeHtml(row.title)}</h1>
    ${row.titleAr ? `<p class="name-ar" dir="rtl" lang="ar">${escapeHtml(row.titleAr)}</p>` : ""}
    <p class="role">${escapeHtml(row.roleLabel)}${row.lineName ? ` &mdash; ${escapeHtml(row.lineName)} Line` : ""}</p>
    <p class="where">${escapeHtml(row.territory)}</p>
    ${months ? `<p class="months">${escapeHtml(months)}</p>` : ""}

    <section class="figure">
      <div class="rulepair rulepair--top"><hr><hr></div>
      <div class="figure__core">
        <p class="figure__label">Achievement</p>
        <p class="figure__pct ${row.achievement === null ? "" : beat ? "is-up" : "is-down"}">${pct(row.achievement)}<span>%</span></p>
        <p class="figure__cap">of the ${escapeHtml(result.windowLabel)} target</p>
        ${gauge(row.achievement, caption)}
      </div>
      <div class="rulepair rulepair--bot"><hr><hr></div>
    </section>

    <section class="stats">
      <div class="stat">
        <p class="stat__v">${egp(row.actualValue)}<small> EGP</small></p>
        <p class="stat__l">Delivered${row.targetValue !== null ? `<br>against ${egp(row.targetValue)} targeted` : "<br>no target set"}</p>
      </div>
      <div class="stat">
        <p class="stat__v">${row.targetedMonths}<small> of ${result.periods.length}</small></p>
        <p class="stat__l">Months in this window<br>that carried a target</p>
      </div>
      <div class="stat">
        <p class="stat__v">${rank}<small> of ${result.totalSubjects}</small></p>
        <p class="stat__l">Rank by ${result.selection.rankBy === "achievement" ? "achievement" : "sales value"}<br>across the company</p>
      </div>
    </section>`;
  return pageShell(result, body, page, total);
}

// ── Stylesheet ────────────────────────────────────────────────────────────────────────────────
const CSS = `
  @page { size: A4 portrait; margin: 0; }
  :root {
    --deep: ${C.deep}; --blue: ${C.blue}; --light: ${C.light}; --tint: ${C.tint};
    --hair: ${C.hair}; --muted: ${C.muted}; --body: ${C.body};
    --green: ${C.green}; --red: ${C.red};
    --display: "Aptos Display", "Aptos", Cambria, Georgia, "Times New Roman", serif;
    --text: "Aptos", "Segoe UI", Calibri, Arial, sans-serif;
    --arabic: "Segoe UI", Tahoma, Arial, sans-serif;
    --hair-w: ${HAIR};
    --u: 3.4mm;
    --pad: 2.4mm;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; border-radius: 0; }
  body { font-family: var(--text); color: var(--body); background: #FFF;
    -webkit-print-color-adjust: exact; print-color-adjust: exact; font-kerning: normal; }

  .sheet { position: relative; width: 210mm; height: 297mm; padding: 13mm 17mm 11mm; overflow: hidden; }
  .sheet--break { page-break-after: always; break-after: page; }

  .frame { position: absolute; inset: 6.6mm; border: var(--hair-w) solid var(--hair); }
  .frame::before { content:""; position:absolute; inset: 1.5mm; border: 1.6pt solid var(--deep); }
  .frame::after  { content:""; position:absolute; inset: 3.2mm; border: var(--hair-w) solid var(--light); }
  .corner { position: absolute; width: 11mm; height: 11mm; }
  .corner svg { display: block; width: 100%; height: 100%; }
  .corner--tl { top: 6.6mm; left: 6.6mm; }
  .corner--tr { top: 6.6mm; right: 6.6mm; transform: scaleX(-1); }
  .corner--bl { bottom: 6.6mm; left: 6.6mm; transform: scaleY(-1); }
  .corner--br { bottom: 6.6mm; right: 6.6mm; transform: scale(-1,-1); }

  .inner { position: relative; height: 100%; display: flex; flex-direction: column; }
  /* Pinned against shrinking: a column flex container whose content is even slightly taller than
     the box shrinks its items to fit, smallest first — which silently reduces the 2.6 mm band to
     height 0 and leaves a page that looks deliberate. Everything is rigid EXCEPT .gap, whose
     whole job is to absorb whatever is left over. */
  .inner > *:not(.gap):not(.figure) { flex: 0 0 auto; }
  .gap { flex: 1 1 0; min-height: 0; }
  .inner > .figure { flex: 1 1 auto; min-height: 0; }

  .lh { display: flex; align-items: flex-start; justify-content: space-between; }
  .lh__mark { width: 35mm; }
  .lh__mark img { display: block; width: 100%; height: auto; }
  .lh__id { text-align: right; color: var(--muted); font-size: 6.3pt; line-height: 1.62;
    padding-left: 7mm; border-left: var(--hair-w) solid var(--hair); }
  .lh__id strong { display: block; color: var(--deep); font-size: 7.8pt; font-weight: 700; letter-spacing: .05em; }
  .lh__id em { font-style: normal; letter-spacing: .13em; text-transform: uppercase; font-size: 5.8pt; }

  .band { height: 2.6mm; margin-top: calc(var(--u) * .9); }
  .band--foot { margin-top: 0; height: 2.2mm; }
  .band svg { display: block; width: 100%; height: 100%; }

  .eyebrow { margin-top: calc(var(--u) * 1.5); text-align: center; font-size: 7.4pt; font-weight: 700;
    letter-spacing: .4em; text-transform: uppercase; color: var(--blue); }
  .accolade { margin-top: calc(var(--u) * 1.3); text-align: center; font-family: var(--display);
    font-size: 13.5pt; letter-spacing: .52em; text-transform: uppercase; color: var(--muted); }
  .flourish { display: flex; align-items: center; justify-content: center; gap: 3.4mm; margin-top: calc(var(--u) * .8); }
  /* A SOLID hairline. It was a fading gradient, which looked a shade better and cost Chromium a
     whole page-sized raster layer per rule when printing. */
  .flourish i { display: block; width: 34mm; height: var(--hair-w); background: var(--hair); }
  .flourish b { display: block; width: 2.1mm; height: 2.1mm; border: 1.1pt solid var(--deep); transform: rotate(45deg); }
  .flourish s { display: block; width: 1.15mm; height: 1.15mm; border: var(--hair-w) solid var(--light); transform: rotate(45deg); }

  .name { margin-top: calc(var(--u) * 1.5); text-align: center; font-family: var(--display);
    font-weight: 700; font-size: 31pt; line-height: 1.1; color: var(--deep); letter-spacing: -.016em; }
  .name-ar { margin-top: calc(var(--u) * .7); text-align: center; font-family: var(--arabic);
    font-size: 13pt; font-weight: 600; color: var(--muted); line-height: 1.35; }
  .role { margin-top: calc(var(--u) * .85); text-align: center; font-size: 9.6pt; font-weight: 600;
    letter-spacing: .21em; text-transform: uppercase; color: var(--blue); }
  .where { margin-top: calc(var(--u) * .5); text-align: center; font-size: 8.4pt; font-weight: 600;
    letter-spacing: .16em; text-transform: uppercase; color: var(--muted); }
  .months { margin-top: calc(var(--u) * .8); text-align: center; font-family: var(--display);
    font-size: 8.8pt; color: var(--muted); letter-spacing: .1em; }

  /* The panel: two rule pairs with the number floating between them, growing to fill the sheet. */
  .figure { text-align: center; margin-top: calc(var(--u) * 2.2); display: flex; flex-direction: column; }
  .figure__core { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; justify-content: center;
    padding: calc(var(--u) * 2) 0; }
  .rulepair--top hr:first-child, .rulepair--bot hr:last-child { height: 1.6pt; background: var(--deep); border: 0; }
  .rulepair--top hr:last-child, .rulepair--bot hr:first-child { height: var(--hair-w); background: var(--hair); border: 0; }
  .rulepair--top hr:last-child, .rulepair--bot hr:last-child { margin-top: 1.1mm; }

  /* The panel's own head. It names what the number IS, so the top rule has something to sit over
     and the reader is not asked to infer a percentage from its size. */
  .figure__label { font-size: 7.4pt; font-weight: 700; letter-spacing: .42em; text-transform: uppercase;
    color: var(--muted); margin-bottom: calc(var(--u) * 1.2); }
  .figure__pct { font-family: var(--display); font-weight: 700; color: var(--deep); font-size: 112pt;
    line-height: 1; letter-spacing: -.038em; margin: 0; font-variant-numeric: lining-nums; }
  .figure__pct span { font-size: 50pt; vertical-align: 20pt; margin-left: 1.4mm; letter-spacing: 0; }
  .figure__pct.is-up { color: var(--deep); }
  .figure__pct.is-down { color: var(--deep); }
  .figure__cap { margin: calc(var(--u) * 1.2) 0 0; font-size: 9.6pt; font-weight: 600;
    letter-spacing: .19em; text-transform: uppercase; color: var(--body); }

  .gauge { width: 128mm; margin: calc(var(--u) * 1.8) auto 0; }
  .gauge__win { text-align: right; margin-bottom: calc(var(--u) * .5); font-size: 7pt; font-weight: 700;
    letter-spacing: .13em; text-transform: uppercase; }
  .gauge__win.is-up { color: var(--green); }
  .gauge__win.is-down { color: var(--red); }
  .gauge__win i { font-style: normal; font-size: 5.8pt; margin-right: 1.2mm; vertical-align: 1pt; }
  .gauge__track { position: relative; height: 3.4mm; background: #E7EDF2; }
  .gauge__base { position: absolute; left: 0; top: 0; bottom: 0; background: var(--deep); }
  .gauge__over { position: absolute; top: 0; bottom: 0; background: var(--green); }
  /* Solid, for the same reason: a repeating gradient rasterises the page. */
  .gauge__under { position: absolute; top: 0; bottom: 0; background: var(--red); opacity: .28; }
  .gauge__tick { position: absolute; top: -1.5mm; bottom: -1.5mm; width: .6mm; background: var(--body); }
  .gauge__labels { position: relative; margin-top: calc(var(--u) * .6); height: 3.2mm; font-size: 6.2pt;
    font-weight: 700; letter-spacing: .16em; text-transform: uppercase; }
  .gauge__t { position: absolute; transform: translateX(-50%); color: var(--body); white-space: nowrap; }
  .gauge__none { font-size: 7.4pt; color: var(--muted); text-align: center; }

  .stats { display: flex; }
  .figure + .stats { margin-top: calc(var(--u) * 2.2); }
  .stats--lb { margin-top: calc(var(--u) * 2); padding-top: calc(var(--u) * 1.2); border-top: var(--hair-w) solid var(--hair); }
  .stat { flex: 1 1 0; text-align: center; padding: 0 3mm; }
  .stat + .stat { border-left: var(--hair-w) solid var(--hair); }
  .stat__v { font-family: var(--display); font-weight: 700; font-size: 18pt; color: var(--deep);
    line-height: 1.12; font-variant-numeric: lining-nums; letter-spacing: -.018em; }
  .stat__v.is-up { color: var(--green); }
  .stat__v.is-down { color: var(--red); }
  .stat__v small { font-size: 9.5pt; font-weight: 600; color: var(--muted); letter-spacing: .03em; }
  .stat__l { margin-top: calc(var(--u) * .55); font-size: 6.4pt; font-weight: 600; letter-spacing: .18em;
    text-transform: uppercase; color: var(--muted); line-height: 1.6; }

  .lb-head { margin-top: calc(var(--u) * 1.1); text-align: center; font-family: var(--display);
    font-weight: 700; font-size: 26pt; line-height: 1.12; color: var(--deep); letter-spacing: -.016em; }
  .lb-head--cont { font-size: 19pt; }
  .lb-sub { margin-top: calc(var(--u) * .8); text-align: center; font-size: 8pt; font-weight: 600;
    letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }

  .lb { margin-top: calc(var(--u) * 1.9); }
  table { width: 100%; table-layout: fixed; border-collapse: collapse; }
  thead th { padding: 0 1.7mm calc(var(--u) * .6); font-size: 6.4pt; font-weight: 700; letter-spacing: .22em;
    text-transform: uppercase; color: var(--blue); text-align: left; border-bottom: 1.2pt solid var(--deep); }
  thead th.r { text-align: right; }
  td { padding: var(--pad) 1.7mm; vertical-align: baseline; border-bottom: var(--hair-w) solid var(--hair); }
  /* THE ONLY FILL ON THE PAGE is the 6% zebra the house identity allows. The over/under key is a
     RULE on the rank cell, not a wash across the row — see the note at the head of this file. */
  tr.zebra td { background: var(--tint); }
  td:first-child { border-left: 1.3pt solid transparent; }
  tr.beat td:first-child { border-left-color: var(--green); }
  tr.miss td:first-child { border-left-color: var(--red); }
  tbody tr:last-child td { border-bottom: 1.2pt solid var(--deep); }

  .lb-rank { font-family: var(--display); font-size: 9pt; color: var(--light); font-weight: 700;
    font-variant-numeric: lining-nums tabular-nums; padding-left: 2.8mm; }
  .lb-name { font-size: 9.2pt; font-weight: 600; color: var(--body); }
  .lb-vacant { margin-left: 2.2mm; font-size: 6.2pt; font-weight: 600; letter-spacing: .1em;
    text-transform: uppercase; color: var(--muted); }
  .lb-where { font-size: 8pt; color: var(--muted); font-weight: 600; }
  .lb-line { display: block; font-size: 6.4pt; letter-spacing: .1em; text-transform: uppercase; color: var(--light); }
  .lb-value { text-align: right; font-family: var(--display); font-size: 11pt; font-weight: 700;
    color: var(--deep); font-variant-numeric: lining-nums tabular-nums; }
  .lb-unit { font-size: 7pt; color: var(--muted); margin-left: .7mm; font-weight: 600; }
  .lb-ach { text-align: right; font-family: var(--display); font-size: 10.5pt; font-weight: 700;
    font-variant-numeric: lining-nums tabular-nums; }
  .lb-ach.up { color: var(--green); }
  .lb-ach.down { color: var(--red); }
  .lb-ach.flat { color: var(--muted); }
  .lb-arrow { font-size: 6.4pt; margin-right: 1.6mm; vertical-align: 1.2pt; }
  .lb-pc { font-size: 7pt; font-weight: 600; margin-left: .4mm; }
  .lb-note { margin-top: calc(var(--u) * .9); font-size: 6.4pt; color: var(--muted); line-height: 1.62; }

  .foot { margin-top: calc(var(--u) * 1.4); }
  .foot__txt { margin-top: calc(var(--u) * .8); display: flex; align-items: flex-start; gap: 6mm;
    font-size: 6.3pt; color: var(--muted); line-height: 1.62; }
  .foot__txt strong { color: var(--deep); font-weight: 700; }
  .foot__src { flex: 1.9 1 0; }
  .foot__no { flex: 0 0 auto; text-align: center; font-family: var(--display); font-size: 7.6pt;
    font-weight: 700; color: var(--deep); letter-spacing: .12em; line-height: 1.45; }
  .foot__no i { font-style: normal; font-size: 6pt; font-weight: 600; color: var(--muted); letter-spacing: .1em; }
  .foot__house { flex: 1 1 0; text-align: right; }
`;

/** The whole document, as HTML. Exported so a test can assert on the markup without Chromium. */
export function spotlightDocumentHtml(result: SpotlightResult): string {
  const layout = result.selection.layout;

  const wantsLeaderboard = layout === "leaderboard" || layout === "both";
  const wantsHeroes = layout === "heroes" || layout === "both";

  // A single subject needs no leaderboard of one — the hero sheet already IS the leaderboard.
  const showLeaderboard = wantsLeaderboard && (result.rows.length > 1 || !wantsHeroes);
  const heroRows = wantsHeroes ? result.rows : [];

  // The leaderboard's pages are worked out BEFORE anything is rendered, because the footer on the
  // first sheet has to know how many sheets there are in all.
  const chunks: SpotlightRow[][] = [];
  if (showLeaderboard) {
    chunks.push(...paginateRows(result.rows, ROW_AREA_FIRST, ROW_AREA_LATER));
    if (chunks.length === 0) chunks.push([]);
  }

  const total = chunks.length + heroRows.length;
  const pages: string[] = [];
  let emitted = 0;
  let offset = 0;

  chunks.forEach((chunk, index) => {
    emitted += 1;
    pages.push(leaderboardPage(result, chunk, offset, index + 1, chunks.length, emitted, total));
    offset += chunk.length;
  });
  heroRows.forEach((row, index) => {
    emitted += 1;
    pages.push(heroPage(result, row, index + 1, emitted, total));
  });

  // A selection that matched nobody still produces a sheet that SAYS so. An empty PDF, or a
  // silently successful download of one blank page, reads as the export being broken.
  if (pages.length === 0) {
    pages.push(pageShell(result, `
      <p class="eyebrow">Spotlight &middot; ${escapeHtml(result.windowLabel)}</p>
      <h1 class="lb-head">${escapeHtml(result.headline)}</h1>
      <p class="lb-sub">Nobody matched this selection</p>
      ${FLOURISH}
      <section class="lb"><p class="lb-note">No subject survived these filters for ${escapeHtml(result.windowLabel)}.
        Widen the lines, regions or areas, or check that the window carries sales.</p></section>
      <div class="gap"></div>`, 1, 1));
  }

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${escapeHtml(result.headline)}</title><style>${CSS}</style></head>
<body>${pages.join("\n")}</body></html>`;
}

/** Render the document. Throws `ChromiumUnavailableError` when the runtime cannot produce a PDF. */
export async function renderSpotlightPdf(result: SpotlightResult): Promise<Uint8Array> {
  const html = spotlightDocumentHtml(result);
  return withChromiumPage(async (page) => {
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.emulateMediaType("print");
    return page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });
  });
}
