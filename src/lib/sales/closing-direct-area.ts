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
