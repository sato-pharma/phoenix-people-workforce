import { redirect } from "next/navigation";

import { PremiumHero } from "@/components/ui/premium-hero";
import { DeductionsWorkspace } from "@/components/admin/deductions-workspace";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

const VIEW_ROLES = new Set(["Super Admin", "CEO", "Finance Manager"]);

export default async function AdminDeductionsPage() {
  const access = await resolveAccessContextFromPage();
  if (!VIEW_ROLES.has(access.role)) {
    redirect("/employee-portals");
  }

  const now = new Date();
  const initialMonthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

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
