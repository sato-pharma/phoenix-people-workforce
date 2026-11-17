import { defaultOfferBlocks } from "@/lib/offers/default-template";
import { HOUSE_COLORS } from "@/lib/hiring-pack/house-identity";
import { PREMIUM_LATIN_FONT_STACK } from "@/lib/hiring-pack/premium-identity";
import type { OfferBlock, OfferTheme } from "@/lib/offers/types";

/**
 * The SIXTH built-in offer design — "SATO Prestige Offer", the navy-and-gold letter.
 *
 * The owner asked for it on 17 Nov 2026 ("a offer tailored to product manager … very premium
 * polished"), and chose "both": a new design beside the five, AND the Product Manager's own wording
 * on the job title, so every design can print it. It is drawn BESIDE the five existing designs and
 * changes none of them: the four frozen ones stay fingerprinted, and Premium keeps its chrome. The
 * Prestige look reaches only a row whose `variant` is `prestige`, through `prestige-skin.ts`.
 *
 * WHAT THE DESIGN IS, in the skin's own terms (each with its reason in `prestige-skin.ts`):
 *   · A NAVY COVER PLATE built from the letterhead, reference and title blocks: the reverse mark, the
 *     company's names, "Offer of Employment" between gold rules, the candidate's name in serif
 *     capitals, the position in serif italic, the reporting line and the reference ledger.
 *   · Flat Sato gold for the rules, corner marks and numerals — never a gradient or a sheen.
 *   · A serif voice for the running text, the figures, the clause numerals and the signatories.
 *   · Sections numbered in Roman capitals, a double rule over the total and over the signatures.
 *   · Three fills only: the cover plate, the 6% zebra on the salary table, and the navy closing plate.
 *
 * The first Prestige (a re-ruling of the ordinary letter) was rejected the same evening — "this is
 * the normal templete" — which is why the plate exists. It carries no page chrome; the preview and
 * the PDF hand it the reverse mark exactly as they hand it to the Sato letter.
 *
 * Nothing on it says Phoenix: the candidate reads a Sato Pharmaceuticals paper.
 *
 * WHICH POSITION OPENS ON IT. The job title Product Manager opens on this design (`opensFor` in
 * `builtin-templates.ts`), because it was made for that offer. The WORDS are not the design's:
 * the Product Manager paragraph lives on the job title (`OFFER_PRODUCT_MANAGER_ROLE_SUMMARY`) and
 * reaches every design through `{{roleSummary}}`, so this design serves any position.
 */
export const OFFER_PRESTIGE_THEME: OfferTheme = {
  body: HOUSE_COLORS.body,
  brand: HOUSE_COLORS.blue,
  // White, so the base sheet's light fills on the scope, steps and total cells never tint anything.
  chip: "#ffffff",
  faint: HOUSE_COLORS.muted,
  frame: HOUSE_COLORS.hair,
  hair: HOUSE_COLORS.hair,
  ink: HOUSE_COLORS.ink,
  line: HOUSE_COLORS.hair,
  muted: HOUSE_COLORS.muted,
  soft: HOUSE_COLORS.muted,
  // The one permitted fill — Brand Blue at 6% — for the salary table's zebra and nothing else.
  tint: HOUSE_COLORS.tint,
  "tint-line": HOUSE_COLORS.hair,
};

export const OFFER_PRESTIGE_FONT = PREMIUM_LATIN_FONT_STACK;
export const OFFER_PRESTIGE_FONT_SIZE_PT = 9.6;
export const OFFER_PRESTIGE_TEMPLATE_NAME = "SATO Prestige Offer";

/**
 * The blocks — the ordinary offer content, reused from the classic factory so the legal words stay a
 * single source of truth across all six designs, with the ids re-keyed to `-x` so a saved prestige
 * template's block ids never collide with another design's edited in the same session.
 */
export function prestigeOfferBlocks(): OfferBlock[] {
  return defaultOfferBlocks().map((block) => ({ ...block, id: `${block.id}-x` }));
}
