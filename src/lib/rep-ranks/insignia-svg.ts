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
// NO BOARD BEHIND IT (owner, 2026-10-05: "make the background transparent"). The insignia stands
// alone in a polished gold — a light-to-deep gradient with a dark outline — so it stays crisp on
// white, on the orange tint of the viewer's own card, on the podium's gold and on paper.
//
// Square-edged like every other surface here: straight strokes, mitred joins, no rounded corners.

import type { RankInsignia } from "@/lib/rep-ranks/ladder";

// One gradient id shared by every badge on a page. Each SVG declares it with the same stops, so
// whichever declaration the browser resolves, the gold is identical.
const GOLD_ID = "phx-rank-gold";
const GOLD = `url(#${GOLD_ID})`;
const GOLD_DARK = "#5c430b";

const DEFS = `<defs><linearGradient id="${GOLD_ID}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#fbe7a6"/><stop offset="0.45" stop-color="#e2b23f"/><stop offset="1" stop-color="#a97a14"/></linearGradient></defs>`;

const STAR_RADIUS = 5.6;
const f = (value: number): string => value.toFixed(2);

function star(x: number, y: number, radius = STAR_RADIUS): string {
  const points: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    const r = index % 2 === 0 ? radius : radius * 0.42;
    const angle = (Math.PI / 5) * index - Math.PI / 2;
    points.push(`${f(x + r * Math.cos(angle))},${f(y + r * Math.sin(angle))}`);
  }
  return `<polygon fill="${GOLD}" points="${points.join(" ")}" stroke="${GOLD_DARK}" stroke-linejoin="miter" stroke-width="0.8"/>`;
}

/** A row of stars centred on `centerX`. */
function starRow(count: number, centerX: number, y: number, gap: number, radius?: number): string {
  const start = centerX - ((count - 1) * gap) / 2;
  return Array.from({ length: count }, (_, index) => star(start + index * gap, y, radius)).join("");
}

/** The eagle, wings spread, head turned: a heraldic silhouette that still reads at 20px tall. */
function eagle(x: number, y: number, scale = 1): string {
  const p = (points: Array<[number, number]>) => points.map(([dx, dy]) => `${f(x + dx * scale)},${f(y + dy * scale)}`).join(" ");
  return `<g fill="${GOLD}" stroke="${GOLD_DARK}" stroke-linejoin="miter" stroke-width="0.8">${[
    // wings, three feathered steps each
    p([[-2.5, -3], [-13, -9], [-12, -5], [-14, -4], [-12, -1], [-13, 1], [-9, 2], [-2.5, 4]]),
    p([[2.5, -3], [13, -9], [12, -5], [14, -4], [12, -1], [13, 1], [9, 2], [2.5, 4]]),
    // body and tail
    p([[-3, -4], [3, -4], [3, 7], [5, 11], [0, 9], [-5, 11], [-3, 7]]),
    // head
    p([[-2.5, -9], [2, -9], [4.5, -6.5], [2, -6], [2.5, -4], [-2.5, -4]]),
  ]
    .map((points) => `<polygon points="${points}"/>`)
    .join("")}</g>`;
}

function chevrons(count: number): string {
  // Point-up chevrons, stacked from the top, centred in the box. A dark stroke under a gold one: the
  // outline that keeps the chevron sharp on white.
  const step = 6.5;
  const top = 16 - ((count - 1) * step) / 2 - 3;
  return `<g fill="none" stroke-linecap="square" stroke-linejoin="miter">${Array.from({ length: count }, (_, index) => {
    const y = top + index * step;
    const points = `20,${f(y + 6)} 32,${f(y)} 44,${f(y + 6)}`;
    return `<polyline points="${points}" stroke="${GOLD_DARK}" stroke-width="4.4"/><polyline points="${points}" stroke="${GOLD}" stroke-width="2.8"/>`;
  }).join("")}</g>`;
}

function crossedSwords(x: number, y: number): string {
  // Drawn twice: dark and wide first as the outline, then gold on top.
  return `<g stroke-linecap="square">${[
    { stroke: GOLD_DARK, blade: 3.6, guard: 3 },
    { stroke: GOLD, blade: 2.2, guard: 1.6 },
  ]
    .map(
      (layer) =>
        `<g stroke="${layer.stroke}">` +
        `<line stroke-width="${layer.blade}" x1="${x - 9}" x2="${x + 9}" y1="${y + 9}" y2="${y - 9}"/>` +
        `<line stroke-width="${layer.blade}" x1="${x - 9}" x2="${x + 9}" y1="${y - 9}" y2="${y + 9}"/>` +
        // the hilts' cross-guards
        `<line stroke-width="${layer.guard}" x1="${x - 10}" x2="${x - 5}" y1="${y + 5}" y2="${y + 10}"/>` +
        `<line stroke-width="${layer.guard}" x1="${x + 5}" x2="${x + 10}" y1="${y + 10}" y2="${y + 5}"/>` +
        `</g>`,
    )
    .join("")}</g>`;
}

function shape(insignia: RankInsignia): string {
  switch (insignia.kind) {
    case "none":
      // A private wears no insignia: one plain bar, so the badge never reads as missing.
      return `<rect fill="${GOLD}" height="3" stroke="${GOLD_DARK}" stroke-width="0.8" width="22" x="21" y="14.5"/>`;
    case "chevrons":
      return chevrons(insignia.count);
    case "stars":
      return starRow(insignia.count, 32, 17, 18, 7.4);
    case "eagle":
      if (insignia.stars === 0) return eagle(32, 15);
      // One or two stars get room to be larger; three are set tighter so none touches the eagle.
      return (
        eagle(insignia.stars === 3 ? 13 : 15, 15.5, insignia.stars === 3 ? 0.8 : 0.88) +
        starRow(insignia.stars, insignia.stars === 3 ? 47.4 : 47, 16.5, insignia.stars === 3 ? 10.8 : 14, insignia.stars === 3 ? 5.6 : 6.6)
      );
    case "eagle-swords":
      return eagle(18, 15.5, 0.88) + crossedSwords(47, 16);
  }
}

/** Everything inside the badge's `<svg>`: the gold and the shape, on a 64×32 box. */
export function insigniaSvgInner(insignia: RankInsignia): string {
  return DEFS + shape(insignia);
}

/** A whole standalone badge, `width` wide (any CSS length) and half as tall. */
export function insigniaSvg(insignia: RankInsignia, width: string, label: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${label.replace(/"/g, "&quot;")}" viewBox="0 0 64 32" style="width:${width};height:auto;display:block">${insigniaSvgInner(insignia)}</svg>`;
}
