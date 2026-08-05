"use client";

import { AlertTriangle, HeartPulse, Loader2, Pill, Store, UserX } from "lucide-react";
import { useEffect, useState } from "react";

import { AdminCallout } from "@/components/admin/admin-design-system";
import { SortableTh, TableNoResults, TableSearchInput } from "@/components/ui/sortable-table";
import { useSortableTable } from "@/components/ui/use-sortable-table";
import { formatCurrency, formatNumber } from "@/lib/sales/format";
import { cn } from "@/lib/utils";
import type { ChannelsByRepResult, ChannelsByRepRow } from "@/lib/sales/channels-by-rep";

// Channels by Rep — Hospital / Store / Pharmacy sales for each rep, side by side.
//
// The sibling of the Customers tab and deliberately built from the same parts (dark table head,
// SortableTh, cards below md, whitespace-nowrap everywhere) so the two read as one module.
//
// Two things this tab refuses to do quietly:
//   1. It shows the sales that reached NO rep — vacant seats, and areas not on the seat model at
//      all — as their own labelled rows. That is roughly 27% of value. A per-rep table that
//      silently adds up to less than the company total is a table that gets questioned.
//   2. It says out loud when the restricted products are excluded, because they are 81.5% of sales
//      value. A reader who does not know that would take the totals for the whole business.

type ChannelsResponse = {
  data?: ChannelsByRepResult;
  error?: string;
  success: boolean;
};

const CHANNEL_TILES: ReadonlyArray<{
  icon: typeof Pill;
  key: "hospital" | "pharmacy" | "store";
  label: string;
  of: (totals: ChannelsByRepResult["totals"]) => number;
}> = [
  { icon: Pill, key: "pharmacy", label: "Pharmacies", of: (t) => t.pharmacyValue },
  { icon: Store, key: "store", label: "Stores", of: (t) => t.storeValue },
  { icon: HeartPulse, key: "hospital", label: "Hospitals", of: (t) => t.hospitalValue },
];

function share(part: number, whole: number): string {
  if (!Number.isFinite(whole) || whole === 0) return "—";
  return `${((100 * part) / whole).toFixed(1)}%`;
}

export function ChannelsByRepTab() {
  const [result, setResult] = useState<ChannelsByRepResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Same shape as CustomersChannelTab: the async work is declared inside the effect behind an
  // `alive` guard so an unmount mid-flight cannot write state, and a retry re-runs it via
  // refreshKey. Every setState sits in the async callback, never in the effect body — that is a
  // lint error in this repo which typecheck does not catch.
  useEffect(() => {
    let alive = true;

    const doFetch = async () => {
      setResult(null);
      setIsLoading(true);
      setError(null);
      try {
        const response = await fetch("/api/sales/channels-by-rep", { cache: "no-store" });
        const text = await response.text();
        if (!alive) return;
        const payload: ChannelsResponse = text ? JSON.parse(text) : { success: response.ok };
        if (payload.success && payload.data) setResult(payload.data);
        else setError(payload.error ?? "Failed to load Channels by Rep.");
      } catch (caught) {
        if (!alive) return;
        setError(caught instanceof Error ? caught.message : "Failed to load Channels by Rep.");
      } finally {
        if (alive) setIsLoading(false);
      }
    };

    void doFetch();
    return () => {
      alive = false;
    };
  }, [refreshKey]);

  const rows: ChannelsByRepRow[] = result?.rows ?? [];

  const table = useSortableTable<ChannelsByRepRow>(rows, {
    columns: [
      { key: "label", accessor: (row) => row.label, type: "string" },
      { key: "lineCode", accessor: (row) => row.lineCode, type: "string" },
      { key: "areaName", accessor: (row) => row.areaName ?? row.areaCode, type: "string" },
      { key: "hospitalValue", accessor: (row) => row.hospitalValue, type: "number" },
      { key: "storeValue", accessor: (row) => row.storeValue, type: "number" },
      { key: "pharmacyValue", accessor: (row) => row.pharmacyValue, type: "number" },
      { key: "totalValue", accessor: (row) => row.totalValue, type: "number" },
    ],
    initialSort: { dir: "desc", key: "totalValue" },
    searchAccessors: [(row) => row.label, (row) => row.areaName, (row) => row.lineCode],
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading Channels by Rep…
      </div>
    );
  }

  if (error) {
    return (
      <AdminCallout tone="danger">
        <p className="font-black">Channels by Rep could not load</p>
        <p>{error}</p>
        <button
          className="mt-2 border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 transition hover:border-[#FDBA74] hover:text-[#F97316]"
          onClick={() => setRefreshKey((key) => key + 1)}
          type="button"
        >
          Try again
        </button>
      </AdminCallout>
    );
  }

  if (!result) return null;

  const { totals } = result;
  const columnCount = 7;

  return (
    <div className="space-y-5">
      {/* Say it before the numbers are read, not in a footnote underneath them. */}
      {!result.restrictedProductsIncluded ? (
        <AdminCallout tone="warning">
          <p className="font-black">Restricted products are excluded from every figure below</p>
          <p>
            Lacto Basic 1, Lacto Basic 2 and Satoslim are stripped by default for every viewer. They
            are the majority of sales value, so these totals are not the whole business.
          </p>
        </AdminCallout>
      ) : null}

      {/* All three channels at once — the comparison is the point, so it must not need a click. */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {CHANNEL_TILES.map((tile) => {
          const Icon = tile.icon;
          const value = tile.of(totals);
          return (
            <div className="border border-[#E2E8F0] bg-white p-4" key={tile.key}>
              <div className="flex items-center gap-2">
                <Icon className="h-4 w-4 text-[#F97316]" />
                <span className="whitespace-nowrap text-xs font-black uppercase tracking-[0.12em] text-slate-500">
                  {tile.label}
                </span>
              </div>
              <p className="mt-2 whitespace-nowrap text-2xl font-black tabular-nums text-[#0F172A]">
                {formatCurrency(value)}
              </p>
              <p className="mt-0.5 whitespace-nowrap text-xs text-slate-400">
                {share(value, totals.totalValue)} of sales shown
              </p>
            </div>
          );
        })}
      </div>

      {/* The unattributed slice gets its own statement rather than being left for the reader to
          notice a shortfall in the table and work out why. */}
      {totals.unattributedValue > 0 ? (
        <AdminCallout tone="warning">
          <p className="font-black">Sales that reached no rep</p>
          <p className="flex items-center gap-2">
            <UserX className="h-4 w-4 shrink-0" />
            <span>
              {formatCurrency(totals.unattributedValue)} — {share(totals.unattributedValue, totals.totalValue)}{" "}
              of the value below — sits on a vacant seat or on an area that is not on the seat model.
              It is listed in the table rather than dropped, so these figures still add to the total.
            </span>
          </p>
        </AdminCallout>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="whitespace-nowrap text-xs font-bold uppercase tracking-[0.12em] text-slate-500">
          {formatNumber(table.total)} rows
        </span>
        <div className="w-56">
          <TableSearchInput
            onChange={table.setQuery}
            onClear={table.clearQuery}
            placeholder="Quick-filter loaded rows…"
            size="md"
            value={table.query}
          />
        </div>
      </div>

      {/* Desktop: the full table. Mobile: cards — never a horizontally scrolling table. */}
      <div className="hidden overflow-x-auto md:block">
        <div className="overflow-hidden border border-[#E2E8F0]">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-[#0B0B0B] text-slate-100">
              <tr>
                <SortableTh className="text-xs tracking-[0.12em]" label="Rep" onSort={table.toggleSort} sort={table.sort} sortKey="label" variant="dark" />
                <SortableTh className="text-xs tracking-[0.12em]" label="Line" onSort={table.toggleSort} sort={table.sort} sortKey="lineCode" variant="dark" />
                <SortableTh className="text-xs tracking-[0.12em]" label="Area" onSort={table.toggleSort} sort={table.sort} sortKey="areaName" variant="dark" />
                <SortableTh align="right" className="text-xs tracking-[0.12em]" label="Hospitals" onSort={table.toggleSort} sort={table.sort} sortKey="hospitalValue" variant="dark" />
                <SortableTh align="right" className="text-xs tracking-[0.12em]" label="Stores" onSort={table.toggleSort} sort={table.sort} sortKey="storeValue" variant="dark" />
                <SortableTh align="right" className="text-xs tracking-[0.12em]" label="Pharmacies" onSort={table.toggleSort} sort={table.sort} sortKey="pharmacyValue" variant="dark" />
                <SortableTh align="right" className="text-xs tracking-[0.12em]" label="Total" onSort={table.toggleSort} sort={table.sort} sortKey="totalValue" variant="dark" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2E8F0]">
              {table.rows.length === 0 ? (
                rows.length === 0 ? (
                  <tr>
                    <td className="px-3 py-6 text-center text-slate-400" colSpan={columnCount}>
                      No sales in the uploaded data.
                    </td>
                  </tr>
                ) : (
                  <TableNoResults colSpan={columnCount} filtered label="reps" />
                )
              ) : (
                table.rows.map((row) => (
                  <tr
                    className={cn(
                      "transition-colors hover:bg-orange-50/50",
                      row.attribution === "rep" ? "" : "bg-amber-50/40",
                    )}
                    key={`${row.seatId ?? "none"}:${row.repHrId ?? "none"}:${row.areaCode ?? "none"}:${row.lineCode ?? "none"}`}
                  >
                    <td className="whitespace-nowrap px-3 py-2.5">
                      <span
                        className={cn(
                          "block font-semibold",
                          row.attribution === "rep" ? "text-[#0F172A]" : "text-[#9A3412]",
                        )}
                      >
                        {row.label}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{row.lineCode ?? "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{row.areaName ?? row.areaCode ?? "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right font-semibold tabular-nums text-slate-900">{formatCurrency(row.hospitalValue)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right font-semibold tabular-nums text-slate-900">{formatCurrency(row.storeValue)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right font-semibold tabular-nums text-slate-900">{formatCurrency(row.pharmacyValue)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right font-black tabular-nums text-[#0F172A]">{formatCurrency(row.totalValue)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="space-y-2 md:hidden">
        {table.rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-400">
            {rows.length === 0 ? "No sales in the uploaded data." : "No reps match this filter."}
          </p>
        ) : (
          table.rows.map((row) => (
            <div
              className={cn(
                "border p-3",
                row.attribution === "rep" ? "border-slate-200 bg-white" : "border-[#FDBA74] bg-amber-50/40",
              )}
              key={`${row.seatId ?? "none"}:${row.repHrId ?? "none"}:${row.areaCode ?? "none"}:${row.lineCode ?? "none"}`}
            >
              <div className="flex items-start justify-between gap-2">
                <p
                  className={cn(
                    "text-sm font-bold",
                    row.attribution === "rep" ? "text-slate-900" : "text-[#9A3412]",
                  )}
                >
                  {row.label}
                </p>
                {row.attribution !== "rep" ? (
                  <AlertTriangle className="h-4 w-4 shrink-0 text-[#9A3412]" />
                ) : null}
              </div>
              <p className="mt-0.5 whitespace-nowrap text-xs text-slate-500">
                {(row.lineCode ?? "—") + " · " + (row.areaName ?? row.areaCode ?? "—")}
              </p>
              <dl className="mt-2 grid grid-cols-2 gap-2 text-xs">
                <div>
                  <dt className="whitespace-nowrap text-[10px] font-bold uppercase text-slate-400">Hospitals</dt>
                  <dd className="whitespace-nowrap font-bold tabular-nums text-slate-800">{formatCurrency(row.hospitalValue)}</dd>
                </div>
                <div>
                  <dt className="whitespace-nowrap text-[10px] font-bold uppercase text-slate-400">Stores</dt>
                  <dd className="whitespace-nowrap font-bold tabular-nums text-slate-800">{formatCurrency(row.storeValue)}</dd>
                </div>
                <div>
                  <dt className="whitespace-nowrap text-[10px] font-bold uppercase text-slate-400">Pharmacies</dt>
                  <dd className="whitespace-nowrap font-bold tabular-nums text-slate-800">{formatCurrency(row.pharmacyValue)}</dd>
                </div>
                <div>
                  <dt className="whitespace-nowrap text-[10px] font-bold uppercase text-slate-400">Total</dt>
                  <dd className="whitespace-nowrap font-black tabular-nums text-slate-900">{formatCurrency(row.totalValue)}</dd>
                </div>
              </dl>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
