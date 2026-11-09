"use client";

import { CeoTopMoversTable } from "@/components/admin/ceo-top-movers-table";

function egp(v: number) {
  if (!Number.isFinite(v)) return "—";
  if (v >= 1_000_000) return `EGP ${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `EGP ${(v / 1_000).toFixed(0)}K`;
  return `EGP ${Math.round(v).toLocaleString("en-US")}`;
}

/**
 * Premium sortable + filterable + XLSX-exportable pair of tables for the CEO
 * Expense Snapshot: spend by region and top-spender managers.
 */
export function CeoExpenseTables({
  byRegion,
  topSpenders,
  windowLabel,
  totalAmount,
}: {
  byRegion: Array<{ label: string; amount: number }>;
  topSpenders: Array<{ label: string; amount: number }>;
  windowLabel?: string;
  /**
   * The window's whole spend. Both lists arrive truncated — regions to 7, spenders to 5 out of an
   * already-capped leaderboard — so this is the only correct denominator for their Share column.
   */
  totalAmount?: number;
}) {
  const regionRows = byRegion.map((r) => ({ label: r.label, value: r.amount }));
  const spenderRows = topSpenders.map((s) => ({ label: s.label, value: s.amount }));

  return (
    <div className="grid gap-5 p-5 lg:grid-cols-2">
      <div>
        <p className="mb-3 text-phx-xs font-black uppercase tracking-[0.16em] text-slate-400">
          Spend by Region
        </p>
        <CeoTopMoversTable
          movers={regionRows}
          title="Spend by Region"
          exportTitle="Expense Snapshot — By Region"
          subtitle={windowLabel}
          labelHeader="Region"
          valueHeader="Amount (EGP)"
          format={egp}
          total={totalAmount}
          empty="No regional data yet."
        />
      </div>
      <div>
        <p className="mb-3 text-phx-xs font-black uppercase tracking-[0.16em] text-slate-400">
          Top Spenders
        </p>
        <CeoTopMoversTable
          movers={spenderRows}
          title="Top Spenders"
          exportTitle="Expense Snapshot — Top Spenders"
          subtitle={windowLabel}
          labelHeader="Manager"
          valueHeader="Amount (EGP)"
          format={egp}
          total={totalAmount}
          empty="No spender data yet."
        />
      </div>
    </div>
  );
}
