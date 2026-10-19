import { HOUSE_COLORS } from "@/lib/hiring-pack/house-identity";
import {
  PREMIUM_COMPANY_DOCUMENT_BRAND,
  PREMIUM_IDENTITY_CSS,
  premiumMasthead,
  premiumPageChrome,
  premiumSheetCss,
} from "@/lib/hiring-pack/premium-identity";
import type { OfferBlock } from "@/lib/offers/types";

/**
 * The premium skin — the HR premium identity laid over the shared offer blocks, as the house skin
 * lays the house identity over them.
 *
 * It is an OVERRIDE sheet appended to the base, and it changes the look, never the content: every
 * word, figure, clause, step and signature cell the other designs print, this prints. What it adds
 * is the identity's own geometry (the frame, the foot and the watermark are drawn by
 * `premiumPageChrome`, the sheet by `premiumSheetCss`) and its voice for each block.
 *
 * THE INK RULE, as the house skin keeps it and the owner set it: lines and type only. The base
 * sheet's filled masses are stripped back to rules — the top rail, the tinted salary hero, the ink
 * clause tiles, the filled acceptance header — and the base's grids, which fake their hairlines by
 * painting a container grey behind white cells, are rebuilt from real borders. The ONE fill left is
 * the 6% zebra on the salary table.
 *
 * NO CSS BACKGROUND TILE. The base draws a per-section engine-turned band as a tiled background; the
 * identity's band is an inline vector (`premiumBandSvg`, inside the masthead), because Chrome
 * rasterises a background tile and it printed soft. The base's tile is switched off here.
 *
 * NOTHING IN HERE ROUNDS A CORNER OR CASTS A SHADOW — the base's `*{border-radius:0}` already holds.
 *
 * THE SEAL STAYS ON THE COMPANY'S RULE ONLY, BUT IT IS PLACED HERE. `.sigcell` and the signature ink
 * are the base's, untouched, and the candidate's cell is never stamped or signed. The base centres a
 * 30mm seal on the whole cell, which printed the word SIGNATURE under the impression, so the premium
 * letter sets it smaller with its foot on the rule (owner, 19 Oct 2026: "Move the seal").
 *
 * NO BACKTICKS IN THE CSS BELOW — it is a template literal, and one would close it.
 */
const D = HOUSE_COLORS.deep;
const B = HOUSE_COLORS.blue;
const L = HOUSE_COLORS.light;
const H = HOUSE_COLORS.hair;
const M = HOUSE_COLORS.muted;

const OFFER_RULES = `
/* The sheet is one A4 page wide on screen too, so the frame lands on its edge. In print the page IS
   the sheet and the premium sheet rules above own the padding. */
.sheet{width:210mm;max-width:210mm;margin:0 auto}
@media screen{.sheet{min-height:297mm}}
@media print{.sheet{width:auto;max-width:none;margin:0}}

/* No filled top bar: the identity carries no top-edge bar, its masthead and band open the page. */
.rail{display:none}

/* Every divider in the letter is a hairline. The base draws a brand tick and a tiled engine-turned
   band here; the band belongs to the masthead alone, as an inline vector. */
.divider-micro{margin:0}
.divider-micro::before{display:none}
.divider-micro::after{content:"";display:block;flex:1;height:0;background:none;border-top:.5pt solid ${H}}

/* The reference strip, and every other strip: a deep rule over it, hair rules between the cells and
   under it. Built from borders, never from a painted container. */
.control{gap:0;margin-top:4mm;background:none;border:0;border-top:.7pt solid ${D};border-bottom:.4pt solid ${H}}
.control > div{background:none;padding:2mm 3mm;border-left:.4pt solid ${H}}
.control > div:first-child{padding-left:0;border-left:0}
.control .k{color:${B};font-size:6.4pt;letter-spacing:1.3pt}
.control .v{margin-top:.8mm;color:var(--ink);font-size:9.6pt}
.control .v.brandv{color:${D}}

.scope{gap:0;margin-top:4mm;background:none;border:0;border-top:.7pt solid ${D};border-bottom:.4pt solid ${H}}
.scope > div{background:none;padding:2mm 3mm;border-left:.4pt solid ${H}}
.scope > div:first-child{padding-left:0;border-left:0}
.scope .k{color:${B};font-size:6.4pt;letter-spacing:1.3pt}
.scope .v{margin-top:.8mm;font-size:9.6pt}

/* The letter opens under the reference strip, so it needs the room the old title row gave it. */
.control + p{margin-top:4.5mm}

/* The salutation tile, if a design keeps one: a ruled initial, never a filled square. */
.lede-mark{background:none;color:${D};border:.5pt solid ${H}}

/* Section voice: a micro label in blue with a hairline running to the column edge. */
.section-h{display:flex;align-items:center;gap:3mm;margin-top:6mm}
.section-h .micro{flex:none;color:${B};font-size:7pt;letter-spacing:1.6px;white-space:nowrap}
.section-h .sub{color:${M};letter-spacing:1.2px}
.section-h .divider-micro{flex:1 1 auto;min-width:0}
/* The first heading of a page that follows the forced break sits on the sheet's own top inset, level
   with the masthead on page one, rather than six millimetres lower. */
.page-break + .section-h{margin-top:0}

/* The appointment chip, if a title carries one: ruled type under the band, no tinted or ink box. */
.appt{margin:2mm 0 0;padding:0;background:none;border:0;text-align:right}
.appt .k{color:${B}}
.appt .v{color:${D}}

/* Compensation — the ink rule's hardest case. The hero is plain, ruled off; its figures are Brand
   Deep; the header is blue type over a deep rule; the data rows carry the ONE allowed fill, the 6%
   zebra; the total is a deep top rule, not a bar. */
.comp{margin-top:3mm;border:0;border-top:.7pt solid ${D}}
.comp-hero{background:none;padding:3.5mm 3mm 3mm;border-bottom:.4pt solid ${H}}
.comp-hero .k{color:${B}}
.comp-hero .big{color:${D}}
.comp-hero .aside .v{color:${D}}
.comp-hero .aside .n{color:${M}}
.comp th{padding:2mm 3mm;background:none;color:${B};border-bottom:.7pt solid ${D}}
.comp td{padding:1.6mm 3mm;border-bottom:.4pt solid ${H}}
.comp tbody tr:not(.total):nth-child(odd) td{background:var(--tint)}
.comp tr.total td{padding-top:2.2mm;padding-bottom:2.2mm;background:none;border-top:.8pt solid ${D};border-bottom:0;color:${D}}
.comp-note{padding:2mm 3mm;background:none;border-top:.4pt solid ${H};border-bottom:.4pt solid ${H};color:${M}}

/* Benefits: a deep rule over a two-column strip, hair rules between and under the cells. */
.benefits{gap:0;margin-top:3mm;background:none;border:0;border-top:.7pt solid ${D}}
.benefits > div{background:none;padding:2.2mm 3mm;border-bottom:.4pt solid ${H}}
.benefits > div:nth-child(odd){padding-left:0;border-right:.4pt solid ${H}}
.benefits > div:nth-child(even){padding-right:0}
.benefits .k{color:${B};font-size:6.8pt;letter-spacing:1.3pt}

/* Clauses: the numeral is OUTLINE type — transparent, stroked in the light blue — never a filled ink
   tile; a deep rule opens the set and hair rules separate the clauses. */
.clause{gap:4mm;padding:2.6mm 0;border-bottom:.4pt solid ${H}}
.clause.first{border-top:.7pt solid ${D}}
.clause .no{width:7mm;height:auto;justify-content:flex-start;align-items:flex-start;background:none;color:transparent;-webkit-text-stroke:.55pt ${L};font-size:16pt;font-weight:300;line-height:1}
.clause .h{color:${D}}

/* Steps: a deep rule over a three-column strip, the blue index over each. */
.steps{gap:0;margin-top:3mm;background:none;border:0;border-top:.7pt solid ${D};border-bottom:.4pt solid ${H}}
.steps > div{background:none;padding:2.2mm 3mm;border-left:.4pt solid ${H}}
.steps > div:first-child{padding-left:0;border-left:0}
.steps .n{color:${B};font-size:6.4pt;letter-spacing:1.3pt}

/* The acceptance block: no filled ink header — a Brand Deep label ruled off with a hairline. The
   signature rules stay ink, and the seal stays where the base draws it, on the company's cell. */
.accept{margin-top:6mm;border:0;border-top:.7pt solid ${D}}
.accept-h{padding:2mm 0;background:none;border-bottom:.4pt solid ${H}}
.accept-h .micro{color:${D}}
.accept-b{gap:0;background:none}
.accept-b > div{background:none;padding:3mm 4mm}
.accept-b > div:first-child{padding-left:0;border-right:.4pt solid ${H}}
.accept-b > div:last-child{padding-right:0}
.accept .k{color:${B};font-size:6.4pt;letter-spacing:1.3pt}
.accept .sub{color:${M}}
/* Headroom on every signature row, both parties, so the four rules stay level while the company's
   impression, which the base lays across its rule, no longer lands on the signatory's name and title. */
.accept .sigrow{padding-top:11mm}
/* The company impression rides ABOVE the signatory's rule, clear of the SIGNATURE label under it and
   of the name and title above. The base centres a 30mm seal on the whole cell, which puts the word
   SIGNATURE under the ink; here it is 21mm, its foot sits on the rule, and it keeps to the left half
   of the cell where the signature is made. The candidate's cell never carries one. */
.accept .offer-seal{left:22mm;top:auto;bottom:4.6mm;width:21mm;height:21mm;transform:rotate(-7deg)}

/* The closing note: a hairline over muted type. */
.foot{margin-top:5mm;padding-top:2.4mm;border-top:.4pt solid ${H}}
.foot p{color:${M}}
.foot .pg{color:${B}}

/* A closing welcome band, if a design keeps one: ruled, not filled, and no mark in it. */
.welcome{margin-top:5mm;border:0;border-top:.7pt solid ${D};border-bottom:.4pt solid ${H}}
.welcome-b{padding:3mm 0;background:none}
.welcome .k{color:${B}}
.welcome .t{color:${D}}
.welcome-cap{display:none}
`.trim();

/**
 * The premium design's whole stylesheet addition: the premium sheet geometry (`@page` margin 0 and
 * the sheet's own padding, so the fixed frame and foot reach the edges), the identity's chrome and
 * masthead, then the offer's own rules above.
 */
export const PREMIUM_OFFER_SKIN = `${premiumSheetCss(".sheet")}\n${PREMIUM_IDENTITY_CSS}\n${OFFER_RULES}`;

/**
 * The page chrome of a premium offer — watermark, frame, running foot — appended as the LAST child of
 * the sheet. The foot is the Sato-only one: nothing the candidate reads says Phoenix.
 */
export function premiumOfferChrome(): string {
  return premiumPageChrome({ brand: PREMIUM_COMPANY_DOCUMENT_BRAND });
}

/**
 * The masthead, built from the letterhead and title blocks so editing either in the designer moves it.
 *
 * Every string is passed in ALREADY FILLED AND ESCAPED (`fillOfferTokens`), so the masthead is told
 * not to escape again. The company's name, its unit and any tagline share the names line — the words
 * the base letterhead prints — and the Arabic registered name is NOT added: the base offer never
 * printed it, and the premium letter changes dress, not wording.
 */
function premiumOfferMasthead(
  letterhead: OfferBlock | undefined,
  title: OfferBlock | undefined,
  fill: (value: unknown) => string,
): string {
  const head = letterhead?.props ?? {};
  const titleProps = title?.props ?? {};
  const names = [fill(head.name), fill(head.unit), fill(head.tagline)]
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join(" · ");
  const sub = fill(titleProps.sub).trim();
  const masthead = premiumMasthead({
    escaped: true,
    legalNameAr: "",
    legalNameEn: names,
    subtitles: sub ? [{ lang: "en", text: sub }] : [],
    title: fill(titleProps.h1),
    titleLang: "en",
  });

  // The appointment chip is the executive design's two-line label; the premium default carries none,
  // but a title block a designer gave one keeps its words.
  const badge = fill(titleProps.badge);
  const badgeK = fill(titleProps.badgeK);
  const chip =
    badge || badgeK
      ? `<div class="appt keep">${badgeK ? `<div class="micro k">${badgeK}</div>` : ""}` +
        `${badge ? `<div class="micro v">${badge}</div>` : ""}</div>`
      : "";
  return masthead + chip;
}

/**
 * The letter's blocks as premium markup.
 *
 * The masthead has the title INSIDE it (the premium masthead is mark, names, title, diamond rule and
 * subtitle in one centred block), so the letterhead and title blocks are drawn together, once, where
 * the first of them stands, and the other is absorbed. The reference strip that sat between them in
 * the other designs now follows the masthead; the words are unchanged. A second letterhead or title
 * block, if a designer adds one, is drawn as the base draws it.
 */
export function premiumOfferBody(
  blocks: OfferBlock[],
  render: (block: OfferBlock) => string,
  fill: (value: unknown) => string,
): string {
  const letterheadAt = blocks.findIndex((block) => block.type === "letterhead");
  const titleAt = blocks.findIndex((block) => block.type === "title");
  const mastheadAt = Math.min(...[letterheadAt, titleAt].filter((index) => index >= 0));

  return blocks
    .map((block, index) => {
      if (!Number.isFinite(mastheadAt)) return render(block);
      if (index === mastheadAt) {
        return premiumOfferMasthead(
          letterheadAt >= 0 ? blocks[letterheadAt] : undefined,
          titleAt >= 0 ? blocks[titleAt] : undefined,
          fill,
        );
      }
      if (index === letterheadAt || index === titleAt) return "";
      return render(block);
    })
    .join("");
}
