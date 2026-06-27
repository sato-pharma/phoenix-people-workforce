// ╔══════════════════════════════════════════════════════════════════╗
// ║  DESIGN LOCK — OWNER UNLOCK REQUIRED (phrase: Sato-1997)        ║
// ║  This file is permanently locked. The identity banner MUST use   ║
// ║  PhoenixSignatureCard. Do NOT swap it for any other component,   ║
// ║  refactor the render, or change props without the unlock phrase. ║
// ╚══════════════════════════════════════════════════════════════════╝
"use client";

import dynamic from "next/dynamic";
import type { EmployeePortalShellData } from "@/lib/employee-portal/service";
import { employeeProfileImageForHrId } from "@/lib/employees/profile-images";
import type { PhoenixSignatureCardProps } from "@/components/phoenix-signature-card/types";

const PhoenixSignatureCard = dynamic<PhoenixSignatureCardProps>(
  () => import("@/components/phoenix-signature-card/PhoenixSignatureCard").then((m) => m.PhoenixSignatureCard),
  { ssr: false }
);

const MANAGER_KEYWORDS = [
  "manager", "director", "head", "ceo", "president",
  "gpm", "nsm", "sfe", "finance", "hr specialist", "super admin",
];

function isManagerOrAbove(roleLabel: string) {
  const lower = roleLabel.toLowerCase();
  return MANAGER_KEYWORDS.some((kw) => lower.includes(kw));
}

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
      prefix={isManagerOrAbove(roleLabel) ? "Dr." : undefined}
      employeeCode={employee.hrId}
    />
  );
}
