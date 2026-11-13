/**
 * Production Planner — what is missing before a product can be planned honestly.
 *
 * The owner, 2026-11-11, after one night found two holes nobody had seen: Saginkgo's foil had no
 * amount in production for eight days (the figure he sent on 3 Nov was written into a file that was
 * never applied), and Saginkgo had no stock recorded anywhere although he believed he had entered it.
 * Both read as ordinary on every screen — a material with no amount just leaves the buy list, and a
 * material with no stock just gets bought in full. Asked which tools to build, he chose a warning for
 * exactly this.
 *
 * Only the materials SATO buys (`isBoughtBySato`): a factory material has no purchase to get wrong,
 * and the Stock and Cost tabs already leave them out for the same reason. Pure, over the wire shape,
 * so the screen and the test read the same answer.
 */
import { isBoughtBySato } from "./rules";
import type { WireMaterial } from "./wire";

export type DataGapKind = "amount" | "stock";

export type DataGap = {
  readonly materialId: string;
  readonly nameAr: string;
  readonly nameEn: string;
  /** What is missing — one material can miss both. */
  readonly missing: readonly DataGapKind[];
};

/** A held figure is a decimal string; any non-zero digit means something is there. */
function holdsSomething(qty: string): boolean {
  return /[1-9]/.test(qty);
}

export function dataGapsFor(materials: readonly WireMaterial[]): DataGap[] {
  const gaps: DataGap[] = [];
  for (const material of materials) {
    if (!isBoughtBySato(material.supplier)) continue;
    const missing: DataGapKind[] = [];
    // An amount read from recorded runs IS an amount: a material left blank on purpose (Royafloxacin's
    // foil, review of 2026-11-13) stops being a gap the moment its first batch is recorded.
    if (material.composition === null && !material.measured) missing.push("amount");
    if (!material.heldByLocation.some((row) => holdsSomething(row.qty))) missing.push("stock");
    if (missing.length > 0) {
      gaps.push({ materialId: material.id, missing, nameAr: material.nameAr, nameEn: material.nameEn });
    }
  }
  return gaps;
}
