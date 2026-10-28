"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { DirectOrderStatusPill } from "@/components/direct-orders/direct-order-status-pill";
import {
  DIRECT_ORDER_REPORT_STATUS_OPTIONS,
  filterDirectOrderReportRows,
} from "@/lib/direct-orders/report-filters";
import { showsAwaitingFinanceMonth } from "@/lib/direct-orders/types";
import type { DirectOrderReportRow, DirectOrderReportScope } from "@/lib/direct-orders/types";
import {
  PortalDesktopTable,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import { phxFieldClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";
import { adminPanelHeaderClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

// The shell this report was opened in, so a row's link stays inside it.
//
// This was a hardcoded "/admin/direct-orders" const, above a comment claiming the report is
// "mounted only by app/(admin)/…". That has not been true since the consolidation:
// app/employee-portals/direct-orders/report/page.tsx mounts the same component, so every District /
// Regional / National Sales / Product Manager clicking a row was sent into the ADMIN shell. It
// worked — the admin detail page redirects portal-mode viewers back — but it cost a server round
// trip and a flash of the wrong chrome to reach the page they should have gone to directly.
//
// It matters that every row can reach the detail: that page is the ONLY place
// DirectOrderSalesMonthControl renders, and booking an approved order into a sales month is
// Finance's job (canSetDirectOrderSalesMonth).
const DEFAULT_DETAIL_BASE = "/admin/direct-orders";

// The local STATUS_TONE map that used to live here is gone (2026-08-12). Its values were
// byte-identical to RING_TONE in direct-order-status-pill.tsx, and it rendered the raw database
// value via `r.status.replace("_", " ")` — so it printed "approved" for a row this very table's
// own Sales month column was simultaneously labelling "Not booked". Same row, two answers.
//
// DirectOrderStatusPill with variant="ring" reproduces this table's styling exactly and adds what
// the copy had dropped: the shared vocabulary from status-labels.ts, and showsAwaitingFinanceMonth,
// which splits `approved` into Completed vs Waiting for Finance depending on the sales month.
const SCOPE_LABEL: Record<DirectOrderReportScope, string> = {
  all: "Company-wide (all direct orders)",
  hierarchy: "Your region / management line",
  line: "Your product line, every region",
  own: "Your own direct orders",
};

const money = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "—" : `${Math.round(n).toLocaleString("en-US")}`;
const units = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "—" : Math.round(n).toLocaleString("en-US");

type Fact = { label: string; value: React.ReactNode };

/**
 * One on-screen column. The report carries every field ("do not minus even one field"), but a
 * 36-column grid cannot fit a screen, so related facts share a cell — the requester with their
 * role and line, the venue with its address and doctor, the money with what was paid. Each fact is
 * said once. The same `facts` feed the phone card, so the table and the cards cannot disagree.
 * Raw codes and ids (HR id, product, venue, brick, area and region codes, linked request ids,
 * distributor customer codes) are not printed here; the spreadsheet export still carries them.
 */
type Col = {
  key: keyof DirectOrderReportRow;
  label: string;
  width: string;
  facts: (row: DirectOrderReportRow) => Fact[];
};

const has = (value: unknown): boolean => value != null && String(value).trim() !== "";

const COLUMNS: Col[] = [
  {
    key: "status",
    label: "Status",
    width: "w-[14%]",
    facts: (r) => [
      { label: "", value: <DirectOrderStatusPill status={r.status} salesMonth={r.salesMonth} variant="ring" /> },
      ...(has(r.activeStepLabel) ? [{ label: "Awaiting", value: r.activeStepLabel }] : []),
    ],
  },
  {
    key: "requesterName",
    label: "Requester",
    width: "w-[12%]",
    facts: (r) => [
      { label: "", value: r.requesterName },
      ...(has(r.requesterRole) ? [{ label: "", value: r.requesterRole }] : []),
      ...(has(r.line) ? [{ label: "Line", value: r.line }] : []),
    ],
  },
  {
    key: "pharmacyName",
    label: "Venue",
    width: "w-[16%]",
    facts: (r) => [
      { label: "", value: r.pharmacyName },
      ...(has(r.pharmacyAddress) ? [{ label: "Address", value: r.pharmacyAddress }] : []),
      ...(has(r.doctorName) ? [{ label: "Doctor", value: r.doctorName }] : []),
    ],
  },
  {
    key: "areaName",
    label: "Place",
    width: "w-[11%]",
    facts: (r) => [
      { label: "Brick", value: has(r.brickName) ? r.brickName : "—" },
      { label: "Area", value: has(r.areaName) ? r.areaName : "—" },
      { label: "Region", value: has(r.regionName) ? r.regionName : "—" },
    ],
  },
  {
    key: "productName",
    label: "Product",
    width: "w-[14%]",
    facts: (r) => [
      { label: "", value: r.productName },
      { label: "Deal", value: r.dealType === "discount" ? `Discount ${r.discountPct == null ? "—" : `${r.discountPct}%`}` : "Bonus" },
      ...(has(r.bonusOverrideReason) ? [{ label: "Bonus override", value: r.bonusOverrideReason }] : []),
    ],
  },
  {
    key: "qty",
    label: "Units and price",
    width: "w-[12%]",
    // A basket prints its units per product ("72 + 24"), never a sum — the same text the xlsx and the
    // live sheet carry in these two columns.
    facts: (r) => [
      { label: "Qty", value: r.basketUnits?.qty ?? units(r.qty) },
      { label: "Bonus", value: r.basketUnits?.bonus ?? units(r.bonus) },
      { label: "Pharmacy price", value: r.pharmacyPriceSnapshot == null ? "—" : money(r.pharmacyPriceSnapshot) },
      { label: "Public price", value: r.publicPriceSnapshot == null ? "—" : money(r.publicPriceSnapshot) },
    ],
  },
  {
    key: "salesValue",
    label: "Value",
    width: "w-[9%]",
    facts: (r) => [
      { label: "Sales value", value: money(r.salesValue) },
      { label: "Paid", value: money(r.paidAmount) },
      { label: "Remaining", value: money(r.remainingAmount) },
    ],
  },
  {
    key: "createdAt",
    label: "Dates",
    width: "w-[12%]",
    facts: (r) => [
      { label: "Created", value: cairoDateTime(r.createdAt) },
      ...(has(r.decidedAt) ? [{ label: "Decided", value: cairoDateTime(r.decidedAt) }] : []),
      ...(has(r.collectionDate) ? [{ label: "Collection", value: r.collectionDate }] : []),
      ...(has(r.paymentDate) ? [{ label: "Payment", value: r.paymentDate }] : []),
      // An APPROVED order with no sales month is money that has been signed off but is not in
      // Source of Sales — a state someone has to act on, not an absent value. Rendering it as the
      // same "—" every other empty cell uses is what let it stay invisible. Non-approved rows are
      // not expected to carry a month, so those keep the neutral dash.
      { label: "Sales month", value: r.salesMonth ? r.salesMonth : r.status === "approved" ? "Not booked" : "—" },
    ],
  },
];

function FactLines({ facts }: { facts: Fact[] }) {
  return (
    <>
      {facts.map((fact, index) => (
        <p className={index === 0 && !fact.label ? "font-semibold text-slate-900" : "text-phx-sm"} key={index}>
          {fact.label ? <span className="text-slate-400">{fact.label} </span> : null}
          {fact.value}
        </p>
      ))}
    </>
  );
}

function KpiCard({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className={`rounded-lg border border-slate-200 bg-white px-4 py-3 ${adminSoftDepthClassName}`}>
      <div className="text-phx-xs font-black uppercase tracking-wider text-slate-400">{label}</div>
      <div className={`text-xl font-black ${tone ?? "text-slate-900"}`}>{value}</div>
    </div>
  );
}

export function DirectOrderReportWorkspace({
  rows,
  scope,
  initialUnbookedOnly = false,
  detailBasePath = DEFAULT_DETAIL_BASE,
}: {
  rows: DirectOrderReportRow[];
  scope: DirectOrderReportScope;
  /** The mounting shell's Direct Orders base, so a row opens in the shell the reader is already in. */
  detailBasePath?: string;
  /**
   * Deep-link default, read from `?unbooked=1` by the page (a server component) rather than by
   * useSearchParams here — that would put this whole workspace behind a Suspense boundary for one
   * boolean. Set by the Finance Manager's two routes into this page: the sidebar badge and the
   * "Direct orders awaiting a sales month" row on his command center, so both land him on exactly
   * the orders he has to act on instead of all 24 with the answer somewhere inside.
   */
  initialUnbookedOnly?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set());
  const [unbookedOnly, setUnbookedOnly] = useState(initialUnbookedOnly);
  const [sortKey, setSortKey] = useState<keyof DirectOrderReportRow>("createdAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The same object the Export button posts, so the file and the KPI cards below can only ever
  // describe one population.
  const filters = useMemo(
    () => ({ search, statuses: [...statusFilter], unbookedOnly }),
    [search, statusFilter, unbookedOnly],
  );

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
    const orders = rows.filter((r) => showsAwaitingFinanceMonth(r.status, r.salesMonth));
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
        <div className="text-phx-xs font-bold uppercase tracking-wider text-slate-400">
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
          <div className="text-phx-xs font-black uppercase tracking-wider text-amber-700">
            Approved, not booked into a sales month
          </div>
          <div className="mt-0.5 text-sm font-semibold text-amber-900">
            {unbooked.count.toLocaleString("en-US")}{" "}
            {unbooked.count === 1 ? "direct order" : "direct orders"} worth {money(unbooked.value)} EGP
            {" "}are approved but are not in Source of Sales yet. Finance sets the sales month on each
            order&apos;s own page — use the Book month link on its row.
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
          className={cn(phxFieldClassName, "w-72")}
        />
        {/* Finance's own slice, and the reason this control exists: booking approved orders into a
            sales month is one person's entire job here, and until now it was the one question this
            report could not be asked. Same chip geometry as the status chips beside it — a
            square-cornered one-off next to nine rounded ones would read as a rendering fault — but
            amber rather than slate when active, because it narrows on a DIFFERENT axis than status
            and composes with them rather than replacing them. Amber matches the unbooked banner
            already sitting above these chips.

            Placed before the status chips and separated by a rule: it is the first question asked
            of this report far more often than any single status is. */}
        <button
          type="button"
          onClick={() => setUnbookedOnly((prev) => !prev)}
          aria-pressed={unbookedOnly}
          className={`rounded-full px-3 py-1 text-xs font-bold ring-1 ${
            unbookedOnly ? "bg-amber-500 text-white ring-amber-500" : "bg-white text-amber-700 ring-amber-300"
          }`}
        >
          Awaiting month
        </button>
        <span aria-hidden="true" className="mx-1 h-5 w-px bg-slate-200" />
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

      <PortalResponsiveDataList
        empty={<p className="border border-slate-200 px-3 py-8 text-center text-slate-400">No direct orders match your filters.</p>}
        getKey={(row) => row.id}
        items={filtered}
        renderCard={(row) => (
          <PortalRecordCard
            actions={
              <Link
                className="font-bold text-orange-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
                href={`${detailBasePath}/${row.id}`}
              >
                {showsAwaitingFinanceMonth(row.status, row.salesMonth) ? "Book month" : "View"}
              </Link>
            }
            meta={[row.requesterName, row.requesterRole].filter(has).join(" · ")}
            status={<DirectOrderStatusPill status={row.status} salesMonth={row.salesMonth} variant="ring" />}
            title={row.pharmacyName}
          >
            <PortalRecordFields
              fields={COLUMNS.flatMap((col) =>
                col.facts(row)
                  // The unlabelled lines are the card's title, meta and status; only the product's
                  // own name has no other home on the card.
                  .filter((fact) => fact.label || col.key === "productName")
                  .map((fact) => ({ label: fact.label || "Product", value: fact.value })),
              )}
            />
          </PortalRecordCard>
        )}
        renderTable={() => (
          <PortalDesktopTable
            cols={
              <colgroup>
                {COLUMNS.map((col) => (
                  <col className={col.width} key={String(col.key)} />
                ))}
              </colgroup>
            }
          >
            <thead className={`${adminPanelHeaderClassName} text-white`}>
              <tr>
                {COLUMNS.map((col) => (
                  <th
                    key={String(col.key)}
                    onClick={() => toggleSort(col.key)}
                    className="cursor-pointer px-3 py-2 text-left text-phx-xs font-black uppercase tracking-wider"
                  >
                    {col.label}
                    {sortKey === col.key ? <span className="ml-1">{sortDir === "asc" ? "▲" : "▼"}</span> : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((row, index) => (
                <tr key={row.id} className={cn("align-top", index % 2 ? "bg-slate-50" : "bg-white")}>
                  {COLUMNS.map((col) => (
                    <td className="break-words px-3 py-1.5 text-left text-slate-700" key={String(col.key)}>
                      <FactLines facts={col.facts(row)} />
                      {col.key === "status" ? (
                        <p>
                          <Link
                            className="font-bold text-orange-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
                            href={`${detailBasePath}/${row.id}`}
                          >
                            {showsAwaitingFinanceMonth(row.status, row.salesMonth) ? "Book month" : "View"}
                          </Link>
                        </p>
                      ) : null}
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
