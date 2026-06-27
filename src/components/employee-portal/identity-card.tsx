"use client";

import { PhoenixIdentityCard } from "@/components/employee/PhoenixIdentityCard";
import { formatDateOnly } from "@/lib/date-only";
import type { EmployeePortalShellData } from "@/lib/employee-portal/service";
import { employeeProfileImageForHrId } from "@/lib/employees/profile-images";
import { formatHrIdForDisplay } from "@/lib/hr-id";

function prettyDate(value: string | null) {
  return formatDateOnly(value, "en-GB", { day: "2-digit", month: "short", year: "numeric" }, "Not available");
}

function titleCaseOffice(value: string | null | undefined, fallback: string) {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  return trimmed
    .split(/\s+/)
    .map((part) => (part.length <= 2 ? part.toUpperCase() : `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`))
    .join(" ");
}

function departmentFromRole(roleLabel: string, fallback: string | null | undefined) {
  if (/marketing/i.test(roleLabel)) return "Marketing";
  if (/training/i.test(roleLabel)) return "Training";
  if (/sales/i.test(roleLabel)) return "Sales";
  return titleCaseOffice(fallback, "Phoenix");
}

export function IdentityCard({ data }: { data: EmployeePortalShellData }) {
  const employee = data.employee;
  const uploadedPhoto = employee.photoUrl ?? null;
  const staticPhoto = employeeProfileImageForHrId(employee.hrId);
  const photoUrl = uploadedPhoto ?? staticPhoto;
  const displayHrId = formatHrIdForDisplay(employee.hrId) ?? employee.hrId;

  return (
    <PhoenixIdentityCard
      employee={{
        department: departmentFromRole(employee.roleLabel, employee.line),
        employeeId: displayHrId,
        fullName: employee.fullName,
        joinDate: prettyDate(data.hrContract.hireDate),
        location: titleCaseOffice(employee.area, "Head Office"),
        photoUrl,
        title: employee.roleLabel,
        verified: true,
      }}
      unoptimizedPhoto={Boolean(uploadedPhoto)}
    />
  );
}
