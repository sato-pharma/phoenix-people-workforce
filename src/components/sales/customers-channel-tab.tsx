"use client";

import { AlertTriangle, Download, Loader2, Pill, Store } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { AdminCallout, AdminInsightChip, AdminTableShell } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { SortableTh, TableNoResults, TableSearchInput, useSortableTable } from "@/components/ui/sortable-table";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/sales/format";
import type { CustomerChannel } from "@/lib/sales/customer-channel";
import type {
  CustomerChannelGroup,
  CustomerDirectoryChannelResult,
  CustomerDirectoryRow,
} from "@/lib/sales/customer-directory";

// Customers tab — the Source-of-Sales customer base split into the two channels the owner
// cares about: PHARMACIES (normal customers) and STORES (wholesalers / warehouses / trading
// companies, identified by the six keywords in src/lib/sales/customer-channel.ts). The split is
// derived from the customer's name on every read, so historical uploads and every future upload
// land on the correct side with no backfill.

type ChannelResponse = {
  data?: CustomerDirectoryChannelResult;
  error?: string;
  success: boolean;
};

function customerHref(row: CustomerDirectoryRow) {
  return `/sales/customer-directory/${encodeURIComponent(row.distributorCode)}/${encodeURIComponent(row.clientCode)}`;
}

const CHANNELS: ReadonlyArray<{
  blurb: string;
  icon: typeof Pill;
  key: CustomerChannel;
  label: string;
}> = [
  {
    blurb: "Customers whose name carries none of the store keywords.",
    icon: Pill,
    key: "pharmacy",
    label: "Pharmacies",
  },
  {
    blurb: "Customers whose name contains مخزن, فارما / فارم, تريد, الشركة, الجمعيه or للتجارة.",
    icon: Store,
    key: "store",
    label: "Stores",
  },
];

export function CustomersChannelTab() {
  const [result, setResult] = useState<CustomerDirectoryChannelResult | null>(null);
  const [channel, setChannel] = useState<CustomerChannel>("pharmacy");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Same shape as SosCoverageTab: the async work is declared inside the effect with an `alive`
  // guard, so an unmount mid-flight cannot write state, and a retry re-runs it via refreshKey.
  useEffect(() => {
    let alive = true;

    const doFetch = async () => {
      setResult(null);
      setIsLoading(true);
      setError(null);
      try {
        const response = await fetch("/api/sales/customer-directory/by-channel", { cache: "no-store" });
        const text = await response.text();
        if (!alive) return;
        const payload: ChannelResponse = text ? JSON.parse(text) : { success: response.ok };
        if (payload.success && payload.data) setResult(payload.data);
        else setError(payload.error ?? "Failed to load Customers.");
      } catch (caught) {
        if (!alive) return;
        setError(caught instanceof Error ? caught.message : "Failed to load Customers.");
      } finally {
        if (alive) setIsLoading(false);
      }
    };

    void doFetch();
    return () => {
      alive = false;
    };
  }, [refreshKey]);

  const active = CHANNELS.find((entry) => entry.key === channel) ?? CHANNELS[0];
  const group = result ? (channel === "store" ? result.stores : result.pharmacies) : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2 rounded-2xl border border-[#D8E0EA] bg-white/90 p-2 shadow-[0_14px_32px_rgba(15,23,42,0.06)]">
        {CHANNELS.map((entry) => {
          const Icon = entry.icon;
          const side = result ? (entry.key === "store" ? result.stores : result.pharmacies) : null;
          return (
            <Button
              className={cn(
                "gap-2 rounded-xl font-black",
                channel === entry.key ? "bg-[#0B0B0B] text-white hover:bg-[#F97316]" : "",
              )}
              key={entry.key}
              onClick={() => setChannel(entry.key)}
              variant="secondary"
            >
              <Icon className="h-4 w-4" />
              {entry.label}
              {side ? (
                <span className="tabular-nums opacity-70">({formatNumber(side.totalCustomers)})</span>
              ) : null}
            </Button>
          );
        })}
      </div>

      {/* Both sides side by side, so "how much comes from stores vs pharmacies" is answered
          without switching tabs. Rendered only once the data is real — never as a zero. */}
      {result ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {CHANNELS.map((entry) => {
            const side = entry.key === "store" ? result.stores : result.pharmacies;
            const Icon = entry.icon;
            const isActive = entry.key === channel;
            return (
              <div
                className={cn(
                  "border p-4 transition",
                  isActive ? "border-[#F97316] bg-orange-50/40" : "border-[#E2E8F0] bg-white",
                )}
                key={entry.key}
              >
                <div className="flex items-center gap-2">
                  <Icon className={cn("h-4 w-4", isActive ? "text-[#F97316]" : "text-slate-400")} />
                  <p className="text-xs font-black uppercase tracking-[0.12em] text-slate-500">{entry.label}</p>
                </div>
                <p className="mt-2 text-2xl font-black tabular-nums text-[#0F172A]">{formatCurrency(side.totalValue)}</p>
                <p className="mt-1 whitespace-nowrap text-xs font-semibold text-slate-500">
                  {formatNumber(side.totalCustomers)} customers · {formatNumber(side.totalUnits)} units
                </p>
              </div>
            );
          })}
        </div>
      ) : null}

      <AdminTableShell
        action={<ExportButton channel={channel} disabled={!group || group.totalCustomers === 0} />}
        description={active.blurb}
        title={active.label}
      >
        {error ? (
          <div className="p-4 md:p-5">
            <AdminCallout tone="danger">
              <AlertTriangle className="mt-0.5 h-4 w-4" />
              <div>
                <p>{error}</p>
                <button
                  className="mt-2 inline-flex items-center gap-1 whitespace-nowrap border border-slate-300 bg-white px-2.5 py-1.5 text-[11px] font-bold text-slate-700 transition hover:border-[#FDBA74] hover:text-[#F97316]"
                  onClick={() => setRefreshKey((key) => key + 1)}
                  type="button"
                >
                  Retry
                </button>
              </div>
            </AdminCallout>
          </div>
        ) : isLoading || !group ? (
          <div className="p-10 text-center text-slate-400">
            <Loader2 className="mx-auto h-6 w-6 animate-spin" />
            <p className="mt-2 text-xs font-semibold">Loading customers…</p>
          </div>
        ) : (
          <ChannelPanel channel={channel} group={group} key={channel} />
        )}
      </AdminTableShell>
    </div>
  );
}

function ExportButton({ channel, disabled }: { channel: CustomerChannel; disabled: boolean }) {
  const [isExporting, setIsExporting] = useState(false);
  const [failed, setFailed] = useState(false);

  async function handleExport() {
    setIsExporting(true);
    setFailed(false);
    try {
      const response = await fetch("/api/sales/customer-directory/export", {
        body: JSON.stringify({ channel }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) throw new Error("Export failed");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = channel === "store" ? "phoenix-customers-stores.xlsx" : "phoenix-customers-pharmacies.xlsx";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch {
      setFailed(true);
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <button
      className="inline-flex h-10 items-center gap-2 whitespace-nowrap border border-[#0B0B0B] bg-[#0B0B0B] px-4 text-sm font-bold text-white transition hover:bg-[#F97316] disabled:opacity-50"
      disabled={disabled || isExporting}
      onClick={() => void handleExport()}
      type="button"
    >
      {isExporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
      {failed ? "Export failed — retry" : "Export XLSX"}
    </button>
  );
}

function ChannelPanel({ channel, group }: { channel: CustomerChannel; group: CustomerChannelGroup }) {
  const isStore = channel === "store";
  const table = useSortableTable(group.customers, {
    columns: [
      { key: "clientName", accessor: (row) => row.clientName, type: "string" },
      { key: "matchedKeywords", accessor: (row) => row.matchedKeywords.join(" + "), type: "string" },
      { key: "clientAddress", accessor: (row) => row.clientAddress, type: "string" },
      { key: "distributorName", accessor: (row) => row.distributorName, type: "string" },
      { key: "brickId", accessor: (row) => row.brickId, type: "string" },
      { key: "brickName", accessor: (row) => row.brickName, type: "string" },
      { key: "areaName", accessor: (row) => row.areaName, type: "string" },
      { key: "regionName", accessor: (row) => row.regionName, type: "string" },
      { key: "totalUnits", accessor: (row) => row.totalUnits, type: "number" },
      { key: "totalValue", accessor: (row) => row.totalValue, type: "number" },
    ],
    searchAccessors: [
      (row) => row.clientName,
      (row) => row.clientCode,
      (row) => row.clientAddress,
      (row) => row.distributorName,
      (row) => row.brickId,
      (row) => row.brickName,
      (row) => row.areaName,
      (row) => row.regionName,
    ],
    initialSort: null,
  });

  const columnCount = isStore ? 11 : 10;

  return (
    <div className="p-4 md:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <AdminInsightChip tone={isStore ? "orange" : "slate"}>
            {formatNumber(group.totalCustomers)} {isStore ? "stores" : "pharmacies"} · {formatCurrency(group.totalValue)}
          </AdminInsightChip>
          {group.truncated ? (
            <span className="whitespace-nowrap text-xs font-semibold text-[#92400E]">
              Showing the first {formatNumber(group.customers.length)} — the totals above cover all{" "}
              {formatNumber(group.totalCustomers)}.
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {table.isFiltered ? (
            <span className="whitespace-nowrap text-xs font-semibold text-slate-500">
              {table.visible} of {table.total} loaded
            </span>
          ) : null}
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
      </div>

      {/* Desktop: the full table. Mobile: cards — never a horizontally scrolling table. */}
      <div className="hidden overflow-x-auto md:block">
        <div className="overflow-hidden border border-[#E2E8F0]">
          <table className="w-full min-w-[1100px] text-sm">
            <thead className="bg-[#0B0B0B] text-slate-100">
              <tr>
                <SortableTh className="text-xs tracking-[0.12em]" label="Customer" onSort={table.toggleSort} sort={table.sort} sortKey="clientName" variant="dark" />
                {isStore ? (
                  <SortableTh className="text-xs tracking-[0.12em]" label="Matched Word" onSort={table.toggleSort} sort={table.sort} sortKey="matchedKeywords" variant="dark" />
                ) : null}
                <SortableTh className="text-xs tracking-[0.12em]" label="Address" onSort={table.toggleSort} sort={table.sort} sortKey="clientAddress" variant="dark" />
                <SortableTh className="text-xs tracking-[0.12em]" label="Distributor" onSort={table.toggleSort} sort={table.sort} sortKey="distributorName" variant="dark" />
                <SortableTh className="text-xs tracking-[0.12em]" label="Brick ID" onSort={table.toggleSort} sort={table.sort} sortKey="brickId" variant="dark" />
                <SortableTh className="text-xs tracking-[0.12em]" label="Brick Name" onSort={table.toggleSort} sort={table.sort} sortKey="brickName" variant="dark" />
                <SortableTh className="text-xs tracking-[0.12em]" label="Area" onSort={table.toggleSort} sort={table.sort} sortKey="areaName" variant="dark" />
                <SortableTh className="text-xs tracking-[0.12em]" label="Region" onSort={table.toggleSort} sort={table.sort} sortKey="regionName" variant="dark" />
                <SortableTh align="right" className="text-xs tracking-[0.12em]" label="Units" onSort={table.toggleSort} sort={table.sort} sortKey="totalUnits" variant="dark" />
                <SortableTh align="right" className="text-xs tracking-[0.12em]" label="Value" onSort={table.toggleSort} sort={table.sort} sortKey="totalValue" variant="dark" />
                <th className="whitespace-nowrap px-3 py-2 text-left text-xs font-black uppercase tracking-[0.12em]"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2E8F0]">
              {table.rows.length === 0 ? (
                group.customers.length === 0 ? (
                  <tr>
                    <td className="px-3 py-6 text-center text-slate-400" colSpan={columnCount}>
                      No {isStore ? "stores" : "pharmacies"} in the uploaded sales.
                    </td>
                  </tr>
                ) : (
                  <TableNoResults colSpan={columnCount} filtered label={isStore ? "stores" : "pharmacies"} />
                )
              ) : (
                table.rows.map((row) => (
                  <tr className="transition-colors hover:bg-orange-50/50" key={`${row.distributorCode}:${row.clientCode}`}>
                    <td className="whitespace-nowrap px-3 py-2.5">
                      <Link className="block" href={customerHref(row)}>
                        <span className="block font-semibold text-[#0F172A] hover:text-[#F97316]">{row.clientName || "—"}</span>
                        <span className="block text-xs text-slate-400">{row.clientCode}</span>
                      </Link>
                    </td>
                    {isStore ? (
                      <td className="whitespace-nowrap px-3 py-2.5">
                        <span className="border border-[#FDBA74] bg-orange-50 px-2 py-0.5 text-[11px] font-bold text-[#9A3412]">
                          {row.matchedKeywords.join(" + ") || "—"}
                        </span>
                      </td>
                    ) : null}
                    <td className="whitespace-nowrap px-3 py-2.5 text-slate-500">{row.clientAddress || "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{row.distributorName}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 font-semibold text-slate-700">{row.brickId}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{row.brickName || "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{row.areaName}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{row.regionName}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right font-semibold tabular-nums text-slate-900">{formatNumber(row.totalUnits)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right font-semibold tabular-nums text-slate-900">{formatCurrency(row.totalValue)}</td>
                    <td className="px-3 py-2.5">
                      <Link
                        className="inline-flex items-center gap-1 whitespace-nowrap border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-bold text-slate-700 transition hover:border-[#FDBA74] hover:text-[#F97316]"
                        href={customerHref(row)}
                      >
                        View
                      </Link>
                    </td>
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
            {group.customers.length === 0
              ? `No ${isStore ? "stores" : "pharmacies"} in the uploaded sales.`
              : `No ${isStore ? "stores" : "pharmacies"} match this filter.`}
          </p>
        ) : (
          table.rows.map((row) => (
            <Link
              className="block border border-slate-200 bg-white p-3 transition hover:border-[#FDBA74]"
              href={customerHref(row)}
              key={`${row.distributorCode}:${row.clientCode}`}
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-bold text-slate-900">{row.clientName || "—"}</p>
                <span className="shrink-0 text-xs font-bold text-slate-500">{row.clientCode}</span>
              </div>
              {isStore && row.matchedKeywords.length > 0 ? (
                <span className="mt-1 inline-block border border-[#FDBA74] bg-orange-50 px-2 py-0.5 text-[11px] font-bold text-[#9A3412]">
                  {row.matchedKeywords.join(" + ")}
                </span>
              ) : null}
              <p className="mt-1 text-xs text-slate-500">{row.clientAddress || "—"}</p>
              <p className="mt-0.5 text-xs text-slate-500">
                {row.distributorName} · {row.areaName} · {row.brickName || row.brickId}
              </p>
              <dl className="mt-2 grid grid-cols-2 gap-2 text-xs">
                <div>
                  <dt className="text-[10px] font-bold uppercase text-slate-400">Units</dt>
                  <dd className="font-bold tabular-nums text-slate-800">{formatNumber(row.totalUnits)}</dd>
                </div>
                <div>
                  <dt className="text-[10px] font-bold uppercase text-slate-400">Value</dt>
                  <dd className="font-bold tabular-nums text-slate-800">{formatCurrency(row.totalValue)}</dd>
                </div>
              </dl>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
