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
  ExpenseAnalysisValidation,
  ExpenseTripRecord,
  PayrollExpenseReport,
} from "@/lib/payroll/types";
import { cn } from "@/lib/utils";

import { panelClassName, payrollMonths } from "./shared";
import { TableHeaderMenu } from "./table-header-menu";
import { SearchableSelect } from "@/components/ui/searchable-select";


function formatEGP(value: number) {
  return formatCurrencyValue(value);
}

function formatNumber(value: number) {
  return formatNumberValue(value);
}

function formatPayrollDate(value: string | null | undefined) {
  return formatDateValue(value);
}

const expenseTemplateHeaders = [
  "TripID",
  "Employee",
  "HR ID",
  "Role",
  "Start Date",
  "End Date",
  "Expense Type",
  "Transported By",
  "Travel Stay Type",
  "To",
  "Destination",
  "KM",
  "Travel Cost (auto)",
  "Meeting Amount",
  "Allowance",
  "Total",
  "AM Workload",
  "PM Workload",
  "Status",
  "Comments",
] as const;

type ExpenseTemplateHeader = (typeof expenseTemplateHeaders)[number];
type ExpenseTemplateRow = Record<ExpenseTemplateHeader, Date | string | number>;

function expenseTemplateComment(record: ExpenseTripRecord, hrApprovalState: { hrComment: string; hrApproved: boolean }) {
  return [record.hrNotes, hrApprovalState.hrComment]
    .filter(Boolean)
    .join(" | ");
}

function escapeForExcel(value: unknown) {
  const textValue = String(value ?? "");
  return /^[=+\-@]/.test(textValue) ? `'${textValue}` : textValue;
}

type ExpenseReviewColumnKey = keyof ExpenseTripRecord | "validation";

const expenseCurrencyKeys = new Set<ExpenseReviewColumnKey>([
  "allowance",
  "meetingAmount",
  "other",
  "total",
  "travelCost",
]);

const expenseNumericKeys = new Set<ExpenseReviewColumnKey>([
  "amWorkload",
  "km",
  "pmWorkload",
  "row",
]);

const expenseDateKeys = new Set<ExpenseReviewColumnKey>(["date", "toDate"]);

const expenseReviewColumns: Array<{
  className?: string;
  key: ExpenseReviewColumnKey;
  label: string;
}> = [
  { className: "min-w-[130px]", key: "validation", label: "Validation" },
  { className: "min-w-[90px]", key: "row", label: "Source Row" },
  { className: "min-w-[130px]", key: "tripId", label: "Trip ID" },
  { className: "min-w-[180px]", key: "specialist", label: "Employee" },
  { className: "min-w-[120px]", key: "hrId", label: "HR ID" },
  { className: "min-w-[140px]", key: "requestType", label: "Expense Type" },
  { className: "min-w-[150px]", key: "tripType", label: "Travel Stay Type" },
  { className: "min-w-[150px]", key: "date", label: "Start Date" },
  { className: "min-w-[150px]", key: "toDate", label: "End Date" },
  { className: "min-w-[240px]", key: "from", label: "From" },
  { className: "min-w-[180px]", key: "to", label: "To" },
  { className: "min-w-[280px]", key: "location", label: "Destination" },
  { className: "min-w-[150px]", key: "transportationType", label: "Transported By" },
  { className: "min-w-[100px]", key: "km", label: "KM" },
  { className: "min-w-[130px]", key: "travelCost", label: "Travel Cost" },
  { className: "min-w-[140px]", key: "meetingAmount", label: "Meeting Amount" },
  { className: "min-w-[120px]", key: "allowance", label: "Allowance" },
  { className: "min-w-[120px]", key: "total", label: "Total" },
  { className: "min-w-[120px]", key: "amWorkload", label: "AM Workload" },
  { className: "min-w-[120px]", key: "pmWorkload", label: "PM Workload" },
  { className: "min-w-[300px]", key: "description", label: "Description" },
  { className: "min-w-[160px]", key: "status", label: "Status" },
  { className: "min-w-[160px]", key: "hr", label: "HR Status" },
  { className: "min-w-[300px]", key: "hrNotes", label: "HR Notes" },
  { className: "min-w-[120px]", key: "open", label: "Open" },
];

function expenseRecordIssues(record: ExpenseTripRecord) {
  const issues: string[] = [];
  const calculatedTotal = record.travelCost + record.meetingAmount + record.allowance;

  if (!record.hrId) issues.push("Missing HR ID");
  if (!record.date) issues.push("Missing date");
  if (!record.to && !record.location) issues.push("Missing destination");
  if (record.total <= 0) issues.push("Zero total");
  if (record.total > 0 && Math.abs(record.total - calculatedTotal) > 1) issues.push("Total mismatch");

  return issues;
}

function expenseColumnRawValue(record: ExpenseTripRecord, key: ExpenseReviewColumnKey) {
  if (key === "validation") {
    const issues = expenseRecordIssues(record);
    return issues.length > 0 ? issues.join(", ") : "Ready";
  }

  return record[key] ?? "";
}

function expenseColumnDisplayValue(record: ExpenseTripRecord, key: ExpenseReviewColumnKey) {
  if (key === "validation") return expenseColumnRawValue(record, key);
  if (expenseDateKeys.has(key)) return formatPayrollDate(String(record[key] ?? ""));
  if (expenseCurrencyKeys.has(key)) return formatEGP(Number(record[key] ?? 0));
  if (expenseNumericKeys.has(key)) return formatNumber(Number(record[key] ?? 0));

  return String(record[key] ?? "") || "-";
}

function buildExpenseValidation(records: ExpenseTripRecord[], warnings: string[] = []): ExpenseAnalysisValidation {
  const missingHrIdRows = records.filter((record) => !record.hrId).length;
  const missingTripDateRows = records.filter((record) => !record.date).length;
  const missingDestinationRows = records.filter((record) => !record.to && !record.location).length;
  const zeroTotalRows = records.filter((record) => record.total <= 0).length;
  const totalMismatchRows = records.filter((record) =>
    record.total > 0 && Math.abs(record.total - (record.travelCost + record.meetingAmount + record.allowance)) > 1,
  ).length;
  const payrollReadyRows = records.filter((record) =>
    record.hrId && record.date && (record.to || record.location) && record.total > 0,
  ).length;
  const errors = records.length === 0 ? ["No expense rows were detected."] : [];

  return {
    errors,
    invalidRows: records.length - payrollReadyRows,
    missingDestinationRows,
    missingHrIdRows,
    missingRequiredColumns: [],
    missingTripDateRows,
    payrollReadyRows,
    recognizedColumns: 0,
    requiredColumns: 0,
    status: errors.length > 0 ? "failed" : warnings.length > 0 || payrollReadyRows < records.length ? "warning" : "passed",
    totalMismatchRows,
    totalRows: records.length,
    warnings,
    zeroTotalRows,
  };
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
        <p className="font-semibold">Outstation expenses analysis error</p>
        <p className="mt-1 leading-6">{message}</p>
      </div>
    </AdminCallout>
  );
}

export function buildExpenseAnalysis(fileName: string, records: ExpenseTripRecord[]): ExpenseAnalysisResult {
  const specialists = Array.from(
    records.reduce((map, record) => {
      const current =
        map.get(record.specialist) ??
        {
          allowance: 0,
          meetingAmount: 0,
          other: 0,
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
      totalOther: records.reduce((sum, record) => sum + (record.other ?? 0), 0),
      totalTravelCost: records.reduce((sum, record) => sum + record.travelCost, 0),
      trips: records.length,
    },
    validation: buildExpenseValidation(records),
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
  onImportToPayroll: (month: number, year: number) => void;
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
        const columnValue = String(expenseColumnRawValue(record, key as ExpenseReviewColumnKey));

        return !filter || columnValue.toLowerCase().includes(filter);
      });

      return matchesTripDate && matchesSearch && matchesColumns;
    });

    return filtered.slice().sort((left, right) => {
      const [key, direction] = sort.split("-");
      const columnKey = key as ExpenseReviewColumnKey;
      const leftValue = expenseColumnRawValue(left, columnKey);
      const rightValue = expenseColumnRawValue(right, columnKey);

      if (expenseCurrencyKeys.has(columnKey) || expenseNumericKeys.has(columnKey)) {
        const leftNumber = Number(leftValue ?? 0);
        const rightNumber = Number(rightValue ?? 0);
        return direction === "desc" ? rightNumber - leftNumber : leftNumber - rightNumber;
      }

      if (expenseDateKeys.has(columnKey)) {
        const leftTime = leftValue ? new Date(String(leftValue)).getTime() : 0;
        const rightTime = rightValue ? new Date(String(rightValue)).getTime() : 0;
        return direction === "desc" ? rightTime - leftTime : leftTime - rightTime;
      }

      return direction === "desc"
        ? String(rightValue).localeCompare(String(leftValue))
        : String(leftValue).localeCompare(String(rightValue));
    });
  }, [analysis?.records, columnFilters, search, sort, tripDateFrom, tripDateTo]);

  const approvedRecords = (analysis?.records ?? []).filter((record) => approvalFor(record).hrApproved);
  const approvedTotal = approvedRecords.reduce((sum, record) => sum + record.total, 0);
  const unmappedRecords = (analysis?.records ?? []).filter((record) => !record.hrId);
  const missingTripDateRecords = (analysis?.records ?? []).filter((record) => !record.date);
  const filteredTotal = records.reduce((sum, record) => sum + record.total, 0);
  const validation = analysis?.validation ?? buildExpenseValidation(analysis?.records ?? []);
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

    onImportToPayroll(Number(importMonth), Number(importYear));
  }

  function downloadFilteredExpenses() {
    void (async () => {
      const ExcelJS = (await import("exceljs")).default;
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Outstation expenses");

      workbook.creator = "Phoenix Workforce";
      workbook.created = new Date();
      sheet.properties.defaultRowHeight = 22;
      sheet.views = [{ state: "frozen", ySplit: 2 }];
      const title = `Outstation expenses - ${records.length} trip(s)`;

      sheet.mergeCells(1, 1, 1, expenseTemplateHeaders.length);
      sheet.getCell("A1").value = title;
      sheet.getCell("A1").alignment = {
        horizontal: "left",
        vertical: "middle",
      };
      sheet.getCell("A1").font = { bold: true, color: { argb: "FFFFFFFF" } };
      sheet.getCell("A1").fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF0F172A" },
      };

      sheet.columns = expenseTemplateHeaders.map((header, index) => ({
        header,
        key: header,
        width: [12, 30, 12, 18, 12, 12, 15, 16, 16, 16, 34, 14, 16, 14, 14, 13, 13, 14, 24, 30][index],
      }));

      const headerRow = sheet.getRow(2);
      headerRow.values = [...expenseTemplateHeaders];
      headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
      headerRow.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF1F2937" },
      };
      headerRow.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      headerRow.height = 28;
      sheet.autoFilter = {
        from: { column: 1, row: 2 },
        to: { column: expenseTemplateHeaders.length, row: 2 },
      };

      const rows: ExpenseTemplateRow[] = records.map((record): ExpenseTemplateRow => {
        const approvalState = approvalFor(record);
        return {
          "TripID": record.tripId,
          "Employee": escapeForExcel(record.specialist),
          "HR ID": record.hrId ?? "",
          "Role": escapeForExcel(record.requestType),
          "Start Date": record.date ? new Date(record.date) : "",
          "End Date": record.toDate ? new Date(record.toDate) : "",
          "Expense Type": escapeForExcel(record.requestType),
          "Transported By": escapeForExcel(record.transportationType),
          "Travel Stay Type": escapeForExcel(record.tripType),
          "To": escapeForExcel(record.to),
          "Destination": escapeForExcel(record.location || record.to),
          "KM": record.km,
          "Travel Cost (auto)": record.travelCost,
          "Meeting Amount": record.meetingAmount,
          "Allowance": record.allowance,
          "Total": record.total,
          "AM Workload": record.amWorkload,
          "PM Workload": record.pmWorkload,
          "Status": escapeForExcel(record.status),
          "Comments": escapeForExcel(expenseTemplateComment(record, approvalState)),
        };
      });

      const rowValues = rows.map((row) => [
        row.TripID,
        row.Employee,
        row["HR ID"],
        row.Role,
        row["Start Date"],
        row["End Date"],
        row["Expense Type"],
        row["Transported By"],
        row["Travel Stay Type"],
        row.To,
        row.Destination,
        row.KM,
        row["Travel Cost (auto)"],
        row["Meeting Amount"],
        row.Allowance,
        row.Total,
        row["AM Workload"],
        row["PM Workload"],
        row.Status,
        row.Comments,
      ]);
      sheet.addRows(rowValues);
      [5, 6].forEach((columnNumber) => {
        sheet.getColumn(columnNumber).numFmt = "yyyy-mm-dd";
      });
      [12, 13, 14, 15, 16, 17, 18].forEach((columnNumber) => {
        sheet.getColumn(columnNumber).numFmt = "#,##0.00";
      });
      sheet.eachRow((row, rowNumber) => {
        row.height = rowNumber === 1 ? 30 : rowNumber === 2 ? 28 : 22;
        row.eachCell({ includeEmpty: true }, (cell) => {
          cell.alignment = {
            horizontal: rowNumber <= 2 ? "center" : "left",
            vertical: "middle",
            wrapText: rowNumber > 1,
          };
          cell.border = {
            bottom: { color: { argb: "FFE5E7EB" }, style: "thin" },
            left: { color: { argb: "FFE5E7EB" }, style: "thin" },
            right: { color: { argb: "FFE5E7EB" }, style: "thin" },
            top: { color: { argb: "FFE5E7EB" }, style: "thin" },
          };
        });
      });
      const output = await workbook.xlsx.writeBuffer();
      const blob = new Blob([output], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `phoenix-outstation-expenses-${new Date().toISOString().slice(0, 10)}.xlsx`;
      link.click();
      URL.revokeObjectURL(url);
    })();
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
              Outstation Expense Operations
            </p>
            <h2 className="mt-3 text-2xl font-black tracking-tight text-white">Outstation Expenses Report</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[#CBD5E1]">
              {analysis
                ? `${analysis.fileName} - ${formatNumber(analysis.summary.trips)} trips saved for review`
                : "Upload a historical outstation expenses sheet, approve rows from HR, then import approved expenses into payroll."}
            </p>
            {analysis?.template ? (
              <p className="mt-2 text-xs leading-6 text-[#FDE68A]">
                {analysis.template.recognized
                  ? `Template recognized: ${analysis.template.name}`
                  : `Template detected: ${analysis.template.name}`}
              </p>
            ) : null}
          </div>
          <div className="relative z-10 flex flex-wrap items-center gap-2">
          <input
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
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
            Upload Historical Expenses
          </Button>
          <Button
            className="rounded-2xl border border-white/15 bg-white/10 px-3 py-2 text-xs text-white shadow-[0_14px_30px_rgba(0,0,0,0.18)] hover:bg-white/16"
            disabled={!analysis || records.length === 0}
            onClick={downloadFilteredExpenses}
            variant="secondary"
          >
            <Download className="mr-2 h-4 w-4" />
            Download Outstation Expenses
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
            Save HR/Admin Approvals
          </Button>
          </div>
        </div>
      </div>

      <div className="space-y-4 p-5">
      {error && <ExpenseErrorBanner message={error} />}

      {reports.length > 0 && (
        <div className="overflow-hidden rounded-[28px] border border-[#D8E0EA] bg-white/94 shadow-[0_16px_38px_rgba(15,23,42,0.07)]">
          <input
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
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
              <h3 className="text-sm font-semibold text-[#0F172A]">Historical Outstation Uploads</h3>
              <p className="mt-0.5 text-xs text-[#64748B]">
                Preview, replace, or delete historical uploaded expense reports from the system database.
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
              { label: "HR/Admin Approved", tone: "bg-emerald-50 text-emerald-800", value: formatEGP(approvedTotal) },
              { label: "Unmapped", tone: "bg-rose-50 text-rose-800", value: formatNumber(unmappedRecords.length) },
            ].map((metric) => (
              <div className={cn("rounded-2xl border border-[#E2E8F0] p-4", metric.tone)} key={metric.label}>
                <p className="text-[10px] font-bold uppercase tracking-[0.16em] opacity-70">{metric.label}</p>
                <p className="mt-2 truncate font-mono text-lg font-bold">{metric.value}</p>
              </div>
            ))}
          </div>

          <AdminCallout
            tone={validation.status === "failed" ? "danger" : validation.status === "warning" ? "warning" : "success"}
          >
            {validation.status === "passed" ? (
              <FileCheck2 className="mt-0.5 h-5 w-5 shrink-0" />
            ) : (
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-semibold">
                  Validation {validation.status === "passed" ? "passed" : validation.status === "failed" ? "failed" : "has warnings"}
                </p>
                <Badge variant={validation.status === "passed" ? "success" : validation.status === "failed" ? "danger" : "warning"}>
                  {formatNumber(validation.payrollReadyRows)} payroll-ready / {formatNumber(validation.totalRows)} rows
                </Badge>
              </div>
              <div className="mt-3 grid gap-2 text-xs md:grid-cols-3 xl:grid-cols-6">
                {[
                  ["Template columns", `${formatNumber(validation.recognizedColumns)} / ${formatNumber(validation.requiredColumns)}`],
                  ["Missing HR ID", formatNumber(validation.missingHrIdRows)],
                  ["Missing dates", formatNumber(validation.missingTripDateRows)],
                  ["Missing destination", formatNumber(validation.missingDestinationRows)],
                  ["Zero totals", formatNumber(validation.zeroTotalRows)],
                  ["Total mismatches", formatNumber(validation.totalMismatchRows)],
                ].map(([label, value]) => (
                  <div className="rounded-lg border border-current/10 bg-white/65 px-3 py-2" key={label}>
                    <p className="font-bold uppercase tracking-[0.12em] opacity-70">{label}</p>
                    <p className="mt-1 font-mono text-sm font-semibold">{value}</p>
                  </div>
                ))}
              </div>
              {validation.missingRequiredColumns.length > 0 ? (
                <p className="mt-3 text-xs leading-5">
                  Missing template columns: {validation.missingRequiredColumns.join(", ")}
                </p>
              ) : null}
              {(validation.errors.length > 0 || validation.warnings.length > 0) ? (
                <p className="mt-2 text-xs leading-5">
                  {[...validation.errors, ...validation.warnings].slice(0, 4).join(" ")}
                </p>
              ) : null}
            </div>
          </AdminCallout>

          <div className="flex flex-wrap items-center gap-2 rounded-[28px] border border-[#D8E0EA] bg-white/90 p-4 shadow-[0_16px_38px_rgba(15,23,42,0.06)]">
            <div className="mr-2">
              <p className="text-sm font-semibold text-[#0F172A]">Import to Payroll</p>
              <p className="text-xs text-[#64748B]">Saved HR/admin approved rows with HR ID only.</p>
            </div>
            <SearchableSelect
              className="h-10 rounded-2xl border border-[#D7E0EA] bg-white px-3 text-sm text-[#0F172A] focus:outline-none"
              onChange={(event) => setImportMonth(event.target.value)}
              value={importMonth}
            >
              {payrollMonthsForImport.map((month) => (
                <option key={month.value} value={month.value}>
                  {month.label}
                </option>
              ))}
            </SearchableSelect>
            <SearchableSelect
              className="h-10 rounded-2xl border border-[#D7E0EA] bg-white px-3 text-sm text-[#0F172A] focus:outline-none"
              onChange={(event) => setImportYear(event.target.value)}
              value={importYear}
            >
              {payrollYearsForImport.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </SearchableSelect>
            <Button disabled={!analysis || importingToPayroll || validation.invalidRows > 0} onClick={importToPayroll}>
              {importingToPayroll ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <FileCheck2 className="mr-2 h-4 w-4" />
              )}
              Import to Payroll
            </Button>
            <p className="text-xs text-text-secondary">
              Import requires all rows to pass validation and uses only approvals already saved by HR/admin.
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
              <div className="overflow-x-scroll rounded-[28px] border border-[#E2E8F0] bg-white pb-2 shadow-[0_16px_38px_rgba(15,23,42,0.06)]">
                <table className="w-full min-w-[4100px] table-fixed text-left text-sm">
                  <thead>
                    <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-xs uppercase tracking-[0.12em] text-[#64748B]">
                      {expenseReviewColumns.map((column) => (
                        <th className={cn("sticky top-0 z-10 px-3 py-3 align-top font-semibold", column.className)} key={column.key}>
                          <TableHeaderMenu
                            filterValue={columnFilters[column.key] ?? ""}
                            label={column.label}
                            onFilterChange={(value) =>
                              setColumnFilters((filters) => ({
                                ...filters,
                                [column.key]: value,
                              }))
                            }
                            onSortAsc={() => setSort(`${column.key}-asc`)}
                            onSortDesc={() => setSort(`${column.key}-desc`)}
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
                        <td className="px-3 py-8 text-center text-sm text-text-secondary" colSpan={expenseReviewColumns.length + 2}>
                          No expenses match the current filters.
                        </td>
                      </tr>
                    ) : (
                      records.slice(0, 250).map((record) => {
                        const issues = expenseRecordIssues(record);

                        return (
                        <tr className="transition-colors hover:bg-[#FFF7ED]/65" key={`${record.tripId}-${record.row}`}>
                          {expenseReviewColumns.map((column) => {
                            const rawValue = expenseColumnRawValue(record, column.key);
                            const displayValue = expenseColumnDisplayValue(record, column.key);
                            const isMoney = expenseCurrencyKeys.has(column.key);
                            const isNumeric = expenseNumericKeys.has(column.key);
                            const isLongText = ["description", "from", "hrNotes", "location"].includes(column.key);

                            if (column.key === "validation") {
                              return (
                                <td className={cn("px-3 py-3 align-top", column.className)} key={column.key}>
                                  <Badge variant={issues.length > 0 ? "warning" : "success"}>
                                    {issues.length > 0 ? issues.join(", ") : "Ready"}
                                  </Badge>
                                </td>
                              );
                            }

                            if (column.key === "hrId") {
                              return (
                                <td className={cn("px-3 py-3 align-top font-mono text-xs text-text-secondary", column.className)} key={column.key}>
                                  {record.hrId ? record.hrId : (
                                    <Badge variant="warning">Not mapped</Badge>
                                  )}
                                </td>
                              );
                            }

                            return (
                              <td
                                className={cn(
                                  "px-3 py-3 align-top text-text-secondary",
                                  column.className,
                                  (isMoney || isNumeric) && "text-right font-mono text-xs",
                                  column.key === "total" && "font-semibold text-text",
                                  isLongText && "whitespace-normal break-words leading-5",
                                )}
                                key={column.key}
                                title={String(rawValue ?? "")}
                              >
                                {displayValue}
                              </td>
                            );
                          })}
                          <td className="px-3 py-3">
                            <Switch
                              checked={approvalFor(record).hrApproved}
                              label="Approved by HR/Admin"
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
                              placeholder="HR/admin comment"
                              value={approvalFor(record).hrComment}
                            />
                          </td>
                        </tr>
                        );
                      })
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
