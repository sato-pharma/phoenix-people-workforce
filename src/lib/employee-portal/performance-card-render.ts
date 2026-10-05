// ─────────────────────────────────────────────────────────────────────────────
// The performance card, drawn. One HTML document, rendered to a PNG he can send in a message
// or a PDF he can keep — through the SAME headless Chromium every other Phoenix document uses
// (`@/lib/pdf/chromium`), never a second PDF engine.
//
// 🔒 THREE BANDS, AND EACH ONE IS A DESIGN THE OWNER ALREADY OWNS (owner, 2026-10-03: "the export
// picture must show the photo, the name, the title, the identity banner and the rank — full
// redesign, premium, polished"). Nothing on the card is a look invented for the card:
//
//   · THE IDENTITY BANNER across the top is the portal's own `PhoenixSignatureCard`: the cream
//     field, the identity watermark bleeding off the right, HIS PHOTOGRAPH in the orange-gold bezel
//     with its glow, the hairline divider, the Pinyon Script name over the orange rule and its
//     square, the title in spaced orange capitals centred under the name, and the navy wave with
//     its orange stroke. That component is DESIGN-LOCKED (CLAUDE.md), so this neither imports nor
//     alters it: it restates the component's devices in print CSS at the card's width, which is the
//     only way a locked React component reaches a PDF at all.
//     🔴 NO HR ID. The portal banner prints one under the title; a card built to be posted publicly
//     shows a name or nothing (names, never codes — AGENTS.md §4).
//
//   · THE RANK across the bottom is HIS FOOTER — the rank strip on his landing page, which he
//     approved line by line on 2026-10-03: a 3px Sato-blue rule top and bottom, the faint square
//     grid, the Sato mark on the left and the Phoenix lockup on the right in full colour, and the
//     ranking on a BLANK white panel cut on whole grid squares, under the orange tick, with the
//     period beneath. His footer was drawn to close a photograph; here it closes the card.
//
//   · THE PROOF between them: the cumulative achievement drawn to scale against its 100% mark, the
//     facts that define it, and the portal's Achievement-by-month chart — square columns, a dashed
//     100% line on the same scale, an unscorable month simply absent.
//
// 🔴 EVERY ASSET IS INLINED AS A DATA URI, read off disk at render time. Chromium renders with
// `setContent` and has no origin, so a `/brand/...` src resolves to nothing and the mark silently
// disappears — the exact failure the spotlight sheet documents. Read once per process, cached.
// The photograph arrives already inlined and polished (`photoDataUri`, see `performance-card.ts`).
//
// 🔴 THE SANS FACE IS "Noto Sans", AT 400 AND 700 ONLY. Production's Chromium has `font-noto` (the
// Dockerfile) and this laptop has Noto Sans too, so the render approved here is the render served
// there. No other weight is asked for: a weight one side has and the other lacks is a card that
// looks different in production from the one he approved.
//
// 🔴 A NAME IS FITTED, NEVER CUT. The script name is one line by design; the layout pass shrinks a
// long one to its room once Pinyon Script has loaded (an unloaded webfont measures at the
// fallback's metrics). No ellipsis anywhere — the house rule.
//
// 🔴 NO MONEY ON THE CARD — percentages, the rank and the counts only. See note 2 in
// `performance-card.ts`: this file is built to be posted publicly.
//
// 🔒 NOT ONE ROUNDED CORNER (AGENTS.md §4), the portrait bezel included.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { withChromiumPage, type ChromiumPage } from "@/lib/pdf/chromium";
import type { PerformanceCardData } from "@/lib/employee-portal/performance-card";

/** The card's pixel geometry. A4 landscape at 96dpi is 1123×794; this is the same shape, bigger. */
const CARD_WIDTH = 1200;
const CARD_HEIGHT = 848;
/** The identity banner. The portrait, the divider, the name and the wave are all placed against it. */
const BANNER_HEIGHT = 300;
/** His footer: the ranking panel plus 12px of grid above and below it, rules included. */
const FOOT_HEIGHT = 168;
/**
 * The strip's own grid square, and the ranking panel cut on it — 20 × 8 whole squares.
 *
 * 🔴 EVEN COUNTS, BOTH WAYS, WITH A LINE THROUGH THE FOOTER'S CENTRE. The grid is offset half a
 * square so a line runs through the centre (a centred TILE draws its line on its own edge, 9px off
 * centre). An even number of squares then puts every edge of the centred panel on a line; an odd one
 * would ring it with half-squares — his "all squares must be the same size", at the panel's edge.
 * The layout pass widens the panel only in steps of TWO squares, for the same reason.
 */
const CELL = 18;
const PANEL_W = 20 * CELL;
const PANEL_H = 8 * CELL;
/** The breathing room the ranks keep inside the panel before the layout pass widens it. */
const PANEL_PAD = 24;
/** The one side margin: the portrait, the achievement, the chart's edge and both marks hang on it. */
const MARGIN = 48;
/** Where the signature block starts, and the room its one-line name may take before it is fitted. */
const SIG_LEFT = 320;
const SIG_ROOM = CARD_WIDTH - SIG_LEFT - MARGIN;
/** The name's size before fitting — the portal banner's script, scaled to the card. */
const SIG_SIZE = 62;

function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * A `public/` asset as a data URI, read once per process.
 *
 * Returns null when the file is missing rather than throwing: a card without its watermark is a
 * card; a 500 on a keepsake is not. Every caller renders the mark only when this returns one.
 */
const assetCache = new Map<string, string | null>();
function assetDataUri(relativePath: string, mime: string): string | null {
  const cached = assetCache.get(relativePath);
  if (cached !== undefined) return cached;
  let uri: string | null = null;
  try {
    const bytes = readFileSync(join(process.cwd(), "public", relativePath));
    uri = `data:${mime};base64,${bytes.toString("base64")}`;
  } catch {
    uri = null;
  }
  assetCache.set(relativePath, uri);
  return uri;
}

/** "1st", "2nd", "3rd", "4th" … "11th", "21st". The same ordinal the strip on screen prints. */
function ordinal(rank: number): string {
  const n = Math.trunc(rank);
  const teen = n % 100;
  if (teen >= 11 && teen <= 13) return `${n}th`;
  const last = n % 10;
  return `${n}${last === 1 ? "st" : last === 2 ? "nd" : last === 3 ? "rd" : "th"}`;
}

/** Target-relative tone — the one scale every percentage in this system is coloured by. */
function tone(pct: number): string {
  if (pct >= 100) return "#0f9d58";
  if (pct >= 90) return "#d99100";
  return "#e2621b";
}

/** One board on the footer — the strip's own cell: its label, the ordinal in its mark's ink, "of N". */
type RankCell = { label: string; rank: number; outOf: number; ink: string };

/** Company first in Phoenix orange, then his line in Sato blue — the strip's order and its two inks. */
function rankCells(data: PerformanceCardData): RankCell[] {
  const cells: RankCell[] = [];
  const company = data.standing?.company ?? null;
  const line = data.standing?.line ?? null;
  if (company) cells.push({ label: "Company", rank: company.rank, outOf: company.outOf, ink: "#f47b20" });
  if (line) cells.push({ label: `${line.lineName} line`, rank: line.rank, outOf: line.outOf, ink: "#0879b8" });
  return cells;
}

/** The framed portrait — `EmployeePortrait`'s bezel, mat and glow; the monogram plate without a photo. */
function portraitHtml(data: PerformanceCardData): string {
  const inner = data.photoDataUri
    ? `<img src="${data.photoDataUri}" alt="${escapeHtml(data.signatureName)} portrait" />`
    : `<span class="portrait-mono">${escapeHtml(data.initials)}</span>`;
  return `<div class="portrait"><div class="portrait-in">${inner}</div></div>`;
}

/** The identity banner — `PhoenixSignatureCard`'s devices, restated for print. */
function bannerHtml(data: PerformanceCardData): string {
  const watermark = assetDataUri("brand/identity-watermark.png", "image/png");
  return `<header class="banner">
  <span class="banner-glow"></span>
  ${watermark ? `<img class="banner-wm" src="${watermark}" alt="" />` : ""}
  <svg class="wave" viewBox="0 0 1875 118" preserveAspectRatio="none" aria-hidden="true">
    <path d="M0 38C420 58 1030 58 1875 4V118H0Z" fill="#0b1f3a" />
    <path d="M0 38C420 58 1030 58 1875 4" fill="none" stroke="#f47b20" stroke-width="9" />
  </svg>
  <span class="divider"></span>
  ${portraitHtml(data)}
  <div class="sig">
    <p class="sig-name"><span>${escapeHtml(data.signatureName)}</span></p>
    <div class="sig-rule"><span class="sig-rule-a"></span><span class="sig-rule-sq"></span><span class="sig-rule-b"></span></div>
    <p class="sig-title">${escapeHtml(data.jobTitle)}</p>
  </div>
</header>`;
}

/** The cumulative achievement, drawn to scale: the bar runs to the larger of the figure and 100%. */
function achievementHtml(data: PerformanceCardData): string {
  const pct = Math.max(0, Math.round(data.achievementPercent));
  const scale = Math.max(100, pct);
  const seats = data.standing?.company ?? null;
  // One fact per row, its label in the house micro voice and its value beside it. Sized for the
  // longest values production holds (2026-10-03): "Anti Infective", "Dokki - Mohandseen - Bolak".
  // A value may still wrap — at a space, never inside a word, and never behind an ellipsis.
  const facts = [
    data.lineName ? `<div class="fact"><dt>Line</dt><dd>${escapeHtml(data.lineName)}</dd></div>` : "",
    data.areaName ? `<div class="fact"><dt>Area</dt><dd>${escapeHtml(data.areaName)}</dd></div>` : "",
    // 🔒 THE STRUCTURE AND ITS VACANCIES — AND NOTHING ELSE (owner, 2026-10-03: "do not show the
    // current medical reps, only show total structure of medical reps count vacants"). "Of 111" on
    // the footer means the organogram's rep seats, so the card says how many are vacant. The count
    // of reps who were scored is NOT printed: that is the "current medical reps" he ruled out.
    seats
      ? `<div class="fact"><dt>Structure</dt><dd>${seats.outOf} rep seats<span class="fact-sub"> · ${seats.vacant} vacant</span></dd></div>`
      : "",
  ]
    .filter(Boolean)
    .join("");
  return `<section class="ach">
  <span class="tick"></span>
  <p class="micro head">Achievement</p>
  <p class="ach-fig" style="color:${tone(pct)}">${pct}<small>%</small></p>
  <p class="micro soft">Of target · cumulative</p>
  <div class="ach-bar"><span class="ach-fill" style="width:${((pct / scale) * 100).toFixed(2)}%;background:${tone(pct)}"></span><span class="ach-mark" style="left:${((100 / scale) * 100).toFixed(2)}%"></span><span class="ach-mark-l" style="right:calc(${(100 - (100 / scale) * 100).toFixed(2)}% - 1px)">100%</span></div>
  <dl class="facts">${facts}</dl>
</section>`;
}

/** The Achievement-by-month chart — the portal's own, in print CSS, on one scale with its 100% line. */
function chartHtml(data: PerformanceCardData): string {
  const peak = Math.max(100, ...data.months.map((month) => Math.round(month.achievementPercent)));
  // Headroom above the tallest column for its own figure, so the label never meets the heading.
  const scale = peak * 1.16;
  const hundred = ((100 / scale) * 100).toFixed(2);
  const columns = data.months
    .map((month) => {
      const pct = Math.max(0, Math.round(month.achievementPercent));
      const height = Math.min(100, (pct / scale) * 100).toFixed(2);
      return `<div class="col"><div class="bar" style="height:${height}%;background:${tone(pct)}"><span class="val">${pct}%</span></div></div>`;
    })
    .join("");
  const labels = data.months.map((month) => `<p class="micro">${escapeHtml(month.label)}</p>`).join("");
  // Two months sit in wide slots; a full year narrows the gutter so a column still reads as one.
  const gutter = data.months.length > 6 ? 16 : 36;
  return `<section class="chart">
  <span class="tick"></span>
  <p class="micro head">Achievement by month</p>
  <div class="plot" style="gap:${gutter}px">
    <span class="p100" style="bottom:${hundred}%"></span>
    <span class="p100-l" style="bottom:calc(${hundred}% + 5px)">100%</span>
    ${columns}
  </div>
  <div class="labs" style="gap:${gutter}px">${labels}</div>
</section>`;
}

/** His footer, with the ranking where his photo frame has the date. */
function footHtml(data: PerformanceCardData): string {
  const sato = assetDataUri("brand/sato-pharma-logo-on-light.png", "image/png");
  const bird = assetDataUri("brand/phoenix-bird-icon.png", "image/png");
  const cells = rankCells(data);
  // The period under the ranking is the RANKING's window; the achievement's is the same months.
  const period = data.standing?.windowLabel ?? data.windowLabel;
  const ranks = cells.length
    ? `<div class="ranks">${cells
        .map(
          (cell) =>
            `<div class="rank"><p class="micro">${escapeHtml(cell.label)}</p><p class="rank-row"><span class="rank-fig" style="color:${cell.ink}">${ordinal(cell.rank)}</span><span class="rank-of">of ${cell.outOf}</span></p></div>`,
        )
        .join("")}</div>`
    : "";
  return `<footer class="foot">
  <span class="foot-rule foot-rule-t"></span>
  <span class="foot-rule foot-rule-b"></span>
  <div class="foot-row">
    <div class="foot-side">${sato ? `<img class="foot-sato" src="${sato}" alt="Sato Pharma" />` : `<span class="foot-type">Sato Pharma</span>`}</div>
    <div class="foot-panel">
      <span class="tick"></span>
      ${ranks}
      <p class="foot-period${cells.length ? "" : " foot-period-only"}">${escapeHtml(period)}</p>
    </div>
    <div class="foot-side foot-side-r">
      ${bird ? `<img class="foot-bird" src="${bird}" alt="" />` : ""}
      <span class="foot-word"><span class="foot-word-a">PHOENIX</span><span class="foot-word-b">WORKFORCE</span></span>
    </div>
  </div>
</footer>`;
}

/** The whole document. One page, fixed geometry — nothing here may reflow onto a second sheet. */
export function performanceCardHtml(data: PerformanceCardData): string {
  const pinyon = assetDataUri("fonts/pinyon-script.woff2", "font/woff2");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>${escapeHtml(data.displayName)} — performance</title>
<style>
  ${pinyon ? `@font-face { font-family: "Pinyon Script"; font-style: normal; font-weight: 400; font-display: block; src: url("${pinyon}") format("woff2"); }` : ""}
  @page { size: ${CARD_WIDTH}px ${CARD_HEIGHT}px; margin: 0; }
  * { box-sizing: border-box; border-radius: 0 !important; }
  html, body { margin: 0; padding: 0; }
  body { position: relative; width: ${CARD_WIDTH}px; height: ${CARD_HEIGHT}px; overflow: hidden; background: #ffffff; color: #0b1f3a;
    font-family: "Noto Sans", "Segoe UI", Arial, sans-serif; -webkit-font-smoothing: antialiased;
    -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  p, dl, dd { margin: 0; }

  /* The house voice: one micro label for every label on the card, and the orange tick above a heading. */
  .micro { font-size: 12px; font-weight: 700; line-height: 1; letter-spacing: 0.2em; text-transform: uppercase; color: #0b1f3a; white-space: nowrap; }
  .micro.soft { color: #69757e; }
  .tick { display: block; flex: none; width: 32px; height: 3px; background: #f47b20; }
  .head { margin-top: 12px; }

  /* ── 1. The identity banner — PhoenixSignatureCard, restated for print ── */
  .banner { position: absolute; left: 0; top: 0; width: ${CARD_WIDTH}px; height: ${BANNER_HEIGHT}px; overflow: hidden; background: #fdf8f3; }
  /* (No backticks anywhere in this stylesheet: it sits inside a template literal, and one would end
     the string — a backtick in a comment here broke the build once, 2026-10-03.) */
  .banner-glow { position: absolute; inset: 0; z-index: 0;
    background: radial-gradient(ellipse at 70% 40%, rgba(255,255,255,0.55) 0%, transparent 60%), radial-gradient(ellipse at 10% 60%, rgba(244,123,32,0.06) 0%, transparent 40%); }
  .banner-wm { position: absolute; z-index: 1; right: -2%; top: -15%; height: 145%; width: auto; }
  .wave { position: absolute; z-index: 2; left: 0; bottom: 0; display: block; width: 100%; height: 28%; }
  /* 🔴 THE DIVIDER FADES BETWEEN SOLID COLOURS, NOT THROUGH TRANSPARENCY. The component fades a 1px
     line out through alpha; on screen that is invisible at its ends, but in the PDF the same alpha
     fade printed as a DARK line — darkest pixel 87 against 203 in the picture, the only region of the
     whole card where the PDF and the picture disagreed (pixel diff, 2026-10-03). Fading from the
     banner's own cream into the beige and back looks identical and has no alpha for a PDF viewer to
     mis-blend. */
  .divider { position: absolute; z-index: 3; left: 286px; top: 8%; bottom: 28%; width: 1px;
    background: linear-gradient(180deg, #fdf8f3, #e0d0bc 20%, #e0d0bc 80%, #fdf8f3); }
  .portrait { position: absolute; z-index: 4; left: ${MARGIN}px; top: 20px; width: 204px; aspect-ratio: 0.785 / 1; overflow: hidden;
    border: 3px solid transparent; background-color: #ffffff;
    background-image: linear-gradient(#fff,#fff), linear-gradient(145deg, #f9c06a, #f47b20 40%, #c45200 70%, #f9c06a);
    background-origin: border-box; background-clip: padding-box, border-box;
    box-shadow: 0 0 0 3px rgba(244,123,32,0.18), 0 0 22px 7px rgba(244,123,32,0.4), 0 0 42px 11px rgba(255,150,40,0.2), 0 12px 30px rgba(15,35,55,0.2); }
  .portrait-in { position: absolute; inset: 6px; overflow: hidden; background: #f8efe5; }
  .portrait-in img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: center top; }
  .portrait-mono { display: flex; width: 100%; height: 100%; align-items: center; justify-content: center;
    background: #fff6eb; color: #f47b20; font-size: 64px; font-weight: 700; letter-spacing: 0.02em; }
  /* The signature block is as wide as the WIDER of the name and the title, so nothing in it can run
     back across the divider: the rule spans the block — the name's own width in the usual case, a
     signing line under a short name — and the title centres on it. */
  .sig { position: absolute; z-index: 3; left: ${SIG_LEFT}px; top: 42%; transform: translateY(-50%);
    display: flex; flex-direction: column; width: max-content; }
  .sig-name { font-family: "Pinyon Script", cursive; font-style: italic; font-weight: 400; font-size: ${SIG_SIZE}px; line-height: 1.1;
    color: #2a3a5c; white-space: nowrap; }
  .sig-rule { display: flex; align-items: center; margin-top: 6px; }
  .sig-rule-a { flex: 1 1 auto; height: 1px; background: #f47b20; }
  .sig-rule-sq { flex: none; width: 7px; height: 7px; margin: 0 5px; background: #f47b20; }
  .sig-rule-b { flex: none; width: 22%; height: 1px; background: rgba(244,123,32,0.5); }
  .sig-title { margin-top: 11px; padding-left: 0.28em; text-align: center;
    white-space: nowrap; color: #f47b20; font-size: 15px; font-weight: 700; line-height: 1; letter-spacing: 0.28em; text-transform: uppercase; }

  /* ── 2. The proof — the achievement and the chart, on white, split by one hairline ── */
  .mid { position: absolute; left: ${MARGIN}px; right: ${MARGIN}px; top: ${BANNER_HEIGHT}px; bottom: ${FOOT_HEIGHT}px;
    padding: 30px 0 24px; display: grid; grid-template-columns: 340px 1px minmax(0, 1fr); column-gap: 44px; }
  .mid-sep { background: #dde4e8; }
  .ach, .chart { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .ach > * { flex: none; }
  .chart > .tick, .chart > .head, .chart > .labs { flex: none; }
  .ach-fig { margin-top: 14px; font-size: 96px; font-weight: 700; line-height: 0.86; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
  .ach-fig small { margin-left: 4px; font-size: 40px; letter-spacing: 0; }
  .ach .soft { margin-top: 12px; }
  .ach-bar { position: relative; margin-top: 16px; height: 8px; background: #eef1f3; }
  .ach-fill { position: absolute; left: 0; top: 0; bottom: 0; }
  .ach-mark { position: absolute; top: -5px; bottom: -5px; width: 2px; margin-left: -1px; background: #0b1f3a; }
  /* The tick's own label, hung under it and ending at it, so it can never run past the bar's end. */
  .ach-mark-l { position: absolute; top: 18px; font-size: 10.5px; font-weight: 700; line-height: 1; letter-spacing: 0.08em; color: #69757e; font-variant-numeric: tabular-nums; }
  .facts { margin-top: 30px; border-bottom: 1px solid #dde4e8; }
  .fact { display: grid; grid-template-columns: 104px minmax(0, 1fr); align-items: baseline; column-gap: 12px; padding: 8px 0; border-top: 1px solid #dde4e8; }
  .fact dt { font-size: 10.5px; font-weight: 700; line-height: 1; letter-spacing: 0.2em; text-transform: uppercase; color: #69757e; white-space: nowrap; }
  .fact dd { font-size: 15px; font-weight: 700; line-height: 1.3; color: #0b1f3a; overflow-wrap: normal; word-break: normal; }
  .fact-sub { font-weight: 400; color: #45515a; }
  .plot { position: relative; flex: 1 1 auto; min-height: 0; margin-top: 18px; padding: 0 0 0 52px; display: flex; gap: 36px;
    border-bottom: 1px solid #0b1f3a; }
  .p100 { position: absolute; left: 0; right: 0; height: 0; border-top: 1px dashed #8a959d; }
  .p100-l { position: absolute; left: 0; font-size: 11px; font-weight: 700; line-height: 1; letter-spacing: 0.08em; color: #69757e; font-variant-numeric: tabular-nums; }
  .col { flex: 1 1 0; min-width: 0; height: 100%; display: flex; align-items: flex-end; justify-content: center; }
  .bar { position: relative; width: 100%; max-width: 120px; }
  .val { position: absolute; left: 50%; bottom: 100%; transform: translateX(-50%); margin-bottom: 7px; white-space: nowrap;
    font-size: 16px; font-weight: 700; line-height: 1; color: #0b1f3a; font-variant-numeric: tabular-nums; }
  .labs { display: flex; gap: 36px; padding: 11px 0 0 52px; }
  .labs .micro { flex: 1 1 0; min-width: 0; text-align: center; }

  /* ── 3. The footer, carrying the rank ── */
  .foot { position: absolute; left: 0; right: 0; bottom: 0; height: ${FOOT_HEIGHT}px; background-color: #ffffff;
    background-image: linear-gradient(to right, #ebeef1 1px, transparent 1px), linear-gradient(to bottom, #ebeef1 1px, transparent 1px);
    background-size: ${CELL}px ${CELL}px; background-position: calc(50% + ${CELL / 2}px) calc(50% + ${CELL / 2}px); }
  .foot-rule { position: absolute; z-index: 1; left: 0; right: 0; height: 3px; background: #0879b8; }
  .foot-rule-t { top: 0; }
  .foot-rule-b { bottom: 0; }
  .foot-row { position: relative; height: 100%; display: flex; align-items: center; gap: 24px; padding: 0 ${MARGIN}px; }
  .foot-side { flex: 1 1 0; min-width: 0; display: flex; align-items: center; }
  .foot-side-r { justify-content: flex-end; gap: 4px; }
  .foot-sato { display: block; width: 130px; height: auto; }
  .foot-type { font-size: 20px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #0b1f3a; }
  .foot-bird { display: block; flex: none; width: 86px; height: auto; }
  .foot-word { display: flex; flex-direction: column; }
  .foot-word-a { font-size: 31px; font-weight: 700; line-height: 1; letter-spacing: 0.04em; color: #0b1f3a; }
  .foot-word-b { margin-top: 6px; margin-right: -0.42em; font-size: 13.5px; font-weight: 700; line-height: 1; letter-spacing: 0.42em; color: #f47b20; }
  .foot-panel { flex: none; width: ${PANEL_W}px; height: ${PANEL_H}px; display: flex; flex-direction: column; align-items: center; justify-content: center; background: #ffffff; }
  .ranks { flex: none; width: max-content; margin-top: 16px; display: flex; align-items: flex-end; gap: 52px; }
  .rank { display: flex; flex-direction: column; align-items: center; }
  .rank-row { margin-top: 10px; display: flex; align-items: baseline; gap: 8px; white-space: nowrap; }
  .rank-fig { font-size: 46px; font-weight: 700; line-height: 1; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
  .rank-of { font-size: 17px; font-weight: 700; line-height: 1; color: #0b1f3a; }
  .foot-period { margin-top: 15px; padding-left: 0.3em; font-size: 12px; font-weight: 700; line-height: 1; letter-spacing: 0.3em;
    text-transform: uppercase; color: #0b1f3a; white-space: nowrap; }
  .foot-period-only { margin-top: 12px; font-size: 14px; }
</style></head>
<body>
  ${bannerHtml(data)}
  <main class="mid">
    ${achievementHtml(data)}
    <span class="mid-sep"></span>
    ${chartHtml(data)}
  </main>
  ${footHtml(data)}
</body></html>`;
}

/**
 * The one layout pass, run in the page once its fonts have loaded. It does two things and reports
 * both — `renderPage` refuses to print a card the pass did not run on:
 *
 *   1. FITS THE NAME. The script name is one line; a long one is shrunk to its room, never cut and
 *      never given an ellipsis. Only after `document.fonts.ready` — an unloaded webfont measures at
 *      the fallback's metrics, which are nowhere near Pinyon Script's.
 *   2. WIDENS THE RANKING PANEL for a long line name ("Anti Infective line"), two grid squares at a
 *      time, so the panel stays an even number of whole squares and its edges stay on the lines.
 *
 * A string, not a function: a function handed to `evaluate` is serialised from the BUNDLED source,
 * where a compiler may have injected helpers the page does not have.
 */
export const PERFORMANCE_CARD_LAYOUT_SCRIPT = `(async () => {
  await document.fonts.ready;
  const report = { nameSize: 0, panelWidth: 0 };
  const name = document.querySelector(".sig-name");
  const span = name ? name.querySelector("span") : null;
  if (name && span) {
    let size = parseFloat(getComputedStyle(name).fontSize) || 0;
    const width = span.getBoundingClientRect().width;
    if (size > 0 && width > ${SIG_ROOM}) {
      size = Math.max(size * 0.45, Math.floor(((size * ${SIG_ROOM} * 0.98) / width) * 10) / 10);
      name.style.fontSize = size + "px";
    }
    report.nameSize = size;
  }
  const panel = document.querySelector(".foot-panel");
  const ranks = document.querySelector(".ranks");
  if (panel) {
    let width = panel.getBoundingClientRect().width;
    if (ranks) {
      const need = ranks.getBoundingClientRect().width + 2 * ${PANEL_PAD};
      while (width < need) width += 2 * ${CELL};
      panel.style.width = width + "px";
    }
    report.panelWidth = width;
  }
  return report;
})()`;

/** Load the card into a page at the card's own size and run the layout pass on it. */
async function renderPage(page: ChromiumPage, data: PerformanceCardData): Promise<void> {
  await page.setViewport({ width: CARD_WIDTH, height: CARD_HEIGHT, deviceScaleFactor: 2 });
  await page.setContent(performanceCardHtml(data), { waitUntil: "networkidle0" });
  const report = (await page.evaluate(PERFORMANCE_CARD_LAYOUT_SCRIPT)) as { nameSize?: unknown } | null;
  if (!report || typeof report.nameSize !== "number" || report.nameSize <= 0) {
    throw new Error("The performance card's layout pass did not run, so its name was never fitted.");
  }
}

/**
 * The card as a PICTURE — the file he shares to WhatsApp, LinkedIn or Facebook.
 *
 * An explicit viewport is required or Chromium hands back an 800×600 thumbnail of the corner (the
 * trap `chromium.ts` documents). `deviceScaleFactor: 2` doubles the pixels so the name, the photo
 * and the figures stay crisp after a platform re-encodes the upload.
 */
export async function renderPerformanceCardPng(data: PerformanceCardData): Promise<Uint8Array> {
  return withChromiumPage(async (page) => {
    await renderPage(page, data);
    await page.emulateMediaType("screen");
    return page.screenshot({ type: "png" });
  });
}

/** The card as a PDF — one page, its own geometry from `@page`, no margins added by the driver. */
export async function renderPerformanceCardPdf(data: PerformanceCardData): Promise<Uint8Array> {
  return withChromiumPage(async (page) => {
    await renderPage(page, data);
    await page.emulateMediaType("print");
    return page.pdf({
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });
  });
}
