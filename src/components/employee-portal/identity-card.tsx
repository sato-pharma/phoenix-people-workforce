"use client";

import { PhoenixSignatureCard } from "@/components/phoenix-signature-card/PhoenixSignatureCard";
import type { EmployeePortalShellData } from "@/lib/employee-portal/service";
import { employeeProfileImageForHrId } from "@/lib/employees/profile-images";

function displaySignatureName(name: string) {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length < 3) return name;
  return `${parts[0]} ${parts[1].charAt(0).toUpperCase()}. ${parts[parts.length - 1]}`;
}

export function IdentityCard({ data }: { data: EmployeePortalShellData }) {
  const employee = data.employee;
  const uploadedPhoto = employee.photoUrl ?? null;
  const staticPhoto = employeeProfileImageForHrId(employee.hrId);
  const profileImage = uploadedPhoto ?? staticPhoto;
  const roleLabel = employee.roleLabel || "Phoenix Workforce";

  return (
    <PhoenixSignatureCard
      name={displaySignatureName(employee.fullName)}
      title={roleLabel}
      photoSrc={profileImage}
      logoSrc="/brand/phoenix-camera-watermark.png"
    />
  );
}
