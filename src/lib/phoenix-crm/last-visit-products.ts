/**
 * Phoenix CRM — what he discussed with this customer last time.
 *
 * GOLDEN RULE #1, the EASY half (owner, 2026-09-26): "very easy very simple … nothing is asked
 * twice". A rep sees the same doctor every few weeks and re-taps the same three or four products
 * every single time. There is nothing to ask him: the answer is already in his own last visit.
 *
 * Pure, so the picker, the form and the phone all agree without a second read. The I/O half lives in
 * `src/lib/phoenix-crm/server/visits.ts`.
 *
 * ## Two rules that matter more than they look
 *
 * A product RETIRED from the line is dropped. Prefilling a name the grid no longer offers would show
 * a rep a selection he cannot see, cannot clear, and would then save — the quietest way to put a dead
 * product back into the numbers.
 *
 * A customer with no earlier visit is ABSENT from the map, never present with an empty list. The
 * screen must be able to tell "nothing to carry over" from "he discussed nothing", because the first
 * hides the offer and the second would show it reading zero products.
 */

/** One visit's products, as the server reads them back. */
export type LastVisitRow = {
  customerId: string;
  /** The Cairo day, `YYYY-MM-DD`. */
  visitDate: string;
  /** The server's own capture time — the tiebreaker when a day holds two. */
  capturedAt: string;
  products: readonly string[];
};

export type LastVisitProducts = {
  /** The day he last saw this customer, for the sentence on the form. */
  date: string;
  products: string[];
};

/**
 * The newest visit per customer, with its products narrowed to what the line still sells.
 *
 * `rows` may arrive in any order and may hold several visits per customer; the newest `visitDate`
 * wins, and `capturedAt` breaks a tie inside one day.
 */
export function pickLastVisitProducts(
  rows: readonly LastVisitRow[],
  lineProducts: readonly string[],
  max: number,
): Map<string, LastVisitProducts> {
  const live = new Set(lineProducts);
  const newest = new Map<string, LastVisitRow>();

  for (const row of rows) {
    if (!row.customerId || !row.visitDate) continue;
    const held = newest.get(row.customerId);
    if (
      !held ||
      row.visitDate > held.visitDate ||
      (row.visitDate === held.visitDate && row.capturedAt > held.capturedAt)
    ) {
      newest.set(row.customerId, row);
    }
  }

  const out = new Map<string, LastVisitProducts>();
  for (const [customerId, row] of newest) {
    const products: string[] = [];
    for (const product of row.products) {
      const name = typeof product === "string" ? product.trim() : "";
      if (!name || !live.has(name) || products.includes(name)) continue;
      products.push(name);
      if (products.length >= max) break;
    }
    // A visit whose products are all retired still counts as a visit — he saw the doctor — but there
    // is nothing to carry over, so it does not offer him an empty selection.
    if (products.length === 0) continue;
    out.set(customerId, { date: row.visitDate, products });
  }
  return out;
}
