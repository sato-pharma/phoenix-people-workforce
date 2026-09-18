// The Phoenix universal template's identity — the three things BOTH the browser and the server need.
//
// Deliberately its own module with no heavy imports: the Source Normalizer's client component needs
// to know which option in the picker means "the Phoenix template", and importing that from
// `phoenix-template.ts` would drag the engine — and with it ExcelJS — into the browser bundle.

import { normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";

/**
 * The sentinel the picker posts as `distributorCode` when the user chose the Phoenix template rather
 * than a named distributor. It is never stored: the recognizer swaps it for the real distributor
 * code read off the sheet before a single row is coded.
 */
export const PHOENIX_TEMPLATE_CODE = "PHX-TEMPLATE";
export const PHOENIX_TEMPLATE_NAME = "Phoenix template — any distributor";

/** True when a distributor selection means "the Phoenix template", not a named distributor. */
export function isPhoenixTemplateCode(distributorCode: unknown): boolean {
  return normalizeCodeKey(distributorCode) === PHOENIX_TEMPLATE_CODE;
}
