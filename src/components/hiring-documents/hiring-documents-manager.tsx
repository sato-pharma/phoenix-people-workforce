"use client";

import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  FileCheck2,
  FilePlus2,
  Paperclip,
  RefreshCw,
  ScanLine,
  Search,
  SlidersHorizontal,
  Table2,
  Trash2,
  X,
} from "lucide-react";
import * as React from "react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminStatCard,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { HiringDocumentCapture } from "@/components/hiring-documents/hiring-document-capture";
import { HiringJoinersPanel } from "@/components/hiring-documents/hiring-joiners-panel";
import { Input } from "@/components/ui/input";
import { PortalDesktopTable } from "@/components/employee-portal/portal-primitives";
import { downloadXlsxFrom } from "@/lib/export/download-xlsx-client";
import { employmentStatusLabel } from "@/lib/employees/employment-status-label";
import { hiringDeadlineChanged, normalizeHiringDeadline } from "@/lib/hiring-documents/deadline";
import {
  HIRING_DOCUMENT_FILTER_ALL,
  HIRING_DOCUMENT_SCANNING_UNSCANNED,
  filterHiringDocumentEmployees,
  hiringDocumentCompletionPercent,
  hiringDocumentFilterSearchParams,
  type HiringDocumentFilterState,
} from "@/lib/hiring-documents/filters";
import { hiringDocumentsFor } from "@/lib/hiring-documents/readiness-signal";
import type {
  HiringDocumentDefinition,
  HiringDocumentEmployeeRow,
  HiringDocumentsDashboardData,
  HiringDocumentStatus,
} from "@/lib/hiring-documents/types";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  phxSelectClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";


type Props = {
  /** False for the seat that receives the papers but does not change what the checklist asks for. */
  canEditChecklist: boolean;
  canRemoveFiles: boolean;
  canManage: boolean;
  initialData: HiringDocumentsDashboardData | null;
  initialError: string | null;
};

type ActiveTab = "documents" | "capture" | "control";

// The sentinel, and the row filter under it, live in `@/lib/hiring-documents/filters` — the XLSX
// export is built on the SERVER from the same filter state, and an export that does not match the
// screen is the defect that module exists to prevent.
const allValue = HIRING_DOCUMENT_FILTER_ALL;
// Both desktop tables on this screen freeze their header, so there is one header class. The tint
// is opaque on purpose — rows scroll underneath it, not past it — and the divider under it is
// painted rather than bordered, see frozenHeaderStyle.
const frozenHeaderClassName =
  "sticky top-0 bg-phx-accent-soft px-3 py-3 text-left text-phx-2xs font-black uppercase tracking-[0.16em] text-phx-ink-soft";
// Tailwind's preflight collapses every table's borders, and a collapsed bottom edge belongs to the
// row boundary, not to the cell — so a `border-b` stays behind the instant the header cell sticks
// and the line under the header vanishes while you scroll. An inset shadow travels with the cell.
const frozenHeaderStyle: React.CSSProperties = { boxShadow: "inset 0 -1px 0 var(--phx-line)" };
const tableCellClassName = "border-b border-phx-line px-3 py-4 align-top";
const inputClassName = "";
const selectClassName  = phxSelectClassName;

function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function uniqueOptions(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.filter(Boolean) as string[])).sort((a, b) => a.localeCompare(b));
}

function statusBadge(status: string | null | undefined) {
  const normalized = String(status ?? "active").toLowerCase();
  // Same words as the filter's <option> list, from the same place. The badge only ever LOOKED
  // right because `Badge` is styled `uppercase`; the string it was handed was the stored code.
  const label = employmentStatusLabel(normalized) || "Unknown";
  if (normalized === "active" || normalized === "on_leave") {
    return <Badge variant="success">{label}</Badge>;
  }
  if (normalized === "resigned" || normalized === "terminated") {
    return <Badge variant="danger">{label}</Badge>;
  }
  return <Badge variant="warning">{label}</Badge>;
}

function documentStatusBadge(status: HiringDocumentStatus) {
  if (status === "submitted") return <Badge variant="success">Submitted</Badge>;
  if (status === "missing") return <Badge variant="danger">Missing</Badge>;
  return <Badge variant="warning">Pending</Badge>;
}

function getCompletionPercent(data: HiringDocumentsDashboardData | null) {
  if (!data?.summary.totalDocumentSlots) return 0;
  return Math.round((data.summary.submittedDocuments / data.summary.totalDocumentSlots) * 100);
}

// One arithmetic, shared with the export — the completion the workbook prints is the completion the
// screen shows, and the completion filter narrows both by the same number.
const employeeCompletion = hiringDocumentCompletionPercent;

export function HiringDocumentsManager({ canEditChecklist, canManage, canRemoveFiles, initialData, initialError }: Props) {
  const [activeTab, setActiveTab] = React.useState<ActiveTab>("documents");
  const [data, setData] = React.useState<HiringDocumentsDashboardData | null>(initialData);
  const [error, setError] = React.useState<string | null>(initialError);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [lineFilter, setLineFilter] = React.useState(allValue);
  const [statusFilter, setStatusFilter] = React.useState(allValue);
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [managerFilter, setManagerFilter] = React.useState(allValue);
  const [jobTitleFilter, setJobTitleFilter] = React.useState(allValue);
  const [scanningFilter, setScanningFilter] = React.useState(allValue);
  const [hireDateFrom, setHireDateFrom] = React.useState("");
  const [hireDateTo, setHireDateTo] = React.useState("");
  const [completionMin, setCompletionMin] = React.useState("");
  const [completionMax, setCompletionMax] = React.useState("");
  const [busyKey, setBusyKey] = React.useState<string | null>(null);
  // Which employee x document pair the Scan & Upload tab opens on. Set by the paperclip in a grid
  // cell, so HR never has to re-find in two dropdowns the row she is already looking at.
  const [captureTarget, setCaptureTarget] = React.useState<{ documentId: string; employeeHrId: string } | null>(null);
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const [isExporting, setIsExporting] = React.useState(false);
  const [newDocumentName, setNewDocumentName] = React.useState("");
  const [newDocumentDescription, setNewDocumentDescription] = React.useState("");
  const [draftNotes, setDraftNotes] = React.useState<Record<string, string>>({});
  // What a deadline box held when it gained focus. A date field has no "done" button, so it
  // saves on blur — and without this, simply tabbing across a row wrote to production.
  const deadlineOnFocusRef = React.useRef<string | null>(null);

  const documents = React.useMemo(() => data?.documents ?? [], [data?.documents]);
  const employees = React.useMemo(() => data?.employees ?? [], [data?.employees]);
  const lineOptions = React.useMemo(() => uniqueOptions(employees.map((employee) => employee.lineName)), [employees]);
  const statusOptions = React.useMemo(() => uniqueOptions(employees.map((employee) => employee.employmentStatus)), [employees]);
  const managerOptions = React.useMemo(
    () => uniqueOptions(employees.map((employee) => employee.managerName)),
    [employees],
  );
  const jobTitleOptions = React.useMemo(
    () => uniqueOptions(employees.map((employee) => employee.jobTitle)),
    [employees],
  );

  // ONE object, because it is also what the export sends to the server. Keeping the nine pieces of
  // state and re-assembling them at the download would be two definitions of "what is on screen",
  // and the day they disagreed the file would carry rows the reader never saw.
  const filters = React.useMemo<HiringDocumentFilterState>(
    () => ({
      completionMax,
      completionMin,
      hireDateFrom,
      hireDateTo,
      jobTitle: jobTitleFilter,
      line: lineFilter,
      manager: managerFilter,
      query,
      scanning: scanningFilter,
      status: statusFilter,
    }),
    [completionMax, completionMin, hireDateFrom, hireDateTo, jobTitleFilter, lineFilter, managerFilter, query, scanningFilter, statusFilter],
  );

  const filteredEmployees = React.useMemo(
    () => filterHiringDocumentEmployees(employees, documents, filters),
    [documents, employees, filters],
  );

  // Ticked but never scanned. Clamped at zero because the two counts come from the same pass and
  // cannot legitimately invert — a negative would be a bug printed to HR as though it were a fact.
  const scanGap = Math.max(
    0,
    (data?.summary.submittedDocuments ?? 0) - (data?.summary.scannedDocuments ?? 0),
  );

  // One document's tick / missing / scan controls for one person. The desktop table and the phone
  // card both draw it, so the two never drift.
  const renderDocumentRow = (employee: (typeof filteredEmployees)[number], document: (typeof documents)[number]) => {
                              const entry = employee.documents[document.id];
                              const dueDate = entry?.dueDate ?? "";
                              const status = entry?.status ?? "pending";
                              const busy = Boolean(busyKey?.startsWith(`${employee.hrId}:${document.id}`));

                              return (
                                <div className="px-3 py-2.5">
                                  <div className="flex items-center justify-between gap-2">
                                    <p className="min-w-0 pr-2 text-xs font-bold text-phx-ink">{document.name}</p>
                                    {documentStatusBadge(status)}
                                  </div>
                                  <div className="mt-2 flex items-center gap-2">
                                    <Button
                                      aria-label={
                                        status === "submitted"
                                          ? `Clear submitted tick for ${document.name} for ${employee.fullName}`
                                          : `Mark ${document.name} submitted for ${employee.fullName}`
                                      }
                                      className="h-8 w-8  p-0"
                                      disabled={!canManage || busy}
                                      // Toggle: a second click clears the tick back to pending, so a
                                      // mistaken tick can be undone and re-applied freely.
                                      onClick={() =>
                                        void updateDocumentStatus(
                                          employee,
                                          document,
                                          status === "submitted" ? "pending" : "submitted",
                                        )
                                      }
                                      title={status === "submitted" ? "Clear tick" : "Mark submitted"}
                                      variant={status === "submitted" ? "default" : "secondary"}
                                    >
                                      <Check className="h-4 w-4" />
                                    </Button>
                                    <Button
                                      aria-label={
                                        status === "missing"
                                          ? `Clear missing mark for ${document.name} for ${employee.fullName}`
                                          : `Mark ${document.name} missing for ${employee.fullName}`
                                      }
                                      className="h-8 w-8  p-0"
                                      disabled={!canManage || busy}
                                      // Toggle: a second click clears the missing mark back to pending.
                                      onClick={() =>
                                        void updateDocumentStatus(
                                          employee,
                                          document,
                                          status === "missing" ? "pending" : "missing",
                                          dueDate || null,
                                        )
                                      }
                                      title={status === "missing" ? "Clear mark" : "Mark missing"}
                                      variant={status === "missing" ? "destructive" : "secondary"}
                                    >
                                      <X className="h-4 w-4" />
                                    </Button>
                                    <Button
                                      aria-label={`Scan or upload ${document.name} for ${employee.fullName}`}
                                      className="h-8 gap-1  px-2"
                                      onClick={() => openCapture(employee.hrId, document.id)}
                                      title="Open Scan & Upload"
                                      variant="secondary"
                                    >
                                      <Paperclip className="h-4 w-4" />
                                      <span className="text-xs font-bold">{entry?.fileCount ?? 0}</span>
                                    </Button>
                                  </div>
                                  {status === "submitted" && (entry?.fileCount ?? 0) === 0 ? (
                                    <p className="mt-2 text-phx-xs font-semibold text-[#B45309]">
                                      Ticked, no scan on file
                                    </p>
                                  ) : null}
                                  {status === "missing" ? (
                                    <label className="mt-2 block">
                                      <span className="mb-1 block text-phx-2xs font-black uppercase tracking-[0.12em] text-phx-ink-soft">Deadline</span>
                                      <Input
                                        className="h-9 text-xs"
                                        disabled={!canManage || busy}
                                        onBlur={(event) => {
                                          const previous = deadlineOnFocusRef.current;
                                          deadlineOnFocusRef.current = null;
                                          if (previous !== null && !hiringDeadlineChanged(previous, event.target.value)) return;
                                          void updateDocumentStatus(employee, document, "missing", normalizeHiringDeadline(event.target.value));
                                        }}
                                        onChange={(event) => {
                                          const value = event.target.value;
                                          setData((current) => {
                                            if (!current) return current;
                                            return {
                                              ...current,
                                              employees: current.employees.map((row) => row.hrId === employee.hrId
                                                ? {
                                                  ...row,
                                                  documents: {
                                                    ...row.documents,
                                                    [document.id]: {
                                                      ...row.documents[document.id],
                                                      dueDate: value,
                                                      documentId: document.id,
                                                      status: "missing",
                                                    },
                                                  },
                                                }
                                                : row),
                                            };
                                          });
                                        }}
                                        onFocus={(event) => {
                                          deadlineOnFocusRef.current = event.target.value;
                                        }}
                                        type="date"
                                        value={dueDate}
                                      />
                                    </label>
                                  ) : null}
                                </div>
                              );
  };


  async function refreshDashboard() {
    setIsRefreshing(true);
    setError(null);
    try {
      const response = await fetch("/api/hiring-documents", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.message ?? payload.error ?? "Hiring documents failed to load.");
        return;
      }
      setData(payload);
      setNotice(null);
    } catch {
      setError("Unable to load hiring documents.");
    } finally {
      setIsRefreshing(false);
    }
  }

  /**
   * Download the readiness workbook for EXACTLY what is on screen.
   *
   * The filters travel in the URL and the server applies the same predicate this component filters
   * with, so the file can never quietly widen to the whole company. The workbook itself is built
   * server-side: it wears the house identity, embeds the mark, and colours every cell green, amber
   * or red — none of which belongs in the browser bundle.
   */
  async function exportWorkbook() {
    setIsExporting(true);
    setError(null);
    setNotice(null);
    try {
      const params = hiringDocumentFilterSearchParams(filters);
      const query = params.toString();
      await downloadXlsxFrom(
        `/api/hiring-documents/export${query ? `?${query}` : ""}`,
        "hiring-documents.xlsx",
      );
      setNotice(`Exported ${filteredEmployees.length} employees across ${documents.length} documents.`);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : "Unable to export hiring documents.");
    } finally {
      setIsExporting(false);
    }
  }

  /** Jump to Scan & Upload already pointed at the cell that was clicked. */
  function openCapture(employeeHrId: string, documentId: string) {
    setCaptureTarget({ documentId, employeeHrId });
    setActiveTab("capture");
    setNotice(null);
    setError(null);
  }

  async function updateDocumentStatus(
    employee: HiringDocumentEmployeeRow,
    document: HiringDocumentDefinition,
    status: HiringDocumentStatus,
    dueDate?: string | null,
  ) {
    if (!canManage) return;
    const key = `${employee.hrId}:${document.id}:${status}`;
    setBusyKey(key);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch("/api/hiring-documents", {
        body: JSON.stringify({
          status: {
            documentId: document.id,
            dueDate: dueDate ?? null,
            employeeHrId: employee.hrId,
            status,
          },
          type: "status",
        }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.message ?? payload.error ?? "Unable to update document status.");
        return;
      }
      setData(payload);
      setNotice(`${document.name} updated for ${employee.fullName}.`);
    } catch {
      setError("Unable to update document status.");
    } finally {
      setBusyKey(null);
    }
  }

  async function saveEmployeeNotes(employeeHrId: string, notes: string) {
    if (!canManage) return;
    setBusyKey(`${employeeHrId}:notes`);
    setError(null);
    try {
      const response = await fetch("/api/hiring-documents", {
        body: JSON.stringify({
          notes: {
            employeeHrId,
            notes,
          },
          type: "notes",
        }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.message ?? payload.error ?? "Unable to save notes.");
        return;
      }
      setData(payload);
      setDraftNotes((current) => {
        const next = { ...current };
        delete next[employeeHrId];
        return next;
      });
      setNotice("Notes saved.");
    } catch {
      setError("Unable to save notes.");
    } finally {
      setBusyKey(null);
    }
  }

  async function addDocument() {
    if (!canManage) return;
    setBusyKey("document:create");
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/hiring-documents/definitions", {
        body: JSON.stringify({
          document: {
            description: newDocumentDescription,
            name: newDocumentName,
          },
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.message ?? payload.error ?? "Unable to add hiring document.");
        return;
      }
      setData(payload);
      setNewDocumentName("");
      setNewDocumentDescription("");
      setNotice("Hiring document added to the table.");
    } catch {
      setError("Unable to add hiring document.");
    } finally {
      setBusyKey(null);
    }
  }

  async function deleteDocument(document: HiringDocumentDefinition) {
    if (!canManage) return;
    const confirmed = window.confirm(`Remove "${document.name}" from the hiring documents table?`);
    if (!confirmed) return;

    setBusyKey(`document:${document.id}:delete`);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/hiring-documents/definitions/${encodeURIComponent(document.id)}`, {
        method: "DELETE",
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.message ?? payload.error ?? "Unable to delete hiring document.");
        return;
      }
      setData(payload);
      setNotice("Hiring document removed from the table.");
    } catch {
      setError("Unable to delete hiring document.");
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="relative overflow-hidden rounded-[34px] border border-phx-line bg-phx-paper p-4  sm:p-6">
      <div className="relative space-y-6">
        <AdminPageHero
          actions={
            <div className="flex flex-wrap gap-2">
              <Button
                className="h-11 gap-2 "
                disabled={isExporting || !data}
                onClick={() => void exportWorkbook()}
                variant="secondary"
              >
                {isExporting ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Table2 className="h-4 w-4" />}
                {isExporting ? "Building the workbook" : "Export XLSX"}
              </Button>
              <Button
                className="h-11 gap-2 "
                disabled={isRefreshing}
                onClick={() => void refreshDashboard()}
                variant="secondary"
              >
                {isRefreshing ? <RefreshCw className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Refresh
              </Button>
            </div>
          }
          badges={
            <div className="flex flex-wrap gap-2">
              <AdminInsightChip>{employees.length} employees</AdminInsightChip>
              <AdminInsightChip tone="orange">{documents.length} documents</AdminInsightChip>
              <AdminInsightChip tone="slate">{getCompletionPercent(data)}% complete</AdminInsightChip>
            </div>
          }
          description="Track onboarding document submission by employee, mark delivered documents, set deadlines for missing items, and control the document checklist."
          eyebrow="People Operations"
          icon={<FileCheck2 className="h-3.5 w-3.5" />}
          title="Hiring Documents"
        />

        {error ? (
          <AdminCallout tone="danger">
            <AlertTriangle className="mt-0.5 h-5 w-5 text-[#B91C1C]" />
            <div>
              <h2 className="text-sm font-bold text-[#B91C1C]">Hiring documents unavailable</h2>
              <p className="mt-1 text-sm text-[#991B1B]">{error}</p>
            </div>
          </AdminCallout>
        ) : null}

        {notice ? (
          <AdminCallout tone="success">
            <Check className="mt-0.5 h-5 w-5 text-[#166534]" />
            <p className="text-sm font-bold text-[#166534]">{notice}</p>
          </AdminCallout>
        ) : null}

        {/* Six tiles, so the track goes 2 -> 3 -> 6 rather than the old 2 -> 5: five columns of six
            cards strands one on a row of its own, and three at `lg` keeps two even rows on the
            widths between. */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <AdminStatCard description="Employees in the hiring document workflow." icon={<FileCheck2 className="h-5 w-5" />} label="Employees" value={data?.summary.employees ?? 0} tone="blue" />
          <AdminStatCard description="Active checklist documents controlled by HR." icon={<FilePlus2 className="h-5 w-5" />} label="Documents" value={documents.length} />
          <AdminStatCard description="Documents marked as delivered." icon={<Check className="h-5 w-5" />} label="Submitted" value={data?.summary.submittedDocuments ?? 0} tone="emerald" />
          {/* Scanning progress, as a FRACTION on purpose. A bare count of scans reads as progress on
              its own; what matters is how far it trails the ticks, and on production that gap was 3
              files against 380 ticks. The description carries the gap in words, because the gap IS
              the work — and it says so plainly rather than leaving a reader to subtract. */}
          <AdminStatCard
            description={
              scanGap > 0
                ? `${scanGap} submitted ${scanGap === 1 ? "document has" : "documents have"} no file on record yet.`
                : "Every submitted document has a scan on file."
            }
            icon={<ScanLine className="h-5 w-5" />}
            label="Scanned"
            tone="violet"
            value={`${data?.summary.scannedDocuments ?? 0} / ${data?.summary.submittedDocuments ?? 0}`}
          />
          <AdminStatCard description="Documents marked missing by HR." icon={<X className="h-5 w-5" />} label="Missing" value={data?.summary.missingDocuments ?? 0} tone="rose" />
          <AdminStatCard description="Missing documents with due date today or earlier." icon={<AlertTriangle className="h-5 w-5" />} label="Due" value={data?.summary.dueDocuments ?? 0} tone="orange" />
        </div>

        <HiringJoinersPanel
          canManage={canManage}
          documents={documents}
          employees={employees}
          onReceivePapers={openCapture}
        />

        <div className="flex flex-wrap gap-2  border border-phx-line bg-white p-2 shadow-sm">
          <Button
            className="h-10 "
            onClick={() => setActiveTab("documents")}
            variant={activeTab === "documents" ? "default" : "ghost"}
          >
            Hiring Documents
          </Button>
          <Button
            className="h-10 "
            onClick={() => setActiveTab("capture")}
            variant={activeTab === "capture" ? "default" : "ghost"}
          >
            Scan &amp; Upload
          </Button>
          {canEditChecklist ? (
            <Button
              className="h-10 "
              onClick={() => setActiveTab("control")}
              variant={activeTab === "control" ? "default" : "ghost"}
            >
              Hiring Documents Control
            </Button>
          ) : null}
        </div>

        {activeTab === "capture" ? (
          <AdminTableShell
            description="Photograph a document with the camera and Phoenix turns the pages into one clean PDF, or upload a file the office scanner already produced. Attaching a document ticks it on the checklist."
            title="Scan & Upload"
          >
            <HiringDocumentCapture
              canManage={canManage}
              canRemoveFiles={canRemoveFiles}
              documents={documents}
              employees={employees}
              initialDocumentId={captureTarget?.documentId ?? null}
              initialEmployeeHrId={captureTarget?.employeeHrId ?? null}
              key={`${captureTarget?.employeeHrId ?? ""}:${captureTarget?.documentId ?? ""}`}
              onChanged={refreshDashboard}
            />
          </AdminTableShell>
        ) : null}

        {activeTab === "documents" ? (
          <>
            <AdminTableShell
              description="Filter the employee checklist before updating submitted or missing document status."
              title="Hiring Documents Filters"
            >
                <div className="mb-3 flex flex-wrap gap-2">
                  <Button
                    className="h-10 gap-2 "
                    onClick={() => setAdvancedOpen((value) => !value)}
                    type="button"
                    variant="secondary"
                  >
                    <SlidersHorizontal className="h-4 w-4" />
                    Advanced Filters
                    {advancedOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </Button>
                  <Button
                    className="h-10 "
                    onClick={() => {
                      setQuery("");
                      setLineFilter(allValue);
                      setStatusFilter(allValue);
                      setManagerFilter(allValue);
                      setJobTitleFilter(allValue);
                      setScanningFilter(allValue);
                      setHireDateFrom("");
                      setHireDateTo("");
                      setCompletionMin("");
                      setCompletionMax("");
                    }}
                    type="button"
                    variant="ghost"
                  >
                    Clear Filters
                  </Button>
                </div>
                <div className="grid gap-3 p-4 lg:grid-cols-3">
                  <label className="relative block">
                    <span className="mb-1.5 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">Search</span>
                    <Search className="pointer-events-none absolute left-3 top-10 h-4 w-4 text-phx-ink-soft" />
                    <Input
                    className={`${inputClassName} pl-9`}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Employee, HR ID, manager..."
                    value={query}
                  />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">Line</span>
                  <SearchableSelect className={selectClassName} onChange={(event) => setLineFilter(event.target.value)} value={lineFilter}>
                    <option value={allValue}>All lines</option>
                    {lineOptions.map((line) => <option key={line} value={line}>{line}</option>)}
                  </SearchableSelect>
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">Employee Status</span>
                  <SearchableSelect className={selectClassName} onChange={(event) => setStatusFilter(event.target.value)} value={statusFilter}>
                    <option value={allValue}>All statuses</option>
                    {statusOptions.map((status) => <option key={status} value={status}>{employmentStatusLabel(status)}</option>)}
                  </SearchableSelect>
                </label>
              </div>
              {advancedOpen ? (
                <div className="grid gap-3 border-t border-phx-line bg-white/80 p-4 lg:grid-cols-3">
                  <label className="block">
                    <span className="mb-1.5 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">Manager</span>
                    <SearchableSelect className={selectClassName} onChange={(event) => setManagerFilter(event.target.value)} value={managerFilter}>
                      <option value={allValue}>All managers</option>
                      {managerOptions.map((manager) => <option key={manager} value={manager}>{manager}</option>)}
                    </SearchableSelect>
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">Job Title</span>
                    <SearchableSelect className={selectClassName} onChange={(event) => setJobTitleFilter(event.target.value)} value={jobTitleFilter}>
                      <option value={allValue}>All job titles</option>
                      {jobTitleOptions.map((title) => <option key={title} value={title}>{title}</option>)}
                    </SearchableSelect>
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">Scanning</span>
                    {/* Its own filter, not a completion range: an employee can read 100% complete and
                        still have every one of those documents unscanned, which is the state production
                        is in. No completion range can find that work. */}
                    <select className={selectClassName} onChange={(event) => setScanningFilter(event.target.value)} value={scanningFilter}>
                      <option value={allValue}>All employees</option>
                      <option value={HIRING_DOCUMENT_SCANNING_UNSCANNED}>Only with documents to scan</option>
                    </select>
                  </label>
                  <label className="grid grid-cols-2 gap-2">
                    <div className="space-y-1.5">
                      <span className="mb-1.5 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">Hire Date From</span>
                      <Input className={inputClassName} onChange={(event) => setHireDateFrom(event.target.value)} type="date" value={hireDateFrom} />
                    </div>
                    <div className="space-y-1.5">
                      <span className="mb-1.5 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">Hire Date To</span>
                      <Input className={inputClassName} onChange={(event) => setHireDateTo(event.target.value)} type="date" value={hireDateTo} />
                    </div>
                  </label>
                  <label className="grid grid-cols-2 gap-2">
                    <div className="space-y-1.5">
                      <span className="mb-1.5 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">Completion Min %</span>
                      <Input
                        className={inputClassName}
                        onChange={(event) => setCompletionMin(event.target.value)}
                        type="number"
                        value={completionMin}
                        max={100}
                        min={0}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <span className="mb-1.5 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">Completion Max %</span>
                      <Input
                        className={inputClassName}
                        onChange={(event) => setCompletionMax(event.target.value)}
                        type="number"
                        value={completionMax}
                        max={100}
                        min={0}
                      />
                    </div>
                  </label>
                </div>
              ) : null}
            </AdminTableShell>

            {/* Desktop: one row per employee. The document columns of the old matrix are one checklist
                cell, so the table fits the screen however many documents are configured. */}
            <Card className="hidden overflow-hidden border border-phx-line bg-white p-0 md:block">
              <div className="max-h-[70vh] overflow-y-auto">
                <table className="w-full table-fixed text-sm">
                  <colgroup>
                    <col className="w-[28%]" />
                    <col className="w-[44%]" />
                    <col className="w-[28%]" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th className={frozenHeaderClassName} style={frozenHeaderStyle}>Employee</th>
                      <th className={frozenHeaderClassName} style={frozenHeaderStyle}>Documents</th>
                      <th className={frozenHeaderClassName} style={frozenHeaderStyle}>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredEmployees.length === 0 ? (
                      <tr>
                        <td className="px-3 py-12 text-center text-sm text-phx-ink-soft" colSpan={3}>
                          No employees match the current filters.
                        </td>
                      </tr>
                    ) : (
                      filteredEmployees.map((employee, index) => {
                        const applicableDocuments = hiringDocumentsFor(documents, employee);
                        return (
                          <tr className="hover:bg-phx-accent-soft/40" key={`${employee.hrId}-${index}`}>
                            <td className={`${tableCellClassName} break-words`}>
                              <p className="font-bold text-phx-ink">{employee.fullName}</p>
                              <p className="mt-1 text-xs text-phx-ink-soft">{employee.jobTitle ?? "—"}</p>
                              <p className="mt-1 text-xs text-phx-ink-soft">
                                {employee.lineName ?? "—"} · hired {formatDate(employee.hireDate)}
                              </p>
                              <p className="mt-1 text-xs text-phx-ink-soft">Manager: {employee.managerName ?? "—"}</p>
                              <div className="mt-2 flex flex-wrap items-center gap-2">
                                {statusBadge(employee.employmentStatus)}
                                <Badge variant="neutral">{employeeCompletion(employee, documents)}%</Badge>
                              </div>
                            </td>
                            <td className={`${tableCellClassName} break-words`}>
                              {applicableDocuments.length === 0 ? (
                                <p className="text-xs text-phx-ink-soft">No hiring documents configured.</p>
                              ) : (
                                <div className="divide-y divide-phx-line border border-phx-line">
                                  {applicableDocuments.map((document) => (
                                    <React.Fragment key={`${employee.hrId}:${document.id}`}>
                                      {renderDocumentRow(employee, document)}
                                    </React.Fragment>
                                  ))}
                                </div>
                              )}
                            </td>
                            <td className={tableCellClassName}>
                              <textarea
                                className={cn(phxTextareaClassName, "min-h-24")}
                                disabled={!canManage || busyKey === `${employee.hrId}:notes`}
                                onBlur={(event) => {
                                  const currentValue = event.target.value;
                                  if (currentValue !== (employee.notes ?? "")) void saveEmployeeNotes(employee.hrId, currentValue);
                                }}
                                onChange={(event) => setDraftNotes((current) => ({ ...current, [employee.hrId]: event.target.value }))}
                                placeholder="HR notes..."
                                value={draftNotes[employee.hrId] ?? employee.notes ?? ""}
                              />
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </Card>

            {/* Mobile: one card per employee, name/HR ID as the title, and a compact
                submitted/missing checklist (one row per document type) as the body,
                instead of forcing the 10+ column matrix into a cramped card. */}
            <Card className="divide-y divide-phx-line  border border-phx-line bg-white p-0  md:hidden">
              {filteredEmployees.length === 0 ? (
                <div className="px-4 py-12 text-center text-sm text-phx-ink-soft">
                  No employees match the current filters.
                </div>
              ) : (
                filteredEmployees.map((employee, index) => {
                  const completion = employeeCompletion(employee, documents);
                  // The documents that apply to THIS person: an exit paper is not on an active
                  // employee's card at all, so the count under it is out of what they can actually
                  // be asked for.
                  const applicableDocuments = hiringDocumentsFor(documents, employee);
                  const submittedCount = applicableDocuments.filter(
                    (document) => employee.documents[document.id]?.status === "submitted",
                  ).length;

                  return (
                    <div className="px-4 py-4" key={`${employee.hrId}-${index}-mobile`}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-black text-phx-ink">{employee.fullName}</p>
                          <p className="mt-0.5 text-xs text-phx-ink-soft">{employee.jobTitle ?? "—"}</p>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1.5">
                          {statusBadge(employee.employmentStatus)}
                          <Badge variant="neutral">{completion}%</Badge>
                        </div>
                      </div>

                      <dl className="mt-3 grid grid-cols-2 gap-2">
                        <div className=" border border-phx-line bg-phx-paper px-2.5 py-2">
                          <dt className="text-phx-2xs font-black uppercase tracking-[0.12em] text-phx-ink-faint">Line</dt>
                          <dd className="mt-0.5 break-words text-xs font-bold text-phx-ink">{employee.lineName ?? "—"}</dd>
                        </div>
                        <div className=" border border-phx-line bg-phx-paper px-2.5 py-2">
                          <dt className="text-phx-2xs font-black uppercase tracking-[0.12em] text-phx-ink-faint">Hiring Date</dt>
                          <dd className="mt-0.5 break-words text-xs font-bold text-phx-ink">{formatDate(employee.hireDate)}</dd>
                        </div>
                        <div className="col-span-2  border border-phx-line bg-phx-paper px-2.5 py-2">
                          <dt className="text-phx-2xs font-black uppercase tracking-[0.12em] text-phx-ink-faint">Manager</dt>
                          <dd className="mt-0.5 break-words text-xs font-bold text-phx-ink">
                            {employee.managerName ?? "—"}
                          </dd>
                        </div>
                      </dl>

                      <div className="mt-3">
                        <p className="mb-1.5 text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">
                          Documents ({submittedCount}/{applicableDocuments.length} submitted)
                        </p>
                        <div className="divide-y divide-phx-line  border border-phx-line">
                          {applicableDocuments.length === 0 ? (
                            <div className="px-3 py-3 text-xs text-phx-ink-soft">No hiring documents configured.</div>
                          ) : (
                            applicableDocuments.map((document) => (
                              <React.Fragment key={`${employee.hrId}:${document.id}:mobile`}>
                                {renderDocumentRow(employee, document)}
                              </React.Fragment>
                            ))
                          )}
                        </div>
                      </div>

                      <div className="mt-3">
                        <span className="mb-1.5 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">Notes</span>
                        <textarea
                          className={cn(phxTextareaClassName, "min-h-20")}
                          disabled={!canManage || busyKey === `${employee.hrId}:notes`}
                          onBlur={(event) => {
                            const currentValue = event.target.value;
                            if (currentValue !== (employee.notes ?? "")) void saveEmployeeNotes(employee.hrId, currentValue);
                          }}
                          onChange={(event) => setDraftNotes((current) => ({ ...current, [employee.hrId]: event.target.value }))}
                          placeholder="HR notes..."
                          value={draftNotes[employee.hrId] ?? employee.notes ?? ""}
                        />
                      </div>
                    </div>
                  );
                })
              )}
            </Card>
          </>
        ) : (
          <AdminTableShell
            description="Add or remove checklist documents. New documents immediately appear as new columns in the hiring documents table."
            title="Hiring Documents Control"
          >
            <div className="grid gap-3 p-4 lg:grid-cols-[1fr_1fr_auto]">
              <label className="block">
                <span className="mb-1.5 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">Document Name</span>
                <Input
                  className={inputClassName}
                  disabled={!canManage}
                  onChange={(event) => setNewDocumentName(event.target.value)}
                  placeholder="e.g. Syndicate card"
                  value={newDocumentName}
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">Description</span>
                <Input
                  className={inputClassName}
                  disabled={!canManage}
                  onChange={(event) => setNewDocumentDescription(event.target.value)}
                  placeholder="Optional control note"
                  value={newDocumentDescription}
                />
              </label>
              <div className="flex items-end">
                <Button
                  className="h-10 w-full gap-2  lg:w-auto"
                  disabled={!canManage || !newDocumentName.trim() || busyKey === "document:create"}
                  onClick={() => void addDocument()}
                >
                  <FilePlus2 className="h-4 w-4" />
                  Add
                </Button>
              </div>
            </div>

            {/* Capped so the four headings below have a scrollport to stick against. A short
                document list is shorter than the cap, so it neither scrolls nor freezes — the
                header only pins itself once the list is long enough to need it. */}
            <PortalDesktopTable
                className="text-sm"
                cols={
                  <colgroup>
                    <col className="w-[30%]" />
                    <col className="w-[40%]" />
                    <col className="w-[12%]" />
                    <col className="w-[18%]" />
                  </colgroup>
                }
                maxHeight="70vh"
              >
                <thead>
                  <tr>
                    <th className={`${frozenHeaderClassName} z-30`} style={frozenHeaderStyle}>Document</th>
                    <th className={`${frozenHeaderClassName} z-30`} style={frozenHeaderStyle}>Description</th>
                    <th className={`${frozenHeaderClassName} z-30`} style={frozenHeaderStyle}>Order</th>
                    <th className={`${frozenHeaderClassName} z-30`} style={frozenHeaderStyle}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {documents.length === 0 ? (
                    <tr>
                      <td className="px-3 py-10 text-center text-sm text-phx-ink-soft" colSpan={4}>
                        No hiring documents are configured yet.
                      </td>
                    </tr>
                  ) : (
                    documents.map((document) => (
                      <tr className="hover:bg-phx-accent-soft/40" key={document.id}>
                        {/* The name, and not the row's UUID underneath it. That id was printed
                            under all ten document names — "b748745e-b674-479e-915d-d01f4c84dcd4"
                            below "National ID copy" — and it is a primary key: nothing on this
                            screen asks for it, nobody types it, and the Delete button already
                            carries it in the closure. Names are unique here, so it disambiguates
                            nothing either. */}
                        <td className={tableCellClassName}>
                          <p className="font-bold text-phx-ink">{document.name}</p>
                        </td>
                        <td className={tableCellClassName}>{document.description ?? "—"}</td>
                        <td className={tableCellClassName}>{document.displayOrder}</td>
                        <td className={tableCellClassName}>
                          <Button
                            aria-label={`Delete ${document.name}`}
                            className="h-9 gap-2 "
                            disabled={!canManage || busyKey === `document:${document.id}:delete`}
                            onClick={() => void deleteDocument(document)}
                            variant="destructive"
                          >
                            <Trash2 className="h-4 w-4" />
                            Delete
                          </Button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
            </PortalDesktopTable>

            {/* Mobile: one card per configured document (name as title, order as a badge). */}
            <div className="divide-y divide-phx-line  border border-phx-line md:hidden">
              {documents.length === 0 ? (
                <div className="px-4 py-10 text-center text-sm text-phx-ink-soft">
                  No hiring documents are configured yet.
                </div>
              ) : (
                documents.map((document) => (
                  <div className="px-4 py-3.5" key={`${document.id}-mobile`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-bold text-phx-ink">{document.name}</p>
                      </div>
                      <Badge variant="neutral">Order {document.displayOrder}</Badge>
                    </div>
                    {document.description ? (
                      <p className="mt-2 text-xs text-phx-ink-soft">{document.description}</p>
                    ) : null}
                    <div className="mt-3">
                      <Button
                        aria-label={`Delete ${document.name}`}
                        className="h-9 gap-2 "
                        disabled={!canManage || busyKey === `document:${document.id}:delete`}
                        onClick={() => void deleteDocument(document)}
                        variant="destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                        Delete
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </AdminTableShell>
        )}
      </div>
    </div>
  );
}
