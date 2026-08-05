"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Download } from "lucide-react";

import {
  PortalDesktopTable,
  PortalEmptyState,
  PortalFilterBar,
  PortalMetricCard,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
  portalInputClassName,
} from "@/components/employee-portal/portal-primitives";
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
  // Cancelled = withdrawn by its requester while held (audit F3).
  cancelled: "bg-zinc-100 text-zinc-600 ring-zinc-300",
};

const SCOPE_LABEL: Record<DirectOrderReportScope, string> = {
  all: "Company-wide (all direct orders)",
  hierarchy: "Your region / management line",
  own: "Your own direct orders",
};

const money = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "-" : `${Math.round(n).toLocaleString("en-US")}`;
const units = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "-" : Math.round(n).toLocaleString("en-US");

function StatusPill({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-wide ring-1 ${STATUS_TONE[status] ?? "bg-slate-50 text-slate-500 ring-slate-200"}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

type Col = {
  key: keyof DirectOrderReportRow;
  label: string;
  numeric?: boolean;
  render?: (row: DirectOrderReportRow) => ReactNode;
};

// Every field -- "do not minus even one field".
const COLUMNS: Col[] = [
  { key: "status", label: "Status", render: (r) => <StatusPill status={r.status} /> },
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
    render: (r) => (r.pharmacyPriceSnapshot == null ? "-" : money(r.pharmacyPriceSnapshot)),
  },
  { key: "salesValue", label: "Sales value", numeric: true, render: (r) => money(r.salesValue) },
  { key: "dealType", label: "Deal", render: (r) => (r.dealType === "discount" ? "Discount" : "Bonus") },
  { key: "discountPct", label: "Disc %", numeric: true, render: (r) => (r.discountPct == null ? "-" : `${r.discountPct}%`) },
  { key: "publicPriceSnapshot", label: "Public price", numeric: true, render: (r) => (r.publicPriceSnapshot == null ? "-" : money(r.publicPriceSnapshot)) },
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
  // Same rule as the admin report: on an APPROVED order a blank month means "signed off but not
  // in Source of Sales yet", which is a state, not a missing value. Only non-approved rows dash.
  {
    key: "salesMonth",
    label: "Sales month",
    render: (r) => (r.salesMonth ? r.salesMonth : r.status === "approved" ? "Not booked" : "-"),
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

// The fields shown by default on a mobile card -- the rest are one tap away via
// "Show all fields", so nothing is ever actually hidden, just progressively disclosed.
const MOBILE_KEY_FIELDS: Array<keyof DirectOrderReportRow> = [
  "requesterName",
  "qty",
  "bonus",
  "dealType",
  "pharmacyCode",
  "areaName",
  "regionName",
  "collectionDate",
  "activeStepLabel",
];

function cellValue(col: Col, row: DirectOrderReportRow): ReactNode {
  return col.render ? col.render(row) : String(row[col.key] ?? "-") || "-";
}

export function DirectOrderPortalReport({
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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // The same object the Export button posts, so the file and the metric cards below can only
  // ever describe one population.
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

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
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

  const keyFieldSet = new Set(MOBILE_KEY_FIELDS);
  const restColumns = COLUMNS.filter((col) => !keyFieldSet.has(col.key) && col.key !== "status" && col.key !== "productName" && col.key !== "salesValue" && col.key !== "line" && col.key !== "pharmacyName");

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <PortalMetricCard label="Rows" value={kpis.count.toLocaleString("en-US")} />
        <PortalMetricCard label="Pending" value={kpis.pending.toLocaleString("en-US")} accent="amber" />
        <PortalMetricCard label="Total value" value={`${money(kpis.totalValue)} EGP`} accent="slate" />
        <PortalMetricCard label="Approved value" value={`${money(kpis.approvedValue)} EGP`} accent="emerald" />
      </div>

      <PortalFilterBar title="Filters" countLabel={`Visibility: ${SCOPE_LABEL[scope]}`}>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search requester, product, pharmacy, area..."
              className={`${portalInputClassName} sm:max-w-xs`}
            />
            <button
              type="button"
              onClick={exportXlsx}
              disabled={exporting || filtered.length === 0}
              className="inline-flex h-10 items-center justify-center gap-2 rounded bg-orange-600 px-4 text-sm font-bold text-white transition hover:bg-orange-700 disabled:opacity-50"
            >
              <Download className="h-4 w-4" />
              {exporting ? "Exporting..." : "Export XLSX"}
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {DIRECT_ORDER_REPORT_STATUS_OPTIONS.map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => toggleStatus(option.key)}
                className={`rounded-full px-3 py-1.5 text-xs font-bold ring-1 transition ${
                  statusFilter.has(option.key) ? "bg-slate-900 text-white ring-slate-900" : "bg-white text-slate-600 ring-slate-300"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </PortalFilterBar>

      {error ? <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div> : null}

      <PortalResponsiveDataList
        items={filtered}
        getKey={(r) => r.id}
        empty={<PortalEmptyState title="No direct orders match your filters" message="Try clearing the search or status filters above." />}
        renderCard={(row) => {
          const isExpanded = expanded.has(row.id);
          return (
            <PortalRecordCard
              title={row.productName}
              meta={`${row.requesterName} - ${row.line} - ${row.pharmacyName}`}
              status={<span className="whitespace-nowrap text-sm font-black text-slate-950">{money(row.salesValue)} EGP</span>}
              accent={row.status === "approved" ? "emerald" : row.status === "rejected" ? "rose" : row.status === "pending_approval" ? "amber" : "slate"}
            >
              <div className="mb-2"><StatusPill status={row.status} /></div>
              <PortalRecordFields
                fields={MOBILE_KEY_FIELDS.map((key) => {
                  const col = COLUMNS.find((c) => c.key === key)!;
                  return { label: col.label, value: cellValue(col, row) };
                })}
              />
              {isExpanded ? (
                <div className="mt-2">
                  <PortalRecordFields fields={restColumns.map((col) => ({ label: col.label, value: cellValue(col, row) }))} />
                </div>
              ) : null}
              <button
                type="button"
                onClick={() => toggleExpanded(row.id)}
                className="mt-3 text-xs font-bold text-orange-600 hover:text-orange-700"
              >
                {isExpanded ? "Show fewer fields" : `Show all ${COLUMNS.length} fields`}
              </button>
            </PortalRecordCard>
          );
        }}
        renderTable={() => (
          <PortalDesktopTable minWidth="1180px">
            <thead className="bg-slate-900 text-white">
              <tr>
                {COLUMNS.map((col) => (
                  <th
                    key={String(col.key)}
                    onClick={() => toggleSort(col.key)}
                    className={`cursor-pointer whitespace-nowrap px-3 py-2 text-[11px] font-black uppercase tracking-wider ${col.numeric ? "text-right" : "text-left"}`}
                  >
                    {col.label}
                    {sortKey === col.key ? <span className="ml-1">{sortDir === "asc" ? "asc" : "desc"}</span> : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((row, index) => (
                <tr key={row.id} className={index % 2 ? "bg-slate-50" : "bg-white"}>
                  {COLUMNS.map((col) => (
                    <td key={String(col.key)} className={`whitespace-nowrap px-3 py-1.5 ${col.numeric ? "text-right tabular-nums" : "text-left"} text-slate-700`}>
                      {cellValue(col, row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </PortalDesktopTable>
        )}
      />
    </div>
  );
}
