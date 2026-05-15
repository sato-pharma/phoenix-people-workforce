"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Download, FileDown, FileSpreadsheet, Filter, UserRound, UsersRound } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { LeaveRequestFilters, LeaveType, VacationReportData, VacationReportRow, VacationReportWorkspace } from "@/lib/leave/types";
import { cn } from "@/lib/utils";

import {
  buttonClassName,
  fieldClassName,
  formatDate,
  Panel,
  PanelHeader,
  prettyStatus,
  statusVariant,
  SyncedTableContainer,
} from "./leave-ui-primitives";

type VacationReportTabKey = "request" | "my" | "team" | "company";

const reportColumns: Array<{ key: keyof VacationReportRow; label: string; className?: string }> = [
  { key: "employeeHrId", label: "Employee HR ID" },
  { key: "employeeName", label: "Employee Name", className: "min-w-[220px]" },
  { key: "title", label: "Title" },
  { key: "line", label: "Line" },
  { key: "area", label: "Area" },
  { key: "directManager", label: "Direct Manager" },
  { key: "directManagerHrId", label: "Direct Manager HR ID" },
  { key: "requestDate", label: "Request Date" },
  { key: "leaveType", label: "Leave Type" },
  { key: "fromDate", label: "From Date" },
  { key: "toDate", label: "To Date" },
  { key: "duration", label: "Duration" },
  { key: "durationUnit", label: "Duration Unit" },
  { key: "balanceBefore", label: "Balance Before" },
  { key: "balanceAfter", label: "Balance After" },
  { key: "paymentStatus", label: "Payment Status" },
  { key: "managerApprovalStatus", label: "Manager Approval Status" },
  { key: "managerApprovedBy", label: "Manager Approved By" },
  { key: "managerDecisionDate", label: "Manager Decision Date" },
  { key: "hrApprovalStatus", label: "HR Approval Status" },
  { key: "hrApprovedBy", label: "HR Approved By" },
  { key: "hrDecisionDate", label: "HR Decision Date" },
  { key: "finalStatus", label: "Final Status" },
  { key: "reason", label: "Reason", className: "min-w-[260px]" },
  { key: "attachmentStatus", label: "Attachment Status" },
  { key: "createdAt", label: "Created At" },
];

function paymentStatusLabel(status: string) {
  if (status === "paid") return "Paid";
  if (status === "unpaid") return "Unpaid";
  if (status === "non_deducted") return "Non-Deducted";
  return "In Review";
}

function durationUnitLabel(value: string) {
  return value === "full_day" ? "Full Day" : value.toUpperCase();
}

function cellValue(row: VacationReportRow, key: keyof VacationReportRow) {
  const value = row[key];
  if (value === null || value === undefined || value === "") return "-";
  if (key === "requestDate" || key === "managerDecisionDate" || key === "hrDecisionDate" || key === "createdAt") return formatDate(String(value));
  if (key === "fromDate" || key === "toDate") return formatDate(String(value));
  if (key === "durationUnit") return durationUnitLabel(String(value));
  if (key === "paymentStatus") return paymentStatusLabel(String(value));
  if (key === "finalStatus" || key === "managerApprovalStatus" || key === "hrApprovalStatus") return prettyStatus(String(value));
  if (key === "attachmentStatus") return value === "attached" ? "Attached" : "Missing";
  return String(value);
}

function reportHref(scope: VacationReportData["scope"], filters: LeaveRequestFilters) {
  const params = new URLSearchParams({ scope });
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value).length > 0) params.set(key, String(value));
  });
  return `/api/leave/vacation-reports/export?${params.toString()}`;
}

export function VacationReportExportButton({ report }: { report: VacationReportData }) {
  if (!report.canExport) return null;
  return (
    <a className={cn(buttonClassName, "border border-slate-200 bg-white text-slate-800 hover:bg-slate-50")} href={reportHref(report.scope, report.filters)}>
      <Download className="h-4 w-4" />
      Export XLSX
    </a>
  );
}

export function VacationReportFilters({
  action,
  leaveTypes,
  report,
}: {
  action: string;
  leaveTypes: LeaveType[];
  report: VacationReportData;
}) {
  const filters = report.filters;
  const lines = uniqueReportValues(report.rows, (row) => row.line);
  const areas = uniqueReportValues(report.rows, (row) => row.area);
  const managers = uniqueReportValues(report.rows, (row) => row.directManagerHrId);

  return (
    <Panel>
      <PanelHeader description="Filter vacation records by employee, organization, leave type, status, payment, and period." icon={<Filter className="h-5 w-5" />} title={`${report.title} Filters`} />
      <form action={action} className="grid gap-3 p-4 sm:p-5 md:grid-cols-4 xl:grid-cols-6">
        <input className={fieldClassName} defaultValue={filters.employee ?? ""} name="employee" placeholder="Employee" />
        <input className={fieldClassName} defaultValue={filters.employeeHrId ?? ""} name="employeeHrId" placeholder="HR ID" />
        <select className={fieldClassName} defaultValue={filters.line ?? ""} name="line"><option value="">All lines</option>{lines.map((line) => <option key={line}>{line}</option>)}</select>
        <select className={fieldClassName} defaultValue={filters.area ?? ""} name="area"><option value="">All areas</option>{areas.map((area) => <option key={area}>{area}</option>)}</select>
        <input className={fieldClassName} defaultValue={filters.managerHrId ?? ""} name="managerHrId" placeholder="Manager HR ID" list={`${report.scope}-manager-options`} />
        <datalist id={`${report.scope}-manager-options`}>{managers.map((manager) => <option key={manager} value={manager} />)}</datalist>
        <select className={fieldClassName} defaultValue={filters.leaveTypeId ?? ""} name="leaveTypeId"><option value="">All leave types</option>{leaveTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select>
        <select className={fieldClassName} defaultValue={filters.status ?? ""} name="status">
          <option value="">All statuses</option>
          {["pending_manager", "pending_hr", "hr_approved", "manager_rejected", "hr_rejected", "cancelled"].map((status) => <option key={status} value={status}>{prettyStatus(status)}</option>)}
        </select>
        <select className={fieldClassName} defaultValue={filters.paymentStatus ?? ""} name="paymentStatus">
          <option value="">All payment statuses</option>
          {["paid", "unpaid", "in_review", "non_deducted"].map((status) => <option key={status} value={status}>{paymentStatusLabel(status)}</option>)}
        </select>
        <input className={fieldClassName} defaultValue={filters.startDate ?? ""} name="startDate" type="date" />
        <input className={fieldClassName} defaultValue={filters.endDate ?? ""} name="endDate" type="date" />
        <input className={fieldClassName} defaultValue={filters.month ?? ""} max="12" min="1" name="month" placeholder="Month" type="number" />
        <input className={fieldClassName} defaultValue={filters.year ?? ""} min="2024" name="year" placeholder="Year" type="number" />
        <button className={cn(buttonClassName, "bg-slate-950 text-white hover:bg-slate-800")} type="submit">Apply Filters</button>
      </form>
    </Panel>
  );
}

function uniqueReportValues(rows: VacationReportRow[], selector: (row: VacationReportRow) => string | null | undefined) {
  return Array.from(new Set(rows.map(selector).filter(Boolean) as string[])).sort();
}

export function VacationReportTable({ report }: { report: VacationReportData }) {
  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        action={<VacationReportExportButton report={report} />}
        description={`${report.rows.length} vacation record${report.rows.length === 1 ? "" : "s"} in this scope.`}
        icon={<FileSpreadsheet className="h-5 w-5" />}
        title={report.title}
      />
      {report.rows.length === 0 ? (
        <div className="px-5 py-12 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-orange-50 text-orange-600 ring-1 ring-orange-100">
            <FileSpreadsheet className="h-5 w-5" />
          </div>
          <p className="mt-4 text-base font-black text-slate-950">No vacation records found.</p>
          <p className="mt-1 text-sm text-slate-500">Try adjusting filters or date range.</p>
        </div>
      ) : (
        <SyncedTableContainer>
          <table className="w-full min-w-[2900px] text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-[10px] font-black uppercase tracking-[0.14em] text-slate-500">
                {reportColumns.map((column) => <th className={cn("px-4 py-3", column.className)} key={column.key}>{column.label}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {report.rows.map((row) => (
                <tr className="transition hover:bg-slate-50/70" key={row.id}>
                  {reportColumns.map((column) => {
                    const value = cellValue(row, column.key);
                    const isStatus = column.key === "finalStatus" || column.key === "managerApprovalStatus" || column.key === "hrApprovalStatus";
                    const isPayment = column.key === "paymentStatus";
                    const isAttachment = column.key === "attachmentStatus";
                    return (
                      <td className={cn("px-4 py-4 align-top font-semibold text-slate-700", column.className)} key={column.key}>
                        {isStatus ? <Badge variant={statusVariant(String(row[column.key]))}>{value}</Badge> : null}
                        {isPayment ? <Badge variant={row.paymentStatus === "unpaid" ? "danger" : row.paymentStatus === "paid" ? "success" : "warning"}>{value}</Badge> : null}
                        {isAttachment ? <Badge variant={row.attachmentStatus === "attached" ? "success" : "neutral"}>{value}</Badge> : null}
                        {!isStatus && !isPayment && !isAttachment ? value : null}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </SyncedTableContainer>
      )}
    </Panel>
  );
}

export function VacationReportTabs({
  action,
  children,
  defaultTab = "request",
  leaveTypes,
  reports,
  showTemplateDownload = false,
}: {
  action: string;
  children?: React.ReactNode;
  defaultTab?: VacationReportTabKey;
  leaveTypes: LeaveType[];
  reports?: VacationReportWorkspace | null;
  showTemplateDownload?: boolean;
}) {
  const availableTabs = useMemo(() => {
    const tabs: Array<{ key: VacationReportTabKey; label: string; icon: ReactNode; report?: VacationReportData | null }> = [];
    if (children) tabs.push({ key: "request", label: "Vacation Request", icon: <FileDown className="h-4 w-4" /> });
    if (reports?.myReport) tabs.push({ key: "my", label: "My Vacation Report", icon: <UserRound className="h-4 w-4" />, report: reports.myReport });
    if (reports?.teamReport) tabs.push({ key: "team", label: "Team Vacation Report", icon: <UsersRound className="h-4 w-4" />, report: reports.teamReport });
    if (reports?.companyReport) tabs.push({ key: "company", label: "Company Vacation Report", icon: <FileSpreadsheet className="h-4 w-4" />, report: reports.companyReport });
    return tabs;
  }, [children, reports]);
  const resolvedDefaultTab = availableTabs.some((tab) => tab.key === defaultTab) ? defaultTab : availableTabs[0]?.key ?? "my";
  const [activeTab, setActiveTab] = useState<VacationReportTabKey>(resolvedDefaultTab);
  useEffect(() => {
    setActiveTab(resolvedDefaultTab);
  }, [resolvedDefaultTab]);
  const activeReport = availableTabs.find((tab) => tab.key === activeTab)?.report ?? null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[18px] border border-slate-200 bg-white p-2 shadow-[0_12px_30px_rgba(15,23,42,0.05)]">
        <div className="flex flex-wrap gap-2">
          {availableTabs.map((tab) => (
            <button
              className={cn(
                "inline-flex h-10 items-center justify-center gap-2 rounded-xl px-3 text-xs font-black transition",
                activeTab === tab.key ? "bg-slate-950 text-white shadow-sm" : "text-slate-600 hover:bg-slate-50",
              )}
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              type="button"
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>
        {showTemplateDownload ? (
          <a className={cn(buttonClassName, "border border-orange-200 bg-orange-50 text-orange-700 hover:bg-orange-100")} href="/api/leave/historical-vacations/template">
            <Download className="h-4 w-4" />
            Historical Vacation Template Download
          </a>
        ) : null}
      </div>
      {activeTab === "request" ? children : null}
      {activeReport ? (
        <div className="space-y-5">
          <VacationReportFilters action={action} leaveTypes={leaveTypes} report={activeReport} />
          <VacationReportTable report={activeReport} />
        </div>
      ) : null}
    </div>
  );
}
