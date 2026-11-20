import { HOUSE_COLORS } from "@/lib/hiring-pack/house-identity";
import { PREMIUM_LATIN_FONT_STACK } from "@/lib/hiring-pack/premium-identity";
import type { OfferBlock } from "@/lib/offers/types";

/**
 * The Prestige letter — the offer as a piece of company stationery: a navy cover plate, flat gold,
 * a serif voice, and a navy closing plate. Its own layout, not the ordinary letter re-coloured.
 *
 * WHY IT LOOKS LIKE THIS. The owner asked on 17 Nov 2026 for an offer "very premium polished
 * godmode", and rejected the first Prestige (a restrained re-ruling of the ordinary letter) the same
 * evening: "this is the normal templete". So the page now opens on what a candidate would hold up:
 *
 *   · A NAVY COVER PLATE in Sato's own navy (#17304d, the navy the on-navy mark was measured against),
 *     carrying the white mark, the company's names, "Offer of Employment" between two gold rules, the
 *     CANDIDATE'S NAME in large spaced serif capitals, the position in serif italic, the reporting
 *     line, and the reference ledger along its foot. Four flat-gold corner marks sit inside it.
 *   · A GOLD RULE a hair below the plate, as on engraved stationery. The gold is Sato's own flat gold
 *     (#a07a3a on paper, #c8a462 on navy), printed flat like foil — never a gradient, never a sheen.
 *   · A SERIF VOICE for the running text, the figures, the clause numerals and the signatories, with
 *     the labels in the house sans in spaced capitals.
 *   · SECTIONS NUMBERED I, II, III in gold serif by a CSS counter, a hairline running to the margin.
 *   · THE SALARY as a serif figure with the currency set small, the table ruled with a 6% zebra and a
 *     double rule over the total.
 *   · A NAVY CLOSING PLATE (the legal footer), under its own gold rule, so the letter closes the way
 *     it opens.
 *
 * WHAT IT NEVER DOES: round a corner, cast a shadow, draw a gradient, gloss or glow — the owner's rule
 * that nothing designed may look machine-made. The navy is flat, the gold is flat.
 *
 * WHAT IT KEEPS: every word. The cover plate is BUILT FROM the letterhead, reference and title blocks
 * (and the candidate's name and reporting line, which the letter already prints), so editing those
 * blocks in the designer moves the plate. Every other block is the ordinary block, re-dressed.
 *
 * THE SEAL is placed as the Premium letter places it: 21mm, its foot on the signatory's rule. The
 * signature cell and the signature ink are the base's, untouched.
 *
 * NO BACKTICKS IN THE CSS BELOW — it is a template literal, and one would close it.
 */

/** Sato's navy — the colour the on-navy mark was drawn and measured for. */
export const PRESTIGE_NAVY = "#17304d";
/** Sato's flat gold on paper: rules, numerals, corner marks. */
export const PRESTIGE_GOLD = "#a07a3a";
/** The same gold one step deeper, for small gold TYPE on paper, so it still reads at 7pt. */
const PRESTIGE_GOLD_TEXT = "#86662d";
/** Sato's flat gold on navy. */
export const PRESTIGE_GOLD_ON_NAVY = "#c8a462";

/** The display face. Georgia on a desk, Noto Serif in the production image, Times last. */
const PRESTIGE_SERIF_STACK = "Georgia,'Noto Serif','Times New Roman',serif";

const N = PRESTIGE_NAVY;
const G = PRESTIGE_GOLD;
const GT = PRESTIGE_GOLD_TEXT;
const GN = PRESTIGE_GOLD_ON_NAVY;
const H = HOUSE_COLORS.hair;
const M = HOUSE_COLORS.muted;
const SERIF = PRESTIGE_SERIF_STACK;
const SANS = PREMIUM_LATIN_FONT_STACK;
/** Navy-plate secondary type and rules — mixed from the navy, flat. */
const PALE = "#dfe6ec";
const QUIET = "#a9b8c6";
const SEAM = "#3a5372";

export const PRESTIGE_OFFER_SKIN = `
/* The section counter lives on the sheet, so every letter starts at I. */
.sheet{counter-reset:pxsec}

/* The ordinary furniture the cover plate replaces. */
.rail{display:none;background:none}
.appt{background:none;border:0}

/* ── The cover plate ─────────────────────────────────────────────────────────────────────────── */
.px-plate{position:relative;margin-top:0;padding:7mm 10mm 0;background:${N};color:#ffffff}
.px-c{position:absolute;width:5mm;height:5mm;border:0 solid ${GN}}
.px-c.tl{left:3mm;top:3mm;border-left-width:.8pt;border-top-width:.8pt}
.px-c.tr{right:3mm;top:3mm;border-right-width:.8pt;border-top-width:.8pt}
.px-c.bl{left:3mm;bottom:3mm;border-left-width:.8pt;border-bottom-width:.8pt}
.px-c.br{right:3mm;bottom:3mm;border-right-width:.8pt;border-bottom-width:.8pt}
.px-head{display:flex;align-items:center;justify-content:space-between;gap:8mm}
.px-mark{display:block;height:9mm;width:auto}
.px-head .logo-gap{display:block;height:9mm}
.px-org{text-align:right}
.px-org .micro{color:#ffffff;font-size:7pt;letter-spacing:2.4px}
.px-org .px-unit{margin-top:1.2mm;color:${GN};font-size:6.6pt;letter-spacing:2px}
.px-dot{margin:0 1.6mm}
.px-title{padding:6.5mm 0 5.5mm;text-align:center}
.px-kicker{display:flex;align-items:center;justify-content:center;gap:4mm;color:${GN};font-size:7.4pt;letter-spacing:4.4px}
.px-kicker::before,.px-kicker::after{content:"";width:16mm;height:0;border-top:.6pt solid ${GN}}
.px-name{margin-top:3.6mm;font-family:${SERIF};font-size:25pt;line-height:1.12;font-weight:400;letter-spacing:2.6px;text-transform:uppercase;color:#ffffff}
/* A long name steps down a size so it stays on one line and the plate keeps its height (four-part
   Egyptian names run past 24 capitals at the full size). */
.px-name.px-long{font-size:19pt;letter-spacing:2px}
.px-role{margin-top:2.4mm;font-family:${SERIF};font-style:italic;font-size:12.6pt;line-height:1.3;color:${PALE}}
.px-line{margin-top:2.6mm;color:${QUIET};font-size:6.8pt;letter-spacing:2px}
.px-meta{display:grid;grid-template-columns:repeat(4,1fr);border-top:.6pt solid ${SEAM}}
.px-meta > div{padding:2.6mm 0 3.6mm 4mm;border-left:.6pt solid ${SEAM}}
.px-meta > div:first-child{padding-left:0;border-left:0}
.px-meta .k{color:${GN};font-size:6.4pt;letter-spacing:1.8px}
.px-meta .v{margin-top:1.4mm;font-size:9pt;font-weight:700;color:#ffffff}
.px-gild{height:0;margin-top:1.4mm;border-top:1.2pt solid ${G}}
/* A second reference row, if a designer adds one, is drawn by the base — ruled here, never filled. */
.control{gap:0;margin-top:5mm;background:none;border:0;border-top:.6pt solid ${H};border-bottom:.6pt solid ${H}}
.control > div{background:none;padding:2mm 3mm;border-left:.6pt solid ${H}}
.control > div:first-child{padding-left:0;border-left:0}
.control .k{color:${GT}}
.control .v{font-family:${SERIF};font-weight:400;color:${N}}

/* ── The letter's voice ──────────────────────────────────────────────────────────────────────── */
p{font-family:${SERIF};font-size:10pt;line-height:1.5;color:#1f2a36}
p + p{margin-top:2.2mm}
.lead{font-size:10.2pt}
strong{color:${N}}
.px-gild + p,.px-gild + .lede,.px-gild + .px-air + p,.px-gild + .px-air + .lede{margin-top:6mm}
.lede-mark{background:none;color:${N};border:.6pt solid ${G};font-family:${SERIF};font-weight:400}

/* Every divider is switched off, and drawn again only where it means something. */
.divider-micro{display:block;margin:0}
.divider-micro::before{display:none;background:none}
.divider-micro::after{display:none;background:none}

/* The scope ledger: a navy rule over it, hairlines between the cells, gold captions, serif values. */
.scope{gap:0;margin-top:5mm;background:none;border:0;border-top:1.2pt solid ${N};border-bottom:.6pt solid ${H}}
.scope > div{background:none;padding:2.4mm 4mm 2.6mm;border-left:.6pt solid ${H}}
.scope > div:first-child{padding-left:0;border-left:0}
.scope .k{color:${GT};font-size:6.4pt;letter-spacing:1.8px}
.scope .v{margin-top:1.4mm;font-family:${SERIF};font-size:11pt;font-weight:400;line-height:1.25;color:${N}}

/* Section heads: a gold Roman numeral, the label in spaced navy capitals, a hairline to the margin.
   The counter renumbers itself when a designer adds or removes a section. */
.section-h{display:flex;align-items:baseline;gap:3.4mm;margin-top:6.5mm;counter-increment:pxsec}
.section-h::before{content:counter(pxsec,upper-roman);flex:none;min-width:6mm;font-family:${SERIF};font-size:15pt;line-height:1;font-weight:400;color:${G}}
.section-h > .micro{flex:none;color:${N};font-size:7.4pt;letter-spacing:2.8px;white-space:nowrap}
.section-h .sub{color:${M}}
.section-h .divider-micro{flex:1 1 auto;align-self:center;min-width:0;height:0;border-top:.6pt solid ${H}}

/* Compensation: the monthly figure in the serif, the currency small and high, the annual beside it;
   the rows ruled with the 6% zebra; a double navy rule over the total. */
.comp{margin-top:3mm;border:0;border-top:1.2pt solid ${N}}
.comp-hero{background:none;padding:3.4mm 0 3mm;border-bottom:.6pt solid ${H}}
.comp-hero .k{color:${GT};font-size:6.6pt;letter-spacing:1.8px}
.comp-hero .big{margin-top:2mm;font-family:${SERIF};font-size:32pt;font-weight:400;letter-spacing:-.3px;color:${N}}
.comp-hero .big .cur{margin-right:2.6mm;font-family:${SANS};font-size:8.4pt;font-weight:700;letter-spacing:1.8px;vertical-align:1.2em;color:${G}}
.comp-hero .aside .k{color:${M}}
.comp-hero .aside .v{font-family:${SERIF};font-size:16pt;font-weight:400;letter-spacing:0;color:${N}}
.comp-hero .aside .n{color:${M};font-family:${SERIF};font-style:italic}
.comp th{padding:1.6mm 3mm;background:none;color:${M};font-size:6.4pt;letter-spacing:1.8px;border-bottom:.8pt solid ${N}}
.comp td{padding:1.5mm 3mm;border-bottom:.6pt solid ${H};color:#1f2a36;font-family:${SERIF};font-size:9.6pt}
.comp td.lbl{color:${N}}
.comp tbody tr:not(.total):nth-child(odd) td{background:var(--tint)}
.comp tr.total td{padding-top:2.2mm;padding-bottom:2.2mm;background:none;border-top:2.6pt double ${N};border-bottom:0;color:${N};font-size:10.8pt;font-weight:700}
.comp-note{padding:2mm 0;background:none;border-top:0;border-bottom:.6pt solid ${H};color:${M};font-family:${SERIF};font-style:italic;font-size:8.8pt}

/* Benefits: a two-column ledger, each heading led by a small flat-gold square. */
.benefits{gap:0;margin-top:3.6mm;background:none;border:0;border-top:1.2pt solid ${N}}
.benefits > div{background:none;padding:2.8mm 3mm;border-bottom:.6pt solid ${H}}
.benefits > div:nth-child(odd){padding-left:0;border-right:.6pt solid ${H}}
.benefits > div:nth-child(even){padding-right:0;padding-left:4.4mm}
.benefits .k{display:flex;align-items:center;gap:2mm;color:${N};font-size:6.8pt;letter-spacing:1.8px}
.benefits .k::before{content:"";flex:none;width:1.5mm;height:1.5mm;border:.8pt solid ${G}}
.benefits .t{font-family:${SERIF};font-size:9.4pt;color:#1f2a36}

/* Clauses: a large gold serif numeral standing in its own gutter — never a filled tile. */
.clause{gap:5mm;padding:3.4mm 0;border-bottom:.6pt solid ${H}}
.clause.first{border-top:1.2pt solid ${N}}
.clause .no{display:block;width:9mm;height:auto;background:none;color:${G};font-family:${SERIF};font-size:20pt;font-weight:400;line-height:1;text-align:right}
.clause .h{font-family:${SERIF};font-size:11pt;font-weight:400;color:${N}}
.clause .t{font-family:${SERIF};font-size:9.6pt;line-height:1.55;color:#1f2a36}

/* Steps: three columns under a navy rule, the gold index over each. */
.steps{gap:0;margin-top:3.6mm;background:none;border:0;border-top:1.2pt solid ${N};border-bottom:.6pt solid ${H}}
.steps > div{background:none;padding:2.8mm 4mm 3.2mm;border-left:.6pt solid ${H}}
.steps > div:first-child{padding-left:0;border-left:0}
.steps .n{color:${GT};font-size:6.4pt;letter-spacing:1.8px}
.steps .h{font-family:${SERIF};font-size:11pt;font-weight:400;color:${N}}
.steps .t{font-family:${SERIF};font-size:9pt;color:#3b4855}

/* The acceptance block opens on the double rule, as the total does; the label is set between gold
   rules, and the two signatories are named in the serif. */
.accept{margin-top:8mm;border:0;border-top:2.6pt double ${N}}
.accept-h{display:flex;align-items:center;gap:4mm;padding:2.6mm 0;background:none;border-bottom:.6pt solid ${H}}
.accept-h::after{content:"";flex:1;height:0;border-top:.6pt solid ${G}}
.accept-h .micro{color:${N};letter-spacing:3px}
.accept-b{gap:0;background:none}
.accept-b > div{background:none;padding:3.4mm 4mm}
.accept-b > div:first-child{padding-left:0;border-right:.6pt solid ${H}}
.accept-b > div:last-child{padding-right:0}
.accept .k{color:${GT};font-size:6.4pt;letter-spacing:1.8px}
.accept .party{margin-top:1.6mm;font-family:${SERIF};font-size:13pt;font-weight:400;color:${N}}
.accept .sub{color:${M};font-family:${SERIF};font-style:italic}
/* Headroom on both parties' signature rows, so the four rules stay level and the company's seal
   clears the signatory's name and title above it. */
.accept .sigrow{padding-top:14mm;gap:6mm}
/* The signing lines in navy, each label centred under its line in small gold capitals. */
.accept .sigline{border-bottom:.8pt solid ${N}}
.accept .siglabel{margin-top:2mm;text-align:center;color:${GT};font-size:6.4pt;letter-spacing:2.2px}
/* The signature and the stamp are CENTRED on the company's line, one over the other (owner, 17 Nov
   2026: "put the stamp on my signature", then "center the signature and the stamp"). The signature
   keeps its own size — 35px is the file's own pixel height, and enlarging it only blurs it. */
.accept .sigcell .sigink-box{justify-content:center}
.accept .sigcell .sigink{margin:0 auto}
/* The seal: 21mm, centred over the signature, its foot resting just under the rule so the signature
   sits in its lower half and the SIGNATURE label below stays clear. Multiply, as ink lands on paper,
   so the signature reads through the stamp. The candidate's cell never carries one. */
.accept .offer-seal{left:50%;top:auto;bottom:4.4mm;width:21mm;height:21mm;transform:translateX(-50%) rotate(-7deg);opacity:.9;mix-blend-mode:multiply}

/* ── The closing plate: the legal footer in navy, under its own gold rule ────────────────────── */
.px-close{margin-top:10mm;break-inside:avoid}
.px-rule{height:0;margin-bottom:1.4mm;border-top:1.2pt solid ${G}}
.foot{margin-top:0;padding:5mm 7mm;background:${N};border-top:0;align-items:center}
.foot p{max-width:72%;font-family:${SERIF};font-style:italic;font-size:8pt;line-height:1.55;color:${PALE}}
.foot .pg{color:${GN};letter-spacing:2.6px}

/* ── The three fixed A4 pages ──────────────────────────────────────────────────────────────────
   Owner, 18 Nov 2026: "Many white spaces, dimensions not fixed". The letter used to flow and break
   wherever a block happened to end: the Compensation heading was left alone at the foot of page one,
   the designer's page break left page two half empty, and the closing plate fell onto a fourth page
   by itself. So the letter is now three A4 pages, each the height of the page's printable area
   (A4 297mm less the 12mm and 14mm margins of the base's @page, with a hair to spare so a rounding
   never spills a blank page): one, the cover plate, the letter and the compensation; two, the
   benefits and the terms; three, what happens next, the signatures and the closing plate, which
   stands on the foot of the page. A heading never leaves its section (.px-sec keeps them together).
   Pages two and three carry more air than page one, which is full by design. */
.px-sec{break-inside:avoid}
.px-air{display:none}
/* On screen (the designer's preview) the pages simply follow one another; only print makes them A4. */
@media print{
.px-page{display:flex;flex-direction:column;min-height:270mm}
.px-page > :first-child,.px-page > .px-sec:first-child .section-h{margin-top:0}
.px-page + .px-page{break-before:page}
/* The height a page has left is shared out between its sections, up to 14mm a gap, so a page fills
   to its foot instead of ending on a band of white. */
.px-air{display:block;flex:1 1 0;min-height:0;max-height:14mm}
/* Page three shares ALL its spare height equally — above the closing words, above the signatures and
   above the closing plate, which therefore stands on the foot of the page. */
.px-p3 > .px-air{max-height:none}
/* A long letter sets page one tighter (prestigePageOneEstimateMm), so the salary never leaves it. */
.px-p1.px-tight .px-title{padding:5mm 0 4.4mm}
.px-p1.px-tight p{font-size:9.6pt;line-height:1.46}
.px-p1.px-tight .px-gild + .px-air + p{margin-top:5mm}
.px-p1.px-tight .scope{margin-top:4mm}
.px-p1.px-tight .section-h{margin-top:5mm}
.px-p1.px-tight .comp-hero{padding:2.6mm 0 2.4mm}
.px-p1.px-tight .comp td{padding:1.2mm 3mm}
.px-page:not(.px-p1) .px-sec .section-h{margin-top:15mm}
.px-page:not(.px-p1) > .px-sec:first-child .section-h{margin-top:0}
.px-page:not(.px-p1) .section-h + *{margin-top:6mm}
.px-page:not(.px-p1) p{font-size:10.4pt;line-height:1.62}
.px-page:not(.px-p1) .benefits > div{padding-top:5.4mm;padding-bottom:5.6mm}
.px-page:not(.px-p1) .benefits .k{font-size:7.2pt}
.px-page:not(.px-p1) .benefits .t{margin-top:1.6mm;font-size:10pt;line-height:1.55}
.px-page:not(.px-p1) .clause{gap:6mm;padding:6.2mm 0}
.px-page:not(.px-p1) .clause .no{font-size:23pt}
.px-page:not(.px-p1) .clause .h{font-size:12.4pt}
.px-page:not(.px-p1) .clause .t{margin-top:1.6mm;font-size:10.2pt;line-height:1.62}
.px-page:not(.px-p1) .steps > div{padding-top:5mm;padding-bottom:5.6mm}
.px-page:not(.px-p1) .steps .h{margin-top:1.8mm;font-size:12.4pt}
.px-page:not(.px-p1) .steps .t{margin-top:1.4mm;font-size:9.8pt;line-height:1.55}
.px-page:not(.px-p1) .steps{margin-bottom:3mm}
.px-page:not(.px-p1) .accept-b > div{padding-top:5mm;padding-bottom:5mm}
.px-page:not(.px-p1) .accept .party{font-size:14pt}
.px-page:not(.px-p1) .accept .sigrow{padding-top:22mm}
.px-p3 > .px-sign{padding-top:12mm}
.px-p3 > .px-sign > .accept{margin-top:0}
.px-p3 > .px-close{margin-top:auto;padding-top:10mm}
}

/* A closing welcome band, if a designer adds one: ruled, not filled, and no mark in it. */
.welcome{margin-top:6mm;border:0;border-top:1.2pt solid ${N};border-bottom:.6pt solid ${H}}
.welcome-b{padding:3mm 0;background:none}
.welcome .k{color:${GT}}
.welcome .t{font-family:${SERIF};font-weight:400;color:${N}}
.welcome-cap{display:none;background:none}
`.trim();

/** The most capitals the candidate's name prints at full size before it steps down to stay on one line. */
export const PRESTIGE_NAME_ONE_LINE = 24;
/** The most capitals the stepped-down name holds on one line. */
const PRESTIGE_NAME_ONE_LINE_LONG = 32;

/**
 * Page one's height in millimetres, estimated from what it prints — measured in Chromium on the
 * production fonts (Noto Serif): the plate, the scope and the compensation are a fixed 212mm, each
 * character of the letter's own paragraphs adds 0.053mm (about 100 characters to a 5.3mm line), and a
 * name that still wraps adds a line of the plate. The printable height is 271mm.
 */
export function prestigePageOneEstimateMm(paragraphChars: number, nameLength: number): number {
  const nameWraps = nameLength > PRESTIGE_NAME_ONE_LINE_LONG;
  return 212 + 0.053 * paragraphChars + (nameWraps ? 8 : 0);
}

/** Past this estimate page one is set tighter, so the compensation never leaves it for page two. */
export const PRESTIGE_PAGE_ONE_TIGHT_FROM_MM = 264;

/** The kinds of block the cover plate is built from. */
const PLATE_TYPES = new Set(["letterhead", "control", "title"]);

type PlateItem = { k?: unknown; v?: unknown };

function plateItems(block: OfferBlock | undefined): PlateItem[] {
  const items = block?.props?.items;
  return Array.isArray(items) ? (items as PlateItem[]) : [];
}

/**
 * The cover plate, built from the letterhead, reference and title blocks so editing any of them in
 * the designer moves it. Every string arrives through `fill`, which substitutes and escapes ONCE.
 */
function prestigeCoverPlate(
  blocks: { control?: OfferBlock; letterhead?: OfferBlock; title?: OfferBlock },
  fill: (value: unknown) => string,
  logoSrc: string,
): string {
  const head = blocks.letterhead?.props ?? {};
  const title = blocks.title?.props ?? {};
  const mark = logoSrc ? `<img class="px-mark" src="${logoSrc}" alt="">` : '<span class="logo-gap"></span>';
  // Two or more short labels on one line, each in its own span, so every one stays its own run of
  // text (the words the letter prints are checked run by run against the ordinary letter).
  const joined = (parts: unknown[]) =>
    parts
      .map((part) => fill(part).trim())
      .filter(Boolean)
      .map((part) => `<span>${part}</span>`)
      .join('<span class="px-dot">·</span>');
  const unit = joined([head.unit, head.tagline]);
  const kicker = fill(title.h1).trim();
  const role = fill(title.sub).trim();
  // A token the letter does not carry comes back unfilled ("{{reportsTo}}"); the plate leaves it out.
  const token = (key: string) => {
    const value = fill(`{{${key}}}`).trim();
    return value.startsWith("{{") ? "" : value;
  };
  const name = token("candidateName");
  const reportsTo = token("reportsTo");
  // The title block's optional appointment badge (two short labels), kept on the plate so no word
  // a designer typed into the title is lost.
  const badge = joined([title.badgeK, title.badge]);
  const meta = plateItems(blocks.control)
    .map((item) => `<div><div class="micro k">${fill(item.k)}</div><div class="v">${fill(item.v)}</div></div>`)
    .join("");

  return (
    '<header class="px-plate keep">' +
    '<i class="px-c tl"></i><i class="px-c tr"></i><i class="px-c bl"></i><i class="px-c br"></i>' +
    `<div class="px-head">${mark}<div class="px-org">` +
    `<div class="micro">${fill(head.name)}</div>` +
    (unit ? `<div class="micro px-unit">${unit}</div>` : "") +
    "</div></div>" +
    '<div class="px-title">' +
    (kicker ? `<div class="micro px-kicker">${kicker}</div>` : "") +
    (name ? `<div class="px-name${name.length > PRESTIGE_NAME_ONE_LINE ? " px-long" : ""}">${name}</div>` : "") +
    (role ? `<div class="px-role">${role}</div>` : "") +
    (reportsTo ? `<div class="micro px-line">Reporting to the ${reportsTo}</div>` : "") +
    (badge ? `<div class="micro px-line">${badge}</div>` : "") +
    "</div>" +
    (meta ? `<div class="px-meta">${meta}</div>` : "") +
    '</header><div class="px-gild"></div>'
  );
}

/** One piece of the letter as drawn: its markup, and the kinds and positions of the blocks in it. */
type Piece = { first: number; html: string; types: string[] };

/**
 * The letter's blocks as Prestige markup.
 *
 * The letterhead, reference and title blocks become ONE cover plate, drawn where the first of them
 * stands; the others of the three are absorbed. The rail is dropped (the plate opens the page).
 * Every other block is the ordinary block. A second letterhead, reference or title block, if a
 * designer adds one, is drawn as the base draws it.
 *
 * THE PAGES (owner, 18 Nov 2026: "Many white spaces, dimensions not fixed"). A section heading is
 * drawn together with the block after it, so it can never be left alone at the foot of a page, and
 * the closing plate carries its own gold rule inside it, so the rule never stays behind on the page
 * before. The letter is then laid out as THREE fixed A4 pages, found by the kind of block rather than
 * by position, so a block a designer adds lands on the page its kind belongs to:
 *   · page one ends with the compensation block (the plate, the letter, the scope, the salary);
 *   · page three starts with the "what happens next" steps — or, with none, the signatures — and
 *     ends on the closing plate;
 *   · page two is everything between them (the benefits and the terms).
 * The pages make the breaks, so a designer's page-break block is not drawn as well; it was the break
 * that left page two half empty. A letter with no compensation block is not paged at all, and draws
 * its page breaks as the base does.
 *
 * `logoSrc` must already be escaped for an attribute; the reverse (white) mark is the one that reads
 * on the plate, and the renderer hands it over.
 */
export function prestigeOfferBody(
  blocks: OfferBlock[],
  render: (block: OfferBlock) => string,
  fill: (value: unknown) => string,
  logoSrc: string,
): string {
  const first = (type: string) => blocks.findIndex((block) => block.type === type);
  const at = { control: first("control"), letterhead: first("letterhead"), title: first("title") };
  const used = Object.values(at).filter((index) => index >= 0);
  const plateAt = used.length > 0 ? Math.min(...used) : -1;
  const paged = first("compensation") >= 0;

  // Each block drawn, in order — the plate in the place of the first of its three blocks.
  const drawn: Piece[] = [];
  blocks.forEach((block, index) => {
    if (index === plateAt) {
      const html = prestigeCoverPlate(
        {
          control: at.control >= 0 ? blocks[at.control] : undefined,
          letterhead: at.letterhead >= 0 ? blocks[at.letterhead] : undefined,
          title: at.title >= 0 ? blocks[at.title] : undefined,
        },
        fill,
        logoSrc,
      );
      drawn.push({ first: index, html, types: ["plate"] });
      return;
    }
    if (PLATE_TYPES.has(block.type) && (index === at.control || index === at.letterhead || index === at.title)) return;
    if (block.type === "rail") return;
    if (block.type === "pagebreak" && paged) return;
    const html = render(block);
    if (html === "") return;
    // The signatures in a holder of their own, so page three can stand them where the height allows.
    if (block.type === "signature") {
      drawn.push({ first: index, html: `<div class="px-sign">${html}</div>`, types: [block.type] });
      return;
    }
    // The closing plate's gold rule is its own element, held with the plate, so the two never part.
    if (block.type === "footer") {
      drawn.push({ first: index, html: `<div class="px-close"><div class="px-rule"></div>${html}</div>`, types: [block.type] });
      return;
    }
    drawn.push({ first: index, html, types: [block.type] });
  });

  // A heading is drawn with the block after it, so it never ends a page alone.
  const pieces: Piece[] = [];
  for (let i = 0; i < drawn.length; i += 1) {
    const piece = drawn[i];
    const next = drawn[i + 1];
    if (piece.types[0] === "heading" && next && next.types[0] !== "heading" && next.types[0] !== "pagebreak") {
      pieces.push({ first: piece.first, html: `<section class="px-sec">${piece.html}${next.html}</section>`, types: ["heading", ...next.types] });
      i += 1;
      continue;
    }
    pieces.push(piece);
  }
  if (!paged) return pieces.map((piece) => piece.html).join("");

  const holding = (type: string) => pieces.findIndex((piece) => piece.types.includes(type));
  const endOfOne = holding("compensation");
  const steps = holding("steps");
  const startOfThree = steps > endOfOne ? steps : holding("signature") > endOfOne ? holding("signature") : pieces.length;
  // A share of the page's spare height between every two pieces — and, on pages one and two, one at
  // the foot, so what is left after the shares sits under the last section rather than above it.
  const AIR = '<i class="px-air"></i>';
  const page = (name: string, from: number, to: number, foot: string) => {
    const html = pieces.slice(from, to).map((piece) => piece.html).join(AIR);
    return html === "" ? "" : `<div class="px-page ${name}">${html}${foot}</div>`;
  };
  // Page one's own paragraphs, as the reader sees them, decide whether it is set tighter.
  const paragraphChars = pieces
    .slice(0, endOfOne + 1)
    .filter((piece) => piece.types.includes("text"))
    .reduce((sum, piece) => sum + piece.html.replace(/<[^>]*>/g, "").replace(/&[a-z#0-9]+;/gi, " ").length, 0);
  const nameLength = fill("{{candidateName}}").trim().length;
  const tight = prestigePageOneEstimateMm(paragraphChars, nameLength) > PRESTIGE_PAGE_ONE_TIGHT_FROM_MM;
  return (
    page(tight ? "px-p1 px-tight" : "px-p1", 0, endOfOne + 1, AIR) +
    page("px-p2", endOfOne + 1, startOfThree, AIR) +
    page("px-p3", startOfThree, pieces.length, "")
  );
}
