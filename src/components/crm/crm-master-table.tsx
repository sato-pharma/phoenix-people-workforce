"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Braces, ChevronLeft, ChevronRight, Database, Search } from "lucide-react";

import type { CrmMasterColumn, CrmMasterData, CrmMasterDataset, CrmMasterRow } from "@/lib/crm/master";
import type { VisitsSyncRun } from "@/lib/visits-report/types";

function formatCairo(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(date);
}

/** Faithful cell rendering — shows the value exactly as stored (this is a raw-mirror view), only
 * mapping null/undefined to a dash. Coordinates keep full precision. */
function renderCell(value: unknown, kind: CrmMasterColumn["kind"]): string {
  if (value === null || value === undefined || value === "") return "—";
  if (kind === "coord" && typeof value === "number") return String(value);
  return String(value);
}

export function CrmMasterTable({ data }: { data: CrmMasterData }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [searchText, setSearchText] = useState(data.search ?? "");
  const [fromText, setFromText] = useState(data.dateFrom ?? "");
  const [toText, setToText] = useState(data.dateTo ?? "");

  const totalPages = Math.max(1, Math.ceil(data.totalCount / data.pageSize));
  const rangeStart = data.totalCount === 0 ? 0 : (data.page - 1) * data.pageSize + 1;
  const rangeEnd = Math.min(data.page * data.pageSize, data.totalCount);
  const lastSuccess = data.latestSyncRuns.find((run: VisitsSyncRun) => run.status === "success") ?? null;

  function navigate(next: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value === null || value === "") params.delete(key);
      else params.set(key, value);
    }
    router.push(`${pathname}?${params.toString()}`);
  }

  function switchDataset(dataset: CrmMasterDataset) {
    if (dataset === data.dataset) return;
    // Reset page + free-text filters that don't map across datasets; keep date range.
    navigate({ dataset, page: null, search: null });
  }

  function applyFilters() {
    navigate({ dateFrom: fromText || null, dateTo: toText || null, page: null, search: searchText || null });
  }

  function resetFilters() {
    setSearchText("");
    setFromText("");
    setToText("");
    navigate({ dateFrom: null, dateTo: null, page: null, search: null });
  }

  function toggleRaw(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const datasets: Array<{ id: CrmMasterDataset; label: string }> = [
    { id: "visits", label: "Visits" },
    { id: "checkins", label: "Check-ins" },
  ];

  return (
    <div className="space-y-4">
      {/* Dataset toggle + freshness */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex overflow-hidden border border-slate-200">
          {datasets.map((ds) => (
            <button
              className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-bold transition ${
                ds.id === data.dataset
                  ? "bg-orange-600 text-white"
                  : "bg-white text-slate-600 hover:bg-slate-50"
              }`}
              key={ds.id}
              onClick={() => switchDataset(ds.id)}
              type="button"
            >
              <Database aria-hidden="true" className="h-3.5 w-3.5" />
              {ds.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-slate-500">
          Last successful sync: <span className="font-semibold text-slate-700">{formatCairo(lastSuccess?.completedAt ?? null)}</span>
          {lastSuccess ? <span className="text-slate-400"> (Cairo)</span> : null}
          {!data.configured ? <span className="ml-2 text-amber-700">· iReports360 not configured</span> : null}
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 border border-slate-200 bg-white p-4">
        <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          From
          <input
            className="border border-slate-200 px-2 py-1.5 text-sm text-slate-800 focus:border-orange-400 focus:outline-none"
            onChange={(event) => setFromText(event.target.value)}
            type="date"
            value={fromText}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          To
          <input
            className="border border-slate-200 px-2 py-1.5 text-sm text-slate-800 focus:border-orange-400 focus:outline-none"
            onChange={(event) => setToText(event.target.value)}
            type="date"
            value={toText}
          />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Search
          <div className="flex items-center gap-2 border border-slate-200 px-2 py-1.5 focus-within:border-orange-400">
            <Search aria-hidden="true" className="h-4 w-4 text-slate-400" />
            <input
              className="w-full text-sm text-slate-800 focus:outline-none"
              onChange={(event) => setSearchText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") applyFilters();
              }}
              placeholder={data.dataset === "checkins" ? "Agent HR ID, contact, address…" : "Agent, contact, customer, comment, HR ID…"}
              type="search"
              value={searchText}
            />
          </div>
        </label>
        <button
          className="bg-orange-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-orange-700"
          onClick={applyFilters}
          type="button"
        >
          Apply
        </button>
        <button
          className="border border-slate-200 px-4 py-2 text-xs font-bold text-slate-600 transition hover:bg-slate-50"
          onClick={resetFilters}
          type="button"
        >
          Reset
        </button>
      </div>

      {/* Count + pagination header */}
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
        <p>
          <span className="font-bold text-slate-900">{data.totalCount.toLocaleString()}</span>{" "}
          {data.dataset === "checkins" ? "check-in" : "visit"} records
          {data.totalCount > 0 ? <span className="text-slate-400"> · showing {rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()}</span> : null}
        </p>
        <div className="flex items-center gap-2">
          <button
            className="inline-flex items-center gap-1 border border-slate-200 px-2 py-1 font-semibold text-slate-600 transition enabled:hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={data.page <= 1}
            onClick={() => navigate({ page: String(data.page - 1) })}
            type="button"
          >
            <ChevronLeft aria-hidden="true" className="h-4 w-4" />
            Prev
          </button>
          <span className="tabular-nums text-slate-500">
            Page {data.page.toLocaleString()} / {totalPages.toLocaleString()}
          </span>
          <button
            className="inline-flex items-center gap-1 border border-slate-200 px-2 py-1 font-semibold text-slate-600 transition enabled:hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={data.page >= totalPages}
            onClick={() => navigate({ page: String(data.page + 1) })}
            type="button"
          >
            Next
            <ChevronRight aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Master table */}
      <div className="overflow-x-auto border border-slate-200 bg-white">
        {!data.schemaReady ? (
          <p className="px-5 py-8 text-center text-sm text-slate-500">
            The iReports360 mirror is not set up yet — no CRM data to show.
          </p>
        ) : data.rows.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-slate-500">No records match the current filters.</p>
        ) : (
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                <th className="whitespace-nowrap px-3 py-2 font-semibold">Raw</th>
                {data.columns.map((col) => (
                  <th className="whitespace-nowrap px-3 py-2 font-semibold" key={col.key}>
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row: CrmMasterRow) => {
                const isOpen = expanded.has(row.id);
                return (
                  <RowGroup
                    columns={data.columns}
                    isOpen={isOpen}
                    key={row.id}
                    onToggle={() => toggleRaw(row.id)}
                    row={row}
                  />
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function RowGroup({
  columns,
  isOpen,
  onToggle,
  row,
}: {
  columns: readonly CrmMasterColumn[];
  isOpen: boolean;
  onToggle: () => void;
  row: CrmMasterRow;
}) {
  return (
    <>
      <tr className="border-b border-slate-100 text-slate-700 hover:bg-orange-50/40">
        <td className="whitespace-nowrap px-3 py-2">
          <button
            aria-expanded={isOpen}
            className={`inline-flex items-center gap-1 border px-2 py-1 text-[11px] font-bold transition ${
              isOpen ? "border-orange-400 bg-orange-50 text-orange-700" : "border-slate-200 text-slate-500 hover:bg-slate-50"
            }`}
            onClick={onToggle}
            type="button"
          >
            <Braces aria-hidden="true" className="h-3.5 w-3.5" />
            {isOpen ? "Hide" : "JSON"}
          </button>
        </td>
        {columns.map((col) => (
          <td className="whitespace-nowrap px-3 py-2" key={col.key}>
            {renderCell(row[col.key], col.kind)}
          </td>
        ))}
      </tr>
      {isOpen ? (
        <tr className="border-b border-slate-100 bg-slate-950">
          <td className="p-0" colSpan={columns.length + 1}>
            <pre className="max-h-96 overflow-auto px-4 py-3 text-[11px] leading-5 text-emerald-200">
              {JSON.stringify(row.raw_payload ?? {}, null, 2)}
            </pre>
          </td>
        </tr>
      ) : null}
    </>
  );
}
