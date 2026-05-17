"use client";

import { useMemo, useState } from "react";
import { Download, FileSpreadsheet, Search } from "lucide-react";
import { useRouter } from "next/navigation";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  FingerprintReportColumn,
  FingerprintReportData,
  FingerprintReportRow,
} from "@/lib/attendance/fingerprint-report";

type Props = {
  initialData: FingerprintReportData | null;
  initialError: string | null;
};

function statusBadge(value: string) {
  if (value === "Complete") return <Badge variant="success">{value}</Badge>;
  if (value === "Short day") return <Badge variant="warning">{value}</Badge>;
  return <Badge variant="danger">{value}</Badge>;
}

function hasCellValue(row: FingerprintReportRow, column: FingerprintReportColumn) {
  return String(row[column.key] ?? "").trim().length > 0;
}

export function FingerprintReport({ initialData, initialError }: Props) {
  const router = useRouter();
  const [dateFrom, setDateFrom] = useState(initialData?.filters.dateFrom ?? "2026-01-01");
  const [dateTo, setDateTo] = useState(initialData?.filters.dateTo ?? new Date().toISOString().slice(0, 10));
  const [deduction, setDeduction] = useState(initialData?.filters.deduction ?? "");
  const [department, setDepartment] = useState(initialData?.filters.department ?? "");
  const [deviceUserId, setDeviceUserId] = useState(initialData?.filters.deviceUserId ?? "");
  const [employeeHrId, setEmployeeHrId] = useState(initialData?.filters.employeeHrId ?? "");
  const [employeeName, setEmployeeName] = useState(initialData?.filters.employeeName ?? "");
  const [jobTitle, setJobTitle] = useState(initialData?.filters.jobTitle ?? "");
  const [search, setSearch] = useState(initialData?.filters.search ?? "");
  const [status, setStatus] = useState(initialData?.filters.status ?? "");

  const visibleColumns = useMemo(() => {
    const rows = initialData?.rows ?? [];
    return (initialData?.columns ?? []).filter((column) => column.always || rows.some((row) => hasCellValue(row, column)));
  }, [initialData?.columns, initialData?.rows]);

  function filterParams() {
    const params = new URLSearchParams();
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    if (deduction.trim()) params.set("deduction", deduction.trim());
    if (department.trim()) params.set("department", department.trim());
    if (deviceUserId.trim()) params.set("deviceUserId", deviceUserId.trim());
    if (employeeHrId.trim()) params.set("employeeHrId", employeeHrId.trim());
    if (employeeName.trim()) params.set("employeeName", employeeName.trim());
    if (jobTitle.trim()) params.set("jobTitle", jobTitle.trim());
    if (search.trim()) params.set("search", search.trim());
    if (status.trim()) params.set("status", status.trim());
    return params;
  }

  function applyFilters() {
    const params = filterParams();
    router.push(`/attendance/fingerprint-report${params.toString() ? `?${params.toString()}` : ""}`);
  }

  const rows = initialData?.rows ?? [];
  const exportHref = `/api/attendance/fingerprint-report/export${filterParams().toString() ? `?${filterParams().toString()}` : ""}`;

  return (
    <div className="space-y-5">
      <AdminPageHero
        badges={(
          <>
            <AdminInsightChip>{initialData?.summary.rows ?? 0} daily rows</AdminInsightChip>
            <AdminInsightChip tone="slate">{initialData?.summary.complete ?? 0} complete</AdminInsightChip>
            <AdminInsightChip tone="orange">{initialData?.summary.deductions ?? 0} deduction flags</AdminInsightChip>
          </>
        )}
        description="Daily fingerprint report built from direct raw punches. Empty export columns are omitted; payroll is not changed."
        eyebrow="Attendance"
        icon={<FileSpreadsheet className="h-3.5 w-3.5" />}
        title="Fingerprint Attendance Report"
        actions={(
          <a
            className={`inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-transparent px-4 py-2 text-sm font-medium text-text transition hover:bg-bg-muted ${rows.length === 0 ? "pointer-events-none opacity-50" : ""}`}
            href={exportHref}
          >
            <Download className="h-4 w-4" />
            Export XLSX
          </a>
        )}
      />

      {initialError ? <AdminCallout tone="danger">{initialError}</AdminCallout> : null}
      <AdminCallout tone="neutral">
        Deduction is a report flag only: it is marked Yes for single-punch days and days under 8 hours. It does not update payroll.
      </AdminCallout>

      <AdminTableShell
        description="Filter by any key field in the report before reviewing or exporting."
        title="Report Filters"
      >
        <div className="grid gap-3 p-4 md:grid-cols-4 xl:grid-cols-6">
          <label className="space-y-1">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">From</span>
            <input
              className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
              type="date"
              value={dateFrom}
              onChange={(event) => setDateFrom(event.target.value)}
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">To</span>
            <input
              className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
              type="date"
              value={dateTo}
              onChange={(event) => setDateTo(event.target.value)}
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Search</span>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
                placeholder="HR_ID, name, device user, department"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          </label>
          <label className="space-y-1">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">AC-No.</span>
            <input
              className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
              value={deviceUserId}
              onChange={(event) => setDeviceUserId(event.target.value)}
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Employee ID</span>
            <input
              className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
              value={employeeHrId}
              onChange={(event) => setEmployeeHrId(event.target.value)}
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Name</span>
            <input
              className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
              value={employeeName}
              onChange={(event) => setEmployeeName(event.target.value)}
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Job Title</span>
            <input
              className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
              value={jobTitle}
              onChange={(event) => setJobTitle(event.target.value)}
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Department</span>
            <input
              className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
              value={department}
              onChange={(event) => setDepartment(event.target.value)}
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Status</span>
            <select
              className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="">All statuses</option>
              <option value="Complete">Complete</option>
              <option value="Short day">Short day</option>
              <option value="Single punch">Single punch</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Deduction</span>
            <input
              className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
              placeholder="days, value, action"
              value={deduction}
              onChange={(event) => setDeduction(event.target.value)}
            />
          </label>
          <div className="flex items-end md:col-span-2 xl:col-span-1">
            <Button className="h-10 w-full" type="button" onClick={applyFilters}>
              Apply
            </Button>
          </div>
        </div>
      </AdminTableShell>

      <AdminTableShell
        description="Matches the populated fingerprint export columns, plus Status and Deduction."
        title="Fingerprint Daily Report"
      >
        <div className="overflow-x-auto">
          <table className="min-w-full text-left">
            <thead className="bg-slate-50 text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">
              <tr>
                {visibleColumns.map((column) => (
                  <th className="whitespace-nowrap px-4 py-3" key={column.key}>{column.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr className="border-b border-slate-100 text-sm last:border-0 hover:bg-slate-50/60" key={row.sortKey}>
                  {visibleColumns.map((column) => (
                    <td className="whitespace-nowrap px-4 py-3 text-slate-700" key={`${row.sortKey}-${column.key}`}>
                      {column.key === "status" ? statusBadge(row.status) : row[column.key] || "-"}
                    </td>
                  ))}
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-center text-sm text-slate-500" colSpan={Math.max(visibleColumns.length, 1)}>
                    No fingerprint attendance rows found for this filter.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </AdminTableShell>
    </div>
  );
}
