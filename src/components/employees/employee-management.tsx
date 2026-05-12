﻿"use client";

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
import { cn, formatEmployeeDisplayName } from "@/lib/utils";

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
    <div className="relative isolate min-h-[calc(100vh-8rem)] overflow-hidden rounded-[34px] border border-[#D8E0EA] bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.16),transparent_32%),linear-gradient(135deg,#FFF9F3_0%,#FFFFFF_44%,#F7FAFC_100%)] p-4 shadow-[0_24px_70px_rgba(15,23,42,0.1)] sm:p-6">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-24 -top-28 h-72 w-72 rounded-full bg-[#F97316]/12 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-10 left-1/4 h-64 w-64 rounded-full bg-[#0F172A]/6 blur-3xl"
      />
      <div className="relative z-10 space-y-6">{children}</div>
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
        className="h-11 rounded-2xl border-[#D7E0EA] bg-white/95 shadow-sm"
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
              employees: current.employees.map((employee) =>
                employee.hrId === resigningEmployee.hrId
                  ? {
                      ...employee,
                      employmentStatus: resignationForm.employeeStatus,
                      updatedAt: new Date().toISOString(),
                    }
                  : employee,
              ),
            }
          : current,
      );
      setNotice(`Resignation recorded for ${formatEmployeeDisplayName(resigningEmployee.fullName)}. Vacancy ${payload.data?.vacancyCode ?? "opened"} created and employee moved to ${resignationForm.employeeStatus}.`);
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
          <div className="grid w-full grid-cols-1 gap-2 sm:min-w-[560px] sm:grid-cols-2 xl:grid-cols-1">
            <a
              className="inline-flex h-11 items-center justify-center gap-2 rounded-2xl border border-[#D7E0EA] bg-white px-3 text-xs font-semibold text-[#0F172A] shadow-sm transition hover:border-[#FDBA74] hover:bg-[#FFF7ED]"
              href="/api/employees/template"
            >
              <Download className="h-3.5 w-3.5 text-[#F97316]" />
              Download Template
            </a>
            <label className="inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-2xl border border-[#D7E0EA] bg-white px-3 text-xs font-semibold text-[#0F172A] shadow-sm transition hover:border-[#FDBA74] hover:bg-[#FFF7ED]">
              {isImportingTemplate ? (
                <LoadingSpinner />
              ) : (
                <Upload className="h-3.5 w-3.5 text-[#F97316]" />
              )}
              Upload Template
              <input
                accept=".xlsx,.xls"
                className="sr-only"
                onChange={(event) => void uploadTemplate(event.target.files?.[0] ?? null)}
                ref={templateInputRef}
                type="file"
              />
            </label>
            <Button
              className="h-11 rounded-2xl px-3 text-xs shadow-sm"
              disabled={isLoading}
              onClick={() => void loadEmployees()}
              variant="secondary"
            >
              {isLoading ? <LoadingSpinner /> : <RefreshCw className="h-3.5 w-3.5" />}
              Refresh
            </Button>
            <Button className="h-11 rounded-2xl px-3 text-xs shadow-[0_14px_30px_rgba(249,115,22,0.22)]" onClick={startCreate}>
              <UserPlus className="mr-1 h-3.5 w-3.5" />
              Add Employee
            </Button>
          </div>
        }
        badges={
          <div className="flex flex-wrap gap-2 text-xs text-[#475569]">
            <AdminInsightChip>Single-record editing and bulk template workflows stay aligned.</AdminInsightChip>
            <AdminInsightChip tone="orange">Salary payout mode remains visible for downstream payroll automation.</AdminInsightChip>
          </div>
        }
        description="Manage employee master data with structured filters, single-record editing, salary payout mode, and safer bulk operations."
        eyebrow="People Ops / Employees"
        icon={<Building2 className="h-3.5 w-3.5" />}
        title="Employee directory"
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
          <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <AdminStatCard
              description="Active workforce currently in system."
              icon={<Users className="h-4 w-4" />}
              label="Total Employees"
              value={formatNumberValue(data.summary.totalEmployees)}
            />
            <AdminStatCard
              description="Records flagged as active and available for payroll."
              icon={<UserCheck2 className="h-4 w-4" />}
              label="Active Employees"
              value={formatNumberValue(data.summary.activeEmployees)}
            />
            <AdminStatCard
              description="Unique operating lines represented in the directory."
              icon={<CircleAlert className="h-4 w-4" />}
              label="Lines Covered"
              value={formatNumberValue(data.summary.uniqueLines)}
            />
            <AdminStatCard
              description="Employees missing direct manager linkage and require assignment."
              icon={<Building2 className="h-4 w-4" />}
              label="No Manager Set"
              value={formatNumberValue(data.summary.employeesWithoutManagers)}
            />
          </section>

          <AdminTableShell
            action={<Badge variant="neutral">{formatNumberValue(filteredEmployees.length)} visible</Badge>}
            description={`Showing ${filteredEmployees.length} of ${employees.length} employees.`}
            title="Employee Directory"
          >
            <div className="grid gap-3 border-b border-[#E2E8F0] bg-[linear-gradient(135deg,#F8FAFC_0%,#FFF7ED_100%)] p-4 xl:grid-cols-[minmax(0,1.5fr)_repeat(7,minmax(0,1fr))_auto]">
              <label className="relative">
                <span className="sr-only">Search employees</span>
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
                <Input
                  className="h-11 rounded-2xl border-[#D7E0EA] bg-white/95 pl-9 shadow-sm"
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
                className="h-11 gap-2 whitespace-nowrap rounded-2xl shadow-sm"
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
                  <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-xs uppercase tracking-[0.16em] text-[#64748B]">
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
                    filteredEmployees.map((employee, index) => (
                      <tr
                        className="transition-colors hover:bg-[#FFF7ED]/65"
                        key={employeeRowKey(employee, index)}
                      >
                        <td className="px-4 py-4">
                          <button
                            className="text-left"
                            onClick={() => startEdit(employee)}
                            type="button"
                          >
                            <p className="font-medium text-text">
                              {formatEmployeeDisplayName(employee.fullName)}
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
                          <div className="flex flex-wrap gap-2">
                            <Button
                              className="h-9 gap-2 rounded-xl px-3 text-xs"
                              onClick={() => startEdit(employee)}
                              variant="secondary"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                              Edit
                            </Button>
                            <Button
                              className="h-9 gap-2 rounded-xl px-3 text-xs"
                              onClick={() => startResignation(employee)}
                              variant="destructive"
                            >
                              <UserX className="h-3.5 w-3.5" />
                              Resigned
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
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[#0F172A]/60 px-4 py-6 backdrop-blur-md">
          <Card className={`${panelClassName} w-full max-w-5xl overflow-hidden`}>
            <AdminSectionHeader
              action={
                <Button
                  className="h-9 rounded-xl px-3 text-xs"
                  onClick={closeForm}
                  variant="secondary"
                >
                  <X className="h-4 w-4" />
                </Button>
              }
              description="Manual entry uses the same employee master-data model as the bulk template. Salary payout mode controls automated payroll split."
              title={editingHrId ? "Edit Employee" : "Add Employee"}
            />

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
                label="residence_address"
                onChange={(value) => updateForm("residenceAddress", value)}
                placeholder="Address from employee ID card"
                value={form.residenceAddress}
              />
              <TextField
                label="residence_city"
                onChange={(value) => updateForm("residenceCity", value)}
                placeholder="Cairo"
                value={form.residenceCity}
              />
              <TextField
                label="residence_area"
                onChange={(value) => updateForm("residenceArea", value)}
                placeholder="Nasr City"
                value={form.residenceArea}
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

            <div className="mx-5 rounded-2xl border border-orange-200 bg-orange-50 p-4 text-sm text-orange-900">
              Residence address is geocoded through Google Maps on save, so Phoenix Workforce can store the latitude and longitude automatically for distance-based expense validation.
            </div>

            <div className="mx-5 rounded-2xl border border-orange-200 bg-orange-50 p-4 text-sm text-orange-900">
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
                <p className="font-semibold text-rose-900">{formatEmployeeDisplayName(resigningEmployee.fullName)}</p>
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
