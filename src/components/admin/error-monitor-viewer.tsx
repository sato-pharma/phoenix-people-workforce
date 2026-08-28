"use client";

import { ChevronLeft, ChevronRight, Loader2, Search, X } from "lucide-react";
import { useState } from "react";

import { SearchableSelect } from "@/components/ui/searchable-select";
import type { ErrorEventFilter, ErrorEventPage } from "@/lib/error-monitor/service";

const SOURCES = ["all", "server", "client"];

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleString("en-GB", {
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      month: "short",
      second: "2-digit",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

function buildQueryString(filters: ErrorEventFilter, page: number) {
  const params = new URLSearchParams();
  if (filters.hrId) params.set("hrId", filters.hrId);
  if (filters.moduleKey) params.set("module", filters.moduleKey);
  if (filters.source) params.set("source", filters.source);
  if (filters.dateFrom) params.set("dateFrom", filters.dateFrom);
  if (filters.dateTo) params.set("dateTo", filters.dateTo);
  params.set("page", String(page));
  params.set("pageSize", "50");
  return params.toString();
}

export function ErrorMonitorViewer({
  initialData,
  initialFilters,
}: {
  initialData: ErrorEventPage;
  initialFilters: ErrorEventFilter;
}) {
  const [data, setData] = useState<ErrorEventPage>(initialData);
  const [isLoading, setIsLoading] = useState(false);
  const [draftFilters, setDraftFilters] = useState<ErrorEventFilter>(initialFilters);
  const [appliedFilters, setAppliedFilters] = useState<ErrorEventFilter>(initialFilters);
  const [currentPage, setCurrentPage] = useState(initialData.page);

  async function fetchEvents(filters: ErrorEventFilter, page: number) {
    setIsLoading(true);
    try {
      const res = await fetch(`/api/admin/errors?${buildQueryString(filters, page)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { message?: string } | null;
        throw new Error(body?.message ?? "Failed to fetch error events");
      }
      const result = await res.json() as ErrorEventPage;
      setData(result);
      setCurrentPage(page);
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  }

  function handleApply() {
    setAppliedFilters(draftFilters);
    fetchEvents(draftFilters, 1);
  }

  function handleClear() {
    const empty: ErrorEventFilter = {};
    setDraftFilters(empty);
    setAppliedFilters(empty);
    fetchEvents(empty, 1);
  }

  function handlePage(page: number) {
    fetchEvents(appliedFilters, page);
  }

  const from = data.total === 0 ? 0 : (currentPage - 1) * data.pageSize + 1;
  const to = Math.min(currentPage * data.pageSize, data.total);

  return (
    <div className="space-y-5">
      <div className="rounded-3xl border border-phx-line bg-white/95 p-5 shadow-[0_18px_42px_rgba(15,23,42,0.07)]">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <p className="flex items-center gap-2 text-sm font-black uppercase tracking-[0.16em] text-slate-700">
              <span className="h-2 w-2 rounded-full bg-phx-accent" />
              Error Filters
            </p>
            <p className="mt-1 text-xs text-slate-500">Search by HR ID, module, source, or date window.</p>
          </div>
          <div className="rounded-full border border-phx-line bg-phx-paper px-3 py-1.5 text-xs font-black text-phx-ink-soft">
            {data.total.toLocaleString("en-US")} events
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-phx-ink-soft" />
            <input
              className="h-10 w-full rounded-xl border border-phx-line bg-phx-paper pl-8 pr-3 text-xs font-semibold text-phx-ink placeholder:text-phx-ink-soft focus:outline-none focus:ring-2 focus:ring-phx-accent/30"
              onChange={(e) => setDraftFilters((f) => ({ ...f, hrId: e.target.value || null }))}
              placeholder="HR ID..."
              value={draftFilters.hrId ?? ""}
            />
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-phx-ink-soft" />
            <input
              className="h-10 w-full rounded-xl border border-phx-line bg-phx-paper pl-8 pr-3 text-xs font-semibold text-phx-ink placeholder:text-phx-ink-soft focus:outline-none focus:ring-2 focus:ring-phx-accent/30"
              onChange={(e) => setDraftFilters((f) => ({ ...f, moduleKey: e.target.value || null }))}
              placeholder="Module..."
              value={draftFilters.moduleKey ?? ""}
            />
          </div>
          <SearchableSelect
            className="h-10 rounded-xl border border-phx-line bg-phx-paper px-3 text-xs font-semibold text-phx-ink focus:outline-none focus:ring-2 focus:ring-phx-accent/30"
            onChange={(e) => setDraftFilters((f) => ({ ...f, source: e.target.value === "all" ? null : (e.target.value as "server" | "client") }))}
            value={draftFilters.source ?? "all"}
          >
            {SOURCES.map((s) => (
              <option key={s} value={s}>{s === "all" ? "All sources" : s === "server" ? "Server" : "Client"}</option>
            ))}
          </SearchableSelect>
          <input
            className="h-10 rounded-xl border border-phx-line bg-phx-paper px-3 text-xs font-semibold text-phx-ink focus:outline-none focus:ring-2 focus:ring-phx-accent/30"
            onChange={(e) => setDraftFilters((f) => ({ ...f, dateFrom: e.target.value || null }))}
            type="date"
            value={draftFilters.dateFrom ?? ""}
          />
          <input
            className="h-10 rounded-xl border border-phx-line bg-phx-paper px-3 text-xs font-semibold text-phx-ink focus:outline-none focus:ring-2 focus:ring-phx-accent/30"
            onChange={(e) => setDraftFilters((f) => ({ ...f, dateTo: e.target.value || null }))}
            type="date"
            value={draftFilters.dateTo ?? ""}
          />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            className="flex h-9 items-center gap-1.5 rounded-xl bg-[#0B0B0B] px-4 text-xs font-black text-white shadow-[0_12px_26px_rgba(15,23,42,0.18)] transition hover:bg-phx-accent disabled:opacity-50"
            disabled={isLoading}
            onClick={handleApply}
            type="button"
          >
            {isLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
            Apply Filters
          </button>
          <button
            className="flex h-9 items-center gap-1.5 rounded-xl border border-phx-line bg-white px-3 text-xs font-black text-phx-ink-soft transition hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700"
            onClick={handleClear}
            type="button"
          >
            <X className="h-3.5 w-3.5" />
            Clear
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-3xl border border-phx-line bg-white/95 shadow-[0_18px_42px_rgba(15,23,42,0.07)]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1000px]">
            <thead>
              <tr className="border-b border-phx-line bg-phx-paper">
                {["Time", "HR ID", "Role", "Module", "Source", "Message", "Route"].map((h) => (
                  <th
                    className="px-5 py-4 text-left text-phx-2xs font-black uppercase tracking-widest text-phx-ink-soft"
                    key={h}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-phx-paper-2">
              {isLoading ? (
                <tr>
                  <td className="px-5 py-8 text-center text-sm text-phx-ink-soft" colSpan={7}>
                    <Loader2 className="mx-auto h-5 w-5 animate-spin text-phx-accent" />
                  </td>
                </tr>
              ) : data.events.length === 0 ? (
                <tr>
                  <td className="px-5 py-8 text-center text-sm text-phx-ink-soft" colSpan={7}>
                    No error events found.
                  </td>
                </tr>
              ) : (
                data.events.map((event) => (
                  <tr className="transition-colors hover:bg-orange-50/35" key={event.id}>
                    <td className="whitespace-nowrap px-5 py-4 font-mono text-xs font-semibold text-phx-ink-soft">
                      {formatDate(event.createdAt)}
                    </td>
                    <td className="whitespace-nowrap px-5 py-4 text-sm font-bold text-phx-ink">
                      {event.hrId ?? "Guest"}
                    </td>
                    <td className="px-5 py-4 text-sm text-phx-ink-soft">{event.role ?? "-"}</td>
                    <td className="px-5 py-4">
                      <span className="inline-flex items-center rounded-full bg-phx-warn-bg px-2.5 py-1 text-phx-xs font-bold text-phx-warn ring-1 ring-phx-warn-line">
                        {event.moduleLabel}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-sm text-phx-ink-soft">{event.source}</td>
                    <td className="max-w-lg px-5 py-4 text-sm font-medium text-phx-ink">
                      <span className="line-clamp-2">{event.message}</span>
                    </td>
                    <td className="max-w-xs px-5 py-4 font-mono text-xs text-phx-ink-soft">
                      <span className="line-clamp-1">{event.route ?? "-"}</span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {data.pageCount > 1 && (
          <div className="flex items-center justify-between border-t border-phx-line bg-phx-paper/80 px-5 py-3">
            <span className="text-xs font-semibold text-phx-ink-soft">
              {from}-{to} of {data.total} events
            </span>
            <div className="flex items-center gap-1">
              <button
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-phx-line-strong bg-white text-phx-ink-soft shadow-sm transition hover:border-orange-300 hover:bg-orange-50 hover:text-orange-600 disabled:opacity-40"
                disabled={currentPage === 1 || isLoading}
                onClick={() => handlePage(currentPage - 1)}
                type="button"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="px-2 text-xs font-semibold text-phx-ink">
                {currentPage} / {data.pageCount}
              </span>
              <button
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-phx-line-strong bg-white text-phx-ink-soft shadow-sm transition hover:border-orange-300 hover:bg-orange-50 hover:text-orange-600 disabled:opacity-40"
                disabled={currentPage === data.pageCount || isLoading}
                onClick={() => handlePage(currentPage + 1)}
                type="button"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
