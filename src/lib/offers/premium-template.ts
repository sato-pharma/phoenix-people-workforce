import { defaultOfferBlocks } from "@/lib/offers/default-template";
import { HOUSE_COLORS } from "@/lib/hiring-pack/house-identity";
import { PREMIUM_LATIN_FONT_STACK } from "@/lib/hiring-pack/premium-identity";
import type { OfferBlock, OfferTheme } from "@/lib/offers/types";

/**
 * The FIFTH built-in offer design — the HR premium identity, the look the owner named on 2026-10-12
 * after the Talent Acquisition New Starter Handbook and now carried by the normal HR papers.
 *
 * He asked for it on 2026-10-13 — "for job offers create new template with the new identity". It is
 * drawn BESIDE the four existing designs and changes none of them: the classic, executive, Sato and
 * house letters stay exactly as the owner froze them on 2026-09-05. The premium identity reaches only
 * a row whose `variant` is `premium`, and only through the skin in `premium-skin.ts` — the block
 * CONTENT here is the ordinary offer, so the words a candidate signs are the same across all five.
 *
 * THE IDENTITY, in what the skin does with it (each rule has its reason in `premium-skin.ts`):
 *   · The centred masthead — the Latin mark left, the title over a diamond rule, an empty right
 *     column — closed by the engine-turned band drawn as an inline vector, never a CSS tile.
 *   · The double-keyline frame with security microtext, the Arabic calligraphy as a 5% watermark,
 *     and the running foot, all drawn by `premiumPageChrome` and repeated on every printed page.
 *   · THE INK RULE: lines and type only. No filled masthead, no tinted salary hero, no ink clause
 *     tiles, no filled acceptance header. The one fill is the 6% zebra on the salary table.
 *
 * NOTHING SAYS PHOENIX. The offer goes to a candidate who has never heard of the app
 * (`src/lib/offers/identity.ts`), so the foot is the Sato-only one (`PREMIUM_COMPANY_DOCUMENT_BRAND`).
 *
 * THE COMPANY SEAL STAYS on the company's signature rule and nowhere else, drawn once. It belongs to
 * the job offer alone; this design never repeats it. It is set smaller than the base draws it, with
 * its foot on the rule, so it no longer prints over the word SIGNATURE (19 Oct 2026, the owner).
 *
 * The tokens map the offer's own slot names onto the house palette. `OfferTheme` has no `deep` or
 * `light` slot, so the skin reaches those two by literal; `brand` carries Blue, the accent.
 */
export const OFFER_PREMIUM_THEME: OfferTheme = {
  // Running text is near-black, as on a legal instrument — the blues are accents, not body colour.
  body: HOUSE_COLORS.body,
  brand: HOUSE_COLORS.blue,
  // White, so the base sheet's light fills on the scope, steps and total cells never tint anything.
  chip: "#ffffff",
  faint: HOUSE_COLORS.muted,
  frame: HOUSE_COLORS.hair,
  hair: HOUSE_COLORS.hair,
  // The identity's ink: values in the fact strips and every signature rule.
  ink: HOUSE_COLORS.ink,
  line: HOUSE_COLORS.hair,
  muted: HOUSE_COLORS.muted,
  soft: HOUSE_COLORS.muted,
  // The one permitted fill — Brand Blue at 6% — for the salary table's zebra and nothing else.
  tint: HOUSE_COLORS.tint,
  "tint-line": HOUSE_COLORS.hair,
};

/**
 * The premium papers' own face: Segoe UI where installed, Noto Sans on the server (the production
 * image installs it), which is also what the identity's foot and masthead are set in — so the letter
 * and its chrome are one family on every machine.
 */
export const OFFER_PREMIUM_FONT = PREMIUM_LATIN_FONT_STACK;
export const OFFER_PREMIUM_FONT_SIZE_PT = 9.6;
export const OFFER_PREMIUM_TEMPLATE_NAME = "SATO Premium Offer";

/**
 * The blocks — the ordinary offer content, reused from the classic factory so the legal words stay a
 * single source of truth across all five designs, with the ids re-keyed to `-p` so a saved premium
 * template's block ids never collide with another design's edited in the same session. The premium
 * IDENTITY is entirely the skin's work; nothing here is premium-specific but the id suffix.
 */
export function premiumOfferBlocks(): OfferBlock[] {
  return defaultOfferBlocks().map((block) => ({ ...block, id: `${block.id}-p` }));
}
