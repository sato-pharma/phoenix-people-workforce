/**
 * One predicate for the one question everything downstream of the closing matrix keeps getting
 * wrong: **is this row the anonymous company Direct row, or a real area that happens to carry
 * direct money?**
 *
 * `isDirect` on a `MonthlyClosingAreaRow` answers TWO different questions, and callers that read the
 * flag on its own silently answer the wrong one:
 *
 *   1. *Is this the synthetic "Direct orders (company)" pseudo-area?* — the row `injectDirectIntoMatrix`
 *      invents for direct money that belongs to no area. It has no geography, no name of its own, and
 *      is identified by its **areaCode, which the injector sets to "DIRECT"**. This drives the LABEL
 *      and the blue band.
 *   2. *Does this row contain direct money?* — true for the synthetic row AND, since July 2026's
 *      direct orders were restated to area grain, for REAL areas that absorbed hand-mapped direct.
 *      Dakahlia 1 (D21) is still Dakahlia 1. This drives STATIC rendering in the XLSX export, because
 *      the hidden Calc sheet holds distributor invoice lines only and a live SUMIFS over it would
 *      recalculate away the direct portion.
 *
 * Collapsing the two renames every area that absorbed direct to "◆ Direct" and — worse, because it
 * is silent — makes every `!area.isDirect` filter drop those real areas: out of the area picker, out
 * of a District Manager's own seat scope, and out of the area codes a filtered portal export sends
 * to the server, which removes their rows from the downloaded workbook entirely.
 *
 * Question 2 is just `area.isDirect`. Question 1 is this function. Never use the raw flag for it.
 */

/** The areaCode `injectDirectIntoMatrix` stamps on the synthetic company Direct row. */
export const SYNTHETIC_DIRECT_AREA_CODE = "DIRECT";

/**
 * The periods whose direct placement comes from a hand-mapped OVERLAY rather than from the row.
 *
 * A direct row's own `area_code` is the normal authority — `au.f_monthly_attribution` reads it and
 * credits that area's rep, so the closing must agree or the two report different money for the same
 * sale. Owner ruling 2026-09-01: **honour the manual areas.** Where a row carries a hand-placed
 * area, the closing places the money there.
 *
 * July 2026 is the one exception, and it is not about trusting the row — it is about which copy of
 * the same mapping wins:
 *
 *   * **2026-01** — 17 Anti Infective rows on 10 real areas, manually placed, no bricks, all
 *     resolving through `au.sos_area_crosswalk`. Honoured from 2026-09-01. Before that a blanket
 *     pre-August floor discarded them, so the closing left 189,319.95 EGP in the Direct band while
 *     Sales vs Target credited the ten areas — the last surface disagreement
 *     `scripts/check-sales-truth.ts` reported.
 *   * **2026-02 … 2026-06** — nothing. 0 of 554 rows carry an area or a brick, so this is inert.
 *   * **2026-07** — the OWNER'S OWN finalized mapping, which lives in `july-2026-direct-orders.ts`
 *     and is applied by `applyJulyDirectAreasToBreakdown`. That refuses to run unless the
 *     `__DIRECT__` bucket reconciles to the penny, so emitting the row's own area here would shrink
 *     the bucket, fail the check, and paper the published July sheet with a "they are not the same
 *     money" warning. The rows now carry the same 11 areas (stamped on production 2026-09-01 so
 *     Sales vs Target agrees), which is exactly why the overlay must stay the one that places them.
 *   * **2026-08 onward** — every row carries an area AND a brick, written by `direct_order_request`.
 *
 * The same list is mirrored in SQL, in `phx_monthly_closing_direct` and
 * `phx_closing_channel_breakdown`. Changing one without the other splits the closing from itself.
 */
export const OVERLAY_OWNED_DIRECT_PERIODS: readonly string[] = ["2026-07"];

/**
 * True when the closing should place this period's direct money on the row's own area — every
 * period except one an overlay already places. An unknown period never folds.
 */
export function directRowsCarryOwnArea(period: string | null | undefined): boolean {
  const trimmed = String(period ?? "").trim();
  if (trimmed === "") return false;
  return !OVERLAY_OWNED_DIRECT_PERIODS.includes(trimmed);
}

/**
 * True only for the synthetic "Direct orders (company)" pseudo-area.
 *
 * Both conditions on purpose: the areaCode is what identifies the row, and `isDirect` keeps a real
 * area that happens to be coded "DIRECT" from being mistaken for it.
 */
export function isSyntheticDirectArea(area: {
  areaCode?: string | null;
  isDirect?: boolean;
}): boolean {
  return (
    Boolean(area.isDirect) &&
    String(area.areaCode ?? "").trim().toUpperCase() === SYNTHETIC_DIRECT_AREA_CODE
  );
}
