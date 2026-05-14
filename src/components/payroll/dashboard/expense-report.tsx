import {
  AlertTriangle,
  Download,
  FileCheck2,
  FileSpreadsheet,
  Loader2,
  Trash2,
  Upload,
} from "lucide-react";
import type { RefObject } from "react";
import { useMemo, useRef, useState } from "react";

import { AdminCallout } from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  formatCurrencyValue,
  formatDateValue,
  formatNumberValue,
} from "@/lib/i18n/format";
import type {
  ExpenseAnalysisResult,
  ExpenseTripRecord,
  PayrollExpenseReport,
} from "@/lib/payroll/types";
import { cn } from "@/lib/utils";

import { panelClassName, payrollMonths } from "./shared";
import { TableHeaderMenu } from "./table-header-menu";

function formatEGP(value: number) {
  return formatCurrencyValue(value);
}

function formatNumber(value: number) {
  return formatNumberValue(value);
}

function formatPayrollDate(value: string | null | undefined) {
  return formatDateValue(value);
}

function ExpenseErrorBanner({
  message,
}: {
  message: string;
}) {
  return (
    <AdminCallout tone="danger">
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
      <div>
        <p className="font-semibold">Expenses analysis error</p>
        <p className="mt-1 leading-6">{message}</p>
      </div>
    </AdminCallout>
  );
}

function expenseColumnValue(record: ExpenseTripRecord, key: string) {
  if (key === "hrId") return record.hrId ?? "";

  const value = record[key as keyof ExpenseTripRecord];

  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  return "";
}

export function buildExpenseAnalysis(fileName: string, records: ExpenseTripRecord[]): ExpenseAnalysisResult {
  const specialists = Array.from(
    records.reduce((map, record) => {
      const current =
        map.get(record.specialist) ??
        {
          allowance: 0,
          meetingAmount: 0,
          specialist: record.specialist || "Unassigned",
          total: 0,
          travelCost: 0,
          trips: 0,
        };

      current.allowance += record.allowance;
      current.meetingAmount += record.meetingAmount;
      current.total += record.total;
      current.travelCost += record.travelCost;
      current.trips += 1;
      map.set(current.specialist, current);
      return map;
    }, new Map<string, ExpenseAnalysisResult["specialists"][number]>()),
  )
    .map(([, value]) => value)
    .sort((left, right) => right.total - left.total);

  return {
    columns: [],
    fileName,
    records,
    specialists,
    summary: {
      confirmedByFinance: records.filter((record) =>
        record.status.toLowerCase().includes("confirmed by finance"),
      ).length,
      refusedByHr: records.filter((record) => record.hr.toLowerCase().includes("refused")).length,
      specialists: specialists.length,
      systemApproved: records.filter((record) =>
        record.status.toLowerCase().includes("system approval"),
      ).length,
      totalAllowance: records.reduce((sum, record) => sum + record.allowance, 0),
      totalExpenses: records.reduce((sum, record) => sum + record.total, 0),
      totalKm: records.reduce((sum, record) => sum + record.km, 0),
      totalMeetingAmount: records.reduce((sum, record) => sum + record.meetingAmount, 0),
      totalTravelCost: records.reduce((sum, record) => sum + record.travelCost, 0),
      trips: records.length,
    },
    warnings: [],
  };
}

export function ExpenseReport({
  analysis,
  analyzing,
  error,
  inputRef,
  onImportToPayroll,
  onDeleteReport,
  onReplaceReport,
  onSaveApprovals,
  onSelectReport,
  onUpload,
  payrollMonthsForImport,
  payrollYearsForImport,
  reports,
  selectedReportId,
  deletingReportId,
  importingToPayroll,
  replacingReportId,
  savingApprovals,
}: {
  analysis: ExpenseAnalysisResult | null;
  analyzing: boolean;
  error: string | null;
  inputRef: RefObject<HTMLInputElement | null>;
  onImportToPayroll: (
    records: Array<ExpenseTripRecord & { hrApproved: boolean; hrComment: string }>,
    month: number,
    year: number,
  ) => void;
  onDeleteReport: (reportId: string) => void;
  onReplaceReport: (reportId: string, file: File | null) => void;
  onSaveApprovals: (records: Array<ExpenseTripRecord & { hrApproved: boolean; hrComment: string }>) => void;
  onSelectReport: (reportId: string) => void;
  onUpload: (file: File | null) => void;
  payrollMonthsForImport: typeof payrollMonths;
  payrollYearsForImport: string[];
  reports: PayrollExpenseReport[];
  selectedReportId: string | null;
  deletingReportId: string | null;
  importingToPayroll: boolean;
  replacingReportId: string | null;
  savingApprovals: boolean;
}) {
  const [search, setSearch] = useState("");
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({});
  const [approvals, setApprovals] = useState<Record<string, { hrApproved: boolean; hrComment: string }>>({});
  const [tripDateFrom, setTripDateFrom] = useState("");
  const [tripDateTo, setTripDateTo] = useState("");
  const [importMonth, setImportMonth] = useState(String(new Date().getMonth() + 1));
  const [importYear, setImportYear] = useState(String(new Date().getFullYear()));
  const [replaceReportId, setReplaceReportId] = useState<string | null>(null);
  const [sort, setSort] = useState("total-desc");
  const replaceReportInputRef = useRef<HTMLInputElement | null>(null);
  const approvalFor = (record: ExpenseTripRecord) => {
    const saved = record as ExpenseTripRecord & { hrApproved?: boolean; hrComment?: string };

    return (
      approvals[record.tripId] ?? {
        hrApproved: Boolean(saved.hrApproved),
        hrComment: saved.hrComment ?? "",
      }
    );
  };
  const columns = [
    { asc: "specialist-asc", desc: "specialist-desc", key: "specialist", label: "Specialist" },
    { asc: "hrId-asc", desc: "hrId-desc", key: "hrId", label: "HR ID" },
    { asc: "date-asc", desc: "date-desc", key: "date", label: "Date" },
    { asc: "tripId-asc", desc: "tripId-desc", key: "tripId", label: "Trip ID" },
    { asc: "from-asc", desc: "from-desc", key: "from", label: "From" },
    { asc: "to-asc", desc: "to-desc", key: "to", label: "To" },
    { asc: "transportationType-asc", desc: "transportationType-desc", key: "transportationType", label: "Transport" },
    { asc: "travelCost-asc", desc: "travelCost-desc", key: "travelCost", label: "Travel" },
    { asc: "meetingAmount-asc", desc: "meetingAmount-desc", key: "meetingAmount", label: "Meeting" },
    { asc: "allowance-asc", desc: "allowance-desc", key: "allowance", label: "Allowance" },
    { asc: "total-asc", desc: "total-desc", key: "total", label: "Total" },
    { asc: "status-asc", desc: "status-desc", key: "status", label: "Status" },
  ];
  const records = useMemo(() => {
    const query = search.trim().toLowerCase();
    const fromDate = tripDateFrom ? new Date(`${tripDateFrom}T00:00:00`) : null;
    const toDate = tripDateTo ? new Date(`${tripDateTo}T23:59:59`) : null;
    const source = analysis?.records ?? [];
    const filtered = source.filter((record) => {
      const tripDate = record.date ? new Date(record.date) : null;
      const matchesTripDate =
        (!fromDate || (tripDate && tripDate >= fromDate)) &&
        (!toDate || (tripDate && tripDate <= toDate));
      const haystack = [
        record.specialist,
        record.hrId ?? "",
        record.tripId,
        record.from,
        record.to,
        record.transportationType,
        record.status,
        record.description,
      ]
        .join(" ")
        .toLowerCase();
      const matchesSearch = !query || haystack.includes(query);
      const matchesColumns = Object.entries(columnFilters).every(([key, value]) => {
        const filter = value.trim().toLowerCase();
        const columnValue =
          key === "hrId" ? record.hrId ?? "" : expenseColumnValue(record, key);

        return !filter || columnValue.toLowerCase().includes(filter);
      });

      return matchesTripDate && matchesSearch && matchesColumns;
    });

    return filtered.slice().sort((left, right) => {
      const [key, direction] = sort.split("-");
      const leftValue =
        key === "hrId" ? left.hrId ?? "" : expenseColumnValue(left, key);
      const rightValue =
        key === "hrId" ? right.hrId ?? "" : expenseColumnValue(right, key);
      const numericKeys = new Set(["travelCost", "meetingAmount", "allowance", "total"]);
      const recordKey = key;

      if (numericKeys.has(key)) {
        const leftNumber = Number(left[recordKey as keyof ExpenseTripRecord] ?? 0);
        const rightNumber = Number(right[recordKey as keyof ExpenseTripRecord] ?? 0);
        return direction === "desc" ? rightNumber - leftNumber : leftNumber - rightNumber;
      }

      return direction === "desc"
        ? rightValue.localeCompare(leftValue)
        : leftValue.localeCompare(rightValue);
    });
  }, [analysis?.records, columnFilters, search, sort, tripDateFrom, tripDateTo]);

  const approvedRecords = (analysis?.records ?? []).filter((record) => approvalFor(record).hrApproved);
  const approvedTotal = approvedRecords.reduce((sum, record) => sum + record.total, 0);
  const unmappedRecords = (analysis?.records ?? []).filter((record) => !record.hrId);
  const missingTripDateRecords = (analysis?.records ?? []).filter((record) => !record.date);
  const filteredTotal = records.reduce((sum, record) => sum + record.total, 0);
  const expenseFilterCount =
    (search.trim() ? 1 : 0) +
    (tripDateFrom ? 1 : 0) +
    (tripDateTo ? 1 : 0) +
    Object.values(columnFilters).filter((value) => value.trim()).length;

  function saveApprovals() {
    if (!analysis) return;

    onSaveApprovals(
      analysis.records.map((record) => ({
        ...record,
        hrApproved: approvalFor(record).hrApproved,
        hrComment: approvalFor(record).hrComment,
      })),
    );
  }

  function importToPayroll() {
    if (!analysis) return;

    onImportToPayroll(
      analysis.records.map((record) => ({
        ...record,
        hrApproved: approvalFor(record).hrApproved,
        hrComment: approvalFor(record).hrComment,
      })),
      Number(importMonth),
      Number(importYear),
    );
  }

  function downloadFilteredExpenses() {
    const headers = [
      "Specialist",
      "HR ID",
      "Date",
      "Trip ID",
      "From",
      "To",
      "Transport",
      "Travel",
      "Meeting",
      "Allowance",
      "Total",
      "Status",
      "HR Approved",
      "Comment",
    ];
    const escapeCsv = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const rows = records.map((record) => [
      record.specialist,
      record.hrId ?? "",
      formatPayrollDate(record.date),
      record.tripId,
      record.from,
      record.to,
      record.transportationType,
      record.travelCost,
      record.meetingAmount,
      record.allowance,
      record.total,
      record.status,
      approvalFor(record).hrApproved ? "Approved" : "",
      approvalFor(record).hrComment,
    ]);
    const csv = [headers, ...rows].map((row) => row.map(escapeCsv).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `expenses-filtered-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Card className={`${panelClassName} overflow-hidden p-0`}>
      <div className="relative overflow-hidden border-b border-[#1F2937] bg-[radial-gradient(circle_at_top_right,rgba(249,115,22,0.24),transparent_34%),linear-gradient(135deg,#080B10_0%,#111827_58%,#24150D_100%)] px-5 py-6 text-white">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-16 -top-20 h-48 w-48 rounded-full bg-[#F97316]/20 blur-3xl"
        />
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="relative z-10">
            <p className="inline-flex rounded-full border border-[#F97316]/35 bg-[#F97316]/12 px-3 py-1 text-[11px] font-black uppercase tracking-[0.22em] text-[#FDBA74]">
              Expense Operations
            </p>
            <h2 className="mt-3 text-2xl font-black tracking-tight text-white">Expenses Report</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[#CBD5E1]">
              {analysis
                ? `${analysis.fileName} - ${formatNumber(analysis.summary.trips)} trips saved for review`
                : "Upload an expenses sheet, approve rows from HR, then import approved expenses into payroll."}
            </p>
          </div>
          <div className="relative z-10 flex flex-wrap items-center gap-2">
          <input
            accept=".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            onChange={(event) => onUpload(event.target.files?.[0] ?? null)}
            ref={inputRef}
            type="file"
          />
          <Button
            className="rounded-2xl border border-white/15 bg-white/10 px-3 py-2 text-xs text-white shadow-[0_14px_30px_rgba(0,0,0,0.18)] hover:bg-white/16"
            disabled={analyzing}
            onClick={() => inputRef.current?.click()}
            variant="secondary"
          >
            {analyzing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Upload className="mr-2 h-4 w-4" />
            )}
            Upload Expenses
          </Button>
          <Button
            className="rounded-2xl border border-white/15 bg-white/10 px-3 py-2 text-xs text-white shadow-[0_14px_30px_rgba(0,0,0,0.18)] hover:bg-white/16"
            disabled={!analysis || records.length === 0}
            onClick={downloadFilteredExpenses}
            variant="secondary"
          >
            <Download className="mr-2 h-4 w-4" />
            Download Expenses
          </Button>
          <Button
            className="rounded-2xl border border-[#FDBA74]/40 bg-[#F97316] px-3 py-2 text-xs text-white shadow-[0_14px_30px_rgba(249,115,22,0.22)] hover:bg-[#EA580C]"
            disabled={!analysis || savingApprovals}
            onClick={saveApprovals}
            variant="secondary"
          >
            {savingApprovals ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <FileCheck2 className="mr-2 h-4 w-4" />
            )}
            Save HR Approvals
          </Button>
          </div>
        </div>
      </div>

      <div className="space-y-4 p-5">
      {error && <ExpenseErrorBanner message={error} />}

      {reports.length > 0 && (
        <div className="overflow-hidden rounded-[28px] border border-[#D8E0EA] bg-white/94 shadow-[0_16px_38px_rgba(15,23,42,0.07)]">
          <input
            accept=".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            onChange={(event) => {
              onReplaceReport(replaceReportId ?? "", event.target.files?.[0] ?? null);
              event.target.value = "";
            }}
            ref={replaceReportInputRef}
            type="file"
          />
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#E2E8F0] bg-[linear-gradient(135deg,#F8FAFC_0%,#FFF7ED_100%)] px-4 py-3">
            <div>
              <h3 className="text-sm font-semibold text-[#0F172A]">Saved Expense Reports</h3>
              <p className="mt-0.5 text-xs text-[#64748B]">
                Preview, replace, or delete uploaded expense reports from the system database.
              </p>
            </div>
            <Badge variant="neutral">{formatNumber(reports.length)} reports</Badge>
          </div>
          <div className="divide-y divide-slate-100">
            {reports.slice(0, 12).map((report) => (
              <div
                className={cn(
                  "flex flex-wrap items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-[#FFF7ED]/70",
                  selectedReportId === report.id && "bg-emerald-50/80 ring-1 ring-inset ring-emerald-200",
                )}
                key={report.id}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-text">{report.fileName}</p>
                  <p className="text-xs text-text-secondary">
                    {formatNumber(report.rowCount)} rows - {formatPayrollDate(report.tripDateFrom)} to {formatPayrollDate(report.tripDateTo)} - uploaded {formatPayrollDate(report.createdAt)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <div className="mr-2 text-right">
                    <p className="font-mono text-sm font-semibold text-text">{formatEGP(report.totalExpenses)}</p>
                    <p className="text-xs text-text-secondary">{formatNumber(report.approvedRows)} approved</p>
                  </div>
                  <Button className="px-3 py-1.5 text-xs" onClick={() => onSelectReport(report.id)} variant="secondary">
                    <FileSpreadsheet className="mr-2 h-3.5 w-3.5" />
                    Preview
                  </Button>
                  <Button
                    className="px-3 py-1.5 text-xs"
                    disabled={replacingReportId === report.id}
                    onClick={() => {
                      setReplaceReportId(report.id);
                      replaceReportInputRef.current?.click();
                    }}
                    variant="secondary"
                  >
                    {replacingReportId === report.id ? (
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Upload className="mr-2 h-3.5 w-3.5" />
                    )}
                    Replace
                  </Button>
                  <Button
                    className="px-3 py-1.5 text-xs"
                    disabled={deletingReportId === report.id}
                    onClick={() => onDeleteReport(report.id)}
                    variant="secondary"
                  >
                    {deletingReportId === report.id ? (
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="mr-2 h-3.5 w-3.5" />
                    )}
                    Delete
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {analysis ? (
        <div className="space-y-5">
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
            {[
              { label: "Trips", tone: "bg-[#F8FAFC] text-[#0F172A]", value: formatNumber(analysis.summary.trips) },
              { label: "Specialists", tone: "bg-[#F8FAFC] text-[#0F172A]", value: formatNumber(analysis.summary.specialists) },
              { label: "Filtered Total", tone: "bg-orange-50 text-orange-800", value: formatEGP(filteredTotal) },
              { label: "Travel Cost", tone: "bg-amber-50 text-amber-800", value: formatEGP(analysis.summary.totalTravelCost) },
              { label: "HR Approved", tone: "bg-emerald-50 text-emerald-800", value: formatEGP(approvedTotal) },
              { label: "Unmapped", tone: "bg-rose-50 text-rose-800", value: formatNumber(unmappedRecords.length) },
            ].map((metric) => (
              <div className={cn("rounded-2xl border border-[#E2E8F0] p-4", metric.tone)} key={metric.label}>
                <p className="text-[10px] font-bold uppercase tracking-[0.16em] opacity-70">{metric.label}</p>
                <p className="mt-2 truncate font-mono text-lg font-bold">{metric.value}</p>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2 rounded-[28px] border border-[#D8E0EA] bg-white/90 p-4 shadow-[0_16px_38px_rgba(15,23,42,0.06)]">
            <div className="mr-2">
              <p className="text-sm font-semibold text-[#0F172A]">Import to Payroll</p>
              <p className="text-xs text-[#64748B]">Approved rows with HR ID only.</p>
            </div>
            <select
              className="h-10 rounded-2xl border border-[#D7E0EA] bg-white px-3 text-sm text-[#0F172A] focus:outline-none"
              onChange={(event) => setImportMonth(event.target.value)}
              value={importMonth}
            >
              {payrollMonthsForImport.map((month) => (
                <option key={month.value} value={month.value}>
                  {month.label}
                </option>
              ))}
            </select>
            <select
              className="h-10 rounded-2xl border border-[#D7E0EA] bg-white px-3 text-sm text-[#0F172A] focus:outline-none"
              onChange={(event) => setImportYear(event.target.value)}
              value={importYear}
            >
              {payrollYearsForImport.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </select>
            <Button disabled={!analysis || importingToPayroll} onClick={importToPayroll}>
              {importingToPayroll ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <FileCheck2 className="mr-2 h-4 w-4" />
              )}
              Import to Payroll
            </Button>
            <p className="text-xs text-text-secondary">
              Select the payroll month that will receive the approved expenses.
            </p>
          </div>

          <div className="grid gap-3 rounded-[28px] border border-[#E2E8F0] bg-[#F8FAFC]/80 p-3 md:grid-cols-[1fr_180px_180px_auto]">
            <Input
              className="bg-white"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search specialist, HR ID, route, trip, status..."
              value={search}
            />
            <input
              className="h-10 rounded-lg border border-border bg-white px-3 text-sm text-text focus:outline-none"
              onChange={(event) => setTripDateFrom(event.target.value)}
              type="date"
              value={tripDateFrom}
            />
            <input
              className="h-10 rounded-lg border border-border bg-white px-3 text-sm text-text focus:outline-none"
              onChange={(event) => setTripDateTo(event.target.value)}
              type="date"
              value={tripDateTo}
            />
            <Button
              onClick={() => {
                setSearch("");
                setTripDateFrom("");
                setTripDateTo("");
                setColumnFilters({});
              }}
              variant="secondary"
            >
              Reset {expenseFilterCount > 0 ? `(${expenseFilterCount})` : ""}
            </Button>
          </div>

          <div>
            <div className="min-w-0">
              <div className="overflow-x-auto rounded-[28px] border border-[#E2E8F0] bg-white shadow-[0_16px_38px_rgba(15,23,42,0.06)]">
                <table className="w-full min-w-[1420px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-xs uppercase tracking-[0.12em] text-[#64748B]">
                      {columns.map((column) => (
                        <th className="sticky top-0 z-10 px-3 py-3 font-semibold" key={column.key}>
                          <TableHeaderMenu
                            filterValue={columnFilters[column.key] ?? ""}
                            label={column.label}
                            onFilterChange={(value) =>
                              setColumnFilters((filters) => ({
                                ...filters,
                                [column.key]: value,
                              }))
                            }
                            onSortAsc={() => setSort(column.asc)}
                            onSortDesc={() => setSort(column.desc)}
                          />
                        </th>
                      ))}
                      <th className="sticky top-0 z-10 px-3 py-3 font-semibold">
                        HR Approved
                      </th>
                      <th className="sticky top-0 z-10 px-3 py-3 font-semibold">
                        Comment
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {records.length === 0 ? (
                      <tr>
                        <td className="px-3 py-8 text-center text-sm text-text-secondary" colSpan={columns.length + 2}>
                          No expenses match the current filters.
                        </td>
                      </tr>
                    ) : (
                      records.slice(0, 250).map((record) => (
                        <tr className="transition-colors hover:bg-[#FFF7ED]/65" key={`${record.tripId}-${record.row}`}>
                          <td className="px-3 py-3 font-medium text-text">{record.specialist}</td>
                          <td className="px-3 py-3 font-mono text-xs text-text-secondary">
                            {record.hrId ? record.hrId : (
                              <Badge variant="warning">Not mapped</Badge>
                            )}
                          </td>
                          <td className="px-3 py-3 text-text-secondary">{formatPayrollDate(record.date)}</td>
                          <td className="px-3 py-3 font-mono text-xs text-text-secondary">{record.tripId}</td>
                          <td className="px-3 py-3 text-text-secondary">{record.from || "-"}</td>
                          <td className="px-3 py-3 text-text-secondary">{record.to || "-"}</td>
                          <td className="px-3 py-3 text-text-secondary">{record.transportationType || "-"}</td>
                          <td className="px-3 py-3 font-mono text-xs text-text-secondary">{formatEGP(record.travelCost)}</td>
                          <td className="px-3 py-3 font-mono text-xs text-text-secondary">{formatEGP(record.meetingAmount)}</td>
                          <td className="px-3 py-3 font-mono text-xs text-text-secondary">{formatEGP(record.allowance)}</td>
                          <td className="px-3 py-3 font-mono font-semibold text-text">{formatEGP(record.total)}</td>
                          <td className="px-3 py-3 text-text-secondary">{record.status || "-"}</td>
                          <td className="px-3 py-3">
                            <Switch
                              checked={approvalFor(record).hrApproved}
                              label="Approved by HR"
                              onChange={(checked) =>
                                setApprovals((current) => ({
                                  ...current,
                                  [record.tripId]: {
                                    hrApproved: checked,
                                    hrComment: approvalFor(record).hrComment,
                                  },
                                }))
                              }
                            />
                          </td>
                          <td className="px-3 py-3">
                            <Input
                              className="h-9 min-w-[220px] text-xs"
                              onChange={(event) =>
                                setApprovals((current) => ({
                                  ...current,
                                  [record.tripId]: {
                                    hrApproved: approvalFor(record).hrApproved,
                                    hrComment: event.target.value,
                                  },
                                }))
                              }
                              placeholder="HR comment"
                              value={approvalFor(record).hrComment}
                            />
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              {records.length > 250 ? (
                <p className="mt-3 text-xs text-text-secondary">
                  Showing first 250 rows. Use filters to narrow the expenses report.
                </p>
              ) : null}
            </div>
          </div>

          {analysis.warnings.length > 0 ? (
            <div className="rounded-[20px] border border-[#FDE68A] bg-[#FFFBEB] px-4 py-3 text-sm text-[#92400E]">
              {analysis.warnings.slice(0, 3).join(" ")}
            </div>
          ) : null}
          {(unmappedRecords.length > 0 || missingTripDateRecords.length > 0) && (
            <div className="rounded-[20px] border border-[#FDE68A] bg-[#FFFBEB] px-4 py-3 text-sm text-[#92400E]">
              {unmappedRecords.length > 0
                ? `${formatNumber(unmappedRecords.length)} expenses are not mapped to HR ID. `
                : ""}
              {missingTripDateRecords.length > 0
                ? `${formatNumber(missingTripDateRecords.length)} expenses are missing trip date.`
                : ""}
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-[28px] border border-dashed border-[#CBD5E1] bg-white/70 px-4 py-10 text-center text-sm text-[#64748B] shadow-[inset_0_1px_0_rgba(255,255,255,0.75)]">
          No expenses sheet analyzed yet.
        </div>
      )}
      </div>
    </Card>
  );
}
