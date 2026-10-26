"use client";

import { ChevronLeft, ChevronRight, Download, Loader2, Search, X } from "lucide-react";
import { useState } from "react";

import type { AuditLogFilter, AuditLogPage } from "@/lib/admin/audit";
import { AUDIT_ENTITY_TYPES } from "@/lib/admin/audit-entity-types";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { PHOENIX_BUSINESS_TIME_ZONE } from "@/lib/i18n/format";
import { formatStableEnGb } from "@/lib/format/cairo-datetime";
import { CSV_BOM, csvLine } from "@/lib/export/spreadsheet-safe";
import { phxFieldClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";


// Every audit entity type there is, and the reason it is not a list typed out here.
//
// 🔴 THIS WAS A HAND-KEPT SHORTLIST OF TEN AND IT WAS WRONG IN BOTH DIRECTIONS. Production
// wrote 88 distinct entity types in 30 days, so ~78 kinds of trail could be reached only by
// paging "all" — ~2,456 rows a day (measured 2026-09-30), which puts an hour-old row a hundred
// deep and yesterday's in the thousands. Three of the ten it DID offer had not been written in
// 30 days. The API behind this select always took any entity type; nothing underneath was
// broken. A trail nobody can select is simply a trail nobody reads.
//
// The list now comes from the catalogue itself, where a `Record<AuditEntityType, true>` makes
// the compiler refuse a missing or invented name — so a new audited feature reaches this screen
// by existing, never by somebody remembering. `AUDIT_ENTITY_TYPES` is already sorted.
//
// Owner-authorised 2026-09-30 ("derive the audit log picker from the catalogue"), after the CV
// Lookup pair had to be added by hand — which is what exposed the shape of the problem. Pinned
// by tests/audit-entity-types.test.ts and tests/cv-lookup.test.ts.
const ENTITY_TYPES = ["all", ...AUDIT_ENTITY_TYPES];

function formatDate(iso: string) {
  try {
    return formatStableEnGb(new Date(iso), {
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      month: "short",
      second: "2-digit",
      year: "numeric",
      timeZone: PHOENIX_BUSINESS_TIME_ZONE,
    });
  } catch {
    return iso;
  }
}

function buildQueryString(filters: AuditLogFilter, page: number) {
  const params = new URLSearchParams();
  if (filters.actor) params.set("actor", filters.actor);
  if (filters.action) params.set("action", filters.action);
  if (filters.entityType) params.set("entityType", filters.entityType);
  if (filters.dateFrom) params.set("dateFrom", filters.dateFrom);
  if (filters.dateTo) params.set("dateTo", filters.dateTo);
  params.set("page", String(page));
  params.set("pageSize", "50");
  return params.toString();
}

export function AuditLogViewer({
  initialData,
  initialFilters,
}: {
  initialData: AuditLogPage;
  initialFilters: AuditLogFilter;
}) {
  const [data, setData] = useState<AuditLogPage>(initialData);
  const [isLoading, setIsLoading] = useState(false);
  const [draftFilters, setDraftFilters] = useState<AuditLogFilter>(initialFilters);
  const [appliedFilters, setAppliedFilters] = useState<AuditLogFilter>(initialFilters);
  const [currentPage, setCurrentPage] = useState(initialData.page);

  async function fetchLogs(filters: AuditLogFilter, page: number) {
    setIsLoading(true);
    try {
      const res = await fetch(`/api/admin/logs?${buildQueryString(filters, page)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { message?: string } | null;
        throw new Error(body?.message ?? "Failed to fetch logs");
      }
      const result = await res.json() as AuditLogPage;
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
    fetchLogs(draftFilters, 1);
  }

  function handleClear() {
    const empty: AuditLogFilter = {};
    setDraftFilters(empty);
    setAppliedFilters(empty);
    fetchLogs(empty, 1);
  }

  function handlePage(page: number) {
    fetchLogs(appliedFilters, page);
  }

  function handleExportCsv() {
    const headers = ["Created At", "Actor Login ID", "Role", "Entity Type", "Entity ID", "Summary", "IP"];
    const rows = data.logs.map((log) => [
      log.createdAt,
      log.actorLoginId,
      log.actorRole ?? "",
      log.entityType ?? "",
      log.entityId ?? "",
      log.summary ?? "",
      log.requestIp ?? "",
    ]);
    // Every cell through the shared guard: an audit summary carries text people typed (names, notes),
    // and a cell that opens with = + - @ would run as a formula in the sheet a Super Admin opens.
    const csv = CSV_BOM + [headers, ...rows].map((r) => csvLine(r)).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-logs-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
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
              Audit Filters
            </p>
            <p className="mt-1 text-xs text-slate-500">Search by actor, summary, entity type, or date window.</p>
          </div>
          <div className="rounded-full border border-phx-line bg-phx-paper px-3 py-1.5 text-xs font-black text-phx-ink-soft">
            {data.total.toLocaleString("en-US")} entries
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-phx-ink-soft" />
            <input
              className={cn(phxFieldClassName, "pl-8")}
              onChange={(e) => setDraftFilters((f) => ({ ...f, actor: e.target.value || null }))}
              placeholder="Actor login ID..."
              value={draftFilters.actor ?? ""}
            />
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-phx-ink-soft" />
            <input
              className={cn(phxFieldClassName, "pl-8")}
              onChange={(e) => setDraftFilters((f) => ({ ...f, action: e.target.value || null }))}
              placeholder="Summary keyword..."
              value={draftFilters.action ?? ""}
            />
          </div>
          <SearchableSelect
            className="px-3 text-xs"
            /*
             * 🔴 THE CAP HAS TO RISE WITH THE LIST, OR THIS "IMPROVEMENT" HIDES MORE THAN IT SHOWS.
             * SearchableSelect shows `maxResults` rows and defaults to 100. The catalogue is 128
             * plus "all", so the default would silently drop the last 29 alphabetically whenever
             * the list is opened without typing — `user`, `vacation_request`,
             * `vacation_weekly_off_policy` and `weekly_plan` among them, three of which the old
             * hand-kept shortlist DID offer. Measured 2026-09-30. The panel is `max-h-64` with
             * `overflow-y-auto`, so the whole list simply scrolls.
             */
            maxResults={ENTITY_TYPES.length}
            onChange={(e) => setDraftFilters((f) => ({ ...f, entityType: e.target.value === "all" ? null : e.target.value }))}
            value={draftFilters.entityType ?? "all"}
          >
            {ENTITY_TYPES.map((t) => (
              <option key={t} value={t}>{t === "all" ? "All entity types" : t}</option>
            ))}
          </SearchableSelect>
          <input
            className={phxFieldClassName}
            onChange={(e) => setDraftFilters((f) => ({ ...f, dateFrom: e.target.value || null }))}
            type="date"
            value={draftFilters.dateFrom ?? ""}
          />
          <input
            className={phxFieldClassName}
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
          <div className="ml-auto">
            <button
              className="flex h-9 items-center gap-1.5 rounded-xl border border-phx-line bg-white px-3 text-xs font-black text-phx-ink-soft transition hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700"
              onClick={handleExportCsv}
              type="button"
            >
              <Download className="h-3.5 w-3.5" />
              Export CSV
            </button>
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-3xl border border-phx-line bg-white/95 shadow-[0_18px_42px_rgba(15,23,42,0.07)]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px]">
            <thead>
              <tr className="border-b border-phx-line bg-phx-paper">
                {["Created At", "Actor", "Role", "Entity Type", "Entity ID", "Summary", "IP"].map((h) => (
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
              ) : data.logs.length === 0 ? (
                <tr>
                  <td className="px-5 py-8 text-center text-sm text-phx-ink-soft" colSpan={7}>
                    No audit log entries found.
                  </td>
                </tr>
              ) : (
                data.logs.map((log) => (
                  <tr className="transition-colors hover:bg-orange-50/35" key={log.id}>
                    <td className="whitespace-nowrap px-5 py-4 font-mono text-xs font-semibold text-phx-ink-soft">
                      {formatDate(log.createdAt)}
                    </td>
                    <td className="px-5 py-4 text-sm font-bold text-phx-ink">
                      {log.actorLoginId}
                      {log.actorHrId && log.actorHrId !== log.actorLoginId && (
                        <span className="ml-1 text-xs font-medium text-phx-ink-soft">({log.actorHrId})</span>
                      )}
                    </td>
                    <td className="px-5 py-4 text-sm text-phx-ink-soft">{log.actorRole ?? "-"}</td>
                    <td className="px-5 py-4">
                      {log.entityType ? (
                        <span className="inline-flex items-center rounded-full bg-phx-warn-bg px-2.5 py-1 text-phx-xs font-bold text-phx-warn ring-1 ring-phx-warn-line">
                          {log.entityType}
                        </span>
                      ) : (
                        <span className="text-phx-ink-soft">-</span>
                      )}
                    </td>
                    <td className="px-5 py-4 font-mono text-xs font-semibold text-phx-ink-soft">{log.entityId ?? "-"}</td>
                    <td className="max-w-lg px-5 py-4 text-sm font-medium text-phx-ink">
                      <span className="line-clamp-2">{log.summary ?? "-"}</span>
                    </td>
                    <td className="px-5 py-4 font-mono text-xs text-phx-ink-soft">{log.requestIp ?? "-"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {data.pageCount > 1 && (
          <div className="flex items-center justify-between border-t border-phx-line bg-phx-paper/80 px-5 py-3">
            <span className="text-xs font-semibold text-phx-ink-soft">
              {from}-{to} of {data.total} entries
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
