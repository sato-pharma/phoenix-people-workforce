"use client";

import { ArrowLeft, Check } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-state";
import { AlertCircle } from "lucide-react";
import type {
  EmployeeDirectoryRow,
  EmployeeMutationInput,
  EmployeeLookupOption,
} from "@/lib/employees/employee-directory";
import { EmployeeProfileCard } from "@/components/employee-portal/employee-profile-card";

// Import the form components and utilities from employee-management
// We'll define them here for reuse

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
  // Phase 1: New employee data fields
  birthDate: string;
  nationalIdNumber: string;
  addressFromIdCard: string;
  personalEmail: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  employeeType: string;
  bankAccountNumber: string;
  bankName: string;
};

type EmployeeMasterDetailProps = {
  employee: EmployeeDirectoryRow;
  lookups: {
    areas: EmployeeLookupOption[];
    departments: EmployeeLookupOption[];
    lines: EmployeeLookupOption[];
    managers: EmployeeLookupOption[];
    positions: EmployeeLookupOption[];
    statuses: EmployeeLookupOption[];
  };
};

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
  const selectClassName =
    "h-11 w-full rounded-2xl border border-[#D7E0EA] bg-white/95 px-3 text-sm text-text shadow-sm transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

  return (
    <label className={className ? `block ${className}` : "block"}>
      <span className="mb-1.5 block text-xs font-medium text-text-secondary">
        {label}
      </span>
      <select
        className={disabled ? "bg-[#F8FAFC] text-[#94A3B8]" : "bg-white"}
        style={{
          border: "1px solid #D7E0EA",
          borderRadius: "1rem",
          padding: "0.75rem",
          fontSize: "0.875rem",
          boxShadow: "0 1px 2px rgba(0, 0, 0, 0.05)",
        }}
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
    // Phase 1: New fields
    birthDate: employee.birthDate ?? "",
    nationalIdNumber: employee.nationalIdNumber ?? "",
    addressFromIdCard: employee.addressFromIdCard ?? "",
    personalEmail: employee.personalEmail ?? "",
    emergencyContactName: employee.emergencyContactName ?? "",
    emergencyContactPhone: employee.emergencyContactPhone ?? "",
    employeeType: employee.employeeType ?? "",
    bankAccountNumber: employee.bankAccountNumber ?? "",
    bankName: employee.bankName ?? "",
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
    residenceAddress: optionalText(form.residenceAddress),
    residenceArea: optionalText(form.residenceArea),
    residenceCity: optionalText(form.residenceCity),
    salaryPaymentMode: optionalText(form.salaryPaymentMode),
    workEmail: optionalText(form.workEmail),
    // Phase 1: New fields
    birthDate: optionalText(form.birthDate),
    nationalIdNumber: optionalText(form.nationalIdNumber),
    addressFromIdCard: optionalText(form.addressFromIdCard),
    personalEmail: optionalText(form.personalEmail),
    emergencyContactName: optionalText(form.emergencyContactName),
    emergencyContactPhone: optionalText(form.emergencyContactPhone),
    employeeType: optionalText(form.employeeType),
    bankAccountNumber: optionalText(form.bankAccountNumber),
    bankName: optionalText(form.bankName),
  };
}

export function EmployeeMasterDetail({
  employee,
  lookups,
}: EmployeeMasterDetailProps) {
  const router = useRouter();
  const [isEditing, setIsEditing] = React.useState(false);
  const [form, setForm] = React.useState<EmployeeFormState>(
    employeeToForm(employee),
  );
  const [isSaving, setIsSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);

  function updateForm(key: keyof EmployeeFormState, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function startEdit() {
    setIsEditing(true);
    setError(null);
    setSuccess(null);
  }

  function cancelEdit() {
    setForm(employeeToForm(employee));
    setIsEditing(false);
    setError(null);
    setSuccess(null);
  }

  async function saveEmployee() {
    setIsSaving(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await fetch("/api/employees", {
        body: JSON.stringify({ employee: formToPayload(form) }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();

      if (!response.ok) {
        setError(payload.message ?? payload.error ?? "Failed to save employee");
        return;
      }

      setSuccess("Employee updated successfully");
      setIsEditing(false);
      // Note: In a real implementation, we'd refresh the employee data here
      // For now, the form reflects the changes made
    } catch {
      setError("Unable to save employee");
    } finally {
      setIsSaving(false);
    }
  }

  const salaryPaymentModeOptions = [
    { label: "One Part", value: "one_part" },
    { label: "Two Parts", value: "two_parts" },
  ];

  return (
    <div className="space-y-6">
      {/* Header with Back Button */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            className="rounded-lg p-2 hover:bg-slate-100"
            onClick={() => router.back()}
            type="button"
          >
            <ArrowLeft className="h-5 w-5 text-slate-600" />
          </button>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">
              {employee.fullName}
            </h1>
            <p className="text-sm text-slate-600">{employee.hrId}</p>
          </div>
        </div>
        <div className="flex gap-2">
          {!isEditing && (
            <Button onClick={startEdit} className="rounded-2xl">
              Edit Employee
            </Button>
          )}
          {isEditing && (
            <>
              <Button onClick={cancelEdit} variant="secondary">
                Cancel
              </Button>
              <Button
                onClick={() => void saveEmployee()}
                disabled={isSaving}
                className="gap-2"
              >
                {isSaving ? <LoadingSpinner /> : <Check className="h-4 w-4" />}
                Save Changes
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Error State */}
      {error && (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4">
          <div className="flex gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 text-red-600" />
            <div>
              <h3 className="font-semibold text-red-900">Save Failed</h3>
              <p className="mt-1 text-sm text-red-800">{error}</p>
            </div>
          </div>
        </div>
      )}

      {/* Success State */}
      {success && (
        <div className="rounded-2xl border border-green-200 bg-green-50 p-4">
          <div className="flex gap-3">
            <Check className="mt-0.5 h-5 w-5 text-green-600" />
            <p className="text-sm font-medium text-green-900">{success}</p>
          </div>
        </div>
      )}

      {/* View Mode: Display employee data */}
      {!isEditing && (
        <EmployeeProfileCard employee={employee} />
      )}

      {/* Edit Mode: Display form */}
      {isEditing && (
        <Card className="border-slate-200 bg-white p-6">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {/* Core Employee Fields */}
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
                updateForm("areaId", "");
              }}
              options={lookups.lines}
              placeholder="Line"
              value={form.lineId}
            />
            <SelectField
              label="area"
              onChange={(value) => updateForm("areaId", value)}
              options={lookups.areas.filter(
                (a) => !form.lineId || String(a.lineId) === String(form.lineId),
              )}
              placeholder="Area"
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
              label="residence_address"
              onChange={(value) => updateForm("residenceAddress", value)}
              value={form.residenceAddress}
            />
            <TextField
              label="residence_city"
              onChange={(value) => updateForm("residenceCity", value)}
              value={form.residenceCity}
            />
            <TextField
              label="residence_area"
              onChange={(value) => updateForm("residenceArea", value)}
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

            {/* Phase 1: Personal Information Section */}
            <div className="col-span-full border-t border-slate-200 pt-6">
              <h3 className="mb-4 text-sm font-bold text-slate-700">
                Personal Information
              </h3>
            </div>
            <TextField
              label="birth_date"
              onChange={(value) => updateForm("birthDate", value)}
              placeholder="YYYY-MM-DD"
              type="date"
              value={form.birthDate}
            />
            <TextField
              label="national_id_number"
              onChange={(value) => updateForm("nationalIdNumber", value)}
              placeholder="e.g., Aadhar, Emirates ID, Passport"
              value={form.nationalIdNumber}
            />
            <TextField
              label="personal_email"
              onChange={(value) => updateForm("personalEmail", value)}
              placeholder="personal@example.com"
              type="email"
              value={form.personalEmail}
            />
            <TextField
              label="emergency_contact_name"
              onChange={(value) => updateForm("emergencyContactName", value)}
              placeholder="Full name of emergency contact"
              value={form.emergencyContactName}
            />
            <TextField
              label="emergency_contact_phone"
              onChange={(value) => updateForm("emergencyContactPhone", value)}
              placeholder="Emergency contact phone"
              value={form.emergencyContactPhone}
            />
            <TextField
              label="address_from_id_card"
              onChange={(value) => updateForm("addressFromIdCard", value)}
              placeholder="Address shown on ID card"
              value={form.addressFromIdCard}
            />

            {/* Phase 1: Employment Details Section */}
            <div className="col-span-full border-t border-slate-200 pt-6">
              <h3 className="mb-4 text-sm font-bold text-slate-700">
                Employment Details
              </h3>
            </div>
            <TextField
              label="employee_type"
              onChange={(value) => updateForm("employeeType", value)}
              placeholder="e.g., Full-time, Contract, Freelance"
              value={form.employeeType}
            />

            {/* Phase 1: Bank Information Section */}
            <div className="col-span-full border-t border-slate-200 pt-6">
              <h3 className="mb-4 text-sm font-bold text-slate-700">
                Bank Information
              </h3>
            </div>
            <TextField
              label="bank_account_number"
              onChange={(value) => updateForm("bankAccountNumber", value)}
              placeholder="IBAN or account number"
              value={form.bankAccountNumber}
            />
            <TextField
              label="bank_name"
              onChange={(value) => updateForm("bankName", value)}
              placeholder="Bank name for salary transfer"
              value={form.bankName}
            />
          </div>

          <div className="mt-6 rounded-2xl border border-orange-200 bg-orange-50 p-4 text-sm text-orange-900">
            Residence address is geocoded through Google Maps on save, so
            Phoenix Workforce can store the latitude and longitude
            automatically for distance-based expense validation.
          </div>

          <div className="mt-4 flex justify-end gap-3">
            <Button onClick={cancelEdit} variant="secondary">
              Cancel
            </Button>
            <Button
              onClick={() => void saveEmployee()}
              disabled={isSaving}
              className="gap-2"
            >
              {isSaving ? <LoadingSpinner /> : <Check className="h-4 w-4" />}
              Save Changes
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
