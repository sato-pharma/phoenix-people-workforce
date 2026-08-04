"use client";

import { useMemo, useState } from "react";

import {
  DIRECT_ORDER_REPORT_STATUS_OPTIONS,
  filterDirectOrderReportRows,
} from "@/lib/direct-orders/report-filters";
import type { DirectOrderReportRow, DirectOrderReportScope } from "@/lib/direct-orders/types";

const STATUS_TONE: Record<string, string> = {
  approved: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  pending_approval: "bg-amber-50 text-amber-700 ring-amber-200",
  returned: "bg-sky-50 text-sky-700 ring-sky-200",
  rejected: "bg-rose-50 text-rose-700 ring-rose-200",
  reversed: "bg-slate-100 text-slate-600 ring-slate-200",
  draft: "bg-slate-50 text-slate-500 ring-slate-200",
  // Held = parked outside the approval flow until the pharmacy passes validation (spec B6).
  held: "bg-orange-50 text-orange-700 ring-orange-200",
  expired: "bg-slate-200 text-slate-500 ring-slate-300",
};

const SCOPE_LABEL: Record<DirectOrderReportScope, string> = {
  all: "Company-wide (all direct orders)",
  hierarchy: "Your region / management line",
  own: "Your own direct orders",
};

const money = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "—" : `${Math.round(n).toLocaleString("en-US")}`;
const units = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "—" : Math.round(n).toLocaleString("en-US");

type Col = {
  key: keyof DirectOrderReportRow;
  label: string;
  numeric?: boolean;
  render?: (row: DirectOrderReportRow) => React.ReactNode;
};

// Every field — "do not minus even one field".
const COLUMNS: Col[] = [
  { key: "status", label: "Status", render: (r) => (
      <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ring-1 ${STATUS_TONE[r.status] ?? "bg-slate-50 text-slate-500 ring-slate-200"}`}>
        {r.status.replace("_", " ")}
      </span>
    ) },
  { key: "requesterName", label: "Requester" },
  { key: "requesterHrId", label: "HR_ID" },
  { key: "requesterRole", label: "Role" },
  { key: "line", label: "Line" },
  { key: "productCode", label: "Prod code" },
  { key: "productName", label: "Product" },
  { key: "qty", label: "Qty", numeric: true, render: (r) => units(r.qty) },
  { key: "bonus", label: "Bonus", numeric: true, render: (r) => units(r.bonus) },
  {
    key: "pharmacyPriceSnapshot",
    label: "Pharmacy price",
    numeric: true,
    render: (r) => (r.pharmacyPriceSnapshot == null ? "—" : money(r.pharmacyPriceSnapshot)),
  },
  { key: "salesValue", label: "Sales value", numeric: true, render: (r) => money(r.salesValue) },
  { key: "dealType", label: "Deal", render: (r) => (r.dealType === "discount" ? "Discount" : "Bonus") },
  { key: "discountPct", label: "Disc %", numeric: true, render: (r) => (r.discountPct == null ? "—" : `${r.discountPct}%`) },
  { key: "publicPriceSnapshot", label: "Public price", numeric: true, render: (r) => (r.publicPriceSnapshot == null ? "—" : money(r.publicPriceSnapshot)) },
  { key: "bonusOverrideReason", label: "Bonus override" },
  { key: "pharmacyCode", label: "Pharmacy code" },
  { key: "pharmacyName", label: "Pharmacy" },
  { key: "pharmacyAddress", label: "Address" },
  { key: "brickName", label: "Brick" },
  { key: "brickId", label: "Brick code" },
  { key: "areaName", label: "Area" },
  { key: "areaCode", label: "Area code" },
  { key: "regionName", label: "Region" },
  { key: "regionCode", label: "Region code" },
  { key: "doctorName", label: "Doctor" },
  { key: "distributorCodesText", label: "Distributor codes" },
  { key: "collectionDate", label: "Collection date" },
  // An APPROVED order with no sales month is money that has been signed off but is not in
  // Source of Sales — a state someone has to act on, not an absent value. Rendering it as the
  // same "—" every other empty cell uses is what let it stay invisible. Non-approved rows are
  // not expected to carry a month, so those keep the neutral dash.
  {
    key: "salesMonth",
    label: "Sales month",
    render: (r) => (r.salesMonth ? r.salesMonth : r.status === "approved" ? "Not booked" : "—"),
  },
  { key: "paymentDate", label: "Payment date" },
  { key: "paidAmount", label: "Paid", numeric: true, render: (r) => money(r.paidAmount) },
  { key: "remainingAmount", label: "Remaining", numeric: true, render: (r) => money(r.remainingAmount) },
  { key: "marketingRequestId", label: "Marketing req" },
  { key: "reversalOfRequestId", label: "Reversal of" },
  { key: "reversedByRequestId", label: "Reversed by" },
  { key: "activeStepLabel", label: "Awaiting" },
  { key: "createdAt", label: "Created" },
  { key: "decidedAt", label: "Decided" },
];

function KpiCard({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
      <div className="text-[11px] font-black uppercase tracking-wider text-slate-400">{label}</div>
      <div className={`text-xl font-black ${tone ?? "text-slate-900"}`}>{value}</div>
    </div>
  );
}

export function DirectOrderReportWorkspace({
  rows,
  scope,
}: {
  rows: DirectOrderReportRow[];
  scope: DirectOrderReportScope;
}) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<keyof DirectOrderReportRow>("createdAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The same object the Export button posts, so the file and the KPI cards below can only ever
  // describe one population.
  const filters = useMemo(() => ({ search, statuses: [...statusFilter] }), [search, statusFilter]);

  const filtered = useMemo(() => {
    const out = filterDirectOrderReportRows(rows, filters);
    return [...out].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === "number" && typeof bv === "number") return sortDir === "asc" ? av - bv : bv - av;
      return sortDir === "asc"
        ? String(av ?? "").localeCompare(String(bv ?? ""))
        : String(bv ?? "").localeCompare(String(av ?? ""));
    });
  }, [rows, filters, sortKey, sortDir]);

  const kpis = useMemo(() => {
    const totalValue = filtered.reduce((s, r) => s + (r.salesValue || 0), 0);
    const approvedValue = filtered.filter((r) => r.status === "approved").reduce((s, r) => s + (r.salesValue || 0), 0);
    const pending = filtered.filter((r) => r.status === "pending_approval").length;
    return { count: filtered.length, totalValue, approvedValue, pending };
  }, [filtered]);

  // Deliberately measured on `rows`, NOT on `filtered`: this describes the viewer's whole
  // population, so narrowing the status chips cannot make the warning disappear. An approved
  // order with no sales month has been signed off but never reaches Source of Sales — the
  // month is Finance-owned and set per order, so until someone picks one the value is real,
  // committed, and absent from every sales number. Nothing else in the module says so.
  const unbooked = useMemo(() => {
    const orders = rows.filter((r) => r.status === "approved" && !r.salesMonth);
    return { count: orders.length, value: orders.reduce((s, r) => s + (r.salesValue || 0), 0) };
  }, [rows]);

  function toggleSort(key: keyof DirectOrderReportRow) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function toggleStatus(key: string) {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function exportXlsx() {
    setExporting(true);
    setError(null);
    try {
      const res = await fetch("/api/direct-orders/report/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The route re-loads its own rows, so the filter has to travel with the request —
        // without it the file answers a different question than the cards above it.
        body: JSON.stringify(filters),
        cache: "no-store",
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.message || "Export failed.");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "direct-orders-report.xlsx";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed.");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
          Visibility: <span className="text-slate-600">{SCOPE_LABEL[scope]}</span>
        </div>
        <button
          type="button"
          onClick={exportXlsx}
          disabled={exporting || filtered.length === 0}
          className="rounded-md bg-orange-600 px-4 py-2 text-sm font-bold text-white hover:bg-orange-700 disabled:opacity-50"
        >
          {exporting ? "Exporting…" : "Export XLSX"}
        </button>
      </div>

      {unbooked.count > 0 ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <div className="text-[11px] font-black uppercase tracking-wider text-amber-700">
            Approved, not booked into a sales month
          </div>
          <div className="mt-0.5 text-sm font-semibold text-amber-900">
            {unbooked.count.toLocaleString("en-US")}{" "}
            {unbooked.count === 1 ? "direct order" : "direct orders"} worth {money(unbooked.value)} EGP
            {" "}are approved but are not in Source of Sales yet. Finance sets the sales month on each
            order&apos;s own page.
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard label="Rows" value={kpis.count.toLocaleString("en-US")} />
        <KpiCard label="Pending" value={kpis.pending.toLocaleString("en-US")} tone="text-amber-600" />
        <KpiCard label="Total value" value={`${money(kpis.totalValue)} EGP`} />
        <KpiCard label="Approved value" value={`${money(kpis.approvedValue)} EGP`} tone="text-emerald-600" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search requester, product, pharmacy, area…"
          className="w-72 rounded-md border border-slate-300 px-3 py-1.5 text-sm"
        />
        {DIRECT_ORDER_REPORT_STATUS_OPTIONS.map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={() => toggleStatus(option.key)}
            className={`rounded-full px-3 py-1 text-xs font-bold ring-1 ${
              statusFilter.has(option.key) ? "bg-slate-900 text-white ring-slate-900" : "bg-white text-slate-600 ring-slate-300"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {error ? <div className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div> : null}

      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="min-w-full border-collapse text-left text-sm">
          <thead className="bg-slate-900 text-white">
            <tr>
              {COLUMNS.map((col) => (
                <th
                  key={String(col.key)}
                  onClick={() => toggleSort(col.key)}
                  className={`cursor-pointer whitespace-nowrap px-3 py-2 text-[11px] font-black uppercase tracking-wider ${
                    col.numeric ? "text-right" : "text-left"
                  }`}
                >
                  {col.label}
                  {sortKey === col.key ? <span className="ml-1">{sortDir === "asc" ? "▲" : "▼"}</span> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((row, index) => (
              <tr key={row.id} className={index % 2 ? "bg-slate-50" : "bg-white"}>
                {COLUMNS.map((col) => (
                  <td
                    key={String(col.key)}
                    className={`whitespace-nowrap px-3 py-1.5 ${col.numeric ? "text-right tabular-nums" : "text-left"} text-slate-700`}
                  >
                    {col.render ? col.render(row) : String(row[col.key] ?? "—") || "—"}
                  </td>
                ))}
              </tr>
            ))}
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS.length} className="px-3 py-8 text-center text-slate-400">
                  No direct orders match your filters.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
