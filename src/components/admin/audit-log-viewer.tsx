"use client";

import { ChevronLeft, ChevronRight, Download, Filter, Loader2, Search, X } from "lucide-react";
import { useMemo, useState } from "react";

import type { AuditLogFilter, AuditLogPage, AuditModule, AuditSourceTable } from "@/lib/admin/audit";

const MODULE_OPTIONS: Array<"all" | AuditModule> = [
  "all",
  "auth",
  "access",
  "governance",
  "leave",
  "sales",
  "recruitment",
  "coaching",
  "outstation",
];
const SOURCE_OPTIONS: Array<"all" | AuditSourceTable> = [
  "all",
  "audit_logs",
  "leave_audit_logs",
  "sales_audit_logs",
  "job_offer_audit_logs",
  "coaching_report_audit_logs",
  "outstation_location_audit_logs",
];
const ENTITY_TYPES = [
  "all",
  "auth_session",
  "coaching_report",
  "job_offer",
  "leave_request",
  "outstation_location",
  "permission_override",
  "salary_flag",
  "sales_import",
  "user",
];
const STATUS_OPTIONS = ["all", "succeeded", "failed", "pending", "changed", "approved", "rejected"];
const PAGE_SIZES = [25, 50, 100, 200];

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

function label(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function csvCell(value: unknown) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function buildQueryString(filters: AuditLogFilter, page: number) {
  const params = new URLSearchParams();
  if (filters.actor) params.set("actor", filters.actor);
  if (filters.action) params.set("action", filters.action);
  if (filters.entityId) params.set("entityId", filters.entityId);
  if (filters.entityType) params.set("entityType", filters.entityType);
  if (filters.module) params.set("module", filters.module);
  if (filters.source) params.set("source", filters.source);
  if (filters.status) params.set("status", filters.status);
  if (filters.dateFrom) params.set("dateFrom", filters.dateFrom);
  if (filters.dateTo) params.set("dateTo", filters.dateTo);
  params.set("page", String(page));
  params.set("pageSize", String(filters.pageSize ?? 50));
  return params.toString();
}

function activeFilterCount(filters: AuditLogFilter) {
  return [
    filters.actor,
    filters.action,
    filters.entityId,
    filters.entityType,
    filters.module,
    filters.source,
    filters.status,
    filters.dateFrom,
    filters.dateTo,
  ].filter(Boolean).length;
}

function FilterSelect({
  labelText,
  onChange,
  options,
  value,
}: {
  labelText: string;
  onChange: (value: string) => void;
  options: string[];
  value: string;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-400">{labelText}</span>
      <select
        className="h-10 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-xs font-semibold text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#F97316]/30"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option === "all" ? `All ${labelText.toLowerCase()}` : label(option)}
          </option>
        ))}
      </select>
    </label>
  );
}

function FilterInput({
  labelText,
  onChange,
  placeholder,
  type = "text",
  value,
}: {
  labelText: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  value: string;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-400">{labelText}</span>
      <div className="relative">
        {type === "text" ? <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#64748B]" /> : null}
        <input
          className={`h-10 w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-xs font-semibold text-[#0F172A] placeholder:text-[#64748B] focus:outline-none focus:ring-2 focus:ring-[#F97316]/30 ${type === "text" ? "pl-8" : ""}`}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          type={type}
          value={value}
        />
      </div>
    </label>
  );
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

  const moduleBadges = useMemo(
    () => Object.entries(data.moduleCounts).filter(([, count]) => count > 0),
    [data.moduleCounts],
  );

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
    const empty: AuditLogFilter = { pageSize: draftFilters.pageSize ?? 50 };
    setDraftFilters(empty);
    setAppliedFilters(empty);
    fetchLogs(empty, 1);
  }

  function handlePage(page: number) {
    fetchLogs(appliedFilters, page);
  }

  function handleExportCsv() {
    const headers = ["Created At", "Module", "Source", "Actor", "Role", "Action", "Entity Type", "Entity ID", "Status", "Summary", "IP"];
    const rows = data.logs.map((log) => [
      log.createdAt,
      log.module,
      log.source,
      log.actorLoginId,
      log.actorRole ?? "",
      log.action ?? "",
      log.entityType ?? "",
      log.entityId ?? "",
      log.status ?? "",
      log.summary ?? "",
      log.requestIp ?? "",
    ]);
    const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
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
        <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="flex items-center gap-2 text-sm font-black uppercase tracking-[0.16em] text-slate-700">
              <Filter className="h-4 w-4 text-orange-600" />
              Advanced Audit Filters
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Search every audit source by module, source table, actor, action, entity, status, and date window.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <div className="rounded-full border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-1.5 text-xs font-black text-slate-500">
              {data.total.toLocaleString("en-US")} entries
            </div>
            <div className="rounded-full border border-orange-200 bg-orange-50 px-3 py-1.5 text-xs font-black text-orange-700">
              {activeFilterCount(appliedFilters)} filters active
            </div>
          </div>
        </div>

        {moduleBadges.length > 0 ? (
          <div className="mb-4 flex flex-wrap gap-2">
            {moduleBadges.map(([module, count]) => (
              <button
                className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] font-bold text-slate-600 transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700"
                key={module}
                onClick={() => {
                  const next = { ...draftFilters, module: module as AuditModule };
                  setDraftFilters(next);
                  setAppliedFilters(next);
                  fetchLogs(next, 1);
                }}
                type="button"
              >
                {label(module)}: {count}
              </button>
            ))}
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          <FilterInput
            labelText="Actor"
            onChange={(value) => setDraftFilters((filters) => ({ ...filters, actor: value || null }))}
            placeholder="Login ID, HR ID, actor..."
            value={draftFilters.actor ?? ""}
          />
          <FilterInput
            labelText="Keyword / Action"
            onChange={(value) => setDraftFilters((filters) => ({ ...filters, action: value || null }))}
            placeholder="Summary, action, metadata..."
            value={draftFilters.action ?? ""}
          />
          <FilterInput
            labelText="Entity ID"
            onChange={(value) => setDraftFilters((filters) => ({ ...filters, entityId: value || null }))}
            placeholder="Request, offer, batch, user..."
            value={draftFilters.entityId ?? ""}
          />
          <FilterSelect
            labelText="Module"
            onChange={(value) => setDraftFilters((filters) => ({ ...filters, module: value === "all" ? null : value as AuditModule }))}
            options={MODULE_OPTIONS}
            value={draftFilters.module ?? "all"}
          />
          <FilterSelect
            labelText="Source"
            onChange={(value) => setDraftFilters((filters) => ({ ...filters, source: value === "all" ? null : value as AuditSourceTable }))}
            options={SOURCE_OPTIONS}
            value={draftFilters.source ?? "all"}
          />
          <FilterSelect
            labelText="Entity Type"
            onChange={(value) => setDraftFilters((filters) => ({ ...filters, entityType: value === "all" ? null : value }))}
            options={ENTITY_TYPES}
            value={draftFilters.entityType ?? "all"}
          />
          <FilterSelect
            labelText="Status"
            onChange={(value) => setDraftFilters((filters) => ({ ...filters, status: value === "all" ? null : value }))}
            options={STATUS_OPTIONS}
            value={draftFilters.status ?? "all"}
          />
          <FilterSelect
            labelText="Page Size"
            onChange={(value) => setDraftFilters((filters) => ({ ...filters, pageSize: Number(value) }))}
            options={PAGE_SIZES.map(String)}
            value={String(draftFilters.pageSize ?? 50)}
          />
          <FilterInput
            labelText="Date From"
            onChange={(value) => setDraftFilters((filters) => ({ ...filters, dateFrom: value || null }))}
            type="date"
            value={draftFilters.dateFrom ?? ""}
          />
          <FilterInput
            labelText="Date To"
            onChange={(value) => setDraftFilters((filters) => ({ ...filters, dateTo: value || null }))}
            type="date"
            value={draftFilters.dateTo ?? ""}
          />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
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
              Export Current Page
            </button>
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-3xl border border-[#E2E8F0] bg-white/95 shadow-[0_18px_42px_rgba(15,23,42,0.07)]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1180px]">
            <thead>
              <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                {["Created At", "Module", "Source", "Actor", "Action", "Entity", "Status", "Summary", "IP"].map((heading) => (
                  <th
                    className="px-5 py-4 text-left text-[10px] font-black uppercase tracking-widest text-[#64748B]"
                    key={heading}
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F1F5F9]">
              {isLoading ? (
                <tr>
                  <td className="px-5 py-8 text-center text-sm text-[#64748B]" colSpan={9}>
                    <Loader2 className="mx-auto h-5 w-5 animate-spin text-[#F97316]" />
                  </td>
                </tr>
              ) : data.logs.length === 0 ? (
                <tr>
                  <td className="px-5 py-8 text-center text-sm text-[#64748B]" colSpan={9}>
                    No audit log entries found.
                  </td>
                </tr>
              ) : (
                data.logs.map((log) => (
                  <tr className="transition-colors hover:bg-orange-50/35" key={log.id}>
                    <td className="whitespace-nowrap px-5 py-4 font-mono text-xs font-semibold text-[#64748B]">
                      {formatDate(log.createdAt)}
                    </td>
                    <td className="px-5 py-4">
                      <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-700 ring-1 ring-slate-200">
                        {label(log.module)}
                      </span>
                    </td>
                    <td className="px-5 py-4 font-mono text-[11px] font-semibold text-[#64748B]">{log.source}</td>
                    <td className="px-5 py-4 text-sm font-bold text-[#0F172A]">
                      {log.actorLoginId}
                      {log.actorHrId && log.actorHrId !== log.actorLoginId ? (
                        <span className="ml-1 text-xs font-medium text-[#64748B]">({log.actorHrId})</span>
                      ) : null}
                    </td>
                    <td className="px-5 py-4 text-xs font-bold text-[#0F172A]">{log.action ?? "-"}</td>
                    <td className="px-5 py-4">
                      <div className="grid gap-1">
                        <span className="text-xs font-bold text-orange-600">{log.entityType ?? "-"}</span>
                        <span className="font-mono text-[11px] font-semibold text-[#64748B]">{log.entityId ?? "-"}</span>
                      </div>
                    </td>
                    <td className="px-5 py-4">
                      <span className="inline-flex items-center rounded-full bg-orange-50 px-2.5 py-1 text-[11px] font-bold text-orange-600 ring-1 ring-orange-100">
                        {log.status ?? "recorded"}
                      </span>
                    </td>
                    <td className="max-w-xl px-5 py-4 text-sm font-medium text-[#0F172A]">
                      <span className="line-clamp-2">{log.summary ?? "-"}</span>
                    </td>
                    <td className="px-5 py-4 font-mono text-xs text-[#64748B]">{log.requestIp ?? "-"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-col gap-3 border-t border-[#E2E8F0] bg-[#F8FAFC]/80 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
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
      </div>
    </div>
  );
}
