"use client";

import {
  AlertCircle,
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

type PopoverElement = HTMLDivElement & {
  hidePopover?: () => void;
  showPopover?: () => void;
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

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <p className="text-sm font-medium text-text-secondary">{label}</p>
      <p className="mt-3 text-3xl font-semibold tracking-tight text-text">
        {value}
      </p>
      <Badge className="mt-4" variant="warning">
        Employees
      </Badge>
    </Card>
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

function SelectField({
  className,
  label,
  onChange,
  options,
  placeholder,
  value,
}: {
  className?: string;
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
        className="h-10 w-full rounded-lg border border-border bg-card px-3 text-sm text-text transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
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
  const formPopoverRef = React.useRef<PopoverElement | null>(null);
  const templateInputRef = React.useRef<HTMLInputElement | null>(null);

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

  const employees = React.useMemo(() => data?.employees ?? [], [data?.employees]);
  const lookups = React.useMemo(
    () =>
      data?.lookups ?? {
        areas: [],
        departments: [],
        lines: [],
        managers: [],
        positions: [],
        statuses: [],
      },
    [data?.lookups],
  );
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
    formPopoverRef.current?.showPopover?.();
  }

  function startEdit(employee: EmployeeDirectoryRow) {
    setEditingHrId(employee.hrId);
    setForm(employeeToForm(employee));
    setNotice(null);
    formPopoverRef.current?.showPopover?.();
  }

  function closeForm() {
    formPopoverRef.current?.hidePopover?.();
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
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.24em] text-primary">
            Phoenix Workforce
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-text">
            Employee Management
          </h1>
          <p className="mt-2 max-w-2xl text-base text-text-secondary">
            Manage employee master data with single-record editing and safe
            bulk operations.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <a href="/api/employees/template">
            <Button className="gap-2" variant="secondary">
              <Download className="h-4 w-4" />
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
            className="gap-2"
            disabled={isImportingTemplate}
            onClick={() => templateInputRef.current?.click()}
            variant="secondary"
          >
            {isImportingTemplate ? (
              <LoadingSpinner />
            ) : (
              <Upload className="h-4 w-4" />
            )}
            Upload Template
          </Button>
          <Button
            className="gap-2"
            disabled={isLoading}
            onClick={() => void loadEmployees()}
            variant="secondary"
          >
            {isLoading ? <LoadingSpinner /> : <RefreshCw className="h-4 w-4" />}
            Refresh
          </Button>
          <Button
            className="gap-2"
            onClick={startCreate}
            popoverTarget="employee-form-popover"
          >
            <UserPlus className="h-4 w-4" />
            Add Employee
          </Button>
        </div>
      </div>

      {error ? (
        <Card className="border-danger/30">
          <div className="flex gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 text-danger" />
            <div>
              <h2 className="text-base font-semibold text-text">
                Employee management unavailable
              </h2>
              <p className="mt-1 text-sm text-text-secondary">{error}</p>
            </div>
          </div>
        </Card>
      ) : null}

      {notice ? (
        <Card className="border-success/30">
          <div className="flex items-center gap-3 text-sm text-text">
            <Check className="h-5 w-5 text-success" />
            {notice}
          </div>
        </Card>
      ) : null}

      {data ? (
        <>
          <section className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
            <SummaryCard label="Total Employees" value={data.summary.totalEmployees} />
            <SummaryCard
              label="Active Employees"
              value={data.summary.activeEmployees}
            />
            <SummaryCard label="Lines Covered" value={data.summary.uniqueLines} />
            <SummaryCard
              label="No Manager Set"
              value={data.summary.employeesWithoutManagers}
            />
          </section>

          <section>
            <Card>
              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div>
                  <h2 className="text-base font-semibold text-text">
                    Employee Directory
                  </h2>
                  <p className="mt-1 text-sm text-text-secondary">
                    Showing {filteredEmployees.length} of {employees.length} records.
                  </p>
                </div>
              </div>

              <div className="mt-5 grid gap-3 xl:grid-cols-[1.4fr_repeat(7,minmax(0,1fr))_auto]">
                <label className="relative block">
                  <span className="sr-only">Search employees</span>
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
                  <Input
                    className="pl-9"
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
                  Clear
                </Button>
              </div>

              <div className="mt-5 overflow-x-auto">
                <table className="w-full min-w-[1380px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs uppercase tracking-[0.16em] text-text-secondary">
                      <th className="px-4 py-3 font-semibold">Employee</th>
                      <th className="px-4 py-3 font-semibold">Position</th>
                      <th className="px-4 py-3 font-semibold">Department</th>
                      <th className="px-4 py-3 font-semibold">Line</th>
                      <th className="px-4 py-3 font-semibold">Area</th>
                      <th className="px-4 py-3 font-semibold">Pay Mode</th>
                      <th className="px-4 py-3 font-semibold">Manager</th>
                      <th className="px-4 py-3 font-semibold">Contact</th>
                      <th className="py-3 pl-4 font-semibold">Status</th>
                      <th className="py-3 pl-4 font-semibold">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredEmployees.length === 0 ? (
                      <tr>
                        <td
                          className="py-8 text-center text-text-secondary"
                          colSpan={10}
                        >
                          No employees match the current filters.
                        </td>
                      </tr>
                    ) : (
                      filteredEmployees.map((employee) => (
                        <tr
                          className="border-b border-border last:border-0"
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
                              <p className="mt-1 text-xs text-text-secondary">
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
                          <td className="py-4 pl-4">
                            <Badge
                              variant={statusBadgeVariant(
                                employee.employmentStatus,
                              )}
                            >
                              {optionName(employee.employmentStatus ?? "active")}
                            </Badge>
                          </td>
                          <td className="py-4 pl-4">
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
            </Card>
          </section>
        </>
      ) : null}

      <div
        className="m-0 h-auto max-h-none w-auto max-w-none overflow-visible border-0 bg-transparent p-0 backdrop:bg-black/45 backdrop:backdrop-blur-sm"
        id="employee-form-popover"
        popover="manual"
        ref={formPopoverRef}
      >
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto px-4 py-6">
          <Card className="w-full max-w-5xl">
            <div className="flex items-start justify-between gap-4 border-b border-border pb-5">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-primary">
                  Employee Record
                </p>
                <h2 className="mt-2 text-xl font-semibold text-text">
                  {editingHrId ? "Edit Employee" : "Add Employee"}
                </h2>
                <p className="mt-1 text-sm text-text-secondary">
                  Manual entry uses the same employee master-data model as the
                  bulk Excel template. Salary payout mode controls automated
                  payroll sheet generation.
                </p>
              </div>
              <Button
                onClick={closeForm}
                popoverTarget="employee-form-popover"
                popoverTargetAction="hide"
                variant="ghost"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
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
              <TextField
                label="job_title"
                onChange={(value) => updateForm("jobTitle", value)}
                value={form.jobTitle}
              />
              <TextField
                label="hire_date"
                onChange={(value) => updateForm("hireDate", value)}
                type="date"
                value={form.hireDate}
              />
              <SelectField
                label="area"
                onChange={(value) => updateForm("areaId", value)}
                options={lookups.areas}
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
              <SelectField
                label="line"
                onChange={(value) => updateForm("lineId", value)}
                options={lookups.lines}
                value={form.lineId}
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
                label="position"
                onChange={(value) => updateForm("positionId", value)}
                options={lookups.positions}
                value={form.positionId}
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

            <div className="mt-5 rounded-lg border border-border bg-bg-soft p-4 text-sm text-text-secondary">
              One Part employees receive the monthly net salary on day 1. Two
              Parts employees receive 70% of base salary on day 1 and the
              remaining salary, allowances, and previous-month expenses on day
              10.
            </div>

            <div className="mt-5 flex justify-end gap-3">
              <Button
                onClick={closeForm}
                popoverTarget="employee-form-popover"
                popoverTargetAction="hide"
                variant="secondary"
              >
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
      </div>
    </div>
  );
}
