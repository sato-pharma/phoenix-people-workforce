import { formatDateOnly } from "@/lib/date-only";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";

/**
 * Shape of the "press a node → see the person" popup on the organogram. Built
 * server-side (app/api/reports/organogram/employee/[hrId]) so the SENSITIVE
 * sections are decided by the viewer's role, not the browser: a line manager
 * (NSM/RM/PM/GPM) receives only the safe org + contact sections, while an
 * admin/HR/finance viewer additionally receives the Personal and Compensation
 * sections. When `canViewSensitive` is false those sections are simply absent
 * from the payload — the sensitive values never leave the server.
 */
export type OrganogramDetailItem = { label: string; value: string | null };
export type OrganogramDetailSection = { title: string; items: OrganogramDetailItem[] };

export type OrganogramEmployeeDetail = {
  hrId: string;
  displayName: string;
  fullName: string;
  jobTitle: string | null;
  areaName: string | null;
  hireDate: string | null;
  /** True when the Personal + Compensation sections are included below. */
  canViewSensitive: boolean;
  sections: OrganogramDetailSection[];
};

function text(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function date(value: string | null | undefined): string | null {
  if (!value) return null;
  return formatDateOnly(value, "en", { day: "2-digit", month: "short", year: "numeric" });
}

function money(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return `EGP ${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)}`;
}

/**
 * Turn a full employee-directory row into the organogram popup payload.
 *
 * `canViewSensitive` gates the Personal + Compensation sections entirely.
 * `redactSalary` blanks only the monetary Compensation values (the
 * Talent-Acquisition-for-named-seniors carve-out, mirrored from
 * isSalaryRedactedForViewer) while keeping the rest of the Compensation
 * section — bank, insurance status — visible.
 *
 * `omitSalary` goes one step further for the seat that never sees a salary (isSalaryBlindRole):
 * the money rows are left out of the payload altogether, label and all, so her popup and her PDF
 * show payment mode and bank without a column of blanks that reads like "no salary on file".
 */
export function buildOrganogramEmployeeDetail(
  employee: EmployeeDirectoryRow,
  options: { canViewSensitive: boolean; redactSalary: boolean; omitSalary?: boolean },
): OrganogramEmployeeDetail {
  const sections: OrganogramDetailSection[] = [
    {
      title: "Identity",
      items: [
        { label: "Full name", value: text(employee.fullName) },
        { label: "Arabic name", value: text(employee.nameAr) },
        { label: "HR ID", value: text(employee.hrId) },
        { label: "Job title", value: text(employee.jobTitle) },
        { label: "Position", value: text(employee.positionTitle) },
        { label: "Status", value: text(employee.employmentStatus) },
      ],
    },
    {
      title: "Placement",
      items: [
        { label: "Department", value: text(employee.departmentName) },
        { label: "Line", value: text(employee.lineName) },
        { label: "Area", value: text(employee.areaName) },
        { label: "Region", value: text(employee.regionName) },
        { label: "Team", value: text(employee.teamName) },
      ],
    },
    {
      title: "Reporting & tenure",
      items: [
        { label: "Reports to", value: text(employee.managerName) },
        { label: "Manager HR ID", value: text(employee.managerHrId) },
        { label: "Hire date", value: date(employee.hireDate) },
        { label: "Contract type", value: text(employee.contractType) },
        { label: "Contract renewal", value: date(employee.contractRenewalDate) },
      ],
    },
    {
      title: "Contact",
      items: [
        { label: "Work email", value: text(employee.workEmail) },
        { label: "Mobile", value: text(employee.mobileNumber) },
        { label: "CRM username", value: text(employee.crmUsername) },
      ],
    },
  ];

  if (options.canViewSensitive) {
    sections.push({
      title: "Personal",
      items: [
        { label: "National ID", value: text(employee.nationalId) },
        { label: "Gender", value: text(employee.gender) },
        { label: "Date of birth", value: date(employee.birthDate) },
        { label: "Education", value: text(employee.education) },
        { label: "Residence city", value: text(employee.residenceCity) },
        { label: "Residence area", value: text(employee.residenceArea) },
        { label: "Residence address", value: text(employee.residenceAddress) },
      ],
    });

    // redactSalary blanks only the money figures, never the whole section — the
    // matching write-side guard (isSalaryRedactedForViewer) lives in the
    // employees POST handler.
    const salary = (value: number | null | undefined) =>
      options.redactSalary || options.omitSalary ? null : money(value);
    const moneyItems = options.omitSalary
      ? []
      : [
          { label: "Base salary", value: salary(employee.baseSalary) },
          { label: "Basic salary", value: salary(employee.basicSalary) },
          { label: "Gross salary", value: salary(employee.grossSalary) },
          { label: "Net salary", value: salary(employee.netSalary) },
          { label: "Fuel allowance", value: salary(employee.fuelAllowance) },
          { label: "Extra cost of living", value: salary(employee.extraCostOfLiving) },
          { label: "Medical insurance", value: salary(employee.medicalInsurance) },
          { label: "Social insurance", value: salary(employee.socialInsurance) },
          { label: "Social insurance wage", value: salary(employee.socialInsuranceWage) },
          { label: "Taxes", value: salary(employee.taxes) },
        ];
    sections.push({
      title: "Compensation",
      items: [
        ...moneyItems,
        { label: "Payment mode", value: text(employee.salaryPaymentMode) },
        { label: "Bank", value: text(employee.bankName) },
        { label: "Bank account", value: text(employee.bankAccount) },
      ],
    });
  }

  return {
    hrId: employee.hrId,
    displayName: employee.displayName,
    fullName: employee.fullName,
    jobTitle: employee.jobTitle,
    areaName: employee.areaName,
    hireDate: employee.hireDate,
    canViewSensitive: options.canViewSensitive,
    sections,
  };
}
