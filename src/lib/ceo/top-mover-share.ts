/**
 * The Share column's arithmetic for the CEO Command Center's top-movers tables.
 *
 * It lives here, apart from the component, for one reason: a share that can silently re-base
 * itself is a number a CEO reads and acts on, so it should be testable without rendering React.
 *
 * WHAT WAS WRONG. `CeoTopMoversTable` computed this twice, differently.
 *
 *  - The SCREEN divided each row by the sum of the rows surviving the FILTER. Typing in the filter
 *    box therefore re-based every percentage on the spot: narrow to one region and its share read
 *    100.0%, whatever that region was actually worth.
 *  - The EXPORT divided by the sum of all `movers`. So the downloaded sheet and the screen it came
 *    from disagreed the moment anyone filtered — and the house rule is that an export MATCHES the
 *    screen.
 *
 * Neither denominator was the right one anyway. Every caller passes a truncated list — the top 5
 * lines, top 5 regions, top 7 spending regions, top 5 spenders — so the sum of what is on screen
 * is the total of the top few, not of the period. Measured on production 2026-09-23 against the
 * Source of Sales months:
 *
 *   2026-08   13 regions carried sales; the 5 listed are 90.4% of their value  → shares ~11% high
 *   2026-05    9 regions carried sales; the 5 listed are 87.6% of their value  → shares ~14% high
 *
 * A region genuinely worth 27% of the month was being shown as 30%. Top Lines escaped in practice
 * only because just four lines carry sales at all, so its top-5 slice is already the whole set.
 *
 * THE RULE: one basis, the whole population where the caller knows it, used by the screen and the
 * export alike. On a top-N list the shares then do not add up to 100%, and that is correct — the
 * remaining money is in the rows that did not make the cut.
 */

export type TopMoverShareRow = { value: number };

/**
 * The denominator for every share in one table.
 *
 * `total` is the whole population's value. It is ignored when absent or non-positive, falling back
 * to the sum of the rows passed — correct only when those rows really are the complete set.
 *
 * NOTE the rows argument is the FULL `movers` list, never the filtered view. Passing a filtered
 * list here reintroduces the original defect.
 */
export function topMoverShareBasis(movers: readonly TopMoverShareRow[], total?: number | null): number {
  if (total != null && Number.isFinite(total) && total > 0) return total;
  return movers.reduce((sum, row) => sum + (Number.isFinite(row.value) ? row.value : 0), 0);
}

/** One row's share of `basis`, to one decimal place, or an em dash when there is nothing to divide by. */
export function formatTopMoverShare(value: number, basis: number): string {
  if (!(basis > 0) || !Number.isFinite(value)) return "—";
  return `${((value / basis) * 100).toFixed(1)}%`;
}
