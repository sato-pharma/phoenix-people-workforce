"use client";

import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  FileCheck2,
  FilePlus2,
  RefreshCw,
  Search,
  SlidersHorizontal,
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
import { Input } from "@/components/ui/input";
import { PortalDesktopTable } from "@/components/employee-portal/portal-primitives";
import type {
  HiringDocumentDefinition,
  HiringDocumentEmployeeRow,
  HiringDocumentsDashboardData,
  HiringDocumentStatus,
} from "@/lib/hiring-documents/types";
import { SearchableSelect } from "@/components/ui/searchable-select";


type Props = {
  canManage: boolean;
  initialData: HiringDocumentsDashboardData | null;
  initialError: string | null;
};

type ActiveTab = "documents" | "control";

const allValue = "__all__";
const tableHeaderClassName =
  "border-b border-[#E2E8F0] bg-[#FFF7ED]/80 px-3 py-3 text-left text-[10px] font-black uppercase tracking-[0.16em] text-[#64748B]";
const tableCellClassName = "border-b border-[#E2E8F0] px-3 py-4 align-top";
const inputClassName =
  "h-10 rounded-xl border-[#D8E0EA] bg-white/95 text-sm shadow-sm focus:border-[#FDBA74] focus:ring-[#F97316]/15";
const selectClassName =
  "h-10 w-full rounded-xl border border-[#D8E0EA] bg-white/95 px-3 text-sm font-semibold text-[#0F172A] shadow-sm outline-none focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/15";

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

function parseDateString(value: string) {
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function uniqueOptions(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.filter(Boolean) as string[])).sort((a, b) => a.localeCompare(b));
}

function statusBadge(status: string | null | undefined) {
  const normalized = String(status ?? "active").toLowerCase();
  if (normalized === "active" || normalized === "on_leave") {
    return <Badge variant="success">{normalized.replace(/_/g, " ")}</Badge>;
  }
  if (normalized === "resigned" || normalized === "terminated") {
    return <Badge variant="danger">{normalized}</Badge>;
  }
  return <Badge variant="warning">{normalized || "unknown"}</Badge>;
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

function employeeCompletion(employee: HiringDocumentEmployeeRow, documents: HiringDocumentDefinition[]) {
  if (documents.length === 0) return 0;
  const submitted = documents.filter((document) => employee.documents[document.id]?.status === "submitted").length;
  return Math.round((submitted / documents.length) * 100);
}

export function HiringDocumentsManager({ canManage, initialData, initialError }: Props) {
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
  const [hireDateFrom, setHireDateFrom] = React.useState("");
  const [hireDateTo, setHireDateTo] = React.useState("");
  const [completionMin, setCompletionMin] = React.useState("");
  const [completionMax, setCompletionMax] = React.useState("");
  const [busyKey, setBusyKey] = React.useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const [newDocumentName, setNewDocumentName] = React.useState("");
  const [newDocumentDescription, setNewDocumentDescription] = React.useState("");
  const [draftNotes, setDraftNotes] = React.useState<Record<string, string>>({});
  const tableContainerRef = React.useRef<HTMLDivElement>(null);
  const topScrollRef = React.useRef<HTMLDivElement>(null);
  const [tableScrollWidth, setTableScrollWidth] = React.useState(0);

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

  const filteredEmployees = React.useMemo(() => {
    const search = query.trim().toLowerCase();
    const minCompletion = Number.parseInt(completionMin, 10);
    const maxCompletion = Number.parseInt(completionMax, 10);
    const fromDate = hireDateFrom ? new Date(`${hireDateFrom}T00:00:00`) : null;
    const toDate = hireDateTo ? new Date(`${hireDateTo}T23:59:59`) : null;

    return employees.filter((employee) => {
      const hireDate = parseDateString(employee.hireDate ?? "");
      const completion = employeeCompletion(employee, documents);

      if (fromDate && hireDate && hireDate < fromDate) {
        return false;
      }
      if (toDate && hireDate && hireDate > toDate) {
        return false;
      }
      if (Number.isInteger(minCompletion) && completion < minCompletion) {
        return false;
      }
      if (Number.isInteger(maxCompletion) && completion > maxCompletion) {
        return false;
      }

      const searchable = [
        employee.fullName,
        employee.hrId,
        employee.jobTitle,
        employee.lineName,
        employee.managerName,
      ].filter(Boolean).join(" ").toLowerCase();

      return (
        (!search || searchable.includes(search)) &&
        (lineFilter === allValue || employee.lineName === lineFilter) &&
        (statusFilter === allValue || employee.employmentStatus === statusFilter) &&
        (managerFilter === allValue || employee.managerName === managerFilter) &&
        (jobTitleFilter === allValue || employee.jobTitle === jobTitleFilter)
      );
    });
  }, [completionMax, completionMin, documents, employees, hireDateFrom, hireDateTo, jobTitleFilter, lineFilter, managerFilter, query, statusFilter]);

  React.useEffect(() => {
    const tableElement = tableContainerRef.current;
    const topElement = topScrollRef.current;
    if (!tableElement || !topElement) return;

    const syncFromTable = () => {
      if (topElement.scrollLeft !== tableElement.scrollLeft) {
        topElement.scrollLeft = tableElement.scrollLeft;
      }
    };

    const syncFromTop = () => {
      if (tableElement.scrollLeft !== topElement.scrollLeft) {
        tableElement.scrollLeft = topElement.scrollLeft;
      }
    };

    const updateWidth = () => {
      setTableScrollWidth(tableElement.scrollWidth);
    };

    tableElement.addEventListener("scroll", syncFromTable);
    topElement.addEventListener("scroll", syncFromTop);

    const resizeObserver = new ResizeObserver(updateWidth);
    resizeObserver.observe(tableElement);
    updateWidth();
    window.addEventListener("resize", updateWidth);

    return () => {
      tableElement.removeEventListener("scroll", syncFromTable);
      topElement.removeEventListener("scroll", syncFromTop);
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateWidth);
    };
  }, [activeTab, documents.length]);

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
    <div className="relative overflow-hidden rounded-[34px] border border-[#D8E0EA] bg-[#F8FAFC] p-4 shadow-[0_24px_70px_rgba(15,23,42,0.1)] sm:p-6">
      <div className="relative space-y-6">
        <AdminPageHero
          actions={
            <Button
              className="h-11 gap-2 rounded-2xl"
              disabled={isRefreshing}
              onClick={() => void refreshDashboard()}
              variant="secondary"
            >
              {isRefreshing ? <RefreshCw className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh
            </Button>
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

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <AdminStatCard description="Employees in the hiring document workflow." icon={<FileCheck2 className="h-5 w-5" />} label="Employees" value={data?.summary.employees ?? 0} tone="blue" />
          <AdminStatCard description="Active checklist documents controlled by HR." icon={<FilePlus2 className="h-5 w-5" />} label="Documents" value={documents.length} />
          <AdminStatCard description="Documents marked as delivered." icon={<Check className="h-5 w-5" />} label="Submitted" value={data?.summary.submittedDocuments ?? 0} tone="emerald" />
          <AdminStatCard description="Documents marked missing by HR." icon={<X className="h-5 w-5" />} label="Missing" value={data?.summary.missingDocuments ?? 0} tone="rose" />
          <AdminStatCard description="Missing documents with due date today or earlier." icon={<AlertTriangle className="h-5 w-5" />} label="Due" value={data?.summary.dueDocuments ?? 0} tone="orange" />
        </div>

        <div className="flex flex-wrap gap-2 rounded-2xl border border-[#E2E8F0] bg-white p-2 shadow-sm">
          <Button
            className="h-10 rounded-xl"
            onClick={() => setActiveTab("documents")}
            variant={activeTab === "documents" ? "default" : "ghost"}
          >
            Hiring Documents
          </Button>
          <Button
            className="h-10 rounded-xl"
            onClick={() => setActiveTab("control")}
            variant={activeTab === "control" ? "default" : "ghost"}
          >
            Hiring Documents Control
          </Button>
        </div>

        {activeTab === "documents" ? (
          <>
            <AdminTableShell
              description="Filter the employee checklist before updating submitted or missing document status."
              title="Hiring Documents Filters"
            >
                <div className="mb-3 flex flex-wrap gap-2">
                  <Button
                    className="h-10 gap-2 rounded-xl"
                    onClick={() => setAdvancedOpen((value) => !value)}
                    type="button"
                    variant="secondary"
                  >
                    <SlidersHorizontal className="h-4 w-4" />
                    Advanced Filters
                    {advancedOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </Button>
                  <Button
                    className="h-10 rounded-xl"
                    onClick={() => {
                      setQuery("");
                      setLineFilter(allValue);
                      setStatusFilter(allValue);
                      setManagerFilter(allValue);
                      setJobTitleFilter(allValue);
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
                    <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">Search</span>
                    <Search className="pointer-events-none absolute left-3 top-10 h-4 w-4 text-[#64748B]" />
                    <Input
                    className={`${inputClassName} pl-9`}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Employee, HR ID, manager..."
                    value={query}
                  />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">Line</span>
                  <SearchableSelect className={selectClassName} onChange={(event) => setLineFilter(event.target.value)} value={lineFilter}>
                    <option value={allValue}>All lines</option>
                    {lineOptions.map((line) => <option key={line} value={line}>{line}</option>)}
                  </SearchableSelect>
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">Employee Status</span>
                  <SearchableSelect className={selectClassName} onChange={(event) => setStatusFilter(event.target.value)} value={statusFilter}>
                    <option value={allValue}>All statuses</option>
                    {statusOptions.map((status) => <option key={status} value={status}>{status.replace(/_/g, " ")}</option>)}
                  </SearchableSelect>
                </label>
              </div>
              {advancedOpen ? (
                <div className="grid gap-3 border-t border-[#E2E8F0] bg-white/80 p-4 lg:grid-cols-3">
                  <label className="block">
                    <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">Manager</span>
                    <SearchableSelect className={selectClassName} onChange={(event) => setManagerFilter(event.target.value)} value={managerFilter}>
                      <option value={allValue}>All managers</option>
                      {managerOptions.map((manager) => <option key={manager} value={manager}>{manager}</option>)}
                    </SearchableSelect>
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">Job Title</span>
                    <SearchableSelect className={selectClassName} onChange={(event) => setJobTitleFilter(event.target.value)} value={jobTitleFilter}>
                      <option value={allValue}>All job titles</option>
                      {jobTitleOptions.map((title) => <option key={title} value={title}>{title}</option>)}
                    </SearchableSelect>
                  </label>
                  <label className="grid grid-cols-2 gap-2">
                    <div className="space-y-1.5">
                      <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">Hire Date From</span>
                      <Input className={inputClassName} onChange={(event) => setHireDateFrom(event.target.value)} type="date" value={hireDateFrom} />
                    </div>
                    <div className="space-y-1.5">
                      <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">Hire Date To</span>
                      <Input className={inputClassName} onChange={(event) => setHireDateTo(event.target.value)} type="date" value={hireDateTo} />
                    </div>
                  </label>
                  <label className="grid grid-cols-2 gap-2">
                    <div className="space-y-1.5">
                      <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">Completion Min %</span>
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
                      <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">Completion Max %</span>
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

            {/* Desktop: full document-completion matrix, unchanged, with its synced dual scrollbar. */}
            <Card className="hidden overflow-hidden rounded-2xl border border-[#D8E0EA] bg-white p-0 shadow-[0_20px_48px_rgba(15,23,42,0.1)] md:block">
              <div
                ref={topScrollRef}
                className="overflow-x-auto overflow-y-hidden border-b border-[#E2E8F0] bg-white px-2"
                style={{ width: "100%" }}
              >
                <div aria-hidden className="h-4" style={{ minWidth: tableScrollWidth }} />
              </div>
              <div ref={tableContainerRef} className="overflow-x-auto">
                <table className="min-w-[1180px] text-sm">
                  <thead>
                    <tr>
                      <th className={`${tableHeaderClassName} sticky left-0 z-20 min-w-[280px] bg-[#FFF7ED]`}>Employee</th>
                      <th className={`${tableHeaderClassName} min-w-[120px]`}>Line</th>
                      <th className={`${tableHeaderClassName} min-w-[130px]`}>Hiring Date</th>
                      <th className={`${tableHeaderClassName} min-w-[190px]`}>Manager</th>
                      {documents.map((document) => (
                        <th className={`${tableHeaderClassName} min-w-[210px]`} key={document.id}>{document.name}</th>
                      ))}
                      <th className={`${tableHeaderClassName} min-w-[260px]`}>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredEmployees.length === 0 ? (
                      <tr>
                        <td className="px-3 py-12 text-center text-sm text-[#64748B]" colSpan={5 + documents.length}>
                          No employees match the current filters.
                        </td>
                      </tr>
                    ) : (
                      filteredEmployees.map((employee, index) => (
                        <tr className="hover:bg-[#FFF7ED]/40" key={`${employee.hrId}-${index}`}>
                          <td className={`${tableCellClassName} sticky left-0 z-10 w-[280px] bg-white`}>
                            <p className="font-bold text-[#0F172A]">{employee.fullName}</p>
                            <p className="mt-1 font-mono text-xs text-[#64748B]">{employee.hrId}</p>
                            <p className="mt-1 text-xs text-[#64748B]">{employee.jobTitle ?? "-"}</p>
                            <div className="mt-2 flex items-center gap-2">
                              {statusBadge(employee.employmentStatus)}
                              <Badge variant="neutral">{employeeCompletion(employee, documents)}%</Badge>
                            </div>
                          </td>
                          <td className={tableCellClassName}>{employee.lineName ?? "-"}</td>
                          <td className={tableCellClassName}>{formatDate(employee.hireDate)}</td>
                          <td className={tableCellClassName}>
                            <p className="font-medium text-[#0F172A]">{employee.managerName ?? "-"}</p>
                            <p className="mt-1 font-mono text-xs text-[#64748B]">{employee.managerHrId ?? ""}</p>
                          </td>
                          {documents.map((document) => {
                            const entry = employee.documents[document.id];
                            const dueDate = entry?.dueDate ?? "";
                            const status = entry?.status ?? "pending";
                            const busy = Boolean(busyKey?.startsWith(`${employee.hrId}:${document.id}`));

                            return (
                              <td className={tableCellClassName} key={`${employee.hrId}:${document.id}`}>
                                <div className="space-y-2">
                                  {documentStatusBadge(status)}
                                  <div className="flex items-center gap-2">
                                    <Button
                                      aria-label={`Mark ${document.name} submitted for ${employee.fullName}`}
                                      className="h-8 w-8 rounded-lg p-0"
                                      disabled={!canManage || busy}
                                      onClick={() => void updateDocumentStatus(employee, document, "submitted")}
                                      title="Mark submitted"
                                      variant={status === "submitted" ? "default" : "secondary"}
                                    >
                                      <Check className="h-4 w-4" />
                                    </Button>
                                    <Button
                                      aria-label={`Mark ${document.name} missing for ${employee.fullName}`}
                                      className="h-8 w-8 rounded-lg p-0"
                                      disabled={!canManage || busy}
                                      onClick={() => void updateDocumentStatus(employee, document, "missing", dueDate || null)}
                                      title="Mark missing"
                                      variant={status === "missing" ? "destructive" : "secondary"}
                                    >
                                      <X className="h-4 w-4" />
                                    </Button>
                                  </div>
                                  {status === "missing" ? (
                                    <label className="block">
                                      <span className="mb-1 block text-[10px] font-black uppercase tracking-[0.12em] text-[#64748B]">Deadline</span>
                                      <Input
                                        className="h-9 rounded-lg border-[#FCA5A5] text-xs"
                                        disabled={!canManage || busy}
                                        onBlur={(event) => void updateDocumentStatus(employee, document, "missing", event.target.value || null)}
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
                                        type="date"
                                        value={dueDate}
                                      />
                                    </label>
                                  ) : null}
                                </div>
                              </td>
                            );
                          })}
                          <td className={tableCellClassName}>
                            <textarea
                              className="min-h-24 w-full resize-y rounded-xl border border-[#D8E0EA] bg-white px-3 py-2 text-sm text-[#0F172A] shadow-sm outline-none focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/15"
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
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </Card>

            {/* Mobile: one card per employee, name/HR ID as the title, and a compact
                submitted/missing checklist (one row per document type) as the body,
                instead of forcing the 10+ column matrix into a cramped card. */}
            <Card className="divide-y divide-[#E2E8F0] rounded-2xl border border-[#D8E0EA] bg-white p-0 shadow-[0_20px_48px_rgba(15,23,42,0.1)] md:hidden">
              {filteredEmployees.length === 0 ? (
                <div className="px-4 py-12 text-center text-sm text-[#64748B]">
                  No employees match the current filters.
                </div>
              ) : (
                filteredEmployees.map((employee, index) => {
                  const completion = employeeCompletion(employee, documents);
                  const submittedCount = documents.filter(
                    (document) => employee.documents[document.id]?.status === "submitted",
                  ).length;

                  return (
                    <div className="px-4 py-4" key={`${employee.hrId}-${index}-mobile`}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-black text-[#0F172A]">{employee.fullName}</p>
                          <p className="mt-0.5 font-mono text-xs text-[#64748B]">{employee.hrId}</p>
                          <p className="mt-0.5 text-xs text-[#64748B]">{employee.jobTitle ?? "-"}</p>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1.5">
                          {statusBadge(employee.employmentStatus)}
                          <Badge variant="neutral">{completion}%</Badge>
                        </div>
                      </div>

                      <dl className="mt-3 grid grid-cols-2 gap-2">
                        <div className="rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-2.5 py-2">
                          <dt className="text-[10px] font-black uppercase tracking-[0.12em] text-[#94A3B8]">Line</dt>
                          <dd className="mt-0.5 truncate text-xs font-bold text-[#0F172A]">{employee.lineName ?? "-"}</dd>
                        </div>
                        <div className="rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-2.5 py-2">
                          <dt className="text-[10px] font-black uppercase tracking-[0.12em] text-[#94A3B8]">Hiring Date</dt>
                          <dd className="mt-0.5 truncate text-xs font-bold text-[#0F172A]">{formatDate(employee.hireDate)}</dd>
                        </div>
                        <div className="col-span-2 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-2.5 py-2">
                          <dt className="text-[10px] font-black uppercase tracking-[0.12em] text-[#94A3B8]">Manager</dt>
                          <dd className="mt-0.5 break-words text-xs font-bold text-[#0F172A]">
                            {employee.managerName ?? "-"}
                            {employee.managerHrId ? (
                              <span className="ml-1.5 font-mono text-[10px] font-normal text-[#94A3B8]">
                                {employee.managerHrId}
                              </span>
                            ) : null}
                          </dd>
                        </div>
                      </dl>

                      <div className="mt-3">
                        <p className="mb-1.5 text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">
                          Documents ({submittedCount}/{documents.length} submitted)
                        </p>
                        <div className="divide-y divide-[#E2E8F0] rounded-xl border border-[#E2E8F0]">
                          {documents.length === 0 ? (
                            <div className="px-3 py-3 text-xs text-[#64748B]">No hiring documents configured.</div>
                          ) : (
                            documents.map((document) => {
                              const entry = employee.documents[document.id];
                              const dueDate = entry?.dueDate ?? "";
                              const status = entry?.status ?? "pending";
                              const busy = Boolean(busyKey?.startsWith(`${employee.hrId}:${document.id}`));

                              return (
                                <div className="px-3 py-2.5" key={`${employee.hrId}:${document.id}:mobile`}>
                                  <div className="flex items-center justify-between gap-2">
                                    <p className="min-w-0 pr-2 text-xs font-bold text-[#0F172A]">{document.name}</p>
                                    {documentStatusBadge(status)}
                                  </div>
                                  <div className="mt-2 flex items-center gap-2">
                                    <Button
                                      aria-label={`Mark ${document.name} submitted for ${employee.fullName}`}
                                      className="h-8 w-8 rounded-lg p-0"
                                      disabled={!canManage || busy}
                                      onClick={() => void updateDocumentStatus(employee, document, "submitted")}
                                      title="Mark submitted"
                                      variant={status === "submitted" ? "default" : "secondary"}
                                    >
                                      <Check className="h-4 w-4" />
                                    </Button>
                                    <Button
                                      aria-label={`Mark ${document.name} missing for ${employee.fullName}`}
                                      className="h-8 w-8 rounded-lg p-0"
                                      disabled={!canManage || busy}
                                      onClick={() => void updateDocumentStatus(employee, document, "missing", dueDate || null)}
                                      title="Mark missing"
                                      variant={status === "missing" ? "destructive" : "secondary"}
                                    >
                                      <X className="h-4 w-4" />
                                    </Button>
                                  </div>
                                  {status === "missing" ? (
                                    <label className="mt-2 block">
                                      <span className="mb-1 block text-[10px] font-black uppercase tracking-[0.12em] text-[#64748B]">Deadline</span>
                                      <Input
                                        className="h-9 rounded-lg border-[#FCA5A5] text-xs"
                                        disabled={!canManage || busy}
                                        onBlur={(event) => void updateDocumentStatus(employee, document, "missing", event.target.value || null)}
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
                                        type="date"
                                        value={dueDate}
                                      />
                                    </label>
                                  ) : null}
                                </div>
                              );
                            })
                          )}
                        </div>
                      </div>

                      <div className="mt-3">
                        <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">Notes</span>
                        <textarea
                          className="min-h-20 w-full resize-y rounded-xl border border-[#D8E0EA] bg-white px-3 py-2 text-sm text-[#0F172A] shadow-sm outline-none focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/15"
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
                <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">Document Name</span>
                <Input
                  className={inputClassName}
                  disabled={!canManage}
                  onChange={(event) => setNewDocumentName(event.target.value)}
                  placeholder="e.g. Syndicate card"
                  value={newDocumentName}
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">Description</span>
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
                  className="h-10 w-full gap-2 rounded-xl lg:w-auto"
                  disabled={!canManage || !newDocumentName.trim() || busyKey === "document:create"}
                  onClick={() => void addDocument()}
                >
                  <FilePlus2 className="h-4 w-4" />
                  Add
                </Button>
              </div>
            </div>

            <PortalDesktopTable className="text-sm" minWidth="100%">
                <thead>
                  <tr>
                    <th className={tableHeaderClassName}>Document</th>
                    <th className={tableHeaderClassName}>Description</th>
                    <th className={tableHeaderClassName}>Order</th>
                    <th className={tableHeaderClassName}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {documents.length === 0 ? (
                    <tr>
                      <td className="px-3 py-10 text-center text-sm text-[#64748B]" colSpan={4}>
                        No hiring documents are configured yet.
                      </td>
                    </tr>
                  ) : (
                    documents.map((document) => (
                      <tr className="hover:bg-[#FFF7ED]/40" key={document.id}>
                        <td className={tableCellClassName}>
                          <p className="font-bold text-[#0F172A]">{document.name}</p>
                          <p className="mt-1 font-mono text-xs text-[#94A3B8]">{document.id}</p>
                        </td>
                        <td className={tableCellClassName}>{document.description ?? "-"}</td>
                        <td className={tableCellClassName}>{document.displayOrder}</td>
                        <td className={tableCellClassName}>
                          <Button
                            aria-label={`Delete ${document.name}`}
                            className="h-9 gap-2 rounded-xl"
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

            {/* Mobile: one card per configured document (name/id as title, order as a badge). */}
            <div className="divide-y divide-[#E2E8F0] rounded-xl border border-[#E2E8F0] md:hidden">
              {documents.length === 0 ? (
                <div className="px-4 py-10 text-center text-sm text-[#64748B]">
                  No hiring documents are configured yet.
                </div>
              ) : (
                documents.map((document) => (
                  <div className="px-4 py-3.5" key={`${document.id}-mobile`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-bold text-[#0F172A]">{document.name}</p>
                        <p className="mt-1 font-mono text-xs text-[#94A3B8]">{document.id}</p>
                      </div>
                      <Badge variant="neutral">Order {document.displayOrder}</Badge>
                    </div>
                    {document.description ? (
                      <p className="mt-2 text-xs text-[#64748B]">{document.description}</p>
                    ) : null}
                    <div className="mt-3">
                      <Button
                        aria-label={`Delete ${document.name}`}
                        className="h-9 gap-2 rounded-xl"
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
