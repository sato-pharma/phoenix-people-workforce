import {
  OFFER_DEFAULT_FONT,
  OFFER_DEFAULT_FONT_SIZE_PT,
  OFFER_DEFAULT_TEMPLATE_NAME,
  OFFER_DEFAULT_THEME,
  defaultOfferBlocks,
} from "@/lib/offers/default-template";
import {
  OFFER_EXECUTIVE_FONT,
  OFFER_EXECUTIVE_FONT_SIZE_PT,
  OFFER_EXECUTIVE_TEMPLATE_NAME,
  OFFER_EXECUTIVE_THEME,
  executiveOfferBlocks,
} from "@/lib/offers/executive-template";
import {
  OFFER_SATO_FONT,
  OFFER_SATO_FONT_SIZE_PT,
  OFFER_SATO_TEMPLATE_NAME,
  OFFER_SATO_THEME,
  satoOfferBlocks,
} from "@/lib/offers/sato-template";
import {
  OFFER_HOUSE_FONT,
  OFFER_HOUSE_FONT_SIZE_PT,
  OFFER_HOUSE_TEMPLATE_NAME,
  OFFER_HOUSE_THEME,
  houseOfferBlocks,
} from "@/lib/offers/house-template";
import {
  OFFER_PREMIUM_FONT,
  OFFER_PREMIUM_FONT_SIZE_PT,
  OFFER_PREMIUM_TEMPLATE_NAME,
  OFFER_PREMIUM_THEME,
  premiumOfferBlocks,
} from "@/lib/offers/premium-template";
import type { OfferBlock, OfferBuiltinKey, OfferTemplateVariant, OfferTheme } from "@/lib/offers/types";

/**
 * The designs that ship with the module.
 *
 * Both are the owner's own uploaded letters, transcribed block for block. They live in CODE rather
 * than in a seeded row for one reason: a built-in must be restorable after ANY amount of editing,
 * including after somebody deletes half of it and saves. A row that has been edited cannot restore
 * itself; a generator can. `builtinKey` is how a row is matched back to its generator, so renaming
 * a template in the UI never breaks its Restore button.
 *
 * Adding a design is one entry here plus its own `*-template.ts`. Nothing else in the module
 * enumerates them — the seeder, the restore route and the designer all read this list. The third,
 * `sato`, was added beside the two frozen uploaded letters and changes neither of them; the fourth,
 * `house`, and the fifth, `premium` (13 Oct 2026), were added the same way and change none of the
 * four before them. Each new key also has to be allowed by the `offer_templates` CHECK constraints in
 * the database BEFORE the code that registers it deploys — see the migration that added `premium`.
 */
export type OfferBuiltinTemplate = {
  blocks: () => OfferBlock[];
  /** Shown under the design's name in the designer, so the two are told apart before opening one. */
  description: string;
  fontFamily: string;
  fontSizePt: number;
  key: OfferBuiltinKey;
  name: string;
  /** The one seeded as the design a new offer opens on, when neither exists yet. */
  seedAsDefault: boolean;
  theme: OfferTheme;
  variant: OfferTemplateVariant;
};

export const OFFER_BUILTIN_TEMPLATES: OfferBuiltinTemplate[] = [
  {
    blocks: defaultOfferBlocks,
    description: "The signed Dr Samaa letter — white sheet, blue rail, hairline rules.",
    fontFamily: OFFER_DEFAULT_FONT,
    fontSizePt: OFFER_DEFAULT_FONT_SIZE_PT,
    key: "classic",
    name: OFFER_DEFAULT_TEMPLATE_NAME,
    seedAsDefault: true,
    theme: OFFER_DEFAULT_THEME,
    variant: "classic",
  },
  {
    blocks: executiveOfferBlocks,
    description: "The Ultra Premium letter — navy bands, tinted salary table, welcome band.",
    fontFamily: OFFER_EXECUTIVE_FONT,
    fontSizePt: OFFER_EXECUTIVE_FONT_SIZE_PT,
    key: "executive",
    name: OFFER_EXECUTIVE_TEMPLATE_NAME,
    seedAsDefault: false,
    theme: OFFER_EXECUTIVE_THEME,
    variant: "executive",
  },
  {
    blocks: satoOfferBlocks,
    description: "The Sato corporate letter — navy masthead band, reverse mark, brand seam, SHARP square edges.",
    fontFamily: OFFER_SATO_FONT,
    fontSizePt: OFFER_SATO_FONT_SIZE_PT,
    key: "sato",
    name: OFFER_SATO_TEMPLATE_NAME,
    seedAsDefault: false,
    theme: OFFER_SATO_THEME,
    variant: "sato",
  },
  {
    blocks: houseOfferBlocks,
    description: "The HR-forms house identity — the on-light mark over the engine-turned band, three logo blues, ink rule (no filled areas), a 6% zebra salary table.",
    fontFamily: OFFER_HOUSE_FONT,
    fontSizePt: OFFER_HOUSE_FONT_SIZE_PT,
    key: "house",
    name: OFFER_HOUSE_TEMPLATE_NAME,
    seedAsDefault: false,
    theme: OFFER_HOUSE_THEME,
    variant: "house",
  },
  {
    blocks: premiumOfferBlocks,
    description: "The HR premium identity — centred masthead over the engine-turned band, double-keyline frame, Arabic watermark, Sato-only foot, ink rule (no filled areas), a 6% zebra salary table.",
    fontFamily: OFFER_PREMIUM_FONT,
    fontSizePt: OFFER_PREMIUM_FONT_SIZE_PT,
    key: "premium",
    name: OFFER_PREMIUM_TEMPLATE_NAME,
    seedAsDefault: false,
    theme: OFFER_PREMIUM_THEME,
    variant: "premium",
  },
];

export function offerBuiltinTemplate(key: string): OfferBuiltinTemplate | null {
  return OFFER_BUILTIN_TEMPLATES.find((entry) => entry.key === key) ?? null;
}

export function isOfferBuiltinKey(value: unknown): value is OfferBuiltinKey {
  return typeof value === "string" && OFFER_BUILTIN_TEMPLATES.some((entry) => entry.key === value);
}

export function isOfferTemplateVariant(value: unknown): value is OfferTemplateVariant {
  return value === "classic" || value === "executive" || value === "sato" || value === "house" || value === "premium";
}
