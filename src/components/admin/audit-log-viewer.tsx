"use client";

import { ChevronLeft, ChevronRight, Download, Loader2, Search, X } from "lucide-react";
import { useState } from "react";

import type { AuditLogFilter, AuditLogPage } from "@/lib/admin/audit";

const ENTITY_TYPES = ["all", "auth_session", "user", "permission_override", "salary_flag"];

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
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
      if (!res.ok) throw new Error("Failed to fetch logs");
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
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="rounded-2xl border border-[#E2E8F0] bg-white p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#64748B]" />
            <input
              className="h-9 w-full rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] pl-8 pr-3 text-xs text-[#0F172A] placeholder:text-[#64748B] focus:outline-none focus:ring-2 focus:ring-[#F97316]/30"
              onChange={(e) => setDraftFilters((f) => ({ ...f, actor: e.target.value || null }))}
              placeholder="Actor login ID…"
              value={draftFilters.actor ?? ""}
            />
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#64748B]" />
            <input
              className="h-9 w-full rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] pl-8 pr-3 text-xs text-[#0F172A] placeholder:text-[#64748B] focus:outline-none focus:ring-2 focus:ring-[#F97316]/30"
              onChange={(e) => setDraftFilters((f) => ({ ...f, action: e.target.value || null }))}
              placeholder="Summary keyword…"
              value={draftFilters.action ?? ""}
            />
          </div>
          <select
            className="h-9 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-xs text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#F97316]/30"
            onChange={(e) => setDraftFilters((f) => ({ ...f, entityType: e.target.value === "all" ? null : e.target.value }))}
            value={draftFilters.entityType ?? "all"}
          >
            {ENTITY_TYPES.map((t) => (
              <option key={t} value={t}>{t === "all" ? "All entity types" : t}</option>
            ))}
          </select>
          <input
            className="h-9 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-xs text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#F97316]/30"
            onChange={(e) => setDraftFilters((f) => ({ ...f, dateFrom: e.target.value || null }))}
            type="date"
            value={draftFilters.dateFrom ?? ""}
          />
          <input
            className="h-9 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-xs text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#F97316]/30"
            onChange={(e) => setDraftFilters((f) => ({ ...f, dateTo: e.target.value || null }))}
            type="date"
            value={draftFilters.dateTo ?? ""}
          />
        </div>
        <div className="mt-3 flex items-center gap-2">
          <button
            className="flex h-8 items-center gap-1.5 rounded-lg bg-[#F97316] px-4 text-xs font-semibold text-white hover:bg-[#EA580C] disabled:opacity-50"
            disabled={isLoading}
            onClick={handleApply}
            type="button"
          >
            {isLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
            Apply Filters
          </button>
          <button
            className="flex h-8 items-center gap-1.5 rounded-lg border border-[#E2E8F0] bg-white px-3 text-xs font-semibold text-[#64748B] hover:bg-[#F8FAFC]"
            onClick={handleClear}
            type="button"
          >
            <X className="h-3.5 w-3.5" />
            Clear
          </button>
          <div className="ml-auto">
            <button
              className="flex h-8 items-center gap-1.5 rounded-lg border border-[#E2E8F0] bg-white px-3 text-xs font-semibold text-[#64748B] hover:bg-[#F8FAFC]"
              onClick={handleExportCsv}
              type="button"
            >
              <Download className="h-3.5 w-3.5" />
              Export CSV
            </button>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-2xl border border-[#E2E8F0] bg-white">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[800px]">
            <thead>
              <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                {["Created At", "Actor", "Role", "Entity Type", "Entity ID", "Summary", "IP"].map((h) => (
                  <th
                    className="px-4 py-3 text-left text-[10px] font-black uppercase tracking-widest text-[#64748B]"
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
                  <td className="px-4 py-8 text-center text-sm text-[#64748B]" colSpan={7}>
                    <Loader2 className="mx-auto h-5 w-5 animate-spin text-[#F97316]" />
                  </td>
                </tr>
              ) : data.logs.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-center text-sm text-[#64748B]" colSpan={7}>
                    No audit log entries found.
                  </td>
                </tr>
              ) : (
                data.logs.map((log) => (
                  <tr className="hover:bg-[#F8FAFC]/50" key={log.id}>
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[11px] text-[#64748B]">
                      {formatDate(log.createdAt)}
                    </td>
                    <td className="px-4 py-2.5 text-xs font-semibold text-[#0F172A]">
                      {log.actorLoginId}
                      {log.actorHrId && log.actorHrId !== log.actorLoginId && (
                        <span className="ml-1 text-[10px] font-normal text-[#64748B]">({log.actorHrId})</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-[#64748B]">{log.actorRole ?? "—"}</td>
                    <td className="px-4 py-2.5">
                      {log.entityType ? (
                        <span className="inline-flex items-center rounded-full bg-[#F1F5F9] px-2 py-0.5 text-[10px] font-semibold text-[#64748B]">
                          {log.entityType}
                        </span>
                      ) : (
                        <span className="text-[#64748B]">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[11px] text-[#64748B]">{log.entityId ?? "—"}</td>
                    <td className="max-w-xs px-4 py-2.5 text-xs text-[#0F172A]">
                      <span className="line-clamp-2">{log.summary ?? "—"}</span>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[10px] text-[#64748B]">{log.requestIp ?? "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {data.pageCount > 1 && (
          <div className="flex items-center justify-between border-t border-[#E2E8F0] px-4 py-3">
            <span className="text-xs text-[#64748B]">
              {from}–{to} of {data.total} entries
            </span>
            <div className="flex items-center gap-1">
              <button
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#E2E8F0] text-[#64748B] hover:bg-[#F8FAFC] disabled:opacity-40"
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
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#E2E8F0] text-[#64748B] hover:bg-[#F8FAFC] disabled:opacity-40"
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
