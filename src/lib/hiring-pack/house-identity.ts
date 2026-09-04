// The house document identity — SATO-DIS-2026-01 v1.0, approved by the owner 2026-09-05.
//
// Every document Sato Pharma issues wears this: the hiring pack, the leavers pack, offer letters,
// and any letter or certificate written on company paper. The approved specimen is
// `xlsx/Sato-Pharma-Document-Identity-Standard.pdf`.
//
// WHY THIS MODULE EXISTS. Four renderers — the contract, both clearances, both custody receipts and
// the worker data form — each carried their own private copy of a navy masthead. They had already
// drifted apart (16 pt here, 15 pt there; a 30 mm mark in one file and 32 mm in another), and the
// job-offer letters were on a different blue entirely. A house identity that lives in five places is
// not a house identity; it is five identities that happen to agree today.
//
// THE INK RULE IS THE POINT, not a preference. These print in volume on office machines — a contract
// in three copies, a clearance in two, a custody receipt for every device issued. The owner's
// instruction was to spend no toner on decoration, so the identity is carried by LINES AND TYPE and
// never by filled area. Measured on the approved specimen, this took page coverage from 9.97% to
// 3.18% — roughly a 69% toner saving for exactly the same information.
//
// The one deliberate filled element besides the mark is the zebra row on data tables, which the
// owner asked for by name, at 6% of Brand Blue. It REPLACES the row hairline rather than joining it.
//
// GOVERNMENT FORMS ARE EXEMPT, PERMANENTLY. Social-insurance Form 1, Form 6 and the labour exit form
// are facsimiles of what the Authority itself issues; they print exactly as the Authority lays them
// out. Do not import this module into `render-form1.ts`, `render-form6.ts` or `render-labour-exit.ts`
// — restyling one of those makes it a form the insurance office can refuse.

import { escapeHtml } from "@/lib/hiring-pack/render-shared";

/**
 * The palette, sampled pixel-by-pixel from the company mark rather than chosen.
 *
 * The three blues are the three strokes of the wave and the ink is the SATO wordmark, so a document
 * drawn in these cannot drift away from the logo sitting above it. THE NAVY #0B2A4A THESE DOCUMENTS
 * USED BEFORE APPEARS NOWHERE IN THE LOGO — it came from the old Word originals, and replacing it is
 * the single reason the letterhead and the mark now read as one family.
 *
 * Sampling, if these ever need re-deriving: `sharp(logo).raw()`, count opaque pixels by RGB, and the
 * three dominant non-black values are Deep, Blue and Light in ascending lightness.
 */
export const HOUSE_COLORS = {
  /** The SATO wordmark. Body text on legal instruments, and every signature rule. */
  ink: "#000000",
  /** The wave's darkest stroke. Titles, headings, table headers. */
  deep: "#0A527D",
  /** The PHARMA wordmark itself. The brand rule and section rules. */
  blue: "#0A6BA6",
  /** The wave's lightest stroke. Callout edges. */
  light: "#1482C2",
  /** Brand Blue at 6% on white — the zebra row, and nothing else. */
  tint: "#F2F6FA",
  hair: "#B9C7D4",
  muted: "#5A6B7C",
  body: "#1A1A1A",
} as const;

/**
 * The mark, as a path under `public/`.
 *
 * ALWAYS THE ON-LIGHT FILE ON PAPER. The stock `sato-pharma-logo.png` sets "SATO" in WHITE for use
 * on dark grounds; the house format has no dark grounds, so on white paper that half of the mark
 * disappears and the letterhead reads "PHARMA". That has already reached printed output once.
 */
export const HOUSE_MARK_SRC = "/brand/sato-pharma-logo-on-light.png";

/** Standard width of the mark on a letterhead. Below 24 mm the PHARMA counters fill in. */
export const HOUSE_MARK_WIDTH_MM = 34;

/**
 * The house stylesheet: the letterhead, the type scale, tables, callouts and the signature block.
 *
 * Written as CSS custom properties so a document's own stylesheet can reach the palette by name
 * (`var(--phx-doc-deep)`) instead of repeating a hex it will later fail to update. The prefix keeps
 * these clear of the app's `--phx-*` design tokens, which are a different system for a different
 * medium — screen, where filled area costs nothing.
 *
 * LOGICAL PROPERTIES THROUGHOUT (`border-inline-start`, not `border-left`). These documents are
 * Arabic and lay out right-to-left; a physical `left` puts every callout rule and every heading tick
 * on the wrong side of the page, which reads as a broken template rather than a mirrored one.
 */
export const HOUSE_IDENTITY_CSS = `
  :root {
    --phx-doc-ink:   ${HOUSE_COLORS.ink};
    --phx-doc-deep:  ${HOUSE_COLORS.deep};
    --phx-doc-blue:  ${HOUSE_COLORS.blue};
    --phx-doc-light: ${HOUSE_COLORS.light};
    --phx-doc-tint:  ${HOUSE_COLORS.tint};
    --phx-doc-hair:  ${HOUSE_COLORS.hair};
    --phx-doc-muted: ${HOUSE_COLORS.muted};
    --phx-doc-body:  ${HOUSE_COLORS.body};
  }

  /* ---------- the letterhead — no filled areas, anywhere ---------- */
  /* THE ROW IS PINNED LEFT-TO-RIGHT, and the direction is the whole point. These documents lay out
     right-to-left, so a direction-following row puts the mark on the RIGHT — which is not what the
     approved sheet shows, and not where the contract has always carried it. The mark belongs
     physically LEFT on every document, Arabic or English, so the two never disagree. The text inside
     each half keeps its own direction; only the order of the two halves is fixed here. */
  .lh {
    display: flex; direction: ltr;
    align-items: flex-end; justify-content: space-between; gap: 8mm;
  }
  .lh__mark img { display: block; width: ${HOUSE_MARK_WIDTH_MM}mm; height: auto; }
  .lh__id { text-align: right; color: var(--phx-doc-muted); font-size: 6.5pt; line-height: 1.5; }
  .lh__id strong { display: block; color: var(--phx-doc-deep); font-size: 8pt; font-weight: 700; }

  /* The one element on every document without exception. 0.7 mm of rule, and it is what makes a
     page recognisable at arm's length — the job the filled navy band used to do, for ~1% of it. */
  .lh__rule { height: .7mm; background: var(--phx-doc-blue); margin-top: 2.2mm; }

  .lh__title { text-align: center; padding: 3.3mm 0 2.2mm; }
  .lh__title h1 { margin: 0; color: var(--phx-doc-deep); font-size: 17pt; font-weight: 700; line-height: 1.2; }
  .lh__title p { margin: 1.2mm 0 0; color: var(--phx-doc-muted); font-size: 8pt; font-weight: 600; }
  .lh__hair { border-top: .5pt solid var(--phx-doc-hair); }

  /* Who keeps this copy. Ruled, never filled — it is the one line that stops the employee's copy
     and the company's copy being confused, so it is given its own band rather than a footnote. */
  .lh__purpose {
    margin: 0; padding: 1.5mm 0;
    border-top: .5pt solid var(--phx-doc-hair);
    border-bottom: .5pt solid var(--phx-doc-hair);
    color: var(--phx-doc-deep); font-size: 8.5pt; font-weight: 700; text-align: center;
  }

  /* ---------- the invisible half: costs no ink, only care ---------- */
  p, li { orphans: 3; widows: 3; }
  .lh__title, .lh__purpose { break-after: avoid; page-break-after: avoid; }
`;

/**
 * Hairlines never thinner than 0.5 pt.
 *
 * Below that a rule is thinner than a 600 dpi printer can resolve, so it drops out on some machines
 * and survives on others — which reads as a defective document rather than a thin line.
 */
export const HOUSE_HAIRLINE_PT = 0.5;

export interface HouseLetterheadInput {
  /** The document's own title, in Arabic. Printed 17 pt bold in Brand Deep. */
  titleAr: string;
  /** The line under it — the law it is written against, or what the paper is for. */
  subtitleAr?: string | null;
  /**
   * Who keeps this copy. Optional: a letter has no such line, a two-copy instrument always does.
   */
  purposeAr?: string | null;
  /** The company as a legal person — its registered name. */
  legalNameAr: string;
  /** The same name in Latin script, under it. Omitted on forms that are Arabic-only. */
  legalNameEn?: string | null;
}

/**
 * The letterhead every document opens with.
 *
 * Deliberately does NOT carry the commercial-register recital. Each instrument states the company's
 * registration in its own words and its own order — the contract's recital is part of the contract's
 * text and is quoted back in disputes — so folding it in here would put this layout's punctuation
 * inside language that belongs to the document. The mark and the name are the identity; the registry
 * detail stays where the document's author put it.
 */
export function houseLetterhead(input: HouseLetterheadInput): string {
  const subtitle = input.subtitleAr?.trim()
    ? `<p>${escapeHtml(input.subtitleAr.trim())}</p>`
    : "";

  // PINNED LEFT-TO-RIGHT, and this is not decoration. These documents lay out right-to-left, and
  // the full stop that ends "Sato Pharma L.L.C." is a NEUTRAL character: with nothing to hold it,
  // the bidirectional algorithm resolves it to the paragraph direction and paints it at the LEFT
  // end of the run, so the letterhead reads ".Sato Pharma L.L.C" — measured in a browser, on this
  // very letterhead, before this line existed. `dir="ltr"` on the element that holds only Latin is
  // the fix; never `dir="auto"` on the block, which reads the first strong character and would turn
  // the Arabic name above it around instead.
  const nameEn = input.legalNameEn?.trim()
    ? `<span dir="ltr">${escapeHtml(input.legalNameEn.trim())}</span>`
    : "";

  const purpose = input.purposeAr?.trim()
    ? `<p class="lh__purpose">${escapeHtml(input.purposeAr.trim())}</p>`
    : "";

  return `<header class="lh">
      <div class="lh__mark"><img src="${HOUSE_MARK_SRC}" alt="" width="401" height="158"></div>
      <div class="lh__id"><strong>${escapeHtml(input.legalNameAr)}</strong>${nameEn}</div>
    </header>
    <div class="lh__rule"></div>
    <div class="lh__title">
      <h1>${escapeHtml(input.titleAr)}</h1>
      ${subtitle}
    </div>
    <div class="lh__hair"></div>
    ${purpose}`;
}
