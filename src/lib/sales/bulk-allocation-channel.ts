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
 *
 * 🔴 AND THE RULE IS ONE PRODUCT WIDE (owner, 2026-10-09, narrowing his own rule the same evening):
 * "IN EPDA BULK ONLY IVYRONC WILL BE CONTRIBUTION ANY OTHER PRODUCT NORMAL MAPPING." So the
 * question this module answers is no longer "is this the bulk sector, on Pedia, in a covered
 * month" — it is that AND "is this Ivyronc". Every other product of the same book keeps the area its
 * invoice names and takes the ordinary rules, the city split included.
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
 * RPCs exclude by name. Head Office is left exactly as invoiced.
 *
 * Since the product narrowing below it is also, strictly, redundant — Ivyronc IS a Pedia product, so
 * no Ivyronc row can arrive on another line. It is kept, and asked FIRST, because the two gates mean
 * different things: a product mis-mastered onto another line must not be spread across THAT line's
 * areas, and the line is the grain every caller of `buildBulkAllocation` already works in.
 */
export const BULK_ALLOCATION_LINES = ["Pedia"] as const;

/**
 * 🔴 THE ONLY PRODUCT THE ALLOCATION MOVES — IVYRONC (owner, 2026-10-09): "IN EPDA BULK ONLY
 * IVYRONC WILL BE CONTRIBUTION ANY OTHER PRODUCT NORMAL MAPPING."
 *
 * `IV001` is the whole of Ivyronc: the live master holds exactly one Ivyronc product code (family
 * `IV`, line Pedia, active — read 9 October 2026), so this list is the product, not a sample of it.
 * A second concentration would arrive as a new code and must be added HERE; it cannot be inferred,
 * because a closing detail row carries its product code and not its family.
 *
 * It is a LIST rather than a constant for that reason alone, and it is deliberately not a prefix
 * match: `IV` would also catch any future unrelated code that happens to start with those letters,
 * and the rule moves money.
 *
 * What it changes in practice, measured on the live book the same day: the bulk sector has uploaded
 * four batches ever (2026-02, 03, 04, 06) and NOT ONE of them carries Ivyronc — they are Lacto Basic
 * on Head Office and 599 packs of Lacto Advanced on Pedia. So on the book's historical shape this
 * rule now moves nothing at all, and the Lacto Advanced rows that the line-level rule would have
 * spread are back on normal mapping. That is his instruction, not a defect: the rule is for the
 * Ivyronc volume the September file is expected to carry.
 */
export const BULK_ALLOCATION_PRODUCT_CODES = ["IV001"] as const;

/**
 * The first closing the allocation applies to — "starting from September closing" (owner,
 * 2026-10-09). Every earlier month keeps the numbers it was published with, which is the same
 * direction every other dated sales rule in this repo takes: a late ruling is a rule for upcoming
 * months, never a correction of a published one.
 */
export const BULK_ALLOCATION_START_PERIOD = "2026-09";

/**
 * 🔴 RULE 2, FROM THE OCTOBER 2026 CLOSING (owner, 2026-11-04): both EPDA books, three products, and
 * each product spread by its OWN retail units. His words: "you will get the total retail sales of every
 * rep without epda bulk or epda-pharmacies then you will distribute the epda sales based on the
 * contribution per area in retail sales but do not forget the 15% and 30% rule then add the direct
 * sales". His answers the same day: the three Sato items, the same product's units, both books.
 *
 * So from October the rule above widens in three directions at once: EPDA-Pharmacies joins the bulk
 * sector, Royafloxacin and Saginko join Ivyronc (which brings Anti Infective in beside Pedia), and the
 * weights are each product's own retail units instead of the line's value. The 15% and 30% are already
 * off the stored rows (import-epda-bonus-deduction.ts), so the spread moves reduced units and never
 * deducts again. September keeps the rule above and the numbers it was published with.
 */
export const EPDA_CONTRIBUTION_START_PERIOD = "2026-10";

/** EPDA-BULK and EPDA-Pharmacies. The main EPDA book (`EP`) is retail and is one of the weights. */
export const EPDA_CONTRIBUTION_DISTRIBUTOR_CODES = ["EP-BK", "EP-PHS"] as const;

/** Ivyronc, Royafloxacin, Saginko. Every other product of the two books keeps its invoiced area. */
export const EPDA_CONTRIBUTION_PRODUCT_CODES = ["IV001", "RO001", "SA001"] as const;

/** The lines those three products are on (live master, read 2026-11-04): Ivyronc Pedia, the other two Anti Infective. */
export const EPDA_CONTRIBUTION_LINES = ["Pedia", "Anti Infective"] as const;

const squeezed = (value: unknown) => String(value ?? "").replace(/\s+/g, "").toUpperCase();

/** True for `2026-10` and every month after it. A period that is not `YYYY-MM` answers false. */
export function isEpdaContributionActive(period: string | null | undefined): boolean {
  const trimmed = String(period ?? "").trim();
  if (!/^\d{4}-\d{2}$/.test(trimmed)) return false;
  return trimmed >= EPDA_CONTRIBUTION_START_PERIOD;
}

/** True for EPDA-BULK and EPDA-Pharmacies. Tolerant of case and stray spaces. */
export function isEpdaContributionDistributor(value: unknown): boolean {
  const key = squeezed(value);
  return EPDA_CONTRIBUTION_DISTRIBUTOR_CODES.some((code) => code === key);
}

/** True for the three products rule 2 spreads. */
export function isEpdaContributionProduct(value: unknown): boolean {
  const key = squeezed(value);
  return Boolean(key) && EPDA_CONTRIBUTION_PRODUCT_CODES.some((code) => code === key);
}

/** True when a row's distributor code is the bulk sector's. Tolerant of case and stray spaces. */
export function isBulkDistributorCode(value: unknown): boolean {
  return String(value ?? "").replace(/\s+/g, "").toUpperCase() === BULK_DISTRIBUTOR_CODE.toUpperCase();
}

/**
 * True when this PRODUCT is one the allocation moves — Ivyronc and nothing else (owner,
 * 2026-10-09). Tolerant of case and stray spaces, like the distributor test above, because a sheet's
 * product code arrives as typed.
 */
export function isBulkAllocatedProduct(value: unknown): boolean {
  const key = String(value ?? "").replace(/\s+/g, "").toUpperCase();
  if (!key) return false;
  return BULK_ALLOCATION_PRODUCT_CODES.some((candidate) => candidate.toUpperCase() === key);
}

/**
 * True when this line's bulk rows are allocated rather than left on their invoiced area. Pass the
 * period: from October 2026 rule 2 reaches Anti Infective too. Without one, the September answer.
 */
export function isBulkAllocationLine(line: string | null | undefined, period?: string | null): boolean {
  const key = String(line ?? "").trim().toUpperCase();
  const lines: readonly string[] = isEpdaContributionActive(period) ? EPDA_CONTRIBUTION_LINES : BULK_ALLOCATION_LINES;
  return lines.some((candidate) => candidate.toUpperCase() === key);
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
 * True when this ROW is one the allocation moves: the bulk sector, on an allocated line, carrying an
 * allocated PRODUCT, in a month the rule covers.
 *
 * 🔴 THE CITY SPLIT ASKS THIS BEFORE IT ASKS ANYTHING ELSE. The bulk sector's customers are
 * wholesalers by definition, so the six keywords classify most of its rows as stores and the city
 * rule would share each one evenly across its own city — and then this rule would spread the same
 * units again by contribution. Money moved twice is money invented. `isSplitEligible` refuses these
 * rows outright (store-sales-city-split.ts), which makes the bulk sector the FOURTH carve-out from
 * the city rule beside EZ, Office and El Qema's warehouses.
 *
 * 🔴 AND THE CARVE-OUT IS EXACTLY AS WIDE AS THE ALLOCATION, NEVER WIDER (owner, 2026-10-09 —
 * "ANY OTHER PRODUCT NORMAL MAPPING"). A bulk row that is not Ivyronc is moved by NEITHER rule here
 * and by the ordinary ones instead: it stays split-eligible, so a wholesaler in a multi-area city
 * still takes the city rule, which is what "normal mapping" is. Widening this test to the whole book
 * would quietly freeze those rows on their invoiced area — a change to published behaviour he did
 * not ask for, in the opposite direction to the one he did.
 *
 * `productCode` is optional ONLY so the pure-arithmetic callers can keep asking with a row alone;
 * absent, it answers FALSE, which is the safe direction — a row this cannot read is a row whose
 * published area must not move.
 */
export function isBulkAllocatedRow(
  row: { distributorCode?: string | null; officialLine?: string | null; productCode?: string | null },
  period: string | null | undefined,
): boolean {
  if (!isBulkAllocationActive(period)) return false;
  // Rule 2 from October: both books and three products, so the city split leaves all of them alone.
  if (isEpdaContributionActive(period)) {
    return isEpdaContributionDistributor(row.distributorCode)
      && isBulkAllocationLine(row.officialLine, period)
      && isEpdaContributionProduct(row.productCode);
  }
  if (!isBulkDistributorCode(row.distributorCode)) return false;
  if (!isBulkAllocationLine(row.officialLine)) return false;
  return isBulkAllocatedProduct(row.productCode);
}
