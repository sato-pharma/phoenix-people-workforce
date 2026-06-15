"use client";

import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";

import type { WeeklyMissingProduct } from "@/lib/sales/weekly/types";

const card = "rounded-[6px] border border-[#E2E8F0] bg-white shadow-sm";
const darkHead = "bg-[#020617] text-left text-[11px] font-black uppercase tracking-wide text-white";

function fmt(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export function WeeklyMissingProducts({ initial, initialError }: { initial: WeeklyMissingProduct[]; initialError: string | null }) {
  const [data, setData] = useState<WeeklyMissingProduct[]>(initial);
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/sales/weekly/missing-products", { cache: "no-store" });
      const payload = (await res.json()) as { success?: boolean; data?: WeeklyMissingProduct[]; error?: string };
      if (payload?.success && payload.data) setData(payload.data);
      else setError(payload?.error ?? "Failed to refresh.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to refresh.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-black text-[#020617]">Weekly Sales — Missing Products</h1>
          <p className="mt-1 text-sm text-[#64748B]">
            These distributor item codes have no product alias yet. Upload rows are stored safely with a warning.
            Once you add the alias on the <strong>Product Mapping</strong> page, all historical rows auto-update.
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={busy}
          className="flex items-center gap-1.5 rounded-[6px] border border-[#E2E8F0] bg-white px-3 py-2 text-xs font-semibold text-[#475569] hover:bg-[#F8FAFC] disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Refresh
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-[6px] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {data.length === 0 && !error ? (
        <div className={`${card} flex flex-col items-center gap-3 py-16 text-center`}>
          <CheckCircle2 className="h-10 w-10 text-emerald-500" />
          <p className="text-sm font-semibold text-[#020617]">All product codes are mapped</p>
          <p className="text-xs text-[#64748B]">Every stored weekly sales row resolves to a master product.</p>
        </div>
      ) : (
        <div className={card}>
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className={darkHead}>
                <th className="px-4 py-3">Distributor</th>
                <th className="px-4 py-3">Item Code</th>
                <th className="px-4 py-3">Item Name (from file)</th>
                <th className="px-4 py-3 text-right">Rows</th>
                <th className="px-4 py-3 text-right">Batches</th>
                <th className="px-4 py-3 text-right">Stock Units</th>
                <th className="px-4 py-3">Weeks</th>
                <th className="px-4 py-3">Fix</th>
              </tr>
            </thead>
            <tbody>
              {data.map((row, idx) => (
                <tr
                  key={`${row.distributorCode}||${row.itemCode}`}
                  className={`border-t border-[#F1F5F9] ${idx % 2 === 0 ? "bg-white" : "bg-[#F8FAFC]"}`}
                >
                  <td className="px-4 py-3 font-semibold text-[#020617]">{row.distributorName || row.distributorCode}</td>
                  <td className="px-4 py-3 font-mono text-xs text-[#F97316]">{row.itemCode}</td>
                  <td className="px-4 py-3 text-[#334155]">{row.itemName || "—"}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-[#475569]">{fmt(row.rowCount)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-[#475569]">{fmt(row.batchCount)}</td>
                  <td className="px-4 py-3 text-right tabular-nums font-semibold text-[#020617]">{fmt(row.totalStock)}</td>
                  <td className="px-4 py-3 text-xs text-[#64748B]">
                    {row.earliestWeek === row.latestWeek
                      ? (row.earliestWeek ?? "—")
                      : `${row.earliestWeek ?? "—"} → ${row.latestWeek ?? "—"}`}
                  </td>
                  <td className="px-4 py-3">
                    <a
                      href={`/sales/weekly/product-mapping?distributor=${encodeURIComponent(row.distributorCode)}`}
                      className="inline-flex items-center gap-1 rounded-[6px] bg-[#F97316] px-3 py-1.5 text-xs font-bold text-white hover:bg-[#EA6C10]"
                    >
                      Add Alias
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="border-t border-[#F1F5F9] px-4 py-2 text-xs text-[#94A3B8]">
            {data.length} unresolved item code{data.length !== 1 ? "s" : ""} across{" "}
            {new Set(data.map((r) => r.distributorCode)).size} distributor{new Set(data.map((r) => r.distributorCode)).size !== 1 ? "s" : ""}
          </div>
        </div>
      )}

      <div className={`${card} border-l-4 border-l-[#F97316] px-4 py-3`}>
        <p className="text-xs font-semibold text-[#020617]">How auto-heal works</p>
        <p className="mt-0.5 text-xs text-[#64748B]">
          Go to <strong>Product Mapping</strong>, select the distributor, and add the alias (item code → master product).
          The system immediately updates all stored rows — region dashboards and totals update in real time.
          No re-upload needed.
        </p>
      </div>
    </div>
  );
}
