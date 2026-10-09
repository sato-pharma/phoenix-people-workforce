/**
 * The EPDA-BULK channel — SATO's own wholesale sector (`EP-BK`, "ساتو قطاع الجملة") — and the one
 * question every caller asks about it: does THIS row take the owner's contribution allocation?
 *
 * A leaf module on purpose, and for exactly the reason `office-distributor.ts` is one: the rule that
 * spreads these rows (`closing-bulk-allocation.ts`) is read by the city split, the closing's own
 * split loader and the attribution net, and `store-sales-city-split.ts` has to ASK the question
 * without importing the rule that answers it. It imports nothing at all.
 *
 * THE RULE (owner, 2026-10-09, in his words): "Starting from September closing, the ابدأ bulk will
 * be distributed and calculated exactly as office, but in line Pedia it will be you will get the
 * total sales contribution of the other distributors over the total sales and get the contribution
 * of every one and based on this distribute the same contribution from EPDA bulk."
 *
 * So: the bulk sector's invoiced geography is IGNORED from September 2026, and its units are spread
 * over the line's areas by each area's share of the OTHER distributors' sales value — the Office
 * channel's locked value-share rule, applied to a real distributor's book. His three answers the
 * same day settled the rest: the file keeps arriving as its own upload under `EP-BK` (so nothing has
 * to classify a merged sheet), Pedia is the only line that takes it, and the allocated money keeps
 * the distributor's own name rather than being folded into an invented source.
 */

/** The distributor code the bulk sector's own uploads carry. */
export const BULK_DISTRIBUTOR_CODE = "EP-BK";

/**
 * How the allocated money is NAMED wherever a surface names its source (owner's choice, 2026-10-09:
 * "EPDA-BULK"). Deliberately the real distributor, not a Main-Stores-style stand-in: the allocation
 * changes WHERE the money is booked, never who sold it.
 */
export const BULK_DISTRIBUTOR_LABEL = "EPDA-BULK";

/**
 * The lines whose bulk rows are allocated — PEDIA ONLY (owner, 2026-10-09).
 *
 * It is not a limitation of the rule, it is the shape of the book: 99.2% of every bulk row ever
 * uploaded is Lacto Basic (`LA003`/`LA004`) on the untracked HEAD OFFICE line, which both closing
 * RPCs exclude by name, and the only part of it that has ever reached a closing at all is 599 packs
 * of Lacto Advanced on Pedia. Head Office is left exactly as invoiced.
 */
export const BULK_ALLOCATION_LINES = ["Pedia"] as const;

/**
 * The first closing the allocation applies to — "starting from September closing" (owner,
 * 2026-10-09). Every earlier month keeps the numbers it was published with, which is the same
 * direction every other dated sales rule in this repo takes: a late ruling is a rule for upcoming
 * months, never a correction of a published one.
 */
export const BULK_ALLOCATION_START_PERIOD = "2026-09";

/** True when a row's distributor code is the bulk sector's. Tolerant of case and stray spaces. */
export function isBulkDistributorCode(value: unknown): boolean {
  return String(value ?? "").replace(/\s+/g, "").toUpperCase() === BULK_DISTRIBUTOR_CODE.toUpperCase();
}

/** True when this line's bulk rows are allocated rather than left on their invoiced area. */
export function isBulkAllocationLine(line: string | null | undefined): boolean {
  const key = String(line ?? "").trim().toUpperCase();
  return BULK_ALLOCATION_LINES.some((candidate) => candidate.toUpperCase() === key);
}

/**
 * True for `2026-09` and every month after it.
 *
 * A STRING comparison on `YYYY-MM`, which sorts correctly, and a period that is not that shape
 * answers FALSE — the safe direction, because a month this cannot read is a month whose published
 * numbers must not move.
 */
export function isBulkAllocationActive(period: string | null | undefined): boolean {
  const trimmed = String(period ?? "").trim();
  if (!/^\d{4}-\d{2}$/.test(trimmed)) return false;
  return trimmed >= BULK_ALLOCATION_START_PERIOD;
}

/**
 * True when this ROW is one the allocation moves: the bulk sector, on an allocated line, in a month
 * the rule covers.
 *
 * 🔴 THE CITY SPLIT ASKS THIS BEFORE IT ASKS ANYTHING ELSE. The bulk sector's customers are
 * wholesalers by definition, so the six keywords classify most of its rows as stores and the city
 * rule would share each one evenly across its own city — and then this rule would spread the same
 * units again by contribution. Money moved twice is money invented. `isSplitEligible` refuses these
 * rows outright (store-sales-city-split.ts), which makes the bulk sector the FOURTH carve-out from
 * the city rule beside EZ, Office and El Qema's warehouses.
 */
export function isBulkAllocatedRow(
  row: { distributorCode?: string | null; officialLine?: string | null },
  period: string | null | undefined,
): boolean {
  if (!isBulkAllocationActive(period)) return false;
  if (!isBulkDistributorCode(row.distributorCode)) return false;
  return isBulkAllocationLine(row.officialLine);
}
