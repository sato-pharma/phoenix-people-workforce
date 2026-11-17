import { HOUSE_COLORS } from "@/lib/hiring-pack/house-identity";
import { PREMIUM_LATIN_FONT_STACK } from "@/lib/hiring-pack/premium-identity";

/**
 * The prestige skin — the engraved-letter look laid over the shared offer blocks.
 *
 * It is an OVERRIDE sheet appended to the base, exactly as the house and premium skins are, and it
 * changes the look, never the content: every word, figure, clause, step and signature cell the other
 * designs print, this prints, in the same order.
 *
 * WHAT IT DOES, AND WHY:
 *   · THE OXFORD DOUBLE RULE closes the letterhead — a 1.2pt Brand Deep rule with a hairline just
 *     under it — and a CSS `double` border repeats it over the total row and over the signatures.
 *     It is how an engraved company letter is ruled, and it gives the page its weight without a
 *     single filled area.
 *   · A SERIF DISPLAY FACE for the title, the monthly figure, the annual figure, the clause numerals,
 *     the section numerals and the two signatories' names — the things a reader's eye lands on.
 *     Georgia where installed, Noto Serif on the server (the production image installs the Noto
 *     families), Times as the last resort. Running text stays in the house sans.
 *   · SECTIONS NUMBERED IN ROMAN CAPITALS by a CSS counter, so a section a designer adds or removes
 *     renumbers itself; the markup is the base's, untouched.
 *   · THE INK RULE: lines and type only. The base sheet's filled masses — the top rail, the tinted
 *     salary hero, the ink clause tiles, the filled acceptance header, the grey-behind-white grids —
 *     are each switched off or turned to nothing under their own selector. The ONE fill left is the
 *     6% zebra on the salary table.
 *
 * NO PAGE CHROME, NO IMAGE. It names no `/brand/` file and tiles no background, so the preview and
 * the PDF hand it over as they hand over the classic letter, and nothing in it is rasterised soft.
 *
 * NOTHING HERE ROUNDS A CORNER, CASTS A SHADOW OR DRAWS A GRADIENT — the base's `*{border-radius:0}`
 * holds, and the owner's rule is that nothing designed may look machine-made.
 *
 * THE SEAL STAYS ON THE COMPANY'S RULE ONLY, placed as the premium letter places it: 21mm, its foot
 * on the signatory's rule, clear of the word SIGNATURE (owner, 19 Oct 2026, "Move the seal"). The
 * signature cell and the signature ink are the base's, untouched.
 *
 * NO BACKTICKS IN THE CSS BELOW — it is a template literal, and one would close it.
 */
const D = HOUSE_COLORS.deep;
const B = HOUSE_COLORS.blue;
const H = HOUSE_COLORS.hair;
const M = HOUSE_COLORS.muted;

/** The display face. Georgia on a desk, Noto Serif in the production image, Times last. */
export const PRESTIGE_SERIF_STACK = "Georgia,'Noto Serif','Times New Roman',serif";
const SERIF = PRESTIGE_SERIF_STACK;
const SANS = PREMIUM_LATIN_FONT_STACK;

export const PRESTIGE_OFFER_SKIN = `
/* The section counter lives on the sheet, so every letter starts at I. */
.sheet{counter-reset:pxsec}

/* No filled top bar: the double rule under the letterhead opens the page. */
.rail{display:none}

/* The letterhead: the mark left, the company's names right in spaced capitals, closed by the Oxford
   double rule — the heavy rule is the letterhead's own border, the hairline sits 2.6pt beneath it. */
.letterhead{position:relative;margin-top:1mm;padding:0 0 3.2mm;border-bottom:1.2pt solid ${D}}
.letterhead::after{content:"";position:absolute;left:0;right:0;bottom:-2.8pt;border-top:.4pt solid ${D}}
.letterhead img{height:44px}
.letterhead .logo-gap{height:44px}
.letterhead .org .name{color:${D};font-size:7.4pt;letter-spacing:2.6pt}
.letterhead .org .unit{margin-top:1.2mm;color:${M};font-size:6.6pt;letter-spacing:2pt}
.letterhead .org .tagline{color:${B}}

/* The reference ledger: no box at all — spaced captions over the values, hair rules between the
   cells and one under them. Built from borders, never from a painted container. */
.control{gap:0;margin-top:5.5mm;background:none;border:0;border-bottom:.4pt solid ${H}}
.control > div{background:none;padding:0 3mm 2mm;border-left:.4pt solid ${H}}
.control > div:first-child{padding-left:0;border-left:0}
.control .k{color:${M};font-size:6.2pt;letter-spacing:1.6pt}
.control .v{margin-top:1mm;color:var(--ink);font-size:9.2pt}
.control .v.brandv{color:${D}}

/* The title: a serif display line in Brand Deep, the role under it in spaced blue capitals, then a
   short deep rule — the one place the base's divider is drawn as a mark rather than a hairline. */
.title-row{margin-top:7mm}
h1{margin-top:0;font-family:${SERIF};font-size:27pt;font-weight:400;line-height:1.05;letter-spacing:-.2pt;color:${D}}
.role-line{margin-top:2.6mm;color:${B};font-size:7.6pt;font-weight:700;letter-spacing:2.6pt;text-transform:uppercase}
.appt{margin:2mm 0 0;padding:0;background:none;border:0;text-align:right}
.appt .k{color:${M}}
.appt .v{color:${D}}

/* Every divider is switched off here, and drawn again only where it means something. The base draws
   a brand tick and a tiled engine-turned band; neither belongs to this letter. */
.divider-micro{display:block;margin:0}
.divider-micro::before{display:none;background:none}
.divider-micro::after{display:none;background:none}
.title-row + .divider-micro{margin:4.5mm 0 5mm}
.title-row + .divider-micro::before{content:"";display:block;width:16mm;height:0;border-top:1pt solid ${D}}

.lead{font-size:10.2pt}
.lede-mark{background:none;color:${D};border:.5pt solid ${H}}

/* The scope ledger: a deep rule over it, hair rules between the cells and under it. */
.scope{gap:0;margin-top:5mm;background:none;border:0;border-top:.8pt solid ${D};border-bottom:.4pt solid ${H}}
.scope > div{background:none;padding:2mm 3mm;border-left:.4pt solid ${H}}
.scope > div:first-child{padding-left:0;border-left:0}
.scope .k{color:${B};font-size:6.2pt;letter-spacing:1.6pt}
.scope .v{margin-top:1mm;font-size:9.4pt}

/* Section voice: a Roman numeral in the serif, the label in spaced deep capitals, and a hairline
   running to the column edge. The counter renumbers itself when a designer adds or drops a section. */
.section-h{display:flex;align-items:baseline;gap:3mm;margin-top:7mm;counter-increment:pxsec}
.section-h > .micro{flex:none;color:${D};font-size:7.2pt;letter-spacing:2.2pt;white-space:nowrap}
.section-h > .micro::before{content:counter(pxsec,upper-roman);margin-right:2.8mm;font-family:${SERIF};font-size:11pt;font-weight:400;letter-spacing:0;color:${B}}
.section-h .sub{color:${M}}
.section-h .divider-micro{flex:1 1 auto;align-self:center;min-width:0;height:0;border-top:.4pt solid ${H}}
/* The first heading after the forced page break sits on the page's own top margin. */
.page-break + .section-h{margin-top:0}

/* Compensation. The hero is plain and ruled off; the monthly figure is the serif display face in
   Brand Deep with the currency set small and high beside it; the data rows carry the ONE allowed
   fill, the 6% zebra; the total is a double rule, never a bar. */
.comp{margin-top:3.5mm;border:0;border-top:.8pt solid ${D}}
.comp-hero{background:none;padding:4mm 3mm 3.5mm;border-bottom:.4pt solid ${H}}
.comp-hero .k{color:${B};font-size:6.4pt;letter-spacing:1.6pt}
.comp-hero .big{margin-top:2.2mm;font-family:${SERIF};font-size:30pt;font-weight:400;letter-spacing:-.4pt;color:${D}}
.comp-hero .big .cur{margin-right:2.4mm;font-family:${SANS};font-size:8.4pt;font-weight:700;letter-spacing:1.6pt;vertical-align:1.1em;color:${B}}
.comp-hero .aside .k{color:${M}}
.comp-hero .aside .v{font-family:${SERIF};font-size:15pt;font-weight:400;letter-spacing:0;color:${D}}
.comp-hero .aside .n{color:${M}}
.comp th{padding:2mm 3mm;background:none;color:${M};font-size:6.2pt;letter-spacing:1.6pt;border-bottom:.4pt solid ${H}}
.comp td{padding:1.7mm 3mm;border-bottom:.4pt solid ${H};color:var(--body)}
.comp td.lbl{color:var(--ink)}
.comp tbody tr:not(.total):nth-child(odd) td{background:var(--tint)}
.comp tr.total td{padding-top:2.4mm;padding-bottom:2.4mm;background:none;border-top:2.4pt double ${D};border-bottom:0;color:${D};font-size:10.4pt}
.comp-note{padding:2.2mm 3mm;background:none;border-top:0;border-bottom:.4pt solid ${H};color:${M};font-family:${SERIF};font-style:italic;font-size:8.8pt}

/* Benefits: a deep rule over a two-column ledger, hair rules between and under the cells. */
.benefits{gap:0;margin-top:3.5mm;background:none;border:0;border-top:.8pt solid ${D}}
.benefits > div{background:none;padding:2.4mm 3mm;border-bottom:.4pt solid ${H}}
.benefits > div:nth-child(odd){padding-left:0;border-right:.4pt solid ${H}}
.benefits > div:nth-child(even){padding-right:0;padding-left:4mm}
.benefits .k{color:${D};font-size:6.6pt;letter-spacing:1.5pt}

/* Clauses: the numeral is a deep-blue serif figure standing on its own — never a filled ink tile. */
.clause{gap:5mm;padding:3mm 0;border-bottom:.4pt solid ${H}}
.clause.first{border-top:.8pt solid ${D}}
.clause .no{display:block;width:8mm;height:auto;background:none;color:${D};font-family:${SERIF};font-size:17pt;font-weight:400;line-height:1;text-align:right}
.clause .h{color:${D};font-size:9.8pt}

/* Steps: a deep rule over a three-column ledger, the blue index over each. */
.steps{gap:0;margin-top:3.5mm;background:none;border:0;border-top:.8pt solid ${D};border-bottom:.4pt solid ${H}}
.steps > div{background:none;padding:2.4mm 3mm;border-left:.4pt solid ${H}}
.steps > div:first-child{padding-left:0;border-left:0}
.steps .n{color:${B};font-size:6.2pt;letter-spacing:1.6pt}
.steps .h{color:${D}}

/* The acceptance block opens on the double rule, as the total does. No filled header: a Brand Deep
   label ruled off with a hairline; the two signatories are named in the serif. */
.accept{margin-top:7mm;border:0;border-top:2.4pt double ${D}}
.accept-h{padding:2.2mm 0;background:none;border-bottom:.4pt solid ${H}}
.accept-h .micro{color:${D};letter-spacing:2.4pt}
.accept-b{gap:0;background:none}
.accept-b > div{background:none;padding:3mm 4mm}
.accept-b > div:first-child{padding-left:0;border-right:.4pt solid ${H}}
.accept-b > div:last-child{padding-right:0}
.accept .k{color:${B};font-size:6.2pt;letter-spacing:1.6pt}
.accept .party{margin-top:1.4mm;font-family:${SERIF};font-size:12pt;font-weight:400;color:${D}}
.accept .sub{color:${M}}
/* Headroom on both parties' signature rows, so the four rules stay level and the company's seal
   clears the signatory's name and title above it. */
.accept .sigrow{padding-top:11mm}
/* The seal: 21mm, its foot on the signatory's rule, in the left half of the cell where the signature
   is made — never centred over the word SIGNATURE. The candidate's cell never carries one. */
.accept .offer-seal{left:22mm;top:auto;bottom:4.6mm;width:21mm;height:21mm;transform:rotate(-7deg)}

/* The closing note: a hairline over muted type, the company in spaced deep capitals. */
.foot{margin-top:6mm;padding-top:2.6mm;border-top:.4pt solid ${H}}
.foot p{color:${M};font-size:8pt}
.foot .pg{color:${D};letter-spacing:2.4pt}

/* A closing welcome band, if a designer adds one: ruled, not filled, and no mark in it. */
.welcome{margin-top:5mm;border:0;border-top:.8pt solid ${D};border-bottom:.4pt solid ${H}}
.welcome-b{padding:3mm 0;background:none}
.welcome .k{color:${B}}
.welcome .t{font-family:${SERIF};font-weight:400;color:${D}}
.welcome-cap{display:none;background:none}
`.trim();
