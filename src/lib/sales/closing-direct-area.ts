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
 * The first period whose direct rows carry an area the **Direct Orders module itself** wrote.
 *
 * A direct row having an `area_code` is NOT enough to trust it — three different things put one
 * there, and only the third is the customer's own geography:
 *
 *   * **2026-02 … 2026-06** — nothing. 0 of 554 rows carry an area or a brick.
 *   * **2026-01 (19 of 71 rows) and 2026-07 (35 of 51)** — areas of manual provenance, no bricks.
 *     July's placement is the OWNER'S OWN finalized mapping, which lives in `july-2026-direct-orders.ts`
 *     and must win: it covers Anti Infective and Pedia only, and July CNS is a locked closing.
 *   * **2026-08 onward** — all 22 rows carry an area AND a brick, written by `direct_order_request`.
 *     `au.f_monthly_attribution` reads that area and credits its rep, so the closing must agree.
 *
 * Reading an area off an older row would move published months: it would fold July CNS onto areas
 * behind the owner's mapping, and it would shrink the `__DIRECT__` bucket that
 * `applyJulyDirectAreasToBreakdown` reconciles against — failing that check and papering the
 * published July sheet with a "they are not the same money" warning. Hence a floor, not a
 * has-an-area test. The same floor is repeated in SQL so the two closing RPCs cannot hand an older
 * month an area at all.
 */
export const DIRECT_AREA_STAMPED_FROM_PERIOD = "2026-08";

/**
 * True when this period's direct rows carry geography written by the Direct Orders module, and the
 * closing should therefore place direct money on its own area. `YYYY-MM` sorts lexically, so a plain
 * string compare is the whole rule.
 */
export function directRowsCarryOwnArea(period: string | null | undefined): boolean {
  return String(period ?? "").trim() >= DIRECT_AREA_STAMPED_FROM_PERIOD;
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
