"use client";

import { AlertTriangle, HeartPulse, Loader2, Pill, Store, UserX } from "lucide-react";
import { useEffect, useState } from "react";

import { AdminCallout } from "@/components/admin/admin-design-system";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { SortableTh, TableNoResults, TableSearchInput } from "@/components/ui/sortable-table";
import { useSortableTable } from "@/components/ui/use-sortable-table";
import { formatCurrency, formatNumber } from "@/lib/sales/format";
import { CHANNELS_BY_REP_WHOLE_HISTORY, periodProseLabel } from "@/lib/sales/periods";
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
  // Null until someone picks: the server then answers with the newest published closing.
  const [chosenPeriod, setChosenPeriod] = useState<string | null>(null);
  // Outlives `result`, which is cleared on every load, so the picker stays on screen through one.
  const [availablePeriods, setAvailablePeriods] = useState<string[]>([]);
  const [shownPeriod, setShownPeriod] = useState<string | null>(null);

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
        const query = chosenPeriod ? `?period=${encodeURIComponent(chosenPeriod)}` : "";
        const response = await fetch(`/api/sales/channels-by-rep${query}`, { cache: "no-store" });
        const text = await response.text();
        if (!alive) return;
        const payload: ChannelsResponse = text ? JSON.parse(text) : { success: response.ok };
        if (payload.success && payload.data) {
          setResult(payload.data);
          setAvailablePeriods(payload.data.availablePeriods);
          setShownPeriod(payload.data.period);
        } else setError(payload.error ?? "Failed to load Channels by Rep.");
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
  }, [chosenPeriod, refreshKey]);

  const rows: ChannelsByRepRow[] = result?.rows ?? [];

  const table = useSortableTable<ChannelsByRepRow>(rows, {
    columns: [
      { key: "label", accessor: (row) => row.label, type: "string" },
      { key: "lineName", accessor: (row) => row.lineName, type: "string" },
      { key: "areaName", accessor: (row) => row.areaName ?? row.areaCode, type: "string" },
      { key: "hospitalValue", accessor: (row) => row.hospitalValue, type: "number" },
      { key: "storeValue", accessor: (row) => row.storeValue, type: "number" },
      { key: "pharmacyValue", accessor: (row) => row.pharmacyValue, type: "number" },
      { key: "totalValue", accessor: (row) => row.totalValue, type: "number" },
    ],
    initialSort: { dir: "desc", key: "totalValue" },
    searchAccessors: [(row) => row.label, (row) => row.areaName, (row) => row.lineName],
  });

  // Locked while a read runs, like the Monthly Source Dashboard's month select: leaving a whole-history
  // read does not stop it on the database, so changing month mid-load would stack a second query on it.
  const monthPicker =
    availablePeriods.length > 0 ? (
      <div className="w-full sm:w-72">
        <SearchableSelect
          aria-label="Month"
          className="px-3"
          disabled={isLoading}
          onChange={(event) => setChosenPeriod(event.target.value)}
          value={chosenPeriod ?? shownPeriod ?? CHANNELS_BY_REP_WHOLE_HISTORY}
        >
          {availablePeriods.map((period) => (
            <option key={period} value={period}>
              {periodProseLabel(period)}
            </option>
          ))}
          <option value={CHANNELS_BY_REP_WHOLE_HISTORY}>Whole history (about 30 seconds)</option>
        </SearchableSelect>
      </div>
    ) : null;

  if (isLoading) {
    return (
      <div className="space-y-5">
        {monthPicker}
        <div className="flex items-center gap-2 py-10 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          {chosenPeriod === CHANNELS_BY_REP_WHOLE_HISTORY
            ? "Loading the whole history. This takes about 30 seconds."
            : "Loading Channels by Rep…"}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-5">
        {monthPicker}
        <AdminCallout tone="danger">
          <p className="font-black">Channels by Rep could not load</p>
          <p>{error}</p>
          <button
            className="mt-2 border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 transition hover:border-phx-accent-line hover:text-phx-accent"
            onClick={() => setRefreshKey((key) => key + 1)}
            type="button"
          >
            Try again
          </button>
        </AdminCallout>
      </div>
    );
  }

  if (!result) return null;

  const { totals } = result;
  const columnCount = 7;
  const noSalesMessage = result.period
    ? `No sales in ${periodProseLabel(result.period)}.`
    : "No sales in the uploaded data.";

  return (
    <div className="space-y-5">
      {monthPicker}

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
            <div className="border border-phx-line bg-white p-4" key={tile.key}>
              <div className="flex items-center gap-2">
                <Icon className="h-4 w-4 text-phx-accent" />
                <span className="whitespace-nowrap text-xs font-black uppercase tracking-[0.12em] text-slate-500">
                  {tile.label}
                </span>
              </div>
              <p className="mt-2 whitespace-nowrap text-2xl font-black tabular-nums text-phx-ink">
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
      <div className="hidden md:block">
        <div className="overflow-hidden border border-phx-line">
          {/* table-fixed + a percentage colgroup: the seven columns divide whatever width the
              container has, so no data length can push the table sideways. */}
          <table className="w-full table-fixed text-sm">
            <colgroup>
              <col className="w-[22%]" />
              <col className="w-[10%]" />
              <col className="w-[16%]" />
              <col className="w-[13%]" />
              <col className="w-[13%]" />
              <col className="w-[13%]" />
              <col className="w-[13%]" />
            </colgroup>
            <thead className="bg-[#0B0B0B] text-slate-100">
              <tr>
                <SortableTh className="break-words text-xs tracking-[0.12em]" label="Rep" onSort={table.toggleSort} sort={table.sort} sortKey="label" variant="dark" />
                <SortableTh className="break-words text-xs tracking-[0.12em]" label="Line" onSort={table.toggleSort} sort={table.sort} sortKey="lineName" variant="dark" />
                <SortableTh className="break-words text-xs tracking-[0.12em]" label="Area" onSort={table.toggleSort} sort={table.sort} sortKey="areaName" variant="dark" />
                <SortableTh align="right" className="break-words text-xs tracking-[0.12em]" label="Hospitals" onSort={table.toggleSort} sort={table.sort} sortKey="hospitalValue" variant="dark" />
                <SortableTh align="right" className="break-words text-xs tracking-[0.12em]" label="Stores" onSort={table.toggleSort} sort={table.sort} sortKey="storeValue" variant="dark" />
                <SortableTh align="right" className="break-words text-xs tracking-[0.12em]" label="Pharmacies" onSort={table.toggleSort} sort={table.sort} sortKey="pharmacyValue" variant="dark" />
                <SortableTh align="right" className="break-words text-xs tracking-[0.12em]" label="Total" onSort={table.toggleSort} sort={table.sort} sortKey="totalValue" variant="dark" />
              </tr>
            </thead>
            <tbody className="divide-y divide-phx-line">
              {table.rows.length === 0 ? (
                rows.length === 0 ? (
                  <tr>
                    <td className="px-3 py-6 text-center text-slate-400" colSpan={columnCount}>
                      {noSalesMessage}
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
                    <td className="break-words px-3 py-2.5 align-top">
                      <span
                        className={cn(
                          "block font-semibold",
                          row.attribution === "rep" ? "text-phx-ink" : "text-[#9A3412]",
                        )}
                      >
                        {row.label}
                      </span>
                    </td>
                    <td className="break-words px-3 py-2.5 align-top text-slate-600">{row.lineName ?? "—"}</td>
                    <td className="break-words px-3 py-2.5 align-top text-slate-600">{row.areaName ?? row.areaCode ?? "—"}</td>
                    <td className="break-words px-3 py-2.5 text-right align-top font-semibold tabular-nums text-slate-900">{formatCurrency(row.hospitalValue)}</td>
                    <td className="break-words px-3 py-2.5 text-right align-top font-semibold tabular-nums text-slate-900">{formatCurrency(row.storeValue)}</td>
                    <td className="break-words px-3 py-2.5 text-right align-top font-semibold tabular-nums text-slate-900">{formatCurrency(row.pharmacyValue)}</td>
                    <td className="break-words px-3 py-2.5 text-right align-top font-black tabular-nums text-phx-ink">{formatCurrency(row.totalValue)}</td>
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
            {rows.length === 0 ? noSalesMessage : "No reps match this filter."}
          </p>
        ) : (
          table.rows.map((row) => (
            <div
              className={cn(
                "border p-3",
                row.attribution === "rep" ? "border-slate-200 bg-white" : "border-phx-accent-line bg-amber-50/40",
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
                {(row.lineName ?? "—") + " · " + (row.areaName ?? row.areaCode ?? "—")}
              </p>
              <dl className="mt-2 grid grid-cols-2 gap-2 text-xs">
                <div>
                  <dt className="whitespace-nowrap text-phx-sm font-bold uppercase text-slate-400">Hospitals</dt>
                  <dd className="whitespace-nowrap font-bold tabular-nums text-slate-800">{formatCurrency(row.hospitalValue)}</dd>
                </div>
                <div>
                  <dt className="whitespace-nowrap text-phx-sm font-bold uppercase text-slate-400">Stores</dt>
                  <dd className="whitespace-nowrap font-bold tabular-nums text-slate-800">{formatCurrency(row.storeValue)}</dd>
                </div>
                <div>
                  <dt className="whitespace-nowrap text-phx-sm font-bold uppercase text-slate-400">Pharmacies</dt>
                  <dd className="whitespace-nowrap font-bold tabular-nums text-slate-800">{formatCurrency(row.pharmacyValue)}</dd>
                </div>
                <div>
                  <dt className="whitespace-nowrap text-phx-sm font-bold uppercase text-slate-400">Total</dt>
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
