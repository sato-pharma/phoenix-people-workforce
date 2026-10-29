"use client";

import { useMemo, useState } from "react";
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
import {
  PortalEmptyState,
  PortalSection,
  PortalSegmentedTabs,
} from "@/components/employee-portal/portal-primitives";
import {
  EXPENSE_PLACES_ENDPOINT,
  PlacesAutocompleteInput,
} from "@/components/outstation/places-autocomplete-input";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-state";
import type { OutstationExpenseRequest } from "@/lib/outstation/types";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { todayInCairo } from "@/lib/date-only";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";
import { stableCurrencyFormatter } from "@/lib/format/stable-currency";
import { cn } from "@/lib/utils";
import { FormField } from "@/components/ui/form-kit";
import {
  phxButtonAccentClassName,
  phxButtonGhostClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";


type ActiveTab = "submit" | "history";
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
  return stableCurrencyFormatter("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return stableEnGbFormatter({
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

function ReadOnlyField({
  icon: Icon,
  value,
}: {
  icon: LucideIcon;
  value: string;
}) {
  // Wraps, never clips: a home address or a long name does not fit a ~240px phone field on one line,
  // and the card around it is overflow-hidden, so a one-line value was cut off mid-word.
  return (
    <div className={`flex min-h-12 min-w-0 items-center gap-2 rounded-none border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-800 ${adminSoftDepthClassName}`}>
      <Icon className="h-4 w-4 shrink-0 text-orange-500" />
      <span className="min-w-0 break-words" dir="auto">{value}</span>
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

function tripDatesLabel(request: OutstationExpenseRequest) {
  return `${formatDate(request.tripStartDate)} – ${formatDate(request.tripEndDate)}`;
}

function countLabel(count: number, singular: string, plural: string) {
  return `${count} ${count === 1 ? singular : plural}`;
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
  // Cairo's calendar day, not UTC's: between midnight and 02:59 Cairo the UTC date is still yesterday.
  link.download = `phoenix-medical-rep-expenses-${todayInCairo()}.xlsx`;
  link.click();
  window.URL.revokeObjectURL(url);
}

/** The house segmented-tab button (the same look as the Phoenix CRM space tabs). */
function tabButtonClassName(active: boolean) {
  return cn(
    "flex min-h-10 min-w-0 items-center justify-center gap-2 px-3 py-2 text-center text-sm font-bold leading-tight transition",
    active ? "bg-white text-orange-700 shadow-sm" : "text-slate-600 hover:bg-white/70",
  );
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
  // The Google place id behind `toLocation`. Empty until a suggestion is actually chosen, which
  // is what separates a resolved place from whatever the rep happened to type.
  const [toPlaceId, setToPlaceId] = useState("");
  const [notes, setNotes] = useState("");
  const [goTicketAmount, setGoTicketAmount] = useState("");
  const [returnTicketAmount, setReturnTicketAmount] = useState("");
  const amWorkload = "";
  const pmWorkload = "";
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
    // The attachment is deliberately absent from this list: the upload is OPTIONAL (owner,
    // 2026-10-01), so a claim with no ticket file sends exactly like one that carries files.
    Boolean(tripStartDate && tripEndDate && toLocation.trim() && notes.trim() && ticketTotal > 0);

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
    formData.set("toPlaceId", toPlaceId);
    formData.set("notes", notes);
    formData.set("goTicketAmount", goTicketAmount);
    formData.set("returnTicketAmount", returnTicketAmount);
    formData.set("amWorkload", amWorkload || "0");
    formData.set("pmWorkload", pmWorkload || "0");
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
      setToPlaceId("");
      setNotes("");
      setGoTicketAmount("");
      setReturnTicketAmount("");
      setAttachments([]);
      setFileInputKey((value) => value + 1);
      setMessage("Expense submitted.");
      setActiveTab("history");
    } catch {
      setMessage("Unable to submit expense.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Two tabs side by side at every width — they fit a 360px phone, so they never stack. */}
      <PortalSegmentedTabs className="grid grid-cols-2">
        <button
          aria-pressed={activeTab === "submit"}
          className={tabButtonClassName(activeTab === "submit")}
          onClick={() => setActiveTab("submit")}
          type="button"
        >
          <ReceiptText className="h-4 w-4 shrink-0" />
          Submit Expense
        </button>
        <button
          aria-pressed={activeTab === "history"}
          className={tabButtonClassName(activeTab === "history")}
          onClick={() => setActiveTab("history")}
          type="button"
        >
          <FileSpreadsheet className="h-4 w-4 shrink-0" />
          History
        </button>
      </PortalSegmentedTabs>

      {message ? (
        <div className="rounded-none border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm">
          {message}
        </div>
      ) : null}

      {activeTab === "submit" ? (
        <PortalSection
          actions={<Badge variant="neutral">Traveling only</Badge>}
          eyebrow="Submit Expense"
          title="Traveling request"
        >
          <form aria-busy={isSubmitting} onSubmit={submitExpense}>
            {/* md, not lg: a tablet (768–1023px) has room for the paired fields, and the same grid
                already fits the ~636px content column at 1024px with the sidebar open. */}
            <div className="grid gap-5 p-4 sm:p-6 md:grid-cols-6">
              <div className="md:col-span-3">
                <FormField label="Employee">
                  <ReadOnlyField icon={ReceiptText} value={employeeName} />
                </FormField>
              </div>

              <div className="md:col-span-3">
                <FormField label="From">
                  <ReadOnlyField
                    icon={MapPin}
                    value={residenceSummary || "Residence not configured"}
                  />
                </FormField>
              </div>

              <div className="md:col-span-2">
                <FormField label="Type">
                  <ReadOnlyField icon={FileText} value="Traveling" />
                </FormField>
              </div>

              <div className="md:col-span-4">
                <FormField label="Attachment (optional)">
                  <label className="flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-none border border-dashed border-orange-300 bg-orange-50 px-4 text-sm font-bold text-orange-700 transition hover:bg-orange-100">
                    <Upload className="h-4 w-4" />
                    <span className="break-words">
                      {attachments.length > 0
                        ? `${countLabel(attachments.length, "file", "files")} selected`
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
                      type="file"
                    />
                  </label>
                </FormField>
              </div>

              <div className="md:col-span-3">
                <FormField label="From Date">
                  <Input
                    onChange={(event) => setTripStartDate(event.target.value)}
                    required
                    type="date"
                    value={tripStartDate}
                  />
                </FormField>
              </div>

              <div className="md:col-span-3">
                <FormField label="To Date">
                  <Input
                    min={tripStartDate || undefined}
                    onChange={(event) => setTripEndDate(event.target.value)}
                    required
                    type="date"
                    value={tripEndDate}
                  />
                </FormField>
              </div>

              <div className="md:col-span-3">
                <FormField label="Go Ticket Amount">
                  <Input
                    min="0"
                    onChange={(event) => setGoTicketAmount(event.target.value)}
                    placeholder="EGP"
                    required
                    type="number"
                    value={goTicketAmount}
                  />
                </FormField>
              </div>

              <div className="md:col-span-3">
                <FormField label="Return Ticket Amount">
                  <Input
                    min="0"
                    onChange={(event) => setReturnTicketAmount(event.target.value)}
                    placeholder="EGP"
                    required
                    type="number"
                    value={returnTicketAmount}
                  />
                </FormField>
              </div>

              <div className="md:col-span-6">
                <FormField label="To">
                  {/* Was a free-text box. The one submission ever made through this path stored
                      "Baniseaf" as the trip's destination — a misspelling of Beni Suef that no
                      report could group, match or map. Picking from real Egyptian places costs the
                      rep FEWER keystrokes, not more, which is the only version of this change
                      worth making to his screen. */}
                  <PlacesAutocompleteInput
                    endpoint={EXPENSE_PLACES_ENDPOINT}
                    onSelect={(prediction) => {
                      setToLocation(prediction.description);
                      setToPlaceId(prediction.placeId);
                    }}
                    placeholder="Search destination…"
                    value={toLocation}
                  />
                </FormField>
              </div>

              <div className="md:col-span-6">
                <FormField label="Note">
                  <textarea
                    className={cn(phxTextareaClassName, "min-h-40")}
                    onChange={(event) => setNotes(event.target.value)}
                    placeholder="Reason for this expense"
                    required
                    value={notes}
                  />
                </FormField>
              </div>

              {/* AM · PM · Pharmacies, three figures apart (the golden rule) — a third of the row each.
                  The placeholder is short because a third of the row is ~185px at 1024px with the
                  sidebar open; where the figures come from is the sentence under the three. */}
              <div className="md:col-span-2">
                <FormField label="AM Visits">
                  <Input
                    disabled
                    placeholder="Filled automatically"
                    readOnly
                    value={amWorkload}
                  />
                </FormField>
              </div>

              <div className="md:col-span-2">
                <FormField label="PM Visits">
                  <Input
                    disabled
                    placeholder="Filled automatically"
                    readOnly
                    value={pmWorkload}
                  />
                </FormField>
              </div>

              <div className="md:col-span-2">
                <FormField label="Pharmacy Visits">
                  <Input
                    disabled
                    placeholder="Filled automatically"
                    readOnly
                    value=""
                  />
                </FormField>
              </div>

              <div className="md:col-span-6">
                <p className="text-xs font-semibold text-slate-500">
                  Workload is resolved automatically from the official published Double Visit Analytics snapshot after submission,
                  as three figures: AM, PM and Pharmacies.
                </p>
              </div>

              {!canSubmit ? (
                <div className="md:col-span-6">
                  <div className="rounded-none border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
                    Residence must be configured before this request can be submitted.
                  </div>
                </div>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-100 bg-slate-50 px-4 py-4 sm:px-6">
              <div className="flex min-w-0 items-center gap-3 text-base font-black text-slate-800">
                <CalendarDays className="h-5 w-5 shrink-0 text-orange-500" />
                <span>Total: {egp(ticketTotal)}</span>
              </div>
              <button
                className={cn(phxButtonAccentClassName, "w-full sm:w-auto sm:min-w-[220px]")}
                disabled={!canSend}
                type="submit"
              >
                {isSubmitting ? <LoadingSpinner className="text-white" /> : <Send className="h-4 w-4" />}
                Submit Expense
              </button>
            </div>
          </form>
        </PortalSection>
      ) : (
        <PortalSection
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="neutral">{countLabel(filteredRequests.length, "claim", "claims")}</Badge>
              <Badge variant="neutral">{egp(filteredTotal)}</Badge>
              <button
                className={phxButtonGhostClassName}
                onClick={() => void downloadExpenseWorkbook(filteredRequests, employeeName)}
                type="button"
              >
                <Download className="h-4 w-4" />
                Download Excel
              </button>
            </div>
          }
          eyebrow="History"
          title="Your submitted claims"
        >
          <div className="border-b border-slate-100 p-4 sm:p-6">
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px_220px]">
              <label className="relative block min-w-0">
                <span className="sr-only">Search claims</span>
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input
                  className="pl-9"
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search by request, destination or note"
                  value={query}
                />
              </label>

              <label className="relative block min-w-0">
                <span className="sr-only">Status filter</span>
                <ListFilter className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <SearchableSelect
                  className="w-full appearance-none px-9"
                  onChange={(event) => setStatusFilter(event.target.value as ExpenseStatusFilter)}
                  value={statusFilter}
                >
                  <option value="all">All statuses</option>
                  <option value="submitted">Submitted</option>
                  <option value="approved">Approved</option>
                  <option value="declined">Declined</option>
                </SearchableSelect>
              </label>

              <label className="relative block min-w-0">
                <span className="sr-only">Order claims</span>
                <ArrowUpDown className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <SearchableSelect
                  className="w-full appearance-none px-9"
                  onChange={(event) => setOrderBy(event.target.value as ExpenseOrder)}
                  value={orderBy}
                >
                  <option value="newest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                  <option value="highest_total">Highest total</option>
                  <option value="lowest_total">Lowest total</option>
                  <option value="destination">Destination A-Z</option>
                </SearchableSelect>
              </label>
            </div>
          </div>

          {filteredRequests.length === 0 ? (
            requests.length === 0 ? (
              <PortalEmptyState
                message="Claims you send from the Submit Expense tab will show here."
                title="No claims yet"
              />
            ) : (
              <PortalEmptyState
                message="Nothing matches these filters. Clear the search or choose another status."
                title="No matching claims"
              />
            )
          ) : (
            <>
              {/* Desktop and tablet: a fixed five-column table that divides the card's width, so no
                  address, destination or note can push it sideways — they wrap inside their column.
                  Merged, never shrunk: dates with the route, and Go / Return / Total stacked in one
                  cell. No employee column: every claim here is the viewer's own. */}
              <div className="hidden md:block">
                <table className="w-full table-fixed border-collapse text-left text-sm">
                  <colgroup>
                    <col className="w-[19%]" />
                    <col className="w-[28%]" />
                    <col className="w-[19%]" />
                    <col className="w-[10%]" />
                    <col className="w-[24%]" />
                  </colgroup>
                  <thead className="bg-slate-900 text-xs font-black uppercase tracking-[0.14em] text-white">
                    <tr>
                      <th className="px-3 py-3">Request</th>
                      <th className="px-3 py-3">Trip</th>
                      <th className="px-3 py-3">Tickets</th>
                      <th className="px-3 py-3">Files</th>
                      <th className="px-3 py-3">Note</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-orange-100 bg-white">
                    {filteredRequests.map((request) => (
                      <tr className="align-top transition hover:bg-orange-50/40" key={getRequestKey(request)}>
                        <td className="px-3 py-3">
                          <p className="break-words font-mono text-xs font-bold text-slate-600">MR-{request.id}</p>
                          <Badge className="mt-1.5" variant={statusVariant(request.status)}>
                            {normalizeStatus(request.status)}
                          </Badge>
                        </td>
                        <td className="px-3 py-3">
                          <p className="break-words font-semibold text-slate-900">{tripDatesLabel(request)}</p>
                          <p className="mt-1 break-words font-medium text-slate-700">
                            <span dir="auto">{requestFromLabel(request)}</span>
                            <span aria-hidden="true" className="px-1 text-orange-500">→</span>
                            <span className="sr-only"> to </span>
                            <span className="font-semibold text-slate-900" dir="auto">
                              {request.toLabel || "—"}
                            </span>
                          </p>
                        </td>
                        <td className="px-3 py-3">
                          <dl className="space-y-1">
                            <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                              <dt className="text-xs font-semibold text-slate-500">Go</dt>
                              <dd className="min-w-0 break-words font-semibold tabular-nums text-slate-800">
                                {egp(request.goTicketAmount)}
                              </dd>
                            </div>
                            <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                              <dt className="text-xs font-semibold text-slate-500">Return</dt>
                              <dd className="min-w-0 break-words font-semibold tabular-nums text-slate-800">
                                {egp(request.returnTicketAmount)}
                              </dd>
                            </div>
                            <div className="flex flex-wrap items-baseline justify-between gap-x-2 border-t border-slate-100 pt-1">
                              <dt className="text-xs font-bold text-slate-600">Total</dt>
                              <dd className="min-w-0 break-words font-black tabular-nums text-slate-950">
                                {egp(requestTotal(request))}
                              </dd>
                            </div>
                          </dl>
                        </td>
                        <td className="px-3 py-3 font-semibold tabular-nums text-slate-700">
                          {request.attachmentCount}
                        </td>
                        <td className="break-words px-3 py-3 font-medium text-slate-700" dir="auto">
                          {request.notes || "—"}
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
                      <div className="min-w-0">
                        <p className="font-mono text-xs font-bold text-slate-500">MR-{request.id}</p>
                        <p className="mt-1 break-words font-black text-slate-950" dir="auto">
                          {request.toLabel}
                        </p>
                      </div>
                      <Badge className="shrink-0" variant={statusVariant(request.status)}>
                        {normalizeStatus(request.status)}
                      </Badge>
                    </div>
                    <p className="mt-2 text-sm font-medium text-slate-600">{tripDatesLabel(request)}</p>
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
                      <p className="mt-3 break-words text-sm font-medium text-slate-700" dir="auto">
                        {request.notes}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            </>
          )}
        </PortalSection>
      )}
    </div>
  );
}
