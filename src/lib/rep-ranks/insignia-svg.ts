// The rank insignia as SVG markup — the ONE drawing, shared by the board (rank-insignia.tsx) and the
// printed certificate (certificate.ts), so the badge on paper is the badge on the screen. PURE.
//
// The Egyptian army's shapes (the owner's choice, 2026-10-05: "real Egyptian insignia"): a plain bar
// for a private, chevrons for the corporal to the staff sergeant, one to three stars for the
// lieutenants and the captain, the eagle for the major with one to three stars beside it up to the
// brigadier, and the eagle with crossed swords for the major general.
//
// EVERY RANK MUST READ AS ITSELF AT A GLANCE (owner, 2026-10-05: "every rank should be distinct …
// you put one logo for all the ranks"). The stars sit BESIDE the eagle, large enough to count.
//
// REDRAWN NINE TIMES on 2026-10-06 — ninth pass: "remove the what's behind them, I need them to be
// icons with transparent background". The third pass's `plate()` (a dark radial-vignette board inside
// a metallic bevel, built to match the owner's reference photo of a real shoulder board) is gone —
// every rank now draws straight onto whatever it's placed on, board or paper, with nothing of its own
// behind it. `shape()` below keeps the per-device drop shadow for lift but no longer calls `plate()`,
// and its gradients (`PLATE_BG_ID`/`BEVEL_OUTER_ID`/`BEVEL_INNER_ID`) are removed from `DEFS` with it.
// Eighth pass: "I want real swords and stars". The seventh pass's
// hand-traced sabre (a bezier blade, an ellipse guard, a rect grip, a circle pommel) and the star's
// hand-chosen inner ratio were still an ORIGINAL drawing in the real device's style, not the real
// device — raised explicitly after the owner saw them fixed and still said so. Flagged the licence
// trade first (the real artwork is CC BY-SA 4.0, share-alike, not Public Domain like the eagle) and
// the owner chose it anyway: the crossed sabres below are now the actual traced Wikimedia Commons
// artwork (`REAL_SWORD_LEFT_MARKUP`/`REAL_SWORD_RIGHT_MARKUP`, full attribution at `crossedSwords()`),
// and the star keeps its own clean parametric facets but with the REAL measured inner/outer ratio
// (0.46, not 0.382) instead of a golden-ratio guess — a bare number carries no licence weight, so it
// needed no embedded artwork. Seventh pass: "the eagle good, the stars moderate, the sword
// awful" — two fixes. The sixth pass's sabre pair rotated both blades around the SAME shared pivot,
// which only fans two blades out of one hilt (a V, no crossing); a close isolated screenshot caught it
// reading as a bowtie, not crossed swords. Each sabre now gets its OWN pivot, offset left/right of
// centre, so the blades swing up and genuinely cross in an X with two separate hilts below — see
// `crossedSwords()`. And the star's two flat facet colours read as a sticker next to the eagle's rich
// gradient, so the lit facet now carries the same `GOLD` gradient the eagle and sabres use — see
// `star()`. Sixth pass: "premium polish them" — a richer gold (a near-white highlight stop, not just
// light-to-dark), a plate with real depth
// (a radial vignette and a two-stop metallic bevel instead of three flat fills), and a soft drop
// shadow under every device so the eagle, stars, chevrons, bar and sabres read as raised metal on the
// board rather than a flat sticker on it. Earlier passes. First replaced the four/five-point polygons with
// hand-written bezier silhouettes ("even more awful"). Second pass dropped the hand-drawing for real
// licensed artwork, still floating on a transparent ground ("no poor") — real devices, but nothing a
// real rank is ever WORN on reads as a rank. The owner then sent a reference photo of actual Egyptian
// officer shoulder boards and NCO sleeve chevrons: dark boards with a gold bevel border, the device
// sitting ON the board, not floating beside it — third pass, `plate()` below. Fourth pass: "no i need
// the real eagle" — the third pass's eagle was Lorc's generic "Eagle Emblem" (game-icons.net), a
// heraldic eagle but not Egypt's own. `COA_EAGLE_MARKUP` below is the actual Egyptian national
// emblem — the Eagle of Saladin, from the official Coat of Arms of Egypt — traced unmodified from
// Wikimedia Commons' "Coat_of_arms_of_Egypt_(Official).svg", Public Domain (self-published by the
// uploader, the PD-self tag on that file's page). Only the small tricolour shield on the eagle's
// breast was dropped (the reference photo's boards show no colour fleck, and at badge scale it would
// read as a speck, not an accent); every path and transform in the eagle itself is the original
// artwork's own geometry, recoloured to this file's house gold — no vertex was redrawn by hand. Fifth
// pass: "real swords real stars" — the swords were still Lorc's straight, ornate-hilted fantasy
// "Crossed Swords" (game-icons.net), and the stars were a flat gradient fill, neither matching how
// Egypt's own rank insignia actually draws either device. Wikimedia Commons hosts the Egyptian army's
// full rank chart (e.g. "Egypt_Army_-_OF06.svg" / "OF07.svg", Military ranks of Egypt), which shows
// the real devices: a curved SABRE, not a straight sword, and a STAR shaded as ten triangular facets
// fanning from its centre (a struck-medal look), not a flat gradient. Those chart files are CC BY-SA
// 4.0 (share-alike, user Punkhung) — a licence this proprietary codebase cannot take on for an
// embedded asset, so they are used as visual reference only, the same way the owner's reference photo
// was: `sabre()` and `facetedStar()` below are this file's OWN tracing of that real shape, built from
// plain geometry (a curved blade, a guard, a grip, a pommel; ten centre-to-edge triangles alternating
// two golds), not copied path data from any source. The crossed swords keep the name `crossedSwords`
// for every call site below, but the device itself is now the sabre pair, not Lorc's artwork — this
// file no longer uses any game-icons.net asset. The chevrons and private's bar are still plain
// geometry (neither has a "real" version to trace), so they stay the hand-drawn shapes below — drawn
// onto the plate, not a transparent ground.

import type { RankInsignia } from "@/lib/rep-ranks/ladder";

// One gradient/filter id set shared by every badge on a page. Each SVG declares the same stops, so
// whichever declaration the browser resolves, the look is identical.
const GOLD_ID = "phx-rank-gold";
const GOLD = `url(#${GOLD_ID})`;
const GOLD_DARK = "#5c430b";
const DEVICE_SHADOW_ID = "phx-rank-device-shadow";

const DEFS_BODY = `<linearGradient id="${GOLD_ID}" x1="0" x2="0.15" y1="0" y2="1"><stop offset="0" stop-color="#fff6de"/><stop offset="0.22" stop-color="#fbe7a6"/><stop offset="0.55" stop-color="#e2b23f"/><stop offset="1" stop-color="#a97a14"/></linearGradient><filter id="${DEVICE_SHADOW_ID}" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="0.45" stdDeviation="0.5" flood-color="#000000" flood-opacity="0.55"/></filter>`;
const DEFS = `<defs>${DEFS_BODY}</defs>`;

/** The board's one copy of the eagle's artwork, which every eagle rank's symbol points at (see `insigniaSpriteDefs`). */
export const EAGLE_ART_ID = "phx-rank-eagle-art";

const STAR_RADIUS = 5.6;
const f = (value: number): string => value.toFixed(2);
// REDRAWN in the seventh pass ("the stars moderate") — flat two-tone facets read as a flat sticker
// next to the eagle's rich gradient. The LIT facet now carries the same `GOLD` gradient the eagle and
// sabres use (a near-white highlight through to a dark base), so the star shares their metal; the
// SHADOW facet stays a flat, darker bronze. The outline thinned too — 0.55 against a ~5.6-unit radius
// was heavy enough to look like a cartoon badge rather than a struck medal.
// EIGHTH pass ("I want real swords and stars") — measured the real star's own inner/outer point ratio
// from the same Wikimedia chart the swords were traced from (an alternating-radius 10-point star, its
// outer points 40 units from centre, its inner points 18.4): 0.46, not the golden-ratio 0.382 used
// before — the real device is fuller, less spiky, than a plain pentagram. A ratio is a bare geometric
// fact, not the chart's protected expression (unlike the swords' hand-drawn hilt), so this needed no
// embedded artwork and carries no licence obligation — just the real number in place of an aesthetic
// guess.
const STAR_FACET_SHADOW = "#6b4f12";
const STAR_INNER_RATIO = 0.46;

/** A star shaded as ten centre-to-edge triangular facets, alternating a lit gold gradient and a flat
 * shadow tone — the real insignia's struck-medal look (Wikimedia's Egyptian army rank chart, used as
 * visual reference only — see the header), not a single flat gradient fill. */
function star(x: number, y: number, radius = STAR_RADIUS): string {
  const points: Array<[number, number]> = [];
  for (let index = 0; index < 10; index += 1) {
    const r = index % 2 === 0 ? radius : radius * STAR_INNER_RATIO;
    const angle = (Math.PI / 5) * index - Math.PI / 2;
    points.push([x + r * Math.cos(angle), y + r * Math.sin(angle)]);
  }
  const facets = points
    .map((a, index) => {
      const b = points[(index + 1) % points.length];
      const fill = index % 2 === 0 ? GOLD : STAR_FACET_SHADOW;
      return `<path d="M${f(x)},${f(y)} L${f(a[0])},${f(a[1])} L${f(b[0])},${f(b[1])} Z" fill="${fill}"/>`;
    })
    .join("");
  const outline = points.map(([px, py]) => `${f(px)},${f(py)}`).join(" ");
  return `<g stroke="${GOLD_DARK}" stroke-width="0.32" stroke-linejoin="round">${facets}<polygon points="${outline}" fill="none"/></g>`;
}

/** A row of stars centred on `centerX`. */
function starRow(count: number, centerX: number, y: number, gap: number, radius?: number): string {
  const start = centerX - ((count - 1) * gap) / 2;
  return Array.from({ length: count }, (_, index) => star(start + index * gap, y, radius)).join("");
}

// ── The real Egyptian national emblem, traced from the official Coat of Arms (Wikimedia Commons,
// Public Domain) — see the header above. Its own canvas is 600×815.143 (the artwork's native size;
// it ships with no viewBox of its own), every path and transform exactly as published, only its two
// inks (`#fff`, `#c09300`) replaced with this file's house gold and the dropped-shield group removed.
// `${GOLD}` / `${GOLD_DARK}` / `${idA}` / `${idB}` are literal placeholder text, not a template
// expression — `egyptEagle()` below fills them in at call time, because the artwork reuses two ids
// (a mirrored wing-feather group) via `<use>`, and every eagle on a page needs its OWN pair or a
// second badge's `<use>` resolves to the first badge's element.
const COA_EAGLE_MARKUP = "<g fill=\"${GOLD}\" stroke=\"${GOLD_DARK}\"><g transform=\"translate(35.212553,641.57853) translate(-189.36166,-1103.042)\" fill=\"${GOLD}\" stroke=\"${GOLD_DARK}\"><path d=\"m 457.60208,879.34399 293.822,272.76201 -20.918,-495.38002 c -3.073,-75.078 -68.316,-57.853 -115.709,-30.77 -48.01,30.77 -102.783,30.77 -160.648,10.454 -57.852,20.315 -112.629,20.315 -160.64,-10.455 -47.388,-27.08 -112.624,-44.308 -115.704,30.77 l -20.931,495.38102 z\" stroke-width=\"5.45\" stroke-linejoin=\"round\"/><path d=\"m 393.47,246.49 -4.734,112.32 -8.035,7.168 4.879,-115.47 c 2.294,-1.578 6.313,-4.017 7.89,-4.017 z m 9.62,8.04 -4.017,93.955 -8.032,8.22 4.877,-108.49 c 1.579,1.577 6.314,5.45 7.172,6.31 z m 8.75,7.17 -3.155,78.362 -6.455,6.31 4.018,-89.406 c 1.574,1.578 4.73,3.874 5.592,4.734 z m 9.47,4.02 -3.156,66.787 -6.313,5.12 3.156,-74.345 c 1.579,0.717 4.735,2.438 6.313,2.438 z m 8.75,0 -2.297,55.657 -6.455,6.313 2.44,-61.252 c 1.575,0 5.593,0 6.312,-0.718 z\" transform=\"matrix(4.29012,0,0,4.29012,-1476.4279,-417.98901)\" id=\"${idA}\" fill=\"${GOLD_DARK}\" stroke=\"none\"/><use xlink:href=\"#${idA}\" transform=\"matrix(-1,0,0,1,908.25417,5.1265624e-7)\" width=\"100%\" height=\"100%\"/><path d=\"m 467.68408,933.65699 41.24,187.71501 -13.547,13.536 -14.154,-10.463 -23.39,-167.39201 9.849,167.39201 -13.544,17.228 -13.54,-17.228 9.85,-167.39201 -23.383,167.39201 -14.168,10.463 -13.533,-13.536 41.233,-187.71601 h 27.087 z\" fill=\"${GOLD_DARK}\" stroke-width=\"4.607\"/><g id=\"${idB}\" fill=\"none\" stroke=\"${GOLD_DARK}\" stroke-width=\"1.27\" stroke-linejoin=\"round\"><path d=\"m 587.732,-30.405 -81.856,290.463 112.637,17.236 47.998,-218.47 -78.78,-89.23 z\" transform=\"translate(-225.92792,881.60599)\" fill=\"${GOLD}\" stroke-width=\"5.101\"/><path d=\"m 560.661,68.697 9.848,23.994 53.219,-50.83\" transform=\"translate(-225.92792,881.60599)\" stroke-width=\"5.448\"/><path d=\"M 597.513,8.55 608.649,112.997 642.5,68.688 m -13.54,17.212 18.49,63.816 m 7.25,-23.446 -37.4,56.806 m 11.665,56.698 -11.97,-56.62 -10.45,-57.587 -25.056,33.93 -10.989,-39.121 -35.07,35.971 17.836,65.429 24.615,-40.477 13.538,41.238 25.27,-39.307\" transform=\"translate(-225.92792,881.60599)\" stroke-width=\"5.448\"/><path d=\"m 529.858,253.301 22.736,-31.934 14.813,49.152 20.31,-34.46 13.547,41.244\" transform=\"translate(-225.92792,881.60599)\" stroke-width=\"5.448\"/></g><use xlink:href=\"#${idB}\" transform=\"matrix(-1,0,0,1,908.25417,5.1265624e-7)\" width=\"100%\" height=\"100%\"/><g stroke-width=\"1.27\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"m 680.055,389.899 c 85.558,0 167.418,-6.769 215.42,-20.31 20.316,-3.684 20.316,-14.147 20.316,-27.694 20.315,-6.768 9.845,-30.762 24,-30.762 -14.155,3.7 -17.228,-24 -34.462,-20.299 0,-24.01 -24.006,-27.083 -44.317,-20.325 -40.626,13.546 -112.637,16.625 -180.958,16.625 -68.316,-3.079 -139.716,-3.079 -180.953,-16.625 -20.31,-6.758 -44.304,-3.685 -44.304,20.325 -17.239,-3.7 -20.315,24 -34.467,20.3 14.152,0 3.687,23.993 24,30.761 0,13.547 0,24.01 20.926,27.694 47.385,13.541 129.253,20.31 214.798,20.31 z\" transform=\"translate(-225.92792,881.60599)\" stroke-width=\"10.202\"/><path d=\"m 563.75,260.036 c 27.69,3.695 58.466,6.769 82.478,3.695 13.528,0 23.378,23.383 -3.701,27.083 -23.995,3.068 -61.542,0 -81.856,-3.7 -17.233,-3.078 -54.776,-9.844 -78.783,-16.625 -24.003,-10.452 -6.762,-30.751 6.766,-27.68 20.931,6.765 48.015,13.54 75.099,17.228 z m 232.653,0 c -27.7,3.695 -58.466,6.769 -81.86,3.695 -14.16,0 -24.008,23.383 3.077,27.083 24.005,3.068 61.55,0 81.847,-3.7 17.242,-3.078 54.78,-9.844 78.784,-16.625 24.01,-10.452 6.78,-30.751 -6.767,-27.68 -20.926,6.765 -48.006,13.54 -75.081,17.228 z\" transform=\"translate(-225.92792,881.60599)\" stroke-width=\"5.448\"/><path d=\"m 478.805,246.523 c -20.923,-3.695 -30.77,20.299 -23.993,33.835 3.073,-6.768 17.23,-6.768 20.312,-13.536 3.681,-10.455 -3.082,-10.455 3.681,-20.3 z m 81.856,62.936 c 0,-13.526 13.533,-11.863 13.533,-25.404 0,-6.766 -3.685,-17.234 -10.454,-17.234 -6.772,0 -13.546,6.768 -13.546,13.536 -3.08,13.544 10.467,15.578 10.467,29.102 z m 97.429,-38.955 c 20.294,0 18.283,27.089 8.432,40.627 0,-9.846 -17.23,-13.538 -17.23,-20.299 0,-10.476 15.556,-10.476 8.798,-20.328 z m 223.215,-23.981 c 20.926,-3.695 30.778,20.299 24.004,33.835 -3.08,-6.768 -17.233,-6.768 -20.31,-13.536 -3.694,-10.455 3.08,-10.455 -3.694,-20.3 z m -81.855,62.936 c 0,-13.526 -13.528,-11.863 -13.528,-25.404 0,-6.766 3.687,-17.234 10.459,-17.234 6.766,0 13.54,6.768 13.54,13.536 3.08,13.544 -10.471,15.578 -10.471,29.102 z m -97.43,-38.955 c -20.302,0 -18.288,27.089 -8.44,40.627 0,-9.846 17.228,-13.538 17.228,-20.299 0.003,-10.476 -15.556,-10.476 -8.787,-20.328 z\" transform=\"translate(-225.92792,881.60599)\" stroke-width=\"5.448\"/><path d=\"m 485.584,253.301 c 6.778,0 17.236,3.079 20.315,6.766 l -20.335,-6.779 z m 33.806,10.468 c 3.697,0 17.239,3.073 24.007,6.758 l -24.025,-6.779 z m 123.127,13.514 c -6.769,0 -20.31,0 -23.994,3.068 l 23.982,-3.089 z m -37.539,0 c -3.684,-3.7 -17.231,-3.7 -23.997,0 h 23.982 z M 874.57,253.301 c -6.769,0 -16.623,3.079 -20.316,6.766 z m -33.85,10.468 c -3.69,0 -17.234,3.073 -24.004,6.758 l 24.024,-6.779 z m -123.126,13.514 c 6.776,0 20.314,0 24.004,3.068 l -24.024,-3.089 z m 37.538,0 c 3.69,-3.7 17.24,-3.7 24.005,0 h -24.025 z\" transform=\"translate(-225.92792,881.60599)\" stroke-width=\"3.822\"/><g fill=\"${GOLD_DARK}\" stroke=\"none\"><path d=\"m 479.878,307.4 c -2.291,-0.438 -3.494,-2.251 -2.918,-4.396 0.703,-2.613 2.796,-4.108 4.773,-3.408 1.258,0.444 3.56,2.765 3.57,3.598 0.012,0.956 -1.205,3.229 -1.728,3.234 -0.226,0.002 -0.576,0.2 -0.778,0.437 -0.429,0.507 -1.773,0.753 -2.919,0.534 z m 235.656,16.817 c -0.852,-0.316 -2.21,-2.225 -2.208,-3.105 0.008,-1.661 2.463,-4.367 3.984,-4.382 0.752,-0.005 2.81,1.064 3.579,1.864 1.394,1.45 1.09,3.83 -0.662,5.182 -0.862,0.666 -3.433,0.907 -4.692,0.44 z m 1.545,10.639 c -1.803,-0.61 -2.462,-1.492 -2.609,-3.49 -0.152,-2.083 0.05,-2.407 2.25,-3.607 l 1.569,-0.855 1.486,0.663 c 2.06,0.918 2.975,1.908 3.048,3.292 0.078,1.492 -1.029,3.018 -2.747,3.788 -1.508,0.676 -1.598,0.682 -2.997,0.21 z\" transform=\"translate(-225.92792,881.60599)\"/><path d=\"m 498.797,288.137 c -1.485,-0.047 -3.523,1.318 -4.692,2.01 -2.785,0.654 -6.026,2.365 -8.714,0.537 -2.648,-0.818 -6.17,-0.173 -6.57,3.084 0.68,2.796 4.598,4.394 6.972,2.547 1.762,-2.306 6.57,-3.659 7.105,0.268 -1.96,2.97 -1.737,6.902 -3.351,10.055 -0.263,1.964 -1.08,3.829 -2.145,5.497 -1.983,0.199 -4.092,-0.035 -5.765,1.206 -2.686,0.147 -5.426,1.482 -6.972,3.754 -1.73,2.48 -3.383,5 -3.888,8.044 0.46,3.11 4.022,4.002 6.704,4.156 2.86,0.788 5.724,1.82 8.58,2.682 4.656,1.042 9.018,2.725 13.675,3.753 6.797,2.05 13.934,2.992 20.78,4.827 0.718,0.238 1.39,0.445 2.145,0.536 2.842,0.59 4.324,-2.5 4.558,-4.826 1.41,-4.975 2.486,-10.035 3.888,-15.016 0.965,-1.997 2.13,-6.509 -1.742,-5.496 -2.21,1.324 -4.084,3.318 -6.838,3.485 -3.75,0.219 -1.61,4.055 -0.134,5.631 0.326,2.52 -0.471,5.53 -2.145,7.508 -2.23,1.414 -5.026,-0.24 -7.374,-0.804 -2.465,0.042 -7.393,-1.216 -5.094,-4.559 0.816,-2.475 0.888,-5.183 1.877,-7.641 1.259,-2.637 1.439,-5.514 2.01,-8.312 -1.55,-3.335 -4.198,1.097 -6.3,1.474 -1.45,1.007 -6.888,1.434 -4.023,4.022 2.468,1.875 0.576,5.134 0.134,7.508 -0.158,3.304 -3.594,4.093 -6.301,3.352 -2.693,-0.13 -6.441,-2.135 -4.156,-5.095 0.52,-2.467 1.381,-4.891 1.877,-7.374 1.018,-2.993 1.876,-5.846 2.95,-8.848 0.465,-2.66 1.42,-5.182 2.68,-7.508 0.075,-2.94 2.05,-5.47 2.011,-8.446 -0.2,-1.454 -0.851,-1.983 -1.742,-2.011 z M 483.38,319.24 c 0.35,-0.06 0.6,-0.008 0.938,0.134 1.071,0.456 1.103,1.327 0,2.28 -0.482,0.415 -1.03,0.816 -1.207,0.804 -2.006,-0.173 -2.598,-0.471 -2.68,-1.207 -0.075,-0.649 0.13,-0.835 1.474,-1.475 0.667,-0.318 1.124,-0.475 1.475,-0.536 z m -4.446,21.537 c -2.128,-2 -1.785,-3.46 1.361,-5.806 1.347,-1.003 2.163,-0.89 3.703,0.515 2.37,2.162 2.465,3.53 0.373,5.383 -1.034,0.916 -1.486,1.104 -2.69,1.116 -1.259,0.013 -1.616,-0.144 -2.747,-1.208 z m 13.085,3.947 a 3.688,3.688 0 0 1 -2.67,-4.666 c 0.55,-1.865 0.87,-2.048 3.604,-2.076 3.067,-0.03 3.662,0.483 3.691,3.183 0.017,1.52 -0.1,1.872 -0.857,2.576 -0.888,0.826 -2.596,1.271 -3.768,0.982 z m 382.293,0.343 c -0.974,-0.81 -1.17,-1.177 -1.181,-2.209 -0.013,-1.761 1.002,-3.053 3.2,-4.049 2.926,-1.325 4.118,-1.143 5.22,0.797 1.465,2.58 1.395,3.633 -0.36,5.371 -0.969,0.96 -1.15,1.016 -3.368,1.038 -2.177,0.013 -2.426,-0.045 -3.511,-0.948 z M 509.394,350 c -1.561,-0.416 -2.37,-1.588 -2.39,-3.46 -0.018,-1.433 0.086,-1.661 1.087,-2.445 0.65,-0.508 1.674,-0.943 2.482,-1.053 1.145,-0.157 1.564,-0.057 2.485,0.59 2.362,1.66 2.864,3.303 1.496,4.897 -1.457,1.697 -2.837,2.091 -5.16,1.471 z m 94.04,4.205 c -0.347,-0.432 -1.112,-0.687 -1.191,-1.232 0.137,-2.38 0.251,-4.79 1.01,-7.07 0.412,-2.244 0.05,-4.588 0.833,-6.773 0.802,-3.977 0.801,-8.077 1.725,-12.028 0.043,-2.035 0.236,-4.071 0.826,-6.03 0.676,-3.096 0.058,-6.333 0.97,-9.392 -0.098,-1.15 1.225,-4.218 2.387,-2.4 1.687,2.473 3.91,4.483 6.096,6.5 1.878,1.084 0.154,2.68 -1.144,3.217 -1.781,0.702 -2.214,2.664 -2.088,4.385 -0.25,1.779 -0.963,3.462 -1.036,5.277 -0.377,2.67 -0.303,5.383 -0.65,8.05 -0.781,2.613 -0.482,5.405 -0.743,8.098 0.034,1.71 -0.778,3.263 -0.666,4.979 -0.208,1.74 -0.286,3.836 -1.747,5.03 -1.41,0.712 -3.45,0.589 -4.583,-0.611 z M 730.85,312.161 c -2.069,1.565 -3.919,3.412 -5.765,5.23 -2.542,1.925 2.088,3.045 2.681,4.692 0.675,2.515 0.635,5.193 0.805,7.776 0.769,2.365 1.108,4.884 0.938,7.374 -0.222,2.67 -3.704,2.107 -5.228,3.62 -2.11,0.888 -2.952,2.962 -4.559,4.423 -1.056,2.071 -1.339,4.618 -1.474,6.972 0.151,1.921 -1.298,4.072 0,5.765 0.167,0.239 0.365,0.566 0.536,0.804 0.434,0.623 1.47,0.126 2.145,0.268 2.16,-0.12 4.412,0.203 6.435,-0.67 5.191,-0.898 10.43,-0.97 15.686,-1.207 3.214,0.103 6.307,-1.016 9.519,-0.938 2.517,0.557 3.65,-2.172 3.62,-4.156 -1.426,-2.804 -0.194,-6.129 -1.341,-8.983 -1.008,-2.885 -0.611,-6.126 -1.073,-9.116 -0.063,-2.353 -3.049,-3.225 -4.558,-1.475 -1.465,1.48 -3.83,1.776 -4.96,3.62 -1.273,2.584 2.691,2.587 3.351,4.558 0.755,1.992 0.508,4.207 0.67,6.301 0.49,2.542 -2.27,2.687 -4.021,2.95 -2.303,0.863 -5.535,1.44 -6.838,-1.34 -0.819,-2.058 -0.707,-4.26 -0.938,-6.436 -0.057,-3.826 -0.977,-7.587 -1.207,-11.395 -0.22,-4.706 -1.033,-9.381 -1.34,-14.077 -0.044,-1.954 -0.304,-5.14 -3.084,-4.558 z m -2.681,35.394 1.34,0.134 0.134,1.609 0.134,1.608 -1.743,0.537 c -0.923,0.273 -1.73,0.404 -1.742,0.402 a 10.938,10.938 0 0 1 -0.805,-0.537 c -0.942,-0.68 -0.701,-1.651 0.536,-2.949 0.698,-0.73 1.025,-0.872 2.145,-0.804 z M 599.615,307.743 c -1.63,0.579 -3.7,2.973 -5.362,2.95 -3.776,0.266 -3.249,3.943 -0.537,5.228 0.358,1.115 0.022,2.522 0.134,3.754 0.527,3.387 -1.61,6.113 -1.206,9.519 -0.19,3.733 -1.317,7.369 -1.475,11.127 -1.06,3.876 -1.072,7.86 -1.743,11.798 -0.447,3.532 -3.001,2.286 -5.229,1.341 -0.017,-1.531 -0.116,-3.027 -0.134,-4.558 0.929,-3.506 -1.892,-4.529 -4.692,-4.96 -2.944,0.278 -4.388,-2.245 -3.754,-4.827 1.265,-1.506 4.445,-1.087 6.435,-1.34 4.21,0.872 4.04,-4.77 1.877,-6.704 -1.479,-2.727 -5.14,-3.9 -6.167,-6.703 0.41,-3.717 -2.058,-7.432 -5.094,-9.25 -4.67,-0.328 -8.196,3.702 -9.921,7.641 -1.942,0.561 -3.878,1.144 -5.765,1.877 -3.042,0.761 -7.378,6.036 -3.218,8.044 2.335,0.643 9.44,2.264 6.301,5.496 -1.768,3.034 -5.152,3.086 -8.178,2.28 -3.104,0.002 -6.56,-1.51 -6.435,-5.095 -0.633,-3.217 -0.529,-6.684 -2.01,-9.653 -0.638,-3.6 -4.723,-2.758 -4.961,0.536 -3.146,2.292 -2.727,5.997 -0.536,8.715 1.367,3.127 0.013,6.768 -1.34,9.652 -0.82,3.754 -4.96,3.882 -7.911,5.095 -1.448,0.562 -6.986,-0.334 -4.96,2.815 3.23,1.14 7.09,2.166 10.457,1.34 3.53,-0.437 6.596,-2.851 8.312,-5.898 2.371,-2.403 6.444,-1.145 9.519,-1.207 3.315,-0.008 6.704,2.328 9.92,0.805 0.933,-2.421 5.243,-6.417 6.57,-2.28 -0.226,3.702 3.043,5.688 6.435,5.23 3.706,-0.212 2.336,2.62 2.28,4.826 0.244,4.009 2.83,6.112 6.166,7.776 1.137,0.306 2.338,0.203 3.486,0 3.209,-1.009 6.665,-2.44 7.642,-6.033 1.302,-2.92 1.333,-6.224 2.279,-9.25 0.76,-4.848 1.741,-9.696 1.877,-14.613 1.184,-4.455 0.844,-9.164 1.742,-13.675 0.568,-3.354 0.99,-6.707 1.341,-10.055 -0.393,-1.79 -1.166,-2.09 -2.145,-1.743 z m -29.092,17.83 c 0.65,0.08 1.01,0.876 1.073,2.28 0.068,1.561 0.885,2.834 1.877,3.083 0.782,0.196 0.715,1.025 -0.134,1.609 -0.494,0.34 -1.377,0.545 -2.95,0.536 -2.48,-0.013 -4.017,-0.655 -5.362,-2.011 l -0.805,-0.804 1.207,-0.805 a 27.579,27.579 0 0 0 2.413,-2.145 c 1.222,-1.247 2.032,-1.822 2.681,-1.743 z m 283.282,-33.79 c -2.433,0.112 -4.879,0.506 -7.105,1.073 -4.463,-0.278 -6.703,4.406 -2.413,6.703 2.58,6.583 6.608,-1.359 10.725,-0.804 6.167,1.2 6.688,7.86 7.642,12.87 0.347,4.963 1.777,9.789 3.217,14.48 4.128,4.588 -3.092,7.465 -6.167,3.887 -2.622,-2.85 -8.239,-6.347 -11.395,-2.413 -3.877,1.642 -4.036,6.823 -7.24,8.312 -5.187,1.58 -5.84,-4.8 -8.58,-7.507 -2.52,-3.537 -7.338,-3.846 -11.262,-5.095 -1.84,-3.727 -0.881,-10.063 -4.692,-12.602 -3.2,1.305 -9.066,7.302 -4.156,10.055 4.795,4.121 -2.093,6.01 -4.29,8.848 -3.139,3.495 -3.64,8.306 -4.157,12.737 -5.402,2.984 -6.454,-3.38 -7.105,-7.374 -0.42,-4.768 -4.444,-3.369 -7.24,-1.609 -4.086,1.656 -6.126,5.536 -8.982,8.58 -0.343,2.779 0.16,5.82 0.134,8.715 0.928,3.48 5.158,1.846 7.776,1.608 4.199,-1.756 5.918,2.692 2.547,5.23 -2.282,2.9 -9.523,1.385 -8.848,6.032 2.333,0.273 4.764,0.185 7.105,0 4.678,-1.278 9.701,-4.579 10.189,-9.787 0.616,-4.54 7.154,-3.713 10.725,-4.692 4.465,-1.287 9.845,-1.618 10.86,4.022 3.043,3.196 9.646,6.795 13.004,2.413 3.408,-2.082 5.046,-5.739 4.826,-9.653 -0.695,-3.366 5.443,-3.488 6.971,-1.609 2.237,3.681 9.228,2.595 12.603,0.537 3.587,-2.648 4.365,-7.315 9.519,-7.374 7.646,-2.29 15.59,-3.61 23.059,-6.435 6.05,-1.319 -0.9,-5.139 -2.413,-7.374 -4.607,-2.278 -8.615,7.044 -13.81,2.413 -4.013,-3.072 -3.74,-8.909 -5.228,-13.407 -1.017,-5.823 -0.76,-12.538 -4.96,-17.16 -2.885,-3.067 -6.804,-3.806 -10.86,-3.62 z m -29.226,40.623 c 0.54,-0.013 1.148,0.254 2.145,0.804 1.88,1.038 3.22,2.758 3.217,4.156 -10e-4,0.912 -0.233,0.974 -1.608,1.609 -0.846,0.39 -1.808,0.809 -2.146,0.804 -0.776,-0.008 -2.678,-1.53 -2.68,-2.145 -0.004,-0.255 -0.25,-1.229 -0.537,-2.01 -0.505,-1.376 -0.427,-1.358 0.268,-2.28 0.444,-0.59 0.801,-0.924 1.34,-0.938 z m 28.02,1.474 c 1.597,-0.104 2.546,0.394 3.217,1.61 0.78,1.41 0.25,2.492 -1.743,3.35 -0.873,0.378 -1.746,0.684 -1.877,0.671 -0.131,-0.013 -0.851,-0.44 -1.609,-0.938 -1.158,-0.763 -1.327,-1.132 -1.34,-2.011 -0.013,-1.353 1.498,-2.56 3.351,-2.682 z m -38.344,0.402 c 0.468,-0.072 0.894,0.172 1.475,0.67 0.772,0.664 1.016,1.197 1.207,2.548 0.134,0.939 0.113,2.153 0,2.681 -0.209,0.97 -0.229,0.926 -2.413,0.939 -2.747,0.026 -3.002,-0.274 -2.95,-2.816 0.034,-1.616 0.05,-2.051 0.939,-2.949 0.688,-0.696 1.275,-1 1.742,-1.073 z m -23.595,6.168 c 0.856,0.2 1.664,0.847 1.877,1.876 0.281,1.363 0.034,1.983 -1.073,2.548 -0.953,0.485 -3.149,0.647 -3.754,0.268 -0.196,-0.123 -0.6,-0.442 -0.804,-0.805 -0.292,-0.52 -0.238,-0.77 0.134,-1.072 0.26,-0.211 0.538,-0.514 0.536,-0.67 -0.002,-0.157 0.289,-0.7 0.67,-1.207 0.627,-0.832 1.558,-1.14 2.413,-0.938 z m 39.683,5.094 c 0.764,-0.004 1.41,0.261 1.877,0.67 0.795,0.697 0.768,1.718 -0.134,2.414 -0.58,0.447 -3.74,0.406 -4.826,0 -0.484,-0.181 -0.668,-0.424 -0.67,-0.939 -0.009,-0.604 0.16,-0.977 1.206,-1.475 0.877,-0.418 1.784,-0.665 2.548,-0.67 z m -73.666,20.673 c -0.411,-0.268 -1.02,-0.502 -0.407,-0.95 0.741,-1.298 2.222,-1.747 3.537,-2.23 2.35,-1.018 4.379,-2.747 5.893,-4.798 0.214,-1.429 1.818,-2.204 1.811,-3.697 0.013,-2.038 0.134,-4.126 -0.363,-6.118 -0.55,-1.826 -1.937,-3.226 -3.546,-4.178 -1.1,-0.865 -2.891,-1.103 -3.298,-2.635 -0.225,-1.47 1.088,-2.59 1.547,-3.9 0.958,-1.81 1.764,-3.706 2.793,-5.47 1.111,-1.235 2.826,-0.068 3.401,1.125 0.812,1.191 1.531,2.47 1.934,3.85 1.297,1.424 2.447,3.093 2.913,4.985 0.637,1.332 1.644,2.584 1.585,4.144 0,1.787 1.008,3.378 0.945,5.175 0.057,2.405 0.056,4.912 -0.823,7.182 -0.6,1.26 -1.804,2.015 -2.602,3.143 -1.368,1.268 -2.876,2.484 -4.632,3.158 -1.24,0.395 -1.96,1.826 -3.515,1.479 -2.207,0.039 -4.447,0.339 -6.637,-0.017 0.138,0.232 -0.671,-0.393 -0.536,-0.246 z m -29.387,1.931 c -1.042,-1.071 -1.267,-1.525 -1.279,-2.576 -0.012,-1.062 0.192,-1.483 1.211,-2.513 1.88,-1.899 2.8,-1.945 6.045,-0.302 3.102,1.57 4.151,1.712 4.429,0.6 0.268,-1.073 2.054,-2.055 3.75,-2.062 1.073,-0.009 1.68,0.205 2.54,0.874 1.078,0.84 1.13,0.97 1.158,2.914 0.017,1.987 -0.009,2.062 -1.246,3.158 -1.19,1.047 -1.381,1.111 -2.855,0.964 -1.876,-0.189 -3.001,-1.047 -3.307,-2.525 -0.221,-1.072 -0.598,-1.328 -0.88,-0.6 -0.09,0.235 -0.552,0.524 -1.025,0.643 -0.873,0.22 -2.355,1.152 -3.407,2.145 -0.398,0.375 -1.095,0.552 -2.225,0.563 -1.526,0.013 -1.738,-0.078 -2.91,-1.283 z m -85.03,-38.182 c -2.852,0.03 -5.923,2.429 -6.302,5.228 0.652,3.228 3.333,6.39 1.609,9.787 1.19,4.346 -3.267,5.995 -6.302,3.486 -1.832,-4.167 -2.76,-8.734 -5.496,-12.468 -3.45,-0.977 -4.953,4.534 -7.374,6.435 1.2,3.24 4.701,6.145 5.094,10.189 0.838,3.925 -1.55,8.282 -4.96,10.323 -2.942,2.809 -6.973,1.805 -10.591,2.413 -4.394,2.568 3.225,3.507 5.229,3.62 4.494,0.457 9.16,-0.136 12.467,-3.486 3.3,-1.575 3.045,-7.281 6.972,-7.91 6.814,-0.304 13.568,1.045 20.378,1.207 3.644,0.872 9.282,-0.434 11.798,2.279 0.008,4.751 4.036,7.681 7.91,9.519 2.14,0.595 4.394,-2.057 6.569,-2.548 4.141,-1.32 2.882,-6.443 5.363,-8.446 7.08,-0.383 14.227,-0.302 21.316,-0.402 1.35,0.034 1.748,-1.887 2.682,-2.681 -0.156,-2.74 -0.255,-5.46 -0.67,-8.178 -1.366,-3.46 0.22,-7.914 -2.28,-10.86 -3.56,-0.97 -6.59,2.29 -10.189,2.548 -3.973,1.77 -7.32,5.439 -7.507,9.92 -2.353,3.847 -6.125,-0.684 -4.827,-3.887 -0.148,-1.396 0.302,-3.022 -0.134,-4.29 -2.175,-2.61 -5.983,-1.757 -8.982,-2.145 -4.37,0.174 -8.635,-0.77 -13.005,-0.67 -3.83,-0.29 -7.816,0.333 -11.53,-0.67 -4.425,-0.127 -3.816,-4.455 -4.558,-7.509 -0.785,-0.582 -1.73,-0.814 -2.68,-0.804 z m 8.58,15.82 c 1.471,0.03 2.859,0.222 4.29,0.401 1.848,0.305 3.817,-0.635 5.63,0 4.19,0.713 8.381,0.545 12.603,0.939 1.114,-0.017 1.912,0.792 2.68,1.475 0.01,2.932 0.004,5.915 0,8.848 -0.127,1.105 0.328,2.566 -0.67,3.352 -0.32,0.22 -0.679,0.46 -1.072,0.536 -1.161,-0.3 -2.39,-1.064 -2.95,-2.145 -0.177,-1.534 0.077,-3.02 0.134,-4.558 -0.03,-0.398 0.174,-1.017 0,-1.341 -0.912,-0.647 -1.947,-1.068 -3.083,-1.073 -3.644,-0.125 -7.216,-0.393 -10.86,-0.536 -3.032,-0.191 -6.148,0.26 -9.116,-0.536 -1.151,-0.419 -2.65,-0.275 -3.351,-1.475 -1.005,-1.168 0.444,-2.56 1.474,-3.083 1.366,-0.621 2.819,-0.833 4.29,-0.805 z m 48.396,1.072 c 0.681,-0.009 0.898,0.214 1.207,1.475 0.197,0.805 0.427,1.79 0.536,2.145 0.156,0.506 -0.093,0.67 -0.804,0.938 -2.12,0.8 -4.229,0.72 -4.96,-0.268 -0.333,-0.448 0.055,-1.864 0.67,-2.413 1.242,-1.11 2.616,-1.875 3.351,-1.877 z\" transform=\"translate(-225.92792,881.60599)\"/></g></g><g transform=\"matrix(4.29012,0,0,4.29012,-1476.4279,-417.98899)\" stroke-width=\"1.27\"><path d=\"m 462.31,253.09 c 0.667,0.04 -0.902,-3.568 -0.902,-3.568 1.765,1.804 8.43,2.235 8.43,2.235 -4,-1.766 -7.998,-15.096 -7.528,-25.721 0.432,-10.664 -1.528,-14.86 -3.097,-16.428 -2,-2 -8.43,-3.764 -12.664,-4 -2.392,-0.117 -2,1.804 -2,1.804 -4.43,-1.137 -8.86,-1.568 -10.86,-0.235 -1.883,1.255 -2.275,7.528 -0.902,6.43 3.332,-2.666 6.234,-0.235 8.233,2.666 1.764,2.549 1.647,9.763 -0.902,18.192 -2.666,8.861 -9.959,17.722 -9.959,17.722 3.96,0 9.528,-3.528 9.528,-3.528 l -1.333,5.528 c 4.195,-2 7.528,-5.097 7.528,-5.097 l 3.999,4.195 c 1.333,-1.764 4,-4.195 4,-4.195 0,0 3.332,3.529 8.429,4 z\" stroke-width=\"1.218\"/><path d=\"m 446.12,227.57 c 0,0 -2.235,16.428 -6.43,21.094 m 9.96,-21.524 c 0,0 -0.863,16.623 -3.764,21.956 m 6.894,-21.286 c 0,0 0,18.192 1.098,21.289 m 2.862,-20.389 c 0,0 0.902,15.291 4.666,20.819\" fill=\"none\"/><path d=\"m 442.08,219.61 c -0.196,-1.45 -0.549,-2.588 -1.059,-3.333 -2,-2.901 -4.9,-5.332 -8.233,-2.666 0,0 1.137,-3.529 3.568,-3.646 1.882,-0.118 6.155,1.411 9.92,7.841 0,0 -2.784,-0.627 -3.45,-0.039 -1.256,1.098 -0.746,1.843 -0.746,1.843 z\" fill=\"${GOLD_DARK}\" stroke-width=\".354\"/><path d=\"m 432.44,209.26 c 0.274,-0.902 0.706,-1.725 1.255,-2.078 2,-1.333 6.43,-0.902 10.86,0.235 0,0 -0.392,-1.921 2,-1.803 4.234,0.235 10.664,2 12.663,3.999 0.47,0.51 1.02,1.255 1.49,2.391 h -0.078 c -0.98,-1.372 -3.764,-1.293 -4.431,-1.215 -1.059,0.118 -1.725,0.078 -3.137,0.431 -0.666,0.157 -1.686,0.353 -2.235,0.784 -0.43,0.353 -0.784,1.647 -1.45,1.647 -1.059,0 -0.98,-0.274 -1.255,-0.588 -0.353,-0.431 -0.549,-1.059 -0.902,-1.02 -1.097,0.197 -2.862,-0.666 -5.096,-2.43 -2.235,-1.765 -3.098,-2.196 -5.999,-2 -2.862,0.235 -3.764,1.843 -3.764,1.843 z\" fill=\"${GOLD_DARK}\" stroke-width=\".354\"/><circle cx=\"448.824\" cy=\"210.672\" r=\"1.176\" stroke=\"none\"/></g><path d=\"m 449.98,327.23 c 32.642,-25.106 29.843,-61.883 29.843,-61.883 -0.8613,0.17223 -1.6795,0.25835 -2.5408,0.25835 -6.8471,0 -23.178,-3.9171 -26.988,-8.8926 -4.0812,4.5034 -20.77,8.8926 -27.574,8.8926 -0.86129,0 -1.7225,-0.0861 -2.5407,-0.25835 0,0 -2.8422,36.776 29.8,61.883 z\" transform=\"matrix(4.2901418,0,0,4.2901418,-1476.4363,-417.99538)\" stroke-width=\"1.15\"/><path d=\"m 477.22,268.04 c -0.28097,0.0176 -0.5633,0.0264 -0.8477,0.0264 -6.2055,0 -20.619,-3.1838 -26.175,-7.9572 -5.8195,4.4095 -20.471,7.9572 -26.576,7.9572 -0.28635,0 -0.56925,-0.035 -0.84965,-0.0865 -0.0142,1.3908 0.0581,2.8324 0.14448,4.1436 0.323,4.9008 1.1826,9.819 2.4876,14.552 4.1081,14.895 12.516,27.553 24.572,37.155 12.066,-9.61 20.484,-22.28 24.601,-37.186 1.3071,-4.7319 2.1694,-9.6497 2.4955,-14.55 0.0763,-1.3719 0.15265,-3.05185 0.14777,-4.0545 z\" transform=\"matrix(4.2901418,0,0,4.2901418,-1476.4363,-417.99538)\" fill=\"none\" stroke-width=\".916\"/></g></g>";

let coaIdCounter = 0;

/** The eagle's artwork on its native canvas, with its own pair of ids for the mirrored wing feathers. */
function eagleArt(idA: string, idB: string): string {
  return COA_EAGLE_MARKUP.replaceAll("${GOLD}", GOLD)
    .replaceAll("${GOLD_DARK}", GOLD_DARK)
    .replaceAll("${idA}", idA)
    .replaceAll("${idB}", idB);
}

/**
 * The real eagle, its native 600×815.143 canvas centred on `(cx, cy)` and scaled to `h` tall.
 * `shared`: point at the board's one copy of the artwork (`EAGLE_ART_ID`) instead of drawing it here.
 */
function egyptEagle(cx: number, cy: number, h: number, shared: boolean): string {
  const nativeWidth = 600;
  const nativeHeight = 815.143;
  const s = h / nativeHeight;
  const tx = cx - (nativeWidth * s) / 2;
  const ty = cy - (nativeHeight * s) / 2;
  let inner: string;
  if (shared) {
    inner = `<use href="#${EAGLE_ART_ID}"/>`;
  } else {
    inner = eagleArt(`phx-coa-a-${coaIdCounter}`, `phx-coa-b-${coaIdCounter}`);
    coaIdCounter += 1;
  }
  return `<g transform="translate(${f(tx)},${f(ty)}) scale(${f(s)})">${inner}</g>`;
}

// ── The real Egyptian crossed-sabres device, traced from Wikimedia Commons' "Egypt_Army_-_OF07.svg"
// (Military ranks of Egypt, uploader Punkhung) — CC BY-SA 4.0, Attribution-ShareAlike. Credit per the
// licence: artwork by Punkhung, https://commons.wikimedia.org/wiki/File:Egypt_Army_-_OF07.svg, used
// and adapted (recoloured to this file's house gold) under CC BY-SA 4.0
// (https://creativecommons.org/licenses/by-sa/4.0/). Unlike the eagle above (Public Domain) and the
// star's proportions below (a bare ratio, not protectable expression), THIS is copied expression —
// the owner weighed that explicitly ("I want real swords and stars") against the eighth pass's
// hand-traced original, and chose the real artwork. ShareAlike's practical bite is on
// DISTRIBUTING this adapted work, not on running it as a hosted app; it does not touch the rest of
// this proprietary codebase. `${SWORD_LIGHT}` / `${SWORD_MID}` / `${GOLD_DARK}` / `${swordId}` are
// literal placeholder text, not a template expression — `crossedSwords()` below fills them in at call
// time, same reason as the eagle's `${idA}`/`${idB}`: every one of the ten embedded gradients needs
// an id unique to its own badge, or a second sword badge on the same page (the rank board shows many
// ranks at once) resolves to the first badge's gradients.
const REAL_SWORD_LEFT_MARKUP = "<g xmlns=\"http://www.w3.org/2000/svg\">\n\n\t\t\t\t<linearGradient id=\"path9648-3-${swordId}\" gradientUnits=\"userSpaceOnUse\" x1=\"-49.3713\" y1=\"-486.4355\" x2=\"-89.4711\" y2=\"-410.7022\" gradientTransform=\"matrix(0.9848 -0.1736 -0.1736 -0.9848 51.2391 -21.307)\">\n\t\t\t\t<stop offset=\"0\" style=\"stop-color:${SWORD_LIGHT}\"/>\n\t\t\t\t<stop offset=\"1\" style=\"stop-color:${SWORD_MID}\"/>\n\t\t\t</linearGradient>\n\t\t\t<path id=\"path9648_2_\" fill=\"url(#path9648-3-${swordId})\" stroke=\"${GOLD_DARK}\" stroke-width=\"0.6784\" d=\"     M42.559,443.289c1.04-0.671,2.086-1.298,3.151-1.831c1.203-0.601,2.421-1.116,3.649-1.547c1.231-0.434,2.472-0.783,3.725-1.058     c1.248-0.273,2.511-0.469,3.781-0.589c1.269-0.123,2.544-0.167,3.829-0.146c1.283,0.02,2.572,0.108,3.864,0.264     c1.292,0.153,2.591,0.371,3.891,0.647c1.298,0.277,2.6,0.618,3.902,1.008c1.301,0.392,2.602,0.838,3.9,1.335     c1.3,0.499,2.596,1.046,3.891,1.641c2.591,1.191,5.163,2.559,7.704,4.078c2.541,1.521,5.054,3.181,7.519,4.959     c2.463,1.776,4.881,3.663,7.236,5.623c2.356,1.959,4.649,3.989,6.865,6.063c2.216,2.073,4.356,4.178,6.403,6.287     c2.044,2.109,3.996,4.218,5.838,6.291c1.845,2.075,3.577,4.113,5.186,6.076c1.612,1.967,3.095,3.861,4.441,5.646     c1.344,1.783,2.548,3.458,3.596,4.988c1.049,1.532,1.94,2.914,2.662,4.12c0.722,1.202,1.271,2.22,1.633,3.024l-0.078,1.815     l-1.131,0.751c-18.72-32.031-63.39-75.774-95.724-58.814C42.356,443.689,42.485,443.509,42.559,443.289z\"/>\n\n\t\t\t\t<linearGradient id=\"path9650-3-${swordId}\" gradientUnits=\"userSpaceOnUse\" x1=\"-37.5256\" y1=\"-491.5791\" x2=\"-94.9791\" y2=\"-417.7486\" gradientTransform=\"matrix(0.9848 -0.1736 -0.1736 -0.9848 51.2391 -21.307)\">\n\t\t\t\t<stop offset=\"0\" style=\"stop-color:${SWORD_LIGHT}\"/>\n\t\t\t\t<stop offset=\"1\" style=\"stop-color:${SWORD_MID}\"/>\n\t\t\t</linearGradient>\n\t\t\t<path id=\"path9650_2_\" fill=\"url(#path9650-3-${swordId})\" stroke=\"${GOLD_DARK}\" stroke-width=\"0.6784\" d=\"     M51.217,434.432c4.222-1.828,9.262-2.501,13.852-2.543c31.301-0.271,69.503,42.74,81.918,64.894l-7.84,5.197l0.078-1.818     c-0.362-0.803-0.91-1.82-1.632-3.022c-0.722-1.205-1.613-2.59-2.663-4.117c-1.049-1.528-2.251-3.208-3.595-4.991     c-1.347-1.785-2.83-3.678-4.44-5.643c-1.609-1.967-3.342-4.005-5.187-6.076c-1.844-2.074-3.795-4.184-5.838-6.293     c-2.048-2.108-4.187-4.217-6.403-6.287c-2.218-2.074-4.511-4.105-6.865-6.064c-2.354-1.961-4.773-3.847-7.238-5.623     c-2.463-1.774-4.976-3.438-7.519-4.959c-2.54-1.518-5.114-2.891-7.702-4.076c-1.295-0.595-2.593-1.142-3.893-1.64     c-1.297-0.5-2.599-0.946-3.9-1.336c-1.303-0.39-2.603-0.73-3.9-1.008c-1.303-0.278-2.599-0.497-3.892-0.647     c-1.293-0.154-2.582-0.244-3.864-0.264c-1.284-0.021-2.561,0.029-3.83,0.146c-1.268,0.124-2.529,0.315-3.781,0.59     c-1.255,0.271-2.493,0.623-3.723,1.056c-1.23,0.432-2.446,0.947-3.649,1.548c-1.064,0.533-2.11,1.16-3.151,1.831     C43.995,439.006,47.205,436.173,51.217,434.432z\"/>\n\n\t\t\t\t<linearGradient id=\"path9652-3-${swordId}\" gradientUnits=\"userSpaceOnUse\" x1=\"-0.5613\" y1=\"-539.293\" x2=\"23.4075\" y2=\"-539.293\" gradientTransform=\"matrix(0.9848 -0.1736 -0.1736 -0.9848 51.2391 -21.307)\">\n\t\t\t\t<stop offset=\"0\" style=\"stop-color:${SWORD_LIGHT}\"/>\n\t\t\t\t<stop offset=\"1\" style=\"stop-color:${SWORD_MID}\"/>\n\t\t\t</linearGradient>\n\n\t\t\t\t<path id=\"path9652_2_\" fill=\"url(#path9652-3-${swordId})\" stroke=\"${GOLD_DARK}\" stroke-width=\"0.6784\" d=\"     M147.432,497.034c0.411,0.556,0.817,1.118,1.228,1.679c1.989,0.336,3.343,1.524,3.398,4.421c2.646-0.088,3.515,1.496,3.699,3.673     c2.713-0.813,3.901,0.935,5.08,2.724c2.141,0.654,4.59,0.839,7.464,0.376l1.742,7.762l-5.375,0.704l-16.191-7.291l-5.587-9.377     L147.432,497.034z\"/>\n\t\t\t<path id=\"path9654_2_\" fill=\"none\" stroke=\"${GOLD_DARK}\" stroke-width=\"0.6784\" d=\"     M152.062,502.935l-0.482,7.464\"/>\n\t\t\t<path id=\"path9656_2_\" fill=\"none\" stroke=\"${GOLD_DARK}\" stroke-width=\"0.6784\" d=\"M160.8,509.274     l-0.482,7.462\"/>\n\t\t\t<path id=\"path9658_2_\" fill=\"none\" stroke=\"${GOLD_DARK}\" stroke-width=\"0.6784\" d=\"     M155.839,506.628l-0.481,7.463\"/>\n\n\t\t\t\t<linearGradient id=\"path9660-3-${swordId}\" gradientUnits=\"userSpaceOnUse\" x1=\"-4.1614\" y1=\"-541.7036\" x2=\"38.2066\" y2=\"-546.1952\" gradientTransform=\"matrix(0.9848 -0.1736 -0.1736 -0.9848 51.2391 -21.307)\">\n\t\t\t\t<stop offset=\"0\" style=\"stop-color:${SWORD_LIGHT}\"/>\n\t\t\t\t<stop offset=\"1\" style=\"stop-color:${SWORD_MID}\"/>\n\t\t\t</linearGradient>\n\n\t\t\t\t<path id=\"path9660_2_\" fill=\"url(#path9660-3-${swordId})\" stroke=\"${GOLD_DARK}\" stroke-width=\"0.6784\" stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"     M144.367,500.808c6.217,5.895,8.975,14.537,23.405,13.898c-1.974-1.234-3.488,0.279-6.138-3.802     c-2.826-4.357,2.964-11.793,8.79-6.374c3.293,3.063,6.811,7.23,3.049,14.032c-3.671,6.629-12.201,4.892-18.648,1.366     c-6.043-3.305-10.747-9.928-15.456-16.519\"/>\n\n\t\t\t\t<linearGradient id=\"path9662-3-${swordId}\" gradientUnits=\"userSpaceOnUse\" x1=\"-14.4978\" y1=\"-529.1069\" x2=\"15.7366\" y2=\"-529.1069\" gradientTransform=\"matrix(0.9848 -0.1736 -0.1736 -0.9848 51.2391 -21.307)\">\n\t\t\t\t<stop offset=\"0\" style=\"stop-color:${SWORD_LIGHT}\"/>\n\t\t\t\t<stop offset=\"1\" style=\"stop-color:${SWORD_MID}\"/>\n\t\t\t</linearGradient>\n\n\t\t\t\t<path id=\"path9662_2_\" fill=\"url(#path9662-3-${swordId})\" stroke=\"${GOLD_DARK}\" stroke-width=\"0.6784\" d=\"     M137.202,502.775l-3.367,2.297c-2.95,2.014-4.021,5.869-3.037,7.43c1.455,2.311,3.685,3.099,5.795,2.502     c2.549-0.719,3.353-4.865,1.879-6.481c-2.437-2.666-4.253-0.256-4.46,0.247c-0.494,1.209-0.202,2.481,0.614,1.506     c1.491-1.788,2.374,0.452,1.854,1.23c-0.74,1.114-1.896,0.727-2.465,0.275c-1.829-1.442-0.534-3.816,0.411-4.451l2.943-1.986     l12.889-8.855l3.361-2.254c2.95-2.012,4.021-5.864,3.037-7.426c-1.453-2.311-3.685-3.099-5.795-2.503     c-2.551,0.72-3.353,4.865-1.879,6.481c2.437,2.668,4.253,0.252,4.46-0.249c0.495-1.203,0.2-2.479-0.611-1.506     c-1.495,1.788-2.375-0.45-1.857-1.231c0.742-1.113,1.896-0.726,2.468-0.272c1.828,1.443,0.533,3.814-0.411,4.451l-2.944,1.987     c-4.754,3.208-8.568,0.98-11.929-1.842C139.822,495.897,140.597,500.459,137.202,502.775L137.202,502.775z\"/>\n\t\t</g>";
const REAL_SWORD_RIGHT_MARKUP = "<g xmlns=\"http://www.w3.org/2000/svg\">\n\n\t\t\t\t<linearGradient id=\"path9648-4-${swordId}\" gradientUnits=\"userSpaceOnUse\" x1=\"-48.2888\" y1=\"-486.627\" x2=\"-88.3885\" y2=\"-410.8938\" gradientTransform=\"matrix(-0.9848 -0.1736 0.1736 -0.9848 177.2516 -21.307)\">\n\t\t\t\t<stop offset=\"0\" style=\"stop-color:${SWORD_LIGHT}\"/>\n\t\t\t\t<stop offset=\"1\" style=\"stop-color:${SWORD_MID}\"/>\n\t\t\t</linearGradient>\n\t\t\t<path id=\"path9648_1_\" fill=\"url(#path9648-4-${swordId})\" stroke=\"${GOLD_DARK}\" stroke-width=\"0.6784\" d=\"     M185.098,443.921c-32.334-16.96-77.004,26.783-95.724,58.814l-1.131-0.751l-0.079-1.815c0.363-0.805,0.911-1.822,1.633-3.024     c0.721-1.206,1.613-2.588,2.662-4.12c1.048-1.53,2.251-3.205,3.595-4.988c1.347-1.784,2.829-3.679,4.441-5.646     c1.608-1.963,3.341-4.001,5.186-6.076c1.842-2.073,3.794-4.182,5.838-6.291c2.047-2.109,4.188-4.214,6.402-6.287     c2.217-2.074,4.51-4.104,6.866-6.063c2.355-1.96,4.773-3.847,7.236-5.623c2.465-1.778,4.978-3.438,7.519-4.959     c2.541-1.52,5.113-2.887,7.704-4.078c1.295-0.595,2.591-1.142,3.891-1.641c1.299-0.497,2.6-0.943,3.9-1.335     c1.303-0.39,2.604-0.73,3.902-1.008c1.3-0.276,2.599-0.494,3.891-0.647c1.292-0.155,2.581-0.244,3.864-0.264     c1.285-0.021,2.561,0.023,3.829,0.146c1.271,0.12,2.533,0.315,3.781,0.589c1.253,0.274,2.493,0.624,3.725,1.058     c1.229,0.431,2.446,0.946,3.649,1.547c1.065,0.533,2.111,1.16,3.151,1.831C184.906,443.509,185.035,443.689,185.098,443.921z\"/>\n\n\t\t\t\t<linearGradient id=\"path9650-4-${swordId}\" gradientUnits=\"userSpaceOnUse\" x1=\"-36.4421\" y1=\"-491.769\" x2=\"-93.8956\" y2=\"-417.9385\" gradientTransform=\"matrix(-0.9848 -0.1736 0.1736 -0.9848 177.2516 -21.307)\">\n\t\t\t\t<stop offset=\"0\" style=\"stop-color:${SWORD_LIGHT}\"/>\n\t\t\t\t<stop offset=\"1\" style=\"stop-color:${SWORD_MID}\"/>\n\t\t\t</linearGradient>\n\t\t\t<path id=\"path9650_1_\" fill=\"url(#path9650-4-${swordId})\" stroke=\"${GOLD_DARK}\" stroke-width=\"0.6784\" d=\"     M184.832,443.285c-1.041-0.671-2.087-1.298-3.151-1.831c-1.203-0.601-2.419-1.116-3.649-1.548     c-1.229-0.433-2.468-0.784-3.723-1.056c-1.252-0.274-2.514-0.466-3.781-0.59c-1.27-0.117-2.546-0.168-3.83-0.146     c-1.282,0.02-2.571,0.109-3.864,0.264c-1.293,0.15-2.589,0.369-3.892,0.647c-1.298,0.277-2.598,0.618-3.9,1.008     c-1.302,0.39-2.604,0.836-3.9,1.336c-1.3,0.498-2.598,1.045-3.893,1.64c-2.588,1.186-5.162,2.559-7.702,4.076     c-2.543,1.521-5.056,3.185-7.519,4.959c-2.465,1.776-4.885,3.662-7.238,5.623c-2.354,1.959-4.647,3.99-6.866,6.064     c-2.216,2.07-4.354,4.179-6.402,6.287c-2.043,2.109-3.994,4.219-5.838,6.293c-1.844,2.071-3.577,4.109-5.186,6.076     c-1.611,1.965-3.094,3.857-4.441,5.643c-1.344,1.783-2.546,3.463-3.595,4.991c-1.05,1.527-1.941,2.912-2.663,4.117     c-0.721,1.202-1.269,2.22-1.631,3.022l0.078,1.818l-7.839-5.197c12.415-22.153,50.617-65.165,81.918-64.894     c4.59,0.042,9.63,0.715,13.852,2.543C180.186,436.173,183.396,439.006,184.832,443.285z\"/>\n\n\t\t\t\t<linearGradient id=\"path9652-4-${swordId}\" gradientUnits=\"userSpaceOnUse\" x1=\"0.5212\" y1=\"-539.4849\" x2=\"24.49\" y2=\"-539.4849\" gradientTransform=\"matrix(-0.9848 -0.1736 0.1736 -0.9848 177.2516 -21.307)\">\n\t\t\t\t<stop offset=\"0\" style=\"stop-color:${SWORD_LIGHT}\"/>\n\t\t\t\t<stop offset=\"1\" style=\"stop-color:${SWORD_MID}\"/>\n\t\t\t</linearGradient>\n\n\t\t\t\t<path id=\"path9652_1_\" fill=\"url(#path9652-4-${swordId})\" stroke=\"${GOLD_DARK}\" stroke-width=\"0.6784\" d=\"     M84.501,501.704l-5.586,9.377l-16.191,7.291l-5.375-0.704l1.743-7.762c2.874,0.463,5.323,0.278,7.463-0.376     c1.179-1.789,2.367-3.536,5.081-2.724c0.185-2.177,1.053-3.761,3.699-3.673c0.055-2.896,1.409-4.085,3.398-4.421     c0.41-0.561,0.817-1.123,1.228-1.679L84.501,501.704z\"/>\n\t\t\t<path id=\"path9654_1_\" fill=\"none\" stroke=\"${GOLD_DARK}\" stroke-width=\"0.6784\" d=\"M75.811,510.398     l-0.482-7.464\"/>\n\t\t\t<path id=\"path9656_1_\" fill=\"none\" stroke=\"${GOLD_DARK}\" stroke-width=\"0.6784\" d=\"M67.073,516.736     l-0.482-7.462\"/>\n\t\t\t<path id=\"path9658_1_\" fill=\"none\" stroke=\"${GOLD_DARK}\" stroke-width=\"0.6784\" d=\"M72.033,514.091     l-0.482-7.463\"/>\n\n\t\t\t\t<linearGradient id=\"path9660-4-${swordId}\" gradientUnits=\"userSpaceOnUse\" x1=\"-3.0784\" y1=\"-541.895\" x2=\"39.2896\" y2=\"-546.3866\" gradientTransform=\"matrix(-0.9848 -0.1736 0.1736 -0.9848 177.2516 -21.307)\">\n\t\t\t\t<stop offset=\"0\" style=\"stop-color:${SWORD_LIGHT}\"/>\n\t\t\t\t<stop offset=\"1\" style=\"stop-color:${SWORD_MID}\"/>\n\t\t\t</linearGradient>\n\n\t\t\t\t<path id=\"path9660_1_\" fill=\"url(#path9660-4-${swordId})\" stroke=\"${GOLD_DARK}\" stroke-width=\"0.6784\" stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"     M88.022,503.41c-4.709,6.591-9.413,13.214-15.457,16.519c-6.447,3.525-14.978,5.263-18.648-1.366     c-3.762-6.802-0.244-10.97,3.048-14.032c5.827-5.419,11.616,2.017,8.791,6.374c-2.649,4.081-4.165,2.567-6.138,3.802     c14.431,0.639,17.189-8.004,23.406-13.898\"/>\n\n\t\t\t\t<linearGradient id=\"path9662-4-${swordId}\" gradientUnits=\"userSpaceOnUse\" x1=\"-13.4158\" y1=\"-529.2988\" x2=\"16.8186\" y2=\"-529.2988\" gradientTransform=\"matrix(-0.9848 -0.1736 0.1736 -0.9848 177.2516 -21.307)\">\n\t\t\t\t<stop offset=\"0\" style=\"stop-color:${SWORD_LIGHT}\"/>\n\t\t\t\t<stop offset=\"1\" style=\"stop-color:${SWORD_MID}\"/>\n\t\t\t</linearGradient>\n\n\t\t\t\t<path id=\"path9662_1_\" fill=\"url(#path9662-4-${swordId})\" stroke=\"${GOLD_DARK}\" stroke-width=\"0.6784\" d=\"     M90.188,502.775c-3.395-2.316-2.619-6.878-0.955-10.65c-3.36,2.822-7.174,5.05-11.929,1.842l-2.944-1.987     c-0.945-0.637-2.239-3.008-0.411-4.451c0.572-0.453,1.725-0.841,2.468,0.272c0.518,0.781-0.363,3.02-1.857,1.231     c-0.812-0.973-1.106,0.303-0.611,1.506c0.207,0.501,2.023,2.917,4.46,0.249c1.474-1.616,0.672-5.762-1.879-6.481     c-2.111-0.596-4.342,0.192-5.795,2.503c-0.984,1.562,0.086,5.414,3.037,7.426l3.361,2.254l12.889,8.855l2.944,1.986     c0.945,0.635,2.24,3.009,0.411,4.451c-0.569,0.451-1.724,0.839-2.465-0.275c-0.521-0.778,0.362-3.019,1.854-1.23     c0.816,0.976,1.108-0.297,0.614-1.506c-0.207-0.503-2.023-2.913-4.459-0.247c-1.474,1.616-0.67,5.763,1.878,6.481     c2.11,0.597,4.34-0.191,5.795-2.502c0.983-1.561-0.087-5.416-3.037-7.43L90.188,502.775L90.188,502.775z\"/>\n\t\t</g>";
const SWORD_LIGHT = "#fff3cf";
const SWORD_MID = "#c99a2e";

let swordIdCounter = 0;

/** The real crossed sabres, their native bounding box (x 42.29–185.10, y 431.89–523.06 in the source
 * chart) centred on `(cx, cy)` and scaled to `h` tall. */
function crossedSwords(cx: number, cy: number, h: number): string {
  const nativeCenterX = 113.695;
  const nativeCenterY = 477.475;
  const nativeHeight = 91.17;
  const s = h / nativeHeight;
  const tx = cx - nativeCenterX * s;
  const ty = cy - nativeCenterY * s;
  const swordId = `sword-${swordIdCounter}`;
  swordIdCounter += 1;
  const fill = (markup: string): string =>
    markup
      .replaceAll("${SWORD_LIGHT}", SWORD_LIGHT)
      .replaceAll("${SWORD_MID}", SWORD_MID)
      .replaceAll("${GOLD_DARK}", GOLD_DARK)
      .replaceAll("${swordId}", swordId);
  return `<g transform="translate(${f(tx)},${f(ty)}) scale(${f(s)})">${fill(REAL_SWORD_LEFT_MARKUP)}${fill(REAL_SWORD_RIGHT_MARKUP)}</g>`;
}

function chevrons(count: number): string {
  // Point-up chevrons, stacked from the top, centred on the plate. A dark stroke under a gold one:
  // the outline that keeps the chevron sharp against the dark board.
  const step = 5.4;
  const top = 16 - ((count - 1) * step) / 2 - 2.3;
  return `<g fill="none" stroke-linecap="round" stroke-linejoin="round">${Array.from({ length: count }, (_, index) => {
    const y = top + index * step;
    const points = `23,${f(y + 4.6)} 32,${f(y)} 41,${f(y + 4.6)}`;
    return `<polyline points="${points}" stroke="${GOLD_DARK}" stroke-width="3.4"/><polyline points="${points}" stroke="${GOLD}" stroke-width="2"/>`;
  }).join("")}</g>`;
}

function shape(insignia: RankInsignia, shared = false): string {
  // NINTH pass — "remove the what's behind them, I need them to be icons with transparent
  // background" (owner, 2026-10-06). The third pass's `plate()` (a dark radial-vignette board with a
  // metallic bevel) was built to match a reference photo of a real shoulder board, but it fought every
  // place the badge is actually used: the certificate prints it onto white paper, and the rank board
  // already supplies its own card. A device drawn to sit ON a board does not need its own board glued
  // underneath — the drop shadow alone still gives it lift off whatever ground it lands on.
  const device = (markup: string): string => `<g filter="url(#${DEVICE_SHADOW_ID})">${markup}</g>`;
  switch (insignia.kind) {
    case "none":
      // A private wears no device at all here — nothing to draw.
      return device(`<rect fill="${GOLD_DARK}" height="3" width="20" x="22" y="14.5"/>`);
    case "chevrons":
      return device(chevrons(insignia.count));
    case "stars":
      return device(starRow(insignia.count, 32, 16, 16, insignia.count === 3 ? 5.8 : 6.6));
    case "eagle":
      if (insignia.stars === 0) return device(egyptEagle(32, 16, 22, shared));
      // One or two stars get room for a bigger eagle; three are set tighter so neither crowds the box.
      return device(
        egyptEagle(insignia.stars === 3 ? 21 : 23, 16, insignia.stars === 3 ? 17 : 19, shared) +
          starRow(insignia.stars, insignia.stars === 3 ? 47.5 : 48, 16, insignia.stars === 3 ? 8.2 : 11, insignia.stars === 3 ? 4.3 : 5.2),
      );
    case "eagle-swords":
      return device(egyptEagle(24, 15.5, 17, shared) + crossedSwords(49, 17, 13));
  }
}

/** Everything inside the badge's `<svg>`: the gold and the shape, on a 64×32 box. Standalone — the certificate prints it. */
export function insigniaSvgInner(insignia: RankInsignia): string {
  return DEFS + shape(insignia);
}

/**
 * The board's sprite draws the shared parts ONCE (12 Nov 2026, owner: "make the Ranks page lighter
 * too"): the gold, the shadow and the eagle's 21 KB of artwork. Five ranks wear the eagle, and every
 * rank's symbol used to carry its own copy of all three — 135 KB of sprite, sent twice (the page and
 * its data). `insigniaSpriteDefs` goes in the sprite's `<defs>`; `insigniaSymbolInner` is one rank's
 * symbol, which points at them. Same geometry, same look — tests/rep-ranks.test.ts pins that each
 * symbol, with the artwork put back, is the certificate's drawing.
 */
export function insigniaSpriteDefs(): string {
  return `${DEFS_BODY}<g id="${EAGLE_ART_ID}">${eagleArt("phx-coa-a-sprite", "phx-coa-b-sprite")}</g>`;
}

/** One rank's sprite symbol: the shape alone, pointing at `insigniaSpriteDefs` for the gold and the eagle. */
export function insigniaSymbolInner(insignia: RankInsignia): string {
  return shape(insignia, true);
}

/** A whole standalone badge, `width` wide (any CSS length) and half as tall. */
export function insigniaSvg(insignia: RankInsignia, width: string, label: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${label.replace(/"/g, "&quot;")}" viewBox="0 0 64 32" style="width:${width};height:auto;display:block">${insigniaSvgInner(insignia)}</svg>`;
}
