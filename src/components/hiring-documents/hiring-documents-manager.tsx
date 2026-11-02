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
  Search,
  SlidersHorizontal,
  Table2,
  Trash2,
  X,
} from "lucide-react";
import * as React from "react";

import { AdminCallout, AdminPageHero, AdminTableShell } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { HiringDocumentCapture } from "@/components/hiring-documents/hiring-document-capture";
import { HiringJoinersPanel } from "@/components/hiring-documents/hiring-joiners-panel";
import { FieldLabel } from "@/components/ui/form-kit";
import { Input } from "@/components/ui/input";
import { PortalDesktopTable } from "@/components/employee-portal/portal-primitives";
import { downloadXlsxFrom } from "@/lib/export/download-xlsx-client";
import { employmentStatusLabel } from "@/lib/employees/employment-status-label";
import { hiringDeadlineChanged, normalizeHiringDeadline } from "@/lib/hiring-documents/deadline";
import {
  HIRING_DOCUMENT_FILTER_ALL,
  HIRING_DOCUMENT_SCANNING_UNSCANNED,
  filterHiringDocumentEmployees,
  hiringDocumentFilterSearchParams,
  type HiringDocumentFilterState,
} from "@/lib/hiring-documents/filters";
import {
  employeePapersStanding,
  HIRING_DOCUMENT_SIGNAL_LABEL,
  hiringDocumentsFor,
  hiringDocumentSignal,
  type HiringDocumentSignal,
} from "@/lib/hiring-documents/readiness-signal";
import type {
  HiringDocumentDefinition,
  HiringDocumentEmployeeRow,
  HiringDocumentsDashboardData,
  HiringDocumentStatus,
} from "@/lib/hiring-documents/types";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { rowDetailToggleProps, TableRowDetail } from "@/components/ui/table-row-detail";
import {
  phxLabelClassName,
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

type ActiveTab = "joiners" | "documents" | "capture" | "control";

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
const tableCellClassName = "border-b border-phx-line px-3 py-3 align-top";
const selectClassName = phxSelectClassName;
const fieldLabelClassName = phxLabelClassName;
const ledgerLabelClassName = "text-phx-2xs font-black uppercase tracking-[0.14em] text-phx-ink-soft";
const ledgerValueClassName = "mt-1 text-2xl font-black tabular-nums text-phx-ink";
const ledgerNoteClassName = "mt-0.5 text-phx-xs font-semibold text-phx-ink-soft";
const documentButtonClassName = "h-auto min-h-9 gap-1 whitespace-normal px-1.5 py-1 text-phx-xs leading-tight";

const SIGNAL_EDGE: Record<HiringDocumentSignal, string> = {
  complete: "border-l-phx-ok",
  missing: "border-l-phx-danger",
  overdue: "border-l-phx-danger",
  pending: "border-l-phx-line",
  unevidenced: "border-l-phx-warn",
};
const SIGNAL_WORD: Record<HiringDocumentSignal, string> = {
  complete: "text-phx-ok",
  missing: "text-phx-danger",
  overdue: "text-phx-danger",
  pending: "text-phx-ink-soft",
  unevidenced: "text-phx-warn",
};

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

/** Said only when it is news: nearly everyone on the list is active. */
function statusWord(status: string | null | undefined) {
  const normalized = String(status ?? "active").toLowerCase();
  // Same words as the filter's <option> list, from the same place.
  const label = employmentStatusLabel(normalized) || "Unknown";
  if (normalized === "active") return null;
  const tone = normalized === "on_leave" ? "text-phx-ink-soft" : normalized === "resigned" || normalized === "terminated" ? "text-phx-danger" : "text-phx-warn";
  return <p className={cn("mt-0.5 text-phx-xs font-black", tone)}>{label}</p>;
}

function getCompletionPercent(data: HiringDocumentsDashboardData | null) {
  if (!data?.summary.totalDocumentSlots) return 0;
  return Math.round((data.summary.submittedDocuments / data.summary.totalDocumentSlots) * 100);
}

export function HiringDocumentsManager({ canEditChecklist, canManage, canRemoveFiles, initialData, initialError }: Props) {
  const [activeTab, setActiveTab] = React.useState<ActiveTab>("joiners");
  const [arrivingCount, setArrivingCount] = React.useState<number | null>(null);
  // Whose papers are open beneath their row: one person at a time.
  const [openHrId, setOpenHrId] = React.useState<string | null>(null);
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
  const captureSectionRef = React.useRef<HTMLDivElement>(null);
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

  // One document's standing and controls for one person. The desktop panel and the phone card both
  // draw it, so the two never drift. Words on the buttons rather than icons: the row is read by someone
  // holding a paper, and a tick, a cross and a paperclip each needed a tooltip to explain.
  const renderDocumentRow = (employee: (typeof filteredEmployees)[number], document: (typeof documents)[number]) => {
    const entry = employee.documents[document.id];
    const dueDate = entry?.dueDate ?? "";
    const status = entry?.status ?? "pending";
    const fileCount = entry?.fileCount ?? 0;
    const busy = Boolean(busyKey?.startsWith(`${employee.hrId}:${document.id}`));
    const signal = hiringDocumentSignal({ dueDate: entry?.dueDate ?? null, fileCount, status });

    return (
      <div className={cn("border border-l-[3px] border-phx-line bg-white px-3 py-2.5 shadow-none", SIGNAL_EDGE[signal])}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <p className="min-w-0 break-words text-sm font-bold text-phx-ink">{document.name}</p>
          <p className={cn("text-phx-xs font-black", SIGNAL_WORD[signal])}>{HIRING_DOCUMENT_SIGNAL_LABEL[signal]}</p>
        </div>
        <div className="mt-2 grid grid-cols-3 gap-1.5">
          <Button
            aria-label={
              status === "submitted"
                ? `Clear submitted tick for ${document.name} for ${employee.fullName}`
                : `Mark ${document.name} submitted for ${employee.fullName}`
            }
            aria-pressed={status === "submitted"}
            className={documentButtonClassName}
            disabled={!canManage || busy}
            // Toggle: a second press clears it back to pending, so a mistaken tick can be undone.
            onClick={() =>
              void updateDocumentStatus(employee, document, status === "submitted" ? "pending" : "submitted")
            }
            variant={status === "submitted" ? "default" : "secondary"}
          >
            <Check className="h-3.5 w-3.5" />
            Submitted
          </Button>
          <Button
            aria-label={
              status === "missing"
                ? `Clear missing mark for ${document.name} for ${employee.fullName}`
                : `Mark ${document.name} missing for ${employee.fullName}`
            }
            aria-pressed={status === "missing"}
            className={documentButtonClassName}
            disabled={!canManage || busy}
            // Toggle: a second press clears the missing mark back to pending.
            onClick={() =>
              void updateDocumentStatus(employee, document, status === "missing" ? "pending" : "missing", dueDate || null)
            }
            variant={status === "missing" ? "destructive" : "secondary"}
          >
            <X className="h-3.5 w-3.5" />
            Missing
          </Button>
          <Button
            aria-label={`Scan or upload ${document.name} for ${employee.fullName}`}
            className={documentButtonClassName}
            onClick={() => openCapture(employee.hrId, document.id)}
            variant="secondary"
          >
            <Paperclip className="h-3.5 w-3.5" />
            {fileCount > 0 ? `${fileCount} on file` : "Scan"}
          </Button>
        </div>
        {status === "missing" ? (
          <label className="mt-2 block">
            <span className={fieldLabelClassName}>Deadline</span>
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

  // The press can come from far down a long list, so the tab it opens starts off the screen. Follow it.
  React.useEffect(() => {
    if (captureTarget) captureSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [captureTarget]);

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

  const hasFilters =
    query !== "" ||
    lineFilter !== allValue ||
    statusFilter !== allValue ||
    managerFilter !== allValue ||
    jobTitleFilter !== allValue ||
    scanningFilter !== allValue ||
    hireDateFrom !== "" ||
    hireDateTo !== "" ||
    completionMin !== "" ||
    completionMax !== "";

  function clearFilters() {
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
  }

  function showUnscanned() {
    clearFilters();
    setScanningFilter(HIRING_DOCUMENT_SCANNING_UNSCANNED);
    setActiveTab("documents");
  }

  const tabs: Array<{ id: ActiveTab; label: string }> = [
    { id: "joiners", label: arrivingCount === null ? "Joiners arriving" : `Joiners arriving · ${arrivingCount}` },
    { id: "documents", label: `All employees · ${employees.length}` },
    { id: "capture", label: "Scan & Upload" },
    ...(canEditChecklist ? [{ id: "control" as const, label: "Checklist" }] : []),
  ];

  const renderNotes = (employee: (typeof filteredEmployees)[number]) => (
    <div>
      <span className={fieldLabelClassName}>Notes</span>
      <textarea
        aria-label={`HR notes for ${employee.fullName}`}
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
    </div>
  );

  const renderPapers = (employee: (typeof filteredEmployees)[number]) => {
    const standing = employeePapersStanding(documents, employee);
    if (standing.total === 0) return <p className="text-phx-xs font-semibold text-phx-ink-soft">No papers asked of them.</p>;
    const percent = Math.round((standing.received / standing.total) * 100);
    const complete = standing.received === standing.total;
    return (
      <div>
        <p className="text-sm font-black tabular-nums text-phx-ink">
          {standing.received} of {standing.total}
          <span className="ml-1 text-phx-xs font-semibold text-phx-ink-soft">submitted</span>
        </p>
        <div
          aria-label={`Papers submitted by ${employee.fullName}`}
          aria-valuemax={standing.total}
          aria-valuemin={0}
          aria-valuenow={standing.received}
          className="mt-1 h-1 w-full bg-phx-line"
          role="progressbar"
        >
          <div className={cn("h-full", complete ? "bg-phx-ok" : "bg-phx-accent")} style={{ width: `${percent}%` }} />
        </div>
        {standing.overdue > 0 || standing.missing > 0 || standing.noScan > 0 ? (
          <p className="mt-1.5 text-phx-xs font-bold">
            {[
              standing.overdue > 0 ? <span className="text-phx-danger" key="overdue">{standing.overdue} overdue</span> : null,
              standing.missing > 0 ? <span className="text-phx-danger" key="missing">{standing.missing} missing</span> : null,
              standing.noScan > 0 ? <span className="text-phx-warn" key="scan">{standing.noScan} no scan</span> : null,
            ]
              .filter(Boolean)
              .map((word, index) => (
                <React.Fragment key={index}>
                  {index > 0 ? " · " : null}
                  {word}
                </React.Fragment>
              ))}
          </p>
        ) : null}
      </div>
    );
  };

  const renderToggle = (employee: (typeof filteredEmployees)[number], panelId: string) => {
    const open = openHrId === employee.hrId;
    const Chevron = open ? ChevronUp : ChevronDown;
    return (
      <Button
        {...rowDetailToggleProps(panelId, open)}
        aria-label={`${open ? "Close" : "Open"} the papers of ${employee.fullName}`}
        className="h-9 w-full gap-1.5"
        onClick={() => setOpenHrId(open ? null : employee.hrId)}
        variant="secondary"
      >
        {open ? "Close" : "Open"}
        <Chevron className="h-4 w-4" />
      </Button>
    );
  };

  return (
    <div className="space-y-5">
      <AdminPageHero
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              className="h-10 gap-2"
              disabled={isExporting || !data}
              onClick={() => void exportWorkbook()}
              variant="secondary"
            >
              {isExporting ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Table2 className="h-4 w-4" />}
              {isExporting ? "Building the workbook" : "Export XLSX"}
            </Button>
            <Button
              className="h-10 gap-2"
              disabled={isRefreshing}
              onClick={() => void refreshDashboard()}
              variant="secondary"
            >
              <RefreshCw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
              Refresh
            </Button>
          </div>
        }
        description={
          canEditChecklist
            ? "Contact the people arriving, receive their papers, and keep the document checklist."
            : "Contact the people arriving and receive their papers."
        }
        eyebrow="People Operations"
        icon={<FileCheck2 className="h-3.5 w-3.5" />}
        title="Hiring Documents"
      />

      {/* The page runs long, so a message that stays at the top is a message nobody reads. It follows. */}
      {error || notice ? (
        <div aria-live="polite" className="sticky top-2 z-20 space-y-2">
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
        </div>
      ) : null}

      {/* One flat strip, so the first screen is the work. No figures when the read failed: an
          unavailable source says so above, and a row of zeros would read as an answer. */}
      {data ? (
        <dl className="grid grid-cols-2 gap-px border border-phx-line bg-phx-line lg:grid-cols-5">
          <div className="col-span-2 bg-white px-4 py-3 lg:col-span-1">
            <dt className={ledgerLabelClassName}>Employees</dt>
            <dd className={ledgerValueClassName}>{data.summary.employees}</dd>
            <dd className={ledgerNoteClassName}>{documents.length} papers on the checklist</dd>
          </div>
          <div className="bg-white px-4 py-3">
            <dt className={ledgerLabelClassName}>Submitted</dt>
            <dd className={ledgerValueClassName}>
              {data.summary.submittedDocuments}
              <span className="text-sm font-bold text-phx-ink-soft"> of {data.summary.totalDocumentSlots}</span>
            </dd>
            <dd className={ledgerNoteClassName}>{getCompletionPercent(data)}% of what is owed</dd>
          </div>
          {/* A fraction on purpose: what matters is how far the scans trail the ticks, and the gap IS
              the work, so it is said in words and is one press from the people it means. */}
          <div className="bg-white px-4 py-3">
            <dt className={ledgerLabelClassName}>Scanned</dt>
            <dd className={ledgerValueClassName}>
              {data.summary.scannedDocuments}
              <span className="text-sm font-bold text-phx-ink-soft"> of {data.summary.submittedDocuments}</span>
            </dd>
            <dd className={ledgerNoteClassName}>
              {scanGap > 0 ? (
                <button className="text-left font-bold text-phx-accent-press hover:underline" onClick={showUnscanned} type="button">
                  {scanGap} with no file. Show who
                </button>
              ) : (
                "Every submitted paper has a scan"
              )}
            </dd>
          </div>
          <div className="bg-white px-4 py-3">
            <dt className={ledgerLabelClassName}>Missing</dt>
            <dd className={cn(ledgerValueClassName, data.summary.missingDocuments > 0 && "text-phx-warn")}>{data.summary.missingDocuments}</dd>
            <dd className={ledgerNoteClassName}>Marked missing by HR</dd>
          </div>
          <div className="bg-white px-4 py-3">
            <dt className={ledgerLabelClassName}>Due</dt>
            <dd className={cn(ledgerValueClassName, data.summary.dueDocuments > 0 && "text-phx-danger")}>{data.summary.dueDocuments}</dd>
            <dd className={ledgerNoteClassName}>Deadline today or earlier</dd>
          </div>
        </dl>
      ) : null}

      <div className="scroll-mt-4" ref={captureSectionRef}>
        <div aria-label="Hiring documents sections" className="grid grid-cols-2 border-b border-phx-line sm:flex sm:flex-wrap" role="tablist">
          {tabs.map((tab) => (
            <button
              aria-selected={activeTab === tab.id}
              className={cn(
                "-mb-px min-h-11 border-b-2 px-4 py-2 text-left text-sm transition-colors",
                activeTab === tab.id
                  ? "border-phx-accent font-black text-phx-ink"
                  : "border-transparent font-bold text-phx-ink-soft hover:text-phx-ink",
              )}
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              role="tab"
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="pt-4">
          {/* Stays mounted on every tab: going to receive a paper and coming back must not lose what
              was typed for a joiner, and the tab above reads its count from here. */}
          <div className={activeTab === "joiners" ? undefined : "hidden"}>
            <HiringJoinersPanel
              canManage={canManage}
              documents={documents}
              employees={employees}
              onArrivingCount={setArrivingCount}
              onReceivePapers={openCapture}
            />
          </div>

          {activeTab === "capture" ? (
            <AdminTableShell
              description="Photograph a document and Phoenix turns the pages into one clean PDF, or upload a file the office scanner already produced. Attaching a document ticks it on the checklist."
              title="Scan & Upload"
            >
              <div className="p-4">
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
              </div>
            </AdminTableShell>
          ) : null}

          {activeTab === "documents" ? (
            <div className="space-y-3">
              <div className="border border-phx-line bg-white p-4 shadow-none">
                <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
                  <div>
                    <FieldLabel htmlFor="hiring-documents-search">Search</FieldLabel>
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-phx-ink-soft" />
                      <Input
                        className="pl-9"
                        id="hiring-documents-search"
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Employee, HR ID, manager"
                        value={query}
                      />
                    </div>
                  </div>
                  <div>
                    <FieldLabel htmlFor="hiring-documents-line">Line</FieldLabel>
                    <SearchableSelect className={selectClassName} id="hiring-documents-line" onChange={(event) => setLineFilter(event.target.value)} value={lineFilter}>
                      <option value={allValue}>All lines</option>
                      {lineOptions.map((line) => <option key={line} value={line}>{line}</option>)}
                    </SearchableSelect>
                  </div>
                  <div>
                    <FieldLabel htmlFor="hiring-documents-status">Employee Status</FieldLabel>
                    <SearchableSelect className={selectClassName} id="hiring-documents-status" onChange={(event) => setStatusFilter(event.target.value)} value={statusFilter}>
                      <option value={allValue}>All statuses</option>
                      {statusOptions.map((status) => <option key={status} value={status}>{employmentStatusLabel(status)}</option>)}
                    </SearchableSelect>
                  </div>
                  <div className="flex items-end">
                    <Button
                      aria-expanded={advancedOpen}
                      className="h-10 w-full gap-2 md:w-auto"
                      onClick={() => setAdvancedOpen((value) => !value)}
                      type="button"
                      variant="secondary"
                    >
                      <SlidersHorizontal className="h-4 w-4" />
                      More filters
                      {advancedOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </Button>
                  </div>
                </div>

                {advancedOpen ? (
                  <div className="mt-3 grid gap-3 border-t border-phx-line pt-3 md:grid-cols-2 xl:grid-cols-3">
                    <div>
                      <FieldLabel htmlFor="hiring-documents-manager">Manager</FieldLabel>
                      <SearchableSelect className={selectClassName} id="hiring-documents-manager" onChange={(event) => setManagerFilter(event.target.value)} value={managerFilter}>
                        <option value={allValue}>All managers</option>
                        {managerOptions.map((manager) => <option key={manager} value={manager}>{manager}</option>)}
                      </SearchableSelect>
                    </div>
                    <div>
                      <FieldLabel htmlFor="hiring-documents-title">Job Title</FieldLabel>
                      <SearchableSelect className={selectClassName} id="hiring-documents-title" onChange={(event) => setJobTitleFilter(event.target.value)} value={jobTitleFilter}>
                        <option value={allValue}>All job titles</option>
                        {jobTitleOptions.map((title) => <option key={title} value={title}>{title}</option>)}
                      </SearchableSelect>
                    </div>
                    <div>
                      <FieldLabel htmlFor="hiring-documents-scanning">Scanning</FieldLabel>
                      {/* Its own filter, not a completion range: an employee can read 100% complete and
                          still have every one of those documents unscanned, and no range can find that. */}
                      <select className={selectClassName} id="hiring-documents-scanning" onChange={(event) => setScanningFilter(event.target.value)} value={scanningFilter}>
                        <option value={allValue}>All employees</option>
                        <option value={HIRING_DOCUMENT_SCANNING_UNSCANNED}>Only with documents to scan</option>
                      </select>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <FieldLabel htmlFor="hiring-documents-hired-from">Hired from</FieldLabel>
                        <Input id="hiring-documents-hired-from" onChange={(event) => setHireDateFrom(event.target.value)} type="date" value={hireDateFrom} />
                      </div>
                      <div>
                        <FieldLabel htmlFor="hiring-documents-hired-to">Hired to</FieldLabel>
                        <Input id="hiring-documents-hired-to" onChange={(event) => setHireDateTo(event.target.value)} type="date" value={hireDateTo} />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <FieldLabel htmlFor="hiring-documents-completion-min">Completion min %</FieldLabel>
                        <Input id="hiring-documents-completion-min" max={100} min={0} onChange={(event) => setCompletionMin(event.target.value)} type="number" value={completionMin} />
                      </div>
                      <div>
                        <FieldLabel htmlFor="hiring-documents-completion-max">Completion max %</FieldLabel>
                        <Input id="hiring-documents-completion-max" max={100} min={0} onChange={(event) => setCompletionMax(event.target.value)} type="number" value={completionMax} />
                      </div>
                    </div>
                  </div>
                ) : null}

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-phx-line pt-3">
                  <p className="text-phx-xs font-bold tabular-nums text-phx-ink-soft">
                    Showing {filteredEmployees.length} of {employees.length}. Export XLSX follows these filters.
                  </p>
                  {hasFilters ? (
                    <Button className="h-8" onClick={clearFilters} type="button" variant="ghost">
                      Clear filters
                    </Button>
                  ) : null}
                </div>
              </div>

              {/* Desktop: ONE LINE PER EMPLOYEE. Ten papers with three controls each made every row
                  about 700px tall, so a list of two hundred people could not be read at all. A row's
                  papers open beneath it as its joined panel, one person at a time. */}
              <div className="hidden border border-phx-line bg-white shadow-none md:block">
                <div className="max-h-[75vh] overflow-y-auto">
                  <table className="w-full table-fixed text-sm">
                    <colgroup>
                      <col className="w-[34%]" />
                      <col className="w-[24%]" />
                      <col className="w-[28%]" />
                      <col className="w-[14%]" />
                    </colgroup>
                    <thead>
                      <tr>
                        <th className={frozenHeaderClassName} style={frozenHeaderStyle}>Employee</th>
                        <th className={frozenHeaderClassName} style={frozenHeaderStyle}>Line and manager</th>
                        <th className={frozenHeaderClassName} style={frozenHeaderStyle}>Papers</th>
                        <th className={frozenHeaderClassName} style={frozenHeaderStyle}>Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredEmployees.length === 0 ? (
                        <tr>
                          <td className="px-3 py-12 text-center text-sm text-phx-ink-soft" colSpan={4}>
                            {data ? "No employees match the current filters." : "The list could not be read. Press Refresh to try again."}
                          </td>
                        </tr>
                      ) : (
                        filteredEmployees.map((employee, index) => {
                          const panelId = `hiring-employee-panel-${index}`;
                          return (
                            <React.Fragment key={`${employee.hrId}-${index}`}>
                              <tr>
                                <td className={`${tableCellClassName} break-words`}>
                                  <p className="font-black text-phx-ink" dir="auto">{employee.fullName}</p>
                                  <p className="mt-0.5 text-phx-xs font-semibold text-phx-ink-soft">
                                    {employee.jobTitle ?? "No job title"}
                                  </p>
                                  {statusWord(employee.employmentStatus)}
                                </td>
                                <td className={`${tableCellClassName} break-words`}>
                                  <p className="text-phx-xs font-bold text-phx-ink">{employee.lineName ?? "No line"}</p>
                                  <p className="mt-0.5 text-phx-xs font-semibold text-phx-ink-soft">{employee.managerName ?? "No manager"}</p>
                                  <p className="text-phx-xs font-semibold text-phx-ink-faint">Hired {formatDate(employee.hireDate)}</p>
                                </td>
                                <td className={tableCellClassName}>{renderPapers(employee)}</td>
                                <td className={tableCellClassName}>{renderToggle(employee, panelId)}</td>
                              </tr>
                              {openHrId === employee.hrId ? (
                                <TableRowDetail className="px-3 pb-4" colSpan={4} id={panelId}>
                                  <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
                                    <div className="grid content-start gap-2 lg:grid-cols-2">
                                      {hiringDocumentsFor(documents, employee).map((document) => (
                                        <React.Fragment key={`${employee.hrId}:${document.id}`}>
                                          {renderDocumentRow(employee, document)}
                                        </React.Fragment>
                                      ))}
                                    </div>
                                    {renderNotes(employee)}
                                  </div>
                                </TableRowDetail>
                              ) : null}
                            </React.Fragment>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Phone: the same one line per person, as a card, with the same panel under it. */}
              <div className="space-y-3 md:hidden">
                {filteredEmployees.length === 0 ? (
                  <div className="border border-phx-line bg-white px-4 py-12 text-center text-sm text-phx-ink-soft shadow-none">
                    {data ? "No employees match the current filters." : "The list could not be read. Press Refresh to try again."}
                  </div>
                ) : (
                  filteredEmployees.map((employee, index) => {
                    const panelId = `hiring-employee-card-panel-${index}`;
                    return (
                      <div className="space-y-3 border border-phx-line bg-white p-4 shadow-none" key={`${employee.hrId}-${index}-mobile`}>
                        <div className="min-w-0">
                          <p className="break-words text-sm font-black text-phx-ink" dir="auto">{employee.fullName}</p>
                          <p className="mt-0.5 break-words text-phx-xs font-semibold text-phx-ink-soft">{employee.jobTitle ?? "No job title"}</p>
                          <p className="break-words text-phx-xs font-semibold text-phx-ink-soft">
                            {employee.lineName ?? "No line"} · {employee.managerName ?? "No manager"}
                          </p>
                          <p className="text-phx-xs font-semibold text-phx-ink-faint">Hired {formatDate(employee.hireDate)}</p>
                          {statusWord(employee.employmentStatus)}
                        </div>
                        {renderPapers(employee)}
                        {renderToggle(employee, panelId)}
                        {openHrId === employee.hrId ? (
                          <div className="space-y-2 border-t border-phx-line pt-3" id={panelId}>
                            {hiringDocumentsFor(documents, employee).map((document) => (
                              <React.Fragment key={`${employee.hrId}:${document.id}:mobile`}>
                                {renderDocumentRow(employee, document)}
                              </React.Fragment>
                            ))}
                            {renderNotes(employee)}
                          </div>
                        ) : null}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          ) : null}

          {/* ONLY on its own tab. This was the `else` of "documents", so it also drew under Scan & Upload,
              and the seat that may not change the checklist was offered Add and Delete there. */}
          {activeTab === "control" && canEditChecklist ? (
            <AdminTableShell
              description="Add or remove checklist documents. A new document appears on every employee's checklist at once."
              title="Checklist"
            >
              <div className="grid gap-3 p-4 lg:grid-cols-[1fr_1fr_auto]">
                <div>
                  <FieldLabel htmlFor="hiring-documents-new-name">Document Name</FieldLabel>
                  <Input
                    disabled={!canManage}
                    id="hiring-documents-new-name"
                    onChange={(event) => setNewDocumentName(event.target.value)}
                    placeholder="e.g. Syndicate card"
                    value={newDocumentName}
                  />
                </div>
                <div>
                  <FieldLabel htmlFor="hiring-documents-new-description">Description</FieldLabel>
                  <Input
                    disabled={!canManage}
                    id="hiring-documents-new-description"
                    onChange={(event) => setNewDocumentDescription(event.target.value)}
                    placeholder="Optional control note"
                    value={newDocumentDescription}
                  />
                </div>
                <div className="flex items-end">
                  <Button
                    className="h-10 w-full gap-2 lg:w-auto"
                    disabled={!canManage || !newDocumentName.trim() || busyKey === "document:create"}
                    onClick={() => void addDocument()}
                  >
                    <FilePlus2 className="h-4 w-4" />
                    Add
                  </Button>
                </div>
              </div>

              {/* Capped so the four headings below have a scrollport to stick against. A short
                  document list is shorter than the cap, so it neither scrolls nor freezes. */}
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
                      <tr key={document.id}>
                        {/* The name, and not the row's UUID underneath it: nothing here asks for a
                            primary key, and the Delete button already carries it in the closure. */}
                        <td className={tableCellClassName}>
                          <p className="font-bold text-phx-ink">{document.name}</p>
                        </td>
                        <td className={tableCellClassName}>{document.description ?? "None"}</td>
                        <td className={tableCellClassName}>{document.displayOrder}</td>
                        <td className={tableCellClassName}>
                          <Button
                            aria-label={`Delete ${document.name}`}
                            className="h-9 gap-2"
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

              {/* Phone: one card per configured document. */}
              <div className="divide-y divide-phx-line border-t border-phx-line md:hidden">
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
                        <span className="shrink-0 text-phx-xs font-bold text-phx-ink-soft">Order {document.displayOrder}</span>
                      </div>
                      {document.description ? (
                        <p className="mt-2 text-xs text-phx-ink-soft">{document.description}</p>
                      ) : null}
                      <div className="mt-3">
                        <Button
                          aria-label={`Delete ${document.name}`}
                          className="h-9 gap-2"
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
          ) : null}
        </div>
      </div>
    </div>
  );
}
