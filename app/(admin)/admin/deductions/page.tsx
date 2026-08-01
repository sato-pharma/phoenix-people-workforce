import { redirect } from "next/navigation";

import { PremiumHero } from "@/components/ui/premium-hero";
import { DeductionsWorkspace } from "@/components/admin/deductions-workspace";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { currentCairoDateParts } from "@/lib/i18n/format";

export const dynamic = "force-dynamic";

const VIEW_ROLES = new Set(["Super Admin", "CEO", "Finance Manager"]);

export default async function AdminDeductionsPage() {
  const access = await resolveAccessContextFromPage();
  if (!VIEW_ROLES.has(access.role)) {
    redirect("/employee-portals");
  }

  // Cairo, not UTC: this key seeds the workspace's state and is what the publish action files
  // deductions under. In the first 2-3 hours of a Cairo month a UTC key still reads the previous
  // month, which would land real deductions on the wrong payslip month.
  const { year, month } = currentCairoDateParts();
  const initialMonthKey = `${year}-${String(month).padStart(2, "0")}`;

  return (
    <div className="space-y-6">
      <PremiumHero
        kicker="Deductions"
        title="Deductions"
        subtitle="Single source of truth for every payroll deduction — Fingerprint, CRM, No Records Activity, Unpaid Vacation, Insufficient Balance Vacation, Loan, and Other. Compute, decide, and (once published) feed Automated Payroll and the employee portal."
      />
      <DeductionsWorkspace canDecide={access.role === "Super Admin"} initialMonthKey={initialMonthKey} />
    </div>
  );
}
