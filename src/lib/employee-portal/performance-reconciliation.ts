// ─────────────────────────────────────────────────────────────────────────────
// Performance-page reconciliation — the "unattributed" slice, computed purely.
//
// The sales performance surfaces (NSM DSMs & Med Reps, CEO company roll-ups) show a
// HEADLINE total covering every scoped Source-of-Sales row, above a leaderboard that
// only lists rows the engine could attribute to a seated rep or DM. Direct Orders the
// engine spread across regions and sales sitting on vacant seats therefore live in the
// header but in NO visible row — up to ~39% of a line's July 2026 actual.
//
// Kept in its own dependency-free module (no Supabase, no env) so the identity
// `headline = Σ(members) + unattributed` is unit-testable without a database — the
// achievement loaders that sos-team-performance.ts pulls in are not importable under the
// test runner.
// ─────────────────────────────────────────────────────────────────────────────

/** The two figures the reconciliation reads off each shown member row. */
export type ReconcilableMember = {
  totalSales: number;
  totalTarget: number;
};

/**
 * The slice of a headline total that NO member row below it carries: Direct Orders the
 * engine spread across regions (no rep/DM seat) plus sales on vacant seats.
 *
 * Computed as headline − Σ(shown members) rather than re-summing null-seat rows, so the
 * identity `headline = Σ(members) + unattributed` holds EXACTLY however the underlying
 * rows are grouped. Sub-piastre float noise is clamped to 0; the value is primarily a
 * SALES reconciliation (null-seat rows almost never carry a target), and target is folded
 * the same way for completeness.
 */
export function reconcileUnattributed(
  headline: { sales: number; target: number },
  members: readonly ReconcilableMember[],
): { unattributedSales: number; unattributedTarget: number } {
  let sales = headline.sales;
  let target = headline.target;
  for (const member of members) {
    sales -= member.totalSales;
    target -= member.totalTarget;
  }
  return {
    unattributedSales: Math.abs(sales) < 0.005 ? 0 : sales,
    unattributedTarget: Math.abs(target) < 0.005 ? 0 : target,
  };
}
