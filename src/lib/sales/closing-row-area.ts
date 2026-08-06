// WHICH AREA DOES THE CLOSING BOOK THIS ROW IN?
//
// An invoice row carries TWO areas and they answer different questions. Getting them the wrong way
// round is not a style choice — it shipped a fix that changed no exported number, twice.
//
//   • the ORIGINAL / FACT area — `source_of_sales_import_rows.area_code`, surfaced on a detail row
//     as `sheetAreaCode`. This is what the distributor's sheet said, and it is the ONLY field a
//     human's hand-apportionment is ever written to.
//   • the RESOLVED area — `areaCode`, which loadMonthlyClosingDetails sets from the row's BRICK's
//     master area, falling back to the sheet's own area when the brick is unmapped.
//
// EVERY closing RPC books by the FACT area: `phx_monthly_closing_matrix` groups by
// `source_of_sales_fact_rollup.area_code`, and that column is the row's own area verbatim (verified
// live 2026-08-06 on Anti Infective 2026-07 — fact and sheet quantities agree area for area, zero
// areas differ). `phx_closing_customers`, `phx_closing_distributor_product` and
// `phx_closing_channel_breakdown` read the same rollup.
//
// So anything that has to AGREE WITH A CLOSING SHEET — which rows a filtered export contains, where
// a customer ranks, which area gives money up in the store split — must ask `closingAreaOf`. Only
// the customer's own physical location should ask `areaCode`.
//
// The two agree on every row in production except a hand-apportioned customer, where the split is
// written to the fact rows and the brick is deliberately left alone. Measured live 2026-08-06 across
// all 153,053 (period, line, client) groups: exactly 4 rows diverge, all client 441164 in 2026-07.

/** The two area fields any row must carry to answer the question. Structural, so both
 *  `ClosingDetailRow` and the leaner `StoreSplitRow` satisfy it with no adapter. */
export type ClosingAreaRow = {
  areaCode: string;
  sheetAreaCode?: string;
};

function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase();
}

/**
 * The area the closing books this row against: the fact area, or the resolved one when the row
 * carries no fact area (a caller outside the closing loader, or an import row with a blank area).
 */
export function closingAreaOf(row: ClosingAreaRow): string {
  return normalize(row.sheetAreaCode) || normalize(row.areaCode);
}

/** The customer's own master location — where the shop physically is, per its brick. */
export function resolvedAreaOf(row: ClosingAreaRow): string {
  return normalize(row.areaCode);
}

/**
 * True when this row was booked somewhere OTHER than its customer's master location.
 *
 * That is the fingerprint of a deliberate human re-allocation, and it is what separates one from a
 * wholesaler that simply trades in two places: a real two-depot store has fact == resolved in each
 * of its areas, while a hand-split has rows pointing away from the single brick they all still
 * carry. Both rows must actually be present — a caller with no fact area cannot be judged, and
 * guessing "re-booked" from a missing field would exempt customers nobody has touched.
 */
export function isRebookedRow(row: ClosingAreaRow): boolean {
  const fact = normalize(row.sheetAreaCode);
  const resolved = normalize(row.areaCode);
  return fact !== "" && resolved !== "" && fact !== resolved;
}
