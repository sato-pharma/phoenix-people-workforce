"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  ArrowUpDown,
  CalendarDays,
  Download,
  FileSpreadsheet,
  FileText,
  ListFilter,
  type LucideIcon,
  MapPin,
  ReceiptText,
  Search,
  Send,
  Upload,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-state";
import type { OutstationExpenseRequest } from "@/lib/outstation/types";

type ActiveTab = "submit" | "input";
type ExpenseStatusFilter = "all" | "submitted" | "approved" | "declined";
type ExpenseOrder = "newest" | "oldest" | "highest_total" | "lowest_total" | "destination";

const expenseExcelHeaders = [
  "Request ID",
  "Employee Name",
  "HR ID",
  "Role",
  "From",
  "To",
  "From Date",
  "To Date",
  "Go Ticket Amount",
  "Return Ticket Amount",
  "Total Ticket Amount",
  "Status",
  "Attachment Count",
  "Note",
  "Submitted At",
];

function egp(value: number) {
  return new Intl.NumberFormat("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}

function formatDate(value: string | null | undefined) {
  if (!value) return "N/A";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function normalizeStatus(value: string) {
  const normalized = value.toLowerCase();
  if (normalized.includes("approve") || normalized.includes("confirm")) return "Approved";
  if (normalized.includes("reject") || normalized.includes("decline")) return "Declined";
  return "Submitted";
}

function statusVariant(status: string): "success" | "danger" | "warning" {
  const normalized = normalizeStatus(status);
  if (normalized === "Approved") return "success";
  if (normalized === "Declined") return "danger";
  return "warning";
}

function Field({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-2 block text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">
        {label}
      </span>
      {children}
    </label>
  );
}

function ReadOnlyField({
  icon: Icon,
  value,
}: {
  icon: LucideIcon;
  value: string;
}) {
  return (
    <div className="flex min-h-12 min-w-0 items-center gap-2 rounded-none border border-slate-200 bg-slate-50 px-4 text-sm font-semibold text-slate-800">
      <Icon className="h-4 w-4 shrink-0 text-orange-500" />
      <span className="min-w-0 whitespace-nowrap">{value}</span>
    </div>
  );
}

function getRequestKey(request: OutstationExpenseRequest) {
  return `${request.id}-${request.createdAt}`;
}

function requestTotal(request: OutstationExpenseRequest) {
  return request.ticketAmount || request.claimedTotalAmount || 0;
}

function requestFromLabel(request: OutstationExpenseRequest) {
  const value = [
    request.residenceAddress,
    request.residenceCity,
    request.residenceArea,
  ]
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .join(" - ");

  return value || "Residence";
}

function requestTimestamp(request: OutstationExpenseRequest) {
  const value = request.submittedAt || request.createdAt || request.tripStartDate;
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.getTime() : 0;
}

function excelText(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function rowsForExpenseWorkbook(rows: OutstationExpenseRequest[], fallbackEmployeeName: string) {
  return rows.map((request) => ({
    "Attachment Count": request.attachmentCount,
    "Employee Name": excelText(request.employeeName || fallbackEmployeeName),
    "From": excelText(requestFromLabel(request)),
    "From Date": excelText(formatDate(request.tripStartDate)),
    "Go Ticket Amount": request.goTicketAmount,
    "HR ID": excelText(request.employeeHrId),
    "Note": excelText(request.notes ?? ""),
    "Request ID": `MR-${request.id}`,
    "Return Ticket Amount": request.returnTicketAmount,
    "Role": excelText(request.employeeRole),
    "Status": normalizeStatus(request.status),
    "Submitted At": excelText(formatDate(request.submittedAt || request.createdAt)),
    "To": excelText(request.toLabel ?? ""),
    "To Date": excelText(formatDate(request.tripEndDate)),
    "Total Ticket Amount": requestTotal(request),
  }));
}

async function downloadExpenseWorkbook(rows: OutstationExpenseRequest[], fallbackEmployeeName: string) {
  // Lazy-load exceljs (~1MB) only when an export is triggered, keeping it out
  // of this client component's initial bundle.
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Expense Input");
  const widths = [14, 28, 14, 18, 34, 34, 14, 14, 18, 20, 20, 14, 18, 42, 16];
  sheet.columns = expenseExcelHeaders.map((header, index) => ({
    header,
    key: header,
    width: widths[index],
  }));
  sheet.addRows(rowsForExpenseWorkbook(rows, fallbackEmployeeName));

  const output = await workbook.xlsx.writeBuffer();
  const blob = new Blob([output], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `phoenix-medical-rep-expenses-${new Date().toISOString().slice(0, 10)}.xlsx`;
  link.click();
  window.URL.revokeObjectURL(url);
}

function tabButtonClassName(active: boolean) {
  return [
    "flex min-h-12 flex-1 items-center justify-center gap-2 rounded-none px-4 text-sm font-black transition",
    active
      ? "bg-orange-500 text-white shadow-[0_14px_28px_rgba(249,115,22,0.24)]"
      : "bg-white text-slate-600 hover:bg-slate-50",
  ].join(" ");
}

export function MedicalRepExpensesWorkspace({
  canSubmit,
  employeeName,
  initialRequests,
  residenceSummary,
}: {
  canSubmit: boolean;
  employeeName: string;
  initialRequests: OutstationExpenseRequest[];
  residenceSummary: string;
}) {
  const [activeTab, setActiveTab] = useState<ActiveTab>("submit");
  const [requests, setRequests] = useState(initialRequests);
  const [tripStartDate, setTripStartDate] = useState("");
  const [tripEndDate, setTripEndDate] = useState("");
  const [toLocation, setToLocation] = useState("");
  const [notes, setNotes] = useState("");
  const [goTicketAmount, setGoTicketAmount] = useState("");
  const [returnTicketAmount, setReturnTicketAmount] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<ExpenseStatusFilter>("all");
  const [orderBy, setOrderBy] = useState<ExpenseOrder>("newest");

  const ticketTotal = useMemo(
    () => Number(goTicketAmount || 0) + Number(returnTicketAmount || 0),
    [goTicketAmount, returnTicketAmount],
  );

  const filteredRequests = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const nextRows = requests.filter((request) => {
      const normalizedStatus = normalizeStatus(request.status).toLowerCase();
      const statusMatches = statusFilter === "all" || normalizedStatus === statusFilter;
      const searchText = [
        `MR-${request.id}`,
        employeeName,
        request.employeeName,
        request.employeeHrId,
        request.employeeRole,
        requestFromLabel(request),
        request.toLabel,
        request.notes,
        normalizeStatus(request.status),
      ]
        .join(" ")
        .toLowerCase();

      return statusMatches && (!normalizedQuery || searchText.includes(normalizedQuery));
    });

    return nextRows.sort((left, right) => {
      if (orderBy === "oldest") return requestTimestamp(left) - requestTimestamp(right);
      if (orderBy === "highest_total") return requestTotal(right) - requestTotal(left);
      if (orderBy === "lowest_total") return requestTotal(left) - requestTotal(right);
      if (orderBy === "destination") return (left.toLabel ?? "").localeCompare(right.toLabel ?? "");
      return requestTimestamp(right) - requestTimestamp(left);
    });
  }, [employeeName, orderBy, query, requests, statusFilter]);

  const filteredTotal = useMemo(
    () => filteredRequests.reduce((total, request) => total + requestTotal(request), 0),
    [filteredRequests],
  );

  const canSend =
    canSubmit &&
    !isSubmitting &&
    Boolean(
      tripStartDate &&
        tripEndDate &&
        toLocation.trim() &&
        notes.trim() &&
        attachments.length > 0 &&
        ticketTotal > 0,
    );

  async function submitExpense(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);

    if (!canSend) {
      setMessage("Complete the required fields before submitting.");
      return;
    }

    const formData = new FormData();
    formData.set("tripStartDate", tripStartDate);
    formData.set("tripEndDate", tripEndDate);
    formData.set("toLocation", toLocation);
    formData.set("notes", notes);
    formData.set("goTicketAmount", goTicketAmount);
    formData.set("returnTicketAmount", returnTicketAmount);
    attachments.forEach((file) => formData.append("attachments", file));

    setIsSubmitting(true);
    try {
      const response = await fetch("/api/outstation/medical-rep-expenses", {
        body: formData,
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) {
        setMessage(payload.message ?? "Unable to submit expense.");
        return;
      }

      setRequests((current) => [payload.request as OutstationExpenseRequest, ...current]);
      setTripStartDate("");
      setTripEndDate("");
      setToLocation("");
      setNotes("");
      setGoTicketAmount("");
      setReturnTicketAmount("");
      setAttachments([]);
      setFileInputKey((value) => value + 1);
      setMessage("Expense submitted.");
      setActiveTab("input");
    } catch {
      setMessage("Unable to submit expense.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-2 rounded-none border border-slate-200 bg-slate-100/70 p-2 shadow-[0_18px_42px_rgba(15,23,42,0.08)] sm:grid-cols-2">
        <button
          className={tabButtonClassName(activeTab === "submit")}
          onClick={() => setActiveTab("submit")}
          type="button"
        >
          <ReceiptText className="h-4 w-4" />
          Submit Expense
        </button>
        <button
          className={tabButtonClassName(activeTab === "input")}
          onClick={() => setActiveTab("input")}
          type="button"
        >
          <FileSpreadsheet className="h-4 w-4" />
          Expense Input
        </button>
      </div>

      {message ? (
        <div className="rounded-none border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm">
          {message}
        </div>
      ) : null}

      {activeTab === "submit" ? (
        <Card className="overflow-hidden rounded-none border border-slate-200 bg-white p-0 shadow-[0_24px_60px_rgba(15,23,42,0.09)]">
          <form aria-busy={isSubmitting} onSubmit={submitExpense}>
            <div className="border-b border-slate-100 bg-gradient-to-r from-white via-orange-50/60 to-white p-6 sm:p-8">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.18em] text-orange-600">
                    Submit Expense
                  </p>
                  <h2 className="mt-2 text-3xl font-black tracking-tight text-slate-950">
                    Traveling request
                  </h2>
                </div>
                <Badge variant="neutral">Traveling only</Badge>
              </div>
            </div>

            <div className="grid gap-5 p-6 sm:p-8 lg:grid-cols-6">
              <div className="lg:col-span-3">
                <Field label="Employee">
                  <ReadOnlyField icon={ReceiptText} value={employeeName} />
                </Field>
              </div>

              <div className="lg:col-span-3">
                <Field label="From">
                  <ReadOnlyField
                    icon={MapPin}
                    value={residenceSummary || "Residence not configured"}
                  />
                </Field>
              </div>

              <div className="lg:col-span-2">
                <Field label="Type">
                  <ReadOnlyField icon={FileText} value="Traveling" />
                </Field>
              </div>

              <div className="lg:col-span-4">
                <Field label="Attachment">
                  <label className="flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-none border border-dashed border-orange-300 bg-orange-50 px-4 text-sm font-bold text-orange-700 transition hover:bg-orange-100">
                    <Upload className="h-4 w-4" />
                    <span className="whitespace-nowrap">
                      {attachments.length > 0
                        ? `${attachments.length} file(s) selected`
                        : "Upload ticket"}
                    </span>
                    <input
                      key={fileInputKey}
                      accept="application/pdf,image/jpeg,image/png"
                      className="hidden"
                      multiple
                      onChange={(event) =>
                        setAttachments(event.target.files ? Array.from(event.target.files) : [])
                      }
                      required
                      type="file"
                    />
                  </label>
                </Field>
              </div>

              <div className="lg:col-span-3">
                <Field label="From Date">
                  <Input
                    className="h-12 rounded-none border-slate-200 bg-white"
                    onChange={(event) => setTripStartDate(event.target.value)}
                    required
                    type="date"
                    value={tripStartDate}
                  />
                </Field>
              </div>

              <div className="lg:col-span-3">
                <Field label="To Date">
                  <Input
                    className="h-12 rounded-none border-slate-200 bg-white"
                    min={tripStartDate || undefined}
                    onChange={(event) => setTripEndDate(event.target.value)}
                    required
                    type="date"
                    value={tripEndDate}
                  />
                </Field>
              </div>

              <div className="lg:col-span-3">
                <Field label="Go Ticket Amount">
                  <Input
                    className="h-12 rounded-none border-slate-200 bg-white"
                    min="0"
                    onChange={(event) => setGoTicketAmount(event.target.value)}
                    placeholder="EGP"
                    required
                    type="number"
                    value={goTicketAmount}
                  />
                </Field>
              </div>

              <div className="lg:col-span-3">
                <Field label="Return Ticket Amount">
                  <Input
                    className="h-12 rounded-none border-slate-200 bg-white"
                    min="0"
                    onChange={(event) => setReturnTicketAmount(event.target.value)}
                    placeholder="EGP"
                    required
                    type="number"
                    value={returnTicketAmount}
                  />
                </Field>
              </div>

              <div className="lg:col-span-6">
                <Field label="To">
                  <Input
                    className="h-12 rounded-none border-slate-200 bg-white"
                    onChange={(event) => setToLocation(event.target.value)}
                    placeholder="Destination"
                    required
                    value={toLocation}
                  />
                </Field>
              </div>

              <div className="lg:col-span-6">
                <Field label="Note">
                  <textarea
                    className="min-h-40 w-full rounded-none border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20"
                    onChange={(event) => setNotes(event.target.value)}
                    placeholder="Reason for this expense"
                    required
                    value={notes}
                  />
                </Field>
              </div>

              {!canSubmit ? (
                <div className="lg:col-span-6">
                  <div className="rounded-none border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
                    Residence must be configured before this request can be submitted.
                  </div>
                </div>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-100 bg-slate-50 px-6 py-5 sm:px-8">
              <div className="flex min-w-0 items-center gap-3 text-base font-black text-slate-800">
                <CalendarDays className="h-5 w-5 shrink-0 text-orange-500" />
                <span>Total: {egp(ticketTotal)}</span>
              </div>
              <Button
                className="min-h-12 min-w-[220px] gap-2 rounded-none bg-orange-500 px-6 text-white hover:bg-orange-600"
                disabled={!canSend}
                type="submit"
              >
                {isSubmitting ? <LoadingSpinner className="text-white" /> : <Send className="h-4 w-4" />}
                Submit Expense
              </Button>
            </div>
          </form>
        </Card>
      ) : (
        <Card className="overflow-hidden rounded-none border border-slate-200 bg-white p-0 shadow-[0_24px_60px_rgba(15,23,42,0.09)]">
          <div className="border-b border-slate-100 p-5 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-xs font-black uppercase tracking-[0.18em] text-orange-600">
                  Expense Input
                </p>
                <h2 className="mt-1 text-2xl font-black text-slate-950">
                  Submitted expense rows
                </h2>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="neutral">{filteredRequests.length} row(s)</Badge>
                <Badge variant="neutral">{egp(filteredTotal)}</Badge>
                <Button
                  className="min-h-10 gap-2 rounded-none border border-slate-200 bg-white px-4 text-slate-700 hover:bg-slate-50"
                  onClick={() => void downloadExpenseWorkbook(filteredRequests, employeeName)}
                  type="button"
                >
                  <Download className="h-4 w-4" />
                  Download Excel
                </Button>
              </div>
            </div>

            <div className="mt-5 grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px_220px]">
              <label className="relative block min-w-0">
                <span className="sr-only">Free filter</span>
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input
                  className="h-11 rounded-none border-slate-200 bg-white pl-9"
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Free filter by employee, request, destination, note"
                  value={query}
                />
              </label>

              <label className="relative block min-w-0">
                <span className="sr-only">Status filter</span>
                <ListFilter className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <select
                  className="h-11 w-full appearance-none rounded-none border border-slate-200 bg-white px-9 text-sm font-bold text-slate-700 outline-none transition focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20"
                  onChange={(event) => setStatusFilter(event.target.value as ExpenseStatusFilter)}
                  value={statusFilter}
                >
                  <option value="all">All statuses</option>
                  <option value="submitted">Submitted</option>
                  <option value="approved">Approved</option>
                  <option value="declined">Declined</option>
                </select>
              </label>

              <label className="relative block min-w-0">
                <span className="sr-only">Order rows</span>
                <ArrowUpDown className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <select
                  className="h-11 w-full appearance-none rounded-none border border-slate-200 bg-white px-9 text-sm font-bold text-slate-700 outline-none transition focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20"
                  onChange={(event) => setOrderBy(event.target.value as ExpenseOrder)}
                  value={orderBy}
                >
                  <option value="newest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                  <option value="highest_total">Highest total</option>
                  <option value="lowest_total">Lowest total</option>
                  <option value="destination">Destination A-Z</option>
                </select>
              </label>
            </div>
          </div>

          <div className="hidden overflow-x-auto md:block">
            <table className="min-w-[1320px] divide-y divide-orange-100 text-left text-sm">
              <thead className="bg-slate-900 text-xs font-black uppercase tracking-[0.14em] text-white">
                <tr>
                  <th className="px-4 py-3">Request</th>
                  <th className="px-4 py-3">Employee Name</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">From</th>
                  <th className="px-4 py-3">To</th>
                  <th className="px-4 py-3 text-right">Go</th>
                  <th className="px-4 py-3 text-right">Return</th>
                  <th className="px-4 py-3 text-right">Total</th>
                  <th className="px-4 py-3">Attachment</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Note</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-orange-100 bg-white">
                {filteredRequests.map((request) => (
                  <tr className="transition hover:bg-orange-50/40" key={getRequestKey(request)}>
                    <td className="px-4 py-3 font-mono text-xs font-bold text-slate-600">
                      MR-{request.id}
                    </td>
                    <td className="max-w-[240px] whitespace-nowrap px-4 py-3 font-semibold text-slate-900">
                      {request.employeeName || employeeName}
                    </td>
                    <td className="px-4 py-3 font-semibold text-slate-800">
                      {formatDate(request.tripStartDate)}
                    </td>
                    <td className="max-w-[220px] whitespace-nowrap px-4 py-3 font-medium text-slate-700">
                      {requestFromLabel(request)}
                    </td>
                    <td className="max-w-[260px] whitespace-nowrap px-4 py-3 font-semibold text-slate-900">
                      {request.toLabel || "N/A"}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-slate-800">
                      {egp(request.goTicketAmount)}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-slate-800">
                      {egp(request.returnTicketAmount)}
                    </td>
                    <td className="px-4 py-3 text-right font-black text-slate-950">
                      {egp(requestTotal(request))}
                    </td>
                    <td className="px-4 py-3 font-medium text-slate-700">
                      {request.attachmentCount} file(s)
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={statusVariant(request.status)}>
                        {normalizeStatus(request.status)}
                      </Badge>
                    </td>
                    <td className="max-w-[260px] whitespace-nowrap px-4 py-3 font-medium text-slate-700">
                      {request.notes || "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="space-y-3 p-4 md:hidden">
            {filteredRequests.map((request) => (
              <div
                className="rounded-none border border-slate-200 bg-white p-4 shadow-[0_12px_28px_rgba(15,23,42,0.06)]"
                key={`${getRequestKey(request)}-mobile`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-mono text-xs font-bold text-slate-500">MR-{request.id}</p>
                    <p className="mt-1 font-black text-slate-950">
                      {request.employeeName || employeeName}
                    </p>
                    <p className="mt-1 text-sm font-semibold text-slate-700">
                      {request.toLabel || "N/A"}
                    </p>
                  </div>
                  <Badge variant={statusVariant(request.status)}>
                    {normalizeStatus(request.status)}
                  </Badge>
                </div>
                <p className="mt-2 text-sm font-medium text-slate-600">
                  {formatDate(request.tripStartDate)} - {formatDate(request.tripEndDate)}
                </p>
                <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                  <p className="text-slate-600">
                    Go: <span className="font-bold text-slate-950">{egp(request.goTicketAmount)}</span>
                  </p>
                  <p className="text-slate-600">
                    Return:{" "}
                    <span className="font-bold text-slate-950">{egp(request.returnTicketAmount)}</span>
                  </p>
                  <p className="text-slate-600">
                    Total:{" "}
                    <span className="font-bold text-slate-950">
                      {egp(requestTotal(request))}
                    </span>
                  </p>
                  <p className="text-slate-600">
                    Files: <span className="font-bold text-slate-950">{request.attachmentCount}</span>
                  </p>
                </div>
                {request.notes ? (
                  <p className="mt-3 text-sm font-medium text-slate-700">{request.notes}</p>
                ) : null}
              </div>
            ))}
            {filteredRequests.length === 0 ? (
              <p className="px-3 py-6 text-sm font-medium text-slate-600">
                No expense rows match the current filters.
              </p>
            ) : null}
          </div>

          {filteredRequests.length === 0 ? (
            <div className="hidden px-5 py-10 text-sm font-semibold text-slate-600 md:block">
              No expense rows match the current filters.
            </div>
          ) : null}
        </Card>
      )}
    </div>
  );
}
