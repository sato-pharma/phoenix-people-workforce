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
 * Adding a third design is one entry here plus its own `*-template.ts`. Nothing else in the module
 * enumerates them — the seeder, the restore route and the designer all read this list.
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
];

export function offerBuiltinTemplate(key: string): OfferBuiltinTemplate | null {
  return OFFER_BUILTIN_TEMPLATES.find((entry) => entry.key === key) ?? null;
}

export function isOfferBuiltinKey(value: unknown): value is OfferBuiltinKey {
  return typeof value === "string" && OFFER_BUILTIN_TEMPLATES.some((entry) => entry.key === value);
}

export function isOfferTemplateVariant(value: unknown): value is OfferTemplateVariant {
  return value === "classic" || value === "executive";
}
