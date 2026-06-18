"use client";

import { ChevronLeft, ChevronRight, Download, Loader2, Search, X } from "lucide-react";
import { useState } from "react";

import type { AuditLogFilter, AuditLogPage } from "@/lib/admin/audit";
import { SearchableSelect } from "@/components/ui/searchable-select";


const ENTITY_TYPES = [
  "all",
  "auth_session",
  "user",
  "permission_override",
  "salary_flag",
  "sales_import_batch",
  "payroll_batch",
  "vacation_request",
  "vacation_weekly_off_policy",
];

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
      (log.summary ?? "").replace(/,/g, ";"),
      log.requestIp ?? "",
    ]);
    const csv = [headers, ...rows].map((r) => r.join(",")).join("\n");
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
      <div className="rounded-3xl border border-[#E2E8F0] bg-white/95 p-5 shadow-[0_18px_42px_rgba(15,23,42,0.07)]">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <p className="flex items-center gap-2 text-sm font-black uppercase tracking-[0.16em] text-slate-700">
              <span className="h-2 w-2 rounded-full bg-[#F97316]" />
              Audit Filters
            </p>
            <p className="mt-1 text-xs text-slate-500">Search by actor, summary, entity type, or date window.</p>
          </div>
          <div className="rounded-full border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-1.5 text-xs font-black text-slate-500">
            {data.total.toLocaleString("en-US")} entries
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#64748B]" />
            <input
              className="h-10 w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] pl-8 pr-3 text-xs font-semibold text-[#0F172A] placeholder:text-[#64748B] focus:outline-none focus:ring-2 focus:ring-[#F97316]/30"
              onChange={(e) => setDraftFilters((f) => ({ ...f, actor: e.target.value || null }))}
              placeholder="Actor login ID..."
              value={draftFilters.actor ?? ""}
            />
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#64748B]" />
            <input
              className="h-10 w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] pl-8 pr-3 text-xs font-semibold text-[#0F172A] placeholder:text-[#64748B] focus:outline-none focus:ring-2 focus:ring-[#F97316]/30"
              onChange={(e) => setDraftFilters((f) => ({ ...f, action: e.target.value || null }))}
              placeholder="Summary keyword..."
              value={draftFilters.action ?? ""}
            />
          </div>
          <SearchableSelect
            className="h-10 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-xs font-semibold text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#F97316]/30"
            onChange={(e) => setDraftFilters((f) => ({ ...f, entityType: e.target.value === "all" ? null : e.target.value }))}
            value={draftFilters.entityType ?? "all"}
          >
            {ENTITY_TYPES.map((t) => (
              <option key={t} value={t}>{t === "all" ? "All entity types" : t}</option>
            ))}
          </SearchableSelect>
          <input
            className="h-10 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-xs font-semibold text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#F97316]/30"
            onChange={(e) => setDraftFilters((f) => ({ ...f, dateFrom: e.target.value || null }))}
            type="date"
            value={draftFilters.dateFrom ?? ""}
          />
          <input
            className="h-10 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-xs font-semibold text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#F97316]/30"
            onChange={(e) => setDraftFilters((f) => ({ ...f, dateTo: e.target.value || null }))}
            type="date"
            value={draftFilters.dateTo ?? ""}
          />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            className="flex h-9 items-center gap-1.5 rounded-xl bg-[#0B0B0B] px-4 text-xs font-black text-white shadow-[0_12px_26px_rgba(15,23,42,0.18)] transition hover:bg-[#F97316] disabled:opacity-50"
            disabled={isLoading}
            onClick={handleApply}
            type="button"
          >
            {isLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
            Apply Filters
          </button>
          <button
            className="flex h-9 items-center gap-1.5 rounded-xl border border-[#E2E8F0] bg-white px-3 text-xs font-black text-[#64748B] transition hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700"
            onClick={handleClear}
            type="button"
          >
            <X className="h-3.5 w-3.5" />
            Clear
          </button>
          <div className="ml-auto">
            <button
              className="flex h-9 items-center gap-1.5 rounded-xl border border-[#E2E8F0] bg-white px-3 text-xs font-black text-[#64748B] transition hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700"
              onClick={handleExportCsv}
              type="button"
            >
              <Download className="h-3.5 w-3.5" />
              Export CSV
            </button>
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-3xl border border-[#E2E8F0] bg-white/95 shadow-[0_18px_42px_rgba(15,23,42,0.07)]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px]">
            <thead>
              <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                {["Created At", "Actor", "Role", "Entity Type", "Entity ID", "Summary", "IP"].map((h) => (
                  <th
                    className="px-5 py-4 text-left text-[10px] font-black uppercase tracking-widest text-[#64748B]"
                    key={h}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F1F5F9]">
              {isLoading ? (
                <tr>
                  <td className="px-5 py-8 text-center text-sm text-[#64748B]" colSpan={7}>
                    <Loader2 className="mx-auto h-5 w-5 animate-spin text-[#F97316]" />
                  </td>
                </tr>
              ) : data.logs.length === 0 ? (
                <tr>
                  <td className="px-5 py-8 text-center text-sm text-[#64748B]" colSpan={7}>
                    No audit log entries found.
                  </td>
                </tr>
              ) : (
                data.logs.map((log) => (
                  <tr className="transition-colors hover:bg-orange-50/35" key={log.id}>
                    <td className="whitespace-nowrap px-5 py-4 font-mono text-xs font-semibold text-[#64748B]">
                      {formatDate(log.createdAt)}
                    </td>
                    <td className="px-5 py-4 text-sm font-bold text-[#0F172A]">
                      {log.actorLoginId}
                      {log.actorHrId && log.actorHrId !== log.actorLoginId && (
                        <span className="ml-1 text-xs font-medium text-[#64748B]">({log.actorHrId})</span>
                      )}
                    </td>
                    <td className="px-5 py-4 text-sm text-[#64748B]">{log.actorRole ?? "-"}</td>
                    <td className="px-5 py-4">
                      {log.entityType ? (
                        <span className="inline-flex items-center rounded-full bg-orange-50 px-2.5 py-1 text-[11px] font-bold text-orange-600 ring-1 ring-orange-100">
                          {log.entityType}
                        </span>
                      ) : (
                        <span className="text-[#64748B]">-</span>
                      )}
                    </td>
                    <td className="px-5 py-4 font-mono text-xs font-semibold text-[#64748B]">{log.entityId ?? "-"}</td>
                    <td className="max-w-lg px-5 py-4 text-sm font-medium text-[#0F172A]">
                      <span className="line-clamp-2">{log.summary ?? "-"}</span>
                    </td>
                    <td className="px-5 py-4 font-mono text-xs text-[#64748B]">{log.requestIp ?? "-"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {data.pageCount > 1 && (
          <div className="flex items-center justify-between border-t border-[#E2E8F0] bg-[#F8FAFC]/80 px-5 py-3">
            <span className="text-xs font-semibold text-[#64748B]">
              {from}-{to} of {data.total} entries
            </span>
            <div className="flex items-center gap-1">
              <button
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#CBD5E1] bg-white text-[#64748B] shadow-sm transition hover:border-orange-300 hover:bg-orange-50 hover:text-orange-600 disabled:opacity-40"
                disabled={currentPage === 1 || isLoading}
                onClick={() => handlePage(currentPage - 1)}
                type="button"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="px-2 text-xs font-semibold text-[#0F172A]">
                {currentPage} / {data.pageCount}
              </span>
              <button
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#CBD5E1] bg-white text-[#64748B] shadow-sm transition hover:border-orange-300 hover:bg-orange-50 hover:text-orange-600 disabled:opacity-40"
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
