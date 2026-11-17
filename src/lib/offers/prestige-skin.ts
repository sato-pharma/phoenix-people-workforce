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
export const PRESTIGE_GOLD_TEXT = "#86662d";
/** Sato's flat gold on navy. */
export const PRESTIGE_GOLD_ON_NAVY = "#c8a462";

/** The display face. Georgia on a desk, Noto Serif in the production image, Times last. */
export const PRESTIGE_SERIF_STACK = "Georgia,'Noto Serif','Times New Roman',serif";

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
.px-plate{position:relative;margin-top:1mm;padding:8mm 10mm 0;background:${N};color:#ffffff}
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
.px-title{padding:9mm 0 7.5mm;text-align:center}
.px-kicker{display:flex;align-items:center;justify-content:center;gap:4mm;color:${GN};font-size:7.4pt;letter-spacing:4.4px}
.px-kicker::before,.px-kicker::after{content:"";width:16mm;height:0;border-top:.6pt solid ${GN}}
.px-name{margin-top:4.6mm;font-family:${SERIF};font-size:25pt;line-height:1.12;font-weight:400;letter-spacing:2.6px;text-transform:uppercase;color:#ffffff}
.px-role{margin-top:3mm;font-family:${SERIF};font-style:italic;font-size:12.6pt;line-height:1.3;color:${PALE}}
.px-line{margin-top:2.6mm;color:${QUIET};font-size:6.8pt;letter-spacing:2px}
.px-meta{display:grid;grid-template-columns:repeat(4,1fr);border-top:.6pt solid ${SEAM}}
.px-meta > div{padding:3.2mm 0 4.4mm 4mm;border-left:.6pt solid ${SEAM}}
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
p{font-family:${SERIF};font-size:10pt;line-height:1.56;color:#1f2a36}
p + p{margin-top:2.2mm}
.lead{font-size:10.2pt}
strong{color:${N}}
.px-gild + p,.px-gild + .lede{margin-top:7mm}
.lede-mark{background:none;color:${N};border:.6pt solid ${G};font-family:${SERIF};font-weight:400}

/* Every divider is switched off, and drawn again only where it means something. */
.divider-micro{display:block;margin:0}
.divider-micro::before{display:none;background:none}
.divider-micro::after{display:none;background:none}

/* The scope ledger: a navy rule over it, hairlines between the cells, gold captions, serif values. */
.scope{gap:0;margin-top:6mm;background:none;border:0;border-top:1.2pt solid ${N};border-bottom:.6pt solid ${H}}
.scope > div{background:none;padding:2.8mm 4mm 3mm;border-left:.6pt solid ${H}}
.scope > div:first-child{padding-left:0;border-left:0}
.scope .k{color:${GT};font-size:6.4pt;letter-spacing:1.8px}
.scope .v{margin-top:1.4mm;font-family:${SERIF};font-size:11pt;font-weight:400;line-height:1.25;color:${N}}

/* Section heads: a gold Roman numeral, the label in spaced navy capitals, a hairline to the margin.
   The counter renumbers itself when a designer adds or removes a section. */
.section-h{display:flex;align-items:baseline;gap:3.4mm;margin-top:8mm;counter-increment:pxsec}
.section-h::before{content:counter(pxsec,upper-roman);flex:none;min-width:6mm;font-family:${SERIF};font-size:15pt;line-height:1;font-weight:400;color:${G}}
.section-h > .micro{flex:none;color:${N};font-size:7.4pt;letter-spacing:2.8px;white-space:nowrap}
.section-h .sub{color:${M}}
.section-h .divider-micro{flex:1 1 auto;align-self:center;min-width:0;height:0;border-top:.6pt solid ${H}}
.page-break + .section-h{margin-top:0}

/* Compensation: the monthly figure in the serif, the currency small and high, the annual beside it;
   the rows ruled with the 6% zebra; a double navy rule over the total. */
.comp{margin-top:3.6mm;border:0;border-top:1.2pt solid ${N}}
.comp-hero{background:none;padding:4.4mm 0 4mm;border-bottom:.6pt solid ${H}}
.comp-hero .k{color:${GT};font-size:6.6pt;letter-spacing:1.8px}
.comp-hero .big{margin-top:2.4mm;font-family:${SERIF};font-size:32pt;font-weight:400;letter-spacing:-.3px;color:${N}}
.comp-hero .big .cur{margin-right:2.6mm;font-family:${SANS};font-size:8.4pt;font-weight:700;letter-spacing:1.8px;vertical-align:1.2em;color:${G}}
.comp-hero .aside .k{color:${M}}
.comp-hero .aside .v{font-family:${SERIF};font-size:16pt;font-weight:400;letter-spacing:0;color:${N}}
.comp-hero .aside .n{color:${M};font-family:${SERIF};font-style:italic}
.comp th{padding:2mm 3mm;background:none;color:${M};font-size:6.4pt;letter-spacing:1.8px;border-bottom:.8pt solid ${N}}
.comp td{padding:1.8mm 3mm;border-bottom:.6pt solid ${H};color:#1f2a36;font-family:${SERIF};font-size:9.6pt}
.comp td.lbl{color:${N}}
.comp tbody tr:not(.total):nth-child(odd) td{background:var(--tint)}
.comp tr.total td{padding-top:2.6mm;padding-bottom:2.6mm;background:none;border-top:2.6pt double ${N};border-bottom:0;color:${N};font-size:10.8pt;font-weight:700}
.comp-note{padding:2.4mm 0;background:none;border-top:0;border-bottom:.6pt solid ${H};color:${M};font-family:${SERIF};font-style:italic;font-size:8.8pt}

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
.accept .sigrow{padding-top:11mm}
/* The seal is stamped ON the signature (owner, 17 Nov 2026: "put the stamp on my signature"): 21mm,
   centred over the signature image, which is about 16mm wide from the start of the rule. Multiply,
   as ink lands on paper, so the signature still reads through the stamp. The candidate's cell never
   carries one. */
.accept .offer-seal{left:-1.4mm;top:auto;bottom:-1.2mm;width:21mm;height:21mm;transform:rotate(-7deg);opacity:.9;mix-blend-mode:multiply}

/* ── The closing plate: the legal footer in navy, under its own gold rule ────────────────────── */
.foot{position:relative;break-inside:avoid;margin-top:10mm;padding:5mm 7mm;background:${N};border-top:0;align-items:center}
.foot::before{content:"";position:absolute;left:0;right:0;top:-2.2mm;border-top:1.2pt solid ${G}}
.foot p{max-width:72%;font-family:${SERIF};font-style:italic;font-size:8pt;line-height:1.55;color:${PALE}}
.foot .pg{color:${GN};letter-spacing:2.6px}

/* A closing welcome band, if a designer adds one: ruled, not filled, and no mark in it. */
.welcome{margin-top:6mm;border:0;border-top:1.2pt solid ${N};border-bottom:.6pt solid ${H}}
.welcome-b{padding:3mm 0;background:none}
.welcome .k{color:${GT}}
.welcome .t{font-family:${SERIF};font-weight:400;color:${N}}
.welcome-cap{display:none;background:none}
`.trim();

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
    (name ? `<div class="px-name">${name}</div>` : "") +
    (role ? `<div class="px-role">${role}</div>` : "") +
    (reportsTo ? `<div class="micro px-line">Reporting to the ${reportsTo}</div>` : "") +
    (badge ? `<div class="micro px-line">${badge}</div>` : "") +
    "</div>" +
    (meta ? `<div class="px-meta">${meta}</div>` : "") +
    '</header><div class="px-gild"></div>'
  );
}

/**
 * The letter's blocks as Prestige markup.
 *
 * The letterhead, reference and title blocks become ONE cover plate, drawn where the first of them
 * stands; the others of the three are absorbed. The rail is dropped (the plate opens the page).
 * Every other block is the ordinary block. A second letterhead, reference or title block, if a
 * designer adds one, is drawn as the base draws it.
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
  if (used.length === 0) return blocks.map(render).join("");
  const plateAt = Math.min(...used);

  return blocks
    .map((block, index) => {
      if (index === plateAt) {
        return prestigeCoverPlate(
          {
            control: at.control >= 0 ? blocks[at.control] : undefined,
            letterhead: at.letterhead >= 0 ? blocks[at.letterhead] : undefined,
            title: at.title >= 0 ? blocks[at.title] : undefined,
          },
          fill,
          logoSrc,
        );
      }
      if (PLATE_TYPES.has(block.type) && (index === at.control || index === at.letterhead || index === at.title)) return "";
      if (block.type === "rail") return "";
      return render(block);
    })
    .join("");
}
