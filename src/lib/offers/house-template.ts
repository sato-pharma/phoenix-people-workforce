import { defaultOfferBlocks } from "@/lib/offers/default-template";
import { HOUSE_COLORS } from "@/lib/hiring-pack/house-identity";
import type { OfferBlock, OfferTheme } from "@/lib/offers/types";

/**
 * The FOURTH built-in offer design — the HR-forms house identity (SATO-DIS-2026-01 v1.0), the same
 * look the hiring pack, both clearances, the custody receipts and the worker data form wear.
 *
 * The owner asked for it on 2026-09-22 — "add the fourth template … with the templates used in HR
 * forms". It is drawn BESIDE the three existing designs and changes none of them: the classic,
 * executive and Sato letters keep their own blue, their filled bands and their frozen looks. The
 * house identity reaches only a row whose `variant` is `house`, and only through the CSS skin in
 * `render.ts` — the block CONTENT here is the ordinary offer, so the same words a candidate signs
 * carry across all four designs.
 *
 * THE IDENTITY, and why every choice below is not free:
 *   · The three logo blues — Deep #0A527D (titles, headings, table rules), Blue #0A6BA6 (the one
 *     accent, and the engine-turned band), Light #1482C2 — sampled from the mark, so the letter
 *     cannot drift from the logo sitting above it. `HOUSE_COLORS` is the single source; a hex typed
 *     here would be a fourth copy of a colour the house has already fixed in one place.
 *   · THE INK RULE. These print in volume on office machines, and the owner's instruction for the
 *     house papers is to spend no toner on decoration: the identity is carried by LINES AND TYPE and
 *     never by filled area. So this design has none of the navy masses the other three use — no
 *     filled masthead, no tinted salary hero, no ink clause tiles, no filled accept band. The one
 *     deliberate fill is the 6% zebra on the salary table, which the owner asked for by name. All of
 *     that is enforced in the `HOUSE_SKIN` stylesheet; the tokens here only supply its palette.
 *
 * The tokens map the offer's own slot names onto the house palette. There is no `deep`/`light` slot
 * in `OfferTheme`, so the skin reaches those two by literal where a heading or a rule needs them;
 * `brand` carries Blue, which is also what the shared engine-turned band is drawn in (see
 * `offerDocumentCss`, where the band takes its colour from `merged.brand`).
 */
export const OFFER_HOUSE_THEME: OfferTheme = {
  // Body text is near-black, as on a legal instrument — NOT a blue, or every paragraph would read as
  // a heading. The blues are accents, reached by the skin and by `brand`.
  body: HOUSE_COLORS.body,
  brand: HOUSE_COLORS.blue,
  // White, to kill the light fills the base sheet paints on the scope, steps and total cells — the
  // ink rule keeps those as hairline grids, not tinted boxes.
  chip: "#ffffff",
  faint: HOUSE_COLORS.muted,
  frame: HOUSE_COLORS.hair,
  hair: HOUSE_COLORS.hair,
  ink: HOUSE_COLORS.body,
  line: HOUSE_COLORS.hair,
  muted: HOUSE_COLORS.muted,
  soft: HOUSE_COLORS.muted,
  // The one permitted fill — Brand Blue at 6% — used ONLY for the salary-table zebra, exactly as it
  // is on the house data tables. Nothing else in this design is painted with it.
  tint: HOUSE_COLORS.tint,
  "tint-line": HOUSE_COLORS.hair,
};

/**
 * The house papers lead in the office face — Aptos where it is installed (the owner's own Windows
 * preview), Segoe UI / Arial elsewhere, which is what the headless Chromium that renders the PDF
 * falls back to. A print measurement: a touch smaller than the classic letter, as the house body is.
 */
export const OFFER_HOUSE_FONT = "'Aptos','Segoe UI',Arial,Helvetica,sans-serif";
export const OFFER_HOUSE_FONT_SIZE_PT = 9.6;
export const OFFER_HOUSE_TEMPLATE_NAME = "SATO HR-Forms Offer";

/**
 * The blocks — the ordinary offer content, reused from the classic factory so the legal words stay
 * a single source of truth across all four designs, with the ids re-keyed to `-h` so a saved house
 * template's block ids never collide with a classic one edited in the same session. The house
 * IDENTITY is entirely the skin's work; nothing here is house-specific but the id suffix.
 */
export function houseOfferBlocks(): OfferBlock[] {
  return defaultOfferBlocks().map((block) => ({ ...block, id: `${block.id}-h` }));
}
