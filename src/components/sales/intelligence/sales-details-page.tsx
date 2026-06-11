"use client";

import { AlertTriangle, Download, Loader2, Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { AdminCallout, AdminInsightChip, AdminPageHero, AdminTableShell } from "@/components/admin/admin-design-system";
import { formatCurrency, formatNumber } from "@/lib/sales/format";
import type { SiCustomerInsights, SiDetailsBundle } from "@/lib/sales/intelligence/types";
import type { SiExportTable } from "@/lib/sales/intelligence/export";
import { cn } from "@/lib/utils";

type Column = { header: string; numeric?: boolean };
type Row = { cells: string[]; search: string };

const pct = (share: number) => `${(share * 100).toFixed(1)}%`;

function SiExportButton({ includeRestricted, period, table }: { includeRestricted: boolean; period: string | null; table: SiExportTable }) {
  const [busy, setBusy] = useState(false);
  async function run() {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch("/api/sales/intelligence/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ table, period, includeRestricted }),
      });
      if (!response.ok) throw new Error("Export failed");
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const match = /filename="(.+?)"/.exec(disposition);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = match?.[1] ?? `phoenix-${table}.xlsx`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch {
      /* surfaced by the disabled state; nothing else to do */
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      className="inline-flex h-9 items-center gap-2 border border-[#D8E0EA] bg-white px-3 text-xs font-bold text-[#0F172A] shadow-sm transition hover:border-[#6B8FB5] hover:text-[#1E3A5F] disabled:opacity-50"
      disabled={busy}
      onClick={run}
      type="button"
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
      Export XLSX
    </button>
  );
}

function FilterableTable({ columns, rows }: { columns: Column[]; rows: Row[] }) {
  const [filter, setFilter] = useState("");
  const lower = filter.toLowerCase();
  const filtered = lower ? rows.filter((row) => row.search.includes(lower)) : rows;

  return (
    <div className="space-y-3 p-4 md:p-5">
      <div className="relative max-w-xs">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#94A3B8]" />
        <input
          className="h-9 w-full border border-[#E2E8F0] bg-[#F8FAFC] pl-9 pr-3 text-sm text-[#0F172A] outline-none focus:border-[#6B8FB5]"
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter rows…"
          type="text"
          value={filter}
        />
      </div>
      <div className="overflow-x-auto border border-[#E2E8F0]">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  className={cn("px-3 py-2 text-xs font-black uppercase tracking-wide", column.numeric ? "text-right" : "")}
                  key={column.header}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td className="px-3 py-6 text-center text-sm text-[#94A3B8]" colSpan={columns.length}>No rows.</td>
              </tr>
            ) : (
              filtered.slice(0, 500).map((row, rowIndex) => (
                <tr key={`${row.cells.join("|")}:${rowIndex}`}>
                  {row.cells.map((cell, cellIndex) => (
                    <td
                      className={cn(
                        "px-3 py-2",
                        columns[cellIndex]?.numeric ? "text-right font-black text-[#0F172A]" : "text-[#0F172A]",
                        cellIndex === 0 ? "font-bold" : columns[cellIndex]?.numeric ? "" : "text-[#64748B]",
                      )}
                      key={cellIndex}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] font-bold text-[#94A3B8]">{formatNumber(filtered.length)} rows{filtered.length > 500 ? " (showing first 500)" : ""}</p>
    </div>
  );
}

type TabKey = SiExportTable;
const TABS: { key: TabKey; label: string }[] = [
  { key: "transactions", label: "Transactions" },
  { key: "products", label: "Products" },
  { key: "distributors", label: "Distributors" },
  { key: "regions", label: "Regions" },
  { key: "areas", label: "Areas" },
  { key: "customers", label: "Customers" },
];

export function SalesDetailsPage({ bundle, error }: { bundle: SiDetailsBundle | null; error: string | null }) {
  if (error || !bundle) {
    return (
      <div className="min-h-[60vh] p-5">
        <AdminCallout tone="danger">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <p className="font-semibold">Sales Details could not load.</p>
            <p className="mt-1 text-sm">{error ?? "No data available."}</p>
          </div>
        </AdminCallout>
      </div>
    );
  }
  return <DetailsInner bundle={bundle} />;
}

function DetailsInner({ bundle }: { bundle: SiDetailsBundle }) {
  const { access } = bundle;
  const [tab, setTab] = useState<TabKey>("transactions");

  // Customers loaded lazily (heaviest aggregate), keyed by (period, restricted).
  const customerKey = `${bundle.period ?? ""}|${access.restrictedIncluded ? "1" : "0"}`;
  const [customerState, setCustomerState] = useState<{ key: string; data: SiCustomerInsights | null }>({ key: "", data: null });
  const customersLoading = tab === "customers" && customerState.key !== customerKey;
  const customers = customerState.key === customerKey ? customerState.data : null;
  useEffect(() => {
    if (tab !== "customers" || customerState.key === customerKey) return;
    let cancelled = false;
    const params = new URLSearchParams();
    if (bundle.period) params.set("period", bundle.period);
    if (access.restrictedIncluded) params.set("includeRestricted", "1");
    fetch(`/api/sales/intelligence/customers?${params.toString()}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (!cancelled) setCustomerState({ key: customerKey, data: payload?.success ? (payload.data as SiCustomerInsights) : null });
      })
      .catch(() => {
        if (!cancelled) setCustomerState({ key: customerKey, data: null });
      });
    return () => {
      cancelled = true;
    };
  }, [tab, customerKey, customerState.key, bundle.period, access.restrictedIncluded]);

  const tableData = useMemo<{ columns: Column[]; rows: Row[] }>(() => {
    const mk = (cells: string[]): Row => ({ cells, search: cells.join(" ").toLowerCase() });
    switch (tab) {
      case "transactions":
        return {
          columns: [
            { header: "Distributor" }, { header: "Line" }, { header: "Region" }, { header: "Area" },
            { header: "Product" }, { header: "Units", numeric: true }, { header: "Value", numeric: true },
          ],
          rows: bundle.transactions.map((row) => mk([row.distributorName, row.officialLine, row.regionName, row.areaName, row.productName, formatNumber(row.units), formatCurrency(row.value)])),
        };
      case "products":
        return {
          columns: [{ header: "Product" }, { header: "Line" }, { header: "Value", numeric: true }, { header: "Units", numeric: true }, { header: "Share", numeric: true }],
          rows: bundle.products.map((row) => mk([row.name, row.officialLine, formatCurrency(row.value), formatNumber(row.units), pct(row.share)])),
        };
      case "distributors":
        return {
          columns: [{ header: "Distributor" }, { header: "Value", numeric: true }, { header: "Units", numeric: true }, { header: "Share", numeric: true }],
          rows: bundle.distributors.map((row) => mk([row.name, formatCurrency(row.value), formatNumber(row.units), pct(row.share)])),
        };
      case "regions":
        return {
          columns: [{ header: "Region" }, { header: "Value", numeric: true }, { header: "Units", numeric: true }, { header: "Share", numeric: true }],
          rows: bundle.regions.map((row) => mk([row.name, formatCurrency(row.value), formatNumber(row.units), pct(row.share)])),
        };
      case "areas":
        return {
          columns: [{ header: "Area" }, { header: "Region" }, { header: "Value", numeric: true }, { header: "Units", numeric: true }, { header: "Share", numeric: true }],
          rows: bundle.areas.map((row) => mk([row.name, row.regionName, formatCurrency(row.value), formatNumber(row.units), pct(row.share)])),
        };
      case "customers":
        return {
          columns: [{ header: "Customer" }, { header: "Distributor" }, { header: "Value", numeric: true }, { header: "Units", numeric: true }, { header: "Share", numeric: true }],
          rows: (customers?.customers ?? []).map((row) => mk([row.name, row.distributorName, formatCurrency(row.value), formatNumber(row.units), pct(row.share)])),
        };
      default:
        return { columns: [], rows: [] };
    }
  }, [tab, bundle, customers]);

  return (
    <div className="space-y-5 p-4 sm:p-5 xl:p-6">
      <AdminPageHero
        actions={(
          <Link href="/sales-intelligence">
            <span className="inline-flex h-10 items-center gap-2 border border-white/20 bg-white/10 px-3 text-xs font-black text-white transition hover:bg-white/20">
              ← Dashboard
            </span>
          </Link>
        )}
        badges={(
          <>
            <AdminInsightChip tone="orange">{bundle.period ?? "No month"}</AdminInsightChip>
            {access.restrictedIncluded
              ? <AdminInsightChip tone="slate">Including Lacto Basic 1 &amp; 2</AdminInsightChip>
              : <AdminInsightChip tone="emerald">Restricted products excluded</AdminInsightChip>}
            {!access.canViewAllSales && access.lineNames.length > 0 && <AdminInsightChip>Line: {access.lineNames.join(", ")}</AdminInsightChip>}
          </>
        )}
        description="Condensed, scoped sales tables — searchable and exportable. Exports re-resolve your scope on the server, so they never include data you cannot see."
        eyebrow="Sales Intelligence"
        icon={<Search className="h-5 w-5" />}
        title="Sales Details"
      />

      <div className="flex flex-wrap gap-2 border border-[#E2E8F0] bg-white p-2">
        {TABS.map((entry) => (
          <button
            className={cn(
              "h-9 px-3 text-xs font-black transition",
              tab === entry.key ? "bg-[#0B0B0B] text-white" : "bg-[#F8FAFC] text-[#0F172A] hover:bg-[#F1F5F9]",
            )}
            key={entry.key}
            onClick={() => setTab(entry.key)}
            type="button"
          >
            {entry.label}
          </button>
        ))}
      </div>

      <AdminTableShell
        action={<SiExportButton includeRestricted={access.restrictedIncluded} period={bundle.period} table={tab} />}
        description="Scope and restricted-product rules apply to this table and its export."
        title={TABS.find((entry) => entry.key === tab)?.label ?? "Details"}
      >
        {tab === "customers" && customersLoading ? (
          <p className="px-5 py-10 text-center text-sm text-[#94A3B8]">Loading customers…</p>
        ) : (
          <FilterableTable columns={tableData.columns} rows={tableData.rows} />
        )}
      </AdminTableShell>
    </div>
  );
}
