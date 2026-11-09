"use client";

import { AlertTriangle, Download, Loader2, HeartPulse, Pill, Store } from "lucide-react";
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

// Customers tab — the Source-of-Sales customer base split into the three channels the owner
// cares about: PHARMACIES (normal customers), STORES (wholesalers / warehouses / trading
// companies, identified by the six keywords in src/lib/sales/customer-channel.ts) and HOSPITALS
// (names carrying مستشف or "hosp"). The split is derived from the customer's name on every read,
// so historical uploads and every future upload land on the correct side with no backfill.

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
  plural: string;
}> = [
  {
    blurb: "Customers whose name carries none of the store or hospital keywords.",
    icon: Pill,
    key: "pharmacy",
    label: "Pharmacies",
    plural: "pharmacies",
  },
  {
    blurb: "Customers whose name contains مخزن, فارما / فارم, تريد, الشركة, الجمعيه or للتجارة.",
    icon: Store,
    key: "store",
    label: "Stores",
    plural: "stores",
  },
  {
    blurb: "Customers whose name contains مستشفى / مستشفي or hospital — the hospital itself and its in-house pharmacy both land here.",
    icon: HeartPulse,
    key: "hospital",
    label: "Hospitals",
    plural: "hospitals",
  },
];

// One place that maps a channel to its side of the payload, so a new channel cannot be added to
// CHANNELS without the compiler demanding its group here.
function groupFor(result: CustomerDirectoryChannelResult, channel: CustomerChannel): CustomerChannelGroup {
  if (channel === "hospital") return result.hospitals;
  if (channel === "store") return result.stores;
  return result.pharmacies;
}

function pluralFor(channel: CustomerChannel): string {
  return CHANNELS.find((entry) => entry.key === channel)?.plural ?? "customers";
}

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
  const group = result ? groupFor(result, channel) : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2 rounded-2xl border border-phx-line bg-white/90 p-2 shadow-[0_14px_32px_rgba(15,23,42,0.06)]">
        {CHANNELS.map((entry) => {
          const Icon = entry.icon;
          const side = result ? groupFor(result, entry.key) : null;
          return (
            <Button
              className={cn(
                "gap-2 rounded-xl font-black",
                channel === entry.key ? "bg-[#0B0B0B] text-white hover:bg-phx-accent" : "",
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

      {/* Every side at once, so "how much comes from stores vs pharmacies vs hospitals" is
          answered without switching tabs. Rendered only once the data is real — never as a zero. */}
      {result ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {CHANNELS.map((entry) => {
            const side = groupFor(result, entry.key);
            const Icon = entry.icon;
            const isActive = entry.key === channel;
            return (
              <div
                className={cn(
                  "border p-4 transition",
                  isActive ? "border-phx-accent bg-orange-50/40" : "border-phx-line bg-white",
                )}
                key={entry.key}
              >
                <div className="flex items-center gap-2">
                  <Icon className={cn("h-4 w-4", isActive ? "text-phx-accent" : "text-slate-400")} />
                  <p className="text-xs font-black uppercase tracking-[0.12em] text-slate-500">{entry.label}</p>
                </div>
                <p className="mt-2 text-2xl font-black tabular-nums text-phx-ink">{formatCurrency(side.totalValue)}</p>
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
                  className="mt-2 inline-flex items-center gap-1 whitespace-nowrap border border-slate-300 bg-white px-2.5 py-1.5 text-phx-xs font-bold text-slate-700 transition hover:border-phx-accent-line hover:text-phx-accent"
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
      anchor.download = `phoenix-customers-${pluralFor(channel)}.xlsx`;
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
      className="inline-flex h-10 items-center gap-2 whitespace-nowrap border border-[#0B0B0B] bg-[#0B0B0B] px-4 text-sm font-bold text-white transition hover:bg-phx-accent disabled:opacity-50"
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
  // Stores and hospitals were both placed by a keyword, so both must show WHICH word did it.
  // Pharmacies are the residue — there is no word to show.
  const showsKeywords = channel !== "pharmacy";
  const plural = pluralFor(channel);
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

  // Brick ID rides inside Brick and Region inside Territory, so the table is nine columns wide
  // (ten with the matched-word column) — keep this in step with the colgroup below.
  const columnCount = showsKeywords ? 9 : 8;

  return (
    <div className="p-4 md:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <AdminInsightChip tone={showsKeywords ? "orange" : "slate"}>
            {formatNumber(group.totalCustomers)} {plural} · {formatCurrency(group.totalValue)}
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
      <div className="hidden md:block">
        <div className="overflow-hidden border border-phx-line">
          {/* Eleven columns cannot divide a screen, so two pairs are MERGED rather than shrunk:
              Brick ID + Brick Name read as one Brick cell, Area + Region as one Territory cell.
              table-fixed + a percentage colgroup then makes a sideways scroll impossible. */}
          <table className="w-full table-fixed text-sm">
            <colgroup>
              <col className={showsKeywords ? "w-[15%]" : "w-[18%]"} />
              {showsKeywords ? <col className="w-[10%]" /> : null}
              <col className={showsKeywords ? "w-[12%]" : "w-[15%]"} />
              <col className={showsKeywords ? "w-[12%]" : "w-[13%]"} />
              <col className={showsKeywords ? "w-[12%]" : "w-[12%]"} />
              <col className={showsKeywords ? "w-[11%]" : "w-[12%]"} />
              <col className={showsKeywords ? "w-[8%]" : "w-[9%]"} />
              <col className={showsKeywords ? "w-[10%]" : "w-[11%]"} />
              {/* The View link cannot shrink below about 61px, and this table starts at md —
                  a narrower share CLIPS the button at exactly 768px. */}
              <col className="w-[10%]" />
            </colgroup>
            <thead className="bg-[#0B0B0B] text-slate-100">
              <tr>
                <SortableTh className="break-words text-xs tracking-[0.12em]" label="Customer" onSort={table.toggleSort} sort={table.sort} sortKey="clientName" variant="dark" />
                {showsKeywords ? (
                  <SortableTh className="break-words text-xs tracking-[0.12em]" label="Matched Word" onSort={table.toggleSort} sort={table.sort} sortKey="matchedKeywords" variant="dark" />
                ) : null}
                <SortableTh className="break-words text-xs tracking-[0.12em]" label="Address" onSort={table.toggleSort} sort={table.sort} sortKey="clientAddress" variant="dark" />
                <SortableTh className="break-words text-xs tracking-[0.12em]" label="Distributor" onSort={table.toggleSort} sort={table.sort} sortKey="distributorName" variant="dark" />
                <SortableTh className="break-words text-xs tracking-[0.12em]" label="Brick" onSort={table.toggleSort} sort={table.sort} sortKey="brickName" variant="dark" />
                <SortableTh className="break-words text-xs tracking-[0.12em]" label="Territory" onSort={table.toggleSort} sort={table.sort} sortKey="areaName" variant="dark" />
                <SortableTh align="right" className="break-words text-xs tracking-[0.12em]" label="Units" onSort={table.toggleSort} sort={table.sort} sortKey="totalUnits" variant="dark" />
                <SortableTh align="right" className="break-words text-xs tracking-[0.12em]" label="Value" onSort={table.toggleSort} sort={table.sort} sortKey="totalValue" variant="dark" />
                <th className="px-3 py-2 text-left text-xs font-black uppercase tracking-[0.12em]"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-phx-line">
              {table.rows.length === 0 ? (
                group.customers.length === 0 ? (
                  <tr>
                    <td className="px-3 py-6 text-center text-slate-400" colSpan={columnCount}>
                      No {plural} in the uploaded sales.
                    </td>
                  </tr>
                ) : (
                  <TableNoResults colSpan={columnCount} filtered label={plural} />
                )
              ) : (
                table.rows.map((row) => (
                  <tr className="transition-colors hover:bg-orange-50/50" key={`${row.distributorCode}:${row.clientCode}`}>
                    <td className="break-words px-3 py-2.5 align-top">
                      <Link className="block" href={customerHref(row)}>
                        <span className="block font-semibold text-phx-ink hover:text-phx-accent">{row.clientName || "—"}</span>
                        <span className="block text-xs text-slate-400">{row.clientCode}</span>
                      </Link>
                    </td>
                    {showsKeywords ? (
                      <td className="break-words px-3 py-2.5 align-top">
                        <span className="inline-block border border-phx-accent-line bg-orange-50 px-2 py-0.5 text-phx-xs font-bold text-[#9A3412]">
                          {row.matchedKeywords.join(" + ") || "—"}
                        </span>
                      </td>
                    ) : null}
                    <td className="break-words px-3 py-2.5 align-top text-slate-500">{row.clientAddress || "—"}</td>
                    <td className="break-words px-3 py-2.5 align-top text-slate-600">{row.distributorName}</td>
                    <td className="break-words px-3 py-2.5 align-top text-slate-600">
                      <span className="block">{row.brickName || "—"}</span>
                      <span className="block text-xs text-slate-400">{row.brickId}</span>
                    </td>
                    <td className="break-words px-3 py-2.5 align-top text-slate-600">
                      <span className="block">{row.areaName}</span>
                      <span className="block text-xs text-slate-400">{row.regionName}</span>
                    </td>
                    <td className="break-words px-3 py-2.5 text-right align-top font-semibold tabular-nums text-slate-900">{formatNumber(row.totalUnits)}</td>
                    <td className="break-words px-3 py-2.5 text-right align-top font-semibold tabular-nums text-slate-900">{formatCurrency(row.totalValue)}</td>
                    <td className="px-3 py-2.5 align-top">
                      <Link
                        className="inline-flex items-center gap-1 border border-slate-200 bg-white px-2.5 py-1.5 text-phx-xs font-bold text-slate-700 transition hover:border-phx-accent-line hover:text-phx-accent"
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
              ? `No ${plural} in the uploaded sales.`
              : `No ${plural} match this filter.`}
          </p>
        ) : (
          table.rows.map((row) => (
            <Link
              className="block border border-slate-200 bg-white p-3 transition hover:border-phx-accent-line"
              href={customerHref(row)}
              key={`${row.distributorCode}:${row.clientCode}`}
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-bold text-slate-900">{row.clientName || "—"}</p>
                <span className="shrink-0 text-xs font-bold text-slate-500">{row.clientCode}</span>
              </div>
              {showsKeywords && row.matchedKeywords.length > 0 ? (
                <span className="mt-1 inline-block border border-phx-accent-line bg-orange-50 px-2 py-0.5 text-phx-xs font-bold text-[#9A3412]">
                  {row.matchedKeywords.join(" + ")}
                </span>
              ) : null}
              <p className="mt-1 text-xs text-slate-500">{row.clientAddress || "—"}</p>
              <p className="mt-0.5 text-xs text-slate-500">
                {row.distributorName} · {row.areaName} / {row.regionName} · {row.brickName || row.brickId}
              </p>
              <dl className="mt-2 grid grid-cols-2 gap-2 text-xs">
                <div>
                  <dt className="text-phx-sm font-bold uppercase text-slate-400">Units</dt>
                  <dd className="font-bold tabular-nums text-slate-800">{formatNumber(row.totalUnits)}</dd>
                </div>
                <div>
                  <dt className="text-phx-sm font-bold uppercase text-slate-400">Value</dt>
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
