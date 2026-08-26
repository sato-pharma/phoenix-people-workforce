/**
 * Is one closing detail row's money inside the Monthly Closing headline?
 *
 * A LEAF module on purpose, and the reason is not style. `monthly-closing-details.ts` imports
 * `getSupabaseAdmin`, so a "use client" component that imports a VALUE from it drags the
 * service-role Supabase client into the browser bundle — importing only `type` is what kept that
 * from happening until now. The details panel needs this predicate at runtime, so it lives here,
 * where nothing server-only can reach it. Same reasoning as ./closing-direct-area.ts.
 *
 * ── THE QUESTION THIS ANSWERS, AND THE ONE IT DOES NOT ──────────────────────────────────────
 * Two channels reach the closing headline and the closing ADDS them:
 *
 *   1. distributor sell-out — the rows `phx_monthly_closing_matrix` aggregates, flagged
 *      `includedInClosing` on a detail row;
 *   2. the direct orders Finance booked into the month — placed in the grid by
 *      `injectDirectIntoMatrix` as per-region "Direct" rows, or, for 2026-07, folded into the
 *      area rows the owner mapped them to. Either way they are inside `combined.grandTotal`.
 *
 * `includedInClosing` alone is therefore the DISTRIBUTOR half, not the headline. Reading it as the
 * headline is what made the Finance Manager's Monthly Closing → Details tab report "In closing
 * 0.00" for 2026-08 while 290,387.57 EGP of direct orders he had just booked sat in the Closing
 * Matrix beside it, every row labelled "Direct (excluded)". The flag still means the distributor
 * half — the export's Data/Total SUMIFS bridge is built on it and must keep it — so the headline
 * question gets its own name instead.
 *
 * Confidential products (LA003 / LA004 / SS001) are the one true exclusion: every closing RPC drops
 * them in SQL, the direct RPC included. A confidential row is outside the headline whether it is
 * direct or not, which is why this is not simply `includedInClosing || isDirect`.
 */

/** The slice of a detail row this predicate reads — structural, so no module has to import back. */
export type ClosingHeadlineRow = {
  includedInClosing: boolean;
  isConfidential: boolean;
  isDirect: boolean;
};

/** True when this row's money is inside the closing headline the reader is looking at. */
export function countsInClosingHeadline(row: ClosingHeadlineRow): boolean {
  if (row.isConfidential) return false;
  return row.includedInClosing || row.isDirect;
}
