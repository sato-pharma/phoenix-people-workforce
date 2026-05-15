﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿"use client";

import {
  AlertCircle,
  Building2,
  Check,
  CircleAlert,
  Download,
  Info,
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

type EmployeeImportPreview = {
  failedRows?: number;
  rowsToInsert?: unknown[];
  rowsToUpdate?: unknown[];
  validationErrors?: Array<{ message?: string; rowNumber?: number }>;
  validationWarnings?: Array<{ message?: string; rowNumber?: number }>;
  vacantPositionsToCreate?: unknown[];
};

type EmployeeFormState = {
  areaId: string;
  bankAccount: string;
  bankName: string;
  baseSalary: string;
  basicSalary: string;
  birthDate: string;
  contractType: string;
  crmId: string;
  crmUsername: string;
  departmentId: string;
  education: string;
  employmentStatus: string;
  extraCostOfLiving: string;
  fuelAllowance: string;
  fullName: string;
  gender: string;
  grossSalary: string;
  hasBankAccount: string;
  hireDate: string;
  hrId: string;
  jobTitle: string;
  lineId: string;
  managerHrId: string;
  medicalInsurance: string;
  medicalInsuranceNumber: string;
  medicalInsuranceStatus: string;
  mobileNumber: string;
  nameAr: string;
  nationalId: string;
  netSalary: string;
  positionId: string;
  residenceAddress: string;
  residenceArea: string;
  residenceCity: string;
  regionName: string;
  salaryPaymentMode: string;
  socialInsurance: string;
  socialInsuranceNumber: string;
  socialInsuranceStatus: string;
  taxes: string;
  workEmail: string;
};

const emptyForm: EmployeeFormState = {
  areaId: "",
  bankAccount: "",
  bankName: "",
  baseSalary: "",
  basicSalary: "",
  birthDate: "",
  contractType: "",
  crmId: "",
  crmUsername: "",
  departmentId: "",
  education: "",
  employmentStatus: "active",
  extraCostOfLiving: "",
  fuelAllowance: "",
  fullName: "",
  gender: "",
  grossSalary: "",
  hasBankAccount: "",
  hireDate: "",
  hrId: "",
  jobTitle: "",
  lineId: "",
  managerHrId: "",
  medicalInsurance: "",
  medicalInsuranceNumber: "",
  medicalInsuranceStatus: "",
  mobileNumber: "",
  nameAr: "",
  nationalId: "",
  netSalary: "",
  positionId: "",
  residenceAddress: "",
  residenceArea: "",
  residenceCity: "",
  regionName: "",
  salaryPaymentMode: "two_parts",
  socialInsurance: "",
  socialInsuranceNumber: "",
  socialInsuranceStatus: "",
  taxes: "",
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

const genderOptions = [
  { label: "Male", value: "male" },
  { label: "Female", value: "female" },
  { label: "Other / Not specified", value: "other" },
];

const contractTypeOptions = [
  { label: "Full Time", value: "full_time" },
  { label: "Part Time", value: "part_time" },
  { label: "Temporary", value: "temporary" },
  { label: "Contractor", value: "contractor" },
];

const yesNoOptions = [
  { label: "Yes", value: "yes" },
  { label: "No", value: "no" },
];

const enrollmentStatusOptions = [
  { label: "Yes", value: "yes" },
  { label: "No", value: "no" },
  { label: "Pending", value: "pending" },
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

function masterText(value: string | number | boolean | null | undefined) {
  if (value === null || value === undefined || value === "") return "Not provided";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function dateText(value: string | null | undefined) {
  return value ? value.slice(0, 10) : "Not provided";
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

function isSalesPositionTitle(value: string | null | undefined) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return (
    isMedicalRepTitle(normalized) ||
    normalized.includes("district sales manager") ||
    normalized === "dsm" ||
    normalized.includes("sales")
  );
}

function normalizeForMatch(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
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
  const numberToText = (value: number | null | undefined) =>
    value === null || value === undefined ? "" : String(value);

  return {
    areaId: employee.areaId ? String(employee.areaId) : "",
    bankAccount: employee.bankAccount ?? "",
    bankName: employee.bankName ?? "",
    baseSalary: numberToText(employee.baseSalary),
    basicSalary: numberToText(employee.basicSalary),
    birthDate: employee.birthDate ?? "",
    contractType: employee.contractType ?? "",
    crmId: employee.crmId ?? "",
    crmUsername: employee.crmUsername ?? "",
    departmentId: employee.departmentId ? String(employee.departmentId) : "",
    education: employee.education ?? "",
    employmentStatus: employee.employmentStatus ?? "active",
    extraCostOfLiving: numberToText(employee.extraCostOfLiving),
    fuelAllowance: numberToText(employee.fuelAllowance),
    fullName: employee.fullName,
    gender: employee.gender ?? "",
    grossSalary: numberToText(employee.grossSalary),
    hasBankAccount: employee.hasBankAccount ?? (employee.bankAccount ? "yes" : ""),
    hireDate: employee.hireDate ?? "",
    hrId: employee.hrId,
    jobTitle: employee.jobTitle ?? employee.positionTitle ?? "",
    lineId: employee.lineId ? String(employee.lineId) : "",
    managerHrId: employee.managerHrId ?? "",
    medicalInsurance: numberToText(employee.medicalInsurance),
    medicalInsuranceNumber: employee.medicalInsuranceNumber ?? "",
    medicalInsuranceStatus: employee.medicalInsuranceStatus ?? "",
    mobileNumber: employee.mobileNumber ?? "",
    nameAr: employee.nameAr ?? "",
    nationalId: employee.nationalId ?? "",
    netSalary: numberToText(employee.netSalary),
    positionId: employee.positionId ? String(employee.positionId) : "",
    residenceAddress: employee.residenceAddress ?? "",
    residenceArea: employee.residenceArea ?? "",
    residenceCity: employee.residenceCity ?? "",
    regionName: employee.regionName ?? "",
    salaryPaymentMode: employee.salaryPaymentMode,
    socialInsurance: numberToText(employee.socialInsurance),
    socialInsuranceNumber: employee.socialInsuranceNumber ?? "",
    socialInsuranceStatus: employee.socialInsuranceStatus ?? "",
    taxes: numberToText(employee.taxes),
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
    bankAccount: optionalText(form.bankAccount),
    bankName: optionalText(form.bankName),
    baseSalary: optionalNumber(form.baseSalary),
    basicSalary: optionalNumber(form.basicSalary),
    birthDate: optionalText(form.birthDate),
    contractType: optionalText(form.contractType),
    crmId: optionalText(form.crmId),
    crmUsername: optionalText(form.crmUsername),
    departmentId: optionalNumber(form.departmentId),
    education: optionalText(form.education),
    employmentStatus: optionalText(form.employmentStatus),
    extraCostOfLiving: optionalNumber(form.extraCostOfLiving),
    fuelAllowance: optionalNumber(form.fuelAllowance),
    fullName: optionalText(form.fullName),
    gender: optionalText(form.gender),
    grossSalary: optionalNumber(form.grossSalary),
    hasBankAccount: optionalText(form.hasBankAccount),
    hireDate: optionalText(form.hireDate),
    hrId: optionalText(form.hrId),
    jobTitle: optionalText(form.jobTitle),
    lineId: optionalNumber(form.lineId),
    managerHrId: optionalText(form.managerHrId),
    medicalInsurance: optionalNumber(form.medicalInsurance),
    medicalInsuranceNumber: optionalText(form.medicalInsuranceNumber),
    medicalInsuranceStatus: optionalText(form.medicalInsuranceStatus),
    mobileNumber: optionalText(form.mobileNumber),
    nameAr: optionalText(form.nameAr),
    nationalId: optionalText(form.nationalId),
    netSalary: optionalNumber(form.netSalary),
    originalHrId,
    positionId: optionalNumber(form.positionId),
    residenceAddress: optionalText(form.residenceAddress),
    residenceArea: optionalText(form.residenceArea),
    residenceCity: optionalText(form.residenceCity),
    regionName: optionalText(form.regionName),
    salaryPaymentMode: optionalText(form.salaryPaymentMode),
    socialInsurance: optionalNumber(form.socialInsurance),
    socialInsuranceNumber: optionalText(form.socialInsuranceNumber),
    socialInsuranceStatus: optionalText(form.socialInsuranceStatus),
    taxes: optionalNumber(form.taxes),
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
  const [hasBankAccountFilter, setHasBankAccountFilter] = React.useState("");
  const [medicalInsuranceStatusFilter, setMedicalInsuranceStatusFilter] = React.useState("");
  const [lineFilter, setLineFilter] = React.useState("");
  const [positionFilter, setPositionFilter] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [regionFilter, setRegionFilter] = React.useState("");
  const [salaryPaymentModeFilter, setSalaryPaymentModeFilter] = React.useState("");
  const [socialInsuranceStatusFilter, setSocialInsuranceStatusFilter] = React.useState("");
  const [form, setForm] = React.useState<EmployeeFormState>(emptyForm);
  const [autoGeneratedHrId, setAutoGeneratedHrId] = React.useState<string | null>(null);
  const [editingHrId, setEditingHrId] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [isFormOpen, setIsFormOpen] = React.useState(false);
  const [isResigning, setIsResigning] = React.useState(false);
  const [isResignationOpen, setIsResignationOpen] = React.useState(false);
  const [masterDetailsEmployee, setMasterDetailsEmployee] = React.useState<EmployeeDirectoryRow | null>(null);
  const [pendingImportFile, setPendingImportFile] = React.useState<File | null>(null);
  const [pendingImportPreview, setPendingImportPreview] = React.useState<EmployeeImportPreview | null>(null);
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
        workforceVacancies: [],
      },
    [data?.lookups],
  );

  const selectedPositionTitle = React.useMemo(() => {
    return lookups.positions.find((position) => position.value === form.positionId)?.label ?? "";
  }, [lookups.positions, form.positionId]);

  const openWorkforceVacancies = React.useMemo(
    () => lookups.workforceVacancies?.length ? lookups.workforceVacancies : (lookups.medicalRepVacancies ?? []),
    [lookups.medicalRepVacancies, lookups.workforceVacancies],
  );

  const salesDepartmentId = React.useMemo(() => {
    return lookups.departments.find((department) => normalizeForMatch(department.label) === "sales")?.value ?? "";
  }, [lookups.departments]);

  const selectedPositionRequiresVacancy = React.useMemo(() => {
    return Boolean(form.positionId || form.jobTitle || selectedPositionTitle);
  }, [form.jobTitle, form.positionId, selectedPositionTitle]);

  const filteredWorkforceVacancies = React.useMemo(() => {
    const selectedTitle = normalizeForMatch(selectedPositionTitle || form.jobTitle);

    return openWorkforceVacancies.filter((vacancy) => {
      const positionMatches =
        !form.positionId ||
        String(vacancy.positionId) === String(form.positionId) ||
        normalizeForMatch(vacancy.positionTitle) === selectedTitle ||
        normalizeForMatch(vacancy.jobTitle) === selectedTitle;
      const lineMatches = !form.lineId || String(vacancy.lineId) === String(form.lineId);

      return positionMatches && lineMatches;
    });
  }, [form.jobTitle, form.lineId, form.positionId, openWorkforceVacancies, selectedPositionTitle]);

  const filteredWorkforceLines = React.useMemo(() => {
    if (!selectedPositionRequiresVacancy) return lookups.lines;

    const vacancyLines = Array.from(
      new Map(
        filteredWorkforceVacancies
          .filter((vacancy) => vacancy.lineId !== null)
          .map((vacancy) => [
            String(vacancy.lineId),
            {
              label: vacancy.lineName ?? `Line ${vacancy.lineId}`,
              value: String(vacancy.lineId),
            },
          ]),
      ).values(),
    ).sort((a, b) => a.label.localeCompare(b.label));

    return vacancyLines.length ? vacancyLines : lookups.lines;
  }, [filteredWorkforceVacancies, lookups.lines, selectedPositionRequiresVacancy]);

  const regionOptions = React.useMemo(() => {
    return Array.from(
      new Set(employees.map((employee) => employee.regionName).filter(Boolean)),
    )
      .sort((a, b) => String(a).localeCompare(String(b)))
      .map((region) => ({ label: String(region), value: String(region) }));
  }, [employees]);

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
        employee.regionName,
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
        (!regionFilter || employee.regionName === regionFilter) &&
        (!hasBankAccountFilter || employee.hasBankAccount === hasBankAccountFilter) &&
        (!medicalInsuranceStatusFilter ||
          employee.medicalInsuranceStatus === medicalInsuranceStatusFilter) &&
        (!socialInsuranceStatusFilter ||
          employee.socialInsuranceStatus === socialInsuranceStatusFilter) &&
        (!salaryPaymentModeFilter ||
          employee.salaryPaymentMode === salaryPaymentModeFilter)
      );
    });
  }, [
    areaFilter,
    departmentFilter,
    employees,
    hasBankAccountFilter,
    lineFilter,
    medicalInsuranceStatusFilter,
    positionFilter,
    query,
    regionFilter,
    salaryPaymentModeFilter,
    socialInsuranceStatusFilter,
  ]);
  const hasActiveFilters = Boolean(
    areaFilter ||
      departmentFilter ||
      hasBankAccountFilter ||
      lineFilter ||
      medicalInsuranceStatusFilter ||
      positionFilter ||
      query ||
      regionFilter ||
      salaryPaymentModeFilter ||
      socialInsuranceStatusFilter,
  );
  const activeFilterCount = [
    areaFilter,
    departmentFilter,
    hasBankAccountFilter,
    lineFilter,
    medicalInsuranceStatusFilter,
    positionFilter,
    query,
    regionFilter,
    salaryPaymentModeFilter,
    socialInsuranceStatusFilter,
  ].filter(Boolean).length;

  function updateForm(key: keyof EmployeeFormState, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function generateEmployeeId(lineId: string, forceCreate = false) {
    try {
      const params = lineId ? `?lineId=${encodeURIComponent(lineId)}` : "";
      const response = await fetch(`/api/employees/next-hr-id${params}`, { cache: "no-store" });
      const payload = await response.json();

      if (!response.ok || !payload.hrId) {
        setError(payload.message ?? "Unable to generate Employee ID.");
        return;
      }

      setAutoGeneratedHrId(payload.hrId);
      setForm((current) => {
        if ((!forceCreate && editingHrId) || (current.hrId && current.hrId !== autoGeneratedHrId)) {
          return current;
        }

        return { ...current, hrId: payload.hrId };
      });
    } catch {
      setError("Unable to generate Employee ID.");
    }
  }

  function updateLine(value: string) {
    setForm((current) => ({
      ...current,
      areaId: "",
      lineId: value,
      managerHrId: "",
    }));

    if (!editingHrId) {
      void generateEmployeeId(value);
    }
  }

  function applyVacancySelection(areaId: string) {
    const vacancy = filteredWorkforceVacancies.find(
      (item) => String(item.areaId) === String(areaId),
    );

    if (!vacancy) {
      updateForm("areaId", areaId);
      return;
    }

    setForm((prev) => ({
      ...prev,
      areaId,
      departmentId: String(vacancy.departmentId ?? prev.departmentId),
      jobTitle: vacancy.positionTitle || vacancy.jobTitle || prev.jobTitle,
      lineId: String(vacancy.lineId ?? prev.lineId),
      managerHrId: vacancy.managerHrId ?? prev.managerHrId,
      positionId: String(vacancy.positionId ?? prev.positionId),
      regionName: vacancy.regionName ?? prev.regionName,
    }));
  }

  function validateEmployeeForm() {
    const numericFields: Array<[keyof EmployeeFormState, string]> = [
      ["basicSalary", "Basic Salary"],
      ["baseSalary", "Base Salary"],
      ["grossSalary", "Gross Salary"],
      ["netSalary", "Net Salary"],
      ["fuelAllowance", "Fuel Allowance"],
      ["extraCostOfLiving", "Extra Cost of Living"],
      ["medicalInsurance", "Medical Insurance"],
      ["socialInsurance", "Social Insurance"],
      ["taxes", "Taxes"],
    ];

    if (!form.hrId.trim()) return "Employee ID is required.";
    if (!form.fullName.trim()) return "Full Name is required.";
    if (form.managerHrId && form.managerHrId.trim().toUpperCase() === form.hrId.trim().toUpperCase()) {
      return "Direct Manager cannot be the same employee.";
    }
    if (form.workEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.workEmail)) {
      return "Work email format is invalid.";
    }

    for (const [key, label] of numericFields) {
      const value = form[key].trim();
      if (value && (!Number.isFinite(Number(value)) || Number(value) < 0)) {
        return `${label} must be a valid positive number.`;
      }
    }

    return null;
  }

  function clearFilters() {
    setAreaFilter("");
    setDepartmentFilter("");
    setHasBankAccountFilter("");
    setLineFilter("");
    setMedicalInsuranceStatusFilter("");
    setPositionFilter("");
    setQuery("");
    setRegionFilter("");
    setSalaryPaymentModeFilter("");
    setSocialInsuranceStatusFilter("");
  }

  function startCreate() {
    setEditingHrId(null);
    setForm(emptyForm);
    setAutoGeneratedHrId(null);
    setNotice(null);
    setIsFormOpen(true);
    void generateEmployeeId("", true);
  }

  function startEdit(employee: EmployeeDirectoryRow) {
    setEditingHrId(employee.hrId);
    setForm(employeeToForm(employee));
    setAutoGeneratedHrId(null);
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
      const validationError = validateEmployeeForm();
      if (validationError) {
        setError(validationError);
        return;
      }

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
    setPendingImportFile(null);
    setPendingImportPreview(null);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const response = await fetch("/api/imports/employees/dry-run", {
        body: formData,
        method: "POST",
      });
      const payload = await response.json();

      if (!response.ok) {
        setError(payload.message ?? payload.error ?? "template_import_failed");
        return;
      }

      setPendingImportFile(file);
      setPendingImportPreview(payload);
      setNotice(
        `Import preview ready: ${payload.rowsToInsert?.length ?? 0} to create, ${
          payload.rowsToUpdate?.length ?? 0
        } to update, ${payload.failedRows ?? 0} blocked.`,
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

  async function confirmPendingImport() {
    if (!pendingImportFile) return;

    setIsImportingTemplate(true);
    setError(null);
    setNotice(null);

    const formData = new FormData();
    formData.append("file", pendingImportFile);

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

      setPendingImportFile(null);
      setPendingImportPreview(null);
      await loadEmployees();
      setNotice(
        `Template processed: ${payload.importedEmployees ?? 0} created, ${
          payload.updatedEmployees ?? 0
        } updated.`,
      );
    } catch {
      setError("Unable to confirm employee import.");
    } finally {
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
                title="Export active employee master data"
              >
                <Download className="h-3.5 w-3.5 text-[#F97316]" />
                Export XLSX
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

      {pendingImportPreview ? (
        <AdminCallout tone={pendingImportPreview.failedRows ? "danger" : "warning"}>
          <Upload className="mt-0.5 h-5 w-5 text-[#F97316]" />
          <div className="flex w-full flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-sm font-semibold text-text">Employee import preview</h2>
              <p className="mt-1 text-sm text-text-secondary">
                {(pendingImportPreview.rowsToInsert?.length ?? 0)} create, {(pendingImportPreview.rowsToUpdate?.length ?? 0)} update, {(pendingImportPreview.vacantPositionsToCreate?.length ?? 0)} vacancy rows, {pendingImportPreview.failedRows ?? 0} blocked.
              </p>
              {(pendingImportPreview.validationErrors?.length ?? 0) > 0 ? (
                <p className="mt-1 text-xs text-danger">
                  {pendingImportPreview.validationErrors?.slice(0, 3).map((issue) => `Row ${issue.rowNumber ?? "-"}: ${issue.message ?? "Validation failed."}`).join(" ")}
                </p>
              ) : null}
            </div>
            <Button
              className="h-9 rounded-xl px-4 text-xs"
              disabled={isImportingTemplate || Boolean(pendingImportPreview.failedRows)}
              onClick={() => void confirmPendingImport()}
            >
              {isImportingTemplate ? <LoadingSpinner /> : <Check className="h-3.5 w-3.5" />}
              Confirm Import
            </Button>
          </div>
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

              <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8">
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
                  label="Region"
                  onChange={setRegionFilter}
                  options={regionOptions}
                  placeholder="All Regions"
                  value={regionFilter}
                />
                <SelectField
                  label="Has Bank Account"
                  onChange={setHasBankAccountFilter}
                  options={yesNoOptions}
                  placeholder="All"
                  value={hasBankAccountFilter}
                />
                <SelectField
                  label="In Medical Insurance"
                  onChange={setMedicalInsuranceStatusFilter}
                  options={enrollmentStatusOptions}
                  placeholder="All"
                  value={medicalInsuranceStatusFilter}
                />
                <SelectField
                  label="In Social Insurance"
                  onChange={setSocialInsuranceStatusFilter}
                  options={enrollmentStatusOptions}
                  placeholder="All"
                  value={socialInsuranceStatusFilter}
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
                              onClick={() => setMasterDetailsEmployee(employee)}
                              title="View Master Details"
                              variant="ghost"
                            >
                              <Info className="h-3.5 w-3.5" />
                            </Button>
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

      {masterDetailsEmployee ? (
        <div className="fixed inset-0 z-50 flex justify-end bg-[#0F172A]/40 backdrop-blur-sm">
          <Card className="h-full w-full max-w-4xl overflow-hidden rounded-none border-l border-[#D8E0EA] bg-white shadow-[-20px_0_50px_rgba(15,23,42,0.1)]">
            <div className="flex items-center justify-between border-b border-[#E2E8F0] bg-[#F8FAFC] px-6 py-5">
              <div>
                <h2 className="text-xl font-bold tracking-tight text-[#0F172A]">{masterDetailsEmployee.fullName}</h2>
                <p className="mt-1 text-sm text-[#64748B]">
                  {masterDetailsEmployee.hrId} · {masterText(masterDetailsEmployee.positionTitle ?? masterDetailsEmployee.jobTitle)}
                </p>
              </div>
              <Button
                className="h-10 w-10 rounded-xl p-0 text-[#64748B] hover:bg-[#E2E8F0] hover:text-[#0F172A]"
                onClick={() => setMasterDetailsEmployee(null)}
                variant="ghost"
              >
                <X className="h-5 w-5" />
              </Button>
            </div>
            <div className="grid max-h-[calc(100vh-88px)] gap-5 overflow-y-auto p-6 lg:grid-cols-2">
              {[
                {
                  title: "Identity",
                  rows: [
                    ["Employee ID", masterDetailsEmployee.hrId],
                    ["Full Name", masterDetailsEmployee.fullName],
                    ["Arabic Name", masterDetailsEmployee.nameAr],
                    ["National ID", masterDetailsEmployee.nationalId],
                    ["Gender", masterDetailsEmployee.gender],
                    ["Birth Date", dateText(masterDetailsEmployee.birthDate)],
                  ],
                },
                {
                  title: "Organization",
                  rows: [
                    ["Department", masterDetailsEmployee.departmentName],
                    ["Line", masterDetailsEmployee.lineName],
                    ["Area", masterDetailsEmployee.areaName],
                    ["Team", masterDetailsEmployee.teamId],
                    ["Title", masterDetailsEmployee.jobTitle],
                    ["Position", masterDetailsEmployee.positionTitle],
                    ["Direct Manager", masterDetailsEmployee.managerName],
                    ["Manager HR_ID", masterDetailsEmployee.managerHrId],
                    ["Hiring Date", dateText(masterDetailsEmployee.hireDate)],
                    ["Employment Status", optionName(masterDetailsEmployee.employmentStatus ?? "active")],
                    ["Contract Type", optionName(masterDetailsEmployee.contractType ?? "")],
                  ],
                },
                {
                  title: "Contact & Residence",
                  rows: [
                    ["Email", masterDetailsEmployee.workEmail],
                    ["Phone", masterDetailsEmployee.mobileNumber],
                    ["Residence Address", masterDetailsEmployee.residenceAddress],
                    ["Residence City", masterDetailsEmployee.residenceCity],
                    ["Residence Area", masterDetailsEmployee.residenceArea],
                  ],
                },
                {
                  title: "CRM",
                  rows: [
                    ["CRM ID", masterDetailsEmployee.crmId],
                    ["CRM Username", masterDetailsEmployee.crmUsername],
                  ],
                },
                {
                  title: "Payroll Reference",
                  rows: [
                    ["Basic Salary", masterDetailsEmployee.basicSalary],
                    ["Base Salary", masterDetailsEmployee.baseSalary],
                    ["Gross Salary", masterDetailsEmployee.grossSalary],
                    ["Net Salary", masterDetailsEmployee.netSalary],
                    ["Fuel Allowance", masterDetailsEmployee.fuelAllowance],
                    ["Extra Cost of Living", masterDetailsEmployee.extraCostOfLiving],
                    ["Medical Insurance", masterDetailsEmployee.medicalInsurance],
                    ["In Medical Insurance", optionName(masterDetailsEmployee.medicalInsuranceStatus ?? "")],
                    ["Social Insurance", masterDetailsEmployee.socialInsurance],
                    ["In Social Insurance", optionName(masterDetailsEmployee.socialInsuranceStatus ?? "")],
                    ["Taxes", masterDetailsEmployee.taxes],
                    ["Payment Mode", masterDetailsEmployee.salaryPaymentMode],
                    ["Has Bank Account", optionName(masterDetailsEmployee.hasBankAccount ?? "")],
                    ["Bank Name", masterDetailsEmployee.bankName],
                    ["Bank Account", masterDetailsEmployee.bankAccount],
                    ["Medical Insurance Number", masterDetailsEmployee.medicalInsuranceNumber],
                    ["Social Insurance Number", masterDetailsEmployee.socialInsuranceNumber],
                  ],
                },
                {
                  title: "Lifecycle/System",
                  rows: [
                    ["Payroll Eligible", masterDetailsEmployee.payrollEligible],
                    ["Organogram Visible", masterDetailsEmployee.organogramVisible],
                    ["Region", masterDetailsEmployee.regionName],
                    ["Last Updated", dateText(masterDetailsEmployee.updatedAt)],
                  ],
                },
              ].map((group) => (
                <section className="rounded-2xl border border-[#E2E8F0] bg-white p-4" key={group.title}>
                  <h3 className="mb-3 text-xs font-bold uppercase tracking-widest text-[#475569]">{group.title}</h3>
                  <dl className="grid gap-2">
                    {group.rows.map(([label, value]) => (
                      <div className="grid grid-cols-[150px_1fr] gap-3 border-b border-[#F1F5F9] py-2 last:border-0" key={String(label)}>
                        <dt className="text-xs font-semibold text-[#64748B]">{label}</dt>
                        <dd className="text-sm text-[#0F172A]">{masterText(value)}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}
            </div>
          </Card>
        </div>
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
                    onChange={(value) => {
                      setAutoGeneratedHrId(null);
                      updateForm("hrId", value);
                    }}
                    placeholder="Auto-generated"
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
                    label="National ID"
                    onChange={(value) => updateForm("nationalId", value)}
                    placeholder="National identity number"
                    value={form.nationalId}
                  />
                  <SelectField
                    label="Gender"
                    onChange={(value) => updateForm("gender", value)}
                    options={genderOptions}
                    placeholder="Select gender"
                    value={form.gender}
                  />
                  <TextField
                    label="Birth Date"
                    onChange={(value) => updateForm("birthDate", value)}
                    type="date"
                    value={form.birthDate}
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
                      const nextJobTitle = selected?.label ?? form.jobTitle;
                      setForm((prev) => ({
                        ...prev,
                        areaId: "",
                        departmentId: isSalesPositionTitle(nextJobTitle) && salesDepartmentId ? salesDepartmentId : prev.departmentId,
                        managerHrId: "",
                        positionId: value,
                        jobTitle: nextJobTitle,
                      }));
                    }}
                    options={lookups.positions}
                    placeholder="Select position"
                    value={form.positionId}
                  />
                  <TextField
                    label="Title"
                    onChange={(value) => updateForm("jobTitle", value)}
                    placeholder="Auto-filled from selected position"
                    value={form.jobTitle}
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
                    onChange={updateLine}
                    options={filteredWorkforceLines}
                    placeholder="Select business line"
                    value={form.lineId}
                  />
                  <SelectField
                    disabled={selectedPositionRequiresVacancy && !form.lineId}
                    label="Operating Area"
                    onChange={(value) => {
                      if (value === "empty") return;
                      if (selectedPositionRequiresVacancy) {
                        applyVacancySelection(value);
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
                      selectedPositionRequiresVacancy
                        ? filteredWorkforceVacancies.length > 0
                          ? filteredWorkforceVacancies.map((v) => ({
                              label: v.managerName
                                ? `${v.areaName} - ${v.positionTitle} - Manager: ${v.managerName}`
                                : `${v.areaName} - ${v.positionTitle}`,
                              value: String(v.areaId),
                            }))
                          : form.lineId
                            ? [{ label: "No open vacancy for this position and line", value: "empty" }]
                            : []
                        : lookups.areas.filter((a) => !form.lineId || String(a.lineId) === String(form.lineId))
                    }
                    placeholder={selectedPositionRequiresVacancy && !form.lineId ? "Select line first" : "Select area"}
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
                    label="Contract Type"
                    onChange={(value) => updateForm("contractType", value)}
                    options={contractTypeOptions}
                    placeholder="Select contract type"
                    value={form.contractType}
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

              {/* Section 6: Payroll Reference */}
              <div className="space-y-4">
                <div className="flex items-center gap-2 border-b border-[#F1F5F9] pb-2">
                  <div className="h-2 w-2 rounded-full bg-[#14B8A6]" />
                  <h3 className="text-xs font-bold uppercase tracking-widest text-[#475569]">Payroll Reference</h3>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField
                    label="Basic Salary"
                    onChange={(value) => updateForm("basicSalary", value)}
                    placeholder="0.00"
                    type="number"
                    value={form.basicSalary}
                  />
                  <TextField
                    label="Base Salary"
                    onChange={(value) => updateForm("baseSalary", value)}
                    placeholder="0.00"
                    type="number"
                    value={form.baseSalary}
                  />
                  <TextField
                    label="Gross Salary"
                    onChange={(value) => updateForm("grossSalary", value)}
                    placeholder="0.00"
                    type="number"
                    value={form.grossSalary}
                  />
                  <TextField
                    label="Net Salary"
                    onChange={(value) => updateForm("netSalary", value)}
                    placeholder="0.00"
                    type="number"
                    value={form.netSalary}
                  />
                  <TextField
                    label="Fuel Allowance"
                    onChange={(value) => updateForm("fuelAllowance", value)}
                    placeholder="0.00"
                    type="number"
                    value={form.fuelAllowance}
                  />
                  <TextField
                    label="Extra Cost of Living"
                    onChange={(value) => updateForm("extraCostOfLiving", value)}
                    placeholder="0.00"
                    type="number"
                    value={form.extraCostOfLiving}
                  />
                  <TextField
                    label="Medical Insurance"
                    onChange={(value) => updateForm("medicalInsurance", value)}
                    placeholder="0.00"
                    type="number"
                    value={form.medicalInsurance}
                  />
                  <SelectField
                    label="In Medical Insurance"
                    onChange={(value) => updateForm("medicalInsuranceStatus", value)}
                    options={enrollmentStatusOptions}
                    placeholder="Select status"
                    value={form.medicalInsuranceStatus}
                  />
                  <TextField
                    label="Social Insurance"
                    onChange={(value) => updateForm("socialInsurance", value)}
                    placeholder="0.00"
                    type="number"
                    value={form.socialInsurance}
                  />
                  <SelectField
                    label="In Social Insurance"
                    onChange={(value) => updateForm("socialInsuranceStatus", value)}
                    options={enrollmentStatusOptions}
                    placeholder="Select status"
                    value={form.socialInsuranceStatus}
                  />
                  <TextField
                    label="Taxes"
                    onChange={(value) => updateForm("taxes", value)}
                    placeholder="0.00"
                    type="number"
                    value={form.taxes}
                  />
                  <SelectField
                    label="Has Bank Account"
                    onChange={(value) => updateForm("hasBankAccount", value)}
                    options={yesNoOptions}
                    placeholder="Select"
                    value={form.hasBankAccount}
                  />
                  <TextField
                    label="Bank Name"
                    onChange={(value) => updateForm("bankName", value)}
                    placeholder="Bank name"
                    value={form.bankName}
                  />
                  <TextField
                    label="Bank Account"
                    onChange={(value) => updateForm("bankAccount", value)}
                    placeholder="Account or IBAN"
                    value={form.bankAccount}
                  />
                  <TextField
                    label="Medical Insurance Number"
                    onChange={(value) => updateForm("medicalInsuranceNumber", value)}
                    placeholder="Reference number"
                    value={form.medicalInsuranceNumber}
                  />
                  <TextField
                    label="Social Insurance Number"
                    onChange={(value) => updateForm("socialInsuranceNumber", value)}
                    placeholder="Reference number"
                    value={form.socialInsuranceNumber}
                  />
                </div>
              </div>

              {/* Section 7: Lifecycle / System */}
              <div className="space-y-4">
                <div className="flex items-center gap-2 border-b border-[#F1F5F9] pb-2">
                  <div className="h-2 w-2 rounded-full bg-[#64748B]" />
                  <h3 className="text-xs font-bold uppercase tracking-widest text-[#475569]">Lifecycle / System</h3>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField
                    disabled
                    label="Payroll Eligible"
                    onChange={() => undefined}
                    value={form.employmentStatus === "active" || form.employmentStatus === "on_leave" ? "Yes" : "No"}
                  />
                  <TextField
                    disabled
                    label="Organogram Visible"
                    onChange={() => undefined}
                    value={form.employmentStatus === "active" || form.employmentStatus === "on_leave" ? "Yes" : "No"}
                  />
                  <TextField
                    label="Region"
                    onChange={(value) => updateForm("regionName", value)}
                    placeholder="Auto-filled from vacancy when available"
                    value={form.regionName}
                  />
                  <TextField
                    disabled
                    label="Last Updated"
                    onChange={() => undefined}
                    value={editingHrId ? "Updated on save" : "Created on save"}
                  />
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
