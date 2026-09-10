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
  greenTint: "#EAF6F0",
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

const CORNER_SVG = `<svg viewBox="0 0 88 88" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M0,88 L0,30 Q0,0 30,0 L88,0" fill="none" stroke="${C.deep}" stroke-width="2.1"/>
  <path d="M10,88 L10,34 Q10,10 34,10 L88,10" fill="none" stroke="${C.hair}" stroke-width="1"/>
  ${rosette(30, 30, 11, 3, 12, 3, C.light, 0.8)}
  <circle cx="30" cy="30" r="2.1" fill="none" stroke="${C.deep}" stroke-width="1.1"/>
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
 */
function braidSvg(color: string, weight: number): string {
  const PERIOD = 72, H = 18, AMP = 6.2, MID = H / 2, STEPS = 24, PERIODS = 29;
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

const BAND_SVG = braidSvg(C.deep, 1.9);
const BAND_LIGHT_SVG = braidSvg(C.hair, 1.7);

// ── Formatting ────────────────────────────────────────────────────────────────────────────────
const egp = (n: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(n));
const millions = (n: number) => (n / 1_000_000).toFixed(2);
const pct = (n: number | null) => (n === null ? "—" : n.toFixed(1));

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
function pageShell(result: SpotlightResult, body: string, isLast: boolean): string {
  return `<div class="sheet${isLast ? "" : " sheet--break"}">
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
        <div class="band" style="margin-top:0">${BAND_LIGHT_SVG}</div>
        <div class="foot__txt">
          <span><strong>Source.</strong> Monthly Closing &mdash; Sales vs Target, ${escapeHtml(result.periods.join(", "))}.<br>
            Indirect sales at factory price, direct orders on the Finance-owned sales month.</span>
          <span style="text-align:right"><strong>Sato Pharma</strong><br>Phoenix Workforce &middot; Spotlight</span>
        </div>
      </footer>
    </div>
  </div>`;
}

// ── The leaderboard ───────────────────────────────────────────────────────────────────────────
function leaderboardPage(result: SpotlightResult, isLast: boolean): string {
  const rows = result.rows.map((row, index) => {
    const beat = row.achievement !== null && row.achievement >= 100;
    const cls = row.achievement === null ? "" : beat ? "beat" : index % 2 === 1 ? "zebra" : "";
    const arrow = row.achievement === null ? "" : beat ? "&#9650;" : "&#9660;";
    const tone = row.achievement === null ? "flat" : beat ? "up" : "down";
    return `<tr class="${cls}">
      <td class="lb-rank">${String(index + 1).padStart(2, "0")}</td>
      <td class="lb-name">${escapeHtml(row.title)}${row.isVacant ? '<span class="lb-vacant">vacant seat</span>' : ""}</td>
      <td class="lb-where">${escapeHtml(row.territory)}${row.lineName ? `<span class="lb-line">${escapeHtml(row.lineName)}</span>` : ""}</td>
      <td class="lb-value">${millions(row.actualValue)}<span class="lb-unit">M</span></td>
      <td class="lb-ach ${tone}"><span class="lb-arrow">${arrow}</span>${pct(row.achievement)}${row.achievement === null ? "" : '<span class="lb-pc">%</span>'}</td>
    </tr>`;
  }).join("");

  const totals = result.shortlistAchievement;
  const body = `
    <p class="eyebrow">Spotlight &middot; ${escapeHtml(result.windowLabel)}</p>
    <h1 class="lb-head">${escapeHtml(result.headline)}</h1>
    <p class="lb-sub">${escapeHtml(result.subheadline)}</p>
    <div class="flourish"><i></i><s></s><b></b><s></s><i></i></div>

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
    </section>

    <section class="lb">
      <table>
        <colgroup><col style="width:9mm"><col><col style="width:44mm"><col style="width:23mm"><col style="width:23mm"></colgroup>
        <thead><tr>
          <th></th><th>Name</th><th>Territory</th><th class="r">Sales</th><th class="r">Achievement</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="lb-note">
        Sales in millions of EGP over ${escapeHtml(result.windowLabel)}. Achievement is measured against each
        subject's own target, summed across the window and never averaged.
        ${result.untargetedSubjects > 0
          ? `${result.untargetedSubjects} carried no target in this window and cannot be ranked by achievement.`
          : ""}
      </p>
    </section>`;
  return pageShell(result, body, isLast);
}

// ── One hero sheet ────────────────────────────────────────────────────────────────────────────
function heroPage(result: SpotlightResult, row: SpotlightRow, rank: number, isLast: boolean): string {
  const beat = row.achievement !== null && row.achievement >= 100;
  const variance = row.varianceValue;
  const caption = variance === null
    ? ""
    : `${egp(Math.abs(variance))} EGP ${variance >= 0 ? "over" : "under"} target`;

  const body = `
    <p class="eyebrow">${escapeHtml(result.headline)} &middot; ${escapeHtml(result.windowLabel)}</p>
    <p class="accolade">${result.rows.length > 1 ? `No. ${rank}` : "Spotlight"}</p>
    <div class="flourish"><i></i><s></s><b></b><s></s><i></i></div>

    <h1 class="name">${escapeHtml(row.title)}</h1>
    ${row.titleAr ? `<p class="name-ar" dir="rtl" lang="ar">${escapeHtml(row.titleAr)}</p>` : ""}
    <p class="role">${escapeHtml(row.roleLabel)}${row.lineName ? ` &mdash; ${escapeHtml(row.lineName)} Line` : ""}</p>
    <p class="where">${escapeHtml(row.territory)}</p>

    <section class="figure">
      <div class="rulepair rulepair--top"><hr><hr></div>
      <p class="figure__pct ${row.achievement === null ? "" : beat ? "is-up" : "is-down"}">${pct(row.achievement)}<span>%</span></p>
      <p class="figure__cap">of the ${escapeHtml(result.windowLabel)} target</p>
      ${gauge(row.achievement, caption)}
      <div class="rulepair rulepair--bot" style="margin-top:calc(var(--u) * 1.9)"><hr><hr></div>
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
  return pageShell(result, body, isLast);
}

// ── Stylesheet ────────────────────────────────────────────────────────────────────────────────
const CSS = `
  @page { size: A4 portrait; margin: 0; }
  :root {
    --deep: ${C.deep}; --blue: ${C.blue}; --light: ${C.light}; --tint: ${C.tint};
    --hair: ${C.hair}; --muted: ${C.muted}; --body: ${C.body};
    --green: ${C.green}; --green-tint: ${C.greenTint}; --red: ${C.red};
    --display: "Aptos Display", "Aptos", Cambria, Georgia, "Times New Roman", serif;
    --text: "Aptos", "Segoe UI", Calibri, Arial, sans-serif;
    --arabic: "Segoe UI", Tahoma, Arial, sans-serif;
    --hair-w: ${HAIR};
    --u: 3.4mm;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; border-radius: 0; }
  body { font-family: var(--text); color: var(--body); background: #FFF;
    -webkit-print-color-adjust: exact; print-color-adjust: exact; font-kerning: normal; }

  .sheet { position: relative; width: 210mm; height: 297mm; padding: 14mm 17mm 12mm; overflow: hidden; }
  .sheet--break { page-break-after: always; break-after: page; }

  .frame { position: absolute; inset: 7mm; border: var(--hair-w) solid var(--hair); }
  .frame::before { content:""; position:absolute; inset: 1.4mm; border: 1.4pt solid var(--deep); }
  .frame::after  { content:""; position:absolute; inset: 2.9mm; border: var(--hair-w) solid var(--light); }
  .corner { position: absolute; width: 8.6mm; height: 8.6mm; }
  .corner svg { display: block; width: 100%; height: 100%; }
  .corner--tl { top: 7mm; left: 7mm; }
  .corner--tr { top: 7mm; right: 7mm; transform: scaleX(-1); }
  .corner--bl { bottom: 7mm; left: 7mm; transform: scaleY(-1); }
  .corner--br { bottom: 7mm; right: 7mm; transform: scale(-1,-1); }

  .inner { position: relative; height: 100%; display: flex; flex-direction: column; }
  /* Pinned against shrinking: a column flex container whose content is even slightly taller than
     the box shrinks its items to fit, smallest first — which silently reduces the 1.8 mm band to
     height 0 and leaves a page that looks deliberate. */
  .inner > * { flex: 0 0 auto; }

  .lh { display: flex; align-items: flex-start; justify-content: space-between; }
  .lh__mark { width: 35mm; }
  .lh__mark img { display: block; width: 100%; height: auto; }
  .lh__id { text-align: right; color: var(--muted); font-size: 6.3pt; line-height: 1.62; }
  .lh__id strong { display: block; color: var(--deep); font-size: 7.8pt; font-weight: 700; letter-spacing: .05em; }
  .lh__id em { font-style: normal; letter-spacing: .13em; text-transform: uppercase; font-size: 5.8pt; }

  .band { height: 1.8mm; margin-top: var(--u); }
  .band svg { display: block; width: 100%; height: 100%; }

  .eyebrow { margin-top: calc(var(--u) * 1.6); text-align: center; font-size: 7.4pt; font-weight: 700;
    letter-spacing: .4em; text-transform: uppercase; color: var(--blue); }
  .accolade { margin-top: calc(var(--u) * 1.4); text-align: center; font-family: var(--display);
    font-size: 12.5pt; letter-spacing: .52em; text-transform: uppercase; color: var(--muted); }
  .flourish { display: flex; align-items: center; justify-content: center; gap: 3.4mm; margin-top: calc(var(--u) * .8); }
  /* A SOLID hairline. It was a fading gradient, which looked a shade better and cost Chromium a
     whole page-sized raster layer per rule when printing. */
  .flourish i { display: block; width: 32mm; height: var(--hair-w); background: var(--hair); }
  .flourish b { display: block; width: 1.9mm; height: 1.9mm; border: 1pt solid var(--deep); transform: rotate(45deg); }
  .flourish s { display: block; width: 1.05mm; height: 1.05mm; border: var(--hair-w) solid var(--light); transform: rotate(45deg); }

  .name { margin-top: calc(var(--u) * 1.5); text-align: center; font-family: var(--display);
    font-weight: 700; font-size: 30pt; line-height: 1.1; color: var(--deep); letter-spacing: -.016em; }
  .name-ar { margin-top: calc(var(--u) * .7); text-align: center; font-family: var(--arabic);
    font-size: 13pt; font-weight: 600; color: var(--muted); line-height: 1.35; }
  .role { margin-top: calc(var(--u) * .85); text-align: center; font-size: 9.6pt; font-weight: 600;
    letter-spacing: .21em; text-transform: uppercase; color: var(--blue); }
  .where { margin-top: calc(var(--u) * .5); text-align: center; font-size: 8.4pt; font-weight: 600;
    letter-spacing: .16em; text-transform: uppercase; color: var(--muted); }

  .figure { margin-top: auto; text-align: center; }
  .rulepair--top hr:first-child, .rulepair--bot hr:last-child { height: 1.4pt; background: var(--deep); border: 0; }
  .rulepair--top hr:last-child, .rulepair--bot hr:first-child { height: var(--hair-w); background: var(--hair); border: 0; }
  .rulepair--top hr:last-child, .rulepair--bot hr:last-child { margin-top: 1.1mm; }

  .figure__pct { font-family: var(--display); font-weight: 700; color: var(--deep); font-size: 90pt;
    line-height: 1; letter-spacing: -.038em; margin: calc(var(--u) * 1.9) 0 0; font-variant-numeric: lining-nums; }
  .figure__pct span { font-size: 42pt; vertical-align: 16pt; margin-left: 1.2mm; letter-spacing: 0; }
  .figure__pct.is-up { color: var(--deep); }
  .figure__pct.is-down { color: var(--deep); }
  .figure__cap { margin: calc(var(--u) * 1.3) 0 0; font-size: 9.6pt; font-weight: 600;
    letter-spacing: .19em; text-transform: uppercase; color: var(--body); }

  .gauge { width: 118mm; margin: calc(var(--u) * 1.5) auto 0; }
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

  .stats { display: flex; margin-top: calc(var(--u) * 1.9); }
  .stats--lb { margin-top: calc(var(--u) * 2.2); padding-top: calc(var(--u) * 1.2); border-top: var(--hair-w) solid var(--hair); }
  .stat { flex: 1 1 0; text-align: center; padding: 0 3mm; }
  .stat + .stat { border-left: var(--hair-w) solid var(--hair); }
  .stat__v { font-family: var(--display); font-weight: 700; font-size: 18pt; color: var(--deep);
    line-height: 1.12; font-variant-numeric: lining-nums; letter-spacing: -.018em; }
  .stat__v.is-up { color: var(--green); }
  .stat__v.is-down { color: var(--red); }
  .stat__v small { font-size: 9.5pt; font-weight: 600; color: var(--muted); letter-spacing: .03em; }
  .stat__l { margin-top: calc(var(--u) * .55); font-size: 6.4pt; font-weight: 600; letter-spacing: .18em;
    text-transform: uppercase; color: var(--muted); line-height: 1.6; }

  .lb-head { margin-top: calc(var(--u) * 1.2); text-align: center; font-family: var(--display);
    font-weight: 700; font-size: 26pt; line-height: 1.12; color: var(--deep); letter-spacing: -.016em; }
  .lb-sub { margin-top: calc(var(--u) * .8); text-align: center; font-size: 8pt; font-weight: 600;
    letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }

  .lb { margin-top: calc(var(--u) * 2); }
  table { width: 100%; table-layout: fixed; border-collapse: collapse; }
  thead th { padding: 0 1.7mm calc(var(--u) * .6); font-size: 6.4pt; font-weight: 700; letter-spacing: .22em;
    text-transform: uppercase; color: var(--blue); text-align: left; border-bottom: 1pt solid var(--deep); }
  thead th.r { text-align: right; }
  td { padding: 1.5mm 1.7mm; vertical-align: baseline; border-bottom: var(--hair-w) solid var(--hair); }
  tr.zebra td { background: var(--tint); }
  tr.beat td { background: var(--green-tint); }

  .lb-rank { font-family: var(--display); font-size: 8.5pt; color: var(--light); font-weight: 700;
    font-variant-numeric: lining-nums tabular-nums; }
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
  .lb-note { margin-top: calc(var(--u) * .8); font-size: 6.4pt; color: var(--muted); line-height: 1.62; }

  .foot { margin-top: auto; padding-top: calc(var(--u) * 1.4); }
  .foot__txt { margin-top: calc(var(--u) * .8); display: flex; justify-content: space-between; gap: 6mm;
    font-size: 6.3pt; color: var(--muted); line-height: 1.62; }
  .foot__txt strong { color: var(--deep); font-weight: 700; }
`;

/** The whole document, as HTML. Exported so a test can assert on the markup without Chromium. */
export function spotlightDocumentHtml(result: SpotlightResult): string {
  const layout = result.selection.layout;
  const pages: string[] = [];

  const wantsLeaderboard = layout === "leaderboard" || layout === "both";
  const wantsHeroes = layout === "heroes" || layout === "both";

  // A single subject needs no leaderboard of one — the hero sheet already IS the leaderboard.
  const showLeaderboard = wantsLeaderboard && (result.rows.length > 1 || !wantsHeroes);
  const heroRows = wantsHeroes ? result.rows : [];

  const total = (showLeaderboard ? 1 : 0) + heroRows.length;
  let emitted = 0;

  if (showLeaderboard) {
    emitted += 1;
    pages.push(leaderboardPage(result, emitted === total));
  }
  heroRows.forEach((row, index) => {
    emitted += 1;
    pages.push(heroPage(result, row, index + 1, emitted === total));
  });

  // A selection that matched nobody still produces a sheet that SAYS so. An empty PDF, or a
  // silently successful download of one blank page, reads as the export being broken.
  if (pages.length === 0) {
    pages.push(pageShell(result, `
      <p class="eyebrow">Spotlight &middot; ${escapeHtml(result.windowLabel)}</p>
      <h1 class="lb-head">${escapeHtml(result.headline)}</h1>
      <p class="lb-sub">Nobody matched this selection</p>
      <div class="flourish"><i></i><s></s><b></b><s></s><i></i></div>
      <section class="lb"><p class="lb-note">No subject survived these filters for ${escapeHtml(result.windowLabel)}.
        Widen the lines, regions or areas, or check that the window carries sales.</p></section>`, true));
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
