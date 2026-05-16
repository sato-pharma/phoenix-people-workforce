"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  formatVacationDate,
  formatVacationTimestamp,
  type LeaveWorkflowAction,
  type LeaveWorkflowStatus,
  loadVacationRequests,
  type VacationPaymentStatus,
  type VacationRequestRecord,
  type VacationRequestType,
  vacationRequestTypeOptions,
} from "@/lib/leave/requests";
import { getWorkflowStatusLabel, leaveWorkflowStatusOptions } from "@/lib/leave/workflow";

type StatusFilter = LeaveWorkflowStatus | "all";
type TypeFilter = VacationRequestType | "all";
type PaymentFilter = VacationPaymentStatus | "all";
type ExportMode = "csv" | "xlsx";
type ExportRowPayload = string[];
type RequestPriority = "normal" | "elevated" | "critical";

function statusClass(status: LeaveWorkflowStatus) {
  if (status === "approved" || status === "awaiting_payout") return "bg-emerald-100 text-emerald-700";
  if (status === "manager_rejected" || status === "hr_rejected" || status === "cancelled") return "bg-rose-100 text-rose-700";
  if (status === "needs_routing") return "bg-orange-100 text-orange-700";
  return "bg-amber-100 text-amber-700";
}

function paymentClass(status: VacationPaymentStatus) {
  if (status === "Paid") return "border-emerald-300 bg-emerald-50 text-emerald-700";
  return "border-rose-300 bg-rose-50 text-rose-700";
}

function normalized(value: string) {
  return value.trim().toLowerCase();
}

function formatMoney(value: number) {
  return `${value.toFixed(2)}`;
}

function statusColor(status: LeaveWorkflowStatus) {
  if (status === "approved" || status === "awaiting_payout") return "#10b981";
  if (status === "manager_rejected" || status === "hr_rejected" || status === "cancelled") return "#f43f5e";
  if (status === "needs_routing") return "#ea580c";
  return "#f59e0b";
}

function priorityLevel(request: VacationRequestRecord): RequestPriority {
  if (request.workflowStatus !== "awaiting_manager" && request.workflowStatus !== "awaiting_hr" && request.workflowStatus !== "needs_routing") return "normal";
  if (request.totalDays >= 10) return "critical";
  if (request.totalDays >= 5) return "elevated";
  return "normal";
}

function priorityClass(level: RequestPriority) {
  if (level === "critical") return "bg-rose-100/70";
  if (level === "elevated") return "bg-amber-100/70";
  return "bg-white";
}

function priorityLineClass(level: RequestPriority) {
  if (level === "critical") return "bg-rose-500";
  if (level === "elevated") return "bg-amber-500";
  return "bg-transparent";
}

function formatDisplay(value: number | string) {
  return typeof value === "number" ? `${value.toFixed(2)}` : value || "—";
}

function isWithinDateWindow(
  request: VacationRequestRecord,
  fromDate: string,
  toDate: string,
) {
  if (!fromDate && !toDate) return true;

  const submittedAt = new Date(request.createdAt);
  if (Number.isNaN(submittedAt.getTime())) return true;

  const start = fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : Number.NEGATIVE_INFINITY;
  const end = toDate ? new Date(`${toDate}T23:59:59`).getTime() : Number.POSITIVE_INFINITY;

  return submittedAt.getTime() >= start && submittedAt.getTime() <= end;
}

function uniqueSorted(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort((left, right) => left.localeCompare(right));
}

function normalizeDash(value: string | undefined) {
  return value && value.trim().length > 0 ? value : "—";
}

function exportHeaders() {
  return [
    "Employee Name",
    "Employee HR ID",
    "Direct Manager",
    "Vacation Type",
    "Day Type",
    "Start Date",
    "End Date",
    "Duration",
    "Paid or Unpaid",
    "Available Balance",
    "Request Status",
    "Request Date",
    "Approval Date",
    "Approved or Rejected By",
    "Rejection Reason",
  ];
}

function toCsvCell(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function buildExportRows(records: VacationRequestRecord[]) {
  return records.map((request) =>
    [
      request.employeeName,
      normalizeDash(request.employeeId),
      normalizeDash(request.directManager),
      request.requestType,
      request.dayType,
      formatVacationDate(request.startDate),
      formatVacationDate(request.endDate),
      formatDisplay(request.totalDays),
      request.paymentStatus,
      formatDisplay(request.availableBalanceAtSubmission),
      request.status,
      formatVacationTimestamp(request.createdAt),
      request.approvalStatusDate ? formatVacationTimestamp(request.approvalStatusDate) : "—",
      normalizeDash(request.approvedOrRejectedBy),
      normalizeDash(request.rejectionReason),
    ] as ExportRowPayload,
  );
}

function buildCsvContent(records: VacationRequestRecord[]) {
  const headers = exportHeaders();
  const rows = buildExportRows(records);
  return `${headers.map(toCsvCell).join(",")}\n${rows.map((row) => row.map((cell) => toCsvCell(String(cell))).join(",")).join("\n")}`;
}

function saveBlob(content: BlobPart, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function VacationReport() {
  const [records, setRecords] = useState<VacationRequestRecord[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [paymentFilter, setPaymentFilter] = useState<PaymentFilter>("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [employeeFilter, setEmployeeFilter] = useState("");
  const [hrIdFilter, setHrIdFilter] = useState("");
  const [managerFilter, setManagerFilter] = useState("");
  const [lineFilter, setLineFilter] = useState("all");
  const [areaFilter, setAreaFilter] = useState("all");
  const [teamFilter, setTeamFilter] = useState("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [rejectionNotes, setRejectionNotes] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [processingDecision, setProcessingDecision] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(10);
  const [isExporting, setIsExporting] = useState<ExportMode | null>(null);
  const processedAutoDecisionRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;

    const load = async () => {
      const result = await loadVacationRequests();
      if (!active) return;
      setRecords(result.requests);
      setLoadError(result.error);
      setIsLoading(false);
    };

    void load();
    return () => {
      active = false;
    };
  }, []);

  const filteredRecords = useMemo(() => {
    const normalizedSearch = normalized(searchTerm);
    const normalizedEmployee = normalized(employeeFilter);
    const normalizedHrId = normalized(hrIdFilter);
    const normalizedManager = normalized(managerFilter);
    const normalizedLine = lineFilter === "all" ? "" : normalized(lineFilter);
    const normalizedArea = areaFilter === "all" ? "" : normalized(areaFilter);
    const normalizedTeam = teamFilter === "all" ? "" : normalized(teamFilter);

    return records
      .filter((request) => {
        const byStatus = statusFilter === "all" || request.workflowStatus === statusFilter;
        const byType = typeFilter === "all" || request.requestType === typeFilter;
        const byPayment = paymentFilter === "all" || request.paymentStatus === paymentFilter;
        const byEmployee =
          !normalizedEmployee || normalized(request.employeeName).includes(normalizedEmployee);
        const byHrId = !normalizedHrId || normalized(request.employeeId).includes(normalizedHrId);
        const byManager =
          !normalizedManager || normalized(request.directManager).includes(normalizedManager);
        const byLine = !normalizedLine || normalized(request.employeeLine).includes(normalizedLine);
        const byArea = !normalizedArea || normalized(request.employeeArea).includes(normalizedArea);
        const byTeam = !normalizedTeam || normalized(request.employeeTeam).includes(normalizedTeam);
        const byDate = isWithinDateWindow(request, fromDate, toDate);
        const bySearch =
          !normalizedSearch ||
          [request.employeeName, request.employeeId, request.employeeEmail, request.requestType, request.directManager, request.employeeLine, request.employeeArea, request.employeeTeam]
            .join(" ")
            .toLowerCase()
            .includes(normalizedSearch);

        return (
          byStatus &&
          byType &&
          byPayment &&
          byEmployee &&
          byHrId &&
          byManager &&
          byLine &&
          byArea &&
          byTeam &&
          byDate &&
          bySearch
        );
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }, [
    areaFilter,
    employeeFilter,
    fromDate,
    hrIdFilter,
    lineFilter,
    managerFilter,
    paymentFilter,
    records,
    searchTerm,
    statusFilter,
    teamFilter,
    toDate,
    typeFilter,
  ]);

  const filterOptions = useMemo(() => {
    return {
      lines: uniqueSorted(records.map((request) => request.employeeLine)),
      areas: uniqueSorted(records.map((request) => request.employeeArea)),
      teams: uniqueSorted(records.map((request) => request.employeeTeam)),
    };
  }, [records]);

  const summary = useMemo(() => {
    const total = filteredRecords.length;
    const totalDays = filteredRecords.reduce((acc, request) => acc + request.totalDays, 0);
    const pending = filteredRecords.filter((request) => request.workflowStatus === "awaiting_manager" || request.workflowStatus === "awaiting_hr" || request.workflowStatus === "needs_routing").length;
    const approved = filteredRecords.filter((request) => request.status === "Approved").length;
    const rejected = filteredRecords.filter((request) => request.status === "Rejected").length;

    return { total, totalDays, pending, approved, rejected };
  }, [filteredRecords]);

  const totalPages = Math.max(1, Math.ceil(filteredRecords.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStart = filteredRecords.length > 0 ? (currentPage - 1) * pageSize + 1 : 0;
  const pageEnd = Math.min(currentPage * pageSize, filteredRecords.length);
  const currentPageRecords = filteredRecords.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );

  const visiblePages = useMemo(() => {
    const pages: number[] = [];
    const maxVisible = 5;
    const startPage = Math.max(1, currentPage - 2);
    const endPage = Math.min(totalPages, startPage + maxVisible - 1);
    for (let pageNumber = startPage; pageNumber <= endPage; pageNumber += 1) {
      pages.push(pageNumber);
    }
    return pages;
  }, [currentPage, totalPages]);

  const clearFilters = () => {
    setSearchTerm("");
    setEmployeeFilter("");
    setHrIdFilter("");
    setManagerFilter("");
    setStatusFilter("all");
    setTypeFilter("all");
    setPaymentFilter("all");
    setFromDate("");
    setToDate("");
    setLineFilter("all");
    setAreaFilter("all");
    setTeamFilter("all");
    setPage(1);
  };

  const updateRejectionReason = (requestId: string, value: string) => {
    setRejectionNotes((current) => ({
      ...current,
      [requestId]: value,
    }));
  };

  const executeDecision = async (
    request: VacationRequestRecord,
    decision: "approve" | "reject",
    rejectionReason?: string,
  ) => {
    const decisionKey = `${request.id}:${decision}`;
    setActionError(null);
    setActionMessage(null);
    setProcessingDecision(decisionKey);

    const normalizedRejectionReason = decision === "reject" ? normalized(rejectionReason ?? "") : "";

    try {
      const response = await fetch("/api/vacation-requests/workflow", {
        body: JSON.stringify({
          action: "decide",
          requestId: request.id,
          decision,
          rejectionReason:
            decision === "reject" && normalizedRejectionReason.length > 0
              ? rejectionReason?.trim() ?? ""
              : "",
        }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as {
        data?: {
          requestSnapshot?: Partial<VacationRequestRecord>;
        };
        error?: string;
        success?: boolean;
      };

      if (!response.ok || !payload.success) {
        setActionError(payload.error || "Workflow decision failed.");
        return;
      }

      setActionMessage(
        `Request ${decision === "approve" ? "approved" : "rejected"} successfully.`,
      );

      const requestSnapshot = payload.data?.requestSnapshot;
      const requestRecord = requestSnapshot
        ? (requestSnapshot as VacationRequestRecord)
        : ({
            ...request,
            status: decision === "approve" ? "Approved" : "Rejected",
            rejectionReason: decision === "reject" ? normalizedRejectionReason : "",
            approvalStatusDate: new Date().toISOString(),
          } as VacationRequestRecord);

      setRecords((current) =>
        current.map((item) => (item.id === request.id ? requestRecord : item)),
      );

      setRejectionNotes((current) => {
        const next = { ...current };
        if (decision === "approve") {
          delete next[request.id];
        }
        return next;
      });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Unable to submit decision.");
    } finally {
      setProcessingDecision(null);
    }
  };

  const handleExportCsv = () => {
    setIsExporting("csv");
    if (filteredRecords.length === 0) {
      setActionMessage("No records match the current filters to export.");
      setIsExporting(null);
      return;
    }

    const content = buildCsvContent(filteredRecords);
    try {
      saveBlob(content, "vacation-report.csv", "text/csv;charset=utf-8;");
      setActionMessage("CSV exported from current filters.");
    } catch {
      setActionError("Unable to download CSV export.");
    } finally {
      setIsExporting(null);
    }
  };

  const handleExportXlsx = async () => {
    if (filteredRecords.length === 0) {
      setActionMessage("No records match the current filters to export.");
      return;
    }

    setIsExporting("xlsx");
    try {
      const xlsx = await import("xlsx");
      const headers = exportHeaders();
      const rows = buildExportRows(filteredRecords);
      const workbook = xlsx.utils.book_new();
      const worksheet = xlsx.utils.aoa_to_sheet([headers, ...rows]);
      xlsx.utils.book_append_sheet(workbook, worksheet, "Vacation Report");

      const output = xlsx.write(workbook, {
        bookType: "xlsx",
        type: "array",
      }) as ArrayBuffer | Uint8Array;

      const blobData = typeof output === "string" ? new TextEncoder().encode(output) : new Uint8Array(output);
      saveBlob(
        blobData,
        "vacation-report.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      setActionMessage("XLSX exported from current filters.");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Unable to generate XLSX export.");
    } finally {
      setIsExporting(null);
    }
  };

  useEffect(() => {
    setPage(1);
  }, [
    areaFilter,
    employeeFilter,
    fromDate,
    hrIdFilter,
    lineFilter,
    managerFilter,
    paymentFilter,
    searchTerm,
    statusFilter,
    teamFilter,
    toDate,
    typeFilter,
  ]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestId = params.get("requestId");
    const decision = params.get("decision");
    if (!requestId || (decision !== "approve" && decision !== "reject")) {
      return;
    }

    const token = `${requestId}:${decision}`;
    if (processedAutoDecisionRef.current === token) return;

    const request = records.find((item) => item.id === requestId);
    if (!request) {
      setActionError(`No matching request found for automatic decision link (${requestId}).`);
      processedAutoDecisionRef.current = token;
      window.history.replaceState({}, "", window.location.pathname);
      return;
    }

    if (!request.allowedActions.includes(decision as LeaveWorkflowAction)) {
      setActionMessage(`Request is currently ${getWorkflowStatusLabel(request.workflowStatus).toLowerCase()}.`);
      processedAutoDecisionRef.current = token;
      window.history.replaceState({}, "", window.location.pathname);
      return;
    }

    processedAutoDecisionRef.current = token;
    void executeDecision(request, decision);
    window.history.replaceState({}, "", window.location.pathname);
  }, [records]);

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-200 bg-gradient-to-r from-white to-[#F8FAFC] p-5 shadow-sm">
        <h1 className="text-xl font-black text-slate-900">Vacation Report</h1>
        <p className="mt-1 text-sm text-slate-600">
          Clean enterprise view of all leave requests with decision status and full request details.
        </p>
      </div>

      {loadError ? <p className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">{loadError}</p> : null}
      {isLoading ? <p className="rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-600">Loading vacation requests...</p> : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Card>
          <p className="text-sm font-semibold text-slate-500">Total Requests</p>
          <p className="mt-2 text-2xl font-black text-slate-900">{summary.total}</p>
        </Card>
        <Card>
          <p className="text-sm font-semibold text-slate-500">Total Days</p>
          <p className="mt-2 text-2xl font-black text-[#065F46]">{summary.totalDays.toFixed(2)}</p>
        </Card>
        <Card>
          <p className="text-sm font-semibold text-slate-500">Pending</p>
          <p className="mt-2 text-2xl font-black text-amber-700">{summary.pending}</p>
        </Card>
        <Card>
          <p className="text-sm font-semibold text-slate-500">Approved</p>
          <p className="mt-2 text-2xl font-black text-emerald-700">{summary.approved}</p>
        </Card>
        <Card>
          <p className="text-sm font-semibold text-slate-500">Rejected</p>
          <p className="mt-2 text-2xl font-black text-rose-700">{summary.rejected}</p>
        </Card>
      </div>

      <Card>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          <label className="space-y-1.5">
            <span className="text-xs font-semibold text-slate-500">Search</span>
            <Input
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Search by employee, HR ID, manager, type..."
              value={searchTerm}
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-semibold text-slate-500">Employee</span>
            <Input
              onChange={(event) => setEmployeeFilter(event.target.value)}
              placeholder="Employee name"
              value={employeeFilter}
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-semibold text-slate-500">Employee HR ID</span>
            <Input
              onChange={(event) => setHrIdFilter(event.target.value)}
              placeholder="HR ID"
              value={hrIdFilter}
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-semibold text-slate-500">Direct Manager</span>
            <Input
              onChange={(event) => setManagerFilter(event.target.value)}
              placeholder="Manager name"
              value={managerFilter}
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-semibold text-slate-500">Vacation Type</span>
            <select
              className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900"
              onChange={(event) => setTypeFilter(event.target.value as TypeFilter)}
              value={typeFilter}
            >
              <option value="all">All</option>
              {vacationRequestTypeOptions.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-semibold text-slate-500">Request Status</span>
            <select
              className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900"
              onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
              value={statusFilter}
            >
              <option value="all">All</option>
              {leaveWorkflowStatusOptions.map((status) => (
                <option key={status} value={status}>
                  {getWorkflowStatusLabel(status)}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-semibold text-slate-500">Paid / Unpaid</span>
            <select
              className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900"
              onChange={(event) => setPaymentFilter(event.target.value as PaymentFilter)}
              value={paymentFilter}
            >
              <option value="all">All</option>
              <option value="Paid">Paid</option>
              <option value="Unpaid">Unpaid</option>
            </select>
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-semibold text-slate-500">Request Date From</span>
            <Input onChange={(event) => setFromDate(event.target.value)} type="date" value={fromDate} />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-semibold text-slate-500">Request Date To</span>
            <Input onChange={(event) => setToDate(event.target.value)} type="date" value={toDate} />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-semibold text-slate-500">Line</span>
            <select
              className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900"
              onChange={(event) => setLineFilter(event.target.value)}
              value={lineFilter}
            >
              <option value="all">All</option>
              {filterOptions.lines.map((line) => (
                <option key={line} value={line}>
                  {line}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-semibold text-slate-500">Area</span>
            <select
              className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900"
              onChange={(event) => setAreaFilter(event.target.value)}
              value={areaFilter}
            >
              <option value="all">All</option>
              {filterOptions.areas.map((area) => (
                <option key={area} value={area}>
                  {area}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-semibold text-slate-500">Team</span>
            <select
              className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900"
              onChange={(event) => setTeamFilter(event.target.value)}
              value={teamFilter}
            >
              <option value="all">All</option>
              {filterOptions.teams.map((team) => (
                <option key={team} value={team}>
                  {team}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex flex-wrap gap-2">
            <Button
              disabled={isExporting === "csv" || filteredRecords.length === 0}
              onClick={handleExportCsv}
              size="sm"
              type="button"
              variant="outline"
            >
              Export CSV
            </Button>
            <Button
              disabled={isExporting === "xlsx" || filteredRecords.length === 0}
              onClick={handleExportXlsx}
              size="sm"
              type="button"
            >
              {isExporting === "xlsx" ? "Exporting XLSX..." : "Export XLSX"}
            </Button>
          </div>
          <button
            className="text-sm font-semibold text-[#0f766e] underline decoration-[#0f766e] underline-offset-4"
            onClick={clearFilters}
            type="button"
          >
            Clear filters
          </button>
        </div>
      </Card>

      <Card>
        {actionError ? (
          <p className="mb-3 rounded-md bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-700">
            {actionError}
          </p>
        ) : null}
        {actionMessage ? (
          <p className="mb-3 rounded-md bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700">
            {actionMessage}
          </p>
        ) : null}

        {currentPageRecords.length === 0 ? (
          <p className="rounded-md bg-slate-50 px-4 py-6 text-sm text-slate-600">
            No vacation requests match the selected filters.
          </p>
        ) : (
          <>
            <div className="hidden md:block">
              <div className="max-h-[70vh] overflow-x-auto overflow-y-auto rounded-lg border border-slate-200">
                <table className="min-w-[1500px] w-full text-sm">
                  <thead className="sticky top-0 z-20 bg-slate-50">
                    <tr className="text-left text-xs font-semibold tracking-wide text-slate-600">
                      <th className="border-b border-slate-200 px-3 py-2">Employee Name</th>
                      <th className="border-b border-slate-200 px-3 py-2">Employee HR ID</th>
                      <th className="border-b border-slate-200 px-3 py-2">Direct Manager</th>
                      <th className="border-b border-slate-200 px-3 py-2">Vacation Type</th>
                      <th className="border-b border-slate-200 px-3 py-2">Day Type</th>
                      <th className="border-b border-slate-200 px-3 py-2">Start Date</th>
                      <th className="border-b border-slate-200 px-3 py-2">End Date</th>
                      <th className="border-b border-slate-200 px-3 py-2">Duration</th>
                      <th className="border-b border-slate-200 px-3 py-2">Paid / Unpaid</th>
                      <th className="border-b border-slate-200 px-3 py-2">Available Balance</th>
                      <th className="border-b border-slate-200 px-3 py-2">Request Status</th>
                      <th className="border-b border-slate-200 px-3 py-2">Request Date</th>
                      <th className="border-b border-slate-200 px-3 py-2">Approval Date</th>
                      <th className="border-b border-slate-200 px-3 py-2">Approved / Rejected By</th>
                      <th className="border-b border-slate-200 px-3 py-2">Rejection Reason</th>
                      <th className="border-b border-slate-200 px-3 py-2">Decision</th>
                    </tr>
                  </thead>
                  <tbody>
                    {currentPageRecords.map((request) => {
                      const priority = priorityLevel(request);
                      const statusLine = statusColor(request.workflowStatus);
                      return (
                        <tr
                          className={`border-b border-slate-200 last:border-none ${priorityClass(priority)}`}
                          key={request.id}
                          style={{
                            borderLeftWidth: "4px",
                            borderLeftStyle: "solid",
                            borderLeftColor: statusLine,
                          }}
                        >
                          <td className="px-3 py-3">
                            <div className="flex gap-2">
                              <span
                                aria-hidden
                                className={`mt-0.5 inline-flex h-8 w-1.5 rounded-full ${priorityLineClass(priority)}`}
                              />
                              <div>
                                <p className="font-semibold text-slate-900">{request.employeeName}</p>
                                <p className="text-xs text-slate-500">{request.employeeEmail || "No email"}</p>
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-3 text-slate-700">{request.employeeId || "—"}</td>
                          <td className="px-3 py-3 text-slate-700">{request.directManager || "—"}</td>
                          <td className="px-3 py-3 text-slate-700">{request.requestType}</td>
                          <td className="px-3 py-3 text-slate-700">{request.dayType}</td>
                          <td className="px-3 py-3 text-slate-700">{formatVacationDate(request.startDate)}</td>
                          <td className="px-3 py-3 text-slate-700">{formatVacationDate(request.endDate)}</td>
                          <td className="px-3 py-3 text-slate-700">{formatMoney(request.totalDays)} day(s)</td>
                          <td className="px-3 py-3">
                            <span className={`inline-flex rounded-full border px-2 py-1 text-xs font-semibold ${paymentClass(request.paymentStatus)}`}>
                              {request.paymentStatus}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-slate-700">{formatMoney(request.availableBalanceAtSubmission)}</td>
                          <td className="px-3 py-3">
                            <span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${statusClass(request.workflowStatus)}`}>
                              {getWorkflowStatusLabel(request.workflowStatus)}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-slate-500">{formatVacationTimestamp(request.createdAt)}</td>
                          <td className="px-3 py-3 text-slate-500">
                            {request.approvalStatusDate ? formatVacationTimestamp(request.approvalStatusDate) : "—"}
                          </td>
                          <td className="px-3 py-3 text-slate-700">{request.approvedOrRejectedBy || "—"}</td>
                          <td className="px-3 py-3 text-slate-700 max-w-[220px]">
                            <p className="line-clamp-2">{request.rejectionReason || "—"}</p>
                          </td>
                          <td className="px-3 py-3">
                            {request.allowedActions.includes("approve" as LeaveWorkflowAction) || request.allowedActions.includes("reject" as LeaveWorkflowAction) ? (
                              <div className="grid gap-2">
                                <div className="flex gap-2">
                                  <Button
                                    disabled={processingDecision === `${request.id}:approve`}
                                    onClick={() => executeDecision(request, "approve")}
                                    size="sm"
                                    type="button"
                                    variant="default"
                                  >
                                    {processingDecision === `${request.id}:approve` ? "Approving..." : "Approve"}
                                  </Button>
                                  <Button
                                    disabled={processingDecision === `${request.id}:reject`}
                                    onClick={() => executeDecision(request, "reject", rejectionNotes[request.id])}
                                    size="sm"
                                    type="button"
                                    variant="outline"
                                  >
                                    {processingDecision === `${request.id}:reject` ? "Rejecting..." : "Reject"}
                                  </Button>
                                </div>
                                <Input
                                  onChange={(event) => updateRejectionReason(request.id, event.target.value)}
                                  placeholder="Optional rejection reason"
                                  value={rejectionNotes[request.id] ?? ""}
                                />
                              </div>
                            ) : (
                              <span className="text-xs font-semibold text-slate-500">No action</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="space-y-3 md:hidden">
              {currentPageRecords.map((request) => {
                const priority = priorityLevel(request);
                return (
                  <Card
                    className={`rounded-lg border-slate-200 p-0 ${priorityClass(priority)}`}
                    key={request.id}
                    style={{
                      borderLeftWidth: "4px",
                      borderLeftStyle: "solid",
                      borderLeftColor: statusColor(request.workflowStatus),
                    }}
                  >
                    <div className="flex flex-col gap-3 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="space-y-1">
                          <div className="flex items-start gap-2">
                            <span
                              aria-hidden
                              className={`mt-0.5 inline-flex h-8 w-1.5 rounded-full ${priorityLineClass(priority)}`}
                            />
                            <div>
                              <p className="text-sm font-black text-slate-900">{request.employeeName}</p>
                              <p className="text-xs text-slate-500">{normalizeDash(request.employeeEmail)}</p>
                              <p className="text-xs text-slate-500">HR ID: {normalizeDash(request.employeeId)}</p>
                            </div>
                          </div>
                        </div>
                        <div className="flex flex-wrap justify-end gap-2">
                          <span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${paymentClass(request.paymentStatus)}`}>
                            {request.paymentStatus}
                          </span>
                          <span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${statusClass(request.workflowStatus)}`}>
                            {getWorkflowStatusLabel(request.workflowStatus)}
                          </span>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-sm">
                        <p className="text-slate-700"><span className="font-semibold text-slate-500">Manager:</span> {normalizeDash(request.directManager)}</p>
                        <p className="text-slate-700"><span className="font-semibold text-slate-500">Type:</span> {request.requestType}</p>
                        <p className="text-slate-700"><span className="font-semibold text-slate-500">Day Type:</span> {request.dayType}</p>
                        <p className="text-slate-700"><span className="font-semibold text-slate-500">From:</span> {formatVacationDate(request.startDate)}</p>
                        <p className="text-slate-700"><span className="font-semibold text-slate-500">To:</span> {formatVacationDate(request.endDate)}</p>
                        <p className="text-slate-700"><span className="font-semibold text-slate-500">Duration:</span> {formatMoney(request.totalDays)} day(s)</p>
                        <p className="text-slate-700"><span className="font-semibold text-slate-500">Balance:</span> {formatMoney(request.availableBalanceAtSubmission)}</p>
                        <p className="text-slate-700"><span className="font-semibold text-slate-500">Request:</span> {formatVacationTimestamp(request.createdAt)}</p>
                        <p className="text-slate-700"><span className="font-semibold text-slate-500">Approval:</span> {request.approvalStatusDate ? formatVacationTimestamp(request.approvalStatusDate) : "—"}</p>
                        <p className="col-span-2 text-slate-700"><span className="font-semibold text-slate-500">By:</span> {normalizeDash(request.approvedOrRejectedBy)}</p>
                        <p className="col-span-2 text-slate-700">
                          <span className="font-semibold text-slate-500">Rejection Reason:</span> {normalizeDash(request.rejectionReason)}
                        </p>
                      </div>
                      <div className="border-t border-slate-200 pt-2">
                        {request.allowedActions.includes("approve" as LeaveWorkflowAction) || request.allowedActions.includes("reject" as LeaveWorkflowAction) ? (
                          <div className="grid gap-2">
                            <div className="flex flex-wrap gap-2">
                              <Button
                                disabled={processingDecision === `${request.id}:approve`}
                                onClick={() => executeDecision(request, "approve")}
                                size="sm"
                                type="button"
                                variant="default"
                              >
                                {processingDecision === `${request.id}:approve` ? "Approving..." : "Approve"}
                              </Button>
                              <Button
                                disabled={processingDecision === `${request.id}:reject`}
                                onClick={() => executeDecision(request, "reject", rejectionNotes[request.id])}
                                size="sm"
                                type="button"
                                variant="outline"
                              >
                                {processingDecision === `${request.id}:reject` ? "Rejecting..." : "Reject"}
                              </Button>
                            </div>
                            <Input
                              onChange={(event) => updateRejectionReason(request.id, event.target.value)}
                              placeholder="Optional rejection reason"
                              value={rejectionNotes[request.id] ?? ""}
                            />
                          </div>
                        ) : (
                          <span className="text-xs font-semibold text-slate-500">No action</span>
                        )}
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
              <p className="text-sm text-slate-600">
                Showing {pageStart}-{pageEnd} of {filteredRecords.length}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  disabled={currentPage <= 1}
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Previous
                </Button>
                {visiblePages.map((pageNumber) => (
                  <Button
                    key={pageNumber}
                    className={pageNumber === currentPage ? "bg-[#0f766e] text-white hover:bg-[#115e59]" : ""}
                    onClick={() => setPage(pageNumber)}
                    size="sm"
                    type="button"
                    variant={pageNumber === currentPage ? "default" : "outline"}
                  >
                    {pageNumber}
                  </Button>
                ))}
                <Button
                  disabled={currentPage >= totalPages}
                  onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
                  size="sm"
                  type="button"
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
