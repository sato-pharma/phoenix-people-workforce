import { SalesWorkflowError } from "@/lib/sales/contracts";

/**
 * The Office channel's distributor code — the one marker that tells an allocated Office unit apart
 * from a real distributor sell-out unit.
 *
 * A leaf module on purpose. `office-allocation.ts` owns the allocation and imports
 * `monthly-distributor-import.ts`, so the closing loader cannot import the constant back from there
 * without a cycle. Everything that only needs to ASK "is this row Office?" imports it from here.
 * It stays a leaf: `contracts.ts`, its one import, imports nothing at all.
 */
export const OFFICE_DISTRIBUTOR_CODE = "Office";

/** True when a row's distributor code is the Office channel. Tolerant of case and stray spaces. */
export function isOfficeDistributorCode(value: unknown): boolean {
  return String(value ?? "").replace(/\s+/g, "").toUpperCase() === OFFICE_DISTRIBUTOR_CODE.toUpperCase();
}

/**
 * The lines that carry an Office channel at all — the owner's rule, 2026-08-25: **CNS only.**
 *
 * Office is not a distributor. It is the company's own stock, imported last and spread across
 * areas by the owner's value-share rule (see office-allocation.ts). Only CNS works that way, and
 * production agrees. Every Office import row ever validated, counted 2026-08-25:
 *
 *   CNS   2026-01 → 2026-07   15,564 rows   219,245 units
 *   Pedia 2026-01 only            84 rows       556 units   150,119.99 EGP
 *
 * Anti Infective and Head Office have never had one. That single Pedia slice is the whole of the
 * non-CNS history, and it is seven months old.
 *
 * So on Pedia, Anti Infective and Head Office the "of wh. Office" columns and the Office
 * Allocation sheet were a wall of zeroes beside every real figure — measured 2026-08-25, the
 * Office grid's grand total for Pedia and Anti Infective 2026-08 is 0.00.
 *
 * DISPLAY ONLY. The Office grid is a lens on the closing, never a source of it: no headline,
 * subtotal or grand total anywhere is computed from it, so hiding the columns cannot move a
 * number. The one visible consequence is that Pedia's 2026-01 Office slice above no longer shows
 * its breakdown — those 556 units and 150,119.99 EGP stay inside Pedia's January sales exactly as
 * before, they just are not broken out any more.
 */
export const OFFICE_CHANNEL_LINES = ["CNS"] as const;

/** True when this line's closing should carry the Office breakdown. See OFFICE_CHANNEL_LINES. */
export function lineHasOfficeChannel(line: string | null | undefined): boolean {
  return officeLineKeys().has(String(line ?? "").trim().toUpperCase());
}

/**
 * True when a line may be ALLOCATED Office units at all — the enforcement half of the same rule.
 *
 * The list above was, until 2026-09-05, a DISPLAY setting and nothing more: it decided whether the
 * closing showed an Office breakdown, while the upload happily accepted a product on any line and
 * the locked value-share rule allocated it. That is how Pedia's 2026-01 slice happened — Lacto
 * Advanced 1 and 2, 556 units, allocated into Pedia's January closing and then hidden by the very
 * setting that was supposed to mean "CNS only". Hiding a number is not the same as refusing it.
 *
 * So the upload now asks THIS question and refuses a workbook carrying a non-CNS product
 * (office-upload.ts). It reads the same list deliberately — two lists would drift, and a drift here
 * means one half allocating what the other half will not show.
 *
 * It changes nothing already stored. Pedia's January units stay exactly where they are; this only
 * stops the next one.
 */
export function isOfficeAllocationLine(line: string | null | undefined): boolean {
  return officeLineKeys().has(String(line ?? "").trim().toUpperCase());
}

/** The line list as a comparison-ready set. One place, so the two questions cannot disagree. */
function officeLineKeys(): Set<string> {
  return new Set(OFFICE_CHANNEL_LINES.map((candidate) => candidate.toUpperCase()));
}

/** One mapped Office product, as much of it as the line rule needs to judge and to report. */
export type OfficeLineCandidate = {
  line: string;
  productCode: string;
  productName: string;
  units: number;
};

/**
 * Refuse an Office workbook carrying a product from a line that may not be allocated Office units.
 *
 * A whole-file refusal, not a quiet drop of the offending rows. A silently shortened Office import
 * is the same class of wrong number as the one this rule exists to stop — the sheet is the thing
 * that needs fixing, and the message names every product so it can be. Fail-closed, matching the
 * unreadable-units and unmapped-name refusals that already sit beside it in office-upload.ts.
 *
 * Pure and DB-free on purpose: the upload path around it needs the product master, the Office name
 * map and the period's contribution base, so a rule left inline there could only ever be pinned by
 * reading the source. Here it can be executed.
 */
export function assertOfficeProductsOnAllowedLine(products: readonly OfficeLineCandidate[]): void {
  const offLine = products.filter((product) => !isOfficeAllocationLine(product.line));
  if (offLine.length === 0) return;
  const sample = offLine
    .slice(0, 5)
    .map((product) => `"${product.productName}" (${product.line.trim() || "no line"}, ${product.units} units)`)
    .join(", ");
  throw new SalesWorkflowError(
    "office_line_not_allowed",
    `The Office channel carries ${OFFICE_CHANNEL_LINES.join(" and ")} only, and this workbook holds `
      + `${offLine.length} product${offLine.length === 1 ? "" : "s"} from another line. Remove `
      + `${offLine.length === 1 ? "it" : "them"} from the sheet and upload again. Found: ${sample}.`,
    400,
    { offLineProducts: offLine },
  );
}
