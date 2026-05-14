﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿"use client";

import {
  AlertCircle,
  Building2,
  Check,
  CircleAlert,
  Download,
  Pencil,
  Users,
  RefreshCw,
  Search,
  Upload,
  UserCheck2,
  UserPlus,
  UserX,
  X,
} from "lucide-react";
import * as React from "react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminSectionHeader,
  AdminStatCard,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
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

type ResignationFormState = {
  effectiveDate: string;
  employeeStatus: string;
  reason: string;
  submittedDate: string;
  workflowNotes: string;
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
  residenceAddress: string;
  residenceArea: string;
  residenceCity: string;
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
  residenceAddress: "",
  residenceArea: "",
  residenceCity: "",
  salaryPaymentMode: "two_parts",
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

const resignationStatusOptions = [
  { label: "Resigned", value: "resigned" },
  { label: "Terminated", value: "terminated" },
  { label: "Inactive", value: "inactive" },
];

const emptyResignationForm: ResignationFormState = {
  effectiveDate: new Date().toISOString().slice(0, 10),
  employeeStatus: "resigned",
  reason: "",
  submittedDate: new Date().toISOString().slice(0, 10),
  workflowNotes: "",
};

const panelClassName =
  "rounded-[28px] border border-[#D8E0EA] bg-white/94 shadow-[0_18px_46px_rgba(15,23,42,0.08)] backdrop-blur";
const selectClassName =
  "h-11 w-full rounded-2xl border border-[#D7E0EA] bg-white/95 px-3 text-sm text-text shadow-sm transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

function EmployeePageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative isolate min-h-[calc(100vh-8rem)] overflow-hidden rounded-[34px] border border-[#D8E0EA] bg-[#F8FAFC] p-4 shadow-[0_24px_70px_rgba(15,23,42,0.1)] sm:p-6 lg:p-8">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-24 -top-28 h-96 w-96 rounded-full bg-[#F97316]/5 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-10 left-1/4 h-80 w-80 rounded-full bg-[#3B82F6]/5 blur-3xl"
      />
      <div className="relative z-10 space-y-8 max-w-[1600px] mx-auto">{children}</div>
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
        className={cn(selectClassName, disabled ? "bg-[#F8FAFC] text-[#94A3B8]" : "bg-white", className)}
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
  disabled = false,
  label,
  onChange,
  placeholder,
  type = "text",
  value,
}: {
  disabled?: boolean;
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
        className={cn("h-11 rounded-2xl border-[#D7E0EA] bg-white/95 shadow-sm", disabled && "bg-[#F8FAFC] text-[#64748B]")}
        disabled={disabled}
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
    residenceAddress: employee.residenceAddress ?? "",
    residenceArea: employee.residenceArea ?? "",
    residenceCity: employee.residenceCity ?? "",
    salaryPaymentMode: employee.salaryPaymentMode,
    workEmail: employee.workEmail ?? "",
  };
}

function employeeRowKey(employee: EmployeeDirectoryRow, index: number) {
  return [
    employee.hrId,
    employee.createdAt,
    employee.updatedAt,
    employee.fullName,
    index,
  ].join(":");
}

function formToPayload(form: EmployeeFormState, originalHrId: string | null): EmployeeMutationInput {
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
    originalHrId,
    positionId: optionalNumber(form.positionId),
    residenceAddress: optionalText(form.residenceAddress),
    residenceArea: optionalText(form.residenceArea),
    residenceCity: optionalText(form.residenceCity),
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
  const [isResigning, setIsResigning] = React.useState(false);
  const [isResignationOpen, setIsResignationOpen] = React.useState(false);
  const [resignationError, setResignationError] = React.useState<string | null>(null);
  const [resigningEmployee, setResigningEmployee] = React.useState<EmployeeDirectoryRow | null>(null);
  const [resignationForm, setResignationForm] = React.useState<ResignationFormState>(emptyResignationForm);
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

  function startResignation(employee: EmployeeDirectoryRow) {
    setResigningEmployee(employee);
    setResignationForm({
      ...emptyResignationForm,
      effectiveDate: new Date().toISOString().slice(0, 10),
      submittedDate: new Date().toISOString().slice(0, 10),
    });
    setNotice(null);
    setError(null);
    setResignationError(null);
    setIsResignationOpen(true);
  }

  function closeResignation() {
    setIsResignationOpen(false);
    setResigningEmployee(null);
    setResignationError(null);
  }

  function updateResignationForm(key: keyof ResignationFormState, value: string) {
    setResignationForm((current) => ({ ...current, [key]: value }));
  }

  async function saveEmployee() {
    setIsSaving(true);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch("/api/employees", {
        body: JSON.stringify({ employee: formToPayload(form, editingHrId) }),
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

  async function submitResignation() {
    if (!resigningEmployee) return;
    setIsResigning(true);
    setError(null);
    setNotice(null);
    setResignationError(null);

    try {
      const response = await fetch(`/api/employees/${encodeURIComponent(resigningEmployee.hrId)}/resign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resignation: {
            employeeHrId: resigningEmployee.hrId,
            effectiveDate: resignationForm.effectiveDate,
            employeeStatus: resignationForm.employeeStatus,
            reason: resignationForm.reason,
            submittedDate: resignationForm.submittedDate,
            workflowNotes: resignationForm.workflowNotes,
          },
        }),
      });
      const payload = await response.json();

      if (!response.ok) {
        setResignationError(payload.message ?? payload.error ?? "employee_resign_failed");
        return;
      }

      setData((current) =>
        current
          ? {
              ...current,
              employees: current.employees.filter((employee) => employee.hrId !== resigningEmployee.hrId),
            }
          : current,
      );
      setNotice(`Resignation recorded for ${resigningEmployee.fullName}. Vacancy ${payload.data?.vacancyCode ?? "opened"} created and employee moved to ${resignationForm.employeeStatus}.`);
      closeResignation();
    } catch {
      setResignationError("Unable to process employee resignation.");
    } finally {
      setIsResigning(false);
    }
  }

  return (
    <EmployeePageShell>
    <div className="space-y-6">
      <AdminPageHero
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 rounded-2xl border border-[#D7E0EA] bg-white p-1 shadow-sm">
              <a
                className="inline-flex h-9 items-center justify-center gap-2 rounded-xl px-4 text-xs font-semibold text-[#475569] transition hover:bg-[#F8FAFC] hover:text-[#0F172A]"
                href="/api/employees/template"
                title="Download bulk upload template"
              >
                <Download className="h-3.5 w-3.5 text-[#F97316]" />
                Template
              </a>
              <div className="h-4 w-px bg-[#E2E8F0]" />
              <label className="inline-flex h-9 cursor-pointer items-center justify-center gap-2 rounded-xl px-4 text-xs font-semibold text-[#475569] transition hover:bg-[#F8FAFC] hover:text-[#0F172A]">
                {isImportingTemplate ? (
                  <LoadingSpinner />
                ) : (
                  <Upload className="h-3.5 w-3.5 text-[#F97316]" />
                )}
                Upload
                <input
                  accept=".xlsx,.xls"
                  className="sr-only"
                  onChange={(event) => void uploadTemplate(event.target.files?.[0] ?? null)}
                  ref={templateInputRef}
                  type="file"
                />
              </label>
            </div>
            <Button
              className="h-11 gap-2 rounded-2xl border-[#D7E0EA] bg-white px-4 text-xs font-semibold text-[#475569] shadow-sm transition hover:border-[#FDBA74] hover:bg-[#FFF7ED] hover:text-[#0F172A]"
              disabled={isLoading}
              onClick={() => void loadEmployees()}
              variant="outline"
            >
              {isLoading ? <LoadingSpinner /> : <RefreshCw className="h-3.5 w-3.5" />}
              Sync
            </Button>
            <Button className="h-11 gap-2 rounded-2xl bg-[#0F172A] px-6 text-xs font-bold text-white shadow-[0_14px_30px_rgba(15,23,42,0.22)] transition hover:bg-[#1E293B]" onClick={startCreate}>
              <UserPlus className="h-4 w-4" />
              Add Employee
            </Button>
          </div>
        }
        badges={
          <div className="flex flex-wrap gap-2 text-xs text-[#475569]">
            <AdminInsightChip>Master Data Governance</AdminInsightChip>
            <AdminInsightChip tone="orange">Payroll Aligned</AdminInsightChip>
          </div>
        }
        description="Enterprise employee master data center for workforce management, lifecycle tracking, and payroll-ready record governance."
        eyebrow="Workforce Intelligence"
        icon={<Building2 className="h-3.5 w-3.5" />}
        title="Employee Master Data"
      />

      {error ? (
        <AdminCallout tone="danger">
            <AlertCircle className="mt-0.5 h-5 w-5 text-danger" />
            <div>
              <h2 className="text-base font-semibold text-text">
                Employee management unavailable
              </h2>
              <p className="mt-1 text-sm text-text-secondary">{error}</p>
            </div>
        </AdminCallout>
      ) : null}

      {notice ? (
        <AdminCallout tone="success">
            <Check className="h-5 w-5 text-success" />
            {notice}
        </AdminCallout>
      ) : null}

      {data ? (
        <>
          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <AdminStatCard
              description="Active workforce currently in system."
              icon={<Users className="h-4 w-4" />}
              label="Total Headcount"
              tone="blue"
              value={formatNumberValue(data.summary.totalEmployees)}
            />
            <AdminStatCard
              description="Records flagged as active and available for payroll."
              icon={<UserCheck2 className="h-4 w-4" />}
              label="Active Workforce"
              tone="emerald"
              value={formatNumberValue(data.summary.activeEmployees)}
            />
            <AdminStatCard
              description="Unique operating lines represented in the directory."
              icon={<CircleAlert className="h-4 w-4" />}
              label="Lines Coverage"
              tone="violet"
              value={formatNumberValue(data.summary.uniqueLines)}
            />
            <AdminStatCard
              description="Employees missing direct manager linkage and require assignment."
              icon={<Building2 className="h-4 w-4" />}
              label="Pending Assignment"
              tone="orange"
              value={formatNumberValue(data.summary.employeesWithoutManagers)}
            />
          </section>

          <AdminTableShell
            action={
              <div className="flex items-center gap-3">
                <Badge className="bg-white text-[#475569] border-[#E2E8F0] shadow-sm" variant="neutral">
                  {formatNumberValue(filteredEmployees.length)} results
                </Badge>
              </div>
            }
            description="Access and manage comprehensive employee records with real-time filters."
            title="Workforce Directory"
          >
            <div className="h-1 w-full bg-gradient-to-r from-[#F97316] via-[#3B82F6] to-[#8B5CF6] opacity-80" />
            <div className="flex flex-col gap-4 border-b border-[#E2E8F0] bg-[#F8FAFC]/50 p-4">
              <div className="grid gap-4 xl:grid-cols-[1fr_auto]">
                <label className="relative">
                  <span className="sr-only">Search employees</span>
                  <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#94A3B8]" />
                  <Input
                    className="h-12 w-full rounded-2xl border-[#E2E8F0] bg-white pl-11 text-sm shadow-sm transition focus:border-[#F97316] focus:ring-1 focus:ring-[#F97316]"
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search by name, ID, email, or manager..."
                    value={query}
                  />
                </label>
                <Button
                  className="h-12 gap-2 rounded-2xl border-[#E2E8F0] bg-white px-6 text-sm font-semibold text-[#475569] shadow-sm transition hover:bg-[#F8FAFC]"
                  disabled={!hasActiveFilters}
                  onClick={clearFilters}
                  variant="outline"
                >
                  <X className="h-4 w-4" />
                  Reset Filters {activeFilterCount > 0 ? `(${activeFilterCount})` : ""}
                </Button>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
                <SelectField
                  label="Department"
                  onChange={setDepartmentFilter}
                  options={lookups.departments}
                  placeholder="All Departments"
                  value={departmentFilter}
                />
                <SelectField
                  label="Business Line"
                  onChange={setLineFilter}
                  options={lookups.lines}
                  placeholder="All Lines"
                  value={lineFilter}
                />
                <SelectField
                  label="Operating Area"
                  onChange={setAreaFilter}
                  options={lookups.areas}
                  placeholder="All Areas"
                  value={areaFilter}
                />
                <SelectField
                  label="Job Position"
                  onChange={setPositionFilter}
                  options={lookups.positions}
                  placeholder="All Positions"
                  value={positionFilter}
                />
                <SelectField
                  label="Direct Manager"
                  onChange={setManagerFilter}
                  options={lookups.managers}
                  placeholder="All Managers"
                  value={managerFilter}
                />
                <SelectField
                  label="Employment Status"
                  onChange={setStatusFilter}
                  options={lookups.statuses}
                  placeholder="All Statuses"
                  value={statusFilter}
                />
                <SelectField
                  label="Payout Mode"
                  onChange={setSalaryPaymentModeFilter}
                  options={salaryPaymentModeOptions}
                  placeholder="All Modes"
                  value={salaryPaymentModeFilter}
                />
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[1200px] text-left text-sm">
                <thead>
                  <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-[11px] font-bold uppercase tracking-wider text-[#64748B]">
                    <th className="sticky top-0 z-10 px-6 py-4">Employee Information</th>
                    <th className="sticky top-0 z-10 px-6 py-4">Organization</th>
                    <th className="sticky top-0 z-10 px-6 py-4">Direct Manager</th>
                    <th className="sticky top-0 z-10 px-6 py-4 text-center">Payout</th>
                    <th className="sticky top-0 z-10 px-6 py-4">Contact Details</th>
                    <th className="sticky top-0 z-10 px-6 py-4">Status</th>
                    <th className="sticky top-0 z-10 px-6 py-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#F1F5F9]">
                  {filteredEmployees.length === 0 ? (
                    <tr>
                      <td
                        className="px-6 py-12 text-center text-sm text-[#94A3B8]"
                        colSpan={7}
                      >
                        No employee records match your current filter criteria.
                      </td>
                    </tr>
                  ) : (
                    filteredEmployees.map((employee, index) => (
                      <tr
                        className="group transition-colors hover:bg-[#F8FAFC]"
                        key={employeeRowKey(employee, index)}
                      >
                        <td className="px-6 py-4">
                          <button
                            className="flex flex-col text-left group/name"
                            onClick={() => startEdit(employee)}
                            type="button"
                          >
                            <span className="font-bold text-[#0F172A] group-hover/name:text-[#F97316] transition-colors leading-tight">
                              {employee.fullName}
                            </span>
                            <div className="mt-1.5 flex items-center gap-2">
                              <span className="font-mono text-[10px] font-black tracking-wider text-[#64748B] bg-slate-100 px-1.5 py-0.5 rounded uppercase">
                                {employee.hrId}
                              </span>
                              {employee.employmentStatus === "active" && (
                                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                              )}
                            </div>
                          </button>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex flex-col gap-0.5">
                            <span className="text-xs font-semibold text-[#334155]">
                              {emptyText(employee.positionTitle ?? employee.jobTitle)}
                            </span>
                            <span className="text-[10px] text-[#64748B]">
                              {emptyText(employee.departmentName)} · {emptyText(employee.lineName)}
                            </span>
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          {employee.managerHrId ? (
                            <div className="flex flex-col">
                              <span className="text-xs font-medium text-[#334155]">
                                {emptyText(employee.managerName)}
                              </span>
                              <span className="text-[10px] text-[#94A3B8]">
                                {employee.managerHrId}
                              </span>
                            </div>
                          ) : (
                            <span className="text-[10px] font-bold uppercase tracking-tighter text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-100">
                              Unassigned
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-center">
                          <Badge
                            className={cn(
                              "border-none px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-tight",
                              employee.salaryPaymentMode === "two_parts"
                                ? "bg-amber-100 text-amber-700"
                                : "bg-emerald-100 text-emerald-700"
                            )}
                            variant="neutral"
                          >
                            {employee.salaryPaymentMode === "two_parts"
                              ? "2 Parts"
                              : "1 Part"}
                          </Badge>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex flex-col">
                            <span className="text-xs text-[#334155]">
                              {emptyText(employee.workEmail)}
                            </span>
                            <span className="text-[10px] text-[#64748B]">
                              {emptyText(employee.mobileNumber)}
                            </span>
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <Badge
                            className={cn(
                              "border-none px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-tight",
                              statusBadgeVariant(employee.employmentStatus) === "success" && "bg-emerald-100 text-emerald-700",
                              statusBadgeVariant(employee.employmentStatus) === "warning" && "bg-amber-100 text-amber-700",
                              statusBadgeVariant(employee.employmentStatus) === "danger" && "bg-rose-100 text-rose-700"
                            )}
                            variant="neutral"
                          >
                            {optionName(employee.employmentStatus ?? "active")}
                          </Badge>
                        </td>
                        <td className="px-6 py-4 text-right">
                          <div className="flex justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                            <Button
                              className="h-8 w-8 rounded-lg p-0 text-[#64748B] hover:bg-[#F1F5F9] hover:text-[#0F172A]"
                              onClick={() => startEdit(employee)}
                              title="Edit Record"
                              variant="ghost"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              className="h-8 w-8 rounded-lg p-0 text-[#64748B] hover:bg-rose-50 hover:text-rose-600"
                              onClick={() => startResignation(employee)}
                              title="Mark as Resigned"
                              variant="ghost"
                            >
                              <UserX className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </AdminTableShell>
        </>
      ) : null}

      {isFormOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-[#0F172A]/40 backdrop-blur-sm transition-all duration-300">
          <Card className="h-full w-full max-w-2xl overflow-hidden rounded-none border-l border-[#D8E0EA] bg-white shadow-[-20px_0_50px_rgba(15,23,42,0.1)] flex flex-col animate-in slide-in-from-right duration-300">
            <div className="flex items-center justify-between border-b border-[#E2E8F0] bg-[#F8FAFC] px-6 py-5">
              <div>
                <h2 className="text-xl font-bold tracking-tight text-[#0F172A]">
                  {editingHrId ? "Employee Profile" : "New Employee Onboarding"}
                </h2>
                <p className="mt-1 text-sm text-[#64748B]">
                  {editingHrId ? `Editing master record for ${form.fullName}` : "Create a new workforce master data record."}
                </p>
              </div>
              <Button
                className="h-10 w-10 rounded-xl p-0 text-[#64748B] hover:bg-[#E2E8F0] hover:text-[#0F172A]"
                onClick={closeForm}
                variant="ghost"
              >
                <X className="h-5 w-5" />
              </Button>
            </div>

            <div className="flex-1 overflow-y-auto bg-white p-6 space-y-8">
              {/* Section 1: Identity Information */}
              <div className="space-y-4">
                <div className="flex items-center gap-2 border-b border-[#F1F5F9] pb-2">
                  <div className="h-2 w-2 rounded-full bg-[#F97316]" />
                  <h3 className="text-xs font-bold uppercase tracking-widest text-[#475569]">Identity Information</h3>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField
                    disabled={Boolean(editingHrId)}
                    label="Employee ID"
                    onChange={(value) => updateForm("hrId", value)}
                    placeholder="e.g. B-001"
                    value={form.hrId}
                  />
                  <TextField
                    label="Full Name (English)"
                    onChange={(value) => updateForm("fullName", value)}
                    placeholder="Enter full legal name"
                    value={form.fullName}
                  />
                  <TextField
                    label="Full Name (Arabic)"
                    onChange={(value) => updateForm("nameAr", value)}
                    placeholder="الاسم بالكامل"
                    value={form.nameAr}
                  />
                  <TextField
                    label="Education / Degree"
                    onChange={(value) => updateForm("education", value)}
                    placeholder="e.g. B.Sc. Pharmacy"
                    value={form.education}
                  />
                </div>
              </div>

              {/* Section 2: Organizational Assignment */}
              <div className="space-y-4">
                <div className="flex items-center gap-2 border-b border-[#F1F5F9] pb-2">
                  <div className="h-2 w-2 rounded-full bg-[#3B82F6]" />
                  <h3 className="text-xs font-bold uppercase tracking-widest text-[#475569]">Organizational Assignment</h3>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <SelectField
                    label="Job Position"
                    onChange={(value) => {
                      const selected = lookups.positions.find((p) => p.value === value);
                      setForm((prev) => ({
                        ...prev,
                        positionId: value,
                        jobTitle: selected?.label ?? prev.jobTitle,
                      }));
                    }}
                    options={lookups.positions}
                    placeholder="Select position"
                    value={form.positionId}
                  />
                  <SelectField
                    label="Department"
                    onChange={(value) => updateForm("departmentId", value)}
                    options={lookups.departments}
                    placeholder="Select department"
                    value={form.departmentId}
                  />
                  <SelectField
                    label="Business Line"
                    onChange={(value) => {
                      updateForm("lineId", value);
                      updateForm("areaId", "");
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
                    placeholder="Select business line"
                    value={form.lineId}
                  />
                  <SelectField
                    disabled={isManualMedicalRep && !form.lineId}
                    label="Operating Area"
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
                    placeholder={isManualMedicalRep && !form.lineId ? "Select line first" : "Select area"}
                    value={form.areaId}
                  />
                  <SelectField
                    label="Direct Manager"
                    onChange={(value) => updateForm("managerHrId", value)}
                    options={lookups.managers.filter(
                      (manager) => manager.value !== form.hrId,
                    )}
                    placeholder="Select manager"
                    value={form.managerHrId}
                  />
                  <TextField
                    disabled
                    label="Manager Employee ID"
                    onChange={() => undefined}
                    placeholder="Linked via manager selection"
                    value={form.managerHrId}
                  />
                </div>
              </div>

              {/* Section 3: Employment Details */}
              <div className="space-y-4">
                <div className="flex items-center gap-2 border-b border-[#F1F5F9] pb-2">
                  <div className="h-2 w-2 rounded-full bg-[#10B981]" />
                  <h3 className="text-xs font-bold uppercase tracking-widest text-[#475569]">Employment Details</h3>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField
                    label="Official Hire Date"
                    onChange={(value) => updateForm("hireDate", value)}
                    type="date"
                    value={form.hireDate}
                  />
                  <SelectField
                    label="Employment Status"
                    onChange={(value) => updateForm("employmentStatus", value)}
                    options={lookups.statuses}
                    value={form.employmentStatus}
                  />
                  <SelectField
                    label="Salary Payout Mode"
                    onChange={(value) => updateForm("salaryPaymentMode", value)}
                    options={salaryPaymentModeOptions}
                    value={form.salaryPaymentMode}
                  />
                </div>
              </div>

              {/* Section 4: Contact & CRM */}
              <div className="space-y-4">
                <div className="flex items-center gap-2 border-b border-[#F1F5F9] pb-2">
                  <div className="h-2 w-2 rounded-full bg-[#8B5CF6]" />
                  <h3 className="text-xs font-bold uppercase tracking-widest text-[#475569]">Contact & System Access</h3>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField
                    label="Work Email Address"
                    onChange={(value) => updateForm("workEmail", value)}
                    placeholder="employee@company.com"
                    type="email"
                    value={form.workEmail}
                  />
                  <TextField
                    label="Mobile Number"
                    onChange={(value) => updateForm("mobileNumber", value)}
                    placeholder="+20..."
                    value={form.mobileNumber}
                  />
                  <TextField
                    label="CRM Username"
                    onChange={(value) => updateForm("crmUsername", value)}
                    placeholder="System username"
                    value={form.crmUsername}
                  />
                  <TextField
                    label="CRM System ID"
                    onChange={(value) => updateForm("crmId", value)}
                    placeholder="External system ID"
                    value={form.crmId}
                  />
                </div>
              </div>

              {/* Section 5: Residence & Location */}
              <div className="space-y-4">
                <div className="flex items-center gap-2 border-b border-[#F1F5F9] pb-2">
                  <div className="h-2 w-2 rounded-full bg-[#F43F5E]" />
                  <h3 className="text-xs font-bold uppercase tracking-widest text-[#475569]">Residence & Geography</h3>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField
                    label="Residence Address"
                    onChange={(value) => updateForm("residenceAddress", value)}
                    placeholder="Full address as per ID"
                    value={form.residenceAddress}
                  />
                  <TextField
                    label="City"
                    onChange={(value) => updateForm("residenceCity", value)}
                    placeholder="e.g. Cairo"
                    value={form.residenceCity}
                  />
                  <TextField
                    label="Area / District"
                    onChange={(value) => updateForm("residenceArea", value)}
                    placeholder="e.g. Maadi"
                    value={form.residenceArea}
                  />
                </div>
                <div className="rounded-xl border border-blue-100 bg-blue-50/50 p-4 text-[11px] leading-relaxed text-[#475569]">
                  <p className="font-bold text-[#1E40AF] mb-1 uppercase tracking-tight">Geocoding Information</p>
                  Residence address is automatically geocoded upon saving. Coordinates are used for distance-based expense validation and workforce heatmaps.
                </div>
              </div>

              {/* Payroll Information Note */}
              <div className="rounded-xl border border-amber-100 bg-amber-50/50 p-4 text-[11px] leading-relaxed text-[#475569]">
                <p className="font-bold text-[#92400E] mb-1 uppercase tracking-tight">Payroll Payout Structure</p>
                <span className="font-bold text-[#92400E]">1 Part:</span> Net salary on Day 1, expenses on Day 10.<br/>
                <span className="font-bold text-[#92400E]">2 Parts:</span> 70% Basic on Day 1. Remaining 30%, Cost of Living, Fuel, and Expenses on Day 10.
              </div>
            </div>

            <div className="border-t border-[#E2E8F0] bg-[#F8FAFC] px-6 py-4 flex justify-end gap-3">
              <Button
                className="h-11 rounded-2xl px-6 text-sm font-semibold text-[#475569] hover:bg-[#E2E8F0]"
                onClick={closeForm}
                variant="ghost"
              >
                Discard Changes
              </Button>
              <Button
                className="h-11 gap-2 rounded-2xl bg-[#0F172A] px-8 text-sm font-bold text-white shadow-lg transition hover:bg-[#1E293B] disabled:opacity-50"
                disabled={isSaving}
                onClick={() => void saveEmployee()}
              >
                {isSaving ? <LoadingSpinner /> : <Check className="h-4 w-4" />}
                {editingHrId ? "Update Record" : "Create Master Record"}
              </Button>
            </div>
          </Card>
        </div>
      )}
      {isResignationOpen && resigningEmployee ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[#0F172A]/60 px-4 py-6 backdrop-blur-md">
          <Card className={`${panelClassName} w-full max-w-3xl overflow-hidden`}>
            <AdminSectionHeader
              action={
                <Button
                  className="h-9 rounded-xl px-3 text-xs"
                  onClick={closeResignation}
                  variant="secondary"
                >
                  <X className="h-4 w-4" />
                </Button>
              }
              description="Update employee status and create the corresponding vacancy record for payroll and headcount continuity."
              title="Mark As Resigned"
            />

            <div className="grid gap-4 p-5 md:grid-cols-2">
              {resignationError ? (
                <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 md:col-span-2">
                  <div className="flex gap-3">
                    <AlertCircle className="mt-0.5 h-5 w-5 text-danger" />
                    <div>
                      <h3 className="text-sm font-semibold text-text">Unable to confirm resignation</h3>
                      <p className="mt-1 text-sm text-text-secondary">{resignationError}</p>
                    </div>
                  </div>
                </div>
              ) : null}
              <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 md:col-span-2">
                <p className="font-semibold text-rose-900">{resigningEmployee.fullName}</p>
                <p className="mt-1 text-sm text-rose-800">
                  {resigningEmployee.hrId} · {emptyText(resigningEmployee.positionTitle ?? resigningEmployee.jobTitle)} · {emptyText(resigningEmployee.areaName)}
                </p>
              </div>

              <TextField
                label="submitted_date"
                onChange={(value) => updateResignationForm("submittedDate", value)}
                type="date"
                value={resignationForm.submittedDate}
              />
              <TextField
                label="effective_date"
                onChange={(value) => updateResignationForm("effectiveDate", value)}
                type="date"
                value={resignationForm.effectiveDate}
              />
              <SelectField
                label="employee_status"
                onChange={(value) => updateResignationForm("employeeStatus", value)}
                options={resignationStatusOptions}
                value={resignationForm.employeeStatus}
              />
              <TextField
                label="reason"
                onChange={(value) => updateResignationForm("reason", value)}
                placeholder="Employee resignation reason"
                value={resignationForm.reason}
              />
              <label className="block md:col-span-2">
                <span className="mb-1.5 block text-xs font-medium text-text-secondary">
                  workflow_notes
                </span>
                <textarea
                  className="min-h-28 w-full rounded-2xl border border-[#D7E0EA] bg-white/95 px-3 py-2 text-sm text-text shadow-sm transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  onChange={(event) => updateResignationForm("workflowNotes", event.target.value)}
                  placeholder="Optional workflow note for the resignation report."
                  value={resignationForm.workflowNotes}
                />
              </label>
            </div>

            <div className="flex justify-end gap-3 p-5">
              <Button onClick={closeResignation} variant="secondary">
                Cancel
              </Button>
              <Button
                className="gap-2 rounded-2xl bg-[#B91C1C] text-white hover:bg-[#B91C1C]/90"
                disabled={isResigning}
                onClick={() => void submitResignation()}
              >
                {isResigning ? <LoadingSpinner /> : <UserX className="h-4 w-4" />}
                Confirm Resignation
              </Button>
            </div>
          </Card>
        </div>
      ) : null}
    </div>
    </EmployeePageShell>
  );
}
