"use client";

import {
  AlertCircle,
  Building2,
  Check,
  Download,
  Pencil,
  RefreshCw,
  Search,
  Upload,
  UserPlus,
  X,
} from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-state";
import { formatNumberValue } from "@/lib/i18n/format";
import type {
  EmployeeDirectoryData,
  EmployeeDirectoryRow,
  EmployeeLookupOption,
  EmployeeMutationInput,
} from "@/lib/employees/employee-directory";
import { cn } from "@/lib/utils";

type EmployeeManagementProps = {
  initialData?: EmployeeDirectoryData | null;
  initialError?: string | null;
};

type EmployeeFormState = {
  areaId: string;
  crmId: string;
  crmUsername: string;
  departmentId: string;
  education: string;
  employmentStatus: string;
  fullName: string;
  hireDate: string;
  hrId: string;
  jobTitle: string;
  lineId: string;
  managerHrId: string;
  mobileNumber: string;
  nameAr: string;
  positionId: string;
  salaryPaymentMode: string;
  workEmail: string;
};

const emptyForm: EmployeeFormState = {
  areaId: "",
  crmId: "",
  crmUsername: "",
  departmentId: "",
  education: "",
  employmentStatus: "active",
  fullName: "",
  hireDate: "",
  hrId: "",
  jobTitle: "",
  lineId: "",
  managerHrId: "",
  mobileNumber: "",
  nameAr: "",
  positionId: "",
  salaryPaymentMode: "one_part",
  workEmail: "",
};

const salaryPaymentModeOptions = [
  {
    label: "One Part",
    value: "one_part",
  },
  {
    label: "Two Parts",
    value: "two_parts",
  },
];

function SummaryCard({
  label,
  tone = "neutral",
  value,
}: {
  label: string;
  tone?: "neutral" | "success" | "warning" | "danger";
  value: number;
}) {
  const toneClass = {
    danger: "bg-rose-50 text-rose-800",
    neutral: "bg-[#F8FAFC] text-[#0F172A]",
    success: "bg-emerald-50 text-emerald-800",
    warning: "bg-orange-50 text-orange-800",
  }[tone];

  return (
    <div className={cn("rounded-2xl border border-[#E2E8F0] p-4", toneClass)}>
      <p className="text-[10px] font-bold uppercase tracking-[0.16em] opacity-70">{label}</p>
      <p className="mt-2 font-mono text-2xl font-bold">
        {formatNumberValue(value)}
      </p>
    </div>
  );
}

function emptyText(value: string | number | null | undefined) {
  return value === null || value === undefined || value === "" ? "-" : String(value);
}

function statusBadgeVariant(status: string | null) {
  if (!status || status === "active") {
    return "success" as const;
  }

  if (status === "inactive" || status === "on_leave") {
    return "warning" as const;
  }

  return "danger" as const;
}

function optionName(value: string) {
  return value.replace(/_/g, " ");
}

function isMedicalRepTitle(value: string | null | undefined) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return (
    normalized.includes("medical representative") ||
    normalized.includes("medical rep") ||
    normalized === "mr"
  );
}

function SelectField({
  className,
  disabled = false,
  label,
  onChange,
  options,
  placeholder,
  value,
}: {
  className?: string;
  disabled?: boolean;
  label: string;
  onChange: (value: string) => void;
  options: EmployeeLookupOption[];
  placeholder?: string;
  value: string;
}) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1.5 block text-xs font-medium text-text-secondary">
        {label}
      </span>
      <select
        className="h-10 w-full rounded-lg border border-border bg-white px-3 text-sm text-text transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        <option value="">{placeholder ?? `Select ${label.toLowerCase()}`}</option>
        {options.map((option) => (
          <option key={`${option.value}-${option.label}`} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function TextField({
  label,
  onChange,
  placeholder,
  type = "text",
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  value: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-text-secondary">
        {label}
      </span>
      <Input
        className="bg-white"
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        type={type}
        value={value}
      />
    </label>
  );
}

function employeeToForm(employee: EmployeeDirectoryRow): EmployeeFormState {
  return {
    areaId: employee.areaId ? String(employee.areaId) : "",
    crmId: employee.crmId ?? "",
    crmUsername: employee.crmUsername ?? "",
    departmentId: employee.departmentId ? String(employee.departmentId) : "",
    education: employee.education ?? "",
    employmentStatus: employee.employmentStatus ?? "active",
    fullName: employee.fullName,
    hireDate: employee.hireDate ?? "",
    hrId: employee.hrId,
    jobTitle: employee.jobTitle ?? employee.positionTitle ?? "",
    lineId: employee.lineId ? String(employee.lineId) : "",
    managerHrId: employee.managerHrId ?? "",
    mobileNumber: employee.mobileNumber ?? "",
    nameAr: employee.nameAr ?? "",
    positionId: employee.positionId ? String(employee.positionId) : "",
    salaryPaymentMode: employee.salaryPaymentMode,
    workEmail: employee.workEmail ?? "",
  };
}

function formToPayload(form: EmployeeFormState): EmployeeMutationInput {
  const optionalNumber = (value: string) => (value ? Number(value) : null);
  const optionalText = (value: string) => value.trim() || null;

  return {
    areaId: optionalNumber(form.areaId),
    crmId: optionalText(form.crmId),
    crmUsername: optionalText(form.crmUsername),
    departmentId: optionalNumber(form.departmentId),
    education: optionalText(form.education),
    employmentStatus: optionalText(form.employmentStatus),
    fullName: optionalText(form.fullName),
    hireDate: optionalText(form.hireDate),
    hrId: optionalText(form.hrId),
    jobTitle: optionalText(form.jobTitle),
    lineId: optionalNumber(form.lineId),
    managerHrId: optionalText(form.managerHrId),
    mobileNumber: optionalText(form.mobileNumber),
    nameAr: optionalText(form.nameAr),
    positionId: optionalNumber(form.positionId),
    salaryPaymentMode: optionalText(form.salaryPaymentMode),
    workEmail: optionalText(form.workEmail),
  };
}

export function EmployeeManagement({
  initialData = null,
  initialError = null,
}: EmployeeManagementProps) {
  const [data, setData] = React.useState<EmployeeDirectoryData | null>(
    initialData,
  );
  const [error, setError] = React.useState<string | null>(initialError);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isImportingTemplate, setIsImportingTemplate] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);
  const [areaFilter, setAreaFilter] = React.useState("");
  const [departmentFilter, setDepartmentFilter] = React.useState("");
  const [lineFilter, setLineFilter] = React.useState("");
  const [managerFilter, setManagerFilter] = React.useState("");
  const [positionFilter, setPositionFilter] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [salaryPaymentModeFilter, setSalaryPaymentModeFilter] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("");
  const [form, setForm] = React.useState<EmployeeFormState>(emptyForm);
  const [editingHrId, setEditingHrId] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [isFormOpen, setIsFormOpen] = React.useState(false);
  const templateInputRef = React.useRef<HTMLInputElement | null>(null);

  const employees = React.useMemo(() => data?.employees ?? [], [data?.employees]);
  const lookups = React.useMemo(
    () =>
      data?.lookups ?? {
        areas: [],
        departments: [],
        lines: [],
        managers: [],
        medicalRepVacancies: [],
        positions: [],
        statuses: [],
      },
    [data?.lookups],
  );

  const selectedPositionTitle = React.useMemo(() => {
    return lookups.positions.find((position) => position.value === form.positionId)?.label ?? "";
  }, [lookups.positions, form.positionId]);

  const isManualMedicalRep = React.useMemo(() => {
    return isMedicalRepTitle(form.jobTitle) || isMedicalRepTitle(selectedPositionTitle);
  }, [form.jobTitle, selectedPositionTitle]);

  const filteredManualVacantAreas = React.useMemo(() => {
    if (!isManualMedicalRep) return [];
    return (lookups.medicalRepVacancies ?? []).filter(
      (v) => String(v.lineId) === String(form.lineId),
    );
  }, [isManualMedicalRep, lookups.medicalRepVacancies, form.lineId]);

  // Debugging in development
  React.useEffect(() => {
    if (process.env.NODE_ENV === "development") {
      console.log("manual medical rep", isManualMedicalRep);
      console.log("manual selected position", selectedPositionTitle);
      console.log("manual vacant areas", filteredManualVacantAreas);
    }
  }, [isManualMedicalRep, selectedPositionTitle, filteredManualVacantAreas]);

  const loadEmployees = React.useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/employees", { cache: "no-store" });
      const payload = await response.json();

      if (!response.ok) {
        setError(payload.message ?? payload.error ?? "employee_load_failed");
        return;
      }

      setData(payload);
    } catch {
      setError("Unable to load employees.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  const filteredEmployees = React.useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return employees.filter((employee) => {
      const searchable = [
        employee.hrId,
        employee.fullName,
        employee.nameAr,
        employee.workEmail,
        employee.mobileNumber,
        employee.jobTitle,
        employee.positionTitle,
        employee.departmentName,
        employee.lineName,
        employee.areaName,
        employee.managerName,
        employee.managerHrId,
        employee.crmId,
        employee.crmUsername,
        employee.salaryPaymentMode === "two_parts" ? "two parts" : "one part",
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return (
        (!normalizedQuery || searchable.includes(normalizedQuery)) &&
        (!departmentFilter || String(employee.departmentId ?? "") === departmentFilter) &&
        (!lineFilter || String(employee.lineId ?? "") === lineFilter) &&
        (!areaFilter || String(employee.areaId ?? "") === areaFilter) &&
        (!positionFilter || String(employee.positionId ?? "") === positionFilter) &&
        (!managerFilter || employee.managerHrId === managerFilter) &&
        (!salaryPaymentModeFilter ||
          employee.salaryPaymentMode === salaryPaymentModeFilter) &&
        (!statusFilter ||
          (employee.employmentStatus ?? "active") === statusFilter)
      );
    });
  }, [
    areaFilter,
    departmentFilter,
    employees,
    lineFilter,
    managerFilter,
    positionFilter,
    query,
    salaryPaymentModeFilter,
    statusFilter,
  ]);
  const hasActiveFilters = Boolean(
    areaFilter ||
      departmentFilter ||
      lineFilter ||
      managerFilter ||
      positionFilter ||
      query ||
      salaryPaymentModeFilter ||
      statusFilter,
  );
  const activeFilterCount = [
    areaFilter,
    departmentFilter,
    lineFilter,
    managerFilter,
    positionFilter,
    query,
    salaryPaymentModeFilter,
    statusFilter,
  ].filter(Boolean).length;

  function updateForm(key: keyof EmployeeFormState, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function clearFilters() {
    setAreaFilter("");
    setDepartmentFilter("");
    setLineFilter("");
    setManagerFilter("");
    setPositionFilter("");
    setQuery("");
    setSalaryPaymentModeFilter("");
    setStatusFilter("");
  }

  function startCreate() {
    setEditingHrId(null);
    setForm(emptyForm);
    setNotice(null);
    setIsFormOpen(true);
  }

  function startEdit(employee: EmployeeDirectoryRow) {
    setEditingHrId(employee.hrId);
    setForm(employeeToForm(employee));
    setNotice(null);
    setIsFormOpen(true);
  }

  function closeForm() {
    setIsFormOpen(false);
  }

  async function saveEmployee() {
    setIsSaving(true);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch("/api/employees", {
        body: JSON.stringify({ employee: formToPayload(form) }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();

      if (!response.ok) {
        setError(payload.message ?? payload.error ?? "employee_save_failed");
        return;
      }

      setData(payload);
      setNotice(editingHrId ? "Employee updated." : "Employee created.");
      setEditingHrId(null);
      setForm(emptyForm);
      closeForm();
    } catch {
      setError("Unable to save employee.");
    } finally {
      setIsSaving(false);
    }
  }

  async function uploadTemplate(file: File | null) {
    if (!file) {
      return;
    }

    setIsImportingTemplate(true);
    setError(null);
    setNotice(null);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const response = await fetch("/api/imports/employees/confirm", {
        body: formData,
        method: "POST",
      });
      const payload = await response.json();

      if (!response.ok) {
        setError(payload.message ?? payload.error ?? "template_import_failed");
        return;
      }

      await loadEmployees();
      setNotice(
        `Template processed: ${payload.importedEmployees ?? 0} created, ${
          payload.updatedEmployees ?? 0
        } updated.`,
      );
    } catch {
      setError("Unable to upload employee template.");
    } finally {
      if (templateInputRef.current) {
        templateInputRef.current.value = "";
      }

      setIsImportingTemplate(false);
    }
  }

  return (
    <Card className="overflow-hidden border-[#E2E8F0] bg-white p-0 shadow-[0_8px_20px_rgba(15,23,42,0.04)]">
      <div className="border-b border-[#E2E8F0] bg-[#0F172A] px-5 py-5 text-white">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-orange-300">
              Employee Management
            </p>
            <h1 className="mt-2 text-2xl font-bold">Employee Directory</h1>
            <p className="mt-1 max-w-2xl text-sm text-white/70">
              Manage employee master data with single-record editing, salary payout mode, and safe bulk operations.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
          <a href="/api/employees/template">
            <Button className="border-white/15 bg-white/10 px-3 py-2 text-xs text-white hover:bg-white/15" variant="secondary">
              <Download className="mr-2 h-3.5 w-3.5" />
              Download Template
            </Button>
          </a>
          <input
            accept=".xlsx,.xls"
            className="hidden"
            onChange={(event) => void uploadTemplate(event.target.files?.[0] ?? null)}
            ref={templateInputRef}
            type="file"
          />
          <Button
            className="border-white/15 bg-white/10 px-3 py-2 text-xs text-white hover:bg-white/15"
            disabled={isImportingTemplate}
            onClick={() => templateInputRef.current?.click()}
            variant="secondary"
          >
            {isImportingTemplate ? (
              <LoadingSpinner />
            ) : (
              <Upload className="mr-2 h-3.5 w-3.5" />
            )}
            Upload Template
          </Button>
          <Button
            className="border-white/15 bg-white/10 px-3 py-2 text-xs text-white hover:bg-white/15"
            disabled={isLoading}
            onClick={() => void loadEmployees()}
            variant="secondary"
          >
            {isLoading ? <LoadingSpinner /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
            Refresh
          </Button>
          <Button
            className="bg-[#F97316] px-3 py-2 text-xs text-white hover:bg-[#F97316]/90"
            onClick={startCreate}
          >
            <UserPlus className="mr-2 h-3.5 w-3.5" />
            Add Employee
          </Button>
          </div>
        </div>
      </div>

      <div className="space-y-4 p-5">

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3">
          <div className="flex gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 text-danger" />
            <div>
              <h2 className="text-base font-semibold text-text">
                Employee management unavailable
              </h2>
              <p className="mt-1 text-sm text-text-secondary">{error}</p>
            </div>
          </div>
        </div>
      ) : null}

      {notice ? (
        <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3">
          <div className="flex items-center gap-3 text-sm text-text">
            <Check className="h-5 w-5 text-success" />
            {notice}
          </div>
        </div>
      ) : null}

      {data ? (
        <>
          <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <SummaryCard label="Total Employees" tone="neutral" value={data.summary.totalEmployees} />
            <SummaryCard
              label="Active Employees"
              tone="success"
              value={data.summary.activeEmployees}
            />
            <SummaryCard label="Lines Covered" tone="warning" value={data.summary.uniqueLines} />
            <SummaryCard
              label="No Manager Set"
              tone="danger"
              value={data.summary.employeesWithoutManagers}
            />
          </section>

          <section>
            <div className="rounded-2xl border border-[#E2E8F0] bg-white">
              <div className="flex flex-col gap-4 border-b border-[#E2E8F0] bg-[#F8FAFC] px-4 py-3 xl:flex-row xl:items-start xl:justify-between">
                <div>
                  <h2 className="text-base font-semibold text-text">
                    Employee Directory
                  </h2>
                  <p className="mt-1 text-sm text-text-secondary">
                    Showing {filteredEmployees.length} of {employees.length} records.
                  </p>
                </div>
                <div className="flex items-center gap-2 text-[#F97316]">
                  <Building2 className="h-5 w-5" />
                  <Badge variant="neutral">{formatNumberValue(filteredEmployees.length)} visible</Badge>
                </div>
              </div>

              <div className="grid gap-3 border-b border-[#E2E8F0] bg-white p-4 xl:grid-cols-[1.4fr_repeat(7,minmax(0,1fr))_auto]">
                <label className="relative block">
                  <span className="sr-only">Search employees</span>
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
                  <Input
                    className="bg-white pl-9"
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search name, HR_ID, email, manager..."
                    value={query}
                  />
                </label>
                <SelectField
                  label="Department"
                  onChange={setDepartmentFilter}
                  options={lookups.departments}
                  placeholder="Department"
                  value={departmentFilter}
                />
                <SelectField
                  label="Line"
                  onChange={setLineFilter}
                  options={lookups.lines}
                  placeholder="Line"
                  value={lineFilter}
                />
                <SelectField
                  label="Area"
                  onChange={setAreaFilter}
                  options={lookups.areas}
                  placeholder="Area"
                  value={areaFilter}
                />
                <SelectField
                  label="Position"
                  onChange={setPositionFilter}
                  options={lookups.positions}
                  placeholder="Position"
                  value={positionFilter}
                />
                <SelectField
                  label="Manager"
                  onChange={setManagerFilter}
                  options={lookups.managers}
                  placeholder="Manager"
                  value={managerFilter}
                />
                <SelectField
                  label="Status"
                  onChange={setStatusFilter}
                  options={lookups.statuses}
                  placeholder="Status"
                  value={statusFilter}
                />
                <SelectField
                  label="Pay Mode"
                  onChange={setSalaryPaymentModeFilter}
                  options={salaryPaymentModeOptions}
                  placeholder="Pay Mode"
                  value={salaryPaymentModeFilter}
                />
                <Button
                  className="gap-2 whitespace-nowrap"
                  disabled={!hasActiveFilters}
                  onClick={clearFilters}
                  variant="secondary"
                >
                  <X className="h-4 w-4" />
                  Clear {activeFilterCount > 0 ? `(${activeFilterCount})` : ""}
                </Button>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full min-w-[1380px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-xs uppercase tracking-[0.12em] text-[#64748B]">
                      <th className="sticky top-0 z-10 px-4 py-3 font-semibold">Employee</th>
                      <th className="sticky top-0 z-10 px-4 py-3 font-semibold">Position</th>
                      <th className="sticky top-0 z-10 px-4 py-3 font-semibold">Department</th>
                      <th className="sticky top-0 z-10 px-4 py-3 font-semibold">Line</th>
                      <th className="sticky top-0 z-10 px-4 py-3 font-semibold">Area</th>
                      <th className="sticky top-0 z-10 px-4 py-3 font-semibold">Pay Mode</th>
                      <th className="sticky top-0 z-10 px-4 py-3 font-semibold">Manager</th>
                      <th className="sticky top-0 z-10 px-4 py-3 font-semibold">Contact</th>
                      <th className="sticky top-0 z-10 px-4 py-3 font-semibold">Status</th>
                      <th className="sticky top-0 z-10 px-4 py-3 font-semibold">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredEmployees.length === 0 ? (
                      <tr>
                        <td
                          className="px-4 py-10 text-center text-sm text-text-secondary"
                          colSpan={10}
                        >
                          No employees match the current filters.
                        </td>
                      </tr>
                    ) : (
                      filteredEmployees.map((employee) => (
                        <tr
                          className="transition-colors hover:bg-[#F8FAFC]"
                          key={employee.hrId}
                        >
                          <td className="px-4 py-4">
                            <button
                              className="text-left"
                              onClick={() => startEdit(employee)}
                              type="button"
                            >
                              <p className="font-medium text-text">
                                {employee.fullName}
                              </p>
                              <p className="mt-1 font-mono text-xs text-text-secondary">
                                {employee.hrId}
                              </p>
                            </button>
                          </td>
                          <td className="px-4 py-4 text-text-secondary">
                            {emptyText(employee.positionTitle ?? employee.jobTitle)}
                          </td>
                          <td className="px-4 py-4 text-text-secondary">
                            {emptyText(employee.departmentName)}
                          </td>
                          <td className="px-4 py-4 text-text-secondary">
                            {emptyText(employee.lineName)}
                          </td>
                          <td className="px-4 py-4 text-text-secondary">
                            {emptyText(employee.areaName)}
                          </td>
                          <td className="px-4 py-4">
                            <Badge
                              variant={
                                employee.salaryPaymentMode === "two_parts"
                                  ? "warning"
                                  : "success"
                              }
                            >
                              {employee.salaryPaymentMode === "two_parts"
                                ? "Two parts"
                                : "One part"}
                            </Badge>
                          </td>
                          <td className="px-4 py-4">
                            <p className="text-text-secondary">
                              {emptyText(employee.managerName)}
                            </p>
                            {employee.managerHrId ? (
                              <p className="mt-1 text-xs text-text-secondary">
                                {employee.managerHrId}
                              </p>
                            ) : null}
                          </td>
                          <td className="px-4 py-4">
                            <p className="text-text-secondary">
                              {emptyText(employee.workEmail)}
                            </p>
                            <p className="mt-1 text-xs text-text-secondary">
                              {emptyText(employee.mobileNumber)}
                            </p>
                          </td>
                          <td className="px-4 py-4">
                            <Badge
                              variant={statusBadgeVariant(
                                employee.employmentStatus,
                              )}
                            >
                              {optionName(employee.employmentStatus ?? "active")}
                            </Badge>
                          </td>
                          <td className="px-4 py-4">
                            <Button
                              className="gap-2 px-3 py-1.5 text-xs"
                              onClick={() => startEdit(employee)}
                              variant="secondary"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                              Edit
                            </Button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </>
      ) : null}

      {isFormOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/45 px-4 py-6 backdrop-blur-sm">
          <Card className="w-full max-w-5xl">
            <div className="flex items-start justify-between gap-4 rounded-t-2xl border-b border-[#E2E8F0] bg-[#0F172A] px-5 py-5 text-white">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-orange-300">
                  Employee Record
                </p>
                <h2 className="mt-2 text-xl font-bold">
                  {editingHrId ? "Edit Employee" : "Add Employee"}
                </h2>
                <p className="mt-1 max-w-3xl text-sm text-white/70">
                  Manual entry uses the same employee master-data model as the
                  bulk Excel template. Salary payout mode controls automated
                  payroll sheet generation.
                </p>
              </div>
              <Button
                className="border-white/15 bg-white/10 text-white hover:bg-white/15"
                onClick={closeForm}
                variant="secondary"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="grid gap-4 p-5 md:grid-cols-2 xl:grid-cols-3">
              <TextField
                label="hr_id"
                onChange={(value) => updateForm("hrId", value)}
                placeholder="B-001"
                value={form.hrId}
              />
              <TextField
                label="full_name"
                onChange={(value) => updateForm("fullName", value)}
                placeholder="Employee full name"
                value={form.fullName}
              />
              <SelectField
                label="job_title"
                onChange={(value) => {
                  const selected = lookups.positions.find((p) => p.value === value);
                  setForm((prev) => ({
                    ...prev,
                    positionId: value,
                    jobTitle: selected?.label ?? prev.jobTitle,
                  }));
                }}
                options={lookups.positions}
                placeholder="Select job title"
                value={form.positionId}
              />
              <TextField
                label="hire_date"
                onChange={(value) => updateForm("hireDate", value)}
                type="date"
                value={form.hireDate}
              />
              <SelectField
                label="line"
                onChange={(value) => {
                  updateForm("lineId", value);
                  updateForm("areaId", ""); // Reset area when line changes
                }}
                options={
                  isManualMedicalRep
                    ? Array.from(
                        new Map(
                          (lookups.medicalRepVacancies ?? [])
                            .filter((vacancy) => vacancy.lineId !== null)
                            .map((vacancy) => [
                              String(vacancy.lineId),
                              {
                                label: vacancy.lineName ?? `Line ${vacancy.lineId}`,
                                value: String(vacancy.lineId),
                              },
                            ]),
                        ).values(),
                      )
                        .sort((a, b) => a.label.localeCompare(b.label))
                    : lookups.lines
                }
                placeholder="Line"
                value={form.lineId}
              />
              <SelectField
                disabled={isManualMedicalRep && !form.lineId}
                label="area"
                onChange={(value) => {
                  if (value === "empty") return;
                  if (isManualMedicalRep) {
                    const vacancy = (lookups.medicalRepVacancies ?? []).find(
                      (v) =>
                        String(v.areaId) === String(value) &&
                        String(v.lineId) === String(form.lineId),
                    );
                    if (vacancy) {
                      setForm((prev) => ({
                        ...prev,
                        areaId: String(value),
                        departmentId: String(vacancy.departmentId ?? prev.departmentId),
                        jobTitle: vacancy.positionTitle || "Medical Representative",
                        lineId: String(vacancy.lineId ?? prev.lineId),
                        managerHrId: vacancy.managerHrId ?? prev.managerHrId,
                        positionId: String(vacancy.positionId ?? prev.positionId),
                      }));
                    } else {
                      updateForm("areaId", value);
                    }
                  } else {
                    const selectedArea = lookups.areas.find((a) => String(a.value) === String(value));
                    if (selectedArea) {
                      setForm((prev) => ({
                        ...prev,
                        areaId: String(value),
                        lineId: String(selectedArea.lineId ?? prev.lineId),
                        managerHrId: selectedArea.managerHrId ?? prev.managerHrId,
                        positionId: String(selectedArea.positionId ?? prev.positionId),
                      }));
                    } else {
                      updateForm("areaId", value);
                    }
                  }
                }}
                options={
                  isManualMedicalRep
                    ? filteredManualVacantAreas.length > 0
                      ? filteredManualVacantAreas.map((v) => ({
                          label: v.managerName
                            ? `${v.areaName} - ${v.positionTitle} - Manager: ${v.managerName}`
                            : `${v.areaName} - ${v.positionTitle}`,
                          value: String(v.areaId),
                        }))
                      : form.lineId
                        ? [{ label: "No open vacancies for this line", value: "empty" }]
                        : []
                    : lookups.areas.filter((a) => !form.lineId || String(a.lineId) === String(form.lineId))
                }
                placeholder={isManualMedicalRep && !form.lineId ? "Select line first" : "Area"}
                value={form.areaId}
              />
              <TextField
                label="email"
                onChange={(value) => updateForm("workEmail", value)}
                type="email"
                value={form.workEmail}
              />
              <TextField
                label="mobile_number"
                onChange={(value) => updateForm("mobileNumber", value)}
                value={form.mobileNumber}
              />
              <TextField
                label="education"
                onChange={(value) => updateForm("education", value)}
                value={form.education}
              />
              <TextField
                label="crm_username"
                onChange={(value) => updateForm("crmUsername", value)}
                value={form.crmUsername}
              />
              <TextField
                label="crm_id"
                onChange={(value) => updateForm("crmId", value)}
                value={form.crmId}
              />
              <TextField
                label="region"
                onChange={() => undefined}
                placeholder="Stored through template for vacancies"
                value=""
              />
              <TextField
                label="name_ar"
                onChange={(value) => updateForm("nameAr", value)}
                value={form.nameAr}
              />
              <SelectField
                label="manager_name"
                onChange={(value) => updateForm("managerHrId", value)}
                options={lookups.managers.filter(
                  (manager) => manager.value !== form.hrId,
                )}
                value={form.managerHrId}
              />
              <TextField
                label="manager_hr_id"
                onChange={(value) => updateForm("managerHrId", value)}
                value={form.managerHrId}
              />
              <SelectField
                label="department"
                onChange={(value) => updateForm("departmentId", value)}
                options={lookups.departments}
                value={form.departmentId}
              />
              <SelectField
                label="employment_status"
                onChange={(value) => updateForm("employmentStatus", value)}
                options={lookups.statuses}
                value={form.employmentStatus}
              />
              <SelectField
                label="salary_payment_mode"
                onChange={(value) => updateForm("salaryPaymentMode", value)}
                options={salaryPaymentModeOptions}
                value={form.salaryPaymentMode}
              />
            </div>

            <div className="mx-5 rounded-xl border border-orange-200 bg-orange-50 p-4 text-sm text-orange-900">
              One Part employees receive net salary on day 1 and any approved
              previous-month expenses on day 10. Two Parts employees receive
              70% of Adjusted Net on day 1 (Basic Salary), where Adjusted Net =
              Net Salary minus Fuel and Cost of Living. Day 10 includes the
              remaining 30%, cost of living, fuel, and approved previous-month
              expenses.
            </div>

            <div className="flex justify-end gap-3 p-5">
              <Button onClick={closeForm} variant="secondary">
                Cancel
              </Button>
              <Button
                className="gap-2"
                disabled={isSaving}
                onClick={() => void saveEmployee()}
              >
                {isSaving ? <LoadingSpinner /> : <Check className="h-4 w-4" />}
                {editingHrId ? "Save Changes" : "Create Employee"}
              </Button>
            </div>
          </Card>
        </div>
      )}
      </div>
    </Card>
  );
}
